import { isBattleWindowId } from "./kinds.ts";
import { isHash, sha256Hex, type LeafEntry } from "./merkle.ts";

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

/** A battle id as it appears in a battle leaf: a lowercase UUID (8-4-4-4-12 hex). The battle's join code never does. */
export const BATTLE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Battle equity: a non-negative decimal string with exactly 6 decimals, no leading zeros, no sign ("10842.120000"). */
export const BATTLE_EQUITY_RE = /^(0|[1-9][0-9]*)\.[0-9]{6}$/;
/** Battle return in percent: a decimal string with exactly 4 decimals, "-" when negative, no "+", never "-0.0000". */
export const BATTLE_PCT_RE = /^(?!-0\.0000$)-?(0|[1-9][0-9]*)\.[0-9]{4}$/;

/** The part of one frozen battle standing a battle leaf commits to (money values are decimal strings, as in a cup). */
export interface BattleLeafRow {
  /** The battle's id, a lowercase UUID. Never the battle's join code. */
  battleId: string;
  /** The standing's rank in the battle's frozen results, 1 or more. */
  rank: number;
  userId: string;
  /** The displayed name the standings show (hashed into `h` exactly like a cup standing's name). */
  name: string;
  /** Final equity, exactly 6 decimals. */
  equity: string;
  /** Return in percent, exactly 4 decimals, possibly negative. */
  pnlPct: string;
  /** Number of exits, 0 or more. */
  trades: number;
  /** Knocked out (Last Man Standing). */
  out: boolean;
  /** Reached the target (Profit Race). */
  finished: boolean;
  /** `fillsHash` of the standing, defined as for a cup standing (SPEC 7.2): 64 lowercase hex. */
  fillsHash: string;
}

const BATTLE_LEAF_KEYS = ["b", "eq", "fh", "fin", "h", "id", "k", "out", "pct", "rank", "tr", "u", "v"] as const;
const isNonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * Why a value is not a valid battle leaf (SPEC 7.5), or null when it is: exactly the keys
 * `b, eq, fh, fin, h, id, k, out, pct, rank, tr, u, v`, each with its documented type and format. Pass `windowId` to
 * also require the leaf's `id` to be that window (the memo id of the anchor it belongs to).
 */
export function battleLeafProblem(leaf: unknown, windowId?: string): string | null {
  if (typeof leaf !== "object" || leaf === null || Array.isArray(leaf)) return "a battle leaf must be a flat object";
  const o = leaf as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== BATTLE_LEAF_KEYS.length || keys.some((k, i) => k !== BATTLE_LEAF_KEYS[i])) return `a battle leaf has exactly the keys ${BATTLE_LEAF_KEYS.join(", ")}`;
  if (o.v !== 1) return "v must be 1";
  if (o.k !== "battle") return 'k must be "battle"';
  if (!isBattleWindowId(o.id)) return "id must be a 4-hour UTC window YYYY-MM-DDTHH (HH 00, 04, 08, 12, 16 or 20) on a real date";
  if (windowId !== undefined && o.id !== windowId) return `id must be the anchor's window ${windowId}`;
  if (typeof o.b !== "string" || !BATTLE_UUID_RE.test(o.b)) return "b must be a lowercase UUID";
  if (!isNonNegInt(o.rank) || o.rank < 1) return "rank must be an integer, 1 or more";
  if (!isHash(o.u)) return "u must be 64 lowercase hex";
  if (!isHash(o.h)) return "h must be 64 lowercase hex";
  if (typeof o.eq !== "string" || !BATTLE_EQUITY_RE.test(o.eq)) return "eq must be a non-negative decimal string with exactly 6 decimals";
  if (typeof o.pct !== "string" || !BATTLE_PCT_RE.test(o.pct)) return 'pct must be a decimal string with exactly 4 decimals ("-" when negative, never "-0.0000")';
  if (!isNonNegInt(o.tr)) return "tr must be an integer, 0 or more";
  if (typeof o.out !== "boolean") return "out must be a boolean";
  if (typeof o.fin !== "boolean") return "fin must be a boolean";
  if (!isHash(o.fh)) return "fh must be 64 lowercase hex";
  return null;
}

/** True when `leaf` is a valid battle leaf (SPEC 7.5), optionally of the given window. */
export const isBattleLeaf = (leaf: unknown, windowId?: string): leaf is LeafEntry => battleLeafProblem(leaf, windowId) === null;

/**
 * One battle leaf (format v1, kind "battle"): one frozen standing of one battle whose results were frozen in the 4-hour
 * UTC window `windowId`. `u` / `h` are the pseudonyms of the account and the displayed name (as in a cup leaf), `b` the
 * battle's UUID, `eq` / `pct` the final equity and return as fixed-decimal strings, `tr` the exits, `out` knocked out,
 * `fin` reached the target, `fh` the hash of the fills. Throws when any input is outside SPEC 7.5. Keep in sync with
 * SPEC.md section 7.5.
 */
export async function battleLeaf(windowId: string, row: BattleLeafRow): Promise<LeafEntry> {
  if (typeof row?.userId !== "string" || row.userId === "") throw new Error("invalid battle leaf: userId must be a non-empty string");
  if (typeof row.name !== "string") throw new Error("invalid battle leaf: name must be a string");
  const leaf: LeafEntry = {
    v: 1,
    k: "battle",
    id: windowId,
    b: row.battleId,
    rank: row.rank,
    u: await userHash(row.userId),
    h: await handleHash(row.name),
    eq: row.equity,
    pct: row.pnlPct,
    tr: row.trades,
    out: row.out,
    fin: row.finished,
    fh: row.fillsHash,
  };
  const problem = battleLeafProblem(leaf);
  if (problem) throw new Error(`invalid battle leaf: ${problem}`);
  return leaf;
}
