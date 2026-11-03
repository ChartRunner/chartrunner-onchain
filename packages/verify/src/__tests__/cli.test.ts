import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { battleLeaf, cupLeavesFromStandings, dailyRaceLeaf, dailyRunLeaf, formatMemo, merkleProof, merkleRoot } from "../index.ts";
import { exitCodeFor, main } from "../cli.ts";

const bin = new URL("../../bin/chartrunner-verify.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "cr-verify-cli-"));
const write = (name: string, v: unknown) => {
  const f = join(dir, name);
  writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
  return f;
};
// The child never inherits a CHARTRUNNER_RPC_URL from the developer's shell.
const childEnv = { ...process.env };
delete childEnv.CHARTRUNNER_RPC_URL;
const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: childEnv });
/** A syntactically valid address (32 bytes in base58); not anyone's operator. */
const ADDR = "So11111111111111111111111111111111111111112";

const rows = [{ id: "a", s: 1 }, { id: "b", s: 2 }, { id: "c", s: 3 }];

describe("chartrunner-verify CLI", async () => {
  const { root, count } = await merkleRoot(rows);
  const memo = formatMemo({ kind: "cup", id: "c1", root, count });
  const good = write("rows.json", rows);

  it("exits 0 when the rows match the memo (offline)", () => {
    const r = run("--rows", good, "--memo", memo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(root);
  });
  it("accepts {rows:[]} but does not trim the memo (strict, like parseMemoStrict)", () => {
    expect(run("--rows", write("w.json", { rows }), "--memo", memo).status).toBe(0);
    expect(run("--rows", write("w.json", { rows }), "--memo", `${memo}\n`).status).toBe(1);
    expect(run("--rows", write("w.json", { rows }), "--memo", ` ${memo}`).status).toBe(1);
  });
  it("accepts a cup results document", async () => {
    const standings = [{ rank: 1, userId: "u", name: "Al", equity: "1.0000", pnlPct: "0.0000", trades: 1, disqualified: false, fillsHash: "d".repeat(64) }];
    const leaves = await cupLeavesFromStandings("cup-9", standings);
    const m = await merkleRoot(leaves);
    const f = write("cup.json", { cupId: "cup-9", results: { standings } });
    expect(run("--rows", f, "--memo", formatMemo({ kind: "cup", id: "cup-9", root: m.root, count: m.count })).status).toBe(0);
  });
  it("verifies Daily Run and Daily Race board leaves, pinned with --kind / --id", async () => {
    const date = "2026-10-12";
    const run1 = await dailyRunLeaf(date, { rank: 1, userId: "u1", handle: "Al", runId: "r1", score: 50, distance: 9, hardcore: true, finished: true, createdAt: "" });
    const race1 = await dailyRaceLeaf(date, { rank: 1, userId: "u1", handle: "Al", runId: "r2", finishTick: 4000, distance: 60, hardcore: false, createdAt: "" });
    for (const [kind, leaf] of [["dailyrun", run1], ["dailyrace", race1]] as const) {
      const m = await merkleRoot([leaf]);
      const text = formatMemo({ kind, id: date, root: m.root, count: m.count });
      const f = write(`${kind}.json`, [leaf]);
      expect(run("--rows", f, "--memo", text, "--kind", kind, "--id", date).status).toBe(0);
      expect(run("--rows", f, "--memo", text, "--kind", kind === "dailyrun" ? "dailyrace" : "dailyrun").status).toBe(1);
    }
  });
  it("verifies battle leaves of one window, pinned with --kind / --id", async () => {
    const w = "2026-10-19T04";
    const base = { userId: "u1", name: "Al", equity: "10842.120000", pnlPct: "-8.4212", trades: 8, out: true, finished: false, fillsHash: "d".repeat(64) };
    const leaves = [
      await battleLeaf(w, { ...base, battleId: "3f2b9c1e-8d4a-4b6f-9e21-7c5d0a1b2e3f", rank: 1 }),
      await battleLeaf(w, { ...base, battleId: "a0c4e6f8-1b3d-4f5a-8c7e-9d0b2a4c6e81", rank: 2 }),
    ];
    const m = await merkleRoot(leaves);
    const text = formatMemo({ kind: "battle", id: w, root: m.root, count: m.count });
    const f = write("battle.json", leaves);
    expect(run("--rows", f, "--memo", text, "--kind", "battle", "--id", w).status).toBe(0);
    expect(run("--rows", f, "--memo", text, "--kind", "battle", "--id", "2026-10-19T08").status).toBe(1);
    expect(run("--rows", f, "--memo", text, "--kind", "cup").status).toBe(1);
    expect(run("--rows", f, "--memo", text.replace("T04", "T03")).status).toBe(1);
  });
  it("exits 1 on a tampered row, a wrong root and a malformed memo", () => {
    const tampered = write("t.json", [rows[0], rows[1], { id: "c", s: 4 }]);
    const t = run("--rows", tampered, "--memo", memo);
    expect(t.status).toBe(1);
    expect(t.stderr).toContain("root_mismatch");
    expect(run("--rows", good, "--memo", formatMemo({ kind: "cup", id: "c1", root: "1".repeat(64), count })).status).toBe(1);
    expect(run("--rows", good, "--memo", "not a memo").status).toBe(1);
    expect(run("--rows", good, "--memo", memo, "--id", "other").status).toBe(1);
  });
  it("verifies one entry with a proof file", async () => {
    const p = await merkleProof(rows, rows[1]!);
    const f = write("p.json", { leaf: p.leaf, proof: p.proof });
    expect(run("--proof", f, "--memo", memo).status).toBe(0);
    expect(run("--proof", write("p2.json", { leaf: p.leaf.replace("2", "9"), proof: p.proof }), "--memo", memo).status).toBe(1);
  });
  it("prints JSON with --json", () => {
    const r = run("--rows", good, "--memo", memo, "--json");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, exitCode: 0 });
  });
  it("exits 2 on usage errors and unreadable input", () => {
    expect(run().status).toBe(2);
    expect(run("--rows", good).status).toBe(2);
    expect(run("--memo", memo).status).toBe(2);
    const noRpc = run("--rows", good, "--sig", "5".repeat(88), "--signer", ADDR);
    expect(noRpc.status).toBe(2); // no default RPC
    expect(noRpc.stderr).toContain("CHARTRUNNER_RPC_URL");
    const noSigner = run("--rows", good, "--sig", "5".repeat(88), "--rpc", "http://127.0.0.1:1");
    expect(noSigner.status).toBe(2); // --signer is required with --sig
    expect(noSigner.stderr).toContain("--signer");
    expect(run("--rows", join(dir, "missing.json"), "--memo", memo).status).toBe(2);
    expect(run("--rows", write("bad.json", "{nope"), "--memo", memo).status).toBe(2);
    expect(run("--rows", write("empty.json", []), "--memo", memo).status).toBe(2);
    expect(run("--bogus").status).toBe(2);
  });
  it("exits 2, never 0, when the RPC is unreachable", () => {
    const r = run("--rows", good, "--sig", "5".repeat(88), "--rpc", "http://127.0.0.1:1", "--signer", ADDR);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("rpc_unreachable");
  });
  it("the bin turns an unexpected crash (cli module cannot load) into exit 2", () => {
    const lone = join(mkdtempSync(join(tmpdir(), "cr-verify-bin-")), "bin.mjs");
    copyFileSync(bin, lone); // no ../src or ../dist next to it: the dynamic import throws
    const r = spawnSync(process.execPath, [lone, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unexpected");
  });
  it("--help exits 0", () => {
    expect(run("--help").status).toBe(0);
  });
  it("maps reasons to exit codes: 1 the data does not match, 2 usage/environment or a check not performed", () => {
    expect(exitCodeFor({ ok: true })).toBe(0);
    for (const reason of ["root_mismatch", "count_mismatch", "proof_invalid", "memo_subject_mismatch", "memo_malformed", "signer_mismatch", "tx_failed", "no_memo", "multiple_memos", "equivocation", "bad_signature", "tx_mismatch"]) {
      expect(exitCodeFor({ ok: false, reason }), reason).toBe(1);
    }
    for (const reason of ["rows_invalid", "leaf_invalid", "input_invalid", "rpc_url_invalid", "signature_invalid", "rpc_unreachable", "rpc_error", "tx_not_found", "meta_missing", "signature_mismatch", "tx_undecodable", "signature_unverified", "equivocation_unchecked"]) {
      expect(exitCodeFor({ ok: false, reason }), reason).toBe(2);
    }
  });
  it("--signer must be a base58 32-byte address: a typo is a usage error (2), never a mismatch", () => {
    for (const bad of ["Op", ADDR.slice(0, -1) + "0", ADDR.slice(0, -1) + "l", "1".repeat(44), ADDR + "1"]) {
      const r = run("--rows", good, "--sig", "5".repeat(88), "--rpc", "http://127.0.0.1:1", "--signer", bad);
      expect(r.status, bad).toBe(2);
      expect(r.stderr, bad).toMatch(/--signer must be a base58 Solana address/);
    }
  });
});

describe("chartrunner-verify CLI: RPC URL from the environment", () => {
  const SIG = "5".repeat(88);
  const silent = { out: () => {}, err: () => {} };
  /** Runs main with a fetch that records the URL it was called with and answers like a node without the transaction. */
  async function urlUsed(argv: string[], env: Record<string, string | undefined>) {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
    }) as typeof fetch;
    try {
      const code = await main(argv, silent, env);
      return { code, urls };
    } finally {
      globalThis.fetch = real;
    }
  }
  const rowsFile = write("env-rows.json", rows);

  it("uses CHARTRUNNER_RPC_URL when --rpc is absent", async () => {
    const r = await urlUsed(["--rows", rowsFile, "--sig", SIG, "--signer", ADDR], { CHARTRUNNER_RPC_URL: "https://env-rpc.example/key" });
    expect(r.urls).toEqual(["https://env-rpc.example/key"]);
    expect(r.code).toBe(2); // tx_not_found: the URL was used, nothing verified
  });
  it("--rpc overrides the environment", async () => {
    const r = await urlUsed(["--rows", rowsFile, "--sig", SIG, "--signer", ADDR, "--rpc", "https://flag-rpc.example"], { CHARTRUNNER_RPC_URL: "https://env-rpc.example" });
    expect(r.urls).toEqual(["https://flag-rpc.example/"]);
  });
  it("an empty variable is unset, and offline mode ignores it", async () => {
    const empty = await urlUsed(["--rows", rowsFile, "--sig", SIG, "--signer", ADDR], { CHARTRUNNER_RPC_URL: "" });
    expect(empty).toEqual({ code: 2, urls: [] });
    const { root, count } = await merkleRoot(rows);
    const offline = await urlUsed(["--rows", rowsFile, "--memo", formatMemo({ kind: "cup", id: "c1", root, count })], { CHARTRUNNER_RPC_URL: "https://env-rpc.example" });
    expect(offline).toEqual({ code: 0, urls: [] });
  });
});
