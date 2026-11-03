import { isBattleWindowId } from "./kinds.ts";
import { canonicalJson, isHash, sha256Hex, type LeafEntry } from "./merkle.ts";

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

// ---- fills hash (SPEC 7.2.1) -------------------------------------------------------------------------------------

/** A decimal fill value: a number (written with toFixed, negative zero without the sign) or an already fixed string. */
export type FillDecimal = number | string;

/**
 * One fill as the fills hash reads it (SPEC 7.2.1), in the order the server accepted it; the final sweep's liquidations
 * come last. Only these fields are committed; any other field of the input (a client id, an internal flag) is ignored.
 * `seq` is the 1-based position and is assigned here; when the input carries one, it must equal that position.
 */
export interface FillInput {
  seq?: number;
  /** Epoch milliseconds (integer). */
  t: number;
  symbol: string;
  side: "long" | "short";
  kind: "open" | "add" | "reduce" | "close" | "liquidation";
  orderType: "market" | "limit" | "stop" | "liquidation";
  /** 10 decimals. */
  qty: FillDecimal;
  /** 8 decimals. */
  price: FillDecimal;
  /** 8 decimals. */
  fee: FillDecimal;
  /** 8 decimals, or null. */
  realized: FillDecimal | null;
  /** 8 decimals, or null. */
  net: FillDecimal | null;
  leverage: number;
}

const FILL_SIDES = ["long", "short"] as const;
const FILL_KINDS = ["open", "add", "reduce", "close", "liquidation"] as const;
/** Order types of cup fills; battle fills use only "market" and "liquidation". */
export const CUP_ORDER_TYPES = ["market", "limit", "stop", "liquidation"] as const;
export const BATTLE_ORDER_TYPES = ["market", "liquidation"] as const;

/** Fixed decimal with exactly `d` decimals: optional "-", no leading zeros, never a negative zero. */
function fixedDecimal(v: unknown, d: number, field: string, i: number): string {
  let out: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`invalid fill ${i}: ${field} must be finite`);
    out = v.toFixed(d);
    if (/^-0\.0+$/.test(out)) out = out.slice(1);
  } else if (typeof v === "string") {
    out = v;
  } else {
    throw new Error(`invalid fill ${i}: ${field} must be a number or a decimal string`);
  }
  const re = new RegExp(`^-?(0|[1-9][0-9]*)\\.[0-9]{${d}}$`);
  if (!re.test(out) || /^-0\.0+$/.test(out)) throw new Error(`invalid fill ${i}: ${field} must be a decimal with exactly ${d} decimals (no exponent, no "+", no negative zero), got ${JSON.stringify(out)}`);
  return out;
}

/**
 * The committed form of a fill list (SPEC 7.2.1): one object per fill with exactly the keys
 * `fee, kind, leverage, net, orderType, price, qty, realized, seq, side, symbol, t`. Throws on any value outside the
 * definition. `orderTypes` narrows the allowed order types (battles: BATTLE_ORDER_TYPES).
 */
export function fillsCommitment(fills: readonly FillInput[], orderTypes: readonly string[] = CUP_ORDER_TYPES): LeafEntry[] {
  if (!Array.isArray(fills)) throw new Error("fills must be an array");
  return fills.map((f, idx) => {
    const i = idx + 1;
    if (typeof f !== "object" || f === null) throw new Error(`invalid fill ${i}: not an object`);
    if (f.seq !== undefined && f.seq !== i) throw new Error(`invalid fill ${i}: seq must be its 1-based position ${i}`);
    if (!Number.isSafeInteger(f.t)) throw new Error(`invalid fill ${i}: t must be integer epoch milliseconds`);
    if (typeof f.symbol !== "string" || f.symbol === "") throw new Error(`invalid fill ${i}: symbol must be a non-empty string`);
    if (!(FILL_SIDES as readonly string[]).includes(f.side)) throw new Error(`invalid fill ${i}: side must be long or short`);
    if (!(FILL_KINDS as readonly string[]).includes(f.kind)) throw new Error(`invalid fill ${i}: kind must be one of ${FILL_KINDS.join(", ")}`);
    if (!orderTypes.includes(f.orderType)) throw new Error(`invalid fill ${i}: orderType must be one of ${orderTypes.join(", ")}`);
    if (!Number.isSafeInteger(f.leverage)) throw new Error(`invalid fill ${i}: leverage must be an integer`);
    return {
      seq: i,
      t: f.t,
      symbol: f.symbol,
      side: f.side,
      kind: f.kind,
      orderType: f.orderType,
      qty: fixedDecimal(f.qty, 10, "qty", i),
      price: fixedDecimal(f.price, 8, "price", i),
      fee: fixedDecimal(f.fee, 8, "fee", i),
      realized: f.realized === null ? null : fixedDecimal(f.realized, 8, "realized", i),
      net: f.net === null ? null : fixedDecimal(f.net, 8, "net", i),
      leverage: f.leverage,
    };
  });
}

/** Canonical text of a fill list (SPEC 7.2.1): `[` + each fill's canonical object (section 3) joined by `,` + `]`. */
export const fillsCanonical = (fills: readonly FillInput[], orderTypes: readonly string[] = CUP_ORDER_TYPES): string =>
  `[${fillsCommitment(fills, orderTypes).map(canonicalJson).join(",")}]`;

/**
 * `fh` of a cup or battle standing (SPEC 7.2.1): lowercase hex SHA-256 of the UTF-8 canonical text of the fill list,
 * fills in submission order followed by the final sweep's liquidations. An empty list hashes `[]`
 * (4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945). A consistency check, not proof of fair execution.
 */
export const fillsHash = (fills: readonly FillInput[], orderTypes: readonly string[] = CUP_ORDER_TYPES): Promise<string> =>
  sha256Hex(fillsCanonical(fills, orderTypes));
