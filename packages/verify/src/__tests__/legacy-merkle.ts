// Deterministic Merkle commitments for ChartRunner results. Isomorphic (WebCrypto only), so the exact same code
// runs on the server (building a snapshot) and in the browser (/verify recomputes the root itself).
//
// Format v1 (see SPEC.md; keep that document in sync):
//   leaf  = sha256(0x00 || utf8(canonicalJson(entry)))
//   node  = sha256(0x01 || left || right)
//   leaves are sorted ascending by leaf hash; duplicates are rejected; a lone node on a level is promoted as is
//   (never duplicated), so the tree has no duplicate-leaf ambiguity. The leaf count is committed in the memo.

export type LeafValue = string | number | boolean | null;
/** One result entry. Numbers must be safe integers: scores and PnL use integers (e.g. micro-units) or strings. */
export type LeafEntry = Record<string, LeafValue>;

export interface ProofStep {
  /** Which side the SIBLING is on. */
  side: "L" | "R";
  hash: string;
}

export interface MerkleTree {
  root: string;
  count: number;
  /** Sorted leaf hashes (hex), index = leaf position. */
  leaves: string[];
  /** levels[0] = leaves ... levels[n] = [root], as raw bytes. */
  levels: Uint8Array[][];
}

const enc = new TextEncoder();
const HEX = /^[0-9a-f]{64}$/;
export const isHash = (s: unknown): s is string => typeof s === "string" && HEX.test(s);

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (!isHash(h)) throw new Error("invalid hash");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await sha256(enc.encode(text)));
}

/** Canonical JSON: keys sorted by UTF-16 code unit, no whitespace, integers/strings/booleans/null only. */
export function canonicalJson(entry: LeafEntry): string {
  const keys = Object.keys(entry).sort();
  const parts = keys.map((k) => {
    const v = entry[k];
    if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error(`leaf field ${k} must be a safe integer, a string, a boolean or null`);
    if (v === undefined || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean" && v !== null)) throw new Error(`leaf field ${k} has an unsupported value`);
    return `${JSON.stringify(k)}:${JSON.stringify(v)}`;
  });
  return `{${parts.join(",")}}`;
}

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

/** Hash of one leaf given its canonical JSON text. */
export async function hashLeaf(canonical: string): Promise<string> {
  return toHex(await sha256(LEAF_PREFIX, enc.encode(canonical)));
}

export async function hashNode(left: string, right: string): Promise<string> {
  return toHex(await sha256(NODE_PREFIX, fromHex(left), fromHex(right)));
}

export interface PreparedLeaf {
  canonical: string;
  hash: string;
}

/** Canonicalize + hash + sort entries by leaf hash. Rejects empty input and duplicate leaves. */
export async function prepareLeaves(entries: LeafEntry[]): Promise<PreparedLeaf[]> {
  if (entries.length === 0) throw new Error("cannot commit to zero leaves");
  const prepared = await Promise.all(
    entries.map(async (e) => {
      const canonical = canonicalJson(e);
      return { canonical, hash: await hashLeaf(canonical) };
    }),
  );
  prepared.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  for (let i = 1; i < prepared.length; i++) if (prepared[i]!.hash === prepared[i - 1]!.hash) throw new Error("duplicate leaf");
  return prepared;
}

/** Hash that binds the exact leaf set (stored next to the root so a data export can be checked cheaply). */
export async function leavesHash(prepared: PreparedLeaf[]): Promise<string> {
  return sha256Hex(prepared.map((p) => p.hash).join("\n"));
}

/** Build the tree from already sorted leaf hashes. */
export async function buildTreeFromHashes(sortedHashes: string[]): Promise<MerkleTree> {
  if (sortedHashes.length === 0) throw new Error("cannot commit to zero leaves");
  let level = sortedHashes.map(fromHex);
  const levels: Uint8Array[][] = [level];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!;
      const r = level[i + 1];
      next.push(r ? await sha256(NODE_PREFIX, l, r) : l);
    }
    levels.push(next);
    level = next;
  }
  return { root: toHex(level[0]!), count: sortedHashes.length, leaves: sortedHashes, levels };
}

export async function buildTree(entries: LeafEntry[]): Promise<MerkleTree & { prepared: PreparedLeaf[] }> {
  const prepared = await prepareLeaves(entries);
  const tree = await buildTreeFromHashes(prepared.map((p) => p.hash));
  return { ...tree, prepared };
}

/** Inclusion proof for the leaf at `index` (position in the sorted leaves). */
export function proveIndex(tree: MerkleTree, index: number): ProofStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= tree.count) throw new Error("leaf index out of range");
  const steps: ProofStep[] = [];
  let i = index;
  for (let lvl = 0; lvl < tree.levels.length - 1; lvl++) {
    const level = tree.levels[lvl]!;
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < level.length) steps.push({ side: i % 2 === 0 ? "R" : "L", hash: toHex(level[sib]!) });
    i = Math.floor(i / 2);
  }
  return steps;
}

/** Fold a leaf hash up its proof. */
export async function rootFromProof(leafHash: string, proof: ProofStep[]): Promise<string> {
  let cur = leafHash;
  for (const s of proof) {
    if ((s.side !== "L" && s.side !== "R") || !isHash(s.hash)) throw new Error("malformed proof step");
    cur = s.side === "L" ? await hashNode(s.hash, cur) : await hashNode(cur, s.hash);
  }
  return cur;
}

/** True when `canonical` (the leaf's canonical JSON) is committed by `root` through `proof`. */
export async function verifyProof(canonical: string, proof: ProofStep[], root: string): Promise<boolean> {
  if (!isHash(root)) return false;
  try {
    return (await rootFromProof(await hashLeaf(canonical), proof)) === root;
  } catch {
    return false;
  }
}

/** Structural bound: a proof for a tree of `count` leaves has at most ceil(log2(count)) steps. */
export const maxProofLength = (count: number): number => (count <= 1 ? 0 : Math.ceil(Math.log2(count)));

// ---- Memo text -------------------------------------------------------------------------------------------------

export const MEMO_PREFIX = "chartrunner:v1:";
export const ANCHOR_KINDS = ["freeplay", "daily", "cup", "xp"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];
export const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const isKind = (k: unknown): k is AnchorKind => typeof k === "string" && (ANCHOR_KINDS as readonly string[]).includes(k);

export interface MemoFields {
  kind: AnchorKind;
  id: string;
  root: string;
  count: number;
}

export function memoText(f: MemoFields): string {
  if (!isKind(f.kind)) throw new Error("invalid kind");
  if (!ID_RE.test(f.id)) throw new Error("invalid id");
  if (!isHash(f.root)) throw new Error("invalid root");
  if (!Number.isSafeInteger(f.count) || f.count < 1) throw new Error("invalid count");
  return `${MEMO_PREFIX}${f.kind}:${f.id}:${f.root}:${f.count}`;
}

export function parseMemo(text: string): MemoFields | null {
  const m = /^chartrunner:v1:([a-z]+):([A-Za-z0-9._-]{1,64}):([0-9a-f]{64}):([1-9][0-9]{0,8})$/.exec(text);
  if (!m || !isKind(m[1])) return null;
  return { kind: m[1], id: m[2]!, root: m[3]!, count: Number(m[4]) };
}
