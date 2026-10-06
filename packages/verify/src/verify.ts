import {
  buildTree,
  canonicalJson,
  hashLeaf,
  isHash,
  maxProofLength,
  memoText,
  parseMemo,
  proveIndex,
  rootFromProof,
  type LeafEntry,
  type MemoFields,
  type ProofStep,
} from "./merkle.ts";
import { ANCHOR_KINDS, KINDS, isKind, type AnchorKind } from "./kinds.ts";

// The SDK surface: friendly names over the format-v1 primitives in merkle.ts / leaves.ts (which are the same code the
// ChartRunner app runs). Nothing here changes hashing or serialization.

/** One results row: a flat object of strings, safe integers, booleans and null (see cupLeaf / boardLeaf). */
export type ResultsRow = LeafEntry;

/** Canonical serialization of a results row: keys sorted, no whitespace. This exact text is what gets hashed. */
export const serializeRow = canonicalJson;
/** Hex sha256(0x00 || utf8(canonical row)). */
export const leafHash = (row: ResultsRow): Promise<string> => hashLeaf(canonicalJson(row));
/** Build the memo text `chartrunner:v1:<kind>:<id>:<root>:<count>`; throws on invalid fields. */
export const formatMemo = memoText;

export type MemoParseFailure = "not_a_chartrunner_memo" | "unknown_kind" | "malformed";
export type MemoParseResult = { ok: true; memo: MemoFields } | { ok: false; reason: MemoParseFailure; message: string };

