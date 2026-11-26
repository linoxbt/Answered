import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

/**
 * Schema from the build spec, as versioned migrations (PRAGMA user_version).
 * Times are INTEGER milliseconds since the epoch. Telegram ids fit in a JS number.
 * Append new migrations; never edit one that has shipped.
 */
const MIGRATIONS: string[] = [
  /* 1: spec tables */ `
  CREATE TABLE hosts (
    id          TEXT PRIMARY KEY,
    tg_user_id  INTEGER NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    host_token  TEXT UNIQUE,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE pairings (
    code        TEXT PRIMARY KEY,
    host_id     TEXT REFERENCES hosts(id),
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id                 TEXT PRIMARY KEY,
    host_id            TEXT NOT NULL REFERENCES hosts(id),
    chat_id            INTEGER NOT NULL,
    chat_title         TEXT NOT NULL,
    chat_username      TEXT,
    status             TEXT NOT NULL CHECK (status IN ('lobby', 'live', 'ended')),
    started_at         INTEGER,
    ended_at           INTEGER,
    opening_message_id INTEGER,
    recap_message_id   INTEGER
  );
  -- At most one open session per group.
  CREATE UNIQUE INDEX sessions_one_open_per_chat ON sessions(chat_id) WHERE status <> 'ended';

  CREATE TABLE messages (
    chat_id      INTEGER NOT NULL,
    message_id   INTEGER NOT NULL,
    session_id   TEXT NOT NULL REFERENCES sessions(id),
    user_id      INTEGER NOT NULL,
    user_name    TEXT NOT NULL,
    text         TEXT NOT NULL,
    reply_to     INTEGER,
    is_question  INTEGER,            -- NULL until classified (phase 2)
    spam         INTEGER NOT NULL DEFAULT 0,
    canonical    TEXT,
    embedding    TEXT,               -- JSON array
    cluster_id   TEXT,
    created_at   INTEGER NOT NULL,
    edited_at    INTEGER,
    PRIMARY KEY (chat_id, message_id)
  );
  CREATE INDEX messages_session ON messages(session_id);

  CREATE TABLE clusters (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(id),
    title             TEXT NOT NULL,
    centroid          TEXT,          -- JSON array
    askers            INTEGER NOT NULL DEFAULT 0,
    votes             INTEGER NOT NULL DEFAULT 0,
    last_ask_at       INTEGER,
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'taken', 'answered', 'skipped')),
    taken_at          INTEGER,
    answered_at       INTEGER,
    summary           TEXT,
    quote             TEXT,
    answer_offset_s   REAL,
    reply_message_id  INTEGER,
    manual            INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX clusters_session ON clusters(session_id, status);

  CREATE TABLE segments (
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    start_s     REAL NOT NULL,
    end_s       REAL NOT NULL,
    text        TEXT NOT NULL
  );
  CREATE INDEX segments_session ON segments(session_id, start_s);
  `,
  /* 2: question pipeline (votes, anonymous reaction counts, cluster ordering) */ `
  ALTER TABLE clusters ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN anon_reactions INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX messages_cluster ON messages(cluster_id);
  CREATE INDEX messages_pending ON messages(session_id, is_question);

  -- A named reaction on a captured message is one vote for that message's cluster.
  CREATE TABLE votes (
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    chat_id     INTEGER NOT NULL,
    message_id  INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id, user_id)
  );
  CREATE INDEX votes_session ON votes(session_id);
  `,
  /* 3: pairing ties a host (and their glasses) to one Telegram group */ `
  ALTER TABLE hosts ADD COLUMN chat_id INTEGER;
  ALTER TABLE hosts ADD COLUMN chat_title TEXT;
  CREATE INDEX hosts_chat ON hosts(chat_id);
  `,
  /* 4: count every ask as well as every person; spam stays out of the recap */ `
  ALTER TABLE clusters ADD COLUMN asks INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clusters ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
  `,
]

/** Opens (and migrates) the database. Accepts `file:./answered.db`, a plain path, or `:memory:`. */
export function openDb(url: string): Db {
  const path = url.replace(/^file:/, '')
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v]!)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

/** Runs `fn` in a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
