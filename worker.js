const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type"
  }
});

function mergeHistory(base = {}, incoming = {}) {
  const out = { ...base };
  for (const [id, value] of Object.entries(incoming || {})) {
    const old = out[id];
    if (!old) {
      out[id] = value;
      continue;
    }

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
    env.DB.prepare("SELECT id, data FROM transport_history").all(),
    env.DB.prepare("SELECT person_key, status FROM conv_status").all()
  ]);

  const transports = (trs.results || []).map(r => JSON.parse(r.data));
  const history = Object.fromEntries(
    (hist.results || []).map(r => [r.id, JSON.parse(r.data)])
  );
  const convStatuses = Object.fromEntries(
    (conv.results || []).map(r => [r.person_key, r.status])
  );

  return {
    transports,
    history,
    convStatuses,
    initialized: transports.length > 0
  };
}

/*
 * D1 has a limit on how many statements can be sent in a single batch.
 * The previous Worker put one INSERT/UPSERT per transport into ONE batch.
 * With 120+ transports that batch became too large and the whole POST failed.
 *
 * Keep each batch comfortably below the D1 batch statement limit.
 */
async function runBatches(env, statements, chunkSize = 50) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    if (chunk.length) await env.DB.batch(chunk);
  }
}

async function writeState(env, payload) {
  const transports = Array.isArray(payload?.transports) ? payload.transports : [];
  const incomingHistory = payload?.history || {};
  const convStatuses = payload?.convStatuses || {};

  // Never let an import erase check-ins already stored on another device.
  const historyIds = Object.keys(incomingHistory).filter(Boolean);
  const existingHistory = {};

  if (historyIds.length) {
    for (let i = 0; i < historyIds.length; i += 50) {
      const ids = historyIds.slice(i, i + 50);
      const placeholders = ids.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT id, data FROM transport_history WHERE id IN (${placeholders})`
      ).bind(...ids).all();

      for (const row of rows.results || []) {
        try {
          existingHistory[row.id] = JSON.parse(row.data);
        } catch {}
      }
    }
  }

  const history = mergeHistory(existingHistory, incomingHistory);
  const statements = [];

  for (const t of transports) {
    if (!t?.id) continue;

    statements.push(
      env.DB.prepare(
        `INSERT INTO transports (id, data, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           data=excluded.data,
           updated_at=excluded.updated_at`
      ).bind(String(t.id), JSON.stringify(t))
    );
  }

  for (const [id, value] of Object.entries(history)) {
    if (!id) continue;

    statements.push(
      env.DB.prepare(
        `INSERT INTO transport_history (id, data, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           data=excluded.data,
           updated_at=excluded.updated_at`
      ).bind(String(id), JSON.stringify(value))
    );
  }

  for (const [personKey, status] of Object.entries(convStatuses)) {
    if (!personKey) continue;

    statements.push(
      env.DB.prepare(
        `INSERT INTO conv_status (person_key, status, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(person_key) DO UPDATE SET
           status=excluded.status,
           updated_at=excluded.updated_at`
      ).bind(String(personKey), String(status))
    );
  }

  await runBatches(env, statements, 50);
  return readState(env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") {
        return json({ ok: true });
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        await env.DB.prepare("SELECT 1").first();
        return json({
          ok: true,
          service: "jebs-2026-nexus",
          database: "connected"
        });
      }

      if (url.pathname === "/api/state" && request.method === "GET") {
        return json(await readState(env));
      }

      if (url.pathname === "/api/state" && request.method === "POST") {
        const payload = await request.json();

        if (!payload || typeof payload !== "object") {
          return json({ ok: false, error: "Payload inválido." }, 400);
        }

        const state = await writeState(env, payload);
        return json({ ok: true, ...state });
      }

      // This Worker is currently being used as the API service. If no
      // ASSETS binding exists, don't crash with "undefined.fetch".
      if (env.ASSETS?.fetch) {
        return env.ASSETS.fetch(request);
      }

      return json({
        ok: false,
        error: "Rota não encontrada."
      }, 404);

    } catch (error) {
      console.error("NEXUS_WORKER_ERROR", error);

      return json({
        ok: false,
        error: error?.message || String(error)
      }, 500);
    }
  }
};
