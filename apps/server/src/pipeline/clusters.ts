import { tx, type Db } from '../db/index.js'
import { newId } from '../sessions.js'
import { rank, type RankableCluster } from './rank.js'
import { clampTitle, pickTitle } from './text.js'

export type ClusterStatus = 'open' | 'taken' | 'answered' | 'skipped'

export interface Cluster extends RankableCluster {
  sessionId: string
  status: ClusterStatus
}

/** A message waiting for the classifier. */
export interface PendingMessage {
  chatId: number
  messageId: number
  userId: number
  text: string
  /** Replying to another user's message (often chatter, not a question for the host). */
  isReply: boolean
}

/** What the classifier decided for one message. */
export interface Classification {
  messageId: number
  isQuestion: boolean
  spam: boolean
  canonical: string
  /** An existing cluster id, or `new:<label>`; messages sharing a label form one new cluster. */
  cluster: string
}

interface ClusterRow {
  id: string
  session_id: string
  title: string
  askers: number
  votes: number
  last_ask_at: number | null
  created_at: number
  status: ClusterStatus
}

const toCluster = (r: ClusterRow): Cluster => ({
  id: r.id,
  sessionId: r.session_id,
  title: r.title,
  askers: r.askers,
  votes: r.votes,
  lastAskAt: r.last_ask_at,
  firstAskAt: r.created_at,
  status: r.status,
})

