import { afterEach, describe, expect, it, vi } from "vitest";
import { base58Decode, base58Encode, checkTransactionSignatures, fetchMemo, formatMemo, MEMO_PROGRAM_ID, merkleRoot } from "../index.ts";
import { main } from "../cli.ts";

// Real Ed25519 signatures over real wire bytes (legacy message: [payer, Memo program], one Memo instruction).

const shortvec = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, pub, address: base58Encode(pub) };
}

/** Build and sign a transaction carrying `memos` (each one Memo instruction). */
async function signedTx(payer: Awaited<ReturnType<typeof keypair>>, memos: string[]) {
  const memoKey = base58Decode(MEMO_PROGRAM_ID)!;
  const enc = new TextEncoder();
  const msg = [1, 0, 1, ...shortvec(2), ...payer.pub, ...memoKey, ...crypto.getRandomValues(new Uint8Array(32)), ...shortvec(memos.length)];
  for (const m of memos) {
    const d = enc.encode(m);
    msg.push(1, ...shortvec(0), ...shortvec(d.length), ...d);
  }
  const message = Uint8Array.from(msg);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, payer.kp.privateKey, message));
  const wire = Uint8Array.from([...shortvec(1), ...sig, ...message]);
  return { signature: base58Encode(sig), base64: Buffer.from(wire).toString("base64"), wire };
}

const parsedTx = (signature: string, payer: string, memos: string[]) => ({
  slot: 77,
  meta: { err: null },
  transaction: { signatures: [signature], message: { accountKeys: [{ pubkey: payer, signer: true }, { pubkey: MEMO_PROGRAM_ID, signer: false }], instructions: memos.map((m) => ({ programId: MEMO_PROGRAM_ID, parsed: m })) } },
});

