import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cupLeavesFromStandings, formatMemo, merkleProof, merkleRoot } from "../index.ts";
import { exitCodeFor } from "../cli.ts";

const bin = new URL("../../bin/chartrunner-verify.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "cr-verify-cli-"));
const write = (name: string, v: unknown) => {
  const f = join(dir, name);
  writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
  return f;
};
const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

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
    expect(run("--rows", good, "--sig", "5".repeat(88), "--signer", "Op").status).toBe(2); // no default RPC
    const noSigner = run("--rows", good, "--sig", "5".repeat(88), "--rpc", "http://127.0.0.1:1");
    expect(noSigner.status).toBe(2); // --signer is required with --sig
    expect(noSigner.stderr).toContain("--signer");
    expect(run("--rows", join(dir, "missing.json"), "--memo", memo).status).toBe(2);
    expect(run("--rows", write("bad.json", "{nope"), "--memo", memo).status).toBe(2);
    expect(run("--rows", write("empty.json", []), "--memo", memo).status).toBe(2);
    expect(run("--bogus").status).toBe(2);
  });
  it("exits 2, never 0, when the RPC is unreachable", () => {
    const r = run("--rows", good, "--sig", "5".repeat(88), "--rpc", "http://127.0.0.1:1", "--signer", "Op");
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
  it("maps reasons to exit codes", () => {
    expect(exitCodeFor({ ok: true })).toBe(0);
    expect(exitCodeFor({ ok: false, reason: "root_mismatch" })).toBe(1);
    expect(exitCodeFor({ ok: false, reason: "rpc_unreachable" })).toBe(2);
    expect(exitCodeFor({ ok: false, reason: "rows_invalid" })).toBe(2);
  });
});
