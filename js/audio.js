/*
 * audio.js — fully procedural sound: every sample is synthesised at runtime
 * with the Web Audio API. No asset files, no network.
 *
 * The AudioContext is created lazily on the first user gesture (browsers
 * block it otherwise) and every sound is a cached AudioBuffer.
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;
  var TAU = Math.PI * 2;

  /* ---------------- generators ----------------
   * Each entry fills a mono Float32Array with -1..1 samples.
   * Variants are separate keys so every one gets its own cached buffer.
   */

  function noiseHit(d, n, sr, tau, amp, rng) {
    for (var i = 0; i < n; i++) {
      d[i] = (rng.next() * 2 - 1) * Math.exp(-i / (sr * tau)) * amp;
    }
  }

  var GEN = {
    /* nail gun: bright, short, metallic crack */
    shoot1: { dur: 0.22, gen: function (d, n, sr) {
      var rng = util.makeRng(1013);
      for (var i = 0; i < n; i++) {
        var t = i / sr, v = 0;
        v += (rng.next() * 2 - 1) * (t < 0.012 ? 1 : Math.exp(-(t - 0.012) / 0.05)) * 0.75;
        v += Math.sin(TAU * 1750 * t) * Math.exp(-t / 0.045) * 0.35;
        v += Math.sin(TAU * 2630 * t) * Math.exp(-t / 0.03) * 0.22;
        v += Math.sin(TAU * 110 * t) * Math.exp(-t / 0.035) * 0.5;
        d[i] = clamp(v, -1, 1) * 0.9;
      }
      highpass(d, n, 0.006);
    } },

    /* super nail: deeper, punchier, twin shot */
    shoot2: { dur: 0.3, gen: function (d, n, sr) {
      var rng = util.makeRng(2027);
      for (var i = 0; i < n; i++) {
        var t = i / sr, v = 0;
        v += (rng.next() * 2 - 1) * (t < 0.02 ? 1 : Math.exp(-(t - 0.02) / 0.06)) * 0.7;
        v += Math.sin(TAU * (620 + 900 * Math.exp(-t * 26)) * t) * Math.exp(-t / 0.06) * 0.55;
        v += Math.sin(TAU * 78 * t) * Math.exp(-t / 0.07) * 0.6;
        d[i] = clamp(v, -1, 1) * 0.9;
      }
    } },

    /* rocket: airy whoosh plus a low boom */
    shoot3: { dur: 0.5, gen: function (d, n, sr) {
      var rng = util.makeRng(3041);
      for (var i = 0; i < n; i++) {
        var t = i / sr, v = 0;
        v += (rng.next() * 2 - 1) * Math.exp(-t / 0.22) * 0.5;
        v += Math.sin(TAU * (58 + 40 * Math.exp(-t * 8)) * t) * Math.exp(-t / 0.16) * 0.8;
        d[i] = clamp(v, -1, 1) * 0.85;
      }
      lowpass(d, n, 0.12);
    } },

    /* thunder gun: long low crack */
    shoot4: { dur: 0.6, gen: function (d, n, sr) {
      var rng = util.makeRng(4051);
      for (var i = 0; i < n; i++) {
        var t = i / sr, v = 0;
        v += (rng.next() * 2 - 1) * (t < 0.02 ? 1 : Math.exp(-(t - 0.02) / 0.14)) * 0.85;
        v += Math.sin(TAU * (140 * Math.exp(-t * 5)) * t) * Math.exp(-t / 0.13) * 0.9;
        v += Math.sin(TAU * 46 * t) * Math.exp(-t / 0.2) * 0.7;
        d[i] = clamp(v, -1, 1);
      }
      lowpass(d, n, 0.25);
    } },

    explosion: { dur: 0.9, gen: function (d, n, sr) {
      var rng = util.makeRng(5077);
      for (var i = 0; i < n; i++) {
        var t = i / sr, v = 0;
        v += (rng.next() * 2 - 1) * Math.exp(-t / 0.24) * 0.9;
        v += Math.sin(TAU * (52 * Math.exp(-t * 3)) * t) * Math.exp(-t / 0.28) * 0.9;
        d[i] = clamp(v, -1, 1);
      }
      lowpass(d, n, 0.07);
    } },

    enemyShoot0: { dur: 0.3, gen: function (d, n, sr) {
      var rng = util.makeRng(6007);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        d[i] = clamp((rng.next() * 2 - 1) * Math.exp(-t / 0.035) * 0.6 +
          Math.sin(TAU * 420 * t) * Math.exp(-t / 0.05) * 0.5, -1, 1);
      }
      lowpass(d, n, 0.05);
    } },

    enemyShoot1: { dur: 0.35, gen: function (d, n, sr) {
      var rng = util.makeRng(6011);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        d[i] = clamp((rng.next() * 2 - 1) * Math.exp(-t / 0.05) * 0.6 +
          Math.sin(TAU * 300 * t) * Math.exp(-t / 0.07) * 0.55, -1, 1);
      }
      lowpass(d, n, 0.04);
    } },

    enemyShoot2: { dur: 0.4, gen: function (d, n, sr) {
      var rng = util.makeRng(6013);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        d[i] = clamp((rng.next() * 2 - 1) * Math.exp(-t / 0.09) * 0.7 +
          Math.sin(TAU * 190 * t) * Math.exp(-t / 0.1) * 0.6, -1, 1);
      }
      lowpass(d, n, 0.03);
    } },

    hitFlesh: { dur: 0.14, gen: function (d, n, sr) {
      var rng = util.makeRng(7001);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        d[i] = clamp((rng.next() * 2 - 1) * Math.exp(-t / 0.03) * 0.7 +
          Math.sin(TAU * 190 * t) * Math.exp(-t / 0.04) * 0.4, -1, 1);
      }
      lowpass(d, n, 0.18);
    } },

    hitArmor: { dur: 0.12, gen: function (d, n, sr) {
      var rng = util.makeRng(7013);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        d[i] = clamp((rng.next() * 2 - 1) * Math.exp(-t / 0.02) * 0.5 +
          Math.sin(TAU * 3100 * t) * Math.exp(-t / 0.03) * 0.6 +
          Math.sin(TAU * 4700 * t) * Math.exp(-t / 0.02) * 0.4, -1, 1);
      }
    } },

    gib: { dur: 0.4, gen: function (d, n, sr) {
      var rng = util.makeRng(7039);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        d[i] = clamp((rng.next() * 2 - 1) * Math.exp(-t / 0.09) * 0.9 +
          Math.sin(TAU * (95 - 40 * t) * t) * Math.exp(-t / 0.11) * 0.7, -1, 1);
      }
      lowpass(d, n, 0.14);
    } },

    pain0: { dur: 0.3, gen: function (d, n, sr) { makePain(d, n, sr, 150, 9001); } },
    pain1: { dur: 0.3, gen: function (d, n, sr) { makePain(d, n, sr, 128, 9007); } },
    pain2: { dur: 0.35, gen: function (d, n, sr) { makePain(d, n, sr, 104, 9013); } },

    pickupHealth: { dur: 0.3, gen: function (d, n, sr) { makePickup(d, n, sr, 440, 11001); } },
    pickupArmor: { dur: 0.3, gen: function (d, n, sr) { makePickup(d, n, sr, 520, 11003); } },
    pickupWeapon: { dur: 0.35, gen: function (d, n, sr) { makePickup(d, n, sr, 660, 11009); } },
    pickupAmmo: { dur: 0.22, gen: function (d, n, sr) { makePickup(d, n, sr, 760, 11017); } },

    door: { dur: 0.9, gen: function (d, n, sr) {
      var rng = util.makeRng(12001);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        var v = (rng.next() * 2 - 1) * 0.5 + Math.sin(TAU * (44 + 30 * t) * t) * 0.5;
        d[i] = clamp(v, -1, 1) * Math.exp(-t / 0.35);
      }
      lowpass(d, n, 0.02);
    } },

    step: { dur: 0.1, gen: function (d, n, sr) {
      noiseHit(d, n, sr, 0.022, 0.6, util.makeRng(13003));
      lowpass(d, n, 0.03);
    } },

    jump: { dur: 0.16, gen: function (d, n, sr) {
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        d[i] = clamp(Math.sin(TAU * (240 + 420 * t) * t) * Math.exp(-t / 0.06), -1, 1) * 0.5;
      }
    } },

    land: { dur: 0.2, gen: function (d, n, sr) {
      var rng = util.makeRng(14009);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        d[i] = clamp((rng.next() * 2 - 1) * Math.exp(-t / 0.03) * 0.6 +
          Math.sin(TAU * 70 * t) * Math.exp(-t / 0.05) * 0.7, -1, 1);
      }
      lowpass(d, n, 0.06);
    } },

    key: { dur: 0.4, gen: function (d, n, sr) {
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        var v = Math.sin(TAU * 880 * t) * 0.4 + Math.sin(TAU * 1320 * t) * 0.3;
        d[i] = clamp(v, -1, 1) * Math.exp(-t / 0.09);
      }
    } },

    spawn: { dur: 0.45, gen: function (d, n, sr) {
      var rng = util.makeRng(15013);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        var v = (rng.next() * 2 - 1) * 0.4 + Math.sin(TAU * (90 + 700 * t) * t) * 0.6;
        d[i] = clamp(v, -1, 1) * Math.exp(-t / 0.2);
      }
      highpass(d, n, 0.01);
    } },

    empty: { dur: 0.08, gen: function (d, n, sr) {
      noiseHit(d, n, sr, 0.012, 0.5, util.makeRng(16001));
      highpass(d, n, 0.05);
    } },

    switchWeapon: { dur: 0.08, gen: function (d, n, sr) {
      noiseHit(d, n, sr, 0.008, 0.45, util.makeRng(16007));
      highpass(d, n, 0.08);
    } },

    win: { dur: 1.6, gen: function (d, n, sr) {
      var notes = [261.6, 329.6, 392.0, 523.3, 659.3, 784.0];
      for (var i = 0; i < n; i++) {
        var t = i / sr, v = 0;
        for (var k = 0; k < notes.length; k++) {
          var tk = t - k * 0.13;
          if (tk > 0) v += Math.sin(TAU * notes[k] * tk) * Math.exp(-tk * 4) * 0.28;
        }
        d[i] = clamp(v, -1, 1);
      }
    } },

    lose: { dur: 1.8, gen: function (d, n, sr) {
      var notes = [392.0, 349.2, 293.7, 196.0];
      for (var i = 0; i < n; i++) {
        var t = i / sr, v = 0;
        for (var k = 0; k < notes.length; k++) {
          var tk = t - k * 0.22;
          if (tk > 0) v += Math.sin(TAU * notes[k] * tk) * Math.exp(-tk * 3) * 0.3;
        }
        d[i] = clamp(v, -1, 1);
      }
      lowpass(d, n, 0.2);
    } }
  };

  function makePain(d, n, sr, f0, seed) {
    var rng = util.makeRng(seed);
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var v = Math.sin(TAU * (f0 - 60 * t) * t) * 0.55 +
        Math.sin(TAU * f0 * 1.5 * t) * 0.25 +
        (rng.next() * 2 - 1) * 0.25;
      d[i] = clamp(v, -1, 1) * Math.exp(-t / 0.11);
    }
    lowpass(d, n, 0.1);
  }

  function makePickup(d, n, sr, base, seed) {
    var rng = util.makeRng(seed);
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var f = base * Math.pow(2, Math.min(1.2, t * 6));
      var v = Math.sin(TAU * f * t) * 0.5 + Math.sin(TAU * f * 2 * t) * 0.2 +
        (rng.next() * 2 - 1) * 0.05;
      d[i] = clamp(v, -1, 1) * Math.exp(-t / 0.11);
    }
  }

  function lowpass(d, n, cutoff) {
    var a = clamp(cutoff, 0.0001, 0.999), prev = 0, i;
    for (i = 0; i < n; i++) { prev = prev + a * (d[i] - prev); d[i] = prev; }
    prev = 0;
    for (i = n - 1; i >= 0; i--) { prev = prev + a * (d[i] - prev); d[i] = prev; }
  }

  function highpass(d, n, cutoff) {
    var a = clamp(cutoff, 0.0001, 0.999), prevIn = 0, prevOut = 0, i, x;
    for (i = 0; i < n; i++) {
      x = d[i];
      prevOut = a * (prevOut + x - prevIn);
      prevIn = x;
      d[i] = prevOut;
    }
  }

  /* ---------------- Audio object ---------------- */

  function Audio() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.7;
    this.cache = {};
    this.ambient = null;
    this.active = 0;
    this.maxConcurrent = 16;
  }

  /* Must be called from a user gesture (click / keydown). */
  Audio.prototype.unlock = function () {
    if (!this.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try { this.ctx = new AC(); } catch (e) { return false; }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      this._buildAmbient();
    }
    if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
    return true;
  };

  Audio.prototype.ready = function () { return !!this.ctx; };

  Audio.prototype.setMuted = function (m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  };

  Audio.prototype._buffer = function (fn, seconds) {
    var ctx = this.ctx;
    var sr = ctx.sampleRate || 44100;
    var n = Math.max(1, Math.ceil(seconds * sr));
    var buf = ctx.createBuffer(1, n, sr);
    var d = buf.getChannelData(0);
    fn(d, n, sr);
    return buf;
  };

  Audio.prototype._get = function (name) {
    var b = this.cache[name];
    if (!b) {
      var g = GEN[name];
      b = this._buffer(g.gen, g.dur);
      this.cache[name] = b;
    }
    return b;
  };

  /* name: logical sound, vol: 0..1, pan: -1..1, rate: pitch multiplier */
  Audio.prototype.play = function (name, vol, pan, rate) {
    if (!this.ctx || this.muted) return;
    if (this.active > this.maxConcurrent) return;
    if (!GEN[name]) return;
    var ctx = this.ctx;
    var buf = this._get(name);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    if (src.playbackRate) src.playbackRate.value = clamp(rate || 1, 0.25, 4);
    var g = ctx.createGain();
    g.gain.value = clamp(vol === undefined ? 1 : vol, 0, 1.5);
    src.connect(g);
    var out = g;
    if (ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      p.pan.value = clamp(pan || 0, -1, 1);
      g.connect(p);
      out = p;
    }
    out.connect(this.master);
    var self = this;
    this.active++;
    src.onended = function () { self.active = Math.max(0, self.active - 1); };
    try { src.start(0); } catch (e) { self.active = Math.max(0, self.active - 1); }
  };

  /* continuous low industrial hum, mixed by combat intensity */
  Audio.prototype._buildAmbient = function () {
    var ctx = this.ctx;
    var g = ctx.createGain();
    g.gain.value = 0;
    g.connect(this.master);

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 190;
    lp.Q.value = 3;

    var osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 41;
    var og = ctx.createGain();
    og.gain.value = 0.10;
    osc.connect(lp); lp.connect(og); og.connect(g);
    osc.start();

    var osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 82.5;
    var og2 = ctx.createGain();
    og2.gain.value = 0.045;
    osc2.connect(og2); og2.connect(g);
    osc2.start();

    var nb = this._buffer(function (d, n, sr) {
      var rng = util.makeRng(4242);
      for (var i = 0; i < n; i++) d[i] = rng.next() * 2 - 1;
      lowpass(d, n, 0.004);
    }, 2.5);
    var ns = ctx.createBufferSource();
    ns.buffer = nb; ns.loop = true;
    var ng = ctx.createGain();
    ng.gain.value = 0.055;
    ns.connect(ng); ng.connect(g);
    ns.start();

    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    var lg = ctx.createGain();
    lg.gain.value = 26;
    lfo.connect(lg); lg.connect(lp.frequency);
    lfo.start();

    this.ambient = { gain: g, lp: lp };
  };

  Audio.prototype.setAmbient = function (on, intensity) {
    if (!this.ambient) return;
    this.ambient.gain.gain.value = on ? 0.5 + 0.35 * clamp(intensity || 0, 0, 1) : 0;
  };

  Q2.sound = new Audio();
})(window.Q2);
