# @chartrunner/verify

Check a ChartRunner Trading Cup or leaderboard result yourself, without the ChartRunner app.

ChartRunner publishes a Merkle root of each frozen result set in a public Solana transaction (an SPL Memo). This
package recomputes that root from the published rows and compares it with the memo. It is the same code the ChartRunner
app uses for its own `/verify` page (<https://app.chartrunner.xyz/verify>); shared golden vectors in
[`test-vectors/v1.json`](https://github.com/ChartRunner/chartrunner-onchain/blob/main/test-vectors/v1.json) keep the two from drifting.

The format is specified in [SPEC.md](https://github.com/ChartRunner/chartrunner-onchain/blob/main/SPEC.md). This README is a usage guide; where the two differ, SPEC.md wins.

Pure TypeScript, ESM, zero runtime dependencies. Uses WebCrypto (`crypto.subtle`), so it runs in browsers and in Node 20+.

## What this proves, and what it does not

It proves:

- The standings you hold (every row, or one row plus a Merkle proof) are exactly the standings whose root was
  written to the chain in that transaction. Changing, adding, removing or reordering-with-edits any row changes the root.
- The transaction was a successful SPL Memo transaction and was signed as its kind requires (`--signer` /
  `expectSigner`; the CLI requires it, because anyone can post a memo for any id): paid by the operator address you
  expect for an operator kind, or signed by the wallet you expect for a user kind.
- The anchor was written at the transaction's slot, so the standings existed no later than then.

It does not prove:

- That the fills and prices behind the standings were fair, or that the game server's rules were applied correctly. It
  proves the published standings match the anchored root, plus whatever the server validated before it anchored.
  Each cup row carries `fh`, a hash of the fills behind the standing, so a published fills list can be checked against
  it, but that is a consistency check, not proof of fair execution.
- That the operator address is who you think it is. Compare it with the address ChartRunner publishes (`--signer`).
- Anything if you take the memo text or the RPC from a source you do not trust. Use an RPC you trust and, ideally, the
  transaction signature from ChartRunner's published links.

## Memo format (v1)

```
chartrunner:v1:<kind>:<id>:<root>:<count>
```

| field   | rule                                                              |
| ------- | ----------------------------------------------------------------- |
| `kind`  | operator kinds `freeplay`, `daily`, `cup`, `xp`; planned user kinds `map`, `strategy`, `bot`, `backtest` (count must be 1) |
| `id`    | 1-64 characters from `A-Z a-z 0-9 . _ -` (cup id, date, ...)      |
| `root`  | 64 lowercase hex characters                                       |
| `count` | number of rows, decimal, 1 to 999999999, no leading zeros         |

Parsing is strict: whitespace, other case, extra fields, other versions and out-of-range counts are all rejected.

Tree (format v1):

```
row_text = canonical JSON of the row (keys sorted, no whitespace; values are strings, safe integers, booleans or null)
leaf     = sha256(0x00 || utf8(row_text))
node     = sha256(0x01 || left || right)
```

Leaves are sorted ascending by leaf hash, duplicates are rejected, and a lone node on a level is promoted unchanged.
The leaf count is not hashed into the root; the memo carries it next to the root.

A cup row (`cupLeaf`) is `{v:1, k:"cup", id, rank, u, h, eq, pct, tr, dq, fh}`: `u`/`h` are sha256 pseudonyms of the
account and displayed name, `eq` the final equity and `pct` the return as fixed-decimal strings, `tr` the exits, `dq`
the disqualified flag and `fh` the hash of the fills.

## Install

Not published to npm yet. Build it from a checkout of this repository:

```
pnpm install && pnpm build
node packages/verify/dist/cli.js --help
```

Once published it will install as `npm install @chartrunner/verify` (the package has no runtime dependencies).

## Node

```ts
import { cupLeavesFromStandings, formatMemo, merkleRoot, merkleProof, verifyAgainstMemo, verifyAgainstSignature } from "@chartrunner/verify";

// 1. Offline: you have the rows and the memo text (copied from an explorer).
const rows = await cupLeavesFromStandings(cupId, results.standings); // or your own array of rows
const res = await verifyAgainstMemo({ rows, memoText });
if (res.ok) console.log("verified", res.root);
else console.log("not verified:", res.reason, res.message); // reason is e.g. "root_mismatch"

// 2. Online: read the memo from the chain yourself. You choose the RPC; there is no default.
const onChain = await verifyAgainstSignature({ signature, rpcUrl: "https://your-rpc.example", rows, expectSigner: operatorAddress });
// onChain.ok === false with reason "rpc_unreachable" | "tx_not_found" | "tx_failed" | "root_mismatch" | ...  (never "verified" on an outage)

// 3. One entry and its proof
const p = await merkleProof(rows, rows[0]);
await verifyAgainstMemo({ leaf: p.leaf, proof: p.proof, memoText });
```

## Browser

```html
<script type="module">
  import { verifyAgainstMemo } from "@chartrunner/verify"; // via your bundler or an import map
  const res = await verifyAgainstMemo({ rows, memoText });
  document.body.textContent = res.ok ? "verified" : `not verified: ${res.reason}`;
</script>
```

`fetchMemo` / `verifyAgainstSignature` read at `finalized` commitment by default (pass `commitment: "confirmed"` for
speed at the cost of rollback risk), and require the response to be the transaction you asked for, with execution
metadata showing success. They use `fetch` and work in the browser if your RPC allows CORS. Every Memo-program
instruction counts: a transaction with two is `multiple_memos`, never "the first one".

With `verifySignature: true`, `fetchMemo` also fetches the wire transaction and verifies its Ed25519 signatures with
WebCrypto, so memo, fee payer and signers come from bytes the keys signed, not from the RPC's JSON. The result's
`signatureCheck` is `verified`, `unsupported` (no Ed25519 in this runtime: the answer rests on the RPC alone, and says
so) or `not_requested`. Bytes that disagree with the RPC's JSON fail with `tx_mismatch`; a bad signature with
`bad_signature`.

## CLI

```
chartrunner-verify --rows results.json --sig <txsig> --rpc <url> --signer <address>
chartrunner-verify --rows results.json --memo "<memo text>"      # offline
chartrunner-verify --proof proof.json  --memo "<memo text>"      # one entry + proof
```

`results.json` is an array of rows, `{"rows": [...]}`, or a cup results document
(`{"cupId": "...", "results": {"standings": [...]}}`, converted to rows exactly as the app does). `proof.json` is
`{"leaf": "<canonical json>", "proof": [{"side": "L"|"R", "hash": "<hex>"}]}`. `--signer` is required with `--sig`: anyone can post a memo for any id, so a matching root only means something when the
transaction was paid by the operator address ChartRunner publishes. Add `--kind`/`--id` to pin the memo
to a snapshot and `--json` for machine output. `--verify-signature` checks the transaction's signatures locally (above).
`--check-equivocation` scans the operator's finalized history for other anchors of the same kind/id (SPEC 2.5): a
different root or count is a mismatch (exit `1`), a duplicate or an anchor that is not the first finalized one is a
warning, and a scan that cannot complete is an error (exit `2`).

Exit codes: `0` verified, `1` mismatch (the data does not match the anchor, or the memo is not a valid anchor),
`2` error (bad input, no RPC given, RPC outage, transaction not found, ...). An outage is never a pass.

The offline `--memo` text is used exactly as given (no trimming).

From a checkout: `node packages/verify/dist/cli.js ...` after `pnpm build`, or `node packages/verify/bin/chartrunner-verify.mjs ...`,
which runs the TypeScript source directly (Node 22.18+ strips the types on the fly; `engines.node` is `>=22.18`). The
built library itself only needs a runtime with WebCrypto and `fetch` (Node 20+ or a current browser).

## API

| export | purpose |
| ------ | ------- |
| `serializeRow(row)` | canonical text of a row |
| `leafHash(row)` | hex leaf hash |
| `merkleRoot(rows)` | `{ root, count }` |
| `merkleProof(rows, rowOrIndex)` | `{ index, leaf, leafHash, proof, root, count }` |
| `verifyProof(leafText, proof, root)` | boolean check of one proof (low level) |
| `formatMemo(fields)` / `parseMemo(text)` | build / strictly parse the memo (`parseMemo` returns `null` on anything malformed) |
| `parseMemoStrict(text)` | like `parseMemo` but with a failure reason |
| `verifyAgainstMemo({ rows \| leaf+proof, memoText, expect? })` | `{ ok: true, ... }` or `{ ok: false, reason, message }` |
| `fetchMemo(signature, { rpcUrl, verifySignature? })` | read the memo of a transaction via `getTransaction`; optionally verify its signatures locally |
| `checkTransactionSignatures(base64, memoProgramId)` | decode a wire transaction and verify every Ed25519 signature (low level) |
| `verifyAgainstSignature({ signature, rpcUrl, rows \| leaf+proof })` | fetch + verify |
| `cupLeaf`, `boardLeaf`, `cupLeavesFromStandings`, `userHash`, `handleHash`, `runHash` | build the exact leaves the app anchors |
| `KINDS`, `ANCHOR_KINDS`, `OPERATOR_KINDS`, `USER_KINDS`, `kindInfo`, `isOperatorKind`, `isUserKind` | the kinds registry: signer model, status, id and count rule of each kind |
| `signerModelOf(memo)` | which signer rule `expectSigner` applies to a memo |
| `checkEquivocation({ rpcUrl, operator, kind, id })` | scan the operator's history: `none`, `unique`, `duplicate` or `equivocation`, plus the first finalized anchor |
| `parseLegacyCr1(text)` | read a legacy `cr1:<kind>:<name>:<hash>` memo (frozen, read-only; never a v1 anchor) |

Failure reasons from `verifyAgainstMemo`: `memo_malformed`, `memo_subject_mismatch`, `rows_invalid`, `leaf_invalid`,
`proof_invalid`, `root_mismatch`, `count_mismatch`, `input_invalid`. From the RPC helpers: `rpc_url_invalid`,
`signature_invalid`, `signature_mismatch`, `meta_missing`, `rpc_unreachable`, `rpc_error`, `tx_not_found`, `tx_failed`, `no_memo`, `multiple_memos`,
`signer_mismatch`, and with `verifySignature`: `tx_undecodable`, `bad_signature`, `tx_mismatch`. From `checkEquivocation`: `input_invalid`, `rpc_url_invalid`, `rpc_unreachable`, `rpc_error`,
`scan_incomplete` (never answered with `none` or `unique` from a partial history).

## Development

```
pnpm --filter @chartrunner/verify test
pnpm --filter @chartrunner/verify build   # emits dist/ with type declarations (not published to npm yet)
```

`src/__tests__/legacy-*.ts` are copies of the app's modules from before this package was extracted, kept only so
tests can prove the SDK produces byte-identical output. `src/__tests__/vectors.test.ts` checks the shared golden
vectors. Do not change hashing or serialization: the roots already on chain depend on it.

## License

Apache-2.0.
