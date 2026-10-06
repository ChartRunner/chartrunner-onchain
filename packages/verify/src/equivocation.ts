import { ID_RE, isOperatorKind, type OperatorKind } from "./kinds.ts";
import { parseMemo } from "./merkle.ts";
import { fetchMemo } from "./rpc.ts";

// Equivocation check (SPEC.md section 2.5). The first finalized operator memo for a (kind, id) is the anchor. If the
// operator ever wrote a second, different memo for the same (kind, id), that is equivocation and must be visible.
//
// This scans the operator address's finalized signature history over plain JSON-RPC, picks the transactions whose memo
// mentions the (kind, id), re-reads each one with the same strict checks as fetchMemo (success, exactly one memo, fee
// payer = operator) and reports every anchor found. Like the rest of the SDK it never turns an outage or a partial scan
// into an answer: anything it could not read is a failure with a reason, never "none" or "unique".

export interface AnchorSighting {
  signature: string;
  slot: number | null;
  blockTime: number | null;
  memo: string;
  root: string;
  count: number;
}

export type EquivocationStatus =
  | "none" // no operator anchor for this (kind, id)
  | "unique" // exactly one
  | "duplicate" // several, all committing to the same root and count (harmless, but should not happen)
  | "equivocation"; // several with different roots or counts

export type EquivocationFailure = "input_invalid" | "rpc_url_invalid" | "rpc_unreachable" | "rpc_error" | "scan_incomplete";

export type EquivocationResult =
  | {
      ok: true;
      status: EquivocationStatus;
      /** The first finalized anchor (lowest slot). Null when there is none, or when two different memos share that slot. */
      winner: AnchorSighting | null;
      /** Every operator anchor for this (kind, id), oldest first. */
      anchors: AnchorSighting[];
      /** Number of signatures read from the operator's history. */
      scanned: number;
    }
  | { ok: false; reason: EquivocationFailure; message: string };

export interface EquivocationOptions {
  /** Solana JSON-RPC endpoint. Required; there is no default. */
  rpcUrl: string;
  /** The published operator address for this cluster. */
  operator: string;
  kind: OperatorKind;
  id: string;
  /**
   * Upper bound on signatures read. A history longer than this is a failure (scan_incomplete), not a partial answer.
   * Default 100000: anyone can spam the operator address with memo-less transactions, and those cost only page reads.
   */
  maxSignatures?: number;
  /** Page size for getSignaturesForAddress (1 to 1000, default 1000). */
  pageSize?: number;
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
}

interface SignatureInfo {
  signature: string;
  slot?: number;
  err?: unknown;
  memo?: string | null;
  blockTime?: number | null;
}

const fail = (reason: EquivocationFailure, message: string): EquivocationResult => ({ ok: false, reason, message });

export async function checkEquivocation(opts: EquivocationOptions): Promise<EquivocationResult> {
  if (!isOperatorKind(opts.kind)) return fail("input_invalid", "The equivocation rule applies to operator kinds only.");
  if (typeof opts.id !== "string" || !ID_RE.test(opts.id)) return fail("input_invalid", "id does not match the id grammar.");
  if (typeof opts.operator !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(opts.operator)) return fail("input_invalid", "operator is not a base58 address.");
  let url: URL;
  try {
    url = new URL(opts.rpcUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
  } catch {
    return fail("rpc_url_invalid", "rpcUrl must be an http(s) URL.");
  }
  const pageSize = Math.min(1000, Math.max(1, Math.floor(opts.pageSize ?? 1000)));
  const maxSignatures = Math.max(1, Math.floor(opts.maxSignatures ?? DEFAULT_MAX_SIGNATURES));
  const doFetch = opts.fetch ?? globalThis.fetch;
  const needle = `chartrunner:v1:${opts.kind}:${opts.id}:`;

  // 1. Page through the operator's finalized history, newest first, until it ends. Only an EMPTY page ends it: a node
  //    may return fewer than `limit` entries mid-history, so a short page is not the end.
  const candidates: SignatureInfo[] = [];
  let scanned = 0;
  let before: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = await rpc<SignatureInfo[]>(doFetch, url, opts.timeoutMs, "getSignaturesForAddress", [opts.operator, { limit: pageSize, commitment: "finalized", ...(before ? { before } : {}) }]);
    if (!page.ok) return page.fail;
    if (!Array.isArray(page.result) || page.result.some((s) => !s || typeof s.signature !== "string")) return fail("rpc_error", "RPC returned an unreadable signature list.");
    if (page.result.length === 0) break; // end of history
    // A cursor that does not move (the page's last signature was already seen) would loop forever or hide history.
    const last = page.result[page.result.length - 1]!.signature;
    if (seen.has(last)) return fail("scan_incomplete", `The RPC returned the same page of the operator's history twice (cursor ${last}); the scan cannot finish, so uniqueness was not checked.`);
    for (const s of page.result) seen.add(s.signature);
    scanned += page.result.length;
    for (const s of page.result) {
      if (s.err !== null && s.err !== undefined) continue; // failed transactions anchor nothing
      // `memo: null` means the transaction has no memo. A missing field means the RPC did not say: read the transaction.
      if (s.memo === null) continue;
      if (typeof s.memo === "string" && !s.memo.includes(needle)) continue;
      candidates.push(s);
    }
    if (scanned >= maxSignatures) {
      return fail(
        "scan_incomplete",
        `Read ${scanned} signatures of the operator's history without reaching its start (limit ${maxSignatures}), so uniqueness was not checked. Raise maxSignatures (CLI: --max-signatures).`,
      );
    }
    before = last;
  }

  // 2. Re-read each candidate with the strict single-transaction checks.
  const anchors: AnchorSighting[] = [];
  for (const c of candidates) {
    const got = await fetchMemo(c.signature, { rpcUrl: opts.rpcUrl, fetch: doFetch, timeoutMs: opts.timeoutMs, commitment: "finalized", expectSigner: opts.operator });
    if (!got.ok) {
      if (got.reason === "rpc_unreachable" || got.reason === "rpc_error") return fail(got.reason, got.message);
      if (got.reason === "tx_not_found" || got.reason === "meta_missing") return fail("scan_incomplete", `Could not read transaction ${c.signature}: ${got.message}`);
      continue; // failed, not a memo transaction, or not paid by the operator: not an operator anchor
    }
    const m = parseMemo(got.memo);
    if (!m || m.kind !== opts.kind || m.id !== opts.id) continue;
    anchors.push({ signature: c.signature, slot: got.slot ?? c.slot ?? null, blockTime: typeof c.blockTime === "number" ? c.blockTime : null, memo: got.memo, root: m.root, count: m.count });
  }

  // 3. First finalized wins: lowest slot.
  return { ok: true, ...classifyAnchors(anchors), scanned };
}

