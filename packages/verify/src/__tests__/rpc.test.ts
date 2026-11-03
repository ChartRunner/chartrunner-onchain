import { describe, expect, it } from "vitest";
import { fetchMemo, MEMO_PROGRAM_ID, verifyAgainstSignature } from "../index.ts";
import { formatMemo, merkleRoot } from "../index.ts";

const SIG = "5".repeat(88);
const PAYER = "Op3rat0rAddressxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const rows = [{ id: "a", s: 1 }, { id: "b", s: 2 }];

const tx = (memo: string, over: Record<string, unknown> = {}) => ({
  slot: 77,
  meta: { err: null },
  transaction: {
    signatures: [SIG],
    message: {
      accountKeys: [{ pubkey: PAYER }],
      instructions: [{ programId: "ComputeBudget111111111111111111111111111111", data: "x" }, { programId: MEMO_PROGRAM_ID, parsed: memo }],
    },
  },
  ...over,
});
const reply = (result: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status })) as typeof fetch;
const opts = (f: typeof fetch) => ({ rpcUrl: "https://rpc.example", fetch: f });

describe("fetchMemo", () => {
  it("reads the memo, fee payer and slot", async () => {
    expect(await fetchMemo(SIG, opts(reply(tx("hello"))))).toEqual({ ok: true, memo: "hello", feePayer: PAYER, signers: [PAYER], slot: 77, signatureCheck: "not_requested" });
  });
  it("counts every Memo-program instruction, parsed or not: a second one is refused, never 'take the first'", async () => {
    const two = tx("chartrunner:v1:cup:c1:" + "a".repeat(64) + ":1");
    (two.transaction.message.instructions as unknown[]).push({ programId: MEMO_PROGRAM_ID, data: "3Bxs4Bc3VYuGVB19" });
    expect(await fetchMemo(SIG, opts(reply(two)))).toMatchObject({ ok: false, reason: "multiple_memos" });
    const unparsed = tx("x");
    (unparsed.transaction.message.instructions as { parsed?: unknown }[])[1]!.parsed = undefined;
    expect(await fetchMemo(SIG, opts(reply(unparsed)))).toMatchObject({ ok: false, reason: "no_memo" });
  });
  it("sends the getTransaction request to the supplied URL only", async () => {
    let seen: { url: string; body: any } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ result: tx("m") }));
    }) as unknown as typeof fetch;
    await fetchMemo(SIG, opts(f));
    expect(seen?.url).toBe("https://rpc.example/");
    expect(seen?.body).toMatchObject({ method: "getTransaction", params: [SIG, { encoding: "jsonParsed" }] });
  });
  it("fails with a reason on every outage shape, never ok", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchMemo(SIG, opts(down))).toMatchObject({ ok: false, reason: "rpc_unreachable" });
    expect(await fetchMemo(SIG, opts(reply(null, 503)))).toMatchObject({ ok: false, reason: "rpc_unreachable" });
    const bad = (async () => new Response("<html>")) as unknown as typeof fetch;
    expect(await fetchMemo(SIG, opts(bad))).toMatchObject({ ok: false, reason: "rpc_unreachable" });
    const err = (async () => new Response(JSON.stringify({ error: { message: "rate limited" } }))) as unknown as typeof fetch;
    expect(await fetchMemo(SIG, opts(err))).toMatchObject({ ok: false, reason: "rpc_error" });
    expect(await fetchMemo(SIG, opts(reply(null)))).toMatchObject({ ok: false, reason: "tx_not_found" });
    expect(await fetchMemo(SIG, opts(reply(tx("m", { meta: { err: { InstructionError: [0, "x"] } } }))))).toMatchObject({ ok: false, reason: "tx_failed" });
    expect(await fetchMemo(SIG, opts(reply({ ...tx("m"), transaction: { signatures: [SIG], message: { accountKeys: [], instructions: [] } } })))).toMatchObject({ ok: false, reason: "no_memo" });
  });
  it("fails when execution metadata is missing or null (never treated as success)", async () => {
    expect(await fetchMemo(SIG, opts(reply(tx("m", { meta: undefined }))))).toMatchObject({ ok: false, reason: "meta_missing" });
    expect(await fetchMemo(SIG, opts(reply(tx("m", { meta: null }))))).toMatchObject({ ok: false, reason: "meta_missing" });
    expect(await fetchMemo(SIG, opts(reply(tx("m", { meta: {} }))))).toMatchObject({ ok: false, reason: "tx_failed" });
  });
  it("fails when the returned transaction is not the one asked for", async () => {
    const other = "6".repeat(88);
    expect(await fetchMemo(SIG, opts(reply(tx("m", { transaction: { signatures: [other], message: tx("m").transaction.message } }))))).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(await fetchMemo(SIG, opts(reply(tx("m", { transaction: { message: tx("m").transaction.message } }))))).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });
  it("defaults to finalized commitment and allows confirmed", async () => {
    const seen: string[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string).params[1].commitment);
      return new Response(JSON.stringify({ result: tx("m") }));
    }) as unknown as typeof fetch;
    await fetchMemo(SIG, opts(f));
    await fetchMemo(SIG, { ...opts(f), commitment: "confirmed" });
    expect(seen).toEqual(["finalized", "confirmed"]);
  });
  it("validates url and signature before any request", async () => {
    const never = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect(await fetchMemo(SIG, { rpcUrl: "", fetch: never })).toMatchObject({ ok: false, reason: "rpc_url_invalid" });
    expect(await fetchMemo(SIG, { rpcUrl: "file:///etc/passwd", fetch: never })).toMatchObject({ ok: false, reason: "rpc_url_invalid" });
    expect(await fetchMemo("short", { rpcUrl: "https://x.example", fetch: never })).toMatchObject({ ok: false, reason: "signature_invalid" });
  });
  it("enforces the expected signer", async () => {
    expect(await fetchMemo(SIG, { ...opts(reply(tx("m"))), expectSigner: "someoneElse" })).toMatchObject({ ok: false, reason: "signer_mismatch" });
    expect(await fetchMemo(SIG, { ...opts(reply(tx("m"))), expectSigner: PAYER })).toMatchObject({ ok: true });
  });
});

