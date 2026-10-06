#!/usr/bin/env node
// Generates test-vectors/v1.json from SPEC.md using an implementation that is independent of @chartrunner/verify
// (node:crypto, written from the spec, no shared code). The SDK tests then check that the SDK reproduces every vector,
// and the ChartRunner app checks the same file, so the public SDK and the app cannot drift apart silently.
//
//   node scripts/gen-vectors.mjs --check   exit 0 when the committed file equals what the spec produces (CI runs this)
//   node scripts/gen-vectors.mjs --write   rewrite the file (only for ADDING vectors; existing ones are frozen)
//
// Format v1 is frozen. A changed value for an existing vector means the implementation broke, not that the vector is stale.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("../test-vectors/v1.json", import.meta.url);

const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : p)))).digest();
const shaHex = (text) => sha(text).toString("hex");

// ---- spec section 3: canonical row text ----
function canonical(row) {
  const keys = Object.keys(row).sort(); // UTF-16 code unit order
  return `{${keys
    .map((k) => {
      const v = row[k];
      const ok = typeof v === "string" || typeof v === "boolean" || v === null || (typeof v === "number" && Number.isSafeInteger(v));
      if (!ok) throw new Error(`invalid value for ${k}`);
      return `${JSON.stringify(k)}:${JSON.stringify(v)}`;
    })
    .join(",")}}`;
}

// ---- spec section 4: tree ----
const leafHash = (text) => sha(Buffer.from([0x00]), text).toString("hex");
const nodeHash = (l, r) => sha(Buffer.from([0x01]), Buffer.from(l, "hex"), Buffer.from(r, "hex")).toString("hex");

function tree(rows) {
  if (rows.length === 0) throw new Error("empty");
  const leaves = rows.map((r) => ({ text: canonical(r), hash: leafHash(canonical(r)) })).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  for (let i = 1; i < leaves.length; i++) if (leaves[i].hash === leaves[i - 1].hash) throw new Error("duplicate");
  const levels = [leaves.map((l) => l.hash)];
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1);
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  const proof = (index) => {
    const steps = [];
    let i = index;
    for (let l = 0; l < levels.length - 1; l++) {
      const sib = i % 2 === 0 ? i + 1 : i - 1;
      if (sib < levels[l].length) steps.push({ side: i % 2 === 0 ? "R" : "L", hash: levels[l][sib] });
      i = Math.floor(i / 2);
    }
    return steps;
  };
  return { leaves, root: levels.at(-1)[0], count: leaves.length, proof };
}

const memo = (kind, id, root, count) => `chartrunner:v1:${kind}:${id}:${root}:${count}`;

// ---- spec section 2.2: kinds registry ----
const KINDS = [
  { kind: "freeplay", signer: "operator", status: "active", count: "any" },
  { kind: "daily", signer: "operator", status: "active", count: "any" },
  { kind: "cup", signer: "operator", status: "active", count: "any" },
  { kind: "xp", signer: "operator", status: "reserved", count: "any" },
  { kind: "map", signer: "user", status: "planned", count: "one" },
  { kind: "strategy", signer: "user", status: "planned", count: "one" },
  { kind: "bot", signer: "user", status: "planned", count: "one" },
  { kind: "backtest", signer: "user", status: "planned", count: "one" },
];

// ---- spec section 5: leaf schemas ----
const userHash = (id) => shaHex(`chartrunner:user:${id}`);
const handleHash = (h) => shaHex(`chartrunner:handle:${h.toLowerCase()}`);
const runHash = (id) => shaHex(`chartrunner:run:${id}`);

const cupLeaf = (cupId, s) => ({ v: 1, k: "cup", id: cupId, rank: s.rank, u: userHash(s.userId), h: handleHash(s.name), eq: s.equity, pct: s.pnlPct, tr: s.trades, dq: s.disqualified, fh: s.fillsHash });
const boardLeaf = (kind, date, r) => ({ v: 1, k: kind, d: date, rank: r.rank, u: userHash(r.userId), h: handleHash(r.handle), s: r.score, dist: r.distance, r: runHash(r.runId) });

