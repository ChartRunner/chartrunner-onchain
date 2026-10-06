import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_KINDS,
  boardLeaf,
  cupLeavesFromStandings,
  formatMemo,
  handleHash,
  hashNode,
  KINDS,
  leafHash,
  MEMO_PROGRAM_ID,
  merkleProof,
  merkleRoot,
  parseMemo,
  parseLegacyCr1,
  parseMemoStrict,
  runHash,
  serializeRow,
  userHash,
  verifyAgainstMemo,
  verifyProof,
  type ProofStep,
  type ResultsRow,
} from "../index.ts";

// Golden vectors shared with the ChartRunner app (drift guard). The app asserts the same file, byte for byte, against its
// own anchoring code; if either side changes a hash, a serialization or the memo format, one of the two suites fails.
// The file is produced from SPEC.md by scripts/gen-vectors.mjs (node:crypto, independent of this SDK).

const VECTORS_URL = new URL("../../../../test-vectors/v1.json", import.meta.url);
/** sha256 of test-vectors/v1.json. The app pins the same value: update both together, and only to APPEND vectors. */
const VECTORS_SHA256 = "e75afcbec9e2f30b96ac89dc631f9ce1540b189b7b28ea000a5f026947b7901c";

const raw = readFileSync(VECTORS_URL);
const V = JSON.parse(raw.toString("utf8")) as Vectors;

interface TreeVector {
  name: string;
  kind: "cup";
  id: string;
  rows: ResultsRow[];
  sortedLeaves: { canonical: string; hash: string }[];
  root: string;
  count: number;
  memo: string;
  proofs: { index: number; leaf: string; proof: ProofStep[] }[];
}
interface Vectors {
  formatVersion: number;
  memoProgramId: string;
  kinds: { kind: string; signer: string; status: string; count: string }[];
  pseudonyms: { fn: "userHash" | "handleHash" | "runHash"; input: string; output: string }[];
  canonical: { name: string; row: ResultsRow; canonical: string; leafHash: string }[];
  invalidRows: { name: string; row: ResultsRow }[];
  nodes: { left: string; right: string; node: string }[];
  trees: TreeVector[];
  duplicates: { name: string; rows: ResultsRow[] }[];
  cup: { cupId: string; standings: Parameters<typeof cupLeavesFromStandings>[1]; leaves: ResultsRow[]; root: string; count: number; memo: string };
  board: { kind: "daily" | "freeplay"; date: string; rows: Parameters<typeof boardLeaf>[2][]; leaves: ResultsRow[]; root: string; count: number; memo: string };
  memos: { valid: { text: string; fields: ReturnType<typeof parseMemo> }[]; invalid: { name: string; text: string }[] };
  legacyCr1: { valid: { text: string; fields: ReturnType<typeof parseLegacyCr1> }[]; invalid: { name: string; text: string }[] };
}

describe("test-vectors/v1.json", () => {
  it("is the pinned file", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(VECTORS_SHA256);
    expect(V.formatVersion).toBe(1);
  });
  it("names the same Memo program and kinds registry as the SDK", () => {
    expect(V.memoProgramId).toBe(MEMO_PROGRAM_ID);
    expect(V.kinds.map((k) => k.kind)).toEqual([...ANCHOR_KINDS]);
    for (const k of V.kinds) expect(KINDS[k.kind as keyof typeof KINDS]).toMatchObject({ signer: k.signer, status: k.status, count: k.count });
  });
});

describe("pseudonyms", () => {
  const fns = { userHash, handleHash, runHash };
  for (const p of V.pseudonyms) it(`${p.fn}(${p.input})`, async () => expect(await fns[p.fn](p.input)).toBe(p.output));
});

describe("canonical rows and leaf hashes", () => {
  for (const c of V.canonical) {
    it(c.name, async () => {
      expect(serializeRow(c.row)).toBe(c.canonical);
      expect(await leafHash(c.row)).toBe(c.leafHash);
    });
  }
  for (const c of V.invalidRows) it(`rejects: ${c.name}`, async () => await expect(merkleRoot([c.row])).rejects.toThrow());
  for (const d of V.duplicates) it(`rejects duplicates: ${d.name}`, async () => await expect(merkleRoot(d.rows)).rejects.toThrow());
});

describe("node hash", () => {
  for (const n of V.nodes) it(`${n.left.slice(0, 8)} + ${n.right.slice(0, 8)}`, async () => expect(await hashNode(n.left, n.right)).toBe(n.node));
});

describe("trees, proofs and memos", () => {
  for (const t of V.trees) {
    it(t.name, async () => {
      expect(await merkleRoot(t.rows)).toEqual({ root: t.root, count: t.count });
      expect(await merkleRoot([...t.rows].reverse())).toEqual({ root: t.root, count: t.count });
      expect(formatMemo({ kind: t.kind, id: t.id, root: t.root, count: t.count })).toBe(t.memo);
      for (const p of t.proofs) {
        const got = await merkleProof(t.rows, p.index);
        expect(got.leaf).toBe(p.leaf);
        expect(got.leafHash).toBe(t.sortedLeaves[p.index]!.hash);
        expect(got.proof).toEqual(p.proof);
        expect(await verifyProof(p.leaf, p.proof, t.root)).toBe(true);
        expect(await verifyAgainstMemo({ leaf: p.leaf, proof: p.proof, memoText: t.memo })).toMatchObject({ ok: true });
      }
      expect(await verifyAgainstMemo({ rows: t.rows, memoText: t.memo })).toMatchObject({ ok: true, root: t.root });
    });
  }
});

describe("leaf schemas", () => {
  it("cup leaves from frozen standings", async () => {
    const leaves = await cupLeavesFromStandings(V.cup.cupId, V.cup.standings);
    expect(leaves).toEqual(V.cup.leaves);
    expect(await merkleRoot(leaves)).toEqual({ root: V.cup.root, count: V.cup.count });
    expect(formatMemo({ kind: "cup", id: V.cup.cupId, root: V.cup.root, count: V.cup.count })).toBe(V.cup.memo);
  });
  it("board leaves", async () => {
    const leaves = await Promise.all(V.board.rows.map((r) => boardLeaf(V.board.kind, V.board.date, r)));
    expect(leaves).toEqual(V.board.leaves);
    expect(await merkleRoot(leaves)).toEqual({ root: V.board.root, count: V.board.count });
    expect(formatMemo({ kind: V.board.kind, id: V.board.date, root: V.board.root, count: V.board.count })).toBe(V.board.memo);
  });
});

describe("memo parsing", () => {
  for (const m of V.memos.valid) {
    it(`accepts ${m.text.slice(0, 40)}...`, () => {
      expect(parseMemo(m.text)).toEqual(m.fields);
      expect(formatMemo(m.fields!)).toBe(m.text);
    });
  }
  for (const m of V.memos.invalid) {
    it(`rejects: ${m.name}`, () => {
      expect(parseMemo(m.text)).toBeNull();
      expect(parseMemoStrict(m.text).ok).toBe(false);
    });
  }
});

describe("legacy cr1 parsing", () => {
  for (const m of V.legacyCr1.valid) it(`accepts ${m.text.slice(0, 24)}...`, () => expect(parseLegacyCr1(m.text)).toEqual(m.fields));
  for (const m of V.legacyCr1.invalid) it(`rejects: ${m.name}`, () => expect(parseLegacyCr1(m.text)).toBeNull());
});
