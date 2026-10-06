// Verify a cup results file against an anchor memo, fully offline (no RPC, no network).
//
//   pnpm build && pnpm examples          (from the repository root)
//   node examples/verify-offline.mjs     (same thing)
//
// In real use you take the memo text from the anchor transaction on a Solana explorer (and check there that the fee
// payer is the operator address ChartRunner publishes), and the results file from the cup's results page.
// The same check from the command line:
//
//   chartrunner-verify --rows examples/results.json --memo "<memo text>"

import { readFileSync } from "node:fs";
import { cupLeavesFromStandings, merkleProof, verifyAgainstMemo } from "@chartrunner/verify";

// Synthetic example data. This memo was computed for examples/results.json; it is not on any chain.
const MEMO = "chartrunner:v1:cup:cup-vector-1:78455195b53abbd802140deccde0f5f8f483781af0cb4ba9ef8359ba169280e3:3";

const doc = JSON.parse(readFileSync(new URL("./results.json", import.meta.url), "utf8"));
const rows = await cupLeavesFromStandings(doc.cupId, doc.results.standings);

let failures = 0;
const expectOutcome = (label, res, wantOk) => {
  const good = res.ok === wantOk;
  if (!good) failures++;
  console.log(`${good ? "ok  " : "FAIL"}  ${label}: ${res.ok ? `verified, root ${res.root}` : `not verified (${res.reason})`}`);
};

// 1. Every standing, pinned to the cup id so a memo for another cup cannot be replayed.
expectOutcome("all standings", await verifyAgainstMemo({ rows, memoText: MEMO, expect: { kind: "cup", id: doc.cupId } }), true);

// 2. One player's standing plus its Merkle proof (what a single player keeps).
const proof = await merkleProof(rows, rows[0]);
expectOutcome("one standing + proof", await verifyAgainstMemo({ leaf: proof.leaf, proof: proof.proof, memoText: MEMO }), true);

// 3. A tampered result must fail: change the winner's final equity.
const tampered = rows.map((r, i) => (i === 0 ? { ...r, eq: "99999.000000" } : r));
expectOutcome("tampered equity (must fail)", await verifyAgainstMemo({ rows: tampered, memoText: MEMO }), false);

// 4. A dropped standing must fail too.
expectOutcome("dropped standing (must fail)", await verifyAgainstMemo({ rows: rows.slice(1), memoText: MEMO }), false);

process.exitCode = failures === 0 ? 0 : 1;