// ---- inputs (all synthetic) ----
const canonicalCases = [
  ["key order and no whitespace", { s: 1, id: "a" }],
  ["all value types", { str: "x", int: -42, zero: 0, t: true, f: false, n: null }],
  ["largest safe integers", { max: 9007199254740991, min: -9007199254740991 }],
  ["string escaping", { q: 'say "hi"', bs: "a\\b", nl: "line\nbreak", tab: "\t", nul: "\u0000", bell: "\u0007", del: "\u007f" }],
  ["non-ASCII stays literal UTF-8", { name: "Zoë", city: "東京", emoji: "🚀", sep: " " }],
  ["keys sort by UTF-16 code unit, not code point", { "～": 1, "😀": 2, "é": 3, a: 4, B: 5, "": 6 }],
  ["empty object", {}],
];

const invalidRows = [
  ["float", { s: 1.5 }],
  ["unsafe integer", { s: 9007199254740992 }],
  ["nested object", { o: { a: 1 } }],
  ["array", { a: [1, 2] }],
];

const rowsN = (n) => Array.from({ length: n }, (_, i) => ({ i, name: `p${i}`, ok: i % 2 === 0, none: null }));

const treeCases = [
  ["one row: root is the leaf hash", [{ id: "a", s: 1 }]],
  ["two rows", [{ id: "a", s: 1 }, { id: "b", s: 2 }]],
  ["three rows: last node promoted", [{ id: "c", s: 3 }, { id: "a", s: 1 }, { id: "b", s: 2 }]],
  ["four rows: full tree", rowsN(4)],
  ["five rows: promotion across two levels", rowsN(5)],
  ["seven rows", rowsN(7)],
];

const duplicateCases = [
  ["same row twice", [{ id: "a", s: 1 }, { id: "a", s: 1 }]],
  ["same row with a different key order", [{ id: "a", s: 1 }, { s: 1, id: "a" }]],
];

const cupId = "cup-vector-1";
const standings = [
  { rank: 1, userId: "user-0001", name: "Alice", equity: "11250.500000", pnlPct: "12.5050", trades: 14, disqualified: false, fillsHash: "a".repeat(64) },
  { rank: 2, userId: "user-0002", name: "Bob", equity: "10100.000000", pnlPct: "1.0000", trades: 3, disqualified: false, fillsHash: "b".repeat(64) },
  { rank: 3, userId: "user-0003", name: "Cy", equity: "5000.000000", pnlPct: "-50.0000", trades: 40, disqualified: true, fillsHash: "c".repeat(64) },
];

const boardDate = "2026-10-02";
const boardRows = [
  { rank: 1, userId: "user-0001", handle: "Alice", runId: "run-0001", score: 90, distance: 20 },
  { rank: 2, userId: "user-0002", handle: "bob", runId: "run-0002", score: 75, distance: 18 },
  { rank: 2, userId: "user-0003", handle: "Cy", runId: "run-0003", score: 75, distance: 30 },
];

