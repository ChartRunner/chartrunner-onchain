// Local check of a transaction's signatures (SPEC.md section 2.4, optional rule 10). An RPC can return any JSON it likes;
// the wire bytes plus the Ed25519 signatures over them cannot be forged without the signers' keys. Given the base64 wire
// transaction, this decodes the message, verifies every required signature with WebCrypto Ed25519 and returns what the
// signed bytes actually say: the signers (fee payer first) and the data of every SPL Memo instruction.
// Dependency free. Where the runtime has no Ed25519 in WebCrypto the result is "unsupported", never a pass.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) encoding, as Solana uses for addresses and signatures. */
export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

/** Base58 decoding; null for a character outside the alphabet. */
export function base58Decode(s: string): Uint8Array | null {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function base64Decode(s: string): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

class Reader {
  pos = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  u8(): number {
    if (this.pos >= this.b.length) throw new RangeError("truncated");
    return this.b[this.pos++]!;
  }
  /** Solana compact-u16 (1 to 3 bytes, little-endian base-128). */
  shortvec(): number {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.u8();
      v |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) return v;
    }
    throw new RangeError("bad compact-u16");
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.b.length) throw new RangeError("truncated");
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export interface SignedTransactionFacts {
  /** Base58 signatures, in order; the first is the transaction id. */
  signatures: string[];
  /** The accounts that signed (the first numRequiredSignatures static keys), fee payer first. */
  signers: string[];
  /** UTF-8 data of every instruction whose program is the SPL Memo program, in order (null when not valid UTF-8). */
  memos: (string | null)[];
}

export type LocalSignatureCheck =
  | { ok: true; status: "verified"; facts: SignedTransactionFacts }
  | { ok: true; status: "unsupported"; facts: SignedTransactionFacts }
  | { ok: false; reason: "tx_undecodable" | "bad_signature"; message: string };

/** Decode a base64 wire transaction (legacy or v0). Throws on malformed input. */
export function decodeTransaction(wire: Uint8Array, memoProgramId: string): { facts: SignedTransactionFacts; message: Uint8Array; rawSignatures: Uint8Array[]; keys: Uint8Array[] } {
  const r = new Reader(wire);
  const nSig = r.shortvec();
  const rawSignatures: Uint8Array[] = [];
  for (let i = 0; i < nSig; i++) rawSignatures.push(r.bytes(64));
  const message = wire.subarray(r.pos);
  const m = new Reader(message);
  const first = message[0];
  if (first === undefined) throw new RangeError("empty message");
  if (first & 0x80) {
    if ((first & 0x7f) !== 0) throw new RangeError("unsupported transaction version");
    m.u8();
  }
  const numRequired = m.u8();
  m.u8(); // readonly signed
  m.u8(); // readonly unsigned
  const nKeys = m.shortvec();
  const keys: Uint8Array[] = [];
  for (let i = 0; i < nKeys; i++) keys.push(m.bytes(32));
  m.bytes(32); // recent blockhash
  const nIx = m.shortvec();
  const memos: (string | null)[] = [];
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < nIx; i++) {
    const programIndex = m.u8();
    const nAcc = m.shortvec();
    m.bytes(nAcc);
    const data = m.bytes(m.shortvec());
    // Programs are always static keys (the runtime refuses a program id loaded from a lookup table).
    const program = keys[programIndex];
    if (program && base58Encode(program) === memoProgramId) {
      try {
        memos.push(utf8.decode(data));
      } catch {
        memos.push(null);
      }
    }
  }
  if (nSig !== numRequired || numRequired === 0 || numRequired > nKeys) throw new RangeError("signature count does not match the message header");
  const signers = keys.slice(0, numRequired).map(base58Encode);
  return { facts: { signatures: rawSignatures.map(base58Encode), signers, memos }, message, rawSignatures, keys };
}

/**
 * Verify every required signature of a base64 wire transaction locally. `subtle` defaults to the runtime's WebCrypto;
 * passing another one is for tests and for runtimes that provide Ed25519 elsewhere.
 */
export async function checkTransactionSignatures(base64: string, memoProgramId: string, subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): Promise<LocalSignatureCheck> {
  const wire = base64Decode(base64);
  if (!wire) return { ok: false, reason: "tx_undecodable", message: "The RPC's base64 transaction is not valid base64." };
  let decoded: ReturnType<typeof decodeTransaction>;
  try {
    decoded = decodeTransaction(wire, memoProgramId);
  } catch (e) {
    return { ok: false, reason: "tx_undecodable", message: `The RPC's wire transaction could not be decoded (${e instanceof Error ? e.message : "malformed"}).` };
  }
  // No Ed25519 in this runtime's WebCrypto: say so, never pass.
  if (!subtle || !(await ed25519Supported(subtle))) return { ok: true, status: "unsupported", facts: decoded.facts };
  for (let i = 0; i < decoded.rawSignatures.length; i++) {
    let valid = false;
    try {
      const key = await subtle.importKey("raw", decoded.keys[i]! as BufferSource, { name: "Ed25519" }, false, ["verify"]);
      valid = await subtle.verify({ name: "Ed25519" }, key, decoded.rawSignatures[i]! as BufferSource, decoded.message as BufferSource);
    } catch {
      valid = false; // a key the runtime refuses is not a key that signed this
    }
    if (!valid) return { ok: false, reason: "bad_signature", message: `Signature ${i + 1} does not verify for ${decoded.facts.signers[i]}: the RPC's transaction is not what that key signed.` };
  }
  return { ok: true, status: "verified", facts: decoded.facts };
}

const support = new WeakMap<SubtleCrypto, Promise<boolean>>();
/** Whether this WebCrypto implements Ed25519 (probed once per instance by generating a throwaway key pair). */
function ed25519Supported(subtle: SubtleCrypto): Promise<boolean> {
  let p = support.get(subtle);
  if (!p) {
    p = Promise.resolve()
      .then(() => subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]))
      .then(
        () => true,
        () => false,
      );
    support.set(subtle, p);
  }
  return p;
}