/** Strict memo parse with a reason. Whitespace, case changes, extra fields and other versions are all rejected. */
export function parseMemoStrict(text: string): MemoParseResult {
  if (typeof text !== "string" || !text.startsWith("chartrunner:")) return { ok: false, reason: "not_a_chartrunner_memo", message: "Text is not a ChartRunner memo." };
  if (!text.startsWith("chartrunner:v1:")) return { ok: false, reason: "malformed", message: "Unsupported memo version (only chartrunner:v1 is defined)." };
  const memo = parseMemo(text);
  if (memo) return { ok: true, memo };
  const kind = text.split(":")[2];
  if (kind !== undefined && /^[a-z]+$/.test(kind) && !(ANCHOR_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: "unknown_kind", message: `Unknown anchor kind "${kind}".` };
  if (isKind(kind) && KINDS[kind].count === "one" && /^chartrunner:v1:[a-z]+:[A-Za-z0-9._-]{1,64}:[0-9a-f]{64}:[1-9][0-9]{0,8}$/.test(text)) return { ok: false, reason: "malformed", message: `Kind "${kind}" anchors a single leaf, so its count must be 1.` };
  return { ok: false, reason: "malformed", message: "Memo does not match chartrunner:v1:<kind>:<id>:<64-hex root>:<count>." };
}

/** Merkle root and leaf count of a set of rows (order does not matter). Throws on empty input or duplicate rows. */
export async function merkleRoot(rows: ResultsRow[]): Promise<{ root: string; count: number }> {
  const t = await buildTree(rows);
  return { root: t.root, count: t.count };
}

export interface MerkleProof {
  /** Position of the leaf in the sorted leaf list. */
  index: number;
  /** Canonical text of the row; this is what `verifyProof` hashes. */
  leaf: string;
  leafHash: string;
  proof: ProofStep[];
  root: string;
  count: number;
}

/** Inclusion proof for `target` (a row, or its index in the sorted leaves) within `rows`. */
export async function merkleProof(rows: ResultsRow[], target: ResultsRow | number): Promise<MerkleProof> {
  const t = await buildTree(rows);
  let index: number;
  let leaf: string;
  if (typeof target === "number") {
    index = target;
    leaf = t.prepared[index]?.canonical ?? "";
    if (!leaf) throw new Error("leaf index out of range");
  } else {
    leaf = canonicalJson(target);
    index = t.prepared.findIndex((p) => p.canonical === leaf);
    if (index < 0) throw new Error("row is not part of the set");
  }
  return { index, leaf, leafHash: t.leaves[index]!, proof: proveIndex(t, index), root: t.root, count: t.count };
}

// ---- verifyAgainstMemo ----------------------------------------------------------------------------------------------

export type VerifyFailureReason =
  | "memo_malformed" // the memo text is not a chartrunner:v1 memo
  | "memo_subject_mismatch" // memo kind/id differ from what the caller expected
  | "rows_invalid" // the rows cannot be serialized or committed (empty, duplicate, float, wrong type)
  | "leaf_invalid" // the leaf input is malformed
  | "proof_invalid" // the proof is malformed or longer than the memo's count allows
  | "root_mismatch" // the recomputed root differs from the memo's root
  | "count_mismatch" // the number of rows differs from the memo's count
  | "input_invalid"; // neither rows nor leaf+proof were supplied

export interface VerifyInputBase {
  /** The memo text exactly as stored on chain. */
  memoText: string;
  /** Optionally require the memo to be about this kind / id (guards against replaying another snapshot's memo). */
  expect?: { kind?: AnchorKind; id?: string };
}
export type VerifyRowsInput = VerifyInputBase & { rows: ResultsRow[]; leaf?: undefined; proof?: undefined };
export type VerifyProofInput = VerifyInputBase & { rows?: undefined; leaf: string | ResultsRow; proof: ProofStep[] };
export type VerifyInput = VerifyRowsInput | VerifyProofInput;

export type VerifyResult =
  | { ok: true; mode: "rows" | "proof"; memo: MemoFields; root: string }
  | { ok: false; reason: VerifyFailureReason; message: string; memo?: MemoFields; computedRoot?: string };

const fail = (reason: VerifyFailureReason, message: string, extra: { memo?: MemoFields; computedRoot?: string } = {}): VerifyResult => ({ ok: false, reason, message, ...extra });

/**
 * Check that a full set of rows (or one row + its proof) is committed by the root in an anchor memo.
 * Never throws and never returns a bare boolean: a failure always carries a reason.
 */
export async function verifyAgainstMemo(input: VerifyInput): Promise<VerifyResult> {
  const parsed = parseMemoStrict(input?.memoText as string);
  if (!parsed.ok) return fail("memo_malformed", parsed.message);
  const memo = parsed.memo;
  const want = input.expect;
  if (want?.kind !== undefined && want.kind !== memo.kind) return fail("memo_subject_mismatch", `Memo is for kind "${memo.kind}", expected "${want.kind}".`, { memo });
  if (want?.id !== undefined && want.id !== memo.id) return fail("memo_subject_mismatch", `Memo is for id "${memo.id}", expected "${want.id}".`, { memo });

  if (input.rows !== undefined) {
    if (!Array.isArray(input.rows) || input.rows.length === 0) return fail("rows_invalid", "rows must be a non-empty array.", { memo });
    let tree: Awaited<ReturnType<typeof buildTree>>;
    try {
      tree = await buildTree(input.rows);
    } catch (e) {
      return fail("rows_invalid", e instanceof Error ? e.message : "rows cannot be committed", { memo });
    }
    if (tree.root !== memo.root) return fail("root_mismatch", "The rows do not rebuild the root committed on chain.", { memo, computedRoot: tree.root });
    if (tree.count !== memo.count) return fail("count_mismatch", `The memo commits ${memo.count} rows, got ${tree.count}.`, { memo, computedRoot: tree.root });
    return { ok: true, mode: "rows", memo, root: tree.root };
  }

  if (input.leaf !== undefined && Array.isArray(input.proof)) {
    let canonical: string;
    try {
      canonical = typeof input.leaf === "string" ? input.leaf : canonicalJson(input.leaf);
    } catch (e) {
      return fail("leaf_invalid", e instanceof Error ? e.message : "leaf cannot be serialized", { memo });
    }
    if (typeof canonical !== "string" || canonical.length === 0) return fail("leaf_invalid", "leaf must be canonical JSON text or a row.", { memo });
    if (input.proof.some((s) => !s || (s.side !== "L" && s.side !== "R") || !isHash(s.hash))) return fail("proof_invalid", "A proof step is malformed.", { memo });
    if (input.proof.length > maxProofLength(memo.count)) return fail("proof_invalid", "The proof is longer than a tree with this many rows allows.", { memo });
    const computed = await rootFromProof(await hashLeaf(canonical), input.proof);
    if (computed !== memo.root) return fail("root_mismatch", "The leaf and proof do not lead to the root committed on chain.", { memo, computedRoot: computed });
    return { ok: true, mode: "proof", memo, root: computed };
  }

  return fail("input_invalid", "Provide either rows, or leaf and proof.");
}
