import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cupLeavesFromStandings } from "./leaves.ts";
import { fetchMemo } from "./rpc.ts";
import { verifyAgainstMemo, type VerifyResult } from "./verify.ts";
import type { ProofStep } from "./merkle.ts";
import { ANCHOR_KINDS, isKind, type AnchorKind } from "./kinds.ts";

// chartrunner-verify: exit 0 verified, 1 the data does not match the anchor, 2 error (bad input, RPC outage, ...).

export const USAGE = `chartrunner-verify: check a ChartRunner result against its on-chain anchor

  chartrunner-verify --rows results.json --sig <txsig> --rpc <url> --signer <address>
  chartrunner-verify --rows results.json --memo "<memo text>"          (offline)
  chartrunner-verify --proof proof.json  --memo "<memo text>"          (one entry + Merkle proof, offline)
  chartrunner-verify --proof proof.json  --sig <txsig> --rpc <url> --signer <address>

  --rows <file>     JSON: an array of rows, {"rows":[...]}, or a cup results document ({"cupId","results":{"standings":[...]}})
  --proof <file>    JSON: {"leaf":"<canonical json>","proof":[{"side":"L|R","hash":"<hex>"}]} (the app's /api/anchors/proof response works)
  --sig <txsig>     anchor transaction signature; requires --rpc and --signer
  --rpc <url>       Solana JSON-RPC endpoint you trust (no default)
  --memo <text>     the memo text as shown on a Solana explorer (offline)
  --signer <addr>   required with --sig (anyone can post a memo): the published operator address
                    (fee payer) for operator kinds, or the wallet that must have signed for user kinds
  --kind / --id     also require the memo to be for this kind / id
  --json            print the result as JSON
  -h, --help

exit codes: 0 verified, 1 mismatch, 2 error`;

const MISMATCH = new Set(["root_mismatch", "count_mismatch", "proof_invalid", "memo_subject_mismatch", "signer_mismatch", "memo_malformed", "tx_failed", "no_memo", "multiple_memos"]);

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
}

function parseArgs(argv: string[]): Args | string {
  const out: Args = { json: false, help: false };
  const valued = new Set(["rows", "proof", "sig", "rpc", "memo", "signer", "kind", "id"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--json") out.json = true;
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

/** Run the CLI. Returns the exit code; writes to stdout/stderr via the given sinks (defaults: console). */
export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => console.log(s), err: (s) => console.error(s) }): Promise<0 | 1 | 2> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(`error: ${args}\n\n${USAGE}`);
    return 2;
  }
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
    io.err("error: --sig needs --rpc <url> (there is no default RPC)");
    return 2;
  }
  if (args.sig !== undefined && args.signer === undefined) {
    io.err("error: --sig needs --signer <operator address>. Anyone can post a memo for any id, so a root match alone does not show ChartRunner anchored it.");
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
  let chain: { feePayer: string | null; slot: number | null } | undefined;
  if (args.sig !== undefined) {
    const got = await fetchMemo(args.sig, { rpcUrl: args.rpc!, expectSigner: args.signer });
    if (!got.ok) return report(io, args.json, { ok: false, reason: got.reason, message: got.message }, undefined);
    memoText = got.memo;
    chain = { feePayer: got.feePayer, slot: got.slot };
  }

  const expect = { ...(args.kind ? { kind: args.kind as AnchorKind } : {}), ...(args.id ? { id: args.id } : {}) };
  const result = await verifyAgainstMemo({ ...loaded, memoText: memoText!, expect } as Parameters<typeof verifyAgainstMemo>[0]);
  return report(io, args.json, result, chain);
}

function report(io: { out: (s: string) => void; err: (s: string) => void }, json: boolean, r: VerifyResult | { ok: false; reason: string; message: string }, chain?: { feePayer: string | null; slot: number | null }): 0 | 1 | 2 {
  const code = exitCodeFor(r);
  if (json) io.out(JSON.stringify({ ...r, ...(chain ? { chain } : {}), exitCode: code }));
  else if (r.ok) {
    io.out(`VERIFIED  ${r.memo.kind} ${r.memo.id}: ${r.mode === "rows" ? `${r.memo.count} rows rebuild` : "entry is committed by"} root ${r.root}`);
    if (chain) io.out(`          paid by ${chain.feePayer ?? "unknown"}${chain.slot !== null ? `, slot ${chain.slot}` : ""}`);
  } else io.err(`${code === 1 ? "MISMATCH" : "ERROR"}  ${r.reason}: ${r.message}`);
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