/** Default limit on signatures read by checkEquivocation. */
export const DEFAULT_MAX_SIGNATURES = 100_000;

/** Sort by slot and classify (SPEC 2.5): status, and the first finalized anchor (null on a tie between different memos). */
export function classifyAnchors(found: AnchorSighting[]): { status: EquivocationStatus; winner: AnchorSighting | null; anchors: AnchorSighting[] } {
  const anchors = [...found].sort((a, b) => (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER));
  const distinct = new Set(anchors.map((a) => `${a.root}:${a.count}`));
  const status: EquivocationStatus = anchors.length === 0 ? "none" : anchors.length === 1 ? "unique" : distinct.size === 1 ? "duplicate" : "equivocation";
  let winner: AnchorSighting | null = anchors[0] ?? null;
  if (winner) {
    const first = winner;
    const tied = anchors.filter((a) => a.slot === first.slot);
    if (first.slot === null || new Set(tied.map((a) => `${a.root}:${a.count}`)).size > 1) winner = null;
  }
  return { status, winner, anchors };
}

/**
 * Where the transaction being verified stands under "first finalized operator memo per (kind, id) wins" (SPEC 2.5).
 * The checked anchor is added to the scan's anchors first (deduplicated by signature) and the status and winner are
 * recomputed, so an anchor in hand plus one found in history is never "unique" or "none".
 *
 * - `sole`: the only anchor. Pass.
 * - `duplicate`: other anchors with the same root and count. Pass, with a warning (the data verified is identical).
 * - `equivocation_first`: other anchors with different roots or counts, and the checked one is the first finalized.
 *   Pass, with a loud warning: the operator equivocated, and this is the anchor that counts.
 * - `not_first`: other anchors with different roots or counts and the checked one is not the winner (or there is no
 *   winner because two different memos share the lowest slot). Fail: this anchor is void.
 */
export type AnchorStanding =
  | { standing: "sole"; pass: true }
  | { standing: "duplicate"; pass: true; first: AnchorSighting | null; count: number }
  | { standing: "equivocation_first"; pass: true; others: AnchorSighting[] }
  | { standing: "not_first"; pass: false; winner: AnchorSighting | null; others: AnchorSighting[] };

export function anchorStanding(result: Extract<EquivocationResult, { ok: true }>, checked: AnchorSighting): AnchorStanding & { result: Extract<EquivocationResult, { ok: true }> } {
  const merged = result.anchors.some((a) => a.signature === checked.signature) ? result.anchors : [...result.anchors, checked];
  const c = classifyAnchors(merged);
  const updated = { ...result, ...c };
  const others = c.anchors.filter((a) => a.signature !== checked.signature);
  if (c.status === "unique") return { standing: "sole", pass: true, result: updated };
  if (c.status === "duplicate") return { standing: "duplicate", pass: true, first: c.winner, count: c.anchors.length, result: updated };
  if (c.winner && c.winner.signature === checked.signature) return { standing: "equivocation_first", pass: true, others, result: updated };
  return { standing: "not_first", pass: false, winner: c.winner, others, result: updated };
}

type RpcOutcome<T> = { ok: true; result: T } | { ok: false; fail: EquivocationResult };

async function rpc<T>(doFetch: typeof fetch, url: URL, timeoutMs: number | undefined, method: string, params: unknown[]): Promise<RpcOutcome<T>> {
  let body: any;
  try {
    const res = await doFetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs ?? 15_000),
    });
    if (!res.ok) return { ok: false, fail: fail("rpc_unreachable", `RPC answered HTTP ${res.status}.`) };
    body = await res.json();
  } catch (e) {
    return { ok: false, fail: fail("rpc_unreachable", `Could not reach the RPC: ${e instanceof Error ? e.message : "unknown error"}.`) };
  }
  if (!body || typeof body !== "object") return { ok: false, fail: fail("rpc_error", "RPC returned an unreadable response.") };
  if (body.error) return { ok: false, fail: fail("rpc_error", `RPC error: ${String(body.error?.message ?? "unknown")}.`) };
  return { ok: true, result: body.result as T };
}
