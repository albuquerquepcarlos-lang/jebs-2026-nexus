const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "pragma": "no-cache"
    }
  });

function safeParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/*
  Mantém os check-ins já registrados.
  Uma nova importação de planilha não pode apagar
  os check-ins existentes.
*/
function mergeHistory(base = {}, incoming = {}) {
  const out = { ...base };

  for (const [id, value] of Object.entries(incoming || {})) {
    if (!id) continue;

    const old = out[id];

    if (!old) {
      out[id] = value;
      continue;
    }

    const oldStops = Array.isArray(old.stops)
      ? old.stops
      : [];

    const newStops = Array.isArray(value?.stops)
      ? value.stops
      : [];

    const oldSteps = Array.isArray(old.steps)
      ? old.steps
      : [];

    const newSteps = Array.isArray(value?.steps)
      ? value.steps
      : [];

    out[id] = {
      ...old,
      ...value,

      stops: [
        ...new Set([
          ...oldStops,
          ...newStops
        ])
      ],

      steps:
        oldSteps.length || newSteps.length
          ? [0, 1, 2].map(
              i => Boolean(oldSteps[i] || newSteps[i])
            )
          : undefined,

      done: Boolean(
        old.done || value?.done
      )
    };
  }

  return out;
}


/* =========================================================
   LEITURA DO ESTADO
   ========================================================= */

async function readState(env) {
  const [
    transportsResult,
    historyResult,
    convResult
  ] = await Promise.all([
    env.DB
      .prepare(
        "SELECT id, data FROM transports ORDER BY id"
      )
      .all(),

    env.DB
      .prepare(
        "SELECT id, data FROM transport_history ORDER BY id"
      )
      .all(),

    env.DB
      .prepare(
        "SELECT person_key, status FROM conv_status ORDER BY person_key"
      )
      .all()
  ]);

  const transports = [];

  for (const row of transportsResult.results || []) {
    const parsed = safeParse(row.data);

    if (parsed !== null) {
      transports.push(parsed);
    }
  }

  const history = {};

  for (const row of historyResult.results || []) {
    const parsed = safeParse(row.data);

    if (parsed !== null) {
      history[row.id] = parsed;
    }
  }

  const convStatuses = {};

  for (const row of convResult.results || []) {
    convStatuses[row.person_key] = row.status;
  }

  return {
    transports,
    history,
    convStatuses,
    initialized: transports.length > 0
  };
}


/* =========================================================
   GRAVAÇÃO DO ESTADO
   ========================================================= */

