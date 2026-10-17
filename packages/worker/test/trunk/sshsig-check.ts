/**
 * An independent reader of a commit's gpgsig header (the SSH signature format, PROTOCOL.sshsig), for tests that
 * cannot run stock git (the Durable Object tests run in workerd): it splits the header from the commit object as git
 * does, decodes the armored blob field by field, and checks the Ed25519 signature with WebCrypto.
 */

const dec = new TextDecoder();

/** The payload git verifies (the commit object without its gpgsig header) and the armored signature, or null without one. */
export function splitSigned(raw: Uint8Array): { payload: Uint8Array; armored: string } | null {
  const text = dec.decode(raw);
  const end = text.indexOf("\n\n");
  const head = text.slice(0, end < 0 ? text.length : end + 1);
  const lines = head.split("\n");
  const at = lines.findIndex((l) => l.startsWith("gpgsig "));
  if (at < 0) return null;
  let last = at;
  while (last + 1 < lines.length && lines[last + 1]!.startsWith(" ")) last++;
  const armored = `${[lines[at]!.slice("gpgsig ".length), ...lines.slice(at + 1, last + 1).map((l) => l.slice(1))].join("\n")}\n`;
  const kept = [...lines.slice(0, at), ...lines.slice(last + 1)].join("\n");
  return { payload: new TextEncoder().encode(`${kept}${text.slice(head.length)}`), armored };
}

/** The fields of an armored SSH signature. */
export function readSshSignature(armored: string): { magic: string; version: number; keyType: string; publicKey: Uint8Array; namespace: string; reserved: string; hash: string; sigType: string; signature: Uint8Array } {
  const body = armored.replace("-----BEGIN SSH SIGNATURE-----", "").replace("-----END SSH SIGNATURE-----", "").replace(/\s+/g, "");
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  let at = 6;
  const string = (): Uint8Array => {
    const n = view.getUint32(at);
    const out = bytes.subarray(at + 4, at + 4 + n);
    at += 4 + n;
    return out;
  };
  const magic = dec.decode(bytes.subarray(0, 6));
  const version = view.getUint32(at);
  at += 4;
  const keyBlob = string();
  const namespace = dec.decode(string());
  const reserved = dec.decode(string());
  const hash = dec.decode(string());
  const sigBlob = string();
  const inner = (blob: Uint8Array): [string, Uint8Array] => {
    const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const n = v.getUint32(0);
    const type = dec.decode(blob.subarray(4, 4 + n));
    const m = v.getUint32(4 + n);
    return [type, blob.subarray(8 + n, 8 + n + m)];
  };
  const [keyType, publicKey] = inner(keyBlob);
  const [sigType, signature] = inner(sigBlob);
  return { magic, version, keyType, publicKey, namespace, reserved, hash, sigType, signature };
}

/** Whether a commit object's gpgsig header is a good SSH signature in the git namespace by the raw Ed25519 key `publicKey`. */
export async function gitSignatureGood(raw: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  const split = splitSigned(raw);
  if (!split) return false;
  const s = readSshSignature(split.armored);
  if (s.magic !== "SSHSIG" || s.version !== 1 || s.keyType !== "ssh-ed25519" || s.sigType !== "ssh-ed25519" || s.namespace !== "git" || s.hash !== "sha512") return false;
  if (s.publicKey.length !== publicKey.length || s.publicKey.some((b, i) => b !== publicKey[i])) return false;
  const str = (b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length);
    out.set(b, 4);
    return out;
  };
  const te = new TextEncoder();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", split.payload));
  const parts = [te.encode("SSHSIG"), str(te.encode("git")), str(new Uint8Array()), str(te.encode("sha512")), str(digest)];
  const signed = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    signed.set(p, at);
    at += p.length;
  }
  const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, s.signature, signed);
}
