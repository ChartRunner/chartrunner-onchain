import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cupLeavesFromStandings } from "./leaves.ts";
import { anchorStanding, checkEquivocation, DEFAULT_MAX_SIGNATURES, type AnchorStanding, type EquivocationResult } from "./equivocation.ts";
import { fetchMemo, type SignatureCheck } from "./rpc.ts";
import { verifyAgainstMemo, type VerifyResult } from "./verify.ts";
import type { ProofStep } from "./merkle.ts";
import { ANCHOR_KINDS, isKind, isOperatorKind, type AnchorKind } from "./kinds.ts";
import { base58Decode } from "./sigcheck.ts";

// chartrunner-verify: exit 0 verified, 1 the data does not match the anchor, 2 usage or environment error, or a check
// that was not performed (bad input, RPC outage, no Ed25519 for --verify-signature, ...).

/** Environment variable read for the RPC URL when --rpc is not given (keeps a keyed URL out of shell history). */
export const RPC_URL_ENV = "CHARTRUNNER_RPC_URL";

export const USAGE = `chartrunner-verify: check a ChartRunner result against its on-chain anchor

  chartrunner-verify --rows results.json --sig <txsig> --rpc <url> --signer <address>
  CHARTRUNNER_RPC_URL=<url> chartrunner-verify --rows results.json --sig <txsig> --signer <address>
  chartrunner-verify --rows results.json --memo "<memo text>"          (offline)
  chartrunner-verify --proof proof.json  --memo "<memo text>"          (one entry + Merkle proof, offline)
  chartrunner-verify --proof proof.json  --sig <txsig> --rpc <url> --signer <address>

  --rows <file>     JSON: an array of rows, {"rows":[...]}, or a cup results document ({"cupId","results":{"standings":[...]}})
  --proof <file>    JSON: {"leaf":"<canonical json>","proof":[{"side":"L|R","hash":"<hex>"}]} (the app's /api/anchors/proof response works)
  --sig <txsig>     anchor transaction signature; requires --rpc (or CHARTRUNNER_RPC_URL) and --signer
  --rpc <url>       Solana JSON-RPC endpoint you trust (no default). Without --rpc, the CHARTRUNNER_RPC_URL
                    environment variable is used, which keeps a URL with an API key out of shell history;
                    --rpc overrides it
  --memo <text>     the memo text as shown on a Solana explorer (offline)
  --signer <addr>   required with --sig (anyone can post a memo): the published operator address
                    (fee payer) for operator kinds, or the wallet that must have signed for user kinds;
                    must be a base58 32-byte address (a typo is a usage error, exit 2, not a mismatch)
  --kind / --id     also require the memo to be for this kind / id
  --verify-signature   with --sig: also fetch the wire transaction and verify its Ed25519 signatures locally
                       (then memo, fee payer and signers come from the signed bytes, not the RPC's word). In a
                       runtime without WebCrypto Ed25519 the check cannot run: exit 2, never a pass
  --check-equivocation with --sig, operator kinds: scan the operator's finalized history (SPEC 2.5). The first
                       finalized operator anchor for the kind/id wins: if another anchor has a different root or
                       count, the checked one passes only if it has the first finalized anchor's root and count
                       (with a loud warning) and fails (exit 1) otherwise; a duplicate (same root and count) is a
                       warning; a scan that cannot complete, or does not find the checked transaction, is an
                       error (exit 2), never a pass
  --max-signatures <n> with --check-equivocation: how many operator signatures to read at most, a plain decimal
                       integer >= 1 (default ${DEFAULT_MAX_SIGNATURES})
  --json            print the result as JSON
  -h, --help

exit codes: 0 verified; 1 the data does not match (tampering or mismatch); 2 usage or environment error,
or a check that was not performed`;

