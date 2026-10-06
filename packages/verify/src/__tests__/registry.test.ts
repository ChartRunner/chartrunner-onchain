import { describe, expect, it } from "vitest";
import {
  anchorStanding,
  ANCHOR_KINDS,
  DEFAULT_MAX_SIGNATURES,
  checkEquivocation,
  fetchMemo,
  formatMemo,
  isOperatorKind,
  isUserKind,
  KINDS,
  kindInfo,
  MEMO_PROGRAM_ID,
  OPERATOR_KINDS,
  parseLegacyCr1,
  parseMemo,
  parseMemoStrict,
  signerModelOf,
  USER_KINDS,
  verifyAgainstMemo,
  verifyAgainstSignature,
} from "../index.ts";

const ROOT = "0e35f6c675e52d251f7e0b25c5fb5d8b728344eea7f519f70ffc950651d95f92";
const ROOT_B = "a17e226e3b86e457dd861c5cf0062480fa31445e9576a60327f1657120806579";
const OPERATOR = "Gp3ratorAddressxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; // base58 alphabet: no 0, O, I or l
const WALLET = "UserWa11etAddressxxxxxxxxxxxxxxxxxxxxxxxxxx";
const OTHER = "SomeoneE1seAddressxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("kinds registry", () => {
  it("lists every kind once, with a signer model", () => {
    expect([...ANCHOR_KINDS]).toEqual([...OPERATOR_KINDS, ...USER_KINDS]);
    expect(new Set(ANCHOR_KINDS).size).toBe(ANCHOR_KINDS.length);
    for (const k of ANCHOR_KINDS) expect(KINDS[k].kind).toBe(k);
    for (const k of OPERATOR_KINDS) expect(KINDS[k]).toMatchObject({ signer: "operator", count: "any" });
    for (const k of USER_KINDS) expect(KINDS[k]).toMatchObject({ signer: "user", status: "planned", count: "one" });
    expect(KINDS.xp.status).toBe("reserved");
    expect(["freeplay", "daily", "cup"].map((k) => kindInfo(k)?.status)).toEqual(["active", "active", "active"]);
  });
  it("is frozen", () => {
    expect(Object.isFrozen(KINDS)).toBe(true);
    expect(() => {
      (KINDS as Record<string, unknown>).evil = {};
    }).toThrow();
  });
  it("classifies kinds", () => {
    expect(isOperatorKind("cup")).toBe(true);
    expect(isOperatorKind("map")).toBe(false);
    expect(isUserKind("bot")).toBe(true);
    expect(isUserKind("daily")).toBe(false);
    expect(kindInfo("nope")).toBeNull();
    expect(kindInfo("__proto__")).toBeNull();
  });
});