/** Questions, clusters and votes for live sessions. */
export class ClusterStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  pending(sessionId: string, limit: number): PendingMessage[] {
    const rows = this.db
      .prepare(
        `SELECT chat_id, message_id, user_id, text, reply_to FROM messages
         WHERE session_id = ? AND is_question IS NULL ORDER BY created_at, message_id LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{ chat_id: number; message_id: number; user_id: number; text: string; reply_to: number | null }>
    return rows.map((r) => ({
      chatId: r.chat_id,
      messageId: r.message_id,
      userId: r.user_id,
      text: r.text,
      isReply: r.reply_to !== null,
    }))
  }

  /** Marks messages as not questions without asking a model (prefilter rejects). */
  markNotQuestion(chatId: number, messageIds: number[]): void {
    const stmt = this.db.prepare('UPDATE messages SET is_question = 0 WHERE chat_id = ? AND message_id = ?')
    tx(this.db, () => messageIds.forEach((id) => stmt.run(chatId, id)))
  }

  /** Clusters a classifier may assign new messages to: anything not skipped. */
  assignable(sessionId: string): Array<{ id: string; title: string; status: ClusterStatus }> {
    return this.db
      .prepare("SELECT id, title, status FROM clusters WHERE session_id = ? AND status <> 'skipped' ORDER BY created_at")
      .all(sessionId) as Array<{ id: string; title: string; status: ClusterStatus }>
  }

  /**
   * Stores classifier results and updates every cluster they touch.
   * Unknown or skipped cluster ids become new clusters, so a model mistake can never drop a question.
   * Returns the ids of clusters that changed.
   */
  apply(sessionId: string, chatId: number, results: Classification[]): string[] {
    return tx(this.db, () => {
      const valid = new Set(this.assignable(sessionId).map((c) => c.id))
      const created = new Map<string, string>()
      const touched = new Set<string>()
      const setMessage = this.db.prepare(
        'UPDATE messages SET is_question = ?, spam = ?, canonical = ?, cluster_id = ? WHERE chat_id = ? AND message_id = ? AND session_id = ?',
      )

      for (const r of results) {
        if (!r.isQuestion || r.spam) {
          setMessage.run(r.isQuestion ? 1 : 0, r.spam ? 1 : 0, null, null, chatId, r.messageId, sessionId)
          continue
        }
        const canonical = clampTitle(r.canonical)
        let clusterId: string
        if (valid.has(r.cluster)) {
          clusterId = r.cluster
        } else {
          const label = r.cluster.startsWith('new:') ? r.cluster : `new:${r.messageId}`
          clusterId = created.get(label) ?? this.create(sessionId, canonical)
          created.set(label, clusterId)
        }
        setMessage.run(1, 0, canonical, clusterId, chatId, r.messageId, sessionId)
        touched.add(clusterId)
      }
      for (const id of touched) this.refresh(id)
      return [...touched]
    })
  }

  private create(sessionId: string, title: string): string {
    const id = newId('c')
    this.db
      .prepare("INSERT INTO clusters (id, session_id, title, status, created_at) VALUES (?, ?, ?, 'open', ?)")
      .run(id, sessionId, title, this.now())
    return id
  }

  /** Recomputes askers, votes, title and last ask time from the cluster's messages. */
  refresh(clusterId: string): void {
    const members = this.db
      .prepare(
        'SELECT user_id, canonical, created_at, anon_reactions FROM messages WHERE cluster_id = ? AND is_question = 1 ORDER BY created_at, message_id',
      )
      .all(clusterId) as Array<{ user_id: number; canonical: string; created_at: number; anon_reactions: number }>

    const status = (this.db.prepare('SELECT status FROM clusters WHERE id = ?').get(clusterId) as { status: ClusterStatus } | undefined)?.status
    if (!status) return
    if (!members.length) {
      // Only an untouched cluster disappears; one the host took or answered keeps its record.
      if (status === 'open') this.db.prepare('DELETE FROM clusters WHERE id = ?').run(clusterId)
      return
    }

    const askers = new Set(members.map((m) => m.user_id))
    // One vote per person per cluster; askers already count double, so their own reactions don't add.
    const voters = this.db
      .prepare(
        `SELECT DISTINCT v.user_id FROM votes v JOIN messages m ON m.chat_id = v.chat_id AND m.message_id = v.message_id
         WHERE m.cluster_id = ?`,
      )
      .all(clusterId) as Array<{ user_id: number }>
    const named = voters.filter((v) => !askers.has(v.user_id)).length
    const anonymous = members.reduce((n, m) => n + m.anon_reactions, 0)

    const times = members.map((m) => m.created_at)
    // created_at is the first ask, not when the batch ran: it breaks ranking ties in asking order.
    this.db
      .prepare('UPDATE clusters SET askers = ?, votes = ?, title = ?, last_ask_at = ?, created_at = ? WHERE id = ?')
      .run(askers.size, named + anonymous, pickTitle(members.map((m) => m.canonical)), Math.max(...times), Math.min(...times), clusterId)
  }

  /** Takes a message out of its cluster (it was edited and will be classified again). */
  detach(chatId: number, messageId: number): string | undefined {
    const row = this.db.prepare('SELECT cluster_id FROM messages WHERE chat_id = ? AND message_id = ?').get(chatId, messageId) as
      | { cluster_id: string | null }
      | undefined
    if (!row?.cluster_id) return undefined
    this.db.prepare('UPDATE messages SET cluster_id = NULL WHERE chat_id = ? AND message_id = ?').run(chatId, messageId)
    this.refresh(row.cluster_id)
    return row.cluster_id
  }

  /** Records a named reaction being added or removed. Returns the cluster it counts toward, if any. */
  react(chatId: number, messageId: number, userId: number, on: boolean): string | undefined {
    const msg = this.db.prepare('SELECT session_id, cluster_id FROM messages WHERE chat_id = ? AND message_id = ?').get(chatId, messageId) as
      | { session_id: string; cluster_id: string | null }
      | undefined
    if (!msg) return undefined
    if (on) {
      this.db.prepare('INSERT OR IGNORE INTO votes (session_id, chat_id, message_id, user_id) VALUES (?, ?, ?, ?)').run(msg.session_id, chatId, messageId, userId)
    } else {
      this.db.prepare('DELETE FROM votes WHERE chat_id = ? AND message_id = ? AND user_id = ?').run(chatId, messageId, userId)
    }
    if (msg.cluster_id) this.refresh(msg.cluster_id)
    return msg.cluster_id ?? undefined
  }

  /** Anonymous reaction totals (slow, grouped updates from Telegram). */
  setAnonymousReactions(chatId: number, messageId: number, total: number): string | undefined {
    const res = this.db.prepare('UPDATE messages SET anon_reactions = ? WHERE chat_id = ? AND message_id = ?').run(total, chatId, messageId)
    if (!res.changes) return undefined
    const row = this.db.prepare('SELECT cluster_id FROM messages WHERE chat_id = ? AND message_id = ?').get(chatId, messageId) as { cluster_id: string | null }
    if (row.cluster_id) this.refresh(row.cluster_id)
    return row.cluster_id ?? undefined
  }

  get(clusterId: string): Cluster | undefined {
    const row = this.db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId) as ClusterRow | undefined
    return row ? toCluster(row) : undefined
  }

  /** Open clusters, ranked. Answered, skipped and taken clusters drop out of the queue. */
  ranked(sessionId: string): Cluster[] {
    const rows = this.db.prepare("SELECT * FROM clusters WHERE session_id = ? AND status = 'open'").all(sessionId) as unknown as ClusterRow[]
    return rank(rows.map(toCluster), this.now())
  }

  /** The host took this question: it leaves the queue while being answered. */
  take(clusterId: string, at: number): void {
    this.db.prepare("UPDATE clusters SET status = 'taken', taken_at = ? WHERE id = ? AND status = 'open'").run(at, clusterId)
  }

  /** After a restart nobody is mid-answer: taken questions go back to the queue. Returns how many. */
  releaseTaken(sessionId: string): number {
    return Number(this.db.prepare("UPDATE clusters SET status = 'open', taken_at = NULL WHERE session_id = ? AND status = 'taken'").run(sessionId).changes)
  }

  /** Back to the queue (host put it back, or the take was abandoned). */
  release(clusterId: string): void {
    this.db.prepare("UPDATE clusters SET status = 'open', taken_at = NULL WHERE id = ? AND status = 'taken'").run(clusterId)
  }

  skip(clusterId: string): void {
    this.db.prepare("UPDATE clusters SET status = 'skipped' WHERE id = ? AND status IN ('open', 'taken')").run(clusterId)
  }

  markAnswered(clusterId: string, a: { at: number; summary: string; quote: string; offsetS: number; manual: boolean }): void {
    this.db
      .prepare(
        "UPDATE clusters SET status = 'answered', answered_at = ?, summary = ?, quote = ?, answer_offset_s = ?, manual = ? WHERE id = ?",
      )
      .run(a.at, a.summary, a.quote, a.offsetS, a.manual ? 1 : 0, clusterId)
  }

  setReplyMessage(clusterId: string, messageId: number): void {
    this.db.prepare('UPDATE clusters SET reply_message_id = ? WHERE id = ?').run(messageId, clusterId)
  }

  answer(clusterId: string): { summary: string | null; offsetS: number | null; replyMessageId: number | null } | undefined {
    const r = this.db.prepare('SELECT summary, answer_offset_s, reply_message_id FROM clusters WHERE id = ?').get(clusterId) as
      | { summary: string | null; answer_offset_s: number | null; reply_message_id: number | null }
      | undefined
    return r ? { summary: r.summary, offsetS: r.answer_offset_s, replyMessageId: r.reply_message_id } : undefined
  }

  /** Every captured message in a cluster (for reactions), oldest first. */
  messageIds(clusterId: string): number[] {
    return (this.db.prepare('SELECT message_id FROM messages WHERE cluster_id = ? AND is_question = 1 ORDER BY created_at').all(clusterId) as Array<{
      message_id: number
    }>).map((r) => r.message_id)
  }

  /** Askers of a cluster, oldest first: who to mention in the reply (phase 4). */
  askers(clusterId: string): Array<{ userId: number; userName: string; messageId: number }> {
    const rows = this.db
      .prepare(
        `SELECT user_id, user_name, MIN(message_id) AS message_id FROM messages
         WHERE cluster_id = ? AND is_question = 1 GROUP BY user_id ORDER BY MIN(created_at)`,
      )
      .all(clusterId) as Array<{ user_id: number; user_name: string; message_id: number }>
    return rows.map((r) => ({ userId: r.user_id, userName: r.user_name, messageId: r.message_id }))
  }
}