/**
 * Reasons that mean "the data does not match the anchor": exit 1. Everything else (bad input, RPC outage, a check that
 * could not run) is exit 2. rows_invalid / leaf_invalid are input errors (2): nothing was compared. bad_signature /
 * tx_mismatch are mismatches (1): the RPC served data that the signed bytes contradict.
 */
const MISMATCH = new Set([
  "root_mismatch",
  "count_mismatch",
  "proof_invalid",
  "memo_subject_mismatch",
  "signer_mismatch",
  "memo_malformed",
  "tx_failed",
  "no_memo",
  "multiple_memos",
  "equivocation",
  "bad_signature",
  "tx_mismatch",
]);

/** Exit code for a result: 0 verified, 1 the data does not match the anchor, 2 anything that prevented a verdict. */
export const exitCodeFor = (r: { ok: boolean; reason?: string }): 0 | 1 | 2 => (r.ok ? 0 : MISMATCH.has(r.reason ?? "") ? 1 : 2);

interface Args {
  rows?: string;
  proof?: string;
  sig?: string;
  rpc?: string;
  memo?: string;
  signer?: string;
  kind?: string;
  id?: string;
  json: boolean;
  help: boolean;
  verifySignature: boolean;
  checkEquivocation: boolean;
  "max-signatures"?: string;
}

