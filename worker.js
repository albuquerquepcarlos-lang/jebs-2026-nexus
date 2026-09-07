const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-origin":"*"}});
function safeParse(v,fallback=null){try{return JSON.parse(v)}catch{return fallback}}
function mergeHistory(base={},incoming={}){
 const out={...base};
 for(const [id,value] of Object.entries(incoming||{})){
  const old=out[id]; if(!old){out[id]=value;continue}
  const oldStops=Array.isArray(old.stops)?old.stops:[], newStops=Array.isArray(value?.stops)?value.stops:[];
  const oldSteps=Array.isArray(old.steps)?old.steps:[], newSteps=Array.isArray(value?.steps)?value.steps:[];
  out[id]={...old,...value,stops:[...new Set([...oldStops,...newStops])],steps:(oldSteps.length||newSteps.length)?[0,1,2].map(i=>Boolean(oldSteps[i]||newSteps[i])):undefined,done:Boolean(old.done||value?.done)};
 }
 return out;
}
async function readState(env){
 const [trs,hist,conv]=await Promise.all([
  env.DB.prepare('SELECT id,data FROM transports ORDER BY rowid').all(),
  env.DB.prepare('SELECT id,data FROM transport_history').all(),
  env.DB.prepare('SELECT person_key,status FROM conv_status').all()
 ]);
 return {transports:(trs.results||[]).map(r=>safeParse(r.data,{})).filter(Boolean),history:Object.fromEntries((hist.results||[]).map(r=>[r.id,safeParse(r.data,{})])),convStatuses:Object.fromEntries((conv.results||[]).map(r=>[r.person_key,r.status])),initialized:(trs.results||[]).length>0,timestamp:new Date().toISOString()};
}
async function writeState(env,payload){
 const transports=Array.isArray(payload?.transports)?payload.transports:[];
 const incomingHistory=payload?.history||{};
 const convStatuses=payload?.convStatuses||{};
 const historyIds=Object.keys(incomingHistory).filter(Boolean);
 const existingHistory={};
 if(historyIds.length){
  const ph=historyIds.map(()=>'?').join(',');
  const rows=await env.DB.prepare(`SELECT id,data FROM transport_history WHERE id IN (${ph})`).bind(...historyIds).all();
  for(const row of rows.results||[]){const parsed=safeParse(row.data);if(parsed)existingHistory[row.id]=parsed;}
 }
 const forceIds=new Set(Array.isArray(payload?.forceHistoryIds)?payload.forceHistoryIds.map(String):[]);
 const history=mergeHistory(existingHistory,incomingHistory);
 for(const id of forceIds){ if(Object.prototype.hasOwnProperty.call(incomingHistory,id)) history[id]=incomingHistory[id]; }
 const batch=[];
 if(payload?.replaceTransports===true) batch.push(env.DB.prepare('DELETE FROM transports'));
 for(const t of transports){if(!t?.id)continue;batch.push(env.DB.prepare("INSERT INTO transports (id,data,updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at").bind(String(t.id),JSON.stringify(t)))}
 for(const [id,value] of Object.entries(history)){if(!id)continue;batch.push(env.DB.prepare("INSERT INTO transport_history (id,data,updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at").bind(String(id),JSON.stringify(value)))}
 for(const [personKey,status] of Object.entries(convStatuses)){if(!personKey)continue;batch.push(env.DB.prepare("INSERT INTO conv_status (person_key,status,updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(person_key) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at").bind(String(personKey),String(status)))}
 if(batch.length)await env.DB.batch(batch);
 return readState(env);
}
export default {async fetch(request,env){const url=new URL(request.url);if(request.method==='OPTIONS')return json({ok:true});try{if(url.pathname==='/api/state'&&request.method==='GET')return json(await readState(env));if(url.pathname==='/api/state'&&request.method==='POST')return json(await writeState(env,await request.json()));if(url.pathname==='/api/health')return json({ok:true,service:'jebs-2026-nexus',database:'connected'});return env.ASSETS.fetch(request)}catch(error){console.error(error);return json({ok:false,error:error?.message||String(error)},500)}}};