describe("user kinds in the memo grammar", () => {
  it("accept count 1 only", () => {
    for (const kind of USER_KINDS) {
      const text = formatMemo({ kind, id: "ent_01J9.x-y", root: ROOT, count: 1 });
      expect(parseMemo(text)).toEqual({ kind, id: "ent_01J9.x-y", root: ROOT, count: 1 });
      expect(() => formatMemo({ kind, id: "e1", root: ROOT, count: 2 })).toThrow();
      expect(parseMemo(`chartrunner:v1:${kind}:e1:${ROOT}:2`)).toBeNull();
      expect(parseMemoStrict(`chartrunner:v1:${kind}:e1:${ROOT}:2`)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });
  it("never allow a free-text name as id", () => {
    expect(parseMemo(`chartrunner:v1:map:My Map:${ROOT}:1`)).toBeNull();
    expect(() => formatMemo({ kind: "map", id: "My Map", root: ROOT, count: 1 })).toThrow();
  });
  it("verify a single-leaf root with an empty proof", async () => {
    const leaf = '{"id":"ent-1","k":"map","v":1}';
    const { hashLeaf } = await import("../index.ts");
    const root = await hashLeaf(leaf);
    const memo = formatMemo({ kind: "map", id: "ent-1", root, count: 1 });
    expect(await verifyAgainstMemo({ leaf, proof: [], memoText: memo })).toMatchObject({ ok: true, mode: "proof" });
    expect(await verifyAgainstMemo({ leaf, proof: [{ side: "L", hash: ROOT }], memoText: memo })).toMatchObject({ ok: false, reason: "proof_invalid" });
  });
  it("formatMemo refuses a count the parser would reject", () => {
    expect(() => formatMemo({ kind: "cup", id: "x", root: ROOT, count: 1_000_000_000 })).toThrow();
    expect(formatMemo({ kind: "cup", id: "x", root: ROOT, count: 999_999_999 })).toBe(`chartrunner:v1:cup:x:${ROOT}:999999999`);
  });
});

// ---- signer expectations -------------------------------------------------------------------------------------------

const SIG = "5".repeat(88);
const txWith = (memo: string, accountKeys: unknown[], signature = SIG, slot = 77) => ({
  slot,
  meta: { err: null },
  transaction: { signatures: [signature], message: { accountKeys, instructions: [{ programId: MEMO_PROGRAM_ID, parsed: memo }] } },
});
const reply = (result: unknown): typeof fetch => (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))) as unknown as typeof fetch;
const key = (pubkey: string, signer: boolean) => ({ pubkey, signer, writable: signer, source: "transaction" });

describe("expectSigner by signer model", () => {
  const cupMemo = formatMemo({ kind: "cup", id: "c1", root: ROOT, count: 3 });
  const mapMemo = formatMemo({ kind: "map", id: "ent-1", root: ROOT, count: 1 });

  it("reports the signer model of a memo", () => {
    expect(signerModelOf(cupMemo)).toBe("operator");
    expect(signerModelOf(mapMemo)).toBe("user");
    expect(signerModelOf("not a memo")).toBe("operator");
    expect(signerModelOf(`cr1:map:Example:${"ab".repeat(32)}`)).toBe("operator");
  });
  it("operator kind: the expected address must be the fee payer, co-signing is not enough", async () => {
    const keys = [key(OTHER, true), key(OPERATOR, true)];
    expect(await fetchMemo(SIG, { rpcUrl: "https://rpc.example", fetch: reply(txWith(cupMemo, keys)), expectSigner: OPERATOR })).toMatchObject({ ok: false, reason: "signer_mismatch" });
    const paid = [key(OPERATOR, true)];
    expect(await fetchMemo(SIG, { rpcUrl: "https://rpc.example", fetch: reply(txWith(cupMemo, paid)), expectSigner: OPERATOR })).toMatchObject({ ok: true, feePayer: OPERATOR, signers: [OPERATOR] });
  });
  it("user kind: the expected wallet must be among the signers (fee payer may be someone else)", async () => {
    const sponsored = [key(OPERATOR, true), key(WALLET, true)];
    expect(await fetchMemo(SIG, { rpcUrl: "https://rpc.example", fetch: reply(txWith(mapMemo, sponsored)), expectSigner: WALLET })).toMatchObject({ ok: true, feePayer: OPERATOR, signers: [OPERATOR, WALLET] });
    const notSigned = [key(OPERATOR, true), key(WALLET, false)];
    expect(await fetchMemo(SIG, { rpcUrl: "https://rpc.example", fetch: reply(txWith(mapMemo, notSigned)), expectSigner: WALLET })).toMatchObject({ ok: false, reason: "signer_mismatch" });
    const plainKeys = [OPERATOR, WALLET]; // no signer flags: only the fee payer is known to have signed
    expect(await fetchMemo(SIG, { rpcUrl: "https://rpc.example", fetch: reply(txWith(mapMemo, plainKeys)), expectSigner: WALLET })).toMatchObject({ ok: false, reason: "signer_mismatch" });
  });
  it("verifyAgainstSignature passes the signers through", async () => {
    const { hashLeaf } = await import("../index.ts");
    const leaf = '{"id":"ent-1","k":"map","v":1}';
    const memo = formatMemo({ kind: "map", id: "ent-1", root: await hashLeaf(leaf), count: 1 });
    const r = await verifyAgainstSignature({ rpcUrl: "https://rpc.example", fetch: reply(txWith(memo, [key(WALLET, true)])), signature: SIG, expectSigner: WALLET, leaf, proof: [] });
    expect(r).toMatchObject({ ok: true, signers: [WALLET] });
  });
});

