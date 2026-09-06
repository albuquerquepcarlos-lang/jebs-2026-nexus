const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

function mergeHistory(base = {}, incoming = {}) {
  // Last-write-wins per transport, while keeping the union of check-in indexes.
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
      // A new import never erases a previously recorded check-in.
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

async function writeState(env, payload) {
  const transports = Array.isArray(payload?.transports) ? payload.transports : [];
  const incomingHistory = payload?.history || {};
  const convStatuses = payload?.convStatuses || {};
  const batch = [];

  // Read the existing history before writing. A full planilha import must
  // never erase check-ins/steps already recorded on another device.
  const historyIds = Object.keys(incomingHistory).filter(Boolean);
  const existingHistory = {};
  if (historyIds.length) {
    const placeholders = historyIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id, data FROM transport_history WHERE id IN (${placeholders})`
    ).bind(...historyIds).all();
    for (const row of rows.results || []) {
      try { existingHistory[row.id] = JSON.parse(row.data); } catch {}
    }
  }
  const history = mergeHistory(existingHistory, incomingHistory);

  for (const t of transports) {
    if (!t?.id) continue;
    batch.push(env.DB.prepare(
      'INSERT INTO transports (id, data, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
    ).bind(String(t.id), JSON.stringify(t)));
  }

  for (const [id, value] of Object.entries(history)) {
    if (!id) continue;
    batch.push(env.DB.prepare(
      'INSERT INTO transport_history (id, data, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
    ).bind(String(id), JSON.stringify(value)));
  }

  for (const [personKey, status] of Object.entries(convStatuses)) {
    if (!personKey) continue;
    batch.push(env.DB.prepare(
      'INSERT INTO conv_status (person_key, status, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(person_key) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at'
    ).bind(String(personKey), String(status)));
  }

  if (batch.length) await env.DB.batch(batch);
  return readState(env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/state' && request.method === 'GET') {
        return json(await readState(env));
      }
      if (url.pathname === '/api/state' && request.method === 'POST') {
        const payload = await request.json();
        return json(await writeState(env, payload));
      }
      if (url.pathname === '/api/health') {
        await env.DB.prepare('SELECT 1').first();
        return json({ ok: true, service: 'jebs-2026-nexus', database: 'connected' });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error?.message || String(error) }, 500);
    }
  }
};
