import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as legacy from "./legacy-merkle";
import * as legacyLeaves from "./legacy-leaves";
import {
  boardLeaf,
  cupLeaf,
  cupLeavesFromStandings,
  formatMemo,
  leafHash,
  memoText,
  merkleProof,
  merkleRoot,
  parseMemo,
  parseMemoStrict,
  serializeRow,
  verifyAgainstMemo,
  verifyProof,
  type ResultsRow,
} from "../index.ts";

// Golden vectors: the same ones the ChartRunner app's own Merkle tests have always asserted (see also test-vectors/).
const A = { id: "a", s: 1 };
const B = { id: "b", s: 2 };
const C = { id: "c", s: 3 };
const LEAF_A = "fb94af131c58f06a58853b517f9f76773fb42bc7a188d737d06c5ac8cbe549f5";
const LEAF_B = "d1641b01a52a717dbea038563bd59b8a568c2e21cea20794706d4ced9877a95b";
const ROOT_3 = "0e35f6c675e52d251f7e0b25c5fb5d8b728344eea7f519f70ffc950651d95f92";
const ROOT_2 = "a17e226e3b86e457dd861c5cf0062480fa31445e9576a60327f1657120806579";

describe("golden vectors", () => {
  it("serializes and hashes rows", async () => {
    expect(serializeRow({ s: 1, id: "a" })).toBe('{"id":"a","s":1}');
    expect(await leafHash(A)).toBe(LEAF_A);
    expect(await leafHash(B)).toBe(LEAF_B);
  });
  it("builds the known roots", async () => {
    expect(await merkleRoot([A])).toEqual({ root: LEAF_A, count: 1 });
    expect(await merkleRoot([A, B])).toEqual({ root: ROOT_2, count: 2 });
    expect(await merkleRoot([C, A, B])).toEqual({ root: ROOT_3, count: 3 });
  });
  it("matches an independent node:crypto implementation", async () => {
    const sha = (...p: Buffer[]) => createHash("sha256").update(Buffer.concat(p)).digest();
    const la = sha(Buffer.from([0]), Buffer.from(serializeRow(A)));
    expect((await leafHash(A))).toBe(la.toString("hex"));
  });
});

// A cup standing in the shape of the app's frozen results (the money values are fixed-decimal strings).
const standings = [
  { rank: 1, userId: "u-1", name: "Alice", equity: "11250.5000", pnlPct: "12.5050", trades: 14, disqualified: false, fillsHash: "a".repeat(64), extra: "ignored" },
  { rank: 2, userId: "u-2", name: "Bob", equity: "10100.0000", pnlPct: "1.0000", trades: 3, disqualified: false, fillsHash: "b".repeat(64) },
  { rank: 3, userId: "u-3", name: "Cy", equity: "5000.0000", pnlPct: "-50.0000", trades: 40, disqualified: true, fillsHash: "c".repeat(64) },
];

describe("cross-check against the app's previous implementation (verbatim copy of the pre-refactor modules)", () => {
  it("cup and board leaves serialize and hash identically", async () => {
    for (const s of standings) {
      const row = { rank: s.rank, userId: s.userId, name: s.name, equity: s.equity, pnlPct: s.pnlPct, trades: s.trades, disqualified: s.disqualified, fillsHash: s.fillsHash };
      const before = await legacyLeaves.cupLeaf("cup-7", row);
      const after = await cupLeaf("cup-7", row);
      expect(after).toEqual(before);
      expect(serializeRow(after)).toBe(legacy.canonicalJson(before));
      expect(await leafHash(after)).toBe(await legacy.hashLeaf(legacy.canonicalJson(before)));
    }
    const b = { userId: "u", handle: "Al", runId: "r", score: 5, distance: 9, createdAt: "x", rank: 2 };
    expect(await boardLeaf("daily", "2026-10-02", b)).toEqual(await legacyLeaves.boardLeaf("daily", "2026-10-02", b));
  });
  it("roots, proofs and memos are identical for many sizes", async () => {
    for (const n of [1, 2, 3, 5, 8, 13, 50]) {
      const rows: ResultsRow[] = Array.from({ length: n }, (_, i) => ({ i, name: `p${i}`, ok: i % 2 === 0, none: null }));
      const before = await legacy.buildTree(rows);
      const after = await merkleRoot(rows);
      expect(after).toEqual({ root: before.root, count: before.count });
      for (const i of [0, n - 1, Math.floor(n / 2)]) {
        const p = await merkleProof(rows, i);
        expect(p.proof).toEqual(legacy.proveIndex(before, i));
        expect(p.leafHash).toBe(before.leaves[i]);
      }
      expect(formatMemo({ kind: "cup", id: "c1", root: after.root, count: n })).toBe(legacy.memoText({ kind: "cup", id: "c1", root: before.root, count: n }));
    }
  });
  it("cupLeavesFromStandings equals what the app built before", async () => {
    const before = await Promise.all(standings.map((s) => legacyLeaves.cupLeaf("cup-7", { rank: s.rank, userId: s.userId, name: s.name, equity: s.equity, pnlPct: s.pnlPct, trades: s.trades, disqualified: s.disqualified, fillsHash: s.fillsHash })));
    expect(await cupLeavesFromStandings("cup-7", standings)).toEqual(before);
  });
});

