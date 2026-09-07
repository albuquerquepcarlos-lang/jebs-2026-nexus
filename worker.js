const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
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
    env.DB.prepare('SELECT id, data FROM transports ORDER BY id').all(),
    env.DB.prepare('SELECT id, data FROM transport_history').all(),
    env.DB.prepare('SELECT person_key, status FROM conv_status').all()
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

// D1 has a limit on how many statements can be sent in one batch.
// Keep a safety margin so a normal planilha with 120+ transports works.
async function executeStatements(env, statements, labels = []) {
  if (!statements.length) {
    return { success: true, attempted: 0, written: 0, errors: [] };
  }

  const CHUNK_SIZE = 80;
  let written = 0;
  const errors = [];

  for (let start = 0; start < statements.length; start += CHUNK_SIZE) {
    const chunk = statements.slice(start, start + CHUNK_SIZE);
    try {
      await env.DB.batch(chunk);
      written += chunk.length;
    } catch (batchError) {
      errors.push({
        chunkStart: start,
        chunkSize: chunk.length,
        error: batchError?.message || String(batchError)
      });
      console.error('Erro ao gravar lote D1:', batchError);
      return {
        success: false,
        attempted: statements.length,
        written,
        errors,
        batchError: batchError?.message || String(batchError)
      };
    }
  }

  return { success: true, attempted: statements.length, written, errors };
}

async function writeState(env, payload) {
  const transports = Array.isArray(payload?.transports) ? payload.transports : [];
  const incomingHistory = payload?.history || {};
  const convStatuses = payload?.convStatuses || {};
  const replaceTransports = payload?.replaceTransports === true;

  // Preserve the check-in history already stored in D1.
  const historyIds = Object.keys(incomingHistory).filter(Boolean);
  const existingHistory = {};

  if (historyIds.length) {
    // Keep each SELECT comfortably below SQLite's variable limit.
    for (let start = 0; start < historyIds.length; start += 80) {
      const ids = historyIds.slice(start, start + 80);
      const placeholders = ids.map(() => '?').join(',');
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

  // When importing a planilha, the spreadsheet is authoritative for the
  // transport list. Delete the old transport rows first so old imports cannot
  // remain and cause 122 -> 240 -> 300+ duplication.
  if (replaceTransports) {
    await env.DB.prepare('DELETE FROM transports').run();
  }

  const transportStatements = [];
  const transportLabels = [];
  for (const t of transports) {
    if (!t?.id) continue;
    transportStatements.push(
      env.DB.prepare(
        `INSERT INTO transports (id, data, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           data=excluded.data,
           updated_at=excluded.updated_at`
      ).bind(String(t.id), JSON.stringify(t))
    );
    transportLabels.push(String(t.id));
  }

  const transportResult = await executeStatements(env, transportStatements, transportLabels);
  if (!transportResult.success) {
    throw new Error(`Falha ao gravar transportes: ${transportResult.batchError || 'erro no D1'}`);
  }

  const historyStatements = [];
  const historyLabels = [];
  for (const [id, value] of Object.entries(history)) {
    if (!id) continue;
    historyStatements.push(
      env.DB.prepare(
        `INSERT INTO transport_history (id, data, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           data=excluded.data,
           updated_at=excluded.updated_at`
      ).bind(String(id), JSON.stringify(value))
    );
    historyLabels.push(String(id));
  }

  const historyResult = await executeStatements(env, historyStatements, historyLabels);
  if (!historyResult.success) {
    throw new Error(`Falha ao gravar histórico: ${historyResult.batchError || 'erro no D1'}`);
  }

  const convStatements = [];
  const convLabels = [];
  for (const [personKey, status] of Object.entries(convStatuses)) {
    if (!personKey) continue;
    convStatements.push(
      env.DB.prepare(
        `INSERT INTO conv_status (person_key, status, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(person_key) DO UPDATE SET
           status=excluded.status,
           updated_at=excluded.updated_at`
      ).bind(String(personKey), String(status))
    );
    convLabels.push(String(personKey));
  }

  const convResult = await executeStatements(env, convStatements, convLabels);
  if (!convResult.success) {
    throw new Error(`Falha ao gravar status: ${convResult.batchError || 'erro no D1'}`);
  }

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
        return json({
          ok: true,
          service: 'jebs-2026-nexus',
          database: 'connected'
        });
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({
        ok: false,
        error: error?.message || String(error)
      }, 500);
    }
  }
};
