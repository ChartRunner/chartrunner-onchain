import { verifyAgainstMemo, type VerifyFailureReason, type VerifyInput, type VerifyResult } from "./verify.ts";
import { parseMemo } from "./merkle.ts";
import { KINDS, type SignerModel } from "./kinds.ts";
import { checkTransactionSignatures } from "./sigcheck.ts";

// Reads the memo of an anchor transaction over plain JSON-RPC. There is no default endpoint: the caller supplies the URL
// (any Solana RPC, including one they run), so the SDK never embeds a secret or a shared key. Any outage is a failure
// with a reason; the SDK never answers "verified" without having read the memo.

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type RpcFailureReason =
  | "rpc_url_invalid"
  | "signature_invalid"
  | "rpc_unreachable"
  | "rpc_error"
  | "tx_not_found"
  | "tx_failed"
  | "no_memo"
  | "multiple_memos"
  | "signer_mismatch"
  | "signature_mismatch"
  | "meta_missing"
  // Only with verifySignature: the RPC's wire bytes are malformed, a signature does not verify, or the signed bytes
  // disagree with what the RPC reported in jsonParsed form. Each means the RPC's answer cannot be trusted.
  | "tx_undecodable"
  | "bad_signature"
  | "tx_mismatch";

/**
 * Whether the transaction's signatures were checked locally (verifySignature):
 * "verified": every required Ed25519 signature verified over the wire bytes, and memo, fee payer and signers were read
 *   from those signed bytes; "unsupported": requested, but this runtime has no WebCrypto Ed25519 (the answer rests on
 *   the RPC alone); "not_requested": verifySignature was off.
 */
export type SignatureCheck = "verified" | "unsupported" | "not_requested";

export type FetchMemoResult =
  | {
      ok: true;
      memo: string;
      feePayer: string | null;
      /** Every account that signed the transaction (from the jsonParsed account keys); the fee payer comes first. */
      signers: string[];
      slot: number | null;
      signatureCheck: SignatureCheck;
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
  /**
   * Also fetch the wire transaction (base64) and verify its Ed25519 signatures locally with WebCrypto, then require the
   * signed bytes to carry the same signature, fee payer, signers and single memo the RPC reported. Removes the need to
   * trust the RPC for anything but availability and execution status (meta.err is not signed). Default false.
   */
  verifySignature?: boolean;
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
  const commitment = opts.commitment ?? "finalized";
  const got = await getTransaction(doFetch, url, signature, "jsonParsed", commitment, opts.timeoutMs);
  if (!got.ok) return got.fail;
  const tx = got.tx;
  const msg = tx.transaction?.message;
  // Every instruction of the Memo program counts, parsed or not: more than one is refused, never "take the first".
  const memos = (msg?.instructions ?? []).filter((i: any) => i?.programId === MEMO_PROGRAM_ID);
  if (memos.length === 0) return bad("no_memo", "The transaction has no SPL Memo instruction.");
  if (memos.length > 1) return bad("multiple_memos", "The transaction has more than one Memo instruction.");
  if (typeof memos[0].parsed !== "string") return bad("no_memo", "The transaction's Memo instruction is not readable text.");
  const keys: unknown[] = Array.isArray(msg?.accountKeys) ? msg.accountKeys : [];
  const k = keys[0] as any;
  let feePayer: string | null = k ? (typeof k === "string" ? k : (k.pubkey ?? null)) : null;
  let signers = signersOf(keys, feePayer);
  const memo = memos[0].parsed as string;
  let signatureCheck: SignatureCheck = "not_requested";
  if (opts.verifySignature) {
    const wire = await getTransaction(doFetch, url, signature, "base64", commitment, opts.timeoutMs);
    if (!wire.ok) return wire.fail;
    const b64 = Array.isArray(wire.tx.transaction) ? wire.tx.transaction[0] : undefined;
    const local = await checkTransactionSignatures(typeof b64 === "string" ? b64 : "", MEMO_PROGRAM_ID);
    if (!local.ok) return bad(local.reason, local.message);
    const f = local.facts;
    if (f.signatures[0] !== signature) return bad("tx_mismatch", "The signed bytes are a different transaction than the signature asked for.");
    if (f.signers[0] !== feePayer) return bad("tx_mismatch", "The signed bytes name a different fee payer than the RPC reported.");
    if (f.memos.length !== 1 || f.memos[0] !== memo) return bad("tx_mismatch", "The signed bytes carry a different memo than the RPC reported.");
    if (signers.some((s) => !f.signers.includes(s))) return bad("tx_mismatch", "The RPC reported a signer that did not sign the bytes.");
    // From here on, signers and fee payer come from the signed bytes.
    feePayer = f.signers[0]!;
    signers = f.signers;
    signatureCheck = local.status;
  }
  if (opts.expectSigner !== undefined) {
    const model = signerModelOf(memo);
    if (model === "operator" && feePayer !== opts.expectSigner) return bad("signer_mismatch", `The transaction was paid by ${feePayer ?? "unknown"}, not the expected operator address.`);
    if (model === "user" && !signers.includes(opts.expectSigner)) return bad("signer_mismatch", "The expected wallet is not among the signers of this transaction.");
  }
  return { ok: true, memo, feePayer, signers, slot: typeof tx.slot === "number" ? tx.slot : null, signatureCheck };
}

