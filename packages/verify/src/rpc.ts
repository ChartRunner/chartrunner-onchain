import { verifyAgainstMemo, type VerifyFailureReason, type VerifyInput, type VerifyResult } from "./verify.ts";
import { parseMemo } from "./merkle.ts";
import { KINDS, type SignerModel } from "./kinds.ts";

// Reads the memo of an anchor transaction over plain JSON-RPC. There is no default endpoint: the caller supplies the URL
// (any Solana RPC, including one they run), so the SDK never embeds a secret or a shared key. Any outage is a failure
// with a reason; the SDK never answers "verified" without having read the memo.

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type RpcFailureReason = "rpc_url_invalid" | "signature_invalid" | "rpc_unreachable" | "rpc_error" | "tx_not_found" | "tx_failed" | "no_memo" | "multiple_memos" | "signer_mismatch" | "signature_mismatch" | "meta_missing";

export type FetchMemoResult =
  | {
      ok: true;
      memo: string;
      feePayer: string | null;
      /** Every account that signed the transaction (from the jsonParsed account keys); the fee payer comes first. */
      signers: string[];
      slot: number | null;
    }
  | { ok: false; reason: RpcFailureReason; message: string };

export interface FetchMemoOptions {
  /** Solana JSON-RPC endpoint, e.g. https://api.mainnet-beta.solana.com or your own. Required; there is no default. */
  rpcUrl: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Request timeout in ms (default 15000). */
  timeoutMs?: number;
  /** "finalized" (default, cannot be rolled back) or "confirmed". */
  commitment?: "confirmed" | "finalized";
  /**
   * The address that must have signed the anchor. For an operator kind, and for any text that is not a valid
   * chartrunner:v1 memo, it must be the FEE PAYER: pass the published operator address. For a user kind it must be
   * AMONG THE SIGNERS: pass the user's wallet. See SPEC.md section 2.4.
   */
  expectSigner?: string;
}

const bad = (reason: RpcFailureReason, message: string): FetchMemoResult => ({ ok: false, reason, message });

export async function fetchMemo(signature: string, opts: FetchMemoOptions): Promise<FetchMemoResult> {
  let url: URL;
  try {
    url = new URL(opts.rpcUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
  } catch {
    return bad("rpc_url_invalid", "rpcUrl must be an http(s) URL.");
  }
  if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return bad("signature_invalid", "signature is not a base58 transaction signature.");
  const doFetch = opts.fetch ?? globalThis.fetch;
  let body: any;
  try {
    const res = await doFetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: opts.commitment ?? "finalized" }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) return bad("rpc_unreachable", `RPC answered HTTP ${res.status}.`);
    body = await res.json();
  } catch (e) {
    return bad("rpc_unreachable", `Could not reach the RPC: ${e instanceof Error ? e.message : "unknown error"}.`);
  }
  if (!body || typeof body !== "object") return bad("rpc_error", "RPC returned an unreadable response.");
  if (body.error) return bad("rpc_error", `RPC error: ${String(body.error?.message ?? "unknown")}.`);
  const tx = body.result;
  if (tx === null || tx === undefined) return bad("tx_not_found", "RPC has no confirmed transaction with that signature (wrong signature, not yet confirmed, or pruned history).");
  if (!tx.meta || typeof tx.meta !== "object") return bad("meta_missing", "RPC returned the transaction without execution metadata, so success cannot be confirmed.");
  if (tx.meta.err !== null) return bad("tx_failed", "The transaction failed on chain (or its status is not reported), so it anchors nothing.");
  if (!Array.isArray(tx.transaction?.signatures) || tx.transaction.signatures[0] !== signature) return bad("signature_mismatch", "RPC returned a different transaction than the signature asked for.");
  const msg = tx.transaction?.message;
  const memos = (msg?.instructions ?? []).filter((i: any) => i?.programId === MEMO_PROGRAM_ID && typeof i.parsed === "string");
  if (memos.length === 0) return bad("no_memo", "The transaction has no SPL Memo instruction.");
  if (memos.length > 1) return bad("multiple_memos", "The transaction has more than one Memo instruction.");
  const keys: unknown[] = Array.isArray(msg?.accountKeys) ? msg.accountKeys : [];
  const k = keys[0] as any;
  const feePayer: string | null = k ? (typeof k === "string" ? k : (k.pubkey ?? null)) : null;
  const signers = signersOf(keys, feePayer);
  const memo = memos[0].parsed as string;
  if (opts.expectSigner !== undefined) {
    const model = signerModelOf(memo);
    if (model === "operator" && feePayer !== opts.expectSigner) return bad("signer_mismatch", `The transaction was paid by ${feePayer ?? "unknown"}, not the expected operator address.`);
    if (model === "user" && !signers.includes(opts.expectSigner)) return bad("signer_mismatch", "The expected wallet is not among the signers of this transaction.");
  }
  return { ok: true, memo, feePayer, signers, slot: typeof tx.slot === "number" ? tx.slot : null };
}

/** The signer model that applies to a memo: its kind's model for a valid chartrunner:v1 memo, else "operator" (the strictest). */
export function signerModelOf(memo: string): SignerModel {
  const f = parseMemo(memo);
  return f ? KINDS[f.kind].signer : "operator";
}

/** Signers from jsonParsed account keys (`{ pubkey, signer }`). Plain string keys carry no signer flag, so only the fee payer is known. */
function signersOf(keys: unknown[], feePayer: string | null): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (key && typeof key === "object" && (key as { signer?: unknown }).signer === true) {
      const pk = (key as { pubkey?: unknown }).pubkey;
      if (typeof pk === "string" && !out.includes(pk)) out.push(pk);
    }
  }
  if (feePayer !== null && !out.includes(feePayer)) out.unshift(feePayer);
  return out;
}

export type VerifyOnChainResult =
  | (Extract<VerifyResult, { ok: true }> & { feePayer: string | null; signers: string[]; slot: number | null; signature: string })
  | { ok: false; reason: VerifyFailureReason | RpcFailureReason; message: string; memo?: Extract<VerifyResult, { ok: true }>["memo"]; computedRoot?: string };

export type VerifyOnChainInput = (Omit<VerifyInput, "memoText"> & { signature: string }) & FetchMemoOptions;

/** Fetch the memo of `signature` from the chain, then run verifyAgainstMemo on it. Any RPC problem is a failure with a reason. */
export async function verifyAgainstSignature(input: VerifyOnChainInput): Promise<VerifyOnChainResult> {
  const { signature, rpcUrl, fetch: f, timeoutMs, commitment, expectSigner, ...rest } = input;
  const got = await fetchMemo(signature, { rpcUrl, fetch: f, timeoutMs, commitment, expectSigner });
  if (!got.ok) return got;
  const res = await verifyAgainstMemo({ ...(rest as object), memoText: got.memo } as VerifyInput);
  return res.ok ? { ...res, feePayer: got.feePayer, signers: got.signers, slot: got.slot, signature } : res;
}
