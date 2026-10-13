import { sha256Hex, type LeafEntry } from "./merkle.ts";

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

/**
 * Standard competition ranking over rows already sorted best first by `key`: equal keys share a rank (1, 2, 2, 4).
 * The Daily Run board ranks by score (higher first), the Daily Race board by finish tick (lower first); the caller
 * sorts, this only numbers.
 */
export function rankRowsBy<T>(rows: readonly T[], key: (row: T) => number): (T & { rank: number })[] {
  const out: (T & { rank: number })[] = [];
  rows.forEach((r, i) => {
    const prev = out[i - 1];
    out.push({ ...r, rank: prev !== undefined && key(rows[i - 1]!) === key(r) ? prev.rank : i + 1 });
  });
  return out;
}

/** One row of a Daily Run board (best score per player on one UTC date's shared chart, mode "run"). */
export interface DailyRunRow {
  userId: string;
  handle: string;
  runId: string;
  score: number;
  distance: number;
  /** The run was played in HARDCORE (same board, marked). */
  hardcore: boolean;
  /** The best run survived the 2:00 timer (the run's `finished`). */
  finished: boolean;
  createdAt: string;
}

/** One row of a Daily Race board (lowest finish tick per player on one UTC date's shared chart, arrived races only). */
export interface DailyRaceRow {
  userId: string;
  handle: string;
  runId: string;
  /** The race time in simulation ticks (60 per second): the tick the run crossed the line. */
  finishTick: number;
  distance: number;
  /** The run was played in HARDCORE (same board, marked). */
  hardcore: boolean;
  createdAt: string;
}

/**
 * One Daily Run leaf (format v1, kind "dailyrun"): the board leaf of SPEC 7.1 plus `hc` (HARDCORE) and `fin`
 * (survived the timer). Rank is by score, ties share a rank. Keep in sync with SPEC.md section 7.3.
 */
export async function dailyRunLeaf(date: string, row: DailyRunRow & { rank: number }): Promise<LeafEntry> {
  return {
    v: 1,
    k: "dailyrun",
    d: date,
    rank: row.rank,
    u: await userHash(row.userId),
    h: await handleHash(row.handle),
    s: row.score,
    dist: row.distance,
    hc: row.hardcore,
    fin: row.finished,
    r: await runHash(row.runId),
  };
}

/**
 * One Daily Race leaf (format v1, kind "dailyrace"): `ft` (finish tick) in place of the score, plus `hc` (HARDCORE).
 * Rank is by finish tick, lowest first, ties share a rank. Keep in sync with SPEC.md section 7.4.
 */
export async function dailyRaceLeaf(date: string, row: DailyRaceRow & { rank: number }): Promise<LeafEntry> {
  return {
    v: 1,
    k: "dailyrace",
    d: date,
    rank: row.rank,
    u: await userHash(row.userId),
    h: await handleHash(row.handle),
    ft: row.finishTick,
    dist: row.distance,
    hc: row.hardcore,
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

/** The standing fields a cup leaf commits to, as stored in a frozen results document (extra fields are ignored). */
export type CupStandingInput = CupLeafRow;

/** Leaves of a frozen cup: one per standing, in standing order. The same construction the app anchors. */
export async function cupLeavesFromStandings(cupId: string, standings: readonly CupStandingInput[]): Promise<LeafEntry[]> {
  return Promise.all(
    standings.map((s) => cupLeaf(cupId, { rank: s.rank, userId: s.userId, name: s.name, equity: s.equity, pnlPct: s.pnlPct, trades: s.trades, disqualified: s.disqualified, fillsHash: s.fillsHash })),
  );
}
