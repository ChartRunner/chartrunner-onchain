import { sha256Hex, type LeafEntry } from "./legacy-merkle";

// Pseudonymous identifiers used inside leaves. Isomorphic: /verify hashes a typed handle the same way the server did.

/** Stable pseudonym for an account (the account id itself never appears in a leaf). */
export const userHash = (userId: string): Promise<string> => sha256Hex(`chartrunner:user:${userId}`);
/** What a handle hashes to (lowercased: handles are case-insensitive). */
export const handleHash = (handle: string): Promise<string> => sha256Hex(`chartrunner:handle:${handle.toLowerCase()}`);
export const runHash = (runId: string): Promise<string> => sha256Hex(`chartrunner:run:${runId}`);

export interface BoardRow {
  userId: string;
  handle: string;
  runId: string;
  score: number;
  distance: number;
  createdAt: string;
}

/** Standard competition ranking (ties share a rank) over rows already sorted score desc. */
export function rankRows<T extends { score: number }>(rows: T[]): (T & { rank: number })[] {
  return rows.map((r) => ({ ...r, rank: rows.findIndex((x) => x.score === r.score) + 1 }));
}

/** One leaderboard leaf (format v1). Keep in sync with SPEC.md. */
export async function boardLeaf(kind: "freeplay" | "daily", date: string, row: BoardRow & { rank: number }): Promise<LeafEntry> {
  return {
    v: 1,
    k: kind,
    d: date,
    rank: row.rank,
    u: await userHash(row.userId),
    h: await handleHash(row.handle),
    s: row.score,
    dist: row.distance,
    r: await runHash(row.runId),
  };
}

/** The part of a frozen cup standing a leaf commits to (money values are the results document's decimal strings). */
export interface CupLeafRow {
  rank: number;
  userId: string;
  name: string;
  equity: string;
  pnlPct: string;
  trades: number;
  disqualified: boolean;
  fillsHash: string;
}

/**
 * One Trading Cup leaf (format v1, kind "cup"), built from the FROZEN canonical results: `u` / `h` are the pseudonyms of
 * the account and the displayed name, `eq` the final equity and `pct` the return as the results' fixed-decimal strings,
 * `tr` the exits, `dq` the disqualified flag, `fh` the hash of the fills behind the standing. Keep in sync with
 * SPEC.md.
 */
export async function cupLeaf(cupId: string, row: CupLeafRow): Promise<LeafEntry> {
  return {
    v: 1,
    k: "cup",
    id: cupId,
    rank: row.rank,
    u: await userHash(row.userId),
    h: await handleHash(row.name),
    eq: row.equity,
    pct: row.pnlPct,
    tr: row.trades,
    dq: row.disqualified,
    fh: row.fillsHash,
  };
}
