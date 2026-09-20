// SHA-1, synchronous, in both runtimes.
//
// The render workflow keys staleness on sha1 hex digests — a draft is fresh
// only while its recorded hash still matches the board's. Those digests are
// already written into every results.json on disk, so the algorithm cannot
// change: a different hash would mark every existing render stale and re-spend
// real money re-rendering boards that were already approved.
//
// node:crypto's createHash is synchronous but is a node: builtin, which app/lib
// must not import (it compiles into the browser bundle too). crypto.subtle is
// available in both runtimes but is ASYNC, and the callers — selectionHash
// inside a map, renderRecordIsStale inside a filter — are synchronous all the
// way up. Making them async would ripple through the whole CLI.
//
// So: a small, well-specified algorithm implemented directly, and checked
// against node:crypto rather than assumed correct. Not for anything
// security-bearing — this is a change detector, and sha1 is not collision
// resistant.

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** Hex sha1 of a string, hashed as UTF-8 — matching `createHash("sha1").update(text)`. */
export function sha1Hex(text: string): string {
  const message = new TextEncoder().encode(text);

  // Pad to a multiple of 64 bytes: a 0x80 byte, zeroes, then the bit length as
  // a big-endian 64-bit integer.
  const bitLength = message.length * 8;
  const withPadding = new Uint8Array((((message.length + 8) >> 6) + 1) << 6);
  withPadding.set(message);
  withPadding[message.length] = 0x80;
  const view = new DataView(withPadding.buffer);
  // Written as two 32-bit halves: a Number cannot hold a 64-bit count exactly,
  // and no input here approaches 2^53 bits anyway.
  view.setUint32(withPadding.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(withPadding.length - 4, bitLength >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);
  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((part) => part.toString(16).padStart(8, "0")).join("");
}
