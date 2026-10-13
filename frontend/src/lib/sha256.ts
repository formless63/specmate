/** Source checksums use WebCrypto when available and the pinned SHA-256 otherwise. */
export async function sha256Hex(content: ArrayBuffer): Promise<string> {
  const digest = typeof globalThis.crypto?.subtle?.digest === "function"
    ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", content))
    : (await import("@noble/hashes/sha2.js")).sha256(new Uint8Array(content));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