const R = "0e35f6c675e52d251f7e0b25c5fb5d8b728344eea7f519f70ffc950651d95f92";
const validMemos = [
  ["chartrunner:v1:cup:cup-2026.10:" + R + ":3", { kind: "cup", id: "cup-2026.10", root: R, count: 3 }],
  ["chartrunner:v1:daily:2026-10-02:" + R + ":1", { kind: "daily", id: "2026-10-02", root: R, count: 1 }],
  ["chartrunner:v1:freeplay:2026-10-02:" + R + ":999999999", { kind: "freeplay", id: "2026-10-02", root: R, count: 999999999 }],
  ["chartrunner:v1:xp:" + "a".repeat(64) + ":" + R + ":12", { kind: "xp", id: "a".repeat(64), root: R, count: 12 }],
  ["chartrunner:v1:cup:A_b.c-9:" + R + ":42", { kind: "cup", id: "A_b.c-9", root: R, count: 42 }],
  ["chartrunner:v1:map:ent_01J9.x-y:" + R + ":1", { kind: "map", id: "ent_01J9.x-y", root: R, count: 1 }],
  ["chartrunner:v1:strategy:s-1:" + R + ":1", { kind: "strategy", id: "s-1", root: R, count: 1 }],
  ["chartrunner:v1:bot:b-1:" + R + ":1", { kind: "bot", id: "b-1", root: R, count: 1 }],
  ["chartrunner:v1:backtest:bt-1:" + R + ":1", { kind: "backtest", id: "bt-1", root: R, count: 1 }],
];
const invalidMemos = [
  ["empty", ""],
  ["trailing space", `chartrunner:v1:cup:x:${R}:3 `],
  ["leading space", ` chartrunner:v1:cup:x:${R}:3`],
  ["trailing newline", `chartrunner:v1:cup:x:${R}:3\n`],
  ["other version", `chartrunner:v2:cup:x:${R}:3`],
  ["unknown kind", `chartrunner:v1:nope:x:${R}:3`],
  ["uppercase kind", `chartrunner:v1:CUP:x:${R}:3`],
  ["uppercase root", `chartrunner:v1:cup:x:${R.toUpperCase()}:3`],
  ["short root", `chartrunner:v1:cup:x:${R.slice(1)}:3`],
  ["zero count", `chartrunner:v1:cup:x:${R}:0`],
  ["leading-zero count", `chartrunner:v1:cup:x:${R}:03`],
  ["ten-digit count", `chartrunner:v1:cup:x:${R}:1000000000`],
  ["extra field", `chartrunner:v1:cup:x:${R}:3:extra`],
  ["empty id", `chartrunner:v1:cup::${R}:3`],
  ["id too long", `chartrunner:v1:cup:${"a".repeat(65)}:${R}:3`],
  ["id with a space", `chartrunner:v1:cup:a b:${R}:3`],
  ["legacy cr1 memo", `cr1:map:Example:${"ab".repeat(32)}`],
  ["user kind with count 2", `chartrunner:v1:map:e1:${R}:2`],
  ["user kind with a free-text name as id", `chartrunner:v1:map:My Map:${R}:1`],
];

// ---- spec section 10: legacy cr1 (read-only) ----
const H = "ab".repeat(32);
const validCr1 = [
  [`cr1:map:First map:${H}`, { version: "cr1", kind: "map", name: "First map", contentHash: H }],
  [`cr1:map:Map 🗺:${H}`, { version: "cr1", kind: "map", name: "Map 🗺", contentHash: H }],
];
const invalidCr1 = [
  ["unknown legacy kind", `cr1:strategy:Name:${H}`],
  ["empty name", `cr1:map::${H}`],
  ["name over 64 UTF-8 bytes", `cr1:map:${"é".repeat(33)}:${H}`],
  ["colon in name", `cr1:map:a:b:${H}`],
  ["uppercase hash", `cr1:map:Name:${H.toUpperCase()}`],
  ["other version", `cr2:map:Name:${H}`],
];
function parseCr1(text) {
  const p = text.split(":");
  if (p.length !== 4 || p[0] !== "cr1" || p[1] !== "map" || p[2] === "" || Buffer.byteLength(p[2], "utf8") > 64 || !/^[0-9a-f]{64}$/.test(p[3])) return null;
  return { version: "cr1", kind: p[1], name: p[2], contentHash: p[3] };
}

// ---- build ----
function treeVector(name, kind, id, rows) {
  const t = tree(rows);
  return {
    name,
    kind,
    id,
    rows,
    sortedLeaves: t.leaves.map((l) => ({ canonical: l.text, hash: l.hash })),
    root: t.root,
    count: t.count,
    memo: memo(kind, id, t.root, t.count),
    proofs: t.leaves.map((l, index) => ({ index, leaf: l.text, proof: t.proof(index) })),
  };
}

function rejects(rows) {
  try {
    tree(rows);
    return false;
  } catch {
    return true;
  }
}