function parseArgs(argv: string[]): Args | string {
  const out: Args = { json: false, help: false, verifySignature: false, checkEquivocation: false };
  const valued = new Set(["rows", "proof", "sig", "rpc", "memo", "signer", "kind", "id", "max-signatures"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--verify-signature") out.verifySignature = true;
    else if (a === "--check-equivocation") out.checkEquivocation = true;
    else if (a.startsWith("--") && valued.has(a.slice(2))) {
      const v = argv[++i];
      if (v === undefined) return `${a} needs a value`;
      (out as unknown as Record<string, unknown>)[a.slice(2)] = v;
    } else return `unknown argument: ${a}`;
  }
  return out;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

type Loaded = { rows: Record<string, string | number | boolean | null>[] } | { leaf: string; proof: ProofStep[] };

async function loadRows(file: string): Promise<Loaded> {
  const data = readJson(file) as any;
  if (Array.isArray(data)) return { rows: data };
  if (data && Array.isArray(data.rows)) return { rows: data.rows };
  const standings = data?.results?.standings ?? data?.standings;
  if (data && typeof data.cupId === "string" && Array.isArray(standings)) return { rows: await cupLeavesFromStandings(data.cupId, standings) };
  throw new Error("rows file must be an array of rows, {rows:[...]}, or a cup results document");
}

function loadProof(file: string): Loaded {
  const data = readJson(file) as any;
  if (!data || typeof data.leaf !== "string" || !Array.isArray(data.proof)) throw new Error("proof file needs a string `leaf` and a `proof` array");
  return { leaf: data.leaf, proof: data.proof };
}

/** True for a base58 string that decodes to exactly 32 bytes (a Solana address). */
function isAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  return base58Decode(s)?.length === 32;
}

/**
 * Run the CLI. Returns the exit code; writes to stdout/stderr via the given sinks (defaults: console). `env` supplies
 * CHARTRUNNER_RPC_URL (default: process.env).
 */
export async function main(
  argv: string[],
  io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => console.log(s), err: (s) => console.error(s) },
  env: Record<string, string | undefined> = process.env,
): Promise<0 | 1 | 2> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(`error: ${args}\n\n${USAGE}`);
    return 2;
  }
  // --rpc overrides the environment; an empty variable counts as unset.
  if (args.rpc === undefined && args.sig !== undefined && env[RPC_URL_ENV]) args.rpc = env[RPC_URL_ENV];
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  if ((args.rows === undefined) === (args.proof === undefined)) {
    io.err(`error: give exactly one of --rows or --proof\n\n${USAGE}`);
    return 2;
  }
  if ((args.sig === undefined) === (args.memo === undefined)) {
    io.err(`error: give exactly one of --sig (with --rpc) or --memo\n\n${USAGE}`);
    return 2;
  }
  if (args.sig !== undefined && args.rpc === undefined) {
    io.err(`error: --sig needs --rpc <url> or ${RPC_URL_ENV} (there is no default RPC)`);
    return 2;
  }
  if (args.sig !== undefined && args.signer === undefined) {
    io.err("error: --sig needs --signer <operator address>. Anyone can post a memo for any id, so a root match alone does not show ChartRunner anchored it.");
    return 2;
  }
  if (args.signer !== undefined && !isAddress(args.signer)) {
    io.err("error: --signer must be a base58 Solana address (32 bytes). Check it for a typo: this is a usage error, not a mismatch.");
    return 2;
  }
  const rawMax = args["max-signatures"];
  // Plain decimal only: Number() would also accept "1e3", "0x10", " 10" or "10.0".
  const maxSignatures = rawMax === undefined ? DEFAULT_MAX_SIGNATURES : /^[1-9][0-9]*$/.test(rawMax) ? Number(rawMax) : NaN;
  if (!Number.isSafeInteger(maxSignatures) || maxSignatures < 1) {
    io.err("error: --max-signatures must be a positive decimal integer (digits only)");
    return 2;
  }
  if (args["max-signatures"] !== undefined && !args.checkEquivocation) {
    io.err("error: --max-signatures only applies with --check-equivocation");
    return 2;
  }
  if ((args.verifySignature || args.checkEquivocation) && args.sig === undefined) {
    io.err("error: --verify-signature and --check-equivocation read the chain: they need --sig, --rpc and --signer");
    return 2;
  }
  if (args.kind !== undefined && !isKind(args.kind)) {
    io.err(`error: --kind must be one of ${ANCHOR_KINDS.join(", ")}`);
    return 2;
  }

  let loaded: Loaded;
  try {
    loaded = args.rows !== undefined ? await loadRows(args.rows) : loadProof(args.proof!);
  } catch (e) {
    io.err(`error: could not read input: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  let memoText = args.memo; // exact text: no trimming, same strictness as parseMemoStrict
  let chain: Chain | undefined;
  if (args.sig !== undefined) {
    const got = await fetchMemo(args.sig, { rpcUrl: args.rpc!, expectSigner: args.signer, verifySignature: args.verifySignature });
    if (!got.ok) return report(io, args.json, { ok: false, reason: got.reason, message: got.message }, undefined);
    if (args.verifySignature && got.signatureCheck !== "verified") {
      // Requested but not performed (no WebCrypto Ed25519 here): never report that as verified.
      return report(
        io,
        args.json,
        { ok: false, reason: "signature_unverified", message: "--verify-signature was requested, but this runtime has no WebCrypto Ed25519, so the signatures were NOT checked. Use a runtime with Ed25519, or drop --verify-signature to rely on the RPC's answer." },
        undefined,
      );
    }
    memoText = got.memo;
    chain = { feePayer: got.feePayer, slot: got.slot, signatureCheck: got.signatureCheck, warnings: [] };
  }

  const expect = { ...(args.kind ? { kind: args.kind as AnchorKind } : {}), ...(args.id ? { id: args.id } : {}) };
  const result = await verifyAgainstMemo({ ...loaded, memoText: memoText!, expect } as Parameters<typeof verifyAgainstMemo>[0]);
  if (!result.ok || !args.checkEquivocation || !chain) return report(io, args.json, result, chain);

  // SPEC 2.5: the first finalized operator memo for this kind/id wins. Is the checked one it?
  const kind = result.memo.kind;
  if (!isOperatorKind(kind)) return report(io, args.json, { ok: false, reason: "input_invalid", message: "--check-equivocation applies to operator kinds only." }, chain);
  const eq = await checkEquivocation({ rpcUrl: args.rpc!, operator: args.signer!, kind, id: result.memo.id, maxSignatures });
  chain.equivocation = eq;
  if (!eq.ok) {
    return report(io, args.json, { ok: false, reason: "equivocation_unchecked", message: `The root matches, but uniqueness was NOT checked (${eq.reason}): ${eq.message}` }, chain);
  }
  // The checked transaction must be among the anchors the completed scan found; otherwise the scan says nothing about it.
  const st = anchorStanding(eq, { signature: args.sig!, slot: chain.slot, blockTime: null, memo: memoText!, root: result.memo.root, count: result.memo.count });
  chain.equivocation = st.result;
  chain.standing = st.standing;
  if (st.standing === "not_in_scan") {
    return report(
      io,
      args.json,
      { ok: false, reason: "equivocation_unchecked", message: `The root matches, but uniqueness was NOT checked: the scan of the operator's history (${eq.scanned} signatures) did not find this transaction. Retry later, or use an RPC that serves full history.` },
      chain,
    );
  }
  if (!st.pass) {
    const list = st.result.anchors.map((a) => `${a.signature} slot ${a.slot ?? "?"} root ${a.root} count ${a.count}`).join("; ");
    const why = st.winner ? `the first finalized anchor is ${st.winner.signature}` : "two different anchors share the lowest slot, so none wins";
    return report(io, args.json, { ok: false, reason: "equivocation", message: `The operator anchored ${kind} ${result.memo.id} more than once with different roots or counts, and this is not the anchor that counts (${why}): ${list}` }, chain);
  }
  const w = standingWarning(st);
  if (w) chain.warnings.push(w);
  return report(io, args.json, result, chain);
}

