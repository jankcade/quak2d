/*
 * util.js — tiny shared helpers: math, seeded RNG, canvas factory.
 * Everything hangs off the global `Q2` namespace (plain scripts, no modules,
 * so index.html works straight from file://).
 */
(function (root) {
  'use strict';

  var Q2 = root.Q2 = root.Q2 || {};

  /* ---------------- math ---------------- */

  var TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function sign(v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); }

  /* frame-rate independent exponential smoothing */
  function approach(cur, target, rate, dt) {
    return target + (cur - target) * Math.exp(-rate * dt);
  }

  /* shortest signed difference between two angles */
  function angleDelta(a, b) {
    var d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }

  function dist2(ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    return dx * dx + dy * dy;
  }

  /* ---------------- seeded RNG (mulberry32) ---------------- */

  function makeRng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    function next() {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      next: next,
      range: function (a, b) { return a + (b - a) * next(); },
      int: function (a, b) { return Math.floor(a + (b - a + 1) * next()) ; },
      pick: function (list) { return list[Math.floor(next() * list.length)]; },
      chance: function (p) { return next() < p; },
      sign: function () { return next() < 0.5 ? -1 : 1; }
    };
  }

  /* ---------------- canvas / pixel helpers ---------------- */

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    var ctx = c.getContext('2d');
    if (ctx) ctx.imageSmoothingEnabled = false;
    return c;
  }

  function makeContext2d(w, h) {
    return makeCanvas(w, h).getContext('2d');
  }

  /* value noise on a torus so tiles are seamless */
  function makeValueNoise(rng, size, lattice) {
    var n = lattice * lattice;
    var g = new Float32Array(n);
    for (var i = 0; i < n; i++) g[i] = rng.next();
    function at(x, y) {
      var xi = ((x % lattice) + lattice) % lattice;
      var yi = ((y % lattice) + lattice) % lattice;
      return g[yi * lattice + xi];
    }
    return function (u, v) {
      var fx = u * lattice, fy = v * lattice;
      var x0 = Math.floor(fx), y0 = Math.floor(fy);
      var tx = fx - x0, ty = fy - y0;
      tx = tx * tx * (3 - 2 * tx);
      ty = ty * ty * (3 - 2 * ty);
      var a = at(x0, y0), b = at(x0 + 1, y0);
      var c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
    };
  }

  /* multi-octave version of the above */
  function makeFbmNoise(rng, lattice, octaves) {
    var layers = [];
    var l = lattice, i;
    for (i = 0; i < octaves; i++) {
      layers.push({ fn: makeValueNoise(rng, 0, l), amp: 1 / (1 << i), scale: 1 });
      l = Math.max(2, l * 2);
    }
    var total = 0;
    for (i = 0; i < layers.length; i++) total += layers[i].amp;
    return function (u, v) {
      var s = 0;
      for (var j = 0; j < layers.length; j++) {
        s += layers[j].fn(u, v) * layers[j].amp;
      }
      return s / total;
    };
  }

  /* ---------------- colour ---------------- */

  function rgb(r, g, b) {
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }

  function rgba(r, g, b, a) {
    return 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a + ')';
  }

  /* shade a 0-255 triple by a factor, clamping */
  function shade(c, f) {
    return [clamp(c[0] * f, 0, 255), clamp(c[1] * f, 0, 255), clamp(c[2] * f, 0, 255)];
  }

  Q2.util = {
    TAU: TAU,
    clamp: clamp,
    lerp: lerp,
    sign: sign,
    approach: approach,
    angleDelta: angleDelta,
    dist2: dist2,
    makeRng: makeRng,
    makeCanvas: makeCanvas,
    makeContext2d: makeContext2d,
    makeValueNoise: makeValueNoise,
    makeFbmNoise: makeFbmNoise,
    rgb: rgb,
    rgba: rgba,
    shade: shade
  };
})(typeof window !== 'undefined' ? window : this);
