// The kinds registry (SPEC.md section 2.2). Every kind that may appear in a `chartrunner:v1` memo is listed here with
// who signs it, what its leaves are, and what its id is. A kind not in this list is not a ChartRunner anchor.
//
// Adding a kind is a deliberate, versioned change (SPEC.md section 9). Never remove or redefine a kind.

/** Kinds written by the ChartRunner operator key: the fee payer is the published operator address. */
export const OPERATOR_KINDS = ["freeplay", "daily", "cup", "xp"] as const;
/** Kinds signed by the user's own wallet (the wallet is among the transaction's signers). Planned, not produced yet. */
export const USER_KINDS = ["map", "strategy", "bot", "backtest"] as const;
/** Every kind the memo grammar accepts. */
export const ANCHOR_KINDS = [...OPERATOR_KINDS, ...USER_KINDS] as const;

export type OperatorKind = (typeof OPERATOR_KINDS)[number];
export type UserKind = (typeof USER_KINDS)[number];
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

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
  cup: { kind: "cup", signer: "operator", status: "active", id: "cup id", leaf: "cup leaf (SPEC 7.2)", count: "any" },
  xp: { kind: "xp", signer: "operator", status: "reserved", id: "not defined yet", leaf: "not defined yet", count: "any" },
  map: { kind: "map", signer: "user", status: "planned", id: "opaque entity id", leaf: "single entity leaf, schema not defined yet", count: "one" },
  strategy: { kind: "strategy", signer: "user", status: "planned", id: "opaque entity id", leaf: "single entity leaf, schema not defined yet", count: "one" },
  bot: { kind: "bot", signer: "user", status: "planned", id: "opaque entity id", leaf: "single entity leaf, schema not defined yet", count: "one" },
  backtest: { kind: "backtest", signer: "user", status: "planned", id: "opaque entity id", leaf: "single entity leaf, schema not defined yet", count: "one" },
});

/** The id grammar shared by every kind. */
export const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const isKind = (k: unknown): k is AnchorKind => typeof k === "string" && (ANCHOR_KINDS as readonly string[]).includes(k);
export const isOperatorKind = (k: unknown): k is OperatorKind => typeof k === "string" && (OPERATOR_KINDS as readonly string[]).includes(k);
export const isUserKind = (k: unknown): k is UserKind => typeof k === "string" && (USER_KINDS as readonly string[]).includes(k);
/** Registry entry of a kind, or null when the kind is unknown. */
export const kindInfo = (k: unknown): Readonly<KindInfo> | null => (isKind(k) ? KINDS[k] : null);
