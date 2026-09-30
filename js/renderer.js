/*
 * renderer.js — software raycaster into a Uint32 framebuffer.
 *
 * Walls, floors and ceilings are cast per pixel (DDA), sprites are blended
 * with a z-buffer, and the result is blitted to the visible canvas. Doing the
 * whole 3D view in one typed-array pass is far faster in Canvas2D than one
 * drawImage per column, and it gives exact control over fog and shading.
 *
 * World space: 1 unit = one map cell = one wall of height 1.
 * z = 0 is the floor, z = 1 the ceiling.
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;

  var TEX = 64;
  var LEVELS = 24;              /* quantised brightness steps */
  var FOG_DIST = 21;            /* world units at which everything is fog */
  var PLANE_LEN = Math.tan(50 * Math.PI / 180);  /* half horizontal FOV */

  /* distance -> brightness step, as a lookup table: this is called once per
   * floor row and once per wall column, so keep it out of the pixel loops */
  var LVL_STEPS = 512;
  var LVL_LUT = new Uint8Array(LVL_STEPS + 1);
  (function () {
    for (var i = 0; i <= LVL_STEPS; i++) {
      var d = (i / LVL_STEPS) * FOG_DIST;
      var t = 1 - d / FOG_DIST;
      if (t < 0) t = 0;
      var l = (Math.pow(t, 1.35) * (LEVELS - 1)) | 0;
      LVL_LUT[i] = l > LEVELS - 1 ? LEVELS - 1 : l;
    }
  })();

  function levelOf(d) {
    var i = (d / FOG_DIST * LVL_STEPS) | 0;
    if (i < 0) i = 0;
    if (i > LVL_STEPS) i = LVL_STEPS;
    return LVL_LUT[i];
  }

  /* ---------------- pixel sources ---------------- */

  function toPixels(source) {
    var w = source.width, h = source.height;
    var ctx;
    if (source.getContext) {
      ctx = source.getContext('2d');
    } else {
      var cv = util.makeCanvas(w, h);
      ctx = cv.getContext('2d');
      ctx.drawImage(source, 0, 0);
    }
    var img = ctx.getImageData(0, 0, w, h);
    return { w: w, h: h, data: new Uint32Array(img.data.buffer.slice(0)) };
  }

  function shadePixel(p, f) {
    var r = (p & 255) * f, g = ((p >> 8) & 255) * f, b = ((p >> 16) & 255) * f;
    return (p & 0xFF000000) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
  }

  /* precompute every texture at every brightness step: shading becomes a copy */
  function buildShaded(pix, minLevel) {
    var out = [];
    var n = pix.data.length;
    for (var l = 0; l < LEVELS; l++) {
      var f = Math.pow((l + 1) / LEVELS, 1.25);
      if (f < minLevel) f = minLevel;
      var arr = new Uint32Array(n);
      for (var i = 0; i < n; i++) arr[i] = shadePixel(pix.data[i], f);
      out.push(arr);
    }
    return out;
  }

  /* ---------------- renderer ---------------- */

  function Renderer(display) {
    this.display = display;
    this.dctx = display.getContext('2d');
    this.buffer = util.makeCanvas(320, 180);
    this.bctx = this.buffer.getContext('2d');
    this.w = 320; this.h = 180;
    this.imageData = null;
    this.fb = null;
    this.zbuf = new Float32Array(this.w);
    this.sprites = [];
    this.sortBuf = [];
    this.cam = null;
    this.buildAssets();
  }

  Renderer.prototype.buildAssets = function () {
    var set = Q2.textures.set;
    this.texPix = {};
    Object.keys(set).forEach(function (name) {
      var t = set[name];
      var pix = toPixels(t.canvas);
      this.texPix[name] = {
        levels: buildShaded(pix, t.emissive ? 0.62 : 0.0),
        raw: pix,
        emissive: t.emissive,
        light: t.light
      };
    }, this);

    /* name lists indexed the same way the map indexes them */
    this.wallList = Q2.maps.WALLS.map(function (n) { return this.texPix[n]; }, this);
    this.floorList = Q2.maps.FLOORS.map(function (n) { return this.texPix[n]; }, this);
    this.ceilList = Q2.maps.CEILS.map(function (n) { return this.texPix[n]; }, this);

    /* sprites */
    var sp = this.sp = {};
    sp.monsters = {};
    Object.keys(Q2.art.monsters).forEach(function (k) {
      var m = Q2.art.monsters[k];
      sp.monsters[k] = {
        frames: m.frames.map(toPixels),
        death: m.death.map(toPixels),
        worldW: m.worldW, worldH: m.worldH
      };
    });
    sp.items = {};
    Object.keys(Q2.art.items).forEach(function (k) { sp.items[k] = toPixels(Q2.art.items[k]); });
    sp.fx = {};
    Object.keys(Q2.art.fx).forEach(function (k) {
      var v = Q2.art.fx[k];
      sp.fx[k] = Array.isArray(v) ? v.map(toPixels) : toPixels(v);
    });
    sp.views = {};
    Object.keys(Q2.art.views).forEach(function (k) { sp.views[k] = Q2.art.views[k]; });

    /* fog colour, packed as ABGR */
    this.fog = (255 << 24) | (26 << 16) | (26 << 8) | 30;
  };

  Renderer.prototype.resize = function (w, h) {
    w = Math.max(160, Math.min(900, w | 0));
    h = Math.max(90, Math.min(600, h | 0));
    this.w = w; this.h = h;
    this.buffer.width = w;
    this.buffer.height = h;
    this.bctx = this.buffer.getContext('2d');
    this.bctx.imageSmoothingEnabled = false;
    this.imageData = this.bctx.createImageData(w, h);
    this.fb = new Uint32Array(this.imageData.data.buffer);
    this.zbuf = new Float32Array(w);
  };

  /* brightness step for a distance */
  Renderer.prototype.level = levelOf;

  /* ---------------- main render ---------------- */

  Renderer.prototype.render = function (world) {
    var w = this.w, h = this.h;
    var p = world.player;
    var map = world.map;

    var shake = world.shake;
    var sy = (Math.random() - 0.5) * shake * h * 0.06;
    var yawJitter = (Math.random() - 0.5) * shake * 0.02;
    var pitchPx = Math.tan(p.pitch) * (w / 2) / PLANE_LEN + sy;
    var horizon = h / 2 + pitchPx;
    var projDist = (w / 2) / PLANE_LEN;

    var ang = p.angle + yawJitter;
    var dirX = Math.cos(ang), dirY = Math.sin(ang);
    var planeX = -dirY * PLANE_LEN, planeY = dirX * PLANE_LEN;
    var eyeH = clamp(p.z + p.height, 0.12, 1.4);

    var fb = this.fb, zbuf = this.zbuf;

    /* ---- floor + ceiling ---- */
    var rayLX = dirX - planeX, rayLY = dirY - planeY;
    var rayRX = dirX + planeX, rayRY = dirY + planeY;
    var stepScaleX = 2 * planeX / w, stepScaleY = 2 * planeY / w;
    var y, x, d, lvl, tex, cell, tx, ty, off, fx, fy, cx, cy;
    var floorList = this.floorList, ceilList = this.ceilList;
    var fog = this.fog;

    for (y = 0; y < h; y++) {
      off = y * w;
      var isFloor = y > horizon;
      var pp = isFloor ? (y - horizon) : (horizon - y);
      if (pp < 0.6) pp = 0.6;
      var planeH = isFloor ? eyeH : (1 - eyeH);
      if (planeH < 0.02) planeH = 0.02;
      d = planeH * projDist / pp;
      if (d > FOG_DIST) {
        fb.fill(fog, off, off + w);
        continue;
      }
      lvl = levelOf(d);
      var stepX = d * stepScaleX, stepY = d * stepScaleY;
      fx = p.x + d * rayLX; fy = p.y + d * rayLY;
      /* consecutive pixels usually sit in the same cell, so cache the row of
         texture levels that cell resolves to */
      var lastCell = -1, arr = null;
      for (x = 0; x < w; x++, fx += stepX, fy += stepY) {
        cx = fx | 0; cy = fy | 0;
        if (cx < 0) cx = 0; else if (cx >= map.w) cx = map.w - 1;
        if (cy < 0) cy = 0; else if (cy >= map.h) cy = map.h - 1;
        cell = cy * map.w + cx;
        if (cell !== lastCell) {
          lastCell = cell;
          var fti = map.floorTex[cell] - 100, cti = map.ceilTex[cell] - 200;
          if (fti < 0 || fti >= floorList.length) fti = 0;
          if (cti < 0 || cti >= ceilList.length) cti = 0;
          arr = (isFloor ? floorList[fti] : ceilList[cti]).levels[lvl];
        }
        tx = ((fx - cx) * TEX) | 0; ty = ((fy - cy) * TEX) | 0;
        fb[off + x] = arr[(ty << 6) + tx];
      }
    }

    /* ---- walls ---- */
    var wallList = this.wallList;
    var lightAt = map.cellLight;
    for (x = 0; x < w; x++) {
      var camX = 2 * x / w - 1;
      var rdx = dirX + planeX * camX, rdy = dirY + planeY * camX;
      var mapX = p.x | 0, mapY = p.y | 0;
      var dDX = Math.abs(1 / rdx), dDY = Math.abs(1 / rdy);
      var stepMX, stepMY, sideX, sideY;
      if (rdx < 0) { stepMX = -1; sideX = (p.x - mapX) * dDX; }
      else { stepMX = 1; sideX = (mapX + 1 - p.x) * dDX; }
      if (rdy < 0) { stepMY = -1; sideY = (p.y - mapY) * dDY; }
      else { stepMY = 1; sideY = (mapY + 1 - p.y) * dDY; }

      var hit = 0, side = 0, guard = 0, perp = 0, cellIdx = 0;
      while (guard++ < 256) {
        if (sideX < sideY) { sideX += dDX; mapX += stepMX; side = 0; }
        else { sideY += dDY; mapY += stepMY; side = 1; }
        if (mapX < 0 || mapY < 0 || mapX >= map.w || mapY >= map.h) { hit = 2; break; }
        cellIdx = map.at(mapX, mapY);
        if (map.solid[cellIdx]) {
          var di = map.doorIdx[cellIdx];
          if (di < 0 || map.doors[di].open < 0.92) { hit = 1; break; }
        }
      }
      if (hit === 2) { zbuf[x] = FOG_DIST; continue; }
      perp = side === 0 ? (sideX - dDX) : (sideY - dDY);
      if (perp < 0.02) perp = 0.02;
      zbuf[x] = perp;
      if (perp > FOG_DIST) continue;

      /* texture u */
      var wallX = side === 0 ? (p.y + perp * rdy) : (p.x + perp * rdx);
      wallX -= Math.floor(wallX);
      var texX = (wallX * TEX) | 0;
      if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) texX = TEX - texX - 1;

      var texId = map.wallTex[cellIdx];
      var t = wallList[texId] || wallList[0];

      /* door opening: the visible surface spans z in [open, 1] */
      var zTop = 1, zBot = 0;
      var di2 = map.doorIdx[cellIdx];
      if (di2 >= 0) zBot = clamp(map.doors[di2].open, 0, 0.98);

      var inv = projDist / perp;
      var yTop = horizon + (eyeH - zTop) * inv;
      var yBot = horizon + (eyeH - zBot) * inv;
      var y0 = yTop < 0 ? 0 : yTop | 0;
      var y1 = yBot > h ? h : Math.ceil(yBot);

      var bright = lightAt(mapX, mapY) * (side === 1 ? 0.72 : 1) * (1 - 0.25 * clamp(perp / FOG_DIST, 0, 1));
      var fogL = levelOf(perp);
      var lvl2 = (fogL * clamp(bright, 0, 1.25)) | 0;
      if (lvl2 > LEVELS - 1) lvl2 = LEVELS - 1;
      if (lvl2 < 0) lvl2 = 0;

      var span = (zTop - zBot);
      var vStep = (TEX * span) / (yBot - yTop);
      var v = (y0 - yTop) * vStep;
      var arr = t.levels[lvl2];
      for (y = y0; y < y1; y++) {
        var vv = v | 0;
        if (vv < 0) vv = 0; else if (vv >= TEX) vv = TEX - 1;
        fb[y * w + x] = arr[(vv << 6) + texX];
        v += vStep;
      }
    }

    /* ---- sprites ---- */
    this.drawSprites(world, dirX, dirY, planeX, planeY, projDist, horizon, eyeH, w, h);

    this.cam = {
      dirX: dirX, dirY: dirY, planeX: planeX, planeY: planeY,
      projDist: projDist, horizon: horizon, eyeH: eyeH, w: w, h: h,
      invDet: 1 / (planeX * dirY - dirX * planeY), px: p.x, py: p.y
    };

    this.bctx.putImageData(this.imageData, 0, 0);
  };
  /* ---------------- sprites ---------------- */

  Renderer.prototype.drawSprites = function (world, dirX, dirY, planeX, planeY, projDist, horizon, eyeH, w, h) {
    var list = this.sprites;
    var count = 0;
    var self = this;
    var invDet = 1 / (planeX * dirY - dirX * planeY);

    /* reuse descriptor objects: allocating hundreds per frame shows up in the
       profiler as GC pressure */
    function slot() {
      var o = list[count];
      if (!o) o = list[count] = {};
      count++;
      return o;
    }

    function push(x, y, z, img, ww, wh, opts) {
      var relX = x - world.player.x, relY = y - world.player.y;
      var depth = invDet * (-planeY * relX + planeX * relY);
      if (depth < 0.12 || depth > FOG_DIST) return;
      var tx = invDet * (dirY * relX - dirX * relY);
      var scale = projDist / depth;
      var sw = ww * scale, sh = wh * scale;
      var cx = (w / 2) * (1 + tx / depth);
      if (cx + sw / 2 < 0 || cx - sw / 2 > w) return;
      var o = slot();
      o.img = img; o.depth = depth; o.scale = scale;
      o.left = cx - sw / 2; o.right = cx + sw / 2;
      /* screen y grows downward: the sprite's world top maps to the smaller y */
      o.top = horizon + (eyeH - (z + wh)) * scale;
      o.bot = horizon + (eyeH - z) * scale;
      o.additive = opts && opts.additive;
      o.alpha = (opts && opts.alpha) === undefined ? 1 : opts.alpha;
      o.bright = (opts && opts.bright) === undefined ? 1 : opts.bright;
      o.tint = opts && opts.tint;
      return o;
    }

    /* corpses (floor decals) */
    world.corpses.forEach(function (c) {
      var img = self.sp.monsters[c.type] ? self.sp.monsters[c.type].death[c.variant] : null;
      if (!img) return;
      push(c.x, c.y, 0.01, img, 1.1, 0.42, { alpha: clamp(1 - (c.age - 20) / 6, 0, 1) });
    });

    /* items */
    world.items.forEach(function (it) {
      if (!it.alive) return;
      var img = self.sp.items[it.def.sprite];
      if (!img) return;
      var bob = it.isExit ? 0.15 + Math.sin(world.time * 2) * 0.05 : Math.sin(it.bob) * 0.06;
      var s = it.isExit ? 1.5 : 0.55;
      push(it.x, it.y, it.z + bob, img, s, s * (img.h / img.w), {
        additive: it.isExit, alpha: 1, bright: it.isExit ? 1.15 : 1
      });
    });

    /* enemies */
    world.enemies.forEach(function (e) {
      var set = self.sp.monsters[e.type];
      if (!set) return;
      var img, ww = set.worldW, wh = set.worldH;
      if (!e.alive) {
        if (e.deathT > 12) return;
        img = set.death[e.deathT > 6 ? 1 : 0];
        ww = 1.1; wh = 0.42;
        push(e.x, e.y, 0.01, img, ww, wh, { alpha: clamp(1 - (e.deathT - 8) / 4, 0, 1) });
        return;
      }
      img = set.frames[e.frame & 3];
      var opts = { bright: 1 };
      if (e.painT > 0) opts.tint = [255, 120, 120];
      push(e.x, e.y, e.z, img, ww, wh, opts);
    });

    /* projectiles */
    world.projectiles.forEach(function (pr) {
      if (!pr.alive) return;
      push(pr.x, pr.y, pr.z, pr.sprite.__pix || (pr.sprite.__pix = self.pixelsOf(pr.sprite)),
        pr.size * 2.4, pr.size * 2.4, { additive: true, bright: 1.3 });
    });

    /* particles */
    world.particles.forEach(function (pt) {
      var a = pt.fade ? clamp(pt.life / pt.maxLife, 0, 1) : 1;
      if (a <= 0) return;
      var img = pt.sprite.__pix || (pt.sprite.__pix = self.pixelsOf(pt.sprite));
      push(pt.x, pt.y, pt.z, img, pt.size, pt.size, { additive: true, alpha: a, bright: 0.6 + a * 0.8 });
    });

    /* explosion fireballs */
    world.explosions.forEach(function (ex) {
      var f = clamp(ex.t / ex.dur, 0, 1);
      var frames = self.sp.fx.explosion;
      var img = frames[Math.min(frames.length - 1, (f * frames.length) | 0)];
      var s = ex.scale * (0.9 + f * 2.6);
      push(ex.x, ex.y, ex.z + 0.1, img, s, s, { additive: true, alpha: clamp(1 - f * f, 0, 1), bright: 1.4 });
    });

    /* sort far -> near, into a persistent scratch array (no per-frame alloc) */
    var arr = this.sortBuf;
    arr.length = count;
    for (var c = 0; c < count; c++) arr[c] = list[c];
    arr.sort(function (a, b) { return b.depth - a.depth; });

    var fb = this.fb;
    for (var i = 0; i < arr.length; i++) {
      this.blitSprite(fb, w, h, arr[i]);
    }
  };

  Renderer.prototype.pixelsOf = function (canvas) {
    return toPixels(canvas);
  };

  Renderer.prototype.blitSprite = function (fb, W, H, s) {
    var img = s.img;
    var sw = img.w, sh = img.h, src = img.data;
    var x0 = Math.max(0, Math.ceil(s.left));
    var x1 = Math.min(W - 1, Math.floor(s.right));
    var y0 = Math.max(0, Math.ceil(s.top));
    var y1 = Math.min(H - 1, Math.floor(s.bot));
    if (x1 < x0 || y1 < y0) return;
    var spanX = s.right - s.left, spanY = s.bot - s.top;
    if (spanX < 0.5 || spanY < 0.5) return;
    var zbuf = this.zbuf;
    var depth = s.depth;
    var additive = s.additive;
    var alpha = s.alpha;
    var bright = s.bright;
    var light = clamp(bright * Math.pow(clamp(1 - depth / FOG_DIST, 0, 1), additive ? 0.8 : 1.35), 0.05, 1.8);
    var tint = s.tint;
    var invX = sw / spanX, invY = sh / spanY;
    var rowLen = sw;               /* src row stride */

    for (var x = x0; x <= x1; x++) {
      if (zbuf[x] < depth) continue;
      var sx = ((x - s.left) * invX) | 0;
      if (sx < 0) sx = 0; else if (sx >= sw) sx = sw - 1;
      /* walk down the column with an accumulating source row so the inner
         loop is one multiply-free increment */
      var acc = (y0 - s.top) * invY;
      for (var y = y0; y <= y1; y++, acc += invY) {
        var si = ((acc | 0) * rowLen) + sx;
        var sp = src[si];
        var a = (sp >>> 24);
        if (a === 0) continue;
        var idx = y * W + x;
        var r = sp & 255, g = (sp >> 8) & 255, b = (sp >> 16) & 255;
        if (tint) {
          r = (r * 0.64 + tint[0] * 0.36) | 0;
          g = (g * 0.64 + tint[1] * 0.36) | 0;
          b = (b * 0.64 + tint[2] * 0.36) | 0;
        }
        var af = (a / 255) * alpha;
        var lr = r * light, lg = g * light, lb = b * light;
        if (additive) {
          var dst = fb[idx];
          var dr = (dst & 255) + lr * af, dg = ((dst >> 8) & 255) + lg * af, db = ((dst >> 16) & 255) + lb * af;
          dr = dr > 255 ? 255 : dr; dg = dg > 255 ? 255 : dg; db = db > 255 ? 255 : db;
          fb[idx] = (dst & 0xFF000000) | ((db | 0) << 16) | ((dg | 0) << 8) | (dr | 0);
        } else {
          if (lr > 255) lr = 255; if (lg > 255) lg = 255; if (lb > 255) lb = 255;
          if (af >= 0.999) {
            fb[idx] = 0xFF000000 | ((lb | 0) << 16) | ((lg | 0) << 8) | (lr | 0);
          } else {
            var dst2 = fb[idx];
            var inv = 1 - af;
            var or_ = (dst2 & 255) * inv + lr * af;
            var og = ((dst2 >> 8) & 255) * inv + lg * af;
            var ob = ((dst2 >> 16) & 255) * inv + lb * af;
            if (or_ > 255) or_ = 255; if (og > 255) og = 255; if (ob > 255) ob = 255;
            fb[idx] = (dst2 & 0xFF000000) | ((ob | 0) << 16) | ((og | 0) << 8) | (or_ | 0);
          }
        }
      }
    }
  };

  /* ---------------- 2D overlay (view model, muzzle flash) ---------------- */

  Renderer.prototype.present = function (world) {
    var dw = this.display.width, dh = this.display.height;
    var ctx = this.dctx;
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.buffer, 0, 0, this.w, this.h, 0, 0, dw, dh);

    /* hitscan tracers, projected from world space */
    var cam = this.cam;
    if (cam && world.tracers.length) {
      ctx.globalCompositeOperation = 'lighter';
      var kx = dw / cam.w, ky = dh / cam.h;
      for (var i = 0; i < world.tracers.length; i++) {
        var tr = world.tracers[i];
        var a = clamp(1 - tr.t / tr.dur, 0, 1);
        var s0 = this.project(cam, tr.x0, tr.y0, tr.z0);
        var s1 = this.project(cam, tr.x1, tr.y1, tr.z1);
        if (!s0 || !s1) continue;
        ctx.strokeStyle = 'rgba(255,220,140,' + (a * 0.85) + ')';
        ctx.lineWidth = Math.max(1, 2 * a * (dh / 400));
        ctx.beginPath();
        ctx.moveTo(s0.x * kx, s0.y * ky);
        ctx.lineTo(s1.x * kx, s1.y * ky);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    /* first-person weapon */
    var p = world.player;
    var key = p.weapon;
    var view = this.sp.views[p.pendingWeapon || key];
    var vx = 0, vy = 0, vw = 0, vh = 0;
    if (view) {
      var scale = dh / 240 * 0.42;
      vw = view.width * scale; vh = view.height * scale;
      var bobX = Math.cos(p.bob) * p.bobAmp * dw * 0.016;
      var bobY = Math.abs(Math.sin(p.bob)) * p.bobAmp * dh * 0.02;
      var kick = p.kickView;
      var switchDip = 0;
      if (p.switchTimer > 0) switchDip = Math.sin(clamp(p.switchTimer / 0.22, 0, 1) * Math.PI) * vh * 0.6;
      vx = dw * 0.5 - vw * 0.5 + vw * 0.20 + bobX;
      vy = dh - vh + bobY + kick * dh * 0.045 + switchDip;
      if (!p.alive) {
        /* the gun drops with the player */
        vy += clamp(p.deathT, 0, 1) * vh * 0.7;
      }
      if (key === 'fist' && world.meleeSwing > 0) {
        var ms = 1 - world.meleeSwing;
        vy -= Math.sin(clamp(ms, 0, 1) * Math.PI) * dh * 0.20;
        vx -= Math.sin(clamp(ms, 0, 1) * Math.PI) * dw * 0.05;
      }
      ctx.drawImage(view, vx, vy, vw, vh);
    }

    /* muzzle flash at the barrel tip, additive */
    var mz = world.muzzle;
    if (mz && mz.t < mz.dur) {
      var f = 1 - mz.t / mz.dur;
      var frames = Q2.art.fx.muzzle;
      var img = frames[Math.min(frames.length - 1, (f * frames.length) | 0)];
      var size = dh * (0.16 + 0.10 * f) * (mz.power || 0.7);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(f * 1.4, 0, 1);
      ctx.drawImage(img, vx + vw * 0.58 - size / 2, vy + vh * 0.20 - size / 2, size, size);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    /* full-screen light pop from the shot and from explosions */
    var flash = 0;
    if (mz && mz.t < mz.dur) flash += (1 - mz.t / mz.dur) * 0.06 * (mz.power || 0.7);
    for (var e2 = 0; e2 < world.explosions.length; e2++) {
      var ex = world.explosions[e2];
      var d = world.distToPlayer(ex.x, ex.y);
      flash += clamp((1 - ex.t / ex.dur) * (1 - d / 14), 0, 0.35);
    }
    if (flash > 0.002) {
      ctx.fillStyle = 'rgba(255,190,110,' + clamp(flash, 0, 0.4) + ')';
      ctx.fillRect(0, 0, dw, dh);
    }
  };

  Renderer.prototype.project = function (cam, x, y, z) {
    var relX = x - cam.px, relY = y - cam.py;
    var depth = cam.invDet * (-cam.planeY * relX + cam.planeX * relY);
    if (depth < 0.15) return null;
    var tx = cam.invDet * (cam.dirY * relX - cam.dirX * relY);
    var scale = cam.projDist / depth;
    return {
      x: (cam.w / 2) * (1 + tx / depth),
      y: cam.horizon + (cam.eyeH - z) * scale,
      depth: depth
    };
  };

  Q2.Renderer = Renderer;
})(window.Q2);
