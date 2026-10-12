# chartrunner-onchain

The specification and reference verifier for ChartRunner's on-chain result anchors.

ChartRunner writes one line to Solana for every frozen Trading Cup and every closed free-play or daily-chart leaderboard day:

```
chartrunner:v1:<kind>:<id>:<merkle root>:<row count>
```

This repository contains:

- [`SPEC.md`](SPEC.md): the exact format of that memo, the kinds registry and who must sign each kind, how rows are
  serialized and hashed into the Merkle root, the proof format, the rules a verifier must apply, the
  "first finalized memo wins" equivocation rule, where the operator addresses are published, and the legacy `cr1:`
  format.
- [`packages/verify`](packages/verify): `@chartrunner/verify`, a TypeScript library and CLI (`chartrunner-verify`) that
  recomputes the root from published rows and compares it with the memo. Zero runtime dependencies, ESM, runs in
  browsers and Node.
- [`test-vectors/v1.json`](test-vectors/v1.json): golden vectors (rows, leaves, roots, proofs, memos) that pin the
  format byte for byte.
- [`examples/`](examples): an offline verification you can run now, and a template for checking a devnet transaction.

Not in this repository: the archived v1 Anchor programs (devnet only, unaudited). Anchors do not use a custom program;
they are plain SPL Memo transactions.

## For the Colosseum jury

