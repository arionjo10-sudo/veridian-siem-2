'use strict';
const crypto = require('crypto');

// Deterministic PRNG so the demo data looks the same on every start.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = mulberry32(20261006);
const rand = () => R();
const int = (a, b) => Math.floor(R() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const chance = (p) => R() < p;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pad = (n, w = 5) => String(n).padStart(w, '0');
const round2 = (n) => Math.round(n * 100) / 100;
// Documentation-reserved ranges only, so no demo address belongs to a real host.
const extIp = () => pick(['203.0.113', '198.51.100', '192.0.2']) + '.' + int(2, 250);
const intIp = () => `10.${int(0, 9)}.${int(0, 40)}.${int(2, 250)}`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { rand, int, pick, chance, sha256, pad, round2, extIp, intIp, HttpError };