async function writeState(env, payload) {

  const transports = Array.isArray(payload?.transports)
    ? payload.transports
    : [];

  const incomingHistory =
    payload?.history &&
    typeof payload.history === "object"
      ? payload.history
      : {};

  const convStatuses =
    payload?.convStatuses &&
    typeof payload.convStatuses === "object"
      ? payload.convStatuses
      : {};


  /* -------------------------------------------------------
     1. Recuperar histórico existente
     ------------------------------------------------------- */

  const historyIds =
    Object.keys(incomingHistory)
      .filter(Boolean);

  const existingHistory = {};

  /*
    Fazemos a consulta em pequenos grupos para evitar
    problemas caso a planilha tenha muitos registros.
  */

  const CHUNK_SIZE = 50;

  for (
    let i = 0;
    i < historyIds.length;
    i += CHUNK_SIZE
  ) {

    const chunk =
      historyIds.slice(
        i,
        i + CHUNK_SIZE
      );

    if (!chunk.length) continue;

    const placeholders =
      chunk.map(() => "?").join(",");

    const result =
      await env.DB
        .prepare(
          `SELECT id, data
           FROM transport_history
           WHERE id IN (${placeholders})`
        )
        .bind(...chunk)
        .all();

    for (const row of result.results || []) {
      const parsed = safeParse(row.data);

      if (parsed !== null) {
        existingHistory[row.id] = parsed;
      }
    }
  }


  /* -------------------------------------------------------
     2. Mesclar histórico
     ------------------------------------------------------- */

  const history =
    mergeHistory(
      existingHistory,
      incomingHistory
    );


  /* -------------------------------------------------------
     3. Gravar TRANSPORTES
     ------------------------------------------------------- */

  const transportEntries = [];

  for (const transport of transports) {

    if (!transport?.id) continue;

    transportEntries.push({
      id: String(transport.id),
      data: JSON.stringify(transport)
    });
  }


  /*
    Não mandamos uma quantidade gigante de statements
    de uma única vez.
  */

  for (
    let i = 0;
    i < transportEntries.length;
    i += CHUNK_SIZE
  ) {

    const chunk =
      transportEntries.slice(
        i,
        i + CHUNK_SIZE
      );

    const statements =
      chunk.map(item =>
        env.DB
          .prepare(
            `INSERT INTO transports
              (id, data, updated_at)
             VALUES
              (?, ?, datetime('now'))
             ON CONFLICT(id)
             DO UPDATE SET
              data = excluded.data,
              updated_at = excluded.updated_at`
          )
          .bind(
            item.id,
            item.data
          )
      );

    if (statements.length) {
      await env.DB.batch(statements);
    }
  }


  /* -------------------------------------------------------
     4. Gravar HISTÓRICO / CHECK-INS
     ------------------------------------------------------- */

  const historyEntries =
    Object.entries(history)
      .filter(([id]) => Boolean(id));

  for (
    let i = 0;
    i < historyEntries.length;
    i += CHUNK_SIZE
  ) {

    const chunk =
      historyEntries.slice(
        i,
        i + CHUNK_SIZE
      );

    const statements =
      chunk.map(([id, value]) =>
        env.DB
          .prepare(
            `INSERT INTO transport_history
              (id, data, updated_at)
             VALUES
              (?, ?, datetime('now'))
             ON CONFLICT(id)
             DO UPDATE SET
              data = excluded.data,
              updated_at = excluded.updated_at`
          )
          .bind(
            String(id),
            JSON.stringify(value)
          )
      );

    if (statements.length) {
      await env.DB.batch(statements);
    }
  }


  /* -------------------------------------------------------
     5. Gravar STATUS DAS CONVERSAS
     ------------------------------------------------------- */

  const statusEntries =
    Object.entries(convStatuses)
      .filter(([personKey]) =>
        Boolean(personKey)
      );

  for (
    let i = 0;
    i < statusEntries.length;
    i += CHUNK_SIZE
  ) {

    const chunk =
      statusEntries.slice(
        i,
        i + CHUNK_SIZE
      );

    const statements =
      chunk.map(([personKey, status]) =>
        env.DB
          .prepare(
            `INSERT INTO conv_status
              (person_key, status, updated_at)
             VALUES
              (?, ?, datetime('now'))
             ON CONFLICT(person_key)
             DO UPDATE SET
              status = excluded.status,
              updated_at = excluded.updated_at`
          )
          .bind(
            String(personKey),
            String(status)
          )
      );

    if (statements.length) {
      await env.DB.batch(statements);
    }
  }


  /* -------------------------------------------------------
     6. CONFIRMAÇÃO REAL DO BANCO
     ------------------------------------------------------- */

  const count =
    await env.DB
      .prepare(
        "SELECT COUNT(*) AS total FROM transports"
      )
      .first();

  /*
    Se chegou aqui, a gravação terminou.
    Retornamos o estado REAL que está no D1.
  */

  const state =
    await readState(env);

  return {
    ...state,

    writeResult: {
      success: true,
      receivedTransports: transports.length,
      databaseTransports: Number(
        count?.total || 0
      ),
      receivedHistory: Object.keys(
        incomingHistory
      ).length,
      receivedConvStatuses: Object.keys(
        convStatuses
      ).length
    }
  };
}


/* =========================================================
   WORKER
   ========================================================= */

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    try {

      /* -----------------------------------------------
         HEALTH
         ----------------------------------------------- */

      if (
        url.pathname === "/api/health"
      ) {

        const result =
          await env.DB
            .prepare("SELECT 1 AS ok")
            .first();

        return json({
          ok: Number(result?.ok) === 1,
          service: "jebs-2026-nexus",
          database: "connected"
        });
      }


      /* -----------------------------------------------
         GET STATE
         ----------------------------------------------- */

      if (
        url.pathname === "/api/state" &&
        request.method === "GET"
      ) {

        const state =
          await readState(env);

        return json({
          ...state,
          timestamp: new Date().toISOString()
        });
      }


      /* -----------------------------------------------
         POST STATE
         ----------------------------------------------- */

      if (
        url.pathname === "/api/state" &&
        request.method === "POST"
      ) {

        let payload;

        try {
          payload =
            await request.json();
        } catch (error) {

          return json({
            ok: false,
            error: "JSON inválido no corpo da requisição.",
            detail: error?.message || String(error)
          }, 400);
        }


        const result =
          await writeState(
            env,
            payload
          );

        return json(result);
      }


      /* -----------------------------------------------
         OUTRAS ROTAS
         ----------------------------------------------- */

      return env.ASSETS.fetch(request);

    } catch (error) {

      console.error(
        "NEXUS WORKER ERROR:",
        error
      );

      return json({
        ok: false,
        error:
          error?.message ||
          String(error)
      }, 500);
    }
  }
};