function parseV1(text) {
  const m = /^chartrunner:v1:([a-z]+):([A-Za-z0-9._-]{1,64}):([0-9a-f]{64}):([1-9][0-9]{0,8})$/.exec(text);
  const k = m && KINDS.find((x) => x.kind === m[1]);
  if (!k || (k.count === "one" && m[4] !== "1")) return null;
  return { kind: m[1], id: m[2], root: m[3], count: Number(m[4]) };
}

function build() {
  for (const [text, fields] of validMemos) if (JSON.stringify(parseV1(text)) !== JSON.stringify(fields)) throw new Error(`memo vector wrong: ${text}`);
  for (const [name, text] of invalidMemos) if (parseV1(text) !== null) throw new Error(`invalid memo accepted: ${name}`);
  for (const [text, fields] of validCr1) if (JSON.stringify(parseCr1(text)) !== JSON.stringify(fields)) throw new Error(`cr1 vector wrong: ${text}`);
  for (const [name, text] of invalidCr1) if (parseCr1(text) !== null) throw new Error(`invalid cr1 accepted: ${name}`);
  for (const [name, row] of invalidRows) if (!rejects([row])) throw new Error(`invalid row accepted: ${name}`);
  for (const [name, rows] of duplicateCases) if (!rejects(rows)) throw new Error(`duplicate accepted: ${name}`);

  const cupLeaves = standings.map((s) => cupLeaf(cupId, s));
  const boardLeaves = boardRows.map((r) => boardLeaf("daily", boardDate, r));
  const a = leafHash(canonical({ id: "a", s: 1 }));
  const b = leafHash(canonical({ id: "b", s: 2 }));

  return {
    format: "chartrunner-anchor-test-vectors",
    formatVersion: 1,
    spec: "SPEC.md (chartrunner:v1)",
    note: "Frozen. Values are produced by scripts/gen-vectors.mjs from the spec with node:crypto, independently of @chartrunner/verify. Never edit a value; only append new vectors.",
    memoProgramId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    kinds: KINDS,
    pseudonyms: [
      { fn: "userHash", input: "user-0001", output: userHash("user-0001") },
      { fn: "handleHash", input: "Alice", output: handleHash("Alice") },
      { fn: "handleHash", input: "ALICE", output: handleHash("ALICE") },
      { fn: "runHash", input: "run-0001", output: runHash("run-0001") },
    ],
    canonical: canonicalCases.map(([name, row]) => ({ name, row, canonical: canonical(row), leafHash: leafHash(canonical(row)) })),
    invalidRows: invalidRows.map(([name, row]) => ({ name, row })),
    nodes: [{ left: a, right: b, node: nodeHash(a, b) }],
    trees: treeCases.map(([name, rows], i) => treeVector(name, "cup", `vector-${i + 1}`, rows)),
    duplicates: duplicateCases.map(([name, rows]) => ({ name, rows })),
    cup: { cupId, standings, leaves: cupLeaves, ...pick(treeVector("cup leaves from standings", "cup", cupId, cupLeaves)) },
    board: { kind: "daily", date: boardDate, rows: boardRows, leaves: boardLeaves, ...pick(treeVector("daily board leaves", "daily", boardDate, boardLeaves)) },
    memos: {
      valid: validMemos.map(([text, fields]) => ({ text, fields })),
      invalid: invalidMemos.map(([name, text]) => ({ name, text })),
    },
    legacyCr1: {
      valid: validCr1.map(([text, fields]) => ({ text, fields })),
      invalid: invalidCr1.map(([name, text]) => ({ name, text })),
    },
  };
}

const pick = (t) => ({ root: t.root, count: t.count, memo: t.memo });

const text = `${JSON.stringify(build(), null, 2)}\n`;
const mode = process.argv[2];
if (mode === "--write") {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT.pathname}`);
} else if (mode === "--check") {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    // missing file is a mismatch
  }
  if (current !== text) {
    console.error("test-vectors/v1.json does not match what the spec produces. Existing vectors are frozen: find out what changed.");
    process.exit(1);
  }
  console.log("test-vectors/v1.json matches the spec");
} else {
  console.error("usage: node scripts/gen-vectors.mjs --check | --write");
  process.exit(2);
}
