/** Ranking from the spec: score = 2 x unique askers + votes + 3 if the last ask was under 2 minutes ago. */

export interface RankableCluster {
  id: string
  title: string
  askers: number
  votes: number
  lastAskAt: number | null
  /** Creation order, used as the final tie-break so the list does not shuffle. */
  firstAskAt: number
}

export const RECENT_MS = 2 * 60_000
export const RECENT_BONUS = 3

export function score(c: RankableCluster, now: number): number {
  const recent = c.lastAskAt !== null && now - c.lastAskAt < RECENT_MS ? RECENT_BONUS : 0
  return 2 * c.askers + c.votes + recent
}

/** Open clusters, best first. Ties go to more askers, then to whoever asked first. */
export function rank<T extends RankableCluster>(clusters: T[], now: number): T[] {
  return [...clusters].sort(
    (a, b) => score(b, now) - score(a, now) || b.askers - a.askers || a.firstAskAt - b.firstAskAt || a.id.localeCompare(b.id),
  )
}
