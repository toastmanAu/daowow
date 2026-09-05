// DAOWOW deterministic core — JavaScript mirror of crates/daowow-core.
//
// Every hash domain, canonical encoding and algorithm here is a faithful
// port of the Rust implementation; apps/web runs a self-test against the
// Rust-generated vectors (tests/vectors/daowow_core_vectors.json) on load.
// Zero dependencies. Shannon amounts use BigInt.

"use strict";

// ---------------------------------------------------------------------------
// blake2b-256 with the CKB personalization ("ckb-default-hash")
// ---------------------------------------------------------------------------

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const M64 = (1n << 64n) - 1n;
const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;

function le64(bytes, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]);
  return v;
}

// h and v are BigInt[16]; m is BigInt[16] (message words, little-endian)
function compress(h, m, tLow, tHigh, isLast) {
  const v = new Array(16);
  for (let i = 0; i < 8; i++) v[i] = h[i];
  for (let i = 0; i < 8; i++) v[8 + i] = IV[i];
  v[12] ^= BigInt(tLow) & M64;
  v[13] ^= BigInt(tHigh) & M64;
  if (isLast) v[14] ^= M64; // f0 = -1
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r];
    g(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] = (h[i] ^ v[i] ^ v[i + 8]) & M64;
}

function g(v, a, b, c, d, x, y) {
  x = BigInt(x); y = BigInt(y);
  v[a] = (v[a] + v[b] + x) & M64;
  v[d] = rotr(v[d] ^ v[a], 32);
  v[c] = (v[c] + v[d]) & M64;
  v[b] = rotr(v[b] ^ v[c], 24);
  v[a] = (v[a] + v[b] + y) & M64;
  v[d] = rotr(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) & M64;
  v[b] = rotr(v[b] ^ v[c], 63);
}

const BLOCK = 128;
const CKB_PERSONAL = new TextEncoder().encode("ckb-default-hash"); // 16 bytes

/**
 * blake2b-256 with the CKB personalization — the only hash in DAOWOW.
 * @param {Uint8Array|Uint8Array[]} parts message or concatenation of parts
 * @returns {Uint8Array} 32-byte digest
 */