describe("fetchMemo: account-key shapes and the signer model (SPEC 2.4 rule 6)", () => {
  const OPERATOR = "So11111111111111111111111111111111111111112";
  const WALLET = "Vote111111111111111111111111111111111111111";
  const OTHER = "Stake11111111111111111111111111111111111111";
  const LOADED = "SysvarRent111111111111111111111111111111111";
  const ROOT = "a".repeat(64);
  const cupMemo = formatMemo({ kind: "cup", id: "c1", root: ROOT, count: 3 });
  const mapMemo = formatMemo({ kind: "map", id: "ent-1", root: ROOT, count: 1 });
  const key = (pubkey: string, signer: boolean, source = "transaction") => ({ pubkey, signer, writable: signer, source });
  const withKeys = (memo: string, accountKeys: unknown[], extra: Record<string, unknown> = {}) => ({
    slot: 90,
    version: 0,
    meta: { err: null, loadedAddresses: { writable: [], readonly: [LOADED] } },
    transaction: { signatures: [SIG], message: { accountKeys, instructions: [{ programId: MEMO_PROGRAM_ID, parsed: memo }], ...extra } },
  });

  it("a v0 transaction with lookup-table addresses: loaded keys never count as signers", async () => {
    const keys = [key(OPERATOR, true), key(MEMO_PROGRAM_ID, false), key(LOADED, false, "lookupTable")];
    const v0 = withKeys(cupMemo, keys, { addressTableLookups: [{ accountKey: OTHER, writableIndexes: [], readonlyIndexes: [0] }] });
    expect(await fetchMemo(SIG, { ...opts(reply(v0)), expectSigner: OPERATOR })).toEqual({ ok: true, memo: cupMemo, feePayer: OPERATOR, signers: [OPERATOR], slot: 90, signatureCheck: "not_requested" });
    // A user kind cannot be "signed" by an address that only arrived through a lookup table.
    expect(await fetchMemo(SIG, { ...opts(reply(withKeys(mapMemo, keys))), expectSigner: LOADED })).toMatchObject({ ok: false, reason: "signer_mismatch" });
  });
  it("operator kind: the operator co-signing while someone else pays is a signer_mismatch", async () => {
    const cosigned = [key(OTHER, true), key(OPERATOR, true)];
    const r = await fetchMemo(SIG, { ...opts(reply(withKeys(cupMemo, cosigned))), expectSigner: OPERATOR });
    expect(r).toMatchObject({ ok: false, reason: "signer_mismatch" });
    expect(!r.ok && r.message).toContain(OTHER);
  });
  it("user kind: the expected wallet among the signers passes, whoever pays", async () => {
    const sponsored = [key(OTHER, true), key(WALLET, true), key(MEMO_PROGRAM_ID, false)];
    expect(await fetchMemo(SIG, { ...opts(reply(withKeys(mapMemo, sponsored))), expectSigner: WALLET })).toMatchObject({ ok: true, feePayer: OTHER, signers: [OTHER, WALLET] });
  });
  it("plain-string account keys carry no signer flags: only the fee payer is known to have signed", async () => {
    const plain = [OPERATOR, WALLET, MEMO_PROGRAM_ID];
    expect(await fetchMemo(SIG, opts(reply(withKeys(cupMemo, plain))))).toMatchObject({ ok: true, feePayer: OPERATOR, signers: [OPERATOR] });
    expect(await fetchMemo(SIG, { ...opts(reply(withKeys(cupMemo, plain))), expectSigner: OPERATOR })).toMatchObject({ ok: true });
    expect(await fetchMemo(SIG, { ...opts(reply(withKeys(mapMemo, plain))), expectSigner: WALLET })).toMatchObject({ ok: false, reason: "signer_mismatch" });
    expect(await fetchMemo(SIG, { ...opts(reply(withKeys(mapMemo, plain))), expectSigner: OPERATOR })).toMatchObject({ ok: true, signers: [OPERATOR] });
  });
});

describe("verifyAgainstSignature", () => {
  it("verifies rows against the on-chain memo", async () => {
    const { root, count } = await merkleRoot(rows);
    const memo = formatMemo({ kind: "cup", id: "c1", root, count });
    expect(await verifyAgainstSignature({ ...opts(reply(tx(memo))), signature: SIG, rows })).toMatchObject({ ok: true, feePayer: PAYER, slot: 77, signature: SIG });
  });
  it("reports a mismatch and an outage with reasons", async () => {
    const memo = formatMemo({ kind: "cup", id: "c1", root: "0".repeat(64), count: 2 });
    expect(await verifyAgainstSignature({ ...opts(reply(tx(memo))), signature: SIG, rows })).toMatchObject({ ok: false, reason: "root_mismatch" });
    expect(await verifyAgainstSignature({ ...opts(reply(tx("not a memo"))), signature: SIG, rows })).toMatchObject({ ok: false, reason: "memo_malformed" });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await verifyAgainstSignature({ ...opts(down), signature: SIG, rows })).toMatchObject({ ok: false, reason: "rpc_unreachable" });
  });
});
