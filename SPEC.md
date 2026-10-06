# ChartRunner on-chain anchor format, v1

Status: **frozen**. Anchors in this format are on Solana and cannot be changed, so nothing in this document that
affects bytes on chain or hashes may change. Section 9 describes how the format may grow.

This document is derived from the reference implementation in [`packages/verify`](packages/verify) (the same code the
ChartRunner app runs to build and check anchors). If this document and that code ever disagree, the code that produced
the anchors already on chain is the ground truth, and this document is the bug. The golden vectors in
[`test-vectors/v1.json`](test-vectors/v1.json) pin the behavior byte for byte.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Overview

ChartRunner commits to a frozen result set (one Trading Cup, or one UTC day of a leaderboard) by writing a single
line of text to Solana with the SPL Memo program:

```
chartrunner:v1:<kind>:<id>:<root>:<count>
```

`root` is the root of a Merkle tree over the result rows, `count` the number of rows. There is no custom on-chain
program. Every kind has a signer model (2.2): result sets (cups, leaderboard days) are authenticated by the
transaction's fee payer, which is ChartRunner's published operator address (2.6); planned user kinds (maps, strategies,
bots, backtests) are authenticated by the user's own wallet signing the transaction.

Anyone holding the rows (or a single row and its Merkle proof) can recompute the root and compare it with the memo,
without trusting the ChartRunner server.

## 2. The memo

### 2.1 Grammar

The memo is the UTF-8 data of one SPL Memo instruction. It MUST match this regular expression exactly, over the whole
string, with no trimming or normalization of any kind:

```
^chartrunner:v1:([a-z]+):([A-Za-z0-9._-]{1,64}):([0-9a-f]{64}):([1-9][0-9]{0,8})$
```

and the first group MUST be one of the kinds in the registry (2.2). For a kind whose count rule is "one" (every user
kind), the count MUST be exactly `1`.

| field   | rule |
| ------- | ---- |
| prefix  | the literal `chartrunner:v1:` (lowercase, version `v1`) |
| `kind`  | one of the kinds in the registry (2.2) |
| `id`    | 1 to 64 characters from `A-Z a-z 0-9 . _ -` (no `:`, no whitespace). An identifier, never a free-text name |
| `root`  | the Merkle root, 64 lowercase hexadecimal characters (32 bytes) |
| `count` | the number of leaves, decimal, 1 to 999999999, no sign, no leading zeros; exactly `1` for user kinds |

A parser MUST reject anything else, including: leading or trailing whitespace or newline, an uppercase kind or root,
a shorter or longer root, a count of `0`, a count with a leading zero, a count of ten or more digits, a count other than
`1` for a user kind, an empty or over-long id, an id containing `:` or a space, extra or missing fields, any version
other than `v1`, and any other prefix. The longest valid memo is 163 bytes.

A writer MUST only emit text that this parser accepts and that formats back to the same text (the reference operator
code parses the memo, re-formats it, and refuses to sign unless the two are identical).

### 2.2 Kinds registry

Every kind is listed in a registry (`KINDS` in `packages/verify/src/kinds.ts`). Each entry declares its **signer
model**, its **leaf schema**, its **id**, and its **count rule**. A kind that is not in the registry is not a ChartRunner
anchor.

Signer models:

- `operator`: the transaction's fee payer is the published operator address (2.6). Operator kinds commit to a result
  set; `count` is the number of leaves.