type TxRead = { ok: true; tx: any } | { ok: false; fail: FetchMemoResult };

/** One getTransaction call with every rule that does not depend on the encoding (2.4 rules 2 to 4). */
async function getTransaction(doFetch: typeof fetch, url: URL, signature: string, encoding: "jsonParsed" | "base64", commitment: string, timeoutMs: number | undefined): Promise<TxRead> {
  let body: any;
  try {
    const res = await doFetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding, maxSupportedTransactionVersion: 0, commitment }] }),
      signal: AbortSignal.timeout(timeoutMs ?? 15_000),
    });
    if (!res.ok) return { ok: false, fail: bad("rpc_unreachable", `RPC answered HTTP ${res.status}.`) };
    body = await res.json();
  } catch (e) {
    return { ok: false, fail: bad("rpc_unreachable", `Could not reach the RPC: ${e instanceof Error ? e.message : "unknown error"}.`) };
  }
  if (!body || typeof body !== "object") return { ok: false, fail: bad("rpc_error", "RPC returned an unreadable response.") };
  if (body.error) return { ok: false, fail: bad("rpc_error", `RPC error: ${String(body.error?.message ?? "unknown")}.`) };
  const tx = body.result;
  if (tx === null || tx === undefined) return { ok: false, fail: bad("tx_not_found", "RPC has no confirmed transaction with that signature (wrong signature, not yet confirmed, or pruned history).") };
  if (!tx.meta || typeof tx.meta !== "object") return { ok: false, fail: bad("meta_missing", "RPC returned the transaction without execution metadata, so success cannot be confirmed.") };
  if (tx.meta.err !== null) return { ok: false, fail: bad("tx_failed", "The transaction failed on chain (or its status is not reported), so it anchors nothing.") };
  if (encoding === "jsonParsed" && (!Array.isArray(tx.transaction?.signatures) || tx.transaction.signatures[0] !== signature)) {
    return { ok: false, fail: bad("signature_mismatch", "RPC returned a different transaction than the signature asked for.") };
  }
  return { ok: true, tx };
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
  | (Extract<VerifyResult, { ok: true }> & { feePayer: string | null; signers: string[]; slot: number | null; signature: string; signatureCheck: SignatureCheck })
  | { ok: false; reason: VerifyFailureReason | RpcFailureReason; message: string; memo?: Extract<VerifyResult, { ok: true }>["memo"]; computedRoot?: string };

export type VerifyOnChainInput = (Omit<VerifyInput, "memoText"> & { signature: string }) & FetchMemoOptions;

/** Fetch the memo of `signature` from the chain, then run verifyAgainstMemo on it. Any RPC problem is a failure with a reason. */
export async function verifyAgainstSignature(input: VerifyOnChainInput): Promise<VerifyOnChainResult> {
  const { signature, rpcUrl, fetch: f, timeoutMs, commitment, expectSigner, verifySignature, ...rest } = input;
  const got = await fetchMemo(signature, { rpcUrl, fetch: f, timeoutMs, commitment, expectSigner, verifySignature });
  if (!got.ok) return got;
  const res = await verifyAgainstMemo({ ...(rest as object), memoText: got.memo } as VerifyInput);
  return res.ok ? { ...res, feePayer: got.feePayer, signers: got.signers, slot: got.slot, signature, signatureCheck: got.signatureCheck } : res;
}
