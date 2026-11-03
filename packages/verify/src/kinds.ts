// The kinds registry (SPEC.md section 2.2). Every kind that may appear in a `chartrunner:v1` memo is listed here with
// who signs it, what its leaves are, and what its id is. A kind not in this list is not a ChartRunner anchor.
//
// Adding a kind is a deliberate, versioned change (SPEC.md section 9). Never remove or redefine a kind.

/** Kinds written by the ChartRunner operator key: the fee payer is the published operator address. */
export const OPERATOR_KINDS = ["freeplay", "daily", "cup", "xp", "dailyrun", "dailyrace", "battle"] as const;
/** Kinds signed by the user's own wallet (the wallet is among the transaction's signers). Planned, not produced yet. */
export const USER_KINDS = ["map", "strategy", "bot", "backtest"] as const;
/**
 * Every kind the memo grammar accepts, in the order the kinds were registered. Append-only, like the `kinds` list of
 * test-vectors/v1.json: a new kind goes at the end, whatever its signer model.
 */
export const ANCHOR_KINDS = ["freeplay", "daily", "cup", "xp", "map", "strategy", "bot", "backtest", "dailyrun", "dailyrace", "battle"] as const;

export type OperatorKind = (typeof OPERATOR_KINDS)[number];
export type UserKind = (typeof USER_KINDS)[number];
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

// Compile-time guard: ANCHOR_KINDS is exactly the operator kinds plus the user kinds, nothing more and nothing less.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _registryComplete: Same<AnchorKind, OperatorKind | UserKind> = true;
void _registryComplete;

/** Who must have signed an anchor of this kind. */
export type SignerModel = "operator" | "user";
/** active: produced now. reserved: accepted, not produced, leaf schema open. planned: accepted, not produced yet. */
export type KindStatus = "active" | "reserved" | "planned";

export interface KindInfo {
  kind: AnchorKind;
  signer: SignerModel;
  status: KindStatus;
  /** What the memo id is. Always within the id grammar `[A-Za-z0-9._-]{1,64}`; never a free-text name. */
  id: string;
  /** The leaf schema (SPEC.md section 7). */
  leaf: string;
  /** "any": count is the number of leaves. "one": a single-leaf root, count is always 1. */
  count: "any" | "one";
}

export const KINDS: Readonly<Record<AnchorKind, Readonly<KindInfo>>> = Object.freeze({
  freeplay: { kind: "freeplay", signer: "operator", status: "active", id: "UTC date YYYY-MM-DD", leaf: "board leaf (SPEC 7.1)", count: "any" },
  daily: { kind: "daily", signer: "operator", status: "active", id: "UTC date YYYY-MM-DD", leaf: "board leaf (SPEC 7.1)", count: "any" },
  dailyrun: { kind: "dailyrun", signer: "operator", status: "active", id: "UTC date YYYY-MM-DD", leaf: "Daily Run leaf (SPEC 7.3)", count: "any" },
  dailyrace: { kind: "dailyrace", signer: "operator", status: "active", id: "UTC date YYYY-MM-DD", leaf: "Daily Race leaf (SPEC 7.4)", count: "any" },
  battle: { kind: "battle", signer: "operator", status: "active", id: "4-hour UTC window YYYY-MM-DDTHH (HH 00, 04, 08, 12, 16 or 20)", leaf: "battle leaf (SPEC 7.5)", count: "any" },
  cup: { kind: "cup", signer: "operator", status: "active", id: "cup id", leaf: "cup leaf (SPEC 7.2)", count: "any" },
  xp: { kind: "xp", signer: "operator", status: "reserved", id: "not defined yet", leaf: "not defined yet", count: "any" },
  map: { kind: "map", signer: "user", status: "planned", id: "opaque entity id", leaf: "single entity leaf, schema not defined yet", count: "one" },
  strategy: { kind: "strategy", signer: "user", status: "planned", id: "opaque entity id", leaf: "single entity leaf, schema not defined yet", count: "one" },
  bot: { kind: "bot", signer: "user", status: "planned", id: "opaque entity id", leaf: "single entity leaf, schema not defined yet", count: "one" },
  backtest: { kind: "backtest", signer: "user", status: "planned", id: "opaque entity id", leaf: "single entity leaf, schema not defined yet", count: "one" },
});

/** The id grammar shared by every kind. */
export const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Most leaves one `battle` anchor may carry (SPEC 7.5). Splitting a busier window is not defined in v1. */
export const MAX_BATTLE_LEAVES = 10_000;

const BATTLE_WINDOW_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T(00|04|08|12|16|20)$/;

/**
 * A `battle` id: the 4-hour UTC window `YYYY-MM-DDTHH`, HH one of 00, 04, 08, 12, 16, 20, on a real Gregorian
 * calendar date (year 0001 to 9999). Uppercase `T` only; nothing else is accepted. The window is [HH:00, HH+4:00) UTC.
 */
export function isBattleWindowId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const m = BATTLE_WINDOW_RE.exec(id);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

/**
 * The per-kind rules on top of the shared memo grammar (SPEC 2.1, 2.2): a user kind's count is 1; a `battle` id is a
 * 4-hour UTC window and its count is at most MAX_BATTLE_LEAVES. Returns a reason, or null when the pair is allowed.
 * Every kind registered before `battle` has no rule here beyond the count rule, so no earlier memo changes meaning.
 */
export function kindRuleViolation(kind: AnchorKind, id: string, count: number): string | null {
  if (KINDS[kind].count === "one" && count !== 1) return `Kind "${kind}" anchors a single leaf, so its count must be 1.`;
  if (kind === "battle") {
    if (!isBattleWindowId(id)) return 'A "battle" id must be a 4-hour UTC window YYYY-MM-DDTHH with HH 00, 04, 08, 12, 16 or 20, on a real date.';
    if (count > MAX_BATTLE_LEAVES) return `A "battle" anchor carries at most ${MAX_BATTLE_LEAVES} leaves.`;
  }
  return null;
}

export const isKind = (k: unknown): k is AnchorKind => typeof k === "string" && (ANCHOR_KINDS as readonly string[]).includes(k);
export const isOperatorKind = (k: unknown): k is OperatorKind => typeof k === "string" && (OPERATOR_KINDS as readonly string[]).includes(k);
export const isUserKind = (k: unknown): k is UserKind => typeof k === "string" && (USER_KINDS as readonly string[]).includes(k);
/** Registry entry of a kind, or null when the kind is unknown. */
export const kindInfo = (k: unknown): Readonly<KindInfo> | null => (isKind(k) ? KINDS[k] : null);