- `user`: the user's own wallet is among the transaction's signers. User kinds commit to one entity: `id` is an opaque
  entity id (never a free-text name), `root` is a single-leaf root (the leaf hash of that entity's leaf, section 4) and
  `count` is always `1`. The fee payer may be someone else.

| kind       | signer   | `id`                | leaves                                                              | count | status |
| ---------- | -------- | ------------------- | ------------------------------------------------------------------- | ----- | ------ |
| `freeplay` | operator | `YYYY-MM-DD` (UTC)  | board leaf (7.1): best free-play run per player on that UTC day      | any   | active |
| `daily`    | operator | `YYYY-MM-DD` (UTC)  | board leaf (7.1): best run per player on that day's shared chart     | any   | active |
| `cup`      | operator | the cup id          | cup leaf (7.2): one per final standing                               | any   | active |
| `xp`       | operator | not defined yet     | XP ledger daily totals, schema not defined yet                       | any   | reserved |
| `map`      | user     | opaque entity id    | one entity leaf, schema not defined yet                              | 1     | planned |
| `strategy` | user     | opaque entity id    | one entity leaf, schema not defined yet                              | 1     | planned |
| `bot`      | user     | opaque entity id    | one entity leaf, schema not defined yet                              | 1     | planned |
| `backtest` | user     | opaque entity id    | one entity leaf, schema not defined yet                              | 1     | planned |

Status: `active` kinds are produced today. `reserved` and `planned` kinds are accepted by the grammar but not produced
yet; their leaf schema (and, for `xp`, its id) is specified here and frozen before the first mainnet anchor of that kind
(section 9). Until then nobody can rebuild such a root from data, so a verifier can check only the memo, the signer and
a leaf-plus-proof that the caller already holds.

A day board is anchored only after its UTC day has ended. A cup is anchored after its results are frozen.

The pair (`kind`, `id`) names the snapshot. Verifiers SHOULD pin both (the reference verifier's `expect` option and the
CLI's `--kind` / `--id`) so that a valid memo for one snapshot cannot be presented as the anchor of another.

### 2.3 Transaction

- Program: the SPL Memo program, **`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`**. Instructions of any other memo
  program (including the legacy Memo v1 program) are not anchors.
- The memo instruction carries no accounts. It is authenticated by the transaction's signers: for an operator kind the
  fee payer MUST be the operator address ChartRunner publishes; for a user kind the user's wallet MUST be among the
  signers.
- Transactions written by the operator contain exactly one Memo instruction plus, optionally, two ComputeBudget
  instructions (`SetComputeUnitLimit`, `SetComputeUnitPrice`), and nothing else: one signer (the fee payer), no other
  programs, no account references, no address lookup tables. This is a property of the writer. The reference verifier
  does not reject a transaction for carrying other instructions; it requires exactly one Memo instruction (2.4).

### 2.4 Verification rules (on chain)

A verifier reading an anchor transaction from an RPC node MUST apply all of the following. The reference implementation
is `fetchMemo` / `verifyAgainstSignature` in `packages/verify/src/rpc.ts`.

1. **The caller chooses the RPC.** There is no default endpoint. Use an RPC you trust for the cluster the anchor lives on.
2. **Commitment.** Read the transaction at `finalized` (the default) or, if the caller accepts rollback risk,
   `confirmed`. Nothing below those levels counts. (The operator marks its own anchor confirmed when the signature
   status is `confirmed` or `finalized` with no error.)
3. **Right transaction.** The returned transaction's first signature MUST equal the signature that was requested.
4. **Executed successfully.** Execution metadata MUST be present and `meta.err` MUST be `null`. Missing metadata is
   a failure, never a success.
5. **Exactly one memo.** The transaction MUST contain exactly one instruction of the Memo program in 2.3, counting
   every such instruction whether or not the RPC could parse its data, and that one instruction's parsed data MUST be a
   string. Zero (or one that is not readable text) is `no_memo`; more than one is `multiple_memos`. A verifier MUST NOT
   pick "the first" memo of a transaction that has several.
6. **Signer, by the kind's signer model.** Anyone can post a memo with any text, so a root match without this check
   proves nothing.
   - Operator kinds, and any text that is not a valid `chartrunner:v1` memo: the fee payer (`accountKeys[0]`) MUST
     equal the published operator address (2.6). Another account co-signing is not enough.
   - User kinds: the expected wallet MUST be among the transaction's signers, read from the signer flags of the
     `jsonParsed` account keys. Account keys without signer flags prove only the fee payer.

   The reference CLI refuses to run an on-chain check without `--signer`. The library's `expectSigner` option applies
   exactly this rule; it is optional only so that a caller can compare the returned `feePayer` / `signers` itself. A
   caller that does neither has not verified anything.
7. **Strict parse.** The memo text MUST pass the grammar in 2.1 exactly as stored on chain.
8. **Then** run the offline checks in section 6 against that memo.
9. **Equivocation (operator kinds).** A single transaction cannot show that it is the only anchor for its (kind, id).
   A verifier that needs that assurance runs the scan in 2.5 and applies its rule to the transaction in hand
   (reference CLI: `--check-equivocation`, limit `--max-signatures`). When another anchor has a different root or
   count, a checked anchor that does not match the first finalized anchor's root and count is a mismatch (exit `1`),
   and one that matches passes with a prominent warning; a duplicate passes with a warning; a scan that could not
   complete, or that did not find the checked transaction, is an error (exit `2`) and the result MUST be presented as
   "root verified, uniqueness not checked", never as plainly verified.
10. **Local signature check (optional, recommended where available).** Rules 3 to 6 take the RPC's word for the
   transaction's contents. A verifier MAY also fetch the wire transaction (`encoding: "base64"`), verify every required
   Ed25519 signature over the message bytes itself, and require the signed bytes to carry the requested signature, the
   same fee payer, the same signers and exactly one Memo instruction with the same text. A mismatch (`tx_mismatch`),
   an invalid signature (`bad_signature`) or undecodable bytes (`tx_undecodable`) MUST fail. Execution status
   (`meta.err`) is not signed and still comes from the RPC. A runtime without Ed25519 MUST report the check as not
   performed, never as passed. Reference: `fetchMemo(..., { verifySignature: true })` (`signatureCheck`:
   `verified` / `unsupported` / `not_requested`), `sigcheck.ts`, CLI `--verify-signature`.

**An outage is not an answer.** Any RPC failure (unreachable, HTTP error, JSON-RPC error, unreadable body, transaction
not found) MUST be reported as an error with a reason. It MUST NOT be reported as "verified", and it MUST NOT be read as
"there is no anchor" or as an empty result. The reference CLI exits `2` for these, `1` for a mismatch, `0` only when
verified.

### 2.5 Equivocation: the first finalized operator memo wins

For an operator kind, the anchor of a (kind, id) on a cluster is the **first finalized** transaction (lowest slot) that
passes 2.4 rules 3 to 7 with the fee payer equal to the operator address. Any later operator memo for the same (kind, id)
is void, whatever it says.

The operator's writer is idempotent per (kind, id, cluster) and never sends a second anchor on purpose. If one exists
anyway:

- same root and count as the first: a **duplicate**. Harmless, but it should not happen.
- a different root or count: **equivocation**. The operator committed to two different result sets under one name.
  Verifiers SHOULD report it prominently, and the first finalized memo still wins.
- two different memos in the same lowest slot: equivocation with **no winner**, since slot order cannot decide.

Applied to one transaction being verified (the "checked" anchor), the verifier looks it up among the anchors a
completed scan found, by signature, and uses the scan's own reading of it (its slot comes from the scan's finalized
read, never from whoever supplied the signature). Then:

| situation | verdict |
| --------- | ------- |
| the scan could not complete, or completed without finding the checked transaction (or read other content for it) | not a pass: "root verified, uniqueness not checked" (the checked anchor is never added to the scan's result by hand) |
| it is the only anchor | pass |
| others with the same root and count (duplicate) | pass, with a warning naming the first finalized |
| others with a different root or count, and it has the same root and count as the first finalized (it is that anchor, or a duplicate of it) | pass, with a prominent equivocation warning: that result counts, the different later ones are void |
| others with a different root or count, and it does not match the first finalized (or there is no winner) | fail: this anchor is void |

The scan reads the history until the node returns an **empty** page; a page shorter than the requested limit is not the
end of history. A page whose cursor does not advance (its last signature was already seen) ends the scan as incomplete.
Anyone can send transactions to the operator address, so the history can be long; the reference default reads up to
100000 signatures and the limit is configurable.

The reference helper `checkEquivocation({ rpcUrl, operator, kind, id })` in `packages/verify/src/equivocation.ts`
pages through the operator address's finalized signature history (`getSignaturesForAddress`), skips failed
transactions and those whose reported memo does not name the (kind, id), re-reads every remaining candidate with the
rules in 2.4, and returns `none`, `unique`, `duplicate` or `equivocation` together with every anchor found and the
winner. A history it could not read completely (outage, pruned transaction, more signatures than its limit, a cursor that
does not advance) is a failure with a reason, never `none` or `unique`. `anchorStanding(result, checked)` applies the
table above to a checked anchor (`not_in_scan`, `sole`, `duplicate`, `equivocation_first`, `not_first`).

The rule covers operator kinds. For user kinds it is not defined yet; it will be specified with their leaf schemas.

### 2.6 Operator addresses

Verification is independent only if the operator address is published somewhere other than the app being checked.
This section is that place.

| cluster        | operator address                               | in effect from |
| -------------- | ---------------------------------------------- | -------------- |
| `mainnet-beta` | `68tWAPfHGkfVzNK1D7PxzVrBrDbtiyqmW2wddwqEmVhy` | 2026-10-06     |
| `devnet`       | none: ChartRunner does not anchor on devnet     |                |

An address listed here is a public key only. Rotating the operator key adds a row with the date it took effect; old
rows stay, because anchors signed by an earlier key remain valid. The private key is never in this repository.

## 3. Canonical row serialization

Each result row is a flat JSON object. Its canonical text is what gets hashed.

- Values MUST be one of: a string, a boolean, `null`, or a number that is a safe integer
  (`-(2^53 - 1)` to `2^53 - 1`). Floats, `NaN`, infinities, unsafe integers, objects, arrays and `undefined` MUST be
  rejected. Money and percentages are therefore carried as fixed-decimal strings (for example `"10500.123457"`).
- Keys are sorted ascending by **UTF-16 code unit** (the default JavaScript string sort). This differs from Unicode
  code point order for characters outside the Basic Multilingual Plane: `"😀"` (U+1F600, code units D83D DE00) sorts
  before `"～"` (U+FF5E). The vectors include this case.
- Output is `{` + `"key":value` pairs joined by `,` + `}`, with no whitespace anywhere.
- Keys and string values are encoded exactly as ECMAScript `JSON.stringify` encodes a string: `"` and `\` are escaped
  as `\"` and `\\`; U+0008, U+0009, U+000A, U+000C, U+000D as `\b`, `\t`, `\n`, `\f`, `\r`; every other code point
  below U+0020 as `\u00xx` with lowercase hex; lone surrogates as `\udxxx` with lowercase hex; everything else
  (including U+007F, U+2028, U+2029 and all non-ASCII) literally, encoded as UTF-8.
- Integers are written in plain decimal, with a leading `-` when negative and no exponent. `-0` is written `0`.

Example: `{"s": 1, "id": "a"}` serializes to `{"id":"a","s":1}`.

## 4. Merkle tree

```
leaf_hash = SHA-256( 0x00 || UTF-8(canonical_row_text) )
node_hash = SHA-256( 0x01 || left || right )        left and right are the raw 32-byte child hashes
```

1. Serialize each row (section 3) and compute its leaf hash.
2. Reject an empty set. There is no anchor of zero rows.
3. Sort the leaves ascending by leaf hash (lowercase hex comparison, which equals byte-wise comparison).
4. Reject the set if two leaves have the same hash. Two rows that differ only in key order are the same row.
5. Build levels bottom up. Pair nodes left to right; a pair becomes `node_hash(left, right)`. If a level has an odd
   number of nodes, the last one is **promoted unchanged** to the next level (never duplicated, never hashed alone).
6. The root is the single node left. A one-row tree's root is that row's leaf hash.

The `0x00` / `0x01` prefixes separate leaves from inner nodes, so an inner node can never be presented as a leaf.
Sorting makes the root independent of the order the rows are supplied in. Rejecting duplicates and promoting lone
nodes removes the duplicate-leaf ambiguity of trees that copy the last node.

The root does not hash the count in. The count is committed next to the root in the memo (section 5).

Informative: the operator also stores `leaves_hash = SHA-256( UTF-8( sorted leaf hashes as hex, joined by "\n" ) )` so
a data export can be checked cheaply. It is not on chain and not part of the anchor.

## 5. Count semantics

`count` is the number of distinct leaves in the tree.

- When verifying a full row set, the number of leaves rebuilt from the rows MUST equal `count`, and the rebuilt root
  MUST equal `root`. Adding, removing or changing any row changes the root; the reference verifier reports a root
  difference as `root_mismatch` before it compares counts (`count_mismatch`).
- When verifying one row with a proof, the proof MUST NOT have more than `ceil(log2(count))` steps (zero steps for
  `count = 1`).
- The count makes omission visible: the number of entries in a snapshot is fixed on chain. A player who cannot obtain a
  proof of their own row from a snapshot of `count` rows was left out, publicly.

The memo grammar allows up to 999999999. The reference operator caps a snapshot at 10000 leaves; that cap is an
operating limit, not part of the format.

## 6. Proofs and offline verification

A proof is an ordered list of steps from the leaf up to the root:

```json
{ "leaf": "<canonical row text>", "proof": [ { "side": "L", "hash": "<64 lowercase hex>" }, ... ] }
```

`side` is the side the **sibling** is on. Levels where the node was promoted contribute no step. Fold:

```
cur = leaf_hash(leaf)
for step in proof:
    cur = step.side == "L" ? node_hash(step.hash, cur) : node_hash(cur, step.hash)
verified  <=>  cur == root
```

`leaf` is hashed exactly as given. It MUST already be canonical text; a verifier MUST NOT re-serialize it. A step whose
`side` is not `L` or `R`, or whose `hash` is not 64 lowercase hex characters, makes the proof invalid.

Offline verification of a memo text against data:

1. Parse the memo strictly (2.1). If the caller pinned a kind or id, they MUST match.
2. Either rebuild the tree from all rows (section 4) and compare root and count (section 5), or fold one leaf through
   its proof (above), check the proof length bound, and compare with the root.

The memo text used offline MUST be taken exactly as stored on chain. The verifier MUST NOT trim it.

## 7. Leaf schemas (v1)

Raw account ids and handles never appear in a leaf. They are replaced by pseudonyms:

```
u (user)    = hex SHA-256( UTF-8( "chartrunner:user:"   + account id ) )
h (handle)  = hex SHA-256( UTF-8( "chartrunner:handle:" + lowercase(handle) ) )      handles are case-insensitive
r (run)     = hex SHA-256( UTF-8( "chartrunner:run:"    + run id ) )
```

These are plain SHA-256 (no `0x00` prefix). Lowercasing is JavaScript `toLowerCase()`.

### 7.1 Board leaf (`freeplay`, `daily`)

```json
{"d":"2026-10-02","dist":20,"h":"<hex>","k":"daily","r":"<hex>","rank":1,"s":90,"u":"<hex>","v":1}
```

| key    | value |
| ------ | ----- |
| `v`    | `1` |
| `k`    | the kind, `"freeplay"` or `"daily"` |
| `d`    | the UTC date, equal to the memo `id` |
| `rank` | standard competition rank by score (ties share a rank: 1, 2, 2, 4) |
| `u`    | user pseudonym |
| `h`    | handle pseudonym |
| `s`    | score (integer) |
| `dist` | distance (integer) |
| `r`    | run pseudonym |

One leaf per player: their best run of that day (highest score; the earliest run wins a tie).

### 7.2 Cup leaf (`cup`)

```json
{"dq":false,"eq":"10500.123457","fh":"<hex>","h":"<hex>","id":"<cup id>","k":"cup","pct":"5.0012","rank":1,"tr":2,"u":"<hex>","v":1}
```

| key    | value |
| ------ | ----- |
| `v`    | `1` |
| `k`    | `"cup"` |
| `id`   | the cup id, equal to the memo `id` |
| `rank` | the standing's rank in the frozen results |
| `u`    | user pseudonym of the account |
| `h`    | handle pseudonym of the displayed name |
| `eq`   | final equity, the results document's fixed-decimal string, verbatim |
| `pct`  | return in percent, the results document's fixed-decimal string, verbatim |
| `tr`   | number of exits (integer) |
| `dq`   | the host's disqualification flag (boolean) |
| `fh`   | `fillsHash` of the standing: the hash of the player's validated fills |

One leaf per standing, built from the frozen results document only (never from live data). `cupLeavesFromStandings`
reads exactly the fields `rank, userId, name, equity, pnlPct, trades, disqualified, fillsHash` from each standing and
ignores every other field.

Because a leaf includes its kind and id (`k` and `d`, or `k` and `id`), a leaf from one snapshot does not hash the same
as a leaf from another.

## 8. What an anchor proves, and what it does not

It proves:

- The rows you hold (all of them, or one row and its proof) are exactly the rows whose root was written in that
  transaction. Any edit, addition or removal changes the root.
- The transaction succeeded, carries exactly one anchor memo, and was signed as its kind requires: paid by the operator
  address you checked for an operator kind, signed by the wallet you checked for a user kind (section 2.4). Only then
  does it say anything about ChartRunner or that user.
- The snapshot existed no later than the transaction's slot, and the operator cannot later swap it for another
  without that swap being visible against the original transaction.

It does not prove:

- **Fair play or fair fills.** The anchor proves the published standings were not changed after anchoring. It does not
  prove the game server's rules, prices, fills or scoring were correct beyond what the server checked before it
  anchored. A self-consistent but wrong snapshot anchors and verifies like a correct one.
- **The fills themselves.** `fh` commits each cup standing to a hash of its fills, so a published fills list can be
  checked for consistency with the standing. That is a consistency check, not proof of fair execution.
- **The cup results document as a whole.** The app also publishes `results_hash`, the SHA-256 of a cup's canonical
  results text. That hash is not on chain. Fields of the results document that are not in the cup leaf (section 7.2)
  are not covered by the anchor. In particular, the `final` block of a final-stage cup (`qualifierId`, the
  `finalists` in seed order, `pickedByHost`) is covered by `results_hash` but **not** by the Merkle anchor, whose leaves
  are the standings only.
- **Completeness by itself.** The root does not stop the operator from leaving a player out before anchoring. The
  on-chain count makes the number of entries public, and an excluded player can show they have no proof (section 5).
- **Who the operator is.** The verifier checks the fee payer against an address you supply. Take it from section 2.6
  or ChartRunner's published documentation, not from the same place as the data you are checking.
- **That this is the only anchor.** One transaction cannot show that no other operator memo exists for its (kind, id).
  Run the equivocation scan (2.5) when that matters.
- **Anything about a source you do not trust.** If the memo text, the signature or the RPC come from an untrusted
  source, so does the answer. Use your own RPC or an explorer you trust.
- **Privacy.** Pseudonyms hide raw ids, but a handle is public, so anyone can test whether a known handle matches `h`.
- **Late data.** A run submitted after its day was anchored is not in that day's snapshot.

## 9. Versioning policy

- Everything in format v1 (memo grammar, canonical serialization, hashing, tree construction, proof shape, the
  pseudonym derivations and the leaf schemas of the produced kinds) is frozen forever once any anchor using it is on
  mainnet. Old anchors must stay verifiable with the same code.
- The kinds registry (2.2) only grows. A kind is never removed, renamed, or given a different signer model, id or leaf
  schema once it has an anchor on mainnet.
- A new kind is a deliberate, documented change: it is added to the registry with its signer model, its `id`, its count
  rule and its leaf schema, and vectors are appended to `test-vectors/v1.json` before the first anchor of that kind is
  written. Adding a kind does not change any existing anchor. The `reserved` and `planned` kinds already in the registry
  get their leaf schemas the same way, frozen with their first mainnet anchor.
- Any change to hashing, serialization or the memo grammar requires a new version prefix (`chartrunner:v2:`) with its
  own specification and vectors. Verifiers keep accepting `v1` unchanged.
- Existing entries in `test-vectors/v1.json` are never edited, only appended to. The ChartRunner app checks the same
  file, pinned by its SHA-256 (see the repository README), so the public SDK and the app cannot drift apart silently.

## 10. Legacy: the `cr1:` memo format

`cr1:` is the memo format of the earlier ChartRunner app. It is **frozen, legacy and read-only**: existing `cr1:` memos
stay readable, nothing new is written in it, and it gets no new kinds. New anchors, including maps, use
`chartrunner:v1` (the `map` user kind in 2.2).

```
cr1:<kind>:<name>:<hash-hex>
```

| field      | rule (as the legacy reader has always parsed it) |
| ---------- | ------------------------------------------------ |
| prefix     | the literal `cr1` |
| `kind`     | `map`, the only legacy kind |
| `name`     | free text chosen by the user: not empty, at most 64 bytes of UTF-8, no `:` |
| `hash-hex` | the content hash, exactly 64 lowercase hex characters (32 bytes), no `0x` |

The text is split on `:` and MUST have exactly four fields; nothing is trimmed. The legacy writer was stricter than this
reader (it also refused leading or trailing spaces and control characters in `name`), but the reader rule above is what
decides whether an existing memo is a legacy anchor. `parseLegacyCr1` in `packages/verify/src/legacy.ts` implements it.

How it differs from `chartrunner:v1`:

| | `cr1:map:...` (legacy) | `chartrunner:v1:...` |
| --- | --- | --- |
| signed by | the user's wallet (it must be among the signers) | operator kinds: the operator as fee payer; user kinds: the user's wallet |
| name / id | free-text name | `id` grammar only, never free text |
| commits to | one content hash | a Merkle root plus its leaf count |
| status | frozen, read-only, no new kinds | current |

Legacy memos were written with the SPL Memo program in 2.3; the legacy reader also accepted instructions of the older
Memo v1 program. A display name taken from a `cr1:` memo is user-chosen text and MUST be shown as untrusted. A `cr1:`
memo is never a `chartrunner:v1` anchor: `parseMemo` rejects it, and `verifyAgainstMemo` reports `memo_malformed`.

## Appendix A. Reference implementation map

| concern | `packages/verify/src` |
| ------- | --------------------- |
| canonical JSON, leaf/node hashing, tree, proofs, memo grammar | `merkle.ts` |
| pseudonyms, board and cup leaf schemas | `leaves.ts` |
| offline verification and failure reasons | `verify.ts` |
| reading an anchor transaction over JSON-RPC, the rules in 2.4 | `rpc.ts` |
| wire-transaction decoding and local Ed25519 signature check (2.4 rule 10) | `sigcheck.ts` |
| command-line verifier and exit codes | `cli.ts` |
| kinds registry, signer models, id grammar | `kinds.ts` |
| equivocation scan (2.5) | `equivocation.ts` |
| legacy `cr1:` parser (section 10) | `legacy.ts` |