ChartRunner is a game-first trading terminal on Solana: a runner game on live candles, multiplayer rooms, timed paper-trading
Trading Cups, and non-custodial Jupiter spot swaps. The app itself (<https://app.chartrunner.xyz>) is closed source. This
repository is the part that is open on purpose: the format of the results ChartRunner writes to Solana mainnet, and the code
anyone can use to check them without trusting us.

What is live on mainnet today:

- Every finished Trading Cup and every closed free-play and daily-chart leaderboard day is anchored as one SPL Memo
  (the newer Daily Run and Daily Race boards are not anchored yet), signed by the published operator
  address `68tWAPfHGkfVzNK1D7PxzVrBrDbtiyqmW2wddwqEmVhy` ([SPEC.md section 2.6](SPEC.md#26-operator-addresses)).
  33 anchors (27 cups, 5 free-play boards, 1 daily board) were posted between 2026-10-06 and 2026-10-12. The full list is
  at <https://app.chartrunner.xyz/api/anchors?limit=100>.
- The app's `/verify` page runs the library in this repository in the browser.

Check a real cup yourself in about a minute (Node 24, pnpm 11, any mainnet RPC):

```sh
git clone https://github.com/ChartRunner/chartrunner-onchain.git && cd chartrunner-onchain
pnpm install && pnpm build
CUP=3277e988-3f27-4de1-9954-4f5681c34fbd   # "Pitch Demo Cup"
curl -s "https://app.chartrunner.xyz/api/cups/$CUP/results" > results.json
SIG=$(curl -s "https://app.chartrunner.xyz/api/anchors?kind=cup&id=$CUP" | jq -r '.anchors[0].signature')
node packages/verify/dist/cli.js --rows results.json --sig "$SIG" --rpc https://api.mainnet-beta.solana.com \
  --signer 68tWAPfHGkfVzNK1D7PxzVrBrDbtiyqmW2wddwqEmVhy --kind cup --id "$CUP" --verify-signature --check-equivocation
```

Expected output (exit code `0`):

```
VERIFIED  cup 3277e988-3f27-4de1-9954-4f5681c34fbd: 2 rows rebuild root c08eae042e433c371dbae5ae3bc1f1cbcc1e781814015e2c7e55cb7f5fc45c91
          paid by 68tWAPfHGkfVzNK1D7PxzVrBrDbtiyqmW2wddwqEmVhy, slot 455497319
          signatures verified locally over the transaction bytes
          only operator anchor for this kind/id (34 signatures scanned)
```

Change any `equity` value under `results.standings` in `results.json` and run the last command again: it prints
`MISMATCH  root_mismatch` and exits `1`. The public RPC above is rate-limited; any mainnet RPC works, and the result does
not depend on which one you pick.

This repository was started on 2026-10-06, inside the judged window. It contains no code from the earlier ChartRunner v1
(its archived devnet Anchor programs are not here and are not part of the submission).

## Why this is open

An anchor is only useful if someone other than ChartRunner can check it. Publishing the format and the verifier means
you can confirm that a result you saw was not edited after the fact, with code you can read, against a chain node you
choose. The ChartRunner app's own `/verify` page runs this same library, so what you run locally is what the app runs.

## Quickstart

Requirements: Node 24 (see `.node-version`) and pnpm 11 (the version is pinned in `package.json`). The package is not on
npm yet, so build it from this checkout:

```sh
git clone https://github.com/ChartRunner/chartrunner-onchain.git
cd chartrunner-onchain
pnpm install
pnpm build
pnpm examples          # offline: verifies examples/results.json against a memo, then shows two tampered inputs failing
```

### CLI

```sh
# Offline: the rows and the memo text you copied from a Solana explorer
node packages/verify/dist/cli.js --rows results.json --memo "chartrunner:v1:cup:<id>:<root>:<count>"

# One entry and its Merkle proof
node packages/verify/dist/cli.js --proof proof.json --memo "chartrunner:v1:cup:<id>:<root>:<count>"

# On chain: you supply the RPC and the published operator address (both required)
node packages/verify/dist/cli.js --rows results.json --sig <signature> --rpc <your rpc url> --signer <operator address>
```

Exit codes: `0` verified, `1` the data does not match the anchor, `2` anything that prevented a verdict (bad input,
RPC outage, transaction not found). An outage never exits `0`.

`results.json` may be an array of rows, `{"rows": [...]}`, or a cup results document
(`{"cupId": "...", "results": {"standings": [...]}}`), which is turned into leaves exactly as the app does.

### Library

```ts
import { cupLeavesFromStandings, verifyAgainstMemo, verifyAgainstSignature } from "@chartrunner/verify";

const rows = await cupLeavesFromStandings(cupId, results.standings);

// Offline, with the memo text from an explorer
const offline = await verifyAgainstMemo({ rows, memoText, expect: { kind: "cup", id: cupId } });

// On chain, with an RPC you choose (there is no default) and the published operator address
const onChain = await verifyAgainstSignature({ signature, rpcUrl, expectSigner: operatorAddress, rows });

if (!onChain.ok) console.log(onChain.reason); // e.g. "root_mismatch", "signer_mismatch", "rpc_unreachable"
```

Results never come back as a bare boolean: a failure always carries a `reason`. The full API is in the
[package README](packages/verify/README.md).

## What this does not prove

The anchor proves that the rows you hold are the rows ChartRunner committed to in that transaction, and that they
existed by that slot. It does not prove:

- that the game was played fairly, or that prices, fills and scoring were right beyond the server's own checks;
- anything about fields that are not in the leaves. For example, the `final` block of a final-stage cup (who qualified,
  whether the host overrode the default picks) is covered by the cup's `results_hash`, which is not on chain, and not by
  the Merkle anchor;
- that nobody was left out before anchoring (the row count is on chain, so an excluded player can show they have no
  proof, but the root alone does not prevent it);
- that the operator address you compared against is really ChartRunner's. Take it from
  [SPEC.md section 2.6](SPEC.md#26-operator-addresses) or the [documentation](https://docs.chartrunner.xyz), not from
  the same source as the data;
- that a transaction is the only anchor for its cup or day. `checkEquivocation` scans the operator's history for a
  second, different memo with the same kind and id (the first finalized one wins).

[SPEC.md section 8](SPEC.md#8-what-an-anchor-proves-and-what-it-does-not) has the full list.

## When not to use this

- To check whether a trade was executed fairly or at the right price. This verifies integrity of published results, not
  market execution.
- To verify `cr1:map:...` memos written by the earlier ChartRunner app as anchors. That legacy format is frozen and
  wallet-signed; `parseLegacyCr1` reads it, but it is not a `chartrunner:v1` anchor and the verifiers reject it (see
  [SPEC.md section 10](SPEC.md#10-legacy-the-cr1-memo-format)).
- For results that have not been anchored yet. A missing anchor is not a failed one; the app shows "not anchored yet".
- As a general Merkle or Solana memo library. The format is fixed to ChartRunner's v1 anchors and will not take options.
- If you only want a quick look: the live verifier at <https://app.chartrunner.xyz/verify> runs the same code in your
  browser.

## Security model

- This repository holds no keys and needs none. It only reads public data. The operator's public addresses are listed
  in [SPEC.md section 2.6](SPEC.md#26-operator-addresses). The mainnet operator is
  `68tWAPfHGkfVzNK1D7PxzVrBrDbtiyqmW2wddwqEmVhy`.
- The operator key that signs anchors is never in this repository, in its CI, or in the published package. The
  verifier only compares the fee payer of a transaction with an address you supply.
- The library has no default RPC endpoint and embeds no API keys. You pick the endpoint, so you decide whom to trust for
  chain data.
- Every RPC failure is a failure with a reason. The code never reports "verified" without having read and checked the
  memo, and never treats an outage as "no anchor".

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Keeping the app and this SDK in step

`test-vectors/v1.json` is generated from the spec by an independent implementation (`scripts/gen-vectors.mjs`, plain
`node:crypto`, no shared code). This package's tests check that the SDK reproduces every vector, CI checks that the file
still matches what the spec produces, and the ChartRunner app keeps a byte-identical copy, pinned by its SHA-256, that its
own anchoring code is tested against. A change on either side that alters a hash fails a test.

## Links

- Live verifier: <https://app.chartrunner.xyz/verify>
- Documentation: <https://docs.chartrunner.xyz>
- Specification: [SPEC.md](SPEC.md)

## Contributing

Bug reports, spec clarifications and verifier ports to other languages are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first: format v1 is frozen, so changes that would alter any hash, serialization or
memo text cannot be accepted.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
