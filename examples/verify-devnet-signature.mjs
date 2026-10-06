// TEMPLATE: verify a results file against an anchor transaction on Solana devnet.
//
// Fill in the two placeholders below, then:
//
//   pnpm build && node examples/verify-devnet-signature.mjs
//
// Or from the command line:
//
//   chartrunner-verify --rows results.json --sig <signature> --rpc https://api.devnet.solana.com --signer <operator address>
//
// Where the values come from:
//   SIGNATURE         the anchor transaction signature, from the "anchored" link on the cup or leaderboard page
//   OPERATOR_ADDRESS  the operator address ChartRunner publishes next to its anchors (see https://docs.chartrunner.xyz)
//   RPC_URL           any Solana RPC you trust for the cluster the anchor lives on (devnet here; mainnet anchors need
//                     a mainnet RPC). The SDK has no default RPC on purpose.
//
// Anyone can post a memo with any text, so the signer check is not optional: a matching root only means something
// when the transaction was paid by the published operator address.

import { readFileSync } from "node:fs";
import { cupLeavesFromStandings, verifyAgainstSignature } from "@chartrunner/verify";

// ---- PLACEHOLDERS: replace both before running. They are deliberately not valid values. ----
const SIGNATURE = "REPLACE_WITH_ANCHOR_TRANSACTION_SIGNATURE";
const OPERATOR_ADDRESS = "REPLACE_WITH_PUBLISHED_OPERATOR_ADDRESS";
// ----------------------------------------------------------------------------------------------
const RPC_URL = "https://api.devnet.solana.com";
const RESULTS_FILE = new URL("./results.json", import.meta.url); // replace with the real cup's results document

if (SIGNATURE.startsWith("REPLACE_WITH") || OPERATOR_ADDRESS.startsWith("REPLACE_WITH")) {
  console.error("This is a template: set SIGNATURE and OPERATOR_ADDRESS in examples/verify-devnet-signature.mjs first.");
  process.exit(2);
}

const doc = JSON.parse(readFileSync(RESULTS_FILE, "utf8"));
const rows = await cupLeavesFromStandings(doc.cupId, doc.results.standings);

const res = await verifyAgainstSignature({
  signature: SIGNATURE,
  rpcUrl: RPC_URL,
  expectSigner: OPERATOR_ADDRESS,
  commitment: "finalized", // the default; "confirmed" is faster but can still be rolled back
  rows,
  expect: { kind: "cup", id: doc.cupId },
});

if (res.ok) {
  console.log(`VERIFIED  ${res.memo.kind} ${res.memo.id}: root ${res.root}, paid by ${res.feePayer}, slot ${res.slot}`);
} else {
  // An RPC outage is reported as a failure (rpc_unreachable, tx_not_found, ...), never as verified.
  console.error(`NOT VERIFIED  ${res.reason}: ${res.message}`);
  process.exitCode = 1;
}