/** Fake RPC answering getTransaction in both encodings (and anything else via `extra`). */
function rpc(parsed: unknown, base64: string | null, extra: (method: string, params: any[]) => unknown = () => null) {
  return (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    let result: unknown;
    if (method === "getTransaction") result = params[1].encoding === "base64" ? (base64 === null ? null : { slot: 77, meta: { err: null }, transaction: [base64, "base64"] }) : parsed;
    else result = extra(method, params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as unknown as typeof fetch;
}

describe("base58", () => {
  it("round-trips, keeps leading zeros, and matches known Solana encodings", () => {
    expect(base58Encode(base58Decode(MEMO_PROGRAM_ID)!)).toBe(MEMO_PROGRAM_ID);
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    expect(base58Decode("0OIl")).toBeNull();
  });
});

describe("checkTransactionSignatures", () => {
  it("verifies a real signature and reads signers and memos from the signed bytes", async () => {
    const payer = await keypair();
    const t = await signedTx(payer, ["hello"]);
    expect(await checkTransactionSignatures(t.base64, MEMO_PROGRAM_ID)).toEqual({ ok: true, status: "verified", facts: { signatures: [t.signature], signers: [payer.address], memos: ["hello"] } });
  });
  it("rejects bytes that the key did not sign", async () => {
    const payer = await keypair();
    const t = await signedTx(payer, ["hello"]);
    const tampered = Uint8Array.from(t.wire);
    tampered[tampered.length - 1]! ^= 1; // "hellp"
    expect(await checkTransactionSignatures(Buffer.from(tampered).toString("base64"), MEMO_PROGRAM_ID)).toMatchObject({ ok: false, reason: "bad_signature" });
  });
  it("rejects undecodable input", async () => {
    expect(await checkTransactionSignatures("not base64!", MEMO_PROGRAM_ID)).toMatchObject({ ok: false, reason: "tx_undecodable" });
    expect(await checkTransactionSignatures(Buffer.from([1, 2, 3]).toString("base64"), MEMO_PROGRAM_ID)).toMatchObject({ ok: false, reason: "tx_undecodable" });
  });
  it("says 'unsupported', never 'verified', without Ed25519 in WebCrypto", async () => {
    const payer = await keypair();
    const t = await signedTx(payer, ["hello"]);
    const noEd = { generateKey: async () => Promise.reject(new DOMException("nope", "NotSupportedError")) } as unknown as SubtleCrypto;
    expect(await checkTransactionSignatures(t.base64, MEMO_PROGRAM_ID, noEd)).toMatchObject({ ok: true, status: "unsupported" });
    expect(await checkTransactionSignatures(t.base64, MEMO_PROGRAM_ID, null)).toMatchObject({ ok: true, status: "unsupported" });
  });
});

describe("fetchMemo({ verifySignature })", () => {
  const OTHER = "So11111111111111111111111111111111111111112";

  it("verified: memo, fee payer and signers come from the signed bytes", async () => {
    const payer = await keypair();
    const t = await signedTx(payer, ["hello"]);
    const r = await fetchMemo(t.signature, { rpcUrl: "https://rpc.example", fetch: rpc(parsedTx(t.signature, payer.address, ["hello"]), t.base64), verifySignature: true, expectSigner: payer.address });
    expect(r).toEqual({ ok: true, memo: "hello", feePayer: payer.address, signers: [payer.address], slot: 77, signatureCheck: "verified" });
  });
  it("an RPC that reports another memo or fee payer than the signed bytes is caught", async () => {
    const payer = await keypair();
    const t = await signedTx(payer, ["the real memo"]);
    const opts = { rpcUrl: "https://rpc.example", verifySignature: true };
    expect(await fetchMemo(t.signature, { ...opts, fetch: rpc(parsedTx(t.signature, payer.address, ["a forged memo"]), t.base64) })).toMatchObject({ ok: false, reason: "tx_mismatch" });
    expect(await fetchMemo(t.signature, { ...opts, fetch: rpc(parsedTx(t.signature, OTHER, ["the real memo"]), t.base64) })).toMatchObject({ ok: false, reason: "tx_mismatch" });
  });
  it("forged bytes fail; a missing wire transaction is tx_not_found, never a pass", async () => {
    const payer = await keypair();
    const t = await signedTx(payer, ["hello"]);
    const forged = Uint8Array.from(t.wire);
    forged[70]! ^= 1;
    const p = parsedTx(t.signature, payer.address, ["hello"]);
    expect(await fetchMemo(t.signature, { rpcUrl: "https://rpc.example", verifySignature: true, fetch: rpc(p, Buffer.from(forged).toString("base64")) })).toMatchObject({ ok: false });
    expect(await fetchMemo(t.signature, { rpcUrl: "https://rpc.example", verifySignature: true, fetch: rpc(p, null) })).toMatchObject({ ok: false, reason: "tx_not_found" });
  });
  it("two Memo instructions in the signed bytes are refused even if the RPC shows one", async () => {
    const payer = await keypair();
    const t = await signedTx(payer, ["one", "two"]);
    expect(await fetchMemo(t.signature, { rpcUrl: "https://rpc.example", verifySignature: true, fetch: rpc(parsedTx(t.signature, payer.address, ["one"]), t.base64) })).toMatchObject({ ok: false, reason: "tx_mismatch" });
  });
});

describe("CLI --verify-signature and --check-equivocation", async () => {
  const rows = [{ id: "a", s: 1 }, { id: "b", s: 2 }, { id: "c", s: 3 }];
  const { root, count } = await merkleRoot(rows);
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "cr-cli-eq-")), "rows.json");
  writeFileSync(file, JSON.stringify(rows));
  afterEach(() => vi.unstubAllGlobals());

  async function setup(history: { memo: string; slot: number; self?: boolean }[]) {
    const payer = await keypair();
    const memo = formatMemo({ kind: "cup", id: "c1", root, count });
    const t = await signedTx(payer, [memo]);
    const others = await Promise.all(history.filter((x) => !x.self).map(async (x) => ({ ...x, tx: await signedTx(payer, [x.memo]) })));
    const all = [...history.filter((x) => x.self).map((x) => ({ ...x, tx: t })), ...others];
    const bySig = new Map(all.map((x) => [x.tx.signature, x]));
    const f = (async (_url: string, init: RequestInit) => {
      const { method, params } = JSON.parse(init.body as string);
      let result: unknown = null;
      if (method === "getSignaturesForAddress") result = params[1].before ? [] : all.map((x) => ({ signature: x.tx.signature, slot: x.slot, err: null, memo: `[${x.memo.length}] ${x.memo}` }));
      if (method === "getTransaction") {
        const x = bySig.get(params[0]) ?? (params[0] === t.signature ? { memo, slot: 50, tx: t } : undefined);
        if (x) result = params[1].encoding === "base64" ? { slot: x.slot, meta: { err: null }, transaction: [x.tx.base64, "base64"] } : { ...parsedTx(x.tx.signature, payer.address, [x.memo]), slot: x.slot };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", f);
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    const run = (...extra: string[]) => main(["--rows", file, "--sig", t.signature, "--rpc", "https://rpc.example", "--signer", payer.address, ...extra], io);
    return { run, out, err, memo };
  }

  it("unique: exit 0, and says the signatures were verified locally", async () => {
    const memo = formatMemo({ kind: "cup", id: "c1", root, count });
    const s = await setup([{ memo, slot: 50, self: true }, { memo: formatMemo({ kind: "cup", id: "c2", root, count }), slot: 60 }]);
    expect(await s.run("--verify-signature", "--check-equivocation")).toBe(0);
    expect(s.out.join("\n")).toMatch(/signatures verified locally/);
    expect(s.out.join("\n")).toMatch(/only operator anchor for this kind\/id \(2 signatures scanned\)/);
  });
  it("equivocation, and an earlier anchor with another root exists: the checked one is void, exit 1", async () => {
    const memo = formatMemo({ kind: "cup", id: "c1", root, count });
    const s = await setup([{ memo, slot: 50, self: true }, { memo: formatMemo({ kind: "cup", id: "c1", root: "f".repeat(64), count }), slot: 40 }]);
    expect(await s.run("--check-equivocation")).toBe(1);
    expect(s.err.join("\n")).toMatch(/MISMATCH {2}equivocation: .*this is not the anchor that counts \(the first finalized anchor is /);
  });
  it("equivocation, and the checked anchor is the first finalized: exit 0 with a loud warning", async () => {
    const memo = formatMemo({ kind: "cup", id: "c1", root, count });
    const s = await setup([{ memo, slot: 50, self: true }, { memo: formatMemo({ kind: "cup", id: "c1", root: "f".repeat(64), count }), slot: 60 }]);
    expect(await s.run("--check-equivocation")).toBe(0);
    expect(s.err.join("\n")).toMatch(/WARNING {3}EQUIVOCATION: .*This anchor is the first finalized one/);
  });
  it("the scan missing the anchor in hand still counts it (no 'none'), and --max-signatures is passed through", async () => {
    const s = await setup([{ memo: formatMemo({ kind: "cup", id: "c2", root, count }), slot: 60 }, { memo: formatMemo({ kind: "cup", id: "c3", root, count }), slot: 61 }]);
    expect(await s.run("--check-equivocation")).toBe(0);
    expect(s.out.join("\n")).toMatch(/only operator anchor for this kind\/id/);
    expect(await s.run("--check-equivocation", "--max-signatures", "1")).toBe(2);
    expect(s.err.join("\n")).toMatch(/equivocation_unchecked: The root matches, but uniqueness was NOT checked \(scan_incomplete\)/);
  });
  it("--max-signatures must be a positive integer and needs --check-equivocation", async () => {
    const s = await setup([]);
    expect(await s.run("--check-equivocation", "--max-signatures", "0")).toBe(2);
    expect(await s.run("--max-signatures", "10")).toBe(2);
  });
  it("duplicate: exit 0 with a warning naming the first finalized anchor", async () => {
    const memo = formatMemo({ kind: "cup", id: "c1", root, count });
    const s = await setup([{ memo, slot: 50, self: true }, { memo, slot: 40 }]);
    expect(await s.run("--check-equivocation")).toBe(0);
    expect(s.err.join("\n")).toMatch(/WARNING .*duplicate.*first finalized is/);
  });
  it("an RPC failure during the scan is exit 2 (could not check), never a pass", async () => {
    const memo = formatMemo({ kind: "cup", id: "c1", root, count });
    const s = await setup([{ memo, slot: 50, self: true }]);
    const good = globalThis.fetch;
    vi.stubGlobal("fetch", (async (url: string, init: RequestInit) =>
      JSON.parse(init.body as string).method === "getSignaturesForAddress" ? new Response("down", { status: 503 }) : good(url, init)) as typeof fetch);
    expect(await s.run("--check-equivocation")).toBe(2);
    expect(s.err.join("\n")).toMatch(/equivocation_unchecked/);
  });
  it("needs --sig", async () => {
    const err: string[] = [];
    expect(await main(["--rows", file, "--memo", "x", "--check-equivocation"], { out: () => {}, err: (s) => err.push(s) })).toBe(2);
  });
});