function ckbHash256(parts) {
  if (!Array.isArray(parts)) parts = [parts];
  let total = 0;
  for (const p of parts) total += p.length;

  // parameter block: h0 ^= LE64(32,0,1,1,0...); h6/h7 ^= personalization
  const h = IV.slice();
  h[0] ^= 0x01010020n; // digest_length=32 | fanout=1<<16 | depth=1<<24
  h[6] ^= le64(CKB_PERSONAL, 0);
  h[7] ^= le64(CKB_PERSONAL, 8);

  // stream blocks
  let offset = 0; // global input offset
  let partIdx = 0, partOff = 0;
  const read = (n, buf) => {
    let got = 0;
    while (got < n && partIdx < parts.length) {
      const p = parts[partIdx];
      const avail = p.length - partOff;
      const take = Math.min(avail, n - got);
      for (let i = 0; i < take; i++) buf[got + i] = p[partOff + i];
      got += take; partOff += take;
      if (partOff === p.length) { partIdx++; partOff = 0; }
    }
    return got;
  };

  const block = new Uint8Array(BLOCK);
  let remaining = total;
  if (remaining === 0) {
    // empty input: one final block of zeros with t=0
    const m = new Array(16).fill(0n);
    compress(h, m, 0, 0, true);
  }
  while (remaining > 0) {
    const isLast = remaining <= BLOCK;
    const want = isLast ? remaining : BLOCK;
    block.fill(0);
    const got = read(want, block);
    const m = new Array(16);
    for (let i = 0; i < 16; i++) m[i] = le64(block, i * 8);
    const t = total - remaining + got; // running counter after this block
    compress(h, m, t, 0, isLast);
    remaining -= got;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((h[i >> 3] >> BigInt((i & 7) * 8)) & 0xffn);
  return out;
}

// ---------------------------------------------------------------------------
// hex helpers
// ---------------------------------------------------------------------------

function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function unhex(s) {
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const enc = new TextEncoder();
const H = (...args) => {
  const parts = [];
  for (const a of args) {
    if (typeof a === "string") parts.push(enc.encode(a));
    else if (Array.isArray(a))
      for (const x of a) parts.push(typeof x === "string" ? enc.encode(x) : x);
    else parts.push(a);
  }
  return ckbHash256(parts);
};

// ---------------------------------------------------------------------------
// little-endian integer writers (canonical encodings are LE)
// ---------------------------------------------------------------------------

function u32le(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }
function u64le(v) {
  v = BigInt(v);
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, Number(v & 0xffffffffn), true);
  dv.setUint32(4, Number((v >> 32n) & 0xffffffffn), true);
  return b;
}
// ---------------------------------------------------------------------------
// canonical encodings (daowow-core/src/encoding.rs)
// ---------------------------------------------------------------------------

const SIZES = {
  roundConfig: 358, shardData: 101, entryData: 132,
  batchData: 96, settlementFunding: 128, payoutItem: 48,
};

/** EntryDataV1 canonical 132-byte encoding */
function encodeEntry(e) {
  const b = new Uint8Array(SIZES.entryData);
  b.set(e.roundId, 0);
  new DataView(b.buffer).setUint32(32, e.shardId, true);
  b.set(e.participantLockHash, 36);
  b.set(u64le(e.ticketCount), 68);
  b.set(u64le(e.principal), 76);
  b.set(u64le(e.positionBase), 84);
  b.set(u64le(e.entryNonce), 92);
  b.set(e.entropyCommitment, 100);
  return b;
}

/** PayoutItem canonical 48-byte encoding */
function encodePayoutItem(p) {
  const b = new Uint8Array(SIZES.payoutItem);
  b.set(p.participantLockHash, 0);
  b.set(u64le(p.principal), 32);
  b.set(u64le(p.prize), 40);
  return b;
}

// ---------------------------------------------------------------------------
// leaf / entropy domains (daowow-core/src/leaf.rs)
// ---------------------------------------------------------------------------

const entryLeaf = (e) => H("DAOWOW_ENTRY_LEAF_V1", encodeEntry(e));
const entropyCommitment = (secret, roundId, participantLockHash) =>
  H("DAOWOW_ENTRY_COMMIT_V1", enc.encode(secret), roundId, participantLockHash);
const missingRevealFallback = (commitment) => H("DAOWOW_MISSING_REVEAL_V1", commitment);
const liabilityLeaf = (participantLockHash, principal, prize) => {
  const buf = new Uint8Array(48);
  buf.set(participantLockHash, 0);
  buf.set(u64le(principal), 32);
  buf.set(u64le(prize), 40);
  return H("DAOWOW_LIABILITY_LEAF_V1", buf);
};

// ---------------------------------------------------------------------------
// MMR (daowow-core/src/accumulator/mmr.rs) — the selected shard accumulator
//   leaf  : passed through (entry leaf hash used directly by the shard)
//   node  : H(0x01 || left || right)
//   root  : H(0x02 || peak_count u32 LE || peaks…), peaks = descending height
// ---------------------------------------------------------------------------

const MMR = {
  MAX_PEAKS: 64,
  nodeHash: (l, r) => H([new Uint8Array([0x01]), l, r]),
  bagPeaks(peaks) {
    const buf = [u32le(peaks.length)];
    for (const p of peaks) buf.push(p);
    return H(buf);
  },
  shape: (count) => popcount(count),
  /** pure append over peak list; returns { peaks, count } */
  appendPeaks(peaks, count, leaf) {
    if (peaks.length !== MMR.shape(count)) throw new Error("bad peak shape");
    const np = peaks.slice();
    let i = peaks.length;
    let cur = leaf;
    let h = 0;
    while ((BigInt(count) >> BigInt(h)) & 1n) {
      if (i === 0) throw new Error("bad peaks");
      i -= 1;
      cur = MMR.nodeHash(np[i], cur);
      h += 1;
    }
    np[i] = cur;
    return np.slice(0, i + 1);
  },
};

function popcount(x) {
  let c = 0;
  while (x) { c += x & 1; x >>= 1; }
  return c;
}

class MmrHost {
  constructor() { this.leaves = []; this.peaks = []; this.count = 0; }
  root() { return MMR.bagPeaks(this.peaks); }
  append(leaf) {
    this.peaks = MMR.appendPeaks(this.peaks, this.count, leaf);
    this.leaves.push(leaf);
    this.count += 1;
  }
  /** wire proof: u8 path_len | path_len*32 siblings (bottom-up) | u8 peak_slot | u8 peaks_len | peaks */
  membershipProof(pos) {
    if (pos >= this.count) throw new Error("pos out of range");
    let remaining = this.count, base = 0, slot = 0, height = 0;
    for (let b = 63; b >= 0; b--) {
      if ((BigInt(remaining) >> BigInt(b)) & 1n) {
        const size = 2 ** b;
        if (pos < base + size) { height = b; break; }
        base += size; slot += 1;
      }
    }
    const local = pos - base;
    let level = this.leaves.slice(base, base + 2 ** height).map((x) => x);
    let idx = local;
    const path = [];
    while (level.length > 1) {
      const sib = idx % 2 === 0 ? level[idx + 1] : level[idx - 1];
      path.push(sib);
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(MMR.nodeHash(level[i], level[i + 1]));
      level = next;
      idx >>= 1;
    }
    const out = [new Uint8Array([path.length])];
    for (const p of path) out.push(p);
    out.push(new Uint8Array([slot]));
    out.push(new Uint8Array([this.peaks.length]));
    for (const p of this.peaks) out.push(p);
    return concat(out);
  }
}

/** on-chain membership verify (mirrors mmr::verify_membership) */
function mmrVerifyMembership(root, count, pos, leaf, proof) {
  if (proof.length < 1 || pos >= count) return false;
  const pathLen = proof[0];
  let off = 1;
  if (proof.length < off + pathLen * 32 + 2) return false;
  let cur = leaf;
  for (let i = 0; i < pathLen; i++) {
    const sib = proof.slice(off, off + 32); off += 32;
    cur = MMR.nodeHash(pos & 1 ? sib : cur, pos & 1 ? cur : sib);
    pos = Math.floor(pos / 2);
  }
  const slot = proof[off]; const peaksLen = proof[off + 1]; off += 2;
  if (peaksLen > MMR.MAX_PEAKS || slot >= peaksLen || proof.length < off + peaksLen * 32) return false;
  if (peaksLen !== popcount(count)) return false;
  const peaks = [];
  for (let i = 0; i < peaksLen; i++) peaks.push(proof.slice(off + i * 32, off + (i + 1) * 32));
  peaks[slot] = cur;
  return hex(MMR.bagPeaks(peaks)) === hex(root);
}

// ---------------------------------------------------------------------------
// IMT (fixed-depth 32, padded root) — measured in the bakeoff, not selected
// ---------------------------------------------------------------------------

const IMT = {
  DEPTH: 32,
  leafHash: (data) => H([new Uint8Array([0x10]), H(data)]),
  nodeHash: (l, r) => H([new Uint8Array([0x11]), l, r]),
  zeroAt(level) {
    let z = new Uint8Array(32);
    for (let i = 0; i < level; i++) z = IMT.nodeHash(z, z);
    return z;
  },
  rootFromFrontier(frontier, n) {
    const rec = (m, depth) => {
      if (depth === 0) return m >= 1 ? frontier[0] : IMT.zeroAt(0);
      const half = 2 ** (depth - 1);
      const right = IMT.zeroAt(depth - 1);
      if (m >= half) return IMT.nodeHash(frontier[depth - 1], rec(m - half, depth - 1));
      return IMT.nodeHash(rec(m, depth - 1), right);
    };
    return rec(n, IMT.DEPTH);
  },
};

class ImtHost {
  constructor() {
    this.frontier = Array.from({ length: IMT.DEPTH }, () => new Uint8Array(32));
    this.count = 0; this.leaves = [];
  }
  root() { return IMT.rootFromFrontier(this.frontier, this.count); }
  append(leaf) {
    let cur = leaf; let j = 0;
    while (j < IMT.DEPTH) {
      if ((BigInt(this.count) >> BigInt(j)) & 1n) {
        cur = IMT.nodeHash(this.frontier[j], cur);
        this.frontier[j] = new Uint8Array(32);
        j += 1;
      } else { this.frontier[j] = cur; break; }
    }
    this.leaves.push(leaf);
    this.count += 1;
  }
}

// ---------------------------------------------------------------------------
// draw (daowow-core/src/draw.rs)
// ---------------------------------------------------------------------------

const drawSeed = (roundId, entryUniverseRoot, totalTickets, participantEntropyRoot, chainEntropyRoot) =>
  H("DAOWOW_DRAW_SEED_V1", roundId, entryUniverseRoot, u64le(totalTickets), participantEntropyRoot, chainEntropyRoot);
const chainEntropyRoot = (blockHashes) => H(["DAOWOW_CHAIN_ENTROPY_V1", ...blockHashes].map((x) => (typeof x === "string" ? enc.encode(x) : x)));
const participantEntropyRoot = (reveals) => H(["DAOWOW_PARTICIPANT_ENTROPY_V1", ...reveals].map((x) => (typeof x === "string" ? enc.encode(x) : x)));
const candidate = (seed, prizeIndex, retry) =>
  H("DAOWOW_DRAW_CANDIDATE_V1", seed, u64le(prizeIndex), u32le(retry));

/** candidate (256-bit BE) mod n via Horner; returns {mod, overLimit} */
function candidateModN(candidateBytes, n) {
  const nB = BigInt(n);
  let r = 0n;
  for (const b of candidateBytes) r = ((r << 8n) | BigInt(b)) % nB;
  // limit = 2^256 - (2^256 mod n); reject iff candidate >= limit
  const two256modN = (2n ** 256n) % nB;
  // candidate >= limit  <=>  candidate > 2^256 - 1 - two256modN
  const threshold = (1n << 256n) - 1n - two256modN;
  let v = 0n;
  for (const b of candidateBytes) v = (v << 8n) | BigInt(b);
  return { mod: Number(r), rejected: v > threshold };
}

function rejectionSample(seed, prizeIndex, nTickets) {
  let retry = 0;
  for (;;) {
    const c = candidate(seed, prizeIndex, retry);
    const { mod, rejected } = candidateModN(c, nTickets);
    if (!rejected) return { position: mod, retry };
    retry += 1;
  }
}

/** distinct positional draw; one position may win at most once */
function drawPositions(seed, nTickets, prizeCount) {
  if (nTickets === 0 || prizeCount > nTickets) throw new Error("invalid draw");
  const used = new Set();
  const out = [];
  for (let i = 0n; i < BigInt(prizeCount); i++) {
    let { position: pos, retry } = rejectionSample(seed, Number(i), nTickets);
    while (used.has(pos)) {
      retry += 1;
      const c = candidate(seed, Number(i), retry);
      const { mod, rejected } = candidateModN(c, nTickets);
      if (rejected) { retry += 1; continue; }
      pos = mod;
    }
    used.add(pos);
    out.push({ prizeIndex: Number(i), position: pos });
  }
  return out;
}

// ---------------------------------------------------------------------------
// vector self-test against the Rust-generated file (vectors.js)
// ---------------------------------------------------------------------------

function selfTest(V) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  const eq = (a, b) => hex(a) === String(b).replace(/^0x/, "");

  const roundId = H("DAOWOW-VECTOR-ROUND-1");
  const participant = H("DAOWOW-VECTOR-PARTICIPANT-1");

  check("blake2b-256 CKB personalization", eq(H(V.domain_hash.input), V.domain_hash.output));

  check("entry leaf (canonical encoding + domain)",
    eq(entryLeaf({
      roundId, shardId: 3, participantLockHash: participant,
      ticketCount: 7n, principal: 700n, positionBase: 13n, entryNonce: 4n,
      entropyCommitment: unhex("447ce21e9942e777a791bd199db30a7938c61f9d6813e416cc6538ab5ea06c3e"),
    }), V.entry_leaf.leaf));

  const commitment = entropyCommitment("secret", roundId, participant);
  check("entropy commitment", eq(commitment, V.entropy.commitment));
  check("missing-reveal fallback", eq(missingRevealFallback(commitment), V.entropy.missing_reveal_fallback));
  check("liability leaf", eq(liabilityLeaf(participant, 100n, 10n), V.liability_leaf.leaf));

  // MMR: rebuild the 5-leaf tree from the vector and verify root + proof
  const mmr = new MmrHost();
  for (let i = 0; i < 5; i++) mmr.append(H(`mmr-${i}`));
  check("mmr root (5 appends)", eq(mmr.root(), V.mmr.root_after_5_appends));
  const mmrProof = unhex(V.mmr.membership_proof_pos2_hex);
  check("mmr membership proof verify (pos 2)",
    mmrVerifyMembership(mmr.root(), 5, 2, H("mmr-2"), mmrProof));

  // IMT
  const imt = new ImtHost();
  for (let i = 0; i < 5; i++) imt.append(H(`imt-${i}`));
  check("imt padded root (5 appends)", eq(imt.root(), V.imt.root_after_5_appends));

  // draw: seed inputs taken from the vector (uses the Rust-computed SMT root)
  const seed = drawSeed(roundId, unhex(V.smt.root_after_4_appends), 1000000n, commitment, unhex(V.entropy.missing_reveal_fallback));
  check("draw seed", eq(seed, V.draw.seed));
  check("draw candidate(0,0)", eq(candidate(seed, 0, 0), V.draw.candidate_0_0));
  const rs = rejectionSample(seed, 0, 1000000);
  check("rejection sampling (n=1,000,000)",
    rs.position === V.draw.rejection_sample_prize0_n1000000.position &&
    rs.retry === V.draw.rejection_sample_prize0_n1000000.retry,
    `position ${rs.position}`);

  return checks;
}

// ---------------------------------------------------------------------------
// export (browser global + node module for headless tests)
// ---------------------------------------------------------------------------

const DaowowCore = {
  ckbHash256, H, hex, unhex, concat, u32le, u64le, SIZES,
  encodeEntry, encodePayoutItem,
  entryLeaf, entropyCommitment, missingRevealFallback, liabilityLeaf,
  MMR, MmrHost, mmrVerifyMembership, IMT, ImtHost,
  drawSeed, chainEntropyRoot, participantEntropyRoot, candidate,
  rejectionSample, drawPositions, candidateModN, selfTest, popcount,
};

if (typeof module !== "undefined" && module.exports) module.exports = DaowowCore;
if (typeof window !== "undefined") window.DaowowCore = DaowowCore;
