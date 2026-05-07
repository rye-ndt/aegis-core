import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createLogger } from "../observability/logger";

const log = createLogger("aesGcm");

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function loadKey(hex: string): Buffer {
  if (!hex) throw new Error("AES_KEY_MISSING");
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_BYTES) {
    throw new Error(`AES_KEY_INVALID_LENGTH:${buf.length}`);
  }
  return buf;
}

/**
 * Envelope format: `v1:<iv-hex>:<authTag-hex>:<ct-hex>`. Versioned so a future
 * algorithm swap can append `v2:` rather than mutating in place.
 */
export function aesEncrypt(plaintext: string, keyHex: string): string {
  const key = loadKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

export function aesDecrypt(envelope: string, keyHex: string): string {
  const key = loadKey(keyHex);
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    log.warn({ versionTag: parts[0] }, "aes-envelope-malformed");
    throw new Error("AES_ENVELOPE_MALFORMED");
  }
  const iv = Buffer.from(parts[1]!, "hex");
  const tag = Buffer.from(parts[2]!, "hex");
  const ct = Buffer.from(parts[3]!, "hex");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
