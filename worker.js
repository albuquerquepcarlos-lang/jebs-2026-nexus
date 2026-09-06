const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    "pragma": "no-cache"
  }
});

function safeParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function mergeHistory(base = {}, incoming = {}) {
  const out = { ...base };
  for (const [id, value] of Object.entries(incoming || {})) {
    if (!id) continue;
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
    env.DB.prepare("SELECT id, data FROM transports ORDER BY id").all(),
    env.DB.prepare("SELECT id, data FROM transport_history ORDER BY id").all(),
    env.DB.prepare("SELECT person_key, status FROM conv_status ORDER BY person_key").all()
  ]);

  const transports = [];
  for (const row of trs.results || []) {
    const parsed = safeParse(row.data);
    if (parsed !== null) transports.push(parsed);
  }

  const history = {};
  for (const row of hist.results || []) {
    const parsed = safeParse(row.data);
    if (parsed !== null) history[row.id] = parsed;
  }

  const convStatuses = {};
  for (const row of conv.results || []) convStatuses[row.person_key] = row.status;

  return {
    transports,
    history,
    convStatuses,
    initialized: transports.length > 0
  };
}

async function writeState(env, payload) {
  const transports = Array.isArray(payload?.transports) ? payload.transports : [];
  const incomingHistory = payload?.history && typeof payload.history === "object" ? payload.history : {};
  const convStatuses = payload?.convStatuses && typeof payload.convStatuses === "object" ? payload.convStatuses : {};
  const replaceTransports = payload?.replaceTransports === true;
  const CHUNK_SIZE = 50;

  const historyIds = Object.keys(incomingHistory).filter(Boolean);
  const existingHistory = {};

  for (let i = 0; i < historyIds.length; i += CHUNK_SIZE) {
    const chunk = historyIds.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, data FROM transport_history WHERE id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const row of rows.results || []) {
      const parsed = safeParse(row.data);
      if (parsed !== null) existingHistory[row.id] = parsed;
    }
  }

  const history = mergeHistory(existingHistory, incomingHistory);
  const transportEntries = transports
    .filter(t => t?.id)
    .map(t => ({ id: String(t.id), data: JSON.stringify(t) }));

  // Uma importação completa substitui a lista de transportes.
  // Primeiro descobrimos quais IDs antigos não fazem parte da nova lista,
  // depois removemos esses IDs em lotes. Isso evita o erro de fazer vários
  // DELETE ... NOT IN em sequência, que poderia apagar registros válidos.
  if (replaceTransports) {
    const incomingIds = new Set(transportEntries.map(x => x.id));
    const existing = await env.DB.prepare("SELECT id FROM transports").all();
    const obsolete = (existing.results || [])
      .map(row => String(row.id))
      .filter(id => !incomingIds.has(id));

    for (let i = 0; i < obsolete.length; i += CHUNK_SIZE) {
      const chunk = obsolete.slice(i, i + CHUNK_SIZE);
      if (!chunk.length) continue;
      const placeholders = chunk.map(() => "?").join(",");
      await env.DB.prepare(
        `DELETE FROM transports WHERE id IN (${placeholders})`
      ).bind(...chunk).run();
    }
  }

  for (let i = 0; i < transportEntries.length; i += CHUNK_SIZE) {
    const chunk = transportEntries.slice(i, i + CHUNK_SIZE);
    const statements = chunk.map(item => env.DB.prepare(
      `INSERT INTO transports (id, data, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`
    ).bind(item.id, item.data));
    if (statements.length) await env.DB.batch(statements);
  }

  const historyEntries = Object.entries(history).filter(([id]) => Boolean(id));
  for (let i = 0; i < historyEntries.length; i += CHUNK_SIZE) {
    const chunk = historyEntries.slice(i, i + CHUNK_SIZE);
    const statements = chunk.map(([id, value]) => env.DB.prepare(
      `INSERT INTO transport_history (id, data, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`
    ).bind(String(id), JSON.stringify(value)));
    if (statements.length) await env.DB.batch(statements);
  }

  const statusEntries = Object.entries(convStatuses).filter(([key]) => Boolean(key));
  for (let i = 0; i < statusEntries.length; i += CHUNK_SIZE) {
    const chunk = statusEntries.slice(i, i + CHUNK_SIZE);
    const statements = chunk.map(([personKey, status]) => env.DB.prepare(
      `INSERT INTO conv_status (person_key, status, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(person_key) DO UPDATE SET
         status = excluded.status,
         updated_at = excluded.updated_at`
    ).bind(String(personKey), String(status)));
    if (statements.length) await env.DB.batch(statements);
  }

  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM transports").first();
  const state = await readState(env);

  return {
    ...state,
    writeResult: {
      success: true,
      replaceTransports,
      receivedTransports: transports.length,
      databaseTransports: Number(count?.total || 0),
      receivedHistory: Object.keys(incomingHistory).length,
      receivedConvStatuses: Object.keys(convStatuses).length
    }
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") {
        await env.DB.prepare("SELECT 1").first();
        return json({ ok: true, service: "jebs-2026-nexus", database: "connected" });
      }

      if (url.pathname === "/api/state" && request.method === "GET") {
        return json({ ...(await readState(env)), timestamp: new Date().toISOString() });
      }

      if (url.pathname === "/api/state" && request.method === "POST") {
        let payload;
        try {
          payload = await request.json();
        } catch (error) {
          return json({ ok: false, error: "JSON inválido no corpo da requisição.", detail: error?.message || String(error) }, 400);
        }
        return json(await writeState(env, payload));
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("NEXUS WORKER ERROR:", error);
      return json({ ok: false, error: error?.message || String(error) }, 500);
    }
  }
};
