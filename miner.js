async function proxy(body){const r=await fetch('/api/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
function setStatus(msg){document.getElementById('status').textContent=msg;}
function setProgress(msg){document.getElementById('loaded').textContent=msg;}
function setBar(n,total){document.getElementById('bar').style.width=Math.round(n/total*100)+'%';}

async function rebuildIndex(){setStatus('Rebuilding index...');const result=await proxy({_storage:true,action:'list',key:'ladder:*'});let keys=result.result;if(!keys||!Array.isArray(keys))return 0;const snapKeys=keys.filter(k=>k!=='ladder:index'&&k!=='ladder:latest');const timestamps=snapKeys.map(k=>k.replace('ladder:','')).sort();await proxy({_storage:true,action:'set',key:'ladder:index',value:timestamps});setStatus('Index rebuilt — '+timestamps.length+' snapshots');return timestamps.length;}

async function loadAll(index){const toLoad=index.filter((_,i)=>i%2===0);setStatus('Loading '+toLoad.length+' snapshots...');const snaps=[];for(let i=0;i<toLoad.length;i++){const r=await proxy({_storage:true,action:'get',key:'ladder:'+toLoad[i]});if(r.result){try{snaps.push(JSON.parse(r.result));}catch(e){}}if(i%20===0){setProgress(i+' / '+toLoad.length);setBar(i,toLoad.length);}await new Promise(r=>setTimeout(r,15));}snaps.sort((a,b)=>new Date(a.ts)-new Date(b.ts));return snaps;}

async function mine(){
document.getElementById('results').innerHTML='';
const count=await rebuildIndex();
if(!count){setStatus('No snapshots found');return;}
const idxData=await proxy({_storage:true,action:'get',key:'ladder:index'});
const index=idxData.result?JSON.parse(idxData.result):[];
const snaps=await loadAll(index);
setStatus('Analyzing '+snaps.length+' snapshots...');

const wins=[];
const losses=[];
const largeOrders=[];
const btcBuckets={};

// Follow-through tracking buckets
// For each large order event, track T+1,T+3,T+6,T+12 snapshots (~10,30,60,120 sec)
const followThrough={
  t10:{continued:0,reversed:0,flat:0,totalMove:0},
  t30:{continued:0,reversed:0,flat:0,totalMove:0},
  t60:{continued:0,reversed:0,flat:0,totalMove:0},
  t120:{continued:0,reversed:0,flat:0,totalMove:0}
};

for(let i=3;i<snaps.length-13;i++){
const snap=snaps[i];
if(!snap.btc_spot)continue;
const btc3=snaps[i-3].btc_spot;
const btc1=snaps[i-1].btc_spot;
const btcNow=snap.btc_spot;
if(!btc3||!btc1)continue;
const btcDelta30s=btcNow-btc3;
const btcDelta10s=btcNow-btc1;
if(Math.abs(btcDelta30s)>200)continue;
if(Math.abs(btcDelta10s)>200)continue;
const bucket=Math.floor(btcDelta30s/20)*20;
const btcFlat=Math.abs(btcDelta30s)<10;

for(const evt of(snap.events||[])){
if(evt.series!=='KXBTCD')continue;
if(evt.mins_to_resolve<=3)continue;
const futureSnap=snaps[i+5];
if(!futureSnap)continue;
const futureEvt=(futureSnap.events||[]).find(e=>e.ticker===evt.ticker);
if(!futureEvt)continue;

for(let si=0;si<evt.strikes.length;si++){
const st=evt.strikes[si];
const futureSt=futureEvt.strikes[si];
if(!futureSt)continue;
const askNow=st.ya;
const askFuture=futureSt.ya;
if(askNow<0.05||askNow>0.80)continue;
if(askNow===0||askFuture===0)continue;
const contractMove=askFuture-askNow;

if(!btcBuckets[bucket])btcBuckets[bucket]={wins:0,losses:0,flat:0,total:0,totalMove:0};
btcBuckets[bucket].total++;
btcBuckets[bucket].totalMove+=contractMove;

if(contractMove>=0.05){
btcBuckets[bucket].wins++;
wins.push({ts:snap.ts.slice(11,19),idx:si,askBefore:askNow.toFixed(2),askAfter:askFuture.toFixed(2),move:contractMove.toFixed(3),btcDelta30s:btcDelta30s.toFixed(0),btcDelta10s:btcDelta10s.toFixed(0),btcFlat:btcFlat,mins:evt.mins_to_resolve,ticker:evt.ticker});

// Large order: 20c+ move, flat BTC, 15+ mins
if(btcFlat&&contractMove>=0.20&&evt.mins_to_resolve>=15){
// Track follow-through at T+1,T+3,T+6,T+12 snapshots
const offsets={t10:1,t30:3,t60:6,t120:12};
for(const[key,offset]of Object.entries(offsets)){
const fwdSnap=snaps[i+5+offset];
if(!fwdSnap)continue;
const fwdEvt=(fwdSnap.events||[]).find(e=>e.ticker===evt.ticker);
if(!fwdEvt)continue;
const fwdSt=fwdEvt.strikes[si];
if(!fwdSt)continue;
const fwdAsk=fwdSt.ya;
const fwdMove=fwdAsk-askFuture;
followThrough[key].totalMove+=fwdMove;
if(fwdMove>0.02)followThrough[key].continued++;
else if(fwdMove<-0.02)followThrough[key].reversed++;
else followThrough[key].flat++;
}

largeOrders.push({ts:snap.ts.slice(11,19),idx:si,askBefore:askNow.toFixed(2),askAfter:askFuture.toFixed(2),move:contractMove.toFixed(3),btcDelta30s:btcDelta30s.toFixed(0),btcDelta10s:btcDelta10s.toFixed(0),mins:evt.mins_to_resolve,ticker:evt.ticker});
}
}else if(contractMove<=-0.05){
btcBuckets[bucket].losses++;
losses.push({ts:snap.ts.slice(11,19),idx:si,askBefore:askNow.toFixed(2),askAfter:askFuture.toFixed(2),move:contractMove.toFixed(3),btcDelta30s:btcDelta30s.toFixed(0),btcDelta10s:btcDelta10s.toFixed(0),btcFlat:btcFlat,mins:evt.mins_to_resolve,ticker:evt.ticker});
}else{
btcBuckets[bucket].flat++;
}
}
}
if(i%50===0){setProgress(i+' / '+snaps.length);setBar(i,snaps.length);}
}

setStatus('Done. '+wins.length+' up, '+losses.length+' down, '+largeOrders.length+' large order events.');
let html='';

// SUMMARY
html+='<div class="card"><div class="sec">Summary</div>';
html+='<div class="row"><span class="label">Snapshots analyzed:</span><span class="val">'+snaps.length+'</span></div>';
html+='<div class="row"><span class="label">Contract +5c moves:</span><span class="val green">'+wins.length+'</span></div>';
html+='<div class="row"><span class="label">Contract -5c moves:</span><span class="val red">'+losses.length+'</span></div>';
html+='<div class="row"><span class="label">Large order events:</span><span class="val amber">'+largeOrders.length+'</span></div>';
html+='</div>';

// FOLLOW THROUGH ANALYSIS
html+='<div class="card"><div class="sec">Large Order Follow-Through Analysis</div>';
html+='<div class="muted" style="padding:4px 0 8px">After a 20c+ move on flat BTC, what does the contract do next?</div>';
html+='<table class="tbl"><thead><tr><th>Time after</th><th>Continued</th><th>Reversed</th><th>Flat</th><th>Total</th><th>Continue%</th><th>Reverse%</th><th>Avg next move</th></tr></thead><tbody>';
const ftLabels={t10:'~10 sec',t30:'~30 sec',t60:'~60 sec',t120:'~120 sec'};
for(const[key,label]of Object.entries(ftLabels)){
const ft=followThrough[key];
const total=ft.continued+ft.reversed+ft.flat;
if(total===0)continue;
const contPct=(ft.continued/total*100).toFixed(1);
const revPct=(ft.reversed/total*100).toFixed(1);
const avgMove=(ft.totalMove/total).toFixed(4);
html+='<tr>';
html+='<td class="amber">'+label+'</td>';
html+='<td class="green">'+ft.continued+'</td>';
html+='<td class="red">'+ft.reversed+'</td>';
html+='<td class="muted">'+ft.flat+'</td>';
html+='<td>'+total+'</td>';
html+='<td class="'+(parseFloat(contPct)>40?'green':'muted')+'">'+contPct+'%</td>';
html+='<td class="'+(parseFloat(revPct)>40?'red':'muted')+'">'+revPct+'%</td>';
html+='<td class="amber">'+avgMove+'</td>';
html+='</tr>';
}
html+='</tbody></table></div>';

// BUCKET TABLE
html+='<div class="card"><div class="sec">BTC 30s Move vs Contract Move</div>';
html+='<table class="tbl"><thead><tr><th>BTC 30s</th><th>+5c</th><th>-5c</th><th>Flat</th><th>Total</th><th>Up%</th><th>Down%</th><th>Avg move</th></tr></thead><tbody>';
const sortedBuckets=Object.keys(btcBuckets).map(Number).sort((a,b)=>a-b);
for(const b of sortedBuckets){
const bk=btcBuckets[b];
if(bk.total<5)continue;
const upPct=(bk.wins/bk.total*100).toFixed(1);
const downPct=(bk.losses/bk.total*100).toFixed(1);
const avgMove=(bk.totalMove/bk.total).toFixed(4);
const label=b>=0?'+$'+b+' to +$'+(b+20):'$'+b+' to $'+(b+20);
const highlight=parseFloat(upPct)>25||parseFloat(downPct)>25;
html+='<tr style="'+(highlight?'background:#1a1a28':'')+'">';
html+='<td class="amber">'+label+'</td><td class="green">'+bk.wins+'</td><td class="red">'+bk.losses+'</td><td class="muted">'+bk.flat+'</td><td>'+bk.total+'</td>';
html+='<td class="'+(parseFloat(upPct)>25?'green':'muted')+'">'+upPct+'%</td>';
html+='<td class="'+(parseFloat(downPct)>25?'red':'muted')+'">'+downPct+'%</td>';
html+='<td class="amber">'+avgMove+'</td></tr>';
}
html+='</tbody></table></div>';

// LARGE ORDER LIST
if(largeOrders.length){
html+='<div class="card"><div class="sec">Large Order Events</div>';
html+='<table class="tbl"><thead><tr><th>Time</th><th>Ticker</th><th>Before</th><th>After</th><th>Move</th><th>BTC 30s</th><th>BTC 10s</th><th>Mins</th></tr></thead><tbody>';
for(const w of largeOrders.sort((a,b)=>parseFloat(b.move)-parseFloat(a.move))){
html+='<tr><td>'+w.ts+'</td><td>'+w.ticker+'</td><td>'+w.askBefore+'</td><td class="green">'+w.askAfter+'</td><td class="green">+'+w.move+'</td><td class="'+(parseFloat(w.btcDelta30s)>=0?'green':'red')+'">'+w.btcDelta30s+'</td><td class="'+(parseFloat(w.btcDelta10s)>=0?'green':'red')+'">'+w.btcDelta10s+'</td><td>'+w.mins+'</td></tr>';
}
html+='</tbody></table></div>';
}

// TOP WINS
if(wins.length){
html+='<div class="card"><div class="sec">Top +5c Moves</div>';
html+='<table class="tbl"><thead><tr><th>Time</th><th>Ticker</th><th>Before</th><th>After</th><th>Move</th><th>BTC 30s</th><th>BTC 10s</th><th>Flat?</th><th>Mins</th></tr></thead><tbody>';
for(const w of wins.sort((a,b)=>parseFloat(b.move)-parseFloat(a.move)).slice(0,30)){
html+='<tr><td>'+w.ts+'</td><td>'+w.ticker+'</td><td>'+w.askBefore+'</td><td class="green">'+w.askAfter+'</td><td class="green">+'+w.move+'</td><td class="'+(parseFloat(w.btcDelta30s)>=0?'green':'red')+'">'+w.btcDelta30s+'</td><td class="'+(parseFloat(w.btcDelta10s)>=0?'green':'red')+'">'+w.btcDelta10s+'</td><td class="'+(w.btcFlat?'amber':'muted')+'">'+(w.btcFlat?'YES':'no')+'</td><td>'+w.mins+'</td></tr>';
}
html+='</tbody></table></div>';
}

// TOP LOSSES
if(losses.length){
html+='<div class="card"><div class="sec">Top -5c Moves</div>';
html+='<table class="tbl"><thead><tr><th>Time</th><th>Ticker</th><th>Before</th><th>After</th><th>Move</th><th>BTC 30s</th><th>BTC 10s</th><th>Flat?</th><th>Mins</th></tr></thead><tbody>';
for(const l of losses.sort((a,b)=>parseFloat(a.move)-parseFloat(b.move)).slice(0,30)){
html+='<tr><td>'+l.ts+'</td><td>'+l.ticker+'</td><td>'+l.askBefore+'</td><td class="red">'+l.askAfter+'</td><td class="red">'+l.move+'</td><td class="'+(parseFloat(l.btcDelta30s)>=0?'green':'red')+'">'+l.btcDelta30s+'</td><td class="'+(parseFloat(l.btcDelta10s)>=0?'green':'red')+'">'+l.btcDelta10s+'</td><td class="'+(l.btcFlat?'amber':'muted')+'">'+(l.btcFlat?'YES':'no')+'</td><td>'+l.mins+'</td></tr>';
}
html+='</tbody></table></div>';
}

document.getElementById('results').innerHTML=html;
}
