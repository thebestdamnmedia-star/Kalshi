async function proxy(body){const r=await fetch('/api/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
function setStatus(msg){document.getElementById('status').textContent=msg;}
function setProgress(msg){document.getElementById('loaded').textContent=msg;}
function setBar(n,total){document.getElementById('bar').style.width=Math.round(n/total*100)+'%';}
async function rebuildIndex(){setStatus('Rebuilding index...');const result=await proxy({_storage:true,action:'list',key:'ladder:*'});let keys=result.result;if(!keys||!Array.isArray(keys))return 0;const snapKeys=keys.filter(k=>k!=='ladder:index'&&k!=='ladder:latest');const timestamps=snapKeys.map(k=>k.replace('ladder:','')).sort();await proxy({_storage:true,action:'set',key:'ladder:index',value:timestamps});setStatus('Index rebuilt — '+timestamps.length+' snapshots');return timestamps.length;}
async function loadAll(index){const toLoad=index.filter((_,i)=>i%2===0);setStatus('Loading '+toLoad.length+' snapshots...');const snaps=[];for(let i=0;i<toLoad.length;i++){const r=await proxy({_storage:true,action:'get',key:'ladder:'+toLoad[i]});if(r.result){try{snaps.push(JSON.parse(r.result));}catch{}}if(i%20===0){setProgress(i+' / '+toLoad.length);setBar(i,toLoad.length);}await new Promise(r=>setTimeout(r,15));}snaps.sort((a,b)=>new Date(a.ts)-new Date(b.ts));return snaps;}
async function mine(){
document.getElementById('results').innerHTML='';
const count=await rebuildIndex();
if(!count){setStatus('No snapshots found');return;}
const idxData=await proxy({_storage:true,action:'get',key:'ladder:index'});
const index=idxData.result?JSON.parse(idxData.result):[];
const snaps=await loadAll(index);
setStatus('Analyzing '+snaps.length+' snapshots...');
const wins=[];const losses=[];const btcBuckets={};
for(let i=3;i<snaps.length-5;i++){
const snap=snaps[i];
if(!snap.btc_spot)continue;
const btc3=snaps[i-3].btc_spot;
const btc1=snaps[i-1].btc_spot;
const btcNow=snap.btc_spot;
if(!btc3||!btc1)continue;
const btcDelta30s=btcNow-btc3;
const btcDelta10s=btcNow-btc1;
const bucket=Math.floor(btcDelta30s/20)*20;
for(const evt of(snap.events||[])){
if(evt.series!=='KXBTCD')continue;
if(evt.mins_to_resolve<5)continue;
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
if(askNow<0.05||askNow>0.95)continue;
if(askNow===0||askFuture===0)continue;
const contractMove=askFuture-askNow;
if(!btcBuckets[bucket])btcBuckets[bucket]={wins:0,losses:0,flat:0,total:0,totalMove:0};
btcBuckets[bucket].total++;
btcBuckets[bucket].totalMove+=contractMove;
if(contractMove>=0.05){btcBuckets[bucket].wins++;wins.push({ts:snap.ts.slice(11,19),idx:si,askBefore:askNow.toFixed(2),askAfter:askFuture.toFixed(2),move:contractMove.toFixed(3),btcDelta30s:btcDelta30s.toFixed(0),btcDelta10s:btcDelta10s.toFixed(0),btcNow:btcNow,mins:evt.mins_to_resolve,ticker:evt.ticker});}
else if(contractMove<=-0.05){btcBuckets[bucket].losses++;losses.push({ts:snap.ts.slice(11,19),idx:si,askBefore:askNow.toFixed(2),askAfter:askFuture.toFixed(2),move:contractMove.toFixed(3),btcDelta30s:btcDelta30s.toFixed(0),btcDelta10s:btcDelta10s.toFixed(0),btcNow:btcNow,mins:evt.mins_to_resolve,ticker:evt.ticker});}
else{btcBuckets[bucket].flat++;}
}}
if(i%50===0){setProgress(i+' / '+snaps.length);setBar(i,snaps.length);}
}
setStatus('Done. '+wins.length+' up moves, '+losses.length+' down moves.');
let html='';
html+='<div class="card"><div class="sec">Summary</div>';
html+='<div class="row"><span class="label">Snapshots analyzed:</span><span class="val">'+snaps.length+'</span></div>';
html+='<div class="row"><span class="label">Contract +5c moves:</span><span class="val green">'+wins.length+'</span></div>';
html+='<div class="row"><span class="label">Contract -5c moves:</span><span class="val red">'+losses.length+'</span></div>';
html+='<div class="row"><span class="label">Total significant moves:</span><span class="val amber">'+(wins.length+losses.length)+'</span></div></div>';
html+='<div class="card"><div class="sec">BTC 30s Move vs Contract Move</div>';
html+='<table class="tbl"><thead><tr><th>BTC 30s</th><th>+5c</th><th>-5c</th><th>Flat</th><th>Total</th><th>Up%</th><th>Down%</th><th>Avg move</th></tr></thead><tbody>';
const sortedBuckets=Object.keys(btcBuckets).map(Number).sort((a,b)=>a-b);
for(const b of sortedBuckets){
const bk=btcBuckets[b];
const upPct=(bk.wins/bk.total*100).toFixed(1);
const downPct=(bk.losses/bk.total*100).toFixed(1);
const avgMove=(bk.totalMove/bk.total).toFixed(4);
const label=b>=0?'+$'+b+' to +$'+(b+20):'$'+b+' to $'+(b+20);
html+='<tr><td class="amber">'+label+'</td><td class="green">'+bk.wins+'</td><td class="red">'+bk.losses+'</td><td class="muted">'+bk.flat+'</td><td>'+bk.total+'</td><td class="green">'+upPct+'%</td><td class="red">'+downPct+'%</td><td class="amber">'+avgMove+'</td></tr>';
}
html+='</tbody></table></div>';
if(wins.length){
html+='<div class="card"><div class="sec">Top +5c Moves</div>';
html+='<table class="tbl"><thead><tr><th>Time</th><th>Ticker</th><th>Before</th><th>After</th><th>Move</th><th>BTC 30s</th><th>BTC 10s</th><th>Mins</th></tr></thead><tbody>';
const topWins=wins.sort((a,b)=>parseFloat(b.move)-parseFloat(a.move)).slice(0,30);
for(const w of topWins){html+='<tr><td>'+w.ts+'</td><td>'+w.ticker+'</td><td>'+w.askBefore+'</td><td class="green">'+w.askAfter+'</td><td class="green">+'+w.move+'</td><td class="'+(parseFloat(w.btcDelta30s)>=0?'green':'red')+'">'+w.btcDelta30s+'</td><td class="'+(parseFloat(w.btcDelta10s)>=0?'green':'red')+'">'+w.btcDelta10s+'</td><td>'+w.mins+'</td></tr>';}
html+='</tbody></table></div>';
}
if(losses.length){
html+='<div class="card"><div class="sec">Top -5c Moves</div>';
html+='<table class="tbl"><thead><tr><th>Time</th><th>Ticker</th><th>Before</th><th>After</th><th>Move</th><th>BTC 30s</th><th>BTC 10s</th><th>Mins</th></tr></thead><tbody>';
const topLosses=losses.sort((a,b)=>parseFloat(a.move)-parseFloat(b.move)).slice(0,30);
for(const l of topLosses){html+='<tr><td>'+l.ts+'</td><td>'+l.ticker+'</td><td>'+l.askBefore+'</td><td class="red">'+l.askAfter+'</td><td class="red">'+l.move+'</td><td class="'+(parseFloat(l.btcDelta30s)>=0?'green':'red')+'">'+l.btcDelta30s+'</td><td class="'+(parseFloat(l.btcDelta10s)>=0?'green':'red')+'">'+l.btcDelta10s+'</td><td>'+l.mins+'</td></tr>';}
html+='</tbody></table></div>';
}
document.getElementById('results').innerHTML=html;
}