// ---- legacy cr1 ------------------------------------------------------------------------------------------------------

describe("parseLegacyCr1", () => {
  const H = "ab".repeat(32);
  it("parses the frozen legacy format", () => {
    expect(parseLegacyCr1(`cr1:map:First map:${H}`)).toEqual({ version: "cr1", kind: "map", name: "First map", contentHash: H });
    expect(parseLegacyCr1(`cr1:map:Map 🗺:${H}`)).toMatchObject({ name: "Map 🗺" });
    expect(parseLegacyCr1(`cr1:map:${"x".repeat(64)}:${H}`)).toMatchObject({ name: "x".repeat(64) });
  });
  const rejected: [string, string][] = [
    ["chartrunner memo", `chartrunner:v1:cup:x:${ROOT}:3`],
    ["other version", `cr2:map:Name:${H}`],
    ["unknown kind", `cr1:strategy:Name:${H}`],
    ["empty name", `cr1:map::${H}`],
    ["name over 64 bytes", `cr1:map:${"é".repeat(33)}:${H}`],
    ["colon in name", `cr1:map:a:b:${H}`],
    ["uppercase hash", `cr1:map:Name:${H.toUpperCase()}`],
    ["0x hash", `cr1:map:Name:0x${H.slice(2)}`],
    ["short hash", `cr1:map:Name:${H.slice(2)}`],
    ["missing hash", "cr1:map:Name"],
  ];
  for (const [name, text] of rejected) it(`rejects: ${name}`, () => expect(parseLegacyCr1(text)).toBeNull());
  it("is never a chartrunner:v1 anchor", async () => {
    const text = `cr1:map:First map:${H}`;
    expect(parseMemo(text)).toBeNull();
    expect(parseMemoStrict(text)).toMatchObject({ ok: false, reason: "not_a_chartrunner_memo" });
    expect(await verifyAgainstMemo({ rows: [{ a: 1 }], memoText: text })).toMatchObject({ ok: false, reason: "memo_malformed" });
  });
});

// ---- equivocation ----------------------------------------------------------------------------------------------------

interface FakeTx {
  signature: string;
  slot: number;
  memo: string | null;
  payer?: string;
  err?: unknown;
}

/** A fake RPC: getSignaturesForAddress pages newest first, getTransaction by signature. */
function fakeRpc(txs: FakeTx[], o: { omitMemoField?: boolean; dropTx?: string; failMethod?: string; maxPage?: number; stuckCursor?: boolean } = {}) {
  const calls: { method: string; params: any[] }[] = [];
  const newestFirst = [...txs].sort((a, b) => b.slot - a.slot);
  const f = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    calls.push({ method, params });
    if (method === o.failMethod) throw new TypeError("fetch failed");
    if (method === "getSignaturesForAddress") {
      const { limit, before } = params[1];
      // stuckCursor: a broken node that ignores `before` and serves the first page again.
      const start = before && !o.stuckCursor ? newestFirst.findIndex((t) => t.signature === before) + 1 : 0;
      const page = newestFirst.slice(start, start + Math.min(limit, o.maxPage ?? limit)).map((t) => ({
        signature: t.signature,
        slot: t.slot,
        err: t.err ?? null,
        blockTime: 1_700_000_000 + t.slot,
        ...(o.omitMemoField ? {} : { memo: t.memo === null ? null : `[${t.memo.length}] ${t.memo}` }),
      }));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: page }));
    }
    if (method === "getTransaction") {
      const t = txs.find((x) => x.signature === params[0]);
      if (!t || t.signature === o.dropTx) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
      const instructions = t.memo === null ? [] : [{ programId: MEMO_PROGRAM_ID, parsed: t.memo }];
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { slot: t.slot, meta: { err: t.err ?? null }, transaction: { signatures: [t.signature], message: { accountKeys: [key(t.payer ?? OPERATOR, true)], instructions } } } }),
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "unknown method" } }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

