/*
 * art.js — every visible creature, item, gun and effect is drawn at load time
 * with Canvas2D primitives into offscreen canvases. No image files.
 *
 * Convention: sprites are W x H canvases, the subject stands on the bottom
 * edge and faces the camera. Organic shapes get a directional "overlay"
 * lighting pass so they read as 3D-ish against the raycast world.
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;
  var rgb = util.rgb, rgba = util.rgba;

  /* ---------------- drawing helpers ---------------- */

  function canvas(w, h) { return util.makeCanvas(w, h); }

  function circle(ctx, x, y, r, c) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function ell(ctx, x, y, rx, ry, c, rot) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.4, rx), Math.max(0.4, ry), rot || 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function ellLine(ctx, x, y, rx, ry, c, lw, rot) {
    ctx.strokeStyle = c;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.4, rx), Math.max(0.4, ry), rot || 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  function rect(ctx, x, y, w, h, c) {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  }

  function roundRect(ctx, x, y, w, h, r, c) {
    ctx.fillStyle = c;
    ctx.beginPath();
    var rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
    ctx.fill();
  }

  function capsule(ctx, x1, y1, x2, y2, r1, r2, c) {
    var a = Math.atan2(y2 - y1, x2 - x1);
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x1, y1, Math.max(0.4, r1), a + Math.PI / 2, a - Math.PI / 2);
    ctx.arc(x2, y2, Math.max(0.4, r2), a - Math.PI / 2, a + Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  }

  function poly(ctx, pts, c) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  }

  function line(ctx, x1, y1, x2, y2, c, lw) {
    ctx.strokeStyle = c;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  /* irregular organic blob */
  function blob(ctx, x, y, rx, ry, c, wob, seed) {
    var rng = util.makeRng(seed || 1);
    var n = 12;
    ctx.fillStyle = c;
    ctx.beginPath();
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * Math.PI * 2;
      var k = 1 + (rng.next() - 0.5) * wob;
      var px = x + Math.cos(a) * rx * k, py = y + Math.sin(a) * ry * k;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  function glow(ctx, x, y, r, c1, c2) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, r));
    g.addColorStop(0, c1);
    g.addColorStop(1, c2 || 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
    ctx.fill();
  }

  /* directional lighting pass, masked to the sprite silhouette */
  function shade(cnv, strength) {
    var ctx = cnv.getContext('2d');
    var w = cnv.width, h = cnv.height;
    var lc = canvas(w, h);
    var l = lc.getContext('2d');
    var g = l.createLinearGradient(-w * 0.15, -h * 0.2, w * 0.9, h * 1.1);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(176,178,186,1)');
    g.addColorStop(1, 'rgba(26,26,38,1)');
    l.fillStyle = g;
    l.fillRect(0, 0, w, h);
    l.globalCompositeOperation = 'destination-in';
    l.drawImage(cnv, 0, 0);
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = clamp(strength, 0, 1);
    ctx.drawImage(lc, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /* darken the bottom of a sprite so feet sit in the floor shadow */
  function groundShadow(cnv, alpha) {
    var ctx = cnv.getContext('2d');
    var w = cnv.width, h = cnv.height;
    var lc = canvas(w, h);
    var l = lc.getContext('2d');
    var g = l.createLinearGradient(0, h, 0, h * 0.6);
    g.addColorStop(0, 'rgba(0,0,0,' + (alpha === undefined ? 0.75 : alpha) + ')');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    l.fillStyle = g;
    l.fillRect(0, 0, w, h);
    l.globalCompositeOperation = 'destination-in';
    l.drawImage(cnv, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(lc, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  function finish(cnv, opts) {
    if (!opts || opts.shade !== 0) shade(cnv, (opts && opts.shade) || 0.55);
    if (!opts || opts.shadow !== 0) groundShadow(cnv, opts && opts.shadowAlpha);
    return cnv;
  }

  /* ---------------- monsters ----------------
   * Each builder draws one animation frame (0 = idle, 1..n = walk cycle).
   */

  var MON = {};

  /* --- grunt: small green imp, one big eye, claws --- */
  MON.grunt = {
    size: 64, worldW: 0.62, worldH: 0.92, frames: 4,
    draw: function (ctx, S, f) {
      var cx = S / 2, g = S * 0.06;
      var bob = Math.sin(f * Math.PI / 2) * S * 0.02;
      var legA = Math.sin(f * Math.PI / 2) * S * 0.09;
      var body = [96, 140, 66], dark = [52, 78, 40], light = [140, 186, 96];
      /* legs */
      capsule(ctx, cx - S * 0.10, S * 0.62, cx - S * 0.12 - legA, S - g, S * 0.055, S * 0.05, rgb(dark[0], dark[1], dark[2]));
      capsule(ctx, cx + S * 0.10, S * 0.62, cx + S * 0.12 + legA, S - g, S * 0.055, S * 0.05, rgb(dark[0], dark[1], dark[2]));
      ell(ctx, cx - S * 0.13 - legA, S - g * 0.7, S * 0.07, S * 0.035, rgb(dark[0], dark[1], dark[2]));
      ell(ctx, cx + S * 0.13 + legA, S - g * 0.7, S * 0.07, S * 0.035, rgb(dark[0], dark[1], dark[2]));
      /* arms + claws */
      var ar = Math.sin(f * Math.PI / 2 + 1) * S * 0.05;
      capsule(ctx, cx - S * 0.20, S * 0.40 + bob, cx - S * 0.30, S * 0.60 + ar, S * 0.045, S * 0.035, rgb(body[0] * 0.8, body[1] * 0.8, body[2] * 0.8));
      capsule(ctx, cx + S * 0.20, S * 0.40 + bob, cx + S * 0.30, S * 0.60 - ar, S * 0.045, S * 0.035, rgb(body[0] * 0.8, body[1] * 0.8, body[2] * 0.8));
      for (var s = -1; s <= 1; s += 2) {
        var hx = cx + s * S * 0.30, hy = S * 0.62 + (s > 0 ? -ar : ar);
        for (var k = 0; k < 3; k++) {
          line(ctx, hx, hy, hx + s * S * 0.05 + (k - 1) * S * 0.025, hy + S * 0.07, '#e8e6d8', Math.max(1, S * 0.012));
        }
      }
      /* torso */
      blob(ctx, cx, S * 0.50 + bob, S * 0.21, S * 0.24, rgb(body[0], body[1], body[2]), 0.10, 7);
      blob(ctx, cx, S * 0.44 + bob, S * 0.14, S * 0.14, rgb(light[0], light[1], light[2]), 0.14, 11);
      /* spikes */
      poly(ctx, [[cx - S * 0.16, S * 0.34 + bob], [cx - S * 0.22, S * 0.20 + bob], [cx - S * 0.08, S * 0.30 + bob]], '#3c2a1e');
      poly(ctx, [[cx + S * 0.16, S * 0.34 + bob], [cx + S * 0.22, S * 0.20 + bob], [cx + S * 0.08, S * 0.30 + bob]], '#3c2a1e');
      /* head */
      blob(ctx, cx, S * 0.26 + bob, S * 0.17, S * 0.15, rgb(body[0] * 1.1, body[1] * 1.1, body[2] * 1.1), 0.08, 21);
      /* single eye */
      ell(ctx, cx, S * 0.25 + bob, S * 0.085, S * 0.07, '#f4f2e6');
      circle(ctx, cx + S * 0.01, S * 0.255 + bob, S * 0.042, '#1a0d0d');
      circle(ctx, cx + S * 0.026, S * 0.24 + bob, S * 0.014, '#ffffff');
      /* mouth */
      ell(ctx, cx, S * 0.345 + bob, S * 0.07, S * 0.028, '#2a0f12');
      for (var t = 0; t < 5; t++) {
        line(ctx, cx - S * 0.06 + t * S * 0.03, S * 0.32 + bob, cx - S * 0.055 + t * S * 0.03, S * 0.345 + bob, '#e8e6d8', Math.max(1, S * 0.008));
      }
    }
  };

  /* --- soldier: armoured grunt with a gun --- */
  MON.soldier = {
    size: 64, worldW: 0.72, worldH: 1.12, frames: 4,
    draw: function (ctx, S, f) {
      var cx = S / 2, g = S * 0.05;
      var legA = Math.sin(f * Math.PI / 2) * S * 0.08;
      var steel = [104, 112, 128], dark = [52, 56, 68], hi = [168, 178, 196];
      /* legs */
      capsule(ctx, cx - S * 0.10, S * 0.66, cx - S * 0.11 - legA, S - g, S * 0.06, S * 0.05, rgb(dark[0], dark[1], dark[2]));
      capsule(ctx, cx + S * 0.10, S * 0.66, cx + S * 0.11 + legA, S - g, S * 0.06, S * 0.05, rgb(dark[0], dark[1], dark[2]));
      rect(ctx, cx - S * 0.19 - legA, S - g * 1.2, S * 0.15, S * 0.05, rgb(hi[0] * 0.6, hi[1] * 0.6, hi[2] * 0.6));
      rect(ctx, cx + S * 0.05 + legA, S - g * 1.2, S * 0.15, S * 0.05, rgb(hi[0] * 0.6, hi[1] * 0.6, hi[2] * 0.6));
      /* torso plate */
      poly(ctx, [[cx - S * 0.20, S * 0.36], [cx + S * 0.20, S * 0.36], [cx + S * 0.16, S * 0.72], [cx - S * 0.16, S * 0.72]], rgb(steel[0], steel[1], steel[2]));
      poly(ctx, [[cx - S * 0.10, S * 0.40], [cx + S * 0.10, S * 0.40], [cx + S * 0.06, S * 0.66], [cx - S * 0.06, S * 0.66]], rgb(dark[0] + 14, dark[1] + 14, dark[2] + 14));
      /* shoulder pads */
      ell(ctx, cx - S * 0.22, S * 0.38, S * 0.10, S * 0.075, rgb(hi[0], hi[1], hi[2]));
      ell(ctx, cx + S * 0.22, S * 0.38, S * 0.10, S * 0.075, rgb(hi[0], hi[1], hi[2]));
      /* arms holding a gun across the chest */
      capsule(ctx, cx - S * 0.22, S * 0.42, cx - S * 0.06, S * 0.56, S * 0.05, S * 0.04, rgb(steel[0] * 0.8, steel[1] * 0.8, steel[2] * 0.8));
      capsule(ctx, cx + S * 0.22, S * 0.42, cx + S * 0.10, S * 0.56, S * 0.05, S * 0.04, rgb(steel[0] * 0.8, steel[1] * 0.8, steel[2] * 0.8));
      rect(ctx, cx - S * 0.16, S * 0.52, S * 0.34, S * 0.055, '#2c2e34');
      rect(ctx, cx + S * 0.10, S * 0.50, S * 0.10, S * 0.09, '#3a3d45');
      circle(ctx, cx + S * 0.20, S * 0.545, S * 0.028, '#0d0e10');
      /* helmet */
      blob(ctx, cx, S * 0.26, S * 0.15, S * 0.14, rgb(steel[0] * 1.05, steel[1] * 1.05, steel[2] * 1.05), 0.05, 33);
      rect(ctx, cx - S * 0.13, S * 0.24, S * 0.26, S * 0.045, '#12141a');
      ell(ctx, cx - S * 0.05, S * 0.262, S * 0.035, S * 0.016, '#ff5a3c');
      ell(ctx, cx + S * 0.05, S * 0.262, S * 0.035, S * 0.016, '#ff5a3c');
      /* crest */
      poly(ctx, [[cx, S * 0.10], [cx + S * 0.03, S * 0.22], [cx - S * 0.03, S * 0.22]], rgb(hi[0], hi[1], hi[2]));
    }
  };

  /* --- hound: low quadruped, glowing jaw --- */
  MON.hound = {
    size: 64, worldW: 0.95, worldH: 0.72, frames: 4,
    draw: function (ctx, S, f) {
      var cx = S / 2, g = S * 0.06;
      var legA = Math.sin(f * Math.PI / 2) * S * 0.10;
      var hide = [126, 62, 48], dark = [70, 32, 26];
      /* back legs */
      capsule(ctx, cx - S * 0.24, S * 0.52, cx - S * 0.26 - legA, S - g, S * 0.05, S * 0.04, rgb(dark[0], dark[1], dark[2]));
      capsule(ctx, cx + S * 0.24, S * 0.52, cx + S * 0.26 + legA, S - g, S * 0.05, S * 0.04, rgb(dark[0], dark[1], dark[2]));
      /* body */
      blob(ctx, cx, S * 0.50, S * 0.32, S * 0.19, rgb(hide[0], hide[1], hide[2]), 0.12, 5);
      /* front legs */
      capsule(ctx, cx - S * 0.16, S * 0.56, cx - S * 0.18 + legA, S - g, S * 0.055, S * 0.045, rgb(hide[0] * 0.85, hide[1] * 0.85, hide[2] * 0.85));
      capsule(ctx, cx + S * 0.16, S * 0.56, cx + S * 0.18 - legA, S - g, S * 0.055, S * 0.045, rgb(hide[0] * 0.85, hide[1] * 0.85, hide[2] * 0.85));
      /* spine spikes */
      for (var i = 0; i < 5; i++) {
        var px = cx - S * 0.20 + i * S * 0.10;
        poly(ctx, [[px, S * 0.36], [px + S * 0.045, S * 0.36], [px + S * 0.02, S * 0.20 - Math.abs(i - 2) * S * 0.02]], '#241a16');
      }
      /* head, low and wide, jaws open */
      blob(ctx, cx, S * 0.40, S * 0.20, S * 0.15, rgb(hide[0] * 1.1, hide[1] * 1.1, hide[2] * 1.1), 0.09, 9);
      poly(ctx, [[cx - S * 0.17, S * 0.44], [cx + S * 0.17, S * 0.44], [cx + S * 0.12, S * 0.60], [cx - S * 0.12, S * 0.60]], '#2a0d10');
      for (var t = 0; t < 7; t++) {
        var tx = cx - S * 0.15 + t * S * 0.05;
        poly(ctx, [[tx, S * 0.44], [tx + S * 0.035, S * 0.44], [tx + S * 0.017, S * 0.53]], '#efe9d6');
        poly(ctx, [[tx, S * 0.60], [tx + S * 0.035, S * 0.60], [tx + S * 0.017, S * 0.51]], '#efe9d6');
      }
      /* eyes */
      glow(ctx, cx - S * 0.09, S * 0.31, S * 0.07, 'rgba(255,120,40,0.9)');
      glow(ctx, cx + S * 0.09, S * 0.31, S * 0.07, 'rgba(255,120,40,0.9)');
      circle(ctx, cx - S * 0.09, S * 0.31, S * 0.026, '#ffd08a');
      circle(ctx, cx + S * 0.09, S * 0.31, S * 0.026, '#ffd08a');
    }
  };

  /* --- mage: floating caster, staff with plasma orb --- */
  MON.mage = {
    size: 64, worldW: 0.70, worldH: 1.28, frames: 4,
    draw: function (ctx, S, f) {
      var cx = S / 2;
      var fl = Math.sin(f * Math.PI / 2) * S * 0.03;
      var robe = [58, 40, 92], dark = [30, 20, 52], trim = [176, 150, 240];
      /* robe */
      poly(ctx, [[cx - S * 0.09, S * 0.26], [cx + S * 0.09, S * 0.26], [cx + S * 0.26, S * 0.92 + fl], [cx - S * 0.26, S * 0.92 + fl]], rgb(robe[0], robe[1], robe[2]));
      for (var i = 0; i < 4; i++) {
        var t = i / 3;
        line(ctx, cx - S * 0.08 + t * S * 0.16, S * 0.30, cx - S * 0.22 + t * S * 0.44, S * 0.90 + fl, rgb(dark[0], dark[1], dark[2]), Math.max(1, S * 0.012));
      }
      /* hem glow */
      ell(ctx, cx, S * 0.92 + fl, S * 0.26, S * 0.03, rgb(trim[0] * 0.5, trim[1] * 0.5, trim[2] * 0.6));
      /* hood */
      blob(ctx, cx, S * 0.20 + fl * 0.5, S * 0.14, S * 0.16, rgb(robe[0] * 1.1, robe[1] * 1.1, robe[2] * 1.1), 0.06, 17);
      ell(ctx, cx, S * 0.22 + fl * 0.5, S * 0.095, S * 0.11, '#08060e');
      /* eyes inside hood */
      glow(ctx, cx - S * 0.035, S * 0.21 + fl * 0.5, S * 0.05, 'rgba(150,255,220,0.95)');
      glow(ctx, cx + S * 0.035, S * 0.21 + fl * 0.5, S * 0.05, 'rgba(150,255,220,0.95)');
      /* sleeve arms */
      capsule(ctx, cx + S * 0.10, S * 0.36, cx + S * 0.26, S * 0.30 - fl, S * 0.05, S * 0.04, rgb(robe[0], robe[1], robe[2]));
      /* staff */
      line(ctx, cx + S * 0.28, S * 0.16 - fl, cx + S * 0.28, S * 0.86, '#4a3a28', Math.max(1.5, S * 0.022));
      glow(ctx, cx + S * 0.28, S * 0.14 - fl, S * 0.13, 'rgba(120,255,230,0.95)', 'rgba(40,180,190,0)');
      circle(ctx, cx + S * 0.28, S * 0.14 - fl, S * 0.05, '#d8fff8');
      /* casting hand sparks */
      if (f === 2 || f === 3) {
        glow(ctx, cx - S * 0.16, S * 0.42, S * 0.10, 'rgba(200,140,255,0.9)');
      }
      capsule(ctx, cx - S * 0.10, S * 0.36, cx - S * 0.18, S * 0.44 + fl, S * 0.05, S * 0.04, rgb(robe[0], robe[1], robe[2]));
    }
  };

  /* --- fiend: hulking two-headed bruiser --- */
  MON.fiend = {
    size: 72, worldW: 1.15, worldH: 1.30, frames: 4,
    draw: function (ctx, S, f) {
      var cx = S / 2, g = S * 0.05;
      var legA = Math.sin(f * Math.PI / 2) * S * 0.07;
      var hide = [150, 58, 44], dark = [86, 30, 24], pale = [206, 128, 96];
      /* legs */
      capsule(ctx, cx - S * 0.14, S * 0.66, cx - S * 0.16 - legA, S - g, S * 0.075, S * 0.06, rgb(dark[0], dark[1], dark[2]));
      capsule(ctx, cx + S * 0.14, S * 0.66, cx + S * 0.16 + legA, S - g, S * 0.075, S * 0.06, rgb(dark[0], dark[1], dark[2]));
      /* torso */
      blob(ctx, cx, S * 0.48, S * 0.30, S * 0.26, rgb(hide[0], hide[1], hide[2]), 0.10, 3);
      blob(ctx, cx, S * 0.44, S * 0.20, S * 0.16, rgb(pale[0], pale[1], pale[2]), 0.14, 8);
      /* ribs */
      for (var i = 0; i < 4; i++) {
        ellLine(ctx, cx, S * 0.40 + i * S * 0.05, S * 0.16 - i * S * 0.01, S * 0.022, rgba(60, 20, 16, 0.7), Math.max(1, S * 0.012));
      }
      /* arms */
      var ar = Math.sin(f * Math.PI / 2) * S * 0.06;
      capsule(ctx, cx - S * 0.28, S * 0.34, cx - S * 0.40, S * 0.62 + ar, S * 0.08, S * 0.06, rgb(hide[0] * 0.9, hide[1] * 0.9, hide[2] * 0.9));
      capsule(ctx, cx + S * 0.28, S * 0.34, cx + S * 0.40, S * 0.62 - ar, S * 0.08, S * 0.06, rgb(hide[0] * 0.9, hide[1] * 0.9, hide[2] * 0.9));
      for (var s = -1; s <= 1; s += 2) {
        var hx = cx + s * S * 0.40, hy = S * 0.64 + (s > 0 ? -ar : ar);
        for (var k = 0; k < 4; k++) {
          line(ctx, hx, hy, hx + s * S * 0.06 + (k - 1.5) * S * 0.026, hy + S * 0.09, '#f2ecd8', Math.max(1, S * 0.014));
        }
      }
      /* two heads */
      for (var h = 0; h < 2; h++) {
        var hx2 = cx + (h === 0 ? -S * 0.13 : S * 0.13);
        blob(ctx, hx2, S * 0.22, S * 0.13, S * 0.12, rgb(hide[0] * 1.05, hide[1] * 1.05, hide[2] * 1.05), 0.09, 30 + h);
        /* horn */
        poly(ctx, [[hx2 - S * 0.06, S * 0.14], [hx2 - S * 0.12, S * 0.02], [hx2 - S * 0.02, S * 0.12]], '#d8cdb4');
        poly(ctx, [[hx2 + S * 0.06, S * 0.14], [hx2 + S * 0.12, S * 0.02], [hx2 + S * 0.02, S * 0.12]], '#d8cdb4');
        circle(ctx, hx2 - S * 0.04, S * 0.20, S * 0.022, '#ffe07a');
        circle(ctx, hx2 + S * 0.04, S * 0.20, S * 0.022, '#ffe07a');
        ell(ctx, hx2, S * 0.29, S * 0.08, S * 0.035, '#28080c');
        for (var t = 0; t < 4; t++) {
          line(ctx, hx2 - S * 0.06 + t * S * 0.04, S * 0.262, hx2 - S * 0.055 + t * S * 0.04, S * 0.295, '#f2ecd8', Math.max(1, S * 0.01));
        }
      }
    }
  };

  /* --- boss: armored overlord with a glowing core --- */
  MON.boss = {
    size: 96, worldW: 1.70, worldH: 2.00, frames: 4,
    draw: function (ctx, S, f) {
      var cx = S / 2, g = S * 0.04;
      var legA = Math.sin(f * Math.PI / 2) * S * 0.05;
      var plate = [64, 66, 80], dark = [28, 28, 38], hi = [120, 126, 148];
      /* legs */
      capsule(ctx, cx - S * 0.14, S * 0.68, cx - S * 0.16 - legA, S - g, S * 0.08, S * 0.07, rgb(dark[0], dark[1], dark[2]));
      capsule(ctx, cx + S * 0.14, S * 0.68, cx + S * 0.16 + legA, S - g, S * 0.08, S * 0.07, rgb(dark[0], dark[1], dark[2]));
      rect(ctx, cx - S * 0.26 - legA, S - g * 1.4, S * 0.20, S * 0.06, rgb(hi[0] * 0.7, hi[1] * 0.7, hi[2] * 0.7));
      rect(ctx, cx + S * 0.06 + legA, S - g * 1.4, S * 0.20, S * 0.06, rgb(hi[0] * 0.7, hi[1] * 0.7, hi[2] * 0.7));
      /* torso */
      poly(ctx, [[cx - S * 0.26, S * 0.30], [cx + S * 0.26, S * 0.30], [cx + S * 0.20, S * 0.74], [cx - S * 0.20, S * 0.74]], rgb(plate[0], plate[1], plate[2]));
      poly(ctx, [[cx - S * 0.14, S * 0.34], [cx + S * 0.14, S * 0.34], [cx + S * 0.10, S * 0.70], [cx - S * 0.10, S * 0.70]], rgb(dark[0] + 8, dark[1] + 8, dark[2] + 10));
      /* core */
      glow(ctx, cx, S * 0.48, S * 0.16, 'rgba(255,180,60,0.95)', 'rgba(255,60,20,0)');
      circle(ctx, cx, S * 0.48, S * 0.07, '#ffe6a8');
      ellLine(ctx, cx, S * 0.48, S * 0.10, S * 0.10, '#ff9a3c', Math.max(1.5, S * 0.014));
      /* pauldrons */
      ell(ctx, cx - S * 0.30, S * 0.32, S * 0.14, S * 0.11, rgb(hi[0], hi[1], hi[2]));
      ell(ctx, cx + S * 0.30, S * 0.32, S * 0.14, S * 0.11, rgb(hi[0], hi[1], hi[2]));
      poly(ctx, [[cx - S * 0.40, S * 0.28], [cx - S * 0.50, S * 0.10], [cx - S * 0.30, S * 0.24]], '#c8ccd8');
      poly(ctx, [[cx + S * 0.40, S * 0.28], [cx + S * 0.50, S * 0.10], [cx + S * 0.30, S * 0.24]], '#c8ccd8');
      /* arms */
      var ar = Math.sin(f * Math.PI / 2) * S * 0.05;
      capsule(ctx, cx - S * 0.30, S * 0.40, cx - S * 0.36, S * 0.66 + ar, S * 0.07, S * 0.06, rgb(plate[0] * 0.9, plate[1] * 0.9, plate[2] * 0.9));
      capsule(ctx, cx + S * 0.30, S * 0.40, cx + S * 0.36, S * 0.66 - ar, S * 0.07, S * 0.06, rgb(plate[0] * 0.9, plate[1] * 0.9, plate[2] * 0.9));
      /* cannon arm */
      rect(ctx, cx + S * 0.28, S * 0.60 - ar, S * 0.18, S * 0.10, '#22242c');
      circle(ctx, cx + S * 0.48, S * 0.65 - ar, S * 0.045, '#0a0b10');
      /* helmet with horns */
      blob(ctx, cx, S * 0.22, S * 0.15, S * 0.13, rgb(plate[0] * 1.2, plate[1] * 1.2, plate[2] * 1.2), 0.05, 41);
      rect(ctx, cx - S * 0.13, S * 0.20, S * 0.26, S * 0.05, '#0a0a10');
      glow(ctx, cx - S * 0.06, S * 0.22, S * 0.06, 'rgba(255,60,60,0.95)');
      glow(ctx, cx + S * 0.06, S * 0.22, S * 0.06, 'rgba(255,60,60,0.95)');
      poly(ctx, [[cx - S * 0.13, S * 0.16], [cx - S * 0.30, S * 0.02], [cx - S * 0.10, S * 0.09]], '#d8d2c0');
      poly(ctx, [[cx + S * 0.13, S * 0.16], [cx + S * 0.30, S * 0.02], [cx + S * 0.10, S * 0.09]], '#d8d2c0');
    }
  };

  /* --- corpse / gib art (shared, tinted per monster) --- */
  function corpse(base, seed) {
    var c = canvas(64, 64);
    var ctx = c.getContext('2d');
    var rng = util.makeRng(seed);
    /* blood pool */
    for (var i = 0; i < 3; i++) {
      blob(ctx, 32 + (rng.next() - 0.5) * 12, 50 + (rng.next() - 0.5) * 6, 18 + rng.next() * 10, 6 + rng.next() * 4,
        rgba(90 + rng.next() * 60, 12, 14, 0.85));
    }
    /* collapsed body */
    blob(ctx, 32, 44, 15, 8, rgb(base[0] * 0.8, base[1] * 0.8, base[2] * 0.8), 0.22, seed + 1);
    blob(ctx, 24, 40, 7, 5, rgb(base[0], base[1], base[2]), 0.3, seed + 2);
    /* bone bits */
    line(ctx, 38, 42, 46, 46, '#e6e0cc', 2);
    line(ctx, 20, 48, 28, 50, '#e6e0cc', 2);
    return c;
  }

  /* ---------------- build all monster frames ---------------- */

  function buildMonsters() {
    var out = {};
    Object.keys(MON).forEach(function (key) {
      var spec = MON[key];
      var frames = [];
      for (var f = 0; f < spec.frames; f++) {
        var c = canvas(spec.size, spec.size);
        var ctx = c.getContext('2d');
        spec.draw(ctx, spec.size, f);
        finish(c, {});
        frames.push(c);
      }
      var base = key === 'grunt' ? [96, 140, 66]
        : key === 'soldier' ? [104, 112, 128]
          : key === 'hound' ? [126, 62, 48]
            : key === 'mage' ? [58, 40, 92]
              : key === 'fiend' ? [150, 58, 44] : [64, 66, 80];
      out[key] = {
        frames: frames,
        death: [corpse(base, 100 + key.length), corpse(base, 200 + key.length)],
        worldW: spec.worldW,
        worldH: spec.worldH
      };
    });
    return out;
  }

  /* ---------------- items ---------------- */

  function itemBox(draw, size) {
    var S = size || 40;
    var c = canvas(S, S);
    var ctx = c.getContext('2d');
    draw(ctx, S);
    return c;
  }

  var ITEMS = {
    health: function (ctx, S) {
      roundRect(ctx, S * 0.16, S * 0.28, S * 0.68, S * 0.52, S * 0.08, '#e8e8ee');
      roundRect(ctx, S * 0.16, S * 0.28, S * 0.68, S * 0.14, S * 0.06, '#c4c4cc');
      rect(ctx, S * 0.44, S * 0.36, S * 0.12, S * 0.36, '#d42020');
      rect(ctx, S * 0.30, S * 0.48, S * 0.40, S * 0.12, '#d42020');
    },
    megahealth: function (ctx, S) {
      glow(ctx, S / 2, S * 0.52, S * 0.48, 'rgba(60,160,255,0.55)');
      roundRect(ctx, S * 0.28, S * 0.22, S * 0.44, S * 0.60, S * 0.12, 'rgba(120,200,255,0.85)');
      rect(ctx, S * 0.40, S * 0.12, S * 0.20, S * 0.12, '#9fb4c8');
      ell(ctx, S * 0.5, S * 0.55, S * 0.13, S * 0.2, 'rgba(230,250,255,0.9)');
    },
    armor: function (ctx, S) {
      poly(ctx, [[S * 0.22, S * 0.26], [S * 0.78, S * 0.26], [S * 0.72, S * 0.80], [S * 0.5, S * 0.9], [S * 0.28, S * 0.80]], '#2fa84a');
      poly(ctx, [[S * 0.34, S * 0.32], [S * 0.66, S * 0.32], [S * 0.62, S * 0.66], [S * 0.5, S * 0.74], [S * 0.38, S * 0.66]], '#7ce88f');
      line(ctx, S * 0.5, S * 0.32, S * 0.5, S * 0.74, '#1d6b2e', Math.max(1, S * 0.03));
    },
    armorShard: function (ctx, S) {
      poly(ctx, [[S * 0.5, S * 0.16], [S * 0.74, S * 0.52], [S * 0.5, S * 0.86], [S * 0.26, S * 0.52]], '#54d873');
      poly(ctx, [[S * 0.5, S * 0.26], [S * 0.63, S * 0.52], [S * 0.5, S * 0.76], [S * 0.37, S * 0.52]], '#b6ffd0');
    },
    ammoNails: function (ctx, S) {
      roundRect(ctx, S * 0.18, S * 0.42, S * 0.64, S * 0.40, S * 0.05, '#6a6f7a');
      roundRect(ctx, S * 0.18, S * 0.42, S * 0.64, S * 0.10, S * 0.04, '#8d94a2');
      for (var i = 0; i < 5; i++) {
        var x = S * 0.24 + i * S * 0.12;
        line(ctx, x, S * 0.42, x, S * 0.20, '#d8dce6', Math.max(1, S * 0.035));
        poly(ctx, [[x - S * 0.03, S * 0.22], [x + S * 0.03, S * 0.22], [x, S * 0.12]], '#ffcf5a');
      }
    },
    ammoShells: function (ctx, S) {
      for (var i = 0; i < 3; i++) {
        var x = S * 0.22 + i * S * 0.2;
        roundRect(ctx, x, S * 0.34, S * 0.16, S * 0.44, S * 0.03, i % 2 ? '#b83a2a' : '#c8452f');
        roundRect(ctx, x, S * 0.62, S * 0.16, S * 0.16, S * 0.02, '#d8b04a');
        circle(ctx, x + S * 0.08, S * 0.34, S * 0.07, '#8d94a2');
      }
    },
    ammoRockets: function (ctx, S) {
      roundRect(ctx, S * 0.14, S * 0.44, S * 0.72, S * 0.26, S * 0.05, '#4a5560');
      for (var i = 0; i < 2; i++) {
        var y = S * 0.48 + i * S * 0.16;
        rect(ctx, S * 0.2, y, S * 0.44, S * 0.1, '#c8ccd4');
        poly(ctx, [[S * 0.64, y], [S * 0.8, y + S * 0.05], [S * 0.64, y + S * 0.1]], '#d4482a');
        poly(ctx, [[S * 0.2, y], [S * 0.12, y + S * 0.05], [S * 0.2, y + S * 0.1]], '#8d94a2');
      }
    },
    ammoCells: function (ctx, S) {
      roundRect(ctx, S * 0.26, S * 0.24, S * 0.48, S * 0.56, S * 0.06, '#2a2f3a');
      roundRect(ctx, S * 0.32, S * 0.30, S * 0.36, S * 0.44, S * 0.04, 'rgba(90,230,255,0.9)');
      for (var i = 0; i < 3; i++) rect(ctx, S * 0.34, S * 0.34 + i * S * 0.14, S * 0.32, S * 0.06, 'rgba(220,255,255,0.85)');
    },
    gunNail: function (ctx, S) {
      rect(ctx, S * 0.14, S * 0.42, S * 0.62, S * 0.16, '#5a626e');
      rect(ctx, S * 0.60, S * 0.36, S * 0.28, S * 0.10, '#8d94a2');
      rect(ctx, S * 0.26, S * 0.56, S * 0.12, S * 0.22, '#3c424c');
      circle(ctx, S * 0.2, S * 0.5, S * 0.09, '#2c313a');
      rect(ctx, S * 0.30, S * 0.30, S * 0.24, S * 0.12, '#6a7280');
    },
    gunShotgun: function (ctx, S) {
      rect(ctx, S * 0.10, S * 0.44, S * 0.72, S * 0.12, '#3c424c');
      rect(ctx, S * 0.10, S * 0.54, S * 0.60, S * 0.10, '#4a515c');
      rect(ctx, S * 0.62, S * 0.40, S * 0.28, S * 0.10, '#8d94a2');
      poly(ctx, [[S * 0.16, S * 0.56], [S * 0.34, S * 0.56], [S * 0.30, S * 0.84], [S * 0.14, S * 0.80]], '#6a4a2a');
      rect(ctx, S * 0.30, S * 0.30, S * 0.16, S * 0.14, '#5a4228');
    },
    gunRocket: function (ctx, S) {
      roundRect(ctx, S * 0.12, S * 0.36, S * 0.70, S * 0.26, S * 0.1, '#4a5560');
      circle(ctx, S * 0.18, S * 0.49, S * 0.13, '#181c22');
      rect(ctx, S * 0.30, S * 0.60, S * 0.16, S * 0.20, '#3c424c');
      rect(ctx, S * 0.56, S * 0.28, S * 0.14, S * 0.10, '#8d94a2');
      poly(ctx, [[S * 0.78, S * 0.36], [S * 0.92, S * 0.49], [S * 0.78, S * 0.62]], '#c8452f');
    },
    gunThunder: function (ctx, S) {
      roundRect(ctx, S * 0.16, S * 0.32, S * 0.56, S * 0.34, S * 0.08, '#3a3f52');
      rect(ctx, S * 0.62, S * 0.40, S * 0.26, S * 0.16, '#6a7280');
      for (var i = 0; i < 3; i++) circle(ctx, S * 0.28 + i * S * 0.14, S * 0.40, S * 0.05, 'rgba(120,220,255,0.9)');
      rect(ctx, S * 0.28, S * 0.62, S * 0.12, S * 0.20, '#2c313a');
    },
    key: function (ctx, S) {
      glow(ctx, S / 2, S * 0.5, S * 0.5, 'rgba(255,210,80,0.45)');
      circle(ctx, S * 0.5, S * 0.34, S * 0.18, '#f0c848');
      circle(ctx, S * 0.5, S * 0.34, S * 0.08, '#3a2c10');
      rect(ctx, S * 0.45, S * 0.46, S * 0.10, S * 0.38, '#f0c848');
      rect(ctx, S * 0.53, S * 0.66, S * 0.14, S * 0.08, '#f0c848');
      rect(ctx, S * 0.53, S * 0.78, S * 0.10, S * 0.07, '#f0c848');
    },
    envCanister: function (ctx, S) {
      roundRect(ctx, S * 0.30, S * 0.20, S * 0.40, S * 0.62, S * 0.10, 'rgba(120,220,255,0.55)');
      roundRect(ctx, S * 0.30, S * 0.20, S * 0.40, S * 0.62, S * 0.10, '#0000');
      ellLine(ctx, S * 0.5, S * 0.5, S * 0.2, S * 0.3, '#bfeaff', Math.max(1, S * 0.03));
      rect(ctx, S * 0.38, S * 0.10, S * 0.24, S * 0.10, '#8d94a2');
      rect(ctx, S * 0.34, S * 0.44, S * 0.32, S * 0.12, 'rgba(60,200,255,0.9)');
    },
    secret: function (ctx, S) {
      glow(ctx, S / 2, S * 0.5, S * 0.5, 'rgba(255,120,255,0.5)');
      poly(ctx, [[S * 0.5, S * 0.14], [S * 0.8, S * 0.5], [S * 0.5, S * 0.86], [S * 0.2, S * 0.5]], '#e8a8ff');
      poly(ctx, [[S * 0.5, S * 0.28], [S * 0.68, S * 0.5], [S * 0.5, S * 0.72], [S * 0.32, S * 0.5]], '#ffffff');
    }
  };

  /* ---------------- projectiles & effects ---------------- */

  function rocketSprite() {
    var S = 32, c = canvas(S, S), ctx = c.getContext('2d');
    glow(ctx, S * 0.3, S * 0.5, S * 0.45, 'rgba(255,180,60,0.85)');
    poly(ctx, [[S * 0.62, S * 0.34], [S * 0.94, S * 0.5], [S * 0.62, S * 0.66]], '#d8d2c0');
    rect(ctx, S * 0.30, S * 0.38, S * 0.34, S * 0.24, '#c8452f');
    rect(ctx, S * 0.24, S * 0.34, S * 0.08, S * 0.32, '#6a7280');
    glow(ctx, S * 0.16, S * 0.5, S * 0.28, 'rgba(255,240,180,0.95)', 'rgba(255,90,20,0)');
    return c;
  }

  function plasmaSprite(hue) {
    var S = 32, c = canvas(S, S), ctx = c.getContext('2d');
    glow(ctx, S / 2, S / 2, S * 0.5, hue === 'green' ? 'rgba(140,255,120,0.9)' : 'rgba(120,220,255,0.9)');
    glow(ctx, S / 2, S / 2, S * 0.28, 'rgba(255,255,255,0.95)');
    return c;
  }

  function sparkSprite() {
    var S = 24, c = canvas(S, S), ctx = c.getContext('2d');
    var rng = util.makeRng(31);
    for (var i = 0; i < 10; i++) {
      var a = rng.next() * Math.PI * 2, r = S * 0.15 + rng.next() * S * 0.3;
      line(ctx, S / 2, S / 2, S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, '#fff0b8', Math.max(1, S * 0.06));
    }
    glow(ctx, S / 2, S / 2, S * 0.3, 'rgba(255,220,140,0.9)');
    return c;
  }

  function bloodSprite(i) {
    var S = 32, c = canvas(S, S), ctx = c.getContext('2d');
    var rng = util.makeRng(1000 + i * 37);
    var n = 4 + i * 3;
    for (var k = 0; k < n; k++) {
      var a = rng.next() * Math.PI * 2;
      var r = (k / n) * S * 0.45 + rng.next() * 3;
      var sz = (1 - k / n) * S * 0.16 + 2;
      circle(ctx, S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, sz,
        rgba(150 + rng.next() * 70, 10 + rng.next() * 20, 12 + rng.next() * 16, clamp(1 - i * 0.22, 0.15, 1)));
    }
    return c;
  }

  function explosionSprite(i) {
    var S = 64, c = canvas(S, S), ctx = c.getContext('2d');
    var t = i / 5;
    var r = S * (0.18 + t * 0.34);
    var rng = util.makeRng(500 + i);
    /* core */
    glow(ctx, S / 2, S / 2, r, 'rgba(255,255,220,' + clamp(1 - t * 1.1, 0, 1) + ')');
    glow(ctx, S / 2, S / 2, r * 1.5, 'rgba(255,150,40,' + clamp(0.85 - t, 0, 1) + ')');
    /* fireball lobes */
    for (var k = 0; k < 9; k++) {
      var a = (k / 9) * Math.PI * 2 + rng.next();
      var d = r * (0.5 + rng.next() * 0.7);
      blob(ctx, S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d,
        r * (0.30 + rng.next() * 0.25), r * (0.30 + rng.next() * 0.25),
        'rgba(255,' + Math.floor(120 + rng.next() * 100) + ',30,' + clamp(0.9 - t * 1.2, 0, 1) + ')', 0.4, k + i);
    }
    /* smoke */
    for (var s = 0; s < 6; s++) {
      var sa = rng.next() * Math.PI * 2, sd = r * (0.9 + rng.next() * 0.6);
      blob(ctx, S / 2 + Math.cos(sa) * sd, S / 2 + Math.sin(sa) * sd,
        r * 0.35 * (0.4 + t), r * 0.35 * (0.4 + t),
        'rgba(40,36,34,' + clamp(t * 0.7, 0, 0.7) + ')', 0.5, s + 90);
    }
    return c;
  }

  function muzzleSprite(i) {
    var S = 48, c = canvas(S, S), ctx = c.getContext('2d');
    var t = i / 2;
    glow(ctx, S / 2, S / 2, S * (0.22 + t * 0.12), 'rgba(255,255,230,0.95)');
    var rng = util.makeRng(70 + i);
    for (var k = 0; k < 8; k++) {
      var a = (k / 8) * Math.PI * 2 + rng.next() * 0.6;
      var r = S * (0.18 + rng.next() * 0.28) * (0.7 + t * 0.5);
      line(ctx, S / 2 + Math.cos(a) * S * 0.1, S / 2 + Math.sin(a) * S * 0.1,
        S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r,
        'rgba(255,' + (180 + Math.floor(rng.next() * 70)) + ',80,0.9)', Math.max(1, S * 0.06));
    }
    return c;
  }

  /* ---------------- first-person weapon views ----------------
   * Drawn in a 320x240 space anchored at the bottom, right-of-centre.
   */

  function viewBase(fn) {
    var c = util.makeCanvas(320, 240);
    var ctx = c.getContext('2d');
    fn(ctx);
    return c;
  }

  var VIEWS = {
    nail: viewBase(function (ctx) {
      var x = 196, y = 250;
      ctx.fillStyle = '#2b3038';
      ctx.beginPath();
      ctx.moveTo(x - 34, y); ctx.lineTo(x + 34, y); ctx.lineTo(x + 22, y - 96); ctx.lineTo(x - 22, y - 96);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#4c5563';
      ctx.fillRect(x - 20, y - 150, 40, 60);
      ctx.fillStyle = '#6d7787';
      ctx.fillRect(x - 12, y - 176, 24, 30);
      ctx.fillStyle = '#191d22';
      ctx.beginPath(); ctx.arc(x, y - 178, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8d97a8';
      ctx.fillRect(x - 30, y - 108, 60, 12);
      ctx.fillRect(x - 26, y - 70, 52, 10);
      /* ammo belt */
      ctx.fillStyle = '#3a2f22';
      ctx.fillRect(x - 40, y - 60, 26, 58);
      for (var i = 0; i < 4; i++) {
        ctx.fillStyle = '#d9c07a';
        ctx.fillRect(x - 38, y - 54 + i * 13, 22, 6);
      }
      /* hand */
      ctx.fillStyle = '#c8b090';
      ctx.beginPath(); ctx.ellipse(x + 4, y - 60, 26, 20, 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a08a6e';
      for (var k = 0; k < 4; k++) ctx.fillRect(x - 14 + k * 11, y - 70, 8, 22);
    }),

    shotgun: viewBase(function (ctx) {
      var x = 190, y = 252;
      ctx.fillStyle = '#20242b';
      ctx.fillRect(x - 16, y - 176, 32, 96);
      ctx.fillStyle = '#33383f';
      ctx.fillRect(x + 16, y - 168, 18, 80);
      ctx.fillStyle = '#0e1013';
      ctx.beginPath(); ctx.arc(x, y - 178, 12, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 24, y - 170, 9, 0, Math.PI * 2); ctx.fill();
      /* wooden stock */
      ctx.fillStyle = '#6b4a28';
      ctx.beginPath();
      ctx.moveTo(x - 22, y - 84); ctx.lineTo(x + 30, y - 84); ctx.lineTo(x + 46, y); ctx.lineTo(x - 6, y);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#8a6236';
      ctx.fillRect(x - 18, y - 80, 44, 8);
      /* pump */
      ctx.fillStyle = '#7a5530';
      ctx.fillRect(x - 6, y - 132, 40, 16);
      ctx.fillStyle = '#c8b090';
      ctx.beginPath(); ctx.ellipse(x + 12, y - 124, 24, 18, 0.1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a08a6e';
      for (var k = 0; k < 4; k++) ctx.fillRect(x - 2 + k * 11, y - 136, 8, 24);
    }),

    rocket: viewBase(function (ctx) {
      var x = 186, y = 254;
      ctx.fillStyle = '#39424c';
      ctx.beginPath();
      ctx.moveTo(x - 40, y); ctx.lineTo(x + 40, y); ctx.lineTo(x + 30, y - 120); ctx.lineTo(x - 30, y - 120);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#525c68';
      ctx.fillRect(x - 30, y - 150, 60, 34);
      ctx.fillStyle = '#1a1e23';
      ctx.beginPath(); ctx.ellipse(x, y - 152, 30, 14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b0d10';
      ctx.beginPath(); ctx.ellipse(x, y - 152, 22, 9, 0, 0, Math.PI * 2); ctx.fill();
      /* sight */
      ctx.fillStyle = '#8d97a8';
      ctx.fillRect(x - 4, y - 176, 8, 26);
      ctx.fillRect(x - 16, y - 178, 32, 6);
      /* rockets loaded on the back */
      ctx.fillStyle = '#c8452f';
      ctx.fillRect(x - 46, y - 108, 16, 40);
      ctx.fillRect(x + 30, y - 108, 16, 40);
      ctx.fillStyle = '#c8b090';
      ctx.beginPath(); ctx.ellipse(x + 6, y - 66, 28, 22, 0.15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a08a6e';
      for (var k = 0; k < 4; k++) ctx.fillRect(x - 10 + k * 12, y - 78, 9, 26);
    }),

    thunder: viewBase(function (ctx) {
      var x = 188, y = 254;
      ctx.fillStyle = '#2f3345';
      ctx.beginPath();
      ctx.moveTo(x - 44, y); ctx.lineTo(x + 44, y); ctx.lineTo(x + 34, y - 110); ctx.lineTo(x - 34, y - 110);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#454b62';
      ctx.fillRect(x - 34, y - 150, 68, 44);
      /* coil rings */
      for (var i = 0; i < 4; i++) {
        ctx.strokeStyle = i % 2 ? '#7fd8ff' : '#2a2f3a';
        ctx.lineWidth = 6;
        ctx.beginPath(); ctx.ellipse(x, y - 146 + i * 11, 34, 9, 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = '#0d0f16';
      ctx.beginPath(); ctx.ellipse(x, y - 152, 24, 11, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#9fe8ff';
      ctx.beginPath(); ctx.ellipse(x, y - 152, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
      /* side capacitor */
      ctx.fillStyle = '#1c2030';
      ctx.fillRect(x + 34, y - 132, 22, 60);
      ctx.fillStyle = 'rgba(120,220,255,0.85)';
      ctx.fillRect(x + 38, y - 126, 14, 48);
      ctx.fillStyle = '#c8b090';
      ctx.beginPath(); ctx.ellipse(x + 4, y - 62, 30, 22, 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a08a6e';
      for (var k = 0; k < 4; k++) ctx.fillRect(x - 12 + k * 13, y - 74, 10, 28);
    }),

    fist: viewBase(function (ctx) {
      var x = 214, y = 250;
      ctx.fillStyle = '#c8b090';
      ctx.beginPath(); ctx.ellipse(x, y - 40, 40, 46, -0.15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a08a6e';
      for (var k = 0; k < 4; k++) ctx.fillRect(x - 30 + k * 17, y - 78, 13, 40);
      ctx.fillStyle = '#8a7460';
      ctx.beginPath(); ctx.ellipse(x - 34, y - 26, 14, 22, 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#6b5a48';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y - 40, 38, -2.4, -0.6); ctx.stroke();
    })
  };

  Q2.art = {
    monsters: buildMonsters(),
    items: (function () {
      var o = {};
      Object.keys(ITEMS).forEach(function (k) { o[k] = itemBox(ITEMS[k], 40); });
      return o;
    })(),
    fx: {
      rocket: rocketSprite(),
      plasmaBlue: plasmaSprite('blue'),
      plasmaGreen: plasmaSprite('green'),
      plasmaRed: (function () {
        var S = 32, c = canvas(S, S), ctx = c.getContext('2d');
        glow(ctx, S / 2, S / 2, S * 0.5, 'rgba(255,120,60,0.9)');
        glow(ctx, S / 2, S / 2, S * 0.26, 'rgba(255,255,240,0.95)');
        return c;
      })(),
      spark: sparkSprite(),
      blood: [bloodSprite(0), bloodSprite(1), bloodSprite(2), bloodSprite(3)],
      explosion: [explosionSprite(0), explosionSprite(1), explosionSprite(2), explosionSprite(3), explosionSprite(4), explosionSprite(5)],
      muzzle: [muzzleSprite(0), muzzleSprite(1), muzzleSprite(2)]
    },
    views: VIEWS
  };
})(window.Q2);