interface Chain {
  feePayer: string | null;
  slot: number | null;
  signatureCheck: SignatureCheck;
  equivocation?: EquivocationResult;
  standing?: AnchorStanding["standing"];
  warnings: string[];
}

function standingWarning(st: AnchorStanding): string | null {
  if (st.standing === "duplicate") return `the operator anchored this kind/id ${st.count} times with the same root and count (duplicate); the first finalized is ${st.first?.signature ?? "unknown"}`;
  if (st.standing === "equivocation_first") {
    const which = st.isWinner ? "This anchor is the first finalized one" : `This anchor has the same root and count as the first finalized one (${st.winner.signature})`;
    return `EQUIVOCATION: the operator also anchored this kind/id with a different root or count (${st.others.filter((a) => a.root !== st.winner.root || a.count !== st.winner.count).map((a) => `${a.signature} root ${a.root} count ${a.count}`).join("; ")}). ${which}, so it is the result that counts; the different later ones are void.`;
  }
  return null;
}

function report(io: { out: (s: string) => void; err: (s: string) => void }, json: boolean, r: VerifyResult | { ok: false; reason: string; message: string }, chain?: Chain): 0 | 1 | 2 {
  const code = exitCodeFor(r);
  if (json) io.out(JSON.stringify({ ...r, ...(chain ? { chain } : {}), exitCode: code }));
  else if (r.ok) {
    io.out(`VERIFIED  ${r.memo.kind} ${r.memo.id}: ${r.mode === "rows" ? `${r.memo.count} rows rebuild` : "entry is committed by"} root ${r.root}`);
    if (chain) {
      io.out(`          paid by ${chain.feePayer ?? "unknown"}${chain.slot !== null ? `, slot ${chain.slot}` : ""}`);
      if (chain.signatureCheck === "verified") io.out("          signatures verified locally over the transaction bytes");
      if (chain.standing === "sole" && chain.equivocation?.ok) io.out(`          only operator anchor for this kind/id (${chain.equivocation.scanned} signatures scanned)`);
    }
  } else io.err(`${code === 1 ? "MISMATCH" : "ERROR"}  ${r.reason}: ${r.message}`);
  for (const w of chain?.warnings ?? []) io.err(`WARNING   ${w}`);
  return code;
}

/** True when this module is the process entry point (`node dist/cli.js ...`), not when it is imported (bin, tests). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(`ERROR  unexpected: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}