const sig = (n: number) => String(n).padStart(2, "1").repeat(44).slice(0, 88).replace(/0/g, "9");
const m = (id: string, root = ROOT, count = 3) => formatMemo({ kind: "cup", id, root, count });
const base = { rpcUrl: "https://rpc.example", operator: OPERATOR, kind: "cup" as const, id: "cup-1" };

describe("checkEquivocation", () => {
  it("none, when the operator never anchored this id", async () => {
    const { f } = fakeRpc([{ signature: sig(1), slot: 10, memo: m("cup-2") }, { signature: sig(2), slot: 11, memo: null }]);
    expect(await checkEquivocation({ ...base, fetch: f })).toMatchObject({ ok: true, status: "none", winner: null, anchors: [], scanned: 2 });
  });
  it("unique, and it only re-reads transactions whose memo names the id", async () => {
    const { f, calls } = fakeRpc([{ signature: sig(1), slot: 10, memo: m("cup-1") }, { signature: sig(2), slot: 11, memo: m("cup-2") }, { signature: sig(3), slot: 12, memo: "gm" }]);
    const r = await checkEquivocation({ ...base, fetch: f });
    expect(r).toMatchObject({ ok: true, status: "unique", winner: { signature: sig(1), slot: 10, root: ROOT, count: 3 } });
    expect(calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0])).toEqual([sig(1)]);
  });
  it("duplicate: the same memo twice; the first finalized wins", async () => {
    const { f } = fakeRpc([{ signature: sig(1), slot: 20, memo: m("cup-1") }, { signature: sig(2), slot: 10, memo: m("cup-1") }]);
    expect(await checkEquivocation({ ...base, fetch: f })).toMatchObject({ ok: true, status: "duplicate", winner: { signature: sig(2), slot: 10 } });
  });
  it("equivocation: different roots for the same id; the first finalized wins", async () => {
    const { f } = fakeRpc([{ signature: sig(1), slot: 30, memo: m("cup-1", ROOT_B) }, { signature: sig(2), slot: 10, memo: m("cup-1") }]);
    const r = await checkEquivocation({ ...base, fetch: f });
    expect(r).toMatchObject({ ok: true, status: "equivocation", winner: { signature: sig(2), root: ROOT } });
    expect(r.ok && r.anchors.map((a) => a.root)).toEqual([ROOT, ROOT_B]);
  });
  it("equivocation in one slot has no winner", async () => {
    const { f } = fakeRpc([{ signature: sig(1), slot: 10, memo: m("cup-1", ROOT_B) }, { signature: sig(2), slot: 10, memo: m("cup-1") }]);
    expect(await checkEquivocation({ ...base, fetch: f })).toMatchObject({ ok: true, status: "equivocation", winner: null });
  });
  it("ignores memos not paid by the operator and failed transactions", async () => {
    const { f } = fakeRpc([
      { signature: sig(1), slot: 5, memo: m("cup-1", ROOT_B), payer: OTHER },
      { signature: sig(2), slot: 6, memo: m("cup-1", ROOT_B), err: { InstructionError: [0, "x"] } },
      { signature: sig(3), slot: 10, memo: m("cup-1") },
    ]);
    expect(await checkEquivocation({ ...base, fetch: f })).toMatchObject({ ok: true, status: "unique", winner: { signature: sig(3) } });
  });
  it("reads every transaction when the RPC does not report memos", async () => {
    const { f, calls } = fakeRpc([{ signature: sig(1), slot: 10, memo: m("cup-1") }, { signature: sig(2), slot: 11, memo: m("cup-2") }], { omitMemoField: true });
    expect(await checkEquivocation({ ...base, fetch: f })).toMatchObject({ ok: true, status: "unique" });
    expect(calls.filter((c) => c.method === "getTransaction")).toHaveLength(2);
  });
  it("pages through the whole history", async () => {
    const txs = Array.from({ length: 7 }, (_, i) => ({ signature: sig(i + 1), slot: 100 + i, memo: i === 0 || i === 6 ? m("cup-1") : m("cup-9") }));
    const { f, calls } = fakeRpc(txs);
    expect(await checkEquivocation({ ...base, fetch: f, pageSize: 3 })).toMatchObject({ ok: true, status: "duplicate", scanned: 7, winner: { slot: 100 } });
    expect(calls.filter((c) => c.method === "getSignaturesForAddress")).toHaveLength(4); // 3 pages + the empty one that ends it
    expect(calls.every((c) => c.method !== "getSignaturesForAddress" || c.params[1].commitment === "finalized")).toBe(true);
  });
  it("a short page is not the end of history: only an empty page is", async () => {
    // The node returns at most 2 per page although 1000 were asked for; the older anchor is on page 3.
    const txs = [{ signature: sig(1), slot: 10, memo: m("cup-1", ROOT_B) }, ...Array.from({ length: 4 }, (_, i) => ({ signature: sig(i + 2), slot: 20 + i, memo: m("cup-9") })), { signature: sig(9), slot: 50, memo: m("cup-1") }];
    const r = await checkEquivocation({ ...base, fetch: fakeRpc(txs, { maxPage: 2 }).f });
    expect(r).toMatchObject({ ok: true, status: "equivocation", scanned: 6, winner: { signature: sig(1) } });
  });
  it("a cursor that does not move is scan_incomplete, never an answer", async () => {
    const txs = Array.from({ length: 3 }, (_, i) => ({ signature: sig(i + 1), slot: 100 + i, memo: m("cup-9") }));
    const r = await checkEquivocation({ ...base, fetch: fakeRpc(txs, { stuckCursor: true }).f, pageSize: 2 });
    expect(r).toMatchObject({ ok: false, reason: "scan_incomplete" });
    expect(!r.ok && r.message).toMatch(/same page/);
  });
  it("defaults to a large signature limit and says how to raise it", async () => {
    expect(DEFAULT_MAX_SIGNATURES).toBe(100_000);
    const txs = Array.from({ length: 5 }, (_, i) => ({ signature: sig(i + 1), slot: 100 + i, memo: m("cup-9") }));
    const r = await checkEquivocation({ ...base, fetch: fakeRpc(txs).f, pageSize: 2, maxSignatures: 4 });
    expect(!r.ok && r.message).toMatch(/Read 4 signatures .* without reaching its start .*uniqueness was not checked.*--max-signatures/);
  });
  it("never answers from a partial scan or an outage", async () => {
    const txs = Array.from({ length: 5 }, (_, i) => ({ signature: sig(i + 1), slot: 100 + i, memo: m("cup-9") }));
    expect(await checkEquivocation({ ...base, fetch: fakeRpc(txs).f, pageSize: 2, maxSignatures: 4 })).toMatchObject({ ok: false, reason: "scan_incomplete" });
    expect(await checkEquivocation({ ...base, fetch: fakeRpc(txs, { failMethod: "getSignaturesForAddress" }).f })).toMatchObject({ ok: false, reason: "rpc_unreachable" });
    const hit = [{ signature: sig(1), slot: 10, memo: m("cup-1") }];
    expect(await checkEquivocation({ ...base, fetch: fakeRpc(hit, { failMethod: "getTransaction" }).f })).toMatchObject({ ok: false, reason: "rpc_unreachable" });
    expect(await checkEquivocation({ ...base, fetch: fakeRpc(hit, { dropTx: sig(1) }).f })).toMatchObject({ ok: false, reason: "scan_incomplete" });
  });
  it("validates its input before any request", async () => {
    const never = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect(await checkEquivocation({ ...base, kind: "map" as never, fetch: never })).toMatchObject({ ok: false, reason: "input_invalid" });
    expect(await checkEquivocation({ ...base, id: "a b", fetch: never })).toMatchObject({ ok: false, reason: "input_invalid" });
    expect(await checkEquivocation({ ...base, operator: "not base58!", fetch: never })).toMatchObject({ ok: false, reason: "input_invalid" });
    expect(await checkEquivocation({ ...base, rpcUrl: "file:///etc/passwd", fetch: never })).toMatchObject({ ok: false, reason: "rpc_url_invalid" });
  });
});

