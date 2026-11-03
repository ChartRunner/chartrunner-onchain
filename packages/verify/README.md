# @chartrunner/verify

Check a ChartRunner Trading Cup or leaderboard result yourself, without the ChartRunner app.

ChartRunner publishes a Merkle root of each frozen result set in a public Solana transaction (an SPL Memo). This
package recomputes that root from the published rows and compares it with the memo. It is the same code the ChartRunner
app uses for its own `/verify` page (<https://app.chartrunner.xyz/verify>); shared golden vectors in
[`test-vectors/v1.json`](https://github.com/ChartRunner/chartrunner-onchain/blob/main/test-vectors/v1.json) keep the two from drifting.

The format is specified in [SPEC.md](https://github.com/ChartRunner/chartrunner-onchain/blob/main/SPEC.md). This README is a usage guide; where the two differ, SPEC.md wins.

Pure TypeScript, ESM, zero runtime dependencies. Uses WebCrypto (`crypto.subtle`, Ed25519 for `verifySignature`) and
`fetch`, so it runs in current browsers and in Node 20 or later (`engines.node` is `>=20`).

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
| `kind`  | operator kinds `freeplay`, `daily`, `cup`, `xp`, `dailyrun`, `dailyrace`, `battle`; planned user kinds `map`, `strategy`, `bot`, `backtest` (count must be 1) |
| `id`    | 1-64 characters from `A-Z a-z 0-9 . _ -` (cup id, date, ...); for `battle`, the 4-hour UTC window `YYYY-MM-DDTHH` on a real date, `HH` one of `00 04 08 12 16 20` |
| `root`  | 64 lowercase hex characters                                       |
| `count` | number of rows, decimal, 1 to 999999999, no leading zeros; at most 10000 for `battle` |

Parsing is strict: whitespace, other case, extra fields, other versions and out-of-range counts are all rejected.

Tree (format v1):

```
row_text = canonical JSON of the row (keys sorted, no whitespace; values are strings, safe integers, booleans or null)
leaf     = sha256(0x00 || utf8(row_text))
node     = sha256(0x01 || left || right)
```

Leaves are sorted ascending by leaf hash, duplicates are rejected, and a lone node on a level is promoted unchanged.
The leaf count is not hashed into the root; the memo carries it next to the root. A full row set is checked against
`count`; one row with a proof is bound to `count` only as an upper bound on the proof's length, so proof mode shows the
row is in the committed set, not that the set is complete (SPEC section 8).

A row must be a plain JSON object. `serializeRow`, `leafHash`, `merkleRoot` and `merkleProof` throw on an array, `null`,
a primitive or a class instance such as a `Date` or `Map`, and `verifyAgainstMemo` reports `rows_invalid` (or
`leaf_invalid` for a non-string `leaf`). Earlier builds serialized an array row as `{"0":...,"1":...}`; no anchor
depends on that, because the app only ever anchors objects.

A cup row (`cupLeaf`) is `{v:1, k:"cup", id, rank, u, h, eq, pct, tr, dq, fh}`: `u`/`h` are sha256 pseudonyms of the
account and displayed name, `eq` the final equity and `pct` the return as fixed-decimal strings, `tr` the exits, `dq`
the disqualified flag and `fh` the hash of the fills (`fillsHash`, SPEC 7.2.1).

A leaderboard-day row (`boardLeaf`, kinds `freeplay` and `daily`) is `{v:1, k, d, rank, u, h, s, dist, r}`: the date,
the rank by score, the pseudonyms of the account, the handle and the run, the score and the distance. The daily
chart's mode boards add to it: a Daily Run row (`dailyRunLeaf`, kind `dailyrun`) is `{v:1, k, d, rank, u, h, s, dist,
hc, fin, r}` with `hc` the HARDCORE flag and `fin` whether the run survived the 2:00 timer; a Daily Race row
(`dailyRaceLeaf`, kind `dailyrace`) is `{v:1, k, d, rank, u, h, ft, dist, hc, r}`, ranked by `ft`, the finish tick
(60 per second, lowest first). See SPEC.md sections 7.1, 7.3 and 7.4.

A battle row (`battleLeaf`, kind `battle`) is `{v:1, k:"battle", id, b, rank, u, h, eq, pct, tr, out, fin, fh}`: `id` the
4-hour UTC window the battle's results were frozen in, `b` the battle's lowercase UUID (never its join code), `u`/`h`,
`eq`, `pct`, `tr` and `fh` as in a cup row (`eq` with exactly 6 decimals, `pct` with exactly 4, `-` when negative),
`out` knocked out (Last Man Standing) and `fin` reached the target (Profit Race). `battleLeaf` refuses any input outside
the schema; `battleLeafProblem` / `isBattleLeaf` check a built leaf. See SPEC.md section 7.5.

## Install

Not published to npm yet. Build it from a checkout of this repository:

```
pnpm install && pnpm build
node packages/verify/dist/cli.js --help
```

Once published it will install as `npm install @chartrunner/verify` (the package has no runtime dependencies).

Publishing is manual and owner-only. The `Publish @chartrunner/verify` workflow
(`.github/workflows/publish.yml`) runs when the owner publishes a GitHub release tagged `v<version>`, or when the owner
dispatches it by hand (a dry run by default). It builds, tests, checks the vectors and runs
`npm publish --provenance --access public` with the `NPM_TOKEN` repository secret, which only the owner sets.
`prepublishOnly` refuses to publish when `LICENSE`, `NOTICE` or the built `dist/` is missing from the package
directory (`node scripts/pack-files.mjs copy` puts the licence files in place; `prepack` does it too). CI packs the
package on every pull request, installs the tarball in an empty project and runs the CLI and the offline example on
Node 20 and 24.

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
`--signer` must be a base58 address of 32 bytes; anything else is a usage error (exit `2`), so a typo is never reported
as a mismatch. In a runtime without WebCrypto Ed25519, `--verify-signature` exits `2` with `signature_unverified`
(the check was requested but not performed), never `0`. Instead of `--rpc` you can set `CHARTRUNNER_RPC_URL`, which
keeps a URL with an API key out of your shell history; `--rpc` overrides it, and offline (`--memo`) runs ignore it.
`--check-equivocation` scans the operator's finalized history for other anchors of the same kind/id (SPEC 2.5) and
applies "first finalized operator memo wins" to the transaction checked: if another anchor has a different root or
count, the checked one passes (with a loud warning) only if it has the same root and count as the first finalized, and
is a mismatch (exit `1`) otherwise; a duplicate is a warning; a scan that cannot complete, or that completes without
finding the checked transaction, is an error (exit `2`: the root matched, but uniqueness was not checked). `--max-signatures <n>` sets how much history to read (default 100000); it takes plain decimal digits only, so `1e3`, `0x10`
or `10.0` are usage errors.

### Exit codes

`0` verified. `1` the data does not match: the rows, the proof or the transaction contradict the anchor (tampering or
a mismatch). `2` a usage or environment error, or a check that was not performed: nothing was compared, so there is no
verdict either way. An outage is never a pass.

| code | reason | why this code |
| ---- | ------ | ------------- |
| `1` | `root_mismatch`, `count_mismatch`, `proof_invalid` | the data you hold does not rebuild the anchored root or count (a proof longer than the count allows cannot belong to that tree) |
| `1` | `memo_malformed`, `memo_subject_mismatch` | the memo is not a valid anchor, or is for another kind or id than you pinned |
| `1` | `no_memo`, `multiple_memos`, `tx_failed`, `signer_mismatch` | the transaction is not a valid anchor: no single memo, failed on chain, or not signed as its kind requires |
| `1` | `bad_signature`, `tx_mismatch` | with `--verify-signature`: the RPC served data that the signed transaction bytes contradict, a forged answer, so the data does not match |
| `1` | `equivocation` | with `--check-equivocation`: the operator anchored this kind/id with another root or count first, so this anchor is void |
| `2` | `rows_invalid`, `leaf_invalid`, `input_invalid` | your input cannot be committed or read (empty, duplicate rows, a float, an array as a row, ...): an input error, nothing was compared |
| `2` | usage errors (no reason): unknown flag, missing `--rpc`/`CHARTRUNNER_RPC_URL` or `--signer`, a `--signer` that is not a 32-byte base58 address, a bad `--max-signatures` | fix the command line |
| `2` | `rpc_url_invalid`, `signature_invalid` | the URL or transaction signature you gave is malformed |
| `2` | `rpc_unreachable`, `rpc_error`, `tx_not_found`, `meta_missing`, `signature_mismatch`, `tx_undecodable` | the RPC could not give a usable answer (outage, pruned history, a different transaction than asked for, bytes that do not decode); nothing proves the anchor right or wrong |
| `2` | `signature_unverified` | `--verify-signature` was requested, but this runtime has no Ed25519, so it was not performed |
| `2` | `equivocation_unchecked` | the root matched, but the equivocation scan could not complete or did not find this transaction: uniqueness was not checked |

`signature_mismatch` stays `2` while `tx_mismatch` is `1`: the first is an RPC returning some other transaction, which
says nothing about this anchor; the second is the RPC's description of this transaction contradicted by its own signed
bytes.

The offline `--memo` text is used exactly as given (no trimming).

From a checkout: `node packages/verify/dist/cli.js ...` after `pnpm build`, or `node packages/verify/bin/chartrunner-verify.mjs ...`,
which runs the TypeScript source directly on a Node that strips types (22.18 or later) and the built `dist/` otherwise.
The package needs only a runtime with global WebCrypto and `fetch`: Node 20 or later (`engines.node` is `>=20`; Node 18
has no global `crypto`), or a current browser. Building and testing this repository needs Node 24 (`.node-version`).

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
| `cupLeaf`, `boardLeaf`, `dailyRunLeaf`, `dailyRaceLeaf`, `battleLeaf`, `cupLeavesFromStandings`, `userHash`, `handleHash`, `runHash` | build the exact leaves the app anchors |
| `battleLeafProblem`, `isBattleLeaf`, `isBattleWindowId`, `MAX_BATTLE_LEAVES` | check a battle leaf and a battle window id against SPEC 7.5 and 2.2 |
| `fillsHash`, `fillsCanonical`, `fillsCommitment`, `CUP_ORDER_TYPES`, `BATTLE_ORDER_TYPES` | the `fh` of a cup or battle standing from its fills (SPEC 7.2.1): canonical fill list in submission order plus final-sweep liquidations, SHA-256 |
| `rankRows`, `rankRowsBy` | standard competition ranking (ties share a rank) over rows sorted best first: by score, or by any key such as a race's finish tick |
| `KINDS`, `ANCHOR_KINDS`, `OPERATOR_KINDS`, `USER_KINDS`, `kindInfo`, `isOperatorKind`, `isUserKind`, `kindRuleViolation` | the kinds registry: signer model, status, id and count rule of each kind |
| `signerModelOf(memo)` | which signer rule `expectSigner` applies to a memo |
| `checkEquivocation({ rpcUrl, operator, kind, id, maxSignatures? })` | scan the operator's history: `none`, `unique`, `duplicate` or `equivocation`, plus the first finalized anchor |
| `anchorStanding(result, checked)` | find the anchor being verified in a completed scan and apply the first-finalized-wins rule: `not_in_scan` (uniqueness not checked), `sole`, `duplicate`, `equivocation_first` (same root and count as the first finalized: pass, warn) or `not_first` (fail) |
| `parseLegacyCr1(text)` | read a legacy `cr1:<kind>:<name>:<hash>` memo (frozen, read-only; never a v1 anchor) |

Failure reasons from `verifyAgainstMemo`: `memo_malformed`, `memo_subject_mismatch`, `rows_invalid`, `leaf_invalid`,
`proof_invalid`, `root_mismatch`, `count_mismatch`, `input_invalid`. From the RPC helpers: `rpc_url_invalid`,
`signature_invalid`, `signature_mismatch`, `meta_missing`, `rpc_unreachable`, `rpc_error`, `tx_not_found`, `tx_failed`, `no_memo`, `multiple_memos`,
`signer_mismatch`, and with `verifySignature`: `tx_undecodable`, `bad_signature`, `tx_mismatch`. From `checkEquivocation`: `input_invalid`, `rpc_url_invalid`, `rpc_unreachable`, `rpc_error`,
`scan_incomplete` (never answered with `none` or `unique` from a partial history). `checkEquivocation` also returns
`scan_incomplete` when the RPC's `getSignaturesForAddress` entries leave out the `memo` field (or report something
other than a string or `null`): without it the scan cannot tell which transactions to read, and reading every one would
cost up to `maxSignatures` requests. Earlier builds read every such transaction one by one; use an RPC that reports
memos (standard Solana RPC nodes do).

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
