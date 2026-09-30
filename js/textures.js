/*
 * textures.js — every wall/floor/ceiling surface is generated per-pixel at
 * load time from seeded value noise. No image files.
 *
 * Textures are TEX x TEX, seamless (noise is sampled on a torus), and are
 * drawn by the raycaster with drawImage per column.
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;

  var TEX = 64;

  /* build one texture: painter(x, y, u, v) -> [r, g, b] */
  function build(painter, opts) {
    var ctx = util.makeContext2d(TEX, TEX);
    var img = ctx.createImageData(TEX, TEX);
    var d = img.data;
    for (var y = 0; y < TEX; y++) {
      for (var x = 0; x < TEX; x++) {
        var c = painter(x, y, (x + 0.5) / TEX, (y + 0.5) / TEX);
        var i = (y * TEX + x) * 4;
        d[i] = clamp(c[0], 0, 255);
        d[i + 1] = clamp(c[1], 0, 255);
        d[i + 2] = clamp(c[2], 0, 255);
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (opts && opts.draw) opts.draw(ctx);
    ctx.imageSmoothingEnabled = false;
    return ctx.canvas;
  }

  /* speckle + grime applied on top of a base colour */
  function grime(n, amount) {
    return (n - 0.5) * 2 * amount;
  }

  /* ---------------- walls ---------------- */

  function metalWall(seed, base, panel) {
    var rng = util.makeRng(seed);
    var fine = util.makeFbmNoise(rng, 8, 3);
    var big = util.makeValueNoise(rng, TEX, 4);
    return function (x, y, u, v) {
      var n = fine(u, v), b = big(u, v);
      var f = 1 + grime(n, 0.30) + grime(b, 0.22);
      var r = base[0] * f, g = base[1] * f, bl = base[2] * f;
      /* panel seams */
      var sx = x % panel, sy = y % panel;
      if (sx === 0 || sy === 0) { r *= 0.42; g *= 0.42; bl *= 0.42; }
      if (sx === 1 || sy === 1) { r *= 0.7; g *= 0.7; bl *= 0.7; }
      if (sx === panel - 1 || sy === panel - 1) { r *= 1.22; g *= 1.22; bl *= 1.22; }
      /* rivets at panel corners */
      var rx = Math.min(sx, panel - sx), ry = Math.min(sy, panel - sy);
      if (rx < 3 && ry < 3) {
        var dd = rx * rx + ry * ry;
        if (dd < 6) { var k = 1.5 - dd * 0.09; r *= k; g *= k; bl *= k; }
      }
      return [r, g, bl];
    };
  }

  function techWall(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 3);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.26);
      var r = 58 * f, g = 66 * f, b = 82 * f;
      /* vertical conduit channels */
      var c = x % 16;
      if (c > 4 && c < 11) {
        r = 34 * f; g = 38 * f; b = 48 * f;
        if (c === 5 || c === 10) { r = 92 * f; g = 98 * f; b = 112 * f; }
      }
      /* glowing conduit studs */
      if (c === 7 && (y % 8) < 3) { r = 120; g = 220; b = 255; }
      /* horizontal band */
      if (y % 32 === 0) { r = 12; g = 12; b = 16; }
      if (y % 32 === 20) { r *= 1.3; g *= 1.3; b *= 1.3; }
      return [r, g, b];
    };
  }

  function stoneWall(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 4);
    var m = util.makeValueNoise(rng, TEX, 16);
    return function (x, y, u, v) {
      var row = Math.floor(y / 8);
      var off = (row % 2) * 8;
      var bx = ((x + off) % 16);
      var by = y % 8;
      var f = 1 + grime(n(u, v), 0.34);
      var mortar = (bx === 0 || by === 0);
      var r = 96 * f, g = 92 * f, b = 86 * f;
      if (mortar) { r = 44; g = 42; b = 40; }
      else if (bx === 1 || by === 1) { r *= 1.18; g *= 1.18; b *= 1.18; }
      var sp = m(u, v);
      if (sp > 0.86) { r *= 1.3; g *= 1.3; b *= 1.25; }
      return [r, g, b];
    };
  }

  function brickWall(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 3);
    return function (x, y, u, v) {
      var row = Math.floor(y / 6);
      var off = (row % 2) * 10;
      var bx = (x + off) % 20, by = y % 6;
      var f = 1 + grime(n(u, v), 0.3);
      var edge = (bx === 0 || by === 0);
      var r = (edge ? 30 : 118) * f, g = (edge ? 26 : 62) * f, b = (edge ? 24 : 48) * f;
      return [r, g, b];
    };
  }

  function hazardWall(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 2);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.22);
      /* dark base with a diagonal striped band across the middle */
      var band = y > 20 && y < 44;
      if (!band) return [46 * f, 48 * f, 54 * f];
      var s = ((x + y) % 12);
      if (s < 6) return [clamp(196 * f, 0, 255), clamp(168 * f, 0, 255), 30];
      return [26 * f, 24 * f, 22 * f];
    };
  }

  function computerWall(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 3);
    var r2 = util.makeValueNoise(rng, TEX, 32);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.2);
      var r = 30 * f, g = 33 * f, b = 40 * f;
      if (x % 32 < 2 || y % 16 === 0) { r = 12; g = 12; b = 16; }
      /* screens */
      var cx = x % 32, cy = y % 16;
      if (cx > 5 && cx < 26 && cy > 3 && cy < 13) {
        var flick = r2(u * 2, v * 2);
        var on = ((x * 7 + y * 13) % 11) < 6;
        if (on) { r = 40 + flick * 60; g = 200 + flick * 55; b = 120 + flick * 60; }
        else { r = 12; g = 40; b = 26; }
      }
      return [r, g, b];
    };
  }

  function doorWall(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 2);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.2);
      var r = 92 * f, g = 78 * f, b = 52 * f;
      /* centre seam */
      var d = Math.abs(x - 32);
      if (d < 2) { r = 18; g = 16; b = 12; }
      if (d === 2) { r *= 1.35; g *= 1.35; b *= 1.35; }
      /* frame */
      if (y < 3 || y > 60) { r = 40 * f; g = 36 * f; b = 30 * f; }
      /* warning plate */
      if (x > 22 && x < 42 && y > 26 && y < 34) {
        var s = (x + y) % 8;
        if (s < 4) { r = 200; g = 170; b = 40; } else { r = 30; g = 28; b = 26; }
      }
      /* edge lights */
      if ((x === 6 || x === 57) && y > 12 && y < 52 && (y % 6) < 3) { r = 255; g = 90; b = 40; }
      return [r, g, b];
    };
  }

  function exitWall(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 3);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.15);
      var r = 24 * f, g = 26 * f, b = 34 * f;
      /* portal: bright vertical energy slot */
      var d = Math.abs(x - 32);
      if (y > 6 && d < 12) {
        var t = 1 - d / 12;
        var pulse = 0.75 + 0.25 * Math.sin(y * 0.4);
        r = 60 + 190 * t * pulse;
        g = 230 * t * pulse + 20;
        b = 120 + 130 * t * pulse;
      }
      /* frame chevrons */
      if (d >= 12 && d < 15) {
        var on = ((y + (d > 13 ? 4 : 0)) % 10) < 5;
        r = on ? 250 : 60; g = on ? 200 : 60; b = on ? 60 : 60;
      }
      return [r, g, b];
    };
  }

  function pipeWall(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 3);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.3);
      var r = 70 * f, g = 72 * f, b = 78 * f;
      /* three chunky vertical pipes */
      var pipes = [12, 32, 52];
      for (var i = 0; i < pipes.length; i++) {
        var d = Math.abs(x - pipes[i]);
        if (d < 6) {
          var k = 1 - d / 6;
          r = 60 + 150 * k * f; g = 62 + 140 * k * f; b = 70 + 150 * k * f;
          if (d > 4.4) { r = 20; g = 20; b = 24; }
          if (y % 16 < 2) { r *= 0.5; g *= 0.5; b *= 0.5; }
        }
      }
      return [r, g, b];
    };
  }

  function fleshWall(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 4);
    var m = util.makeValueNoise(rng, TEX, 12);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.4);
      var veins = Math.abs(Math.sin((x * 0.3 + y * 0.2) + m(u, v) * 6));
      var r = 108 * f, g = 34 * f, b = 40 * f;
      if (veins < 0.12) { r = 170; g = 60; b = 60; }
      var p = m(u, v);
      if (p > 0.8) { r *= 1.25; g *= 0.8; b *= 0.8; }
      return [r, g, b];
    };
  }

  /* ---------------- floors / ceilings ---------------- */

  function floorTile(seed, a, bcol) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 3);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.34);
      var tile = ((Math.floor(x / 16) + Math.floor(y / 16)) % 2) === 0;
      var c = tile ? a : bcol;
      var r = c[0] * f, g = c[1] * f, bl = c[2] * f;
      var gx = x % 16, gy = y % 16;
      if (gx === 0 || gy === 0) { r *= 0.45; g *= 0.45; bl *= 0.45; }
      return [r, g, bl];
    };
  }

  function floorGrate(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 2);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.25);
      var slot = y % 8;
      var r, g, b;
      if (slot < 3) { r = 16 * f; g = 17 * f; b = 20 * f; }
      else { r = 86 * f; g = 88 * f; b = 96 * f; }
      if (x % 16 === 0) { r *= 0.5; g *= 0.5; b *= 0.5; }
      return [r, g, b];
    };
  }

  function floorLava(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 4, 4);
    var m = util.makeValueNoise(rng, TEX, 8);
    return function (x, y, u, v) {
      var t = n(u, v) * 0.7 + m(u, v) * 0.3;
      var k = clamp((t - 0.35) * 3.2, 0, 1);
      var from, to, f;
      if (k < 0.55) { from = [26, 16, 14]; to = [255, 150, 30]; f = k / 0.55; }
      else { from = [255, 150, 30]; to = [255, 240, 150]; f = (k - 0.55) / 0.45; }
      return [util.lerp(from[0], to[0], f), util.lerp(from[1], to[1], f), util.lerp(from[2], to[2], f)];
    };
  }

  function ceilPanel(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 2);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.3);
      var r = 34 * f, g = 36 * f, b = 42 * f;
      if (x % 32 === 0 || y % 32 === 0) { r = 14; g = 14; b = 18; }
      return [r, g, b];
    };
  }

  function ceilLight(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 2);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.2);
      var r = 36 * f, g = 38 * f, b = 44 * f;
      if (x % 32 === 0 || y % 32 === 0) { r = 14; g = 14; b = 18; }
      var cx = x % 32, cy = y % 32;
      if (cx > 8 && cx < 24 && cy > 8 && cy < 24) {
        var d = Math.max(Math.abs(cx - 16), Math.abs(cy - 16)) / 8;
        var k = clamp(1 - d, 0, 1);
        r = 40 + 215 * k; g = 45 + 210 * k; b = 40 + 170 * k;
      }
      return [r, g, b];
    };
  }

  function floorTech(seed) {
    var rng = util.makeRng(seed);
    var n = util.makeFbmNoise(rng, 8, 3);
    return function (x, y, u, v) {
      var f = 1 + grime(n(u, v), 0.3);
      var r = 48 * f, g = 52 * f, b = 60 * f;
      if (x % 32 === 0 || y % 32 === 0) { r = 22; g = 24; b = 28; }
      if ((x % 32 === 1) || (y % 32 === 1)) { r *= 1.4; g *= 1.4; b *= 1.4; }
      var cx = x % 32, cy = y % 32;
      if (cx > 14 && cx < 18 && cy > 14 && cy < 18) { r = 90; g = 200; b = 210; }
      return [r, g, b];
    };
  }

  /* ---------------- registry ---------------- */

  /* kind: 'wall' | 'floor' | 'ceil'; emissive surfaces ignore distance shading */
  function makeSet() {
    var T = {};
    function add(name, canvas, opts) {
      T[name] = {
        canvas: canvas,
        emissive: !!(opts && opts.emissive),
        light: (opts && opts.light) || 0,
        kind: (opts && opts.kind) || 'wall'
      };
    }

    add('metal', build(metalWall(11, [74, 80, 92], 32)));
    add('metalDark', build(metalWall(23, [46, 48, 58], 16)));
    add('metalRust', build(metalWall(37, [96, 70, 52], 32)));
    add('tech', build(techWall(53)));
    add('stone', build(stoneWall(71)));
    add('brick', build(brickWall(89)));
    add('hazard', build(hazardWall(97)));
    add('computer', build(computerWall(103), { emissive: true, light: 0.25 }));
    add('door', build(doorWall(113)));
    add('exit', build(exitWall(127), { emissive: true, light: 0.9 }));
    add('pipe', build(pipeWall(131)));
    add('flesh', build(fleshWall(139)));
    add('trim', build(metalWall(149, [120, 108, 74], 8)));

    add('tileFloor', build(floorTile(151, [88, 88, 96], [58, 58, 66]), { kind: 'floor' }));
    add('grateFloor', build(floorGrate(157), { kind: 'floor' }));
    add('lavaFloor', build(floorLava(163), { kind: 'floor', emissive: true, light: 1.0 }));
    add('techFloor', build(floorTech(167), { kind: 'floor' }));
    add('stoneFloor', build(floorTile(173, [64, 60, 56], [46, 44, 42]), { kind: 'floor' }));

    add('ceilPanel', build(ceilPanel(179), { kind: 'ceil' }));
    add('ceilLight', build(ceilLight(181), { kind: 'ceil', emissive: true, light: 0.75 }));

    return T;
  }

  Q2.textures = {
    TEX: TEX,
    /* built on first touch so the loading bar can paint before it */
    get set() {
      if (!this._set) this._set = makeSet();
      return this._set;
    },
    /* deterministic pick from a list, used by the map generator */
    pick: function (list, rng) { return list[rng.int(0, list.length - 1)]; }
  };
})(window.Q2);
