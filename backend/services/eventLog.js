'use strict';

const db = require('../db');

const BATCH_SIZE = 500;

const insertEvent = db.prepare(
  `INSERT INTO match_events (session_id, frame_idx, t_ms, event_type, payload_json)
   VALUES (?, ?, ?, ?, ?)`
);

// Wrap each chunk in a single transaction — ~3.6k inserts/match otherwise thrash WAL.
const insertChunk = db.transaction((sessionId, chunk) => {
  for (const e of chunk) {
    insertEvent.run(
      sessionId,
      e.frameIdx,
      e.tMs,
      e.type,
      e.payload != null ? JSON.stringify(e.payload) : null
    );
  }
});

const upsertMeta = db.prepare(
  `INSERT INTO match_meta (session_id, map_name, agent, ally_side_initial, events_source)
   VALUES (@session_id, @map_name, @agent, @ally_side_initial, @events_source)
   ON CONFLICT(session_id) DO UPDATE SET
     map_name          = excluded.map_name,
     agent             = excluded.agent,
     ally_side_initial = excluded.ally_side_initial,
     events_source     = excluded.events_source`
);

// events: [{ frameIdx, tMs, type, payload }]
function writeEvents(sessionId, events) {
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    insertChunk(sessionId, events.slice(i, i + BATCH_SIZE));
  }
  return events.length;
}

// meta: { mapName, agent, allySideInitial, eventsSource } — any field may be null
function writeMeta(sessionId, meta = {}) {
  upsertMeta.run({
    session_id: sessionId,
    map_name: meta.mapName ?? null,
    agent: meta.agent ?? null,
    ally_side_initial: meta.allySideInitial ?? null,
    events_source: meta.eventsSource ?? null,
  });
}

function persist(sessionId, events = [], meta = {}) {
  writeEvents(sessionId, events);
  writeMeta(sessionId, meta);
}

module.exports = { persist, writeEvents, writeMeta, BATCH_SIZE };
