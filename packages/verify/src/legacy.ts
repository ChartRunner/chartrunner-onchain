// The legacy `cr1:` memo format (SPEC.md section 10). Frozen and read-only: this SDK parses it so existing anchors can be
// read, but nothing new is written in it and it gets no new kinds. It is NOT a chartrunner:v1 anchor: it is signed by the
// user's wallet, carries a free-text name, and commits to one content hash rather than a Merkle root.
//
// The rules below are exactly those of the reader that has always parsed these memos: four fields split on ":", the
// version `cr1`, a known kind, a non-empty name of at most 64 UTF-8 bytes, and a 64-character lowercase hex hash.

export const LEGACY_CR1_PREFIX = "cr1:";
/** The only legacy kinds. Frozen: no new kinds are ever added to cr1. */
export const LEGACY_CR1_KINDS = ["map"] as const;
export type LegacyCr1Kind = (typeof LEGACY_CR1_KINDS)[number];
export const LEGACY_CR1_NAME_MAX_BYTES = 64;

export interface LegacyCr1Memo {
  version: "cr1";
  kind: LegacyCr1Kind;
  /** Free text chosen by the user (never contains ":"). Display it as untrusted text. */
  name: string;
  /** 32 bytes as 64 lowercase hex characters. */
  contentHash: string;
}

const enc = new TextEncoder();

/** Strictly parse a legacy `cr1:<kind>:<name>:<hash-hex>` memo. Returns null for anything else (no trimming). */
export function parseLegacyCr1(text: string): LegacyCr1Memo | null {
  if (typeof text !== "string") return null;
  const parts = text.split(":");
  if (parts.length !== 4) return null;
  const [version, kind, name, hash] = parts as [string, string, string, string];
  if (version !== "cr1") return null;
  if (!(LEGACY_CR1_KINDS as readonly string[]).includes(kind)) return null;
  if (name === "" || enc.encode(name).length > LEGACY_CR1_NAME_MAX_BYTES) return null;
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  return { version: "cr1", kind: kind as LegacyCr1Kind, name, contentHash: hash };
}