describe("anchorStanding (first finalized operator memo wins)", () => {
  const sighting = (n: number, slot: number | null, root = ROOT) => ({ signature: sig(n), slot, blockTime: null, memo: m("cup-1", root), root, count: 3 });
  const scan = (anchors: ReturnType<typeof sighting>[]) => ({ ok: true as const, status: "none" as const, winner: null, anchors, scanned: 9 });

  it("the checked anchor missing from a completed scan: not checked, never added (no pass, no verdict)", () => {
    const st = anchorStanding(scan([sighting(2, 5, ROOT_B)]), sighting(1, 10));
    expect(st).toMatchObject({ standing: "not_in_scan", pass: null });
    expect(st.result.anchors.map((a) => a.signature)).toEqual([sig(2)]); // not added
    expect(anchorStanding(scan([]), sighting(1, 10))).toMatchObject({ standing: "not_in_scan", pass: null });
  });
  it("a caller-supplied slot never decides the winner: the scan's own sighting is used", () => {
    // The caller claims slot 1 (earlier than the other anchor); the scan read it at slot 50. The scan's slot counts.
    const st = anchorStanding(scan([sighting(2, 5, ROOT_B), sighting(1, 50)]), sighting(1, 1));
    expect(st).toMatchObject({ standing: "not_first", pass: false, winner: { signature: sig(2) } });
  });
  it("the scan read other content for the checked signature: not checked", () => {
    expect(anchorStanding(scan([sighting(1, 10, ROOT_B)]), sighting(1, 10))).toMatchObject({ standing: "not_in_scan" });
  });
  it("the only anchor: sole", () => {
    expect(anchorStanding(scan([sighting(1, 10)]), sighting(1, 10))).toMatchObject({ standing: "sole", pass: true, result: { status: "unique" } });
  });
  it("the checked anchor is the first finalized of different anchors: pass, equivocation_first, isWinner", () => {
    const st = anchorStanding(scan([sighting(1, 10), sighting(2, 30, ROOT_B)]), sighting(1, 10));
    expect(st).toMatchObject({ standing: "equivocation_first", pass: true, isWinner: true, others: [{ signature: sig(2) }] });
  });
  it("a same-root duplicate of the winner is not voided by a later different anchor (root+count, not signature)", () => {
    const st = anchorStanding(scan([sighting(1, 10), sighting(3, 20), sighting(2, 30, ROOT_B)]), sighting(3, 20));
    expect(st).toMatchObject({ standing: "equivocation_first", pass: true, isWinner: false, winner: { signature: sig(1) } });
  });
  it("a later anchor with a different root: not_first, fail", () => {
    expect(anchorStanding(scan([sighting(2, 5, ROOT_B), sighting(1, 10)]), sighting(1, 10))).toMatchObject({ standing: "not_first", pass: false, winner: { signature: sig(2) } });
  });
  it("no winner (two different memos in the lowest slot): fail", () => {
    expect(anchorStanding(scan([sighting(2, 10, ROOT_B), sighting(1, 10)]), sighting(1, 10))).toMatchObject({ standing: "not_first", pass: false, winner: null });
  });
  it("same root and count elsewhere: duplicate, pass with the first named", () => {
    expect(anchorStanding(scan([sighting(2, 5), sighting(1, 10)]), sighting(1, 10))).toMatchObject({ standing: "duplicate", pass: true, first: { signature: sig(2) }, count: 2 });
  });
});
