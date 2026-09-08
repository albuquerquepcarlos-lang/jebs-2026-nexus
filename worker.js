const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'Content-Type'
  }
});

function mergeHistory(base = {}, incoming = {}) {
  const out = { ...base };
  for (const [id, value] of Object.entries(incoming || {})) {
    const old = out[id];
    if (!old) { out[id] = value; continue; }
    const oldStops = Array.isArray(old.stops) ? old.stops : [];
    const newStops = Array.isArray(value?.stops) ? value.stops : [];
    const oldSteps = Array.isArray(old.steps) ? old.steps : [];
    const newSteps = Array.isArray(value?.steps) ? value.steps : [];
    out[id] = {
      ...old,
      ...value,
      stops: [...new Set([...oldStops, ...newStops])],
      steps: oldSteps.length || newSteps.length
        ? [0, 1, 2].map(i => Boolean(oldSteps[i] || newSteps[i]))
        : undefined,
      done: Boolean(old.done || value?.done)
    };
  }
  return out;
}

async function readState(env) {
  const [trs, hist, conv] = await Promise.all([
    env.DB.prepare('SELECT id, data FROM transports ORDER BY id').all(),
    env.DB.prepare('SELECT id, data FROM transport_history').all(),
    env.DB.prepare('SELECT person_key, status FROM conv_status').all()
  ]);
  const transports = (trs.results || []).map(r => JSON.parse(r.data));
  const history = Object.fromEntries((hist.results || []).map(r => [r.id, JSON.parse(r.data)]));
  const convStatuses = Object.fromEntries((conv.results || []).map(r => [r.person_key, r.status]));
  return { transports, history, convStatuses, initialized: transports.length > 0 };
}

function normalizeTransportPassengers(transports = []) {
  return transports.map(t => {
    if (!t || typeof t !== 'object') return t;
    const stops = Array.isArray(t.stops) ? t.stops : [];
    const boarding = stops.filter(x => x && x.kind !== 'chegada');
    const passengers = boarding.reduce((sum, x) => {
      const q = Number(x?.qty);
      return sum + (Number.isFinite(q) ? q : 0);
    }, 0);
    return { ...t, passengers };
  });
}

async function writeState(env, payload) {
  const transports = normalizeTransportPassengers(Array.isArray(payload?.transports) ? payload.transports : []);
  const incomingHistory = payload?.history || {};
  const convStatuses = payload?.convStatuses || {};
  const replaceTransports = payload?.replaceTransports === true;
  const forceHistoryIds = new Set(Array.isArray(payload?.forceHistoryIds) ? payload.forceHistoryIds.map(String) : []);

  const historyIds = Object.keys(incomingHistory).filter(Boolean);
  const existingHistory = {};
  if (historyIds.length) {
    for (let i = 0; i < historyIds.length; i += 90) {
      const chunk = historyIds.slice(i, i + 90);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT id, data FROM transport_history WHERE id IN (${placeholders})`
      ).bind(...chunk).all();
      for (const row of rows.results || []) {
        try { existingHistory[row.id] = JSON.parse(row.data); } catch {}
      }
    }
  }
  const history = mergeHistory(existingHistory, incomingHistory);
  for (const id of forceHistoryIds) {
    if (Object.prototype.hasOwnProperty.call(incomingHistory, id)) {
      history[id] = incomingHistory[id];
    }
  }

  const batch = [];
  if (replaceTransports) {
    await env.DB.prepare('DELETE FROM transports').run();
  }

  for (const t of transports) {
    if (!t?.id) continue;
    batch.push(env.DB.prepare(
      `INSERT INTO transports (id, data, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
    ).bind(String(t.id), JSON.stringify(t)));
  }

  for (const [id, value] of Object.entries(history)) {
    if (!id) continue;
    batch.push(env.DB.prepare(
      `INSERT INTO transport_history (id, data, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
    ).bind(String(id), JSON.stringify(value)));
  }

  for (const [personKey, status] of Object.entries(convStatuses)) {
    if (!personKey) continue;
    batch.push(env.DB.prepare(
      `INSERT INTO conv_status (person_key, status, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(person_key) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`
    ).bind(String(personKey), String(status)));
  }

  if (batch.length) {
    for (let i = 0; i < batch.length; i += 90) {
      await env.DB.batch(batch.slice(i, i + 90));
    }
  }
  return readState(env);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({ ok: true });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const state = await readState(env);
        state.transports = normalizeTransportPassengers(state.transports);
        return json(state);
      }
      if (url.pathname === '/api/conv-status' && request.method === 'POST') {
        const payload = await request.json();
        const personKey = String(payload?.personKey || '');
        const status = String(payload?.status || '');
        if (!personKey || !status) return json({ok:false,error:'personKey e status são obrigatórios'},400);
        await env.DB.prepare(
          `INSERT INTO conv_status (person_key, status, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(person_key) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`
        ).bind(personKey,status).run();
        return json({ok:true,personKey,status});
      }
      if (url.pathname === '/api/history' && request.method === 'POST') {
        const payload = await request.json();
        const id = String(payload?.id || '');
        if (!id) return json({ ok:false, error:'id obrigatório' }, 400);
        const value = payload?.data;
        if (!value || typeof value !== 'object') return json({ ok:false, error:'data inválido' }, 400);
        await env.DB.prepare(
          `INSERT INTO transport_history (id, data, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
        ).bind(id, JSON.stringify(value)).run();
        return json({ ok:true, id, data:value });
      }
      if (url.pathname === '/api/state' && request.method === 'POST') {
        const payload = await request.json();
        return json(await writeState(env, payload));
      }
      if (url.pathname === '/api/health') {
        await env.DB.prepare('SELECT 1').first();
        return json({ ok: true, service: 'jebs-2026-nexus', database: 'connected' });
      }
      const assetResponse = await env.ASSETS.fetch(request);
      const contentType = assetResponse.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) return assetResponse;
      const html = await assetResponse.text();
      const patch = `<script>
(function(){
  const originalFetch = window.fetch.bind(window);
  function normalizeTransport(t){
    if(!t || typeof t!=='object') return t;
    const stops=Array.isArray(t.stops)?t.stops:[];
    const passengers=stops.filter(x=>x&&x.kind!=='chegada').reduce((n,x)=>{const q=Number(x&&x.qty);return n+(Number.isFinite(q)?q:0)},0);
    return Object.assign({},t,{passengers:passengers});
  }
  window.fetch = function(input, init){
    try{
      const url=typeof input==='string'?input:(input&&input.url)||'';
      if(String(url).includes('/api/state')){
        if(init && init.body && typeof init.body==='string' && String(init.method||'GET').toUpperCase()==='POST'){
          const payload=JSON.parse(init.body);
          if(Array.isArray(payload.transports)) payload.transports=payload.transports.map(normalizeTransport);
          init=Object.assign({},init,{body:JSON.stringify(payload)});
        }
        return originalFetch(input,init).then(function(res){
          if(!res.ok) return res;
          return res.clone().json().then(function(data){
            if(Array.isArray(data.transports)) data.transports=data.transports.map(normalizeTransport);
            return new Response(JSON.stringify(data),{status:res.status,statusText:res.statusText,headers:res.headers});
          }).catch(function(){return res});
        });
      }
    }catch(e){}
    return originalFetch(input,init);
  };
})();
</script>`;
      return new Response(html.replace('</head>', patch + '</head>'), {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers: assetResponse.headers
      });
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error?.message || String(error) }, 500);
    }
  }
};