describe("memo format", () => {
  const root = ROOT_3;
  it("round-trips and the strict parser agrees with parseMemo", () => {
    const text = formatMemo({ kind: "cup", id: "cup-2026.10", root, count: 3 });
    expect(text).toBe(`chartrunner:v1:cup:cup-2026.10:${root}:3`);
    expect(parseMemo(text)).toEqual({ kind: "cup", id: "cup-2026.10", root, count: 3 });
    expect(parseMemoStrict(text)).toEqual({ ok: true, memo: { kind: "cup", id: "cup-2026.10", root, count: 3 } });
  });
  const rejected: [string, string][] = [
    ["empty", ""],
    ["prose", "hello"],
    ["trailing space", `chartrunner:v1:cup:x:${ROOT_3}:3 `],
    ["leading space", ` chartrunner:v1:cup:x:${ROOT_3}:3`],
    ["newline", `chartrunner:v1:cup:x:${ROOT_3}:3\n`],
    ["other version", `chartrunner:v2:cup:x:${ROOT_3}:3`],
    ["unknown kind", `chartrunner:v1:nope:x:${ROOT_3}:3`],
    ["uppercase kind", `chartrunner:v1:CUP:x:${ROOT_3}:3`],
    ["uppercase root", `chartrunner:v1:cup:x:${ROOT_3.toUpperCase()}:3`],
    ["short root", `chartrunner:v1:cup:x:${ROOT_3.slice(1)}:3`],
    ["long root", `chartrunner:v1:cup:x:${ROOT_3}0:3`],
    ["zero count", `chartrunner:v1:cup:x:${ROOT_3}:0`],
    ["leading-zero count", `chartrunner:v1:cup:x:${ROOT_3}:03`],
    ["negative count", `chartrunner:v1:cup:x:${ROOT_3}:-1`],
    ["float count", `chartrunner:v1:cup:x:${ROOT_3}:1.5`],
    ["huge count", `chartrunner:v1:cup:x:${ROOT_3}:1234567890`],
    ["missing field", `chartrunner:v1:cup:${ROOT_3}:3`],
    ["extra field", `chartrunner:v1:cup:x:${ROOT_3}:3:extra`],
    ["id with colon", `chartrunner:v1:cup:a:b:${ROOT_3}:3`],
    ["empty id", `chartrunner:v1:cup::${ROOT_3}:3`],
    ["id too long", `chartrunner:v1:cup:${"a".repeat(65)}:${ROOT_3}:3`],
    ["id with space", `chartrunner:v1:cup:a b:${ROOT_3}:3`],
    ["wrong prefix", `chartrunnr:v1:cup:x:${ROOT_3}:3`],
  ];
  for (const [name, text] of rejected) {
    it(`rejects: ${name}`, () => {
      expect(parseMemo(text)).toBeNull();
      const r = parseMemoStrict(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    });
  }
  it("reports a distinct reason for an unknown kind", () => {
    const r = parseMemoStrict(`chartrunner:v1:nope:x:${ROOT_3}:3`);
    expect(r).toMatchObject({ ok: false, reason: "unknown_kind" });
  });
  it("formatMemo refuses invalid fields", () => {
    expect(() => formatMemo({ kind: "cup", id: "a:b", root, count: 1 })).toThrow();
    expect(() => formatMemo({ kind: "cup", id: "x", root: "abc", count: 1 })).toThrow();
    expect(() => formatMemo({ kind: "cup", id: "x", root, count: 0 })).toThrow();
  });
});

describe("verifyAgainstMemo", () => {
  const rows = [A, B, C];
  const memo = memoText({ kind: "cup", id: "c1", root: ROOT_3, count: 3 });

  it("verifies the full row set (any order)", async () => {
    expect(await verifyAgainstMemo({ rows, memoText: memo })).toMatchObject({ ok: true, mode: "rows", root: ROOT_3 });
    expect(await verifyAgainstMemo({ rows: [C, B, A], memoText: memo })).toMatchObject({ ok: true });
  });
  it("verifies one row with its proof (row or canonical text)", async () => {
    const p = await merkleProof(rows, A);
    expect(await verifyAgainstMemo({ leaf: p.leaf, proof: p.proof, memoText: memo })).toMatchObject({ ok: true, mode: "proof" });
    expect(await verifyAgainstMemo({ leaf: A, proof: p.proof, memoText: memo })).toMatchObject({ ok: true });
    expect(await verifyProof(p.leaf, p.proof, ROOT_3)).toBe(true);
  });
  it("fails on a tampered row with root_mismatch and the recomputed root", async () => {
    const r = await verifyAgainstMemo({ rows: [A, B, { id: "c", s: 4 }], memoText: memo });
    expect(r).toMatchObject({ ok: false, reason: "root_mismatch" });
    expect(!r.ok && r.computedRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(!r.ok && r.computedRoot).not.toBe(ROOT_3);
  });
  it("fails on a removed or added row", async () => {
    expect(await verifyAgainstMemo({ rows: [A, B], memoText: memo })).toMatchObject({ ok: false, reason: "root_mismatch" });
    expect(await verifyAgainstMemo({ rows: [A, B, C, { id: "d", s: 9 }], memoText: memo })).toMatchObject({ ok: false, reason: "root_mismatch" });
  });
  it("fails on a wrong root in the memo", async () => {
    const wrong = memoText({ kind: "cup", id: "c1", root: ROOT_2, count: 3 });
    expect(await verifyAgainstMemo({ rows, memoText: wrong })).toMatchObject({ ok: false, reason: "root_mismatch" });
  });
  it("fails on a wrong count in the memo", async () => {
    const wrong = memoText({ kind: "cup", id: "c1", root: ROOT_3, count: 4 });
    expect(await verifyAgainstMemo({ rows, memoText: wrong })).toMatchObject({ ok: false, reason: "count_mismatch" });
  });
  it("fails a tampered or foreign proof", async () => {
    const p = await merkleProof(rows, A);
    expect(await verifyAgainstMemo({ leaf: { id: "a", s: 999 }, proof: p.proof, memoText: memo })).toMatchObject({ ok: false, reason: "root_mismatch" });
    expect(await verifyAgainstMemo({ leaf: A, proof: p.proof.slice(1), memoText: memo })).toMatchObject({ ok: false, reason: "root_mismatch" });
    expect(await verifyAgainstMemo({ leaf: A, proof: [{ side: "L", hash: "zz" }], memoText: memo })).toMatchObject({ ok: false, reason: "proof_invalid" });
    const long = Array.from({ length: 5 }, () => ({ side: "L" as const, hash: LEAF_A }));
    expect(await verifyAgainstMemo({ leaf: A, proof: long, memoText: memo })).toMatchObject({ ok: false, reason: "proof_invalid" });
  });
  it("rejects malformed memo, bad rows and missing input with reasons", async () => {
    expect(await verifyAgainstMemo({ rows, memoText: "nope" })).toMatchObject({ ok: false, reason: "memo_malformed" });
    expect(await verifyAgainstMemo({ rows: [], memoText: memo })).toMatchObject({ ok: false, reason: "rows_invalid" });
    expect(await verifyAgainstMemo({ rows: [{ s: 1.5 }], memoText: memo })).toMatchObject({ ok: false, reason: "rows_invalid" });
    expect(await verifyAgainstMemo({ rows: [A, A], memoText: memo })).toMatchObject({ ok: false, reason: "rows_invalid" });
    expect(await verifyAgainstMemo({ memoText: memo } as never)).toMatchObject({ ok: false, reason: "input_invalid" });
  });
  it("can pin the memo to an expected kind and id", async () => {
    expect(await verifyAgainstMemo({ rows, memoText: memo, expect: { kind: "cup", id: "c1" } })).toMatchObject({ ok: true });
    expect(await verifyAgainstMemo({ rows, memoText: memo, expect: { id: "c2" } })).toMatchObject({ ok: false, reason: "memo_subject_mismatch" });
    expect(await verifyAgainstMemo({ rows, memoText: memo, expect: { kind: "daily" } })).toMatchObject({ ok: false, reason: "memo_subject_mismatch" });
  });
  it("verifies a real cup end to end", async () => {
    const leaves = await cupLeavesFromStandings("cup-7", standings);
    const { root, count } = await merkleRoot(leaves);
    const m = formatMemo({ kind: "cup", id: "cup-7", root, count });
    expect(await verifyAgainstMemo({ rows: leaves, memoText: m })).toMatchObject({ ok: true });
    const tampered = leaves.map((l, i) => (i === 0 ? { ...l, eq: "99999.0000" } : l));
    expect(await verifyAgainstMemo({ rows: tampered, memoText: m })).toMatchObject({ ok: false, reason: "root_mismatch" });
  });
});
