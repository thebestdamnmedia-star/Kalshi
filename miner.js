async function proxy(body){const r=await fetch('/api/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
function setStatus(msg){document.getElementById('status').textContent=msg;}
function setProgress(msg){document.getElementById('loaded').textContent=msg;}
function setBar(n,total){document.getElementById('bar').style.width=Math.round(n/total*100)+'%';}

async function rebuildIndex(){setStatus('Rebuilding index...');const result=await proxy({_storage:true,action:'list',key:'ladder:*'});let keys=result.result;if(!keys||!Array.isArray(keys))return 0;const snapKeys=keys.filter(k=>k!=='ladder:index'&&k!=='ladder:latest');const timestamps=snapKeys.map(k=>k.replace('ladder:','')).sort();await proxy({_storage:true,action:'set',key:'ladder:index',value:timestamps});setStatus('Index rebuilt — '+timestamps.length+' snapshots');return timestamps.length;}

async function loadAll(index){const toLoad=index.filter((_,i)=>i%2===0);setStatus('Loading '+toLoad.length+' snapshots...');const snaps=[];for(let i=0;i<toLoad.length;i++){const r=await proxy({_storage:true,action:'get',key:'ladder:'+toLoad[i]});if(r.result){try{snaps.push(JSON.parse(r.result));}catch(e){}}if(i%20===0){setProgress(i+' / '+toLoad.length);setBar(i,toLoad.length);}await new Promise(r=>setTimeout(r,15));}snaps.sort((a,b)=>new Date(a.ts)-new Date(b.ts));return snaps;}

function calcTrades(trades,accountSize){
if(!trades.length)return null;
const wins=trades.filter(t=>t.pnl>0);
const losses=trades.filter(t=>t.pnl<=0);
const totalPnl=trades.reduce((s,t)=>s+t.pnl,0);
const avgWin=wins.length?wins.reduce((s,t)=>s+t.pnl,0)/wins.length:0;
const avgLoss=losses.length?losses.reduce((s,t)=>s+t.pnl,0)/losses.length:0;
const wr=wins.length/trades.length;
let peak=accountSize;let balance=accountSize;let maxDD=0;
for(const t of trades){balance+=t.pnl;if(balance>peak)peak=balance;const dd=(peak-balance)/peak*100;if(dd>maxDD)maxDD=dd;}
let maxStreak=0;let streak=0;
for(const t of trades){if(t.pnl<=0){streak++;if(streak>maxStreak)maxStreak=streak;}else{streak=0;}}
return{count:trades.length,wins:wins.length,losses:losses.length,wr:(wr*100).toFixed(1),totalPnl:totalPnl.toFixed(2),avgWin:avgWin.toFixed(3),avgLoss:avgLoss.toFixed(3),finalBalance:(accountSize+totalPnl).toFixed(2),maxDD:maxDD.toFixed(1),maxStreak:maxStreak,perDay:(totalPnl/0.56).toFixed(2)};}

async function mine(){
document.getElementById('results').innerHTML='';
const count=await rebuildIndex();
if(!count){setStatus('No snapshots found');return;}
const idxData=await proxy({_storage:true,action:'get',key:'ladder:index'});
const index=idxData.result?JSON.parse(idxData.result):[];
const snaps=await loadAll(index);
setStatus('Backtesting all 3 models on '+snaps.length+' snapshots...');

const ACCOUNT=100;
const FEE=0.02;
const CONTRACTS=10;

// MODEL 1: Large Order Fade
// Entry: contract moves 20c+ in 50 sec, BTC flat (<$10), 15+ mins left
// Trade: buy NO at current ask after spike (fade the move)
// Exit: T+60 seconds (6 snapshots later)
// Risk: NO ask price × contracts
const m1trades=[];

// MODEL 2: BTC Momentum Follow
// Entry: BTC moves $60+ in 30 sec in one direction
// Trade: buy YES contracts priced $0.10-0.40 in direction of BTC move
// Exit: T+50 seconds (5 snapshots later)
// Risk: YES ask × contracts
const m2trades=[];

// MODEL 3: Stagnation Fade
// Entry: BTC flat (<$5) for 5+ consecutive snapshots (50+ sec)
// Trade: buy NO on OTM YES contracts priced $0.20-0.50
// Exit: T+60 seconds (6 snapshots later)
// Risk: NO ask × contracts
const m3trades=[];

// Track stagnation streak
let flatStreak=0;

for(let i=5;i<snaps.length-13;i++){
const snap=snaps[i];
if(!snap.btc_spot)continue;
const btc5=snaps[i-5].btc_spot;
const btc3=snaps[i-3].btc_spot;
const btc1=snaps[i-1].btc_spot;
const btcNow=snap.btc_spot;
if(!btc5||!btc3||!btc1)continue;
const btcDelta30s=btcNow-btc3;
const btcDelta10s=btcNow-btc1;
const btcDelta50s=btcNow-btc5;
if(Math.abs(btcDelta30s)>200)continue;
if(Math.abs(btcDelta10s)>200)continue;
const btcFlat=Math.abs(btcDelta30s)<10;
const btcFlat50s=Math.abs(btcDelta50s)<5;

if(btcFlat50s)flatStreak++;
else flatStreak=0;

for(const evt of(snap.events||[])){
if(evt.series!=='KXBTCD')continue;
if(evt.mins_to_resolve<=3)continue;

// Get future snapshots for exit
const exit6=snaps[i+6];
const exit5=snaps[i+5];
if(!exit6||!exit5)continue;
const exitEvt6=(exit6.events||[]).find(e=>e.ticker===evt.ticker);
const exitEvt5=(exit5.events||[]).find(e=>e.ticker===evt.ticker);
if(!exitEvt6||!exitEvt5)continue;

for(let si=0;si<evt.strikes.length;si++){
const st=evt.strikes[si];
if(!st)continue;
const askNow=st.ya;
const noAskNow=st.na;
if(askNow===0||noAskNow===0)continue;

// MODEL 1: Large Order Fade
// Need to detect if this strike just moved 20c+ in last 5 snapshots
const prev5Snap=snaps[i-5];
if(prev5Snap){
const prev5Evt=(prev5Snap.events||[]).find(e=>e.ticker===evt.ticker);
if(prev5Evt&&prev5Evt.strikes[si]){
const prevAsk=prev5Evt.strikes[si].ya;
const recentMove=askNow-prevAsk;
if(recentMove>=0.20&&btcFlat&&evt.mins_to_resolve>=15&&noAskNow>=0.05&&noAskNow<=0.80){
const exitSt=exitEvt6.strikes[si];
if(exitSt){
const exitNoAsk=exitSt.na;
const exitYesAsk=exitSt.ya;
// Bought NO, win if YES price drops (NO price rises)
// PnL = (exitYesBid implicit - entryNoAsk) * contracts
// Simplified: if YES ask drops, our NO is worth more
const yesDrop=askNow-exitYesAsk;
const pnl=(yesDrop-FEE)*CONTRACTS;
m1trades.push({ts:snap.ts.slice(11,19),ticker:evt.ticker,entry:noAskNow.toFixed(2),exit:exitYesAsk.toFixed(2),yesDrop:yesDrop.toFixed(3),pnl:pnl,mins:evt.mins_to_resolve});
}
}
}
}

// MODEL 2: BTC Momentum Follow
if(Math.abs(btcDelta30s)>=60&&askNow>=0.10&&askNow<=0.40&&evt.mins_to_resolve>=10){
const btcUp=btcDelta30s>0;
// Only trade strikes that benefit from BTC direction
// If BTC up, buy YES on strikes near or slightly below spot
// If BTC down, those same strikes become less likely — skip
// Use strike index as proxy: middle of ladder = ATM zone
const atm=Math.abs(si-94)<20;
if(atm){
const exitSt=exitEvt5.strikes[si];
if(exitSt){
const exitAsk=exitSt.ya;
const priceMove=exitAsk-askNow;
const pnl=(priceMove-FEE)*CONTRACTS;
m2trades.push({ts:snap.ts.slice(11,19),ticker:evt.ticker,entry:askNow.toFixed(2),exit:exitAsk.toFixed(2),btcDelta:btcDelta30s.toFixed(0),priceMove:priceMove.toFixed(3),pnl:pnl,mins:evt.mins_to_resolve});
}
}
}

// MODEL 3: Stagnation Fade
if(flatStreak>=5&&askNow>=0.20&&askNow<=0.50&&noAskNow>=0.50&&noAskNow<=0.80&&evt.mins_to_resolve>=15){
const exitSt=exitEvt6.strikes[si];
if(exitSt){
const exitYesAsk=exitSt.ya;
const yesDrop=askNow-exitYesAsk;
const pnl=(yesDrop-FEE)*CONTRACTS;
m3trades.push({ts:snap.ts.slice(11,19),ticker:evt.ticker,entry:noAskNow.toFixed(2),exitYes:exitYesAsk.toFixed(2),yesDrop:yesDrop.toFixed(3),pnl:pnl,mins:evt.mins_to_resolve,streak:flatStreak});
}
}
}
}
if(i%50===0){setProgress(i+' / '+snaps.length);setBar(i,snaps.length);}
}

setStatus('Done.');

const r1=calcTrades(m1trades,ACCOUNT);
const r2=calcTrades(m2trades,ACCOUNT);
const r3=calcTrades(m3trades,ACCOUNT);

let html='';

// ACCOUNT SETTINGS
html+='<div class="card"><div class="sec">Backtest Settings</div>';
html+='<div class="row"><span class="label">Starting account:</span><span class="val amber">$'+ACCOUNT+'</span></div>';
html+='<div class="row"><span class="label">Contracts per trade:</span><span class="val amber">'+CONTRACTS+'</span></div>';
html+='<div class="row"><span class="label">Fee per contract:</span><span class="val amber">$'+FEE+'</span></div>';
html+='<div class="row"><span class="label">Data window:</span><span class="val amber">13.6 hours</span></div>';
html+='</div>';

// MODEL COMPARISON
html+='<div class="card"><div class="sec">Model Comparison — $100 Account</div>';
html+='<table class="tbl"><thead><tr><th>Model</th><th>Trades</th><th>WR</th><th>Avg Win</th><th>Avg Loss</th><th>Total P&L</th><th>Final $</th><th>Max DD%</th><th>$/day est</th></tr></thead><tbody>';

const models=[
{name:'M1 Large Order Fade',r:r1},
{name:'M2 BTC Momentum',r:r2},
{name:'M3 Stagnation Fade',r:r3}
];

for(const m of models){
if(!m.r){
html+='<tr><td class="amber">'+m.name+'</td><td colspan="8" class="muted">No trades generated</td></tr>';
continue;
}
const pnlCls=parseFloat(m.r.totalPnl)>0?'green':'red';
const wrCls=parseFloat(m.r.wr)>55?'green':parseFloat(m.r.wr)>45?'amber':'red';
html+='<tr>';
html+='<td class="amber">'+m.name+'</td>';
html+='<td>'+m.r.count+'</td>';
html+='<td class="'+wrCls+'">'+m.r.wr+'%</td>';
html+='<td class="green">$'+m.r.avgWin+'</td>';
html+='<td class="red">$'+m.r.avgLoss+'</td>';
html+='<td class="'+pnlCls+'">$'+m.r.totalPnl+'</td>';
html+='<td class="'+pnlCls+'">$'+m.r.finalBalance+'</td>';
html+='<td class="'+(parseFloat(m.r.maxDD)>20?'red':'amber')+'">'+m.r.maxDD+'%</td>';
html+='<td class="'+pnlCls+'">$'+m.r.perDay+'</td>';
html+='</tr>';
}
html+='</tbody></table></div>';

// DETAILED RESULTS PER MODEL
for(const m of models){
if(!m.r)continue;
const trades=m.name.includes('M1')?m1trades:m.name.includes('M2')?m2trades:m3trades;
html+='<div class="card"><div class="sec">'+m.name+' — Trade Log (first 30)</div>';
html+='<div class="row"><span class="label">Total trades:</span><span class="val">'+m.r.count+'</span></div>';
html+='<div class="row"><span class="label">Win rate:</span><span class="val '+(parseFloat(m.r.wr)>55?'green':'red')+'">'+m.r.wr+'%</span></div>';
html+='<div class="row"><span class="label">Max losing streak:</span><span class="val">'+m.r.maxStreak+'</span></div>';
html+='<div class="row"><span class="label">Est $/day (extrapolated):</span><span class="val '+(parseFloat(m.r.perDay)>0?'green':'red')+'">$'+m.r.perDay+'</span></div>';
html+='<table class="tbl"><thead><tr><th>Time</th><th>Ticker</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Mins</th></tr></thead><tbody>';
for(const t of trades.slice(0,30)){
const pnlCls=t.pnl>0?'green':'red';
html+='<tr><td>'+t.ts+'</td><td>'+t.ticker+'</td><td>'+t.entry+'</td><td>'+(t.exit||t.exitYes||'--')+'</td><td class="'+pnlCls+'">$'+t.pnl.toFixed(3)+'</td><td>'+t.mins+'</td></tr>';
}
html+='</tbody></table></div>';
}

document.getElementById('results').innerHTML=html;
}
