/*
 * hud.js — all 2D interface: status bar, crosshair, minimap, messages,
 * damage flash, and the title / pause / win / lose screens. Everything is
 * drawn on the canvas so the game needs no DOM layout to work.
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;

  function scaleUnit(W, H) { return Math.min(W, H * 1.6) / 960; }

  function HUD(display) {
    this.canvas = display;
    this.ctx = display.getContext('2d');
    this.mapCanvas = null;
    this.mapDirty = true;
    this.mapScale = 3;
    this.font = 'bold %spx "Courier New", monospace';
  }

  HUD.prototype.f = function (px) { return this.font.replace('%s', px); };

  HUD.prototype.invalidateMap = function () { this.mapDirty = true; };

  /* static minimap layer from the map grid */
  HUD.prototype.buildMap = function (map) {
    var s = this.mapScale;
    var c = util.makeCanvas(map.w * s, map.h * s);
    var g = c.getContext('2d');
    g.fillStyle = '#05060a';
    g.fillRect(0, 0, c.width, c.height);
    for (var y = 0; y < map.h; y++) {
      for (var x = 0; x < map.w; x++) {
        var cell = map.at(x, y);
        if (!map.solid[cell]) {
          var d = map.dmg[cell];
          g.fillStyle = d > 0 ? '#5a1a10' : '#1d2430';
          g.fillRect(x * s, y * s, s, s);
        } else if (map.secret[cell]) {
          g.fillStyle = '#3a2a5a';
          g.fillRect(x * s, y * s, s, s);
        }
      }
    }
    for (var i = 0; i < map.doors.length; i++) {
      var d2 = map.doors[i];
      g.fillStyle = d2.locked ? '#c85a20' : '#4a86c8';
      g.fillRect(d2.x * s, d2.y * s, s, s);
    }
    this.mapCanvas = c;
    this.mapDirty = false;
  };

  /* ---------------- main draw ---------------- */

  HUD.prototype.draw = function (world, ui) {
    var ctx = this.ctx;
    var W = this.canvas.width, H = this.canvas.height;
    var p = world.player;
    var u = scaleUnit(W, H);   /* keeps the HUD the same physical size at any res */

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.textBaseline = 'alphabetic';

    /* ---- damage / pickup full-screen tints ---- */
    if (p.damageFlash > 0) {
      ctx.fillStyle = 'rgba(150,10,10,' + clamp(p.damageFlash * 0.42, 0, 0.55) + ')';
      ctx.fillRect(0, 0, W, H);
    }
    if (p.pickupFlash > 0) {
      ctx.fillStyle = 'rgba(200,180,60,' + clamp(p.pickupFlash * 0.18, 0, 0.2) + ')';
      ctx.fillRect(0, 0, W, H);
    }
    if (p.megaT > 0) {
      var grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(40,120,255,' + clamp(0.16 * (p.megaT / 20 + 0.4), 0, 0.3) + ')');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
    /* low-health vignette */
    if (p.alive && p.health <= 40) {
      var pulse = 0.10 + 0.10 * Math.sin(world.time * (7 - p.health * 0.05));
      var g2 = ctx.createRadialGradient(W / 2, H / 2, H * 0.15, W / 2, H / 2, H * 0.8);
      g2.addColorStop(0, 'rgba(0,0,0,0)');
      g2.addColorStop(1, 'rgba(120,0,0,' + clamp(pulse * (1 - p.health / 40) + 0.05, 0, 0.5) + ')');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, W, H);
    }
    /* direction of the last hit */
    if (world.hurtT > 0 && p.alive) {
      ctx.save();
      ctx.translate(W / 2, H / 2);
      var rel = world.hurtDir - p.angle;
      ctx.rotate(rel + Math.PI / 2);
      ctx.fillStyle = 'rgba(255,60,40,' + clamp(world.hurtT * 0.7, 0, 0.8) + ')';
      ctx.beginPath();
      ctx.moveTo(-W * 0.06, -H * 0.30);
      ctx.lineTo(W * 0.06, -H * 0.30);
      ctx.lineTo(0, -H * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    /* ---- crosshair ---- */
    if (p.alive) {
      var w = Q2.weapons.WEAPONS[p.pendingWeapon || p.weapon];
      var gap = (w.spread * 900 + 6) * u * (1 + p.kickView * 1.6);
      var len = 7 * u;
      var th = Math.max(1, 2 * u);
      ctx.fillStyle = 'rgba(120,255,160,0.85)';
      ctx.fillRect(W / 2 - gap - len, H / 2 - th / 2, len, th);
      ctx.fillRect(W / 2 + gap, H / 2 - th / 2, len, th);
      ctx.fillRect(W / 2 - th / 2, H / 2 - gap - len, th, len);
      ctx.fillRect(W / 2 - th / 2, H / 2 + gap, th, len);
      ctx.fillRect(W / 2 - th / 2, H / 2 - th / 2, th, th);
    }

    /* ---- status bar ---- */
    this.statusBar(world, u, W, H);

    /* ---- minimap ---- */
    if (world.showMap) this.minimap(world, u, W, H);

    /* ---- weapon strip ---- */
    this.weaponStrip(world, u, W, H);

    /* ---- messages ---- */
    var my = H * 0.20;
    for (var i = 0; i < world.messages.length; i++) {
      var m = world.messages[i];
      var a = clamp(m.t / 1.2, 0, 1);
      ctx.globalAlpha = a;
      ctx.font = this.f(Math.round(13 * u));
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000';
      ctx.fillText(m.text, W / 2 + u, my + u);
      ctx.fillStyle = m.color;
      ctx.fillText(m.text, W / 2, my);
      my += 18 * u;
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';

    /* ---- objective / timer ---- */
    ctx.font = this.f(Math.round(11 * u));
    ctx.fillStyle = 'rgba(200,220,255,0.75)';
    var enemiesLeft = world.enemies.filter(function (e) { return e.alive; }).length;
    ctx.fillText('TIME ' + world.clockText(), 10 * u, 16 * u);
    ctx.fillText('KILLS ' + p.kills + '/' + world.totalEnemies, 10 * u, 30 * u);
    ctx.fillText('HOSTILES ' + enemiesLeft, 10 * u, 44 * u);
    ctx.textAlign = 'right';
    ctx.fillStyle = p.hasKey ? 'rgba(255,210,90,0.95)' : 'rgba(160,170,190,0.6)';
    ctx.fillText(p.hasKey ? 'ACCESS KEY: YES' : 'ACCESS KEY: NO', W - 10 * u, 16 * u);
    ctx.fillStyle = 'rgba(160,170,190,0.6)';
    ctx.fillText(world.objective(), W - 10 * u, 30 * u);
    ctx.textAlign = 'left';

    ctx.restore();
  };

  /* ---------------- status bar ---------------- */

  HUD.prototype.statusBar = function (world, u, W, H) {
    var ctx = this.ctx;
    var p = world.player;
    var bh = 46 * u;
    var y = H - bh;

    /* panel */
    ctx.fillStyle = 'rgba(8,10,14,0.82)';
    ctx.fillRect(0, y, W, bh);
    ctx.fillStyle = 'rgba(90,110,140,0.55)';
    ctx.fillRect(0, y, W, Math.max(1, 1 * u));
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, y + bh - Math.max(1, 1 * u), W, Math.max(1, 1 * u));

    function cell(x, w, label, value, color, big) {
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(x, y + 5 * u, w, bh - 10 * u);
      ctx.strokeStyle = 'rgba(120,140,170,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 5.5 * u, w, bh - 11 * u);
      ctx.font = world.hud.f(Math.round(8 * u));
      ctx.fillStyle = 'rgba(150,170,200,0.8)';
      ctx.fillText(label, x + 6 * u, y + 15 * u);
      ctx.font = world.hud.f(Math.round((big || 20) * u));
      ctx.fillStyle = color;
      ctx.fillText(value, x + 6 * u, y + 36 * u);
    }

    var hc = p.health > 60 ? '#5ce87a' : (p.health > 25 ? '#ffd05a' : '#ff5a4a');
    cell(8 * u, 78 * u, 'HEALTH', Math.ceil(p.health) + '', hc);
    cell(92 * u, 78 * u, 'ARMOR', Math.ceil(p.armor) + '', '#5ab8ff');

    /* ammo for the current gun */
    var w = Q2.weapons.WEAPONS[p.pendingWeapon || p.weapon];
    var ammoText = w.ammo ? (Math.floor(p.ammo[w.ammo] || 0) + '') : '∞';
    cell(176 * u, 70 * u, 'AMMO', ammoText, (w.ammo && p.ammo[w.ammo] < w.use * 3) ? '#ff5a4a' : '#e8e2c8');

    /* face plate: reacts to health, turns to death when dead */
    var fx = W - 58 * u, fw = 46 * u;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(fx, y + 5 * u, fw, bh - 10 * u);
    ctx.strokeStyle = 'rgba(120,140,170,0.3)';
    ctx.strokeRect(fx + 0.5, y + 5.5 * u, fw, bh - 11 * u);
    this.face(fx, y + 5 * u, fw, bh - 10 * u, p, world);

    /* key indicator */
    ctx.font = world.hud.f(Math.round(9 * u));
    ctx.fillStyle = p.hasKey ? '#ffd05a' : 'rgba(120,130,150,0.5)';
    ctx.fillText('KEY', fx - 30 * u, y + 20 * u);
    ctx.fillStyle = p.hasKey ? 'rgba(255,210,90,0.9)' : 'rgba(90,100,120,0.5)';
    ctx.fillRect(fx - 30 * u, y + 26 * u, 22 * u, 8 * u);
  };

  HUD.prototype.face = function (x, y, w, h, p, world) {
    var ctx = this.ctx;
    var cx = x + w / 2, cy = y + h / 2;
    var r = Math.min(w, h) * 0.36;
    var hurt = clamp(p.damageFlash, 0, 1);
    var hp = clamp(p.health / 100, 0, 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (!p.alive) {
      ctx.fillStyle = '#5a1414';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#200';
      ctx.lineWidth = Math.max(1, r * 0.14);
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.6, cy - r * 0.5); ctx.lineTo(cx - r * 0.1, cy + r * 0.1);
      ctx.moveTo(cx + r * 0.6, cy - r * 0.5); ctx.lineTo(cx + r * 0.1, cy + r * 0.1);
      ctx.moveTo(cx - r * 0.4, cy + r * 0.6); ctx.lineTo(cx + r * 0.4, cy + r * 0.4);
      ctx.stroke();
      ctx.restore();
      return;
    }
    /* skin tone reddens as it takes damage */
    var skin = 'rgb(' + Math.round(150 + hurt * 80) + ',' + Math.round(110 - hurt * 40) + ',' + Math.round(80 - hurt * 30) + ')';
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(cx + r * 0.35, cy, r, 0, Math.PI * 2); ctx.fill();
    /* eyes track the mouse-pitch a little */
    var ex = clamp(Math.sin(world.player.angle) * 0, -1, 1);
    var ey = clamp(p.pitch * 1.2, -0.5, 0.5);
    ctx.fillStyle = '#f2ecd8';
    ctx.beginPath(); ctx.ellipse(cx - r * 0.38, cy - r * 0.15 + ey * r, r * 0.24, r * 0.17, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + r * 0.38, cy - r * 0.15 + ey * r, r * 0.24, r * 0.17, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a0d0d';
    var look = clamp(world.lastStrafe, -1, 1) * r * 0.1;
    ctx.beginPath(); ctx.arc(cx - r * 0.38 + look, cy - r * 0.15 + ey * r, r * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.38 + look, cy - r * 0.15 + ey * r, r * 0.1, 0, Math.PI * 2); ctx.fill();
    /* mouth: grimaces with low health */
    ctx.strokeStyle = '#3a1010';
    ctx.lineWidth = Math.max(1, r * 0.13);
    ctx.beginPath();
    var mo = cy + r * 0.45;
    var curve = (hp - 0.5) * r * 0.7;
    ctx.moveTo(cx - r * 0.4, mo);
    ctx.quadraticCurveTo(cx, mo + curve, cx + r * 0.4, mo);
    ctx.stroke();
    if (hurt > 0.3) {
      ctx.strokeStyle = 'rgba(180,20,20,0.8)';
      ctx.lineWidth = Math.max(1, r * 0.1);
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5, cy - r * 0.7); ctx.lineTo(cx - r * 0.2, cy - r * 0.2);
      ctx.stroke();
    }
    ctx.restore();
  };

  /* ---------------- weapon strip ---------------- */

  HUD.prototype.weaponStrip = function (world, u, W, H) {
    var ctx = this.ctx;
    var p = world.player;
    var order = Q2.weapons.ORDER;
    var bw = 40 * u, bh = 15 * u;
    var x = W / 2 - order.length * bw / 2;
    var y = H - 46 * u - bh - 6 * u;
    for (var i = 0; i < order.length; i++) {
      var k = order[i];
      var have = p.guns[k];
      var cur = (p.pendingWeapon || p.weapon) === k;
      ctx.fillStyle = cur ? 'rgba(255,210,90,0.28)' : (have ? 'rgba(30,40,55,0.7)' : 'rgba(12,14,18,0.55)');
      ctx.fillRect(x + i * bw, y, bw - 3 * u, bh);
      ctx.strokeStyle = cur ? 'rgba(255,210,90,0.9)' : 'rgba(120,140,170,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + i * bw + 0.5, y + 0.5, bw - 3 * u, bh);
      ctx.font = world.hud.f(Math.round(8 * u));
      ctx.fillStyle = have ? (cur ? '#fff' : 'rgba(190,210,230,0.8)') : 'rgba(110,120,135,0.45)';
      ctx.textAlign = 'center';
      ctx.fillText((i + 1) + ' ' + Q2.weapons.WEAPONS[k].name.slice(0, 6), x + i * bw + (bw - 3 * u) / 2, y + 11 * u);
      ctx.textAlign = 'left';
    }
  };

  /* ---------------- minimap ---------------- */

  HUD.prototype.minimap = function (world, u, W, H) {
    var ctx = this.ctx;
    var map = world.map;
    if (this.mapDirty || !this.mapCanvas) this.buildMap(map);
    var size = Math.min(W, H) * 0.34;
    var scale = size / (map.w * this.mapScale);
    var x = W - size - 12 * u, y = 40 * u;
    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = '#04050a';
    ctx.fillRect(x - 2, y - 2, size + 4, size + 4);
    ctx.drawImage(this.mapCanvas, x, y, size, size);

    /* items */
    world.items.forEach(function (it) {
      if (!it.alive) return;
      ctx.fillStyle = it.isExit ? '#8affd8' : (it.kind.indexOf('gun') === 0 ? '#ffd05a' : 'rgba(140,200,255,0.8)');
      ctx.fillRect(x + it.x * this.mapScale * scale - 1, y + it.y * this.mapScale * scale - 1, 2.5, 2.5);
    }, this);

    /* enemies (only alerted ones, keeps it a tool not a cheat) */
    world.enemies.forEach(function (e) {
      if (!e.alive || !e.alert) return;
      ctx.fillStyle = e.boss ? '#ff40ff' : '#ff5a4a';
      ctx.fillRect(x + e.x * this.mapScale * scale - 1.5, y + e.y * this.mapScale * scale - 1.5, 3, 3);
    }, this);

    /* player */
    var p = world.player;
    ctx.save();
    ctx.translate(x + p.x * this.mapScale * scale, y + p.y * this.mapScale * scale);
    ctx.rotate(p.angle + Math.PI / 2);
    ctx.fillStyle = '#8affd8';
    ctx.beginPath();
    ctx.moveTo(0, -4); ctx.lineTo(3, 3); ctx.lineTo(0, 1.5); ctx.lineTo(-3, 3);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(120,140,170,0.5)';
    ctx.strokeRect(x - 2.5, y - 2.5, size + 5, size + 5);
    ctx.restore();
  };

  /* ---------------- full-screen states ---------------- */

  HUD.prototype.overlay = function (world, ui) {
    var ctx = this.ctx;
    var W = this.canvas.width, H = this.canvas.height;
    var u = scaleUnit(W, H);
    ctx.save();
    ctx.textAlign = 'center';

    function panel(alpha) {
      ctx.fillStyle = 'rgba(3,4,8,' + alpha + ')';
      ctx.fillRect(0, 0, W, H);
    }

    function title(text, y, size, color) {
      ctx.font = world.hud.f(Math.round(size * u));
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillText(text, W / 2 + 2 * u, y + 2 * u);
      ctx.fillStyle = color;
      ctx.fillText(text, W / 2, y);
    }

    function lines(list, y, size, color, gap) {
      ctx.font = world.hud.f(Math.round(size * u));
      ctx.fillStyle = color;
      for (var i = 0; i < list.length; i++) {
        ctx.fillText(list[i], W / 2, y + i * gap * u);
      }
    }

    if (ui.state === 'title') {
      panel(0.86);
      title('QUAKE-2D', H * 0.26, 46, '#ff8a3a');
      title('DESCENT INTO THE SILVER FORGE', H * 0.26 + 26 * u, 12, '#8fb8d8');
      lines([
        'WASD move  ·  MOUSE look  ·  LMB fire  ·  RMB alt-fire',
        'SPACE jump  ·  CTRL crouch  ·  1-5 / WHEEL weapons',
        'TAB map  ·  E use door  ·  ESC pause  ·  M mute'
      ], H * 0.46, 11, 'rgba(200,215,235,0.9)', 17);
      title('FIND THE ACCESS KEY. KILL THE OVERLORD. REACH THE EXIT.', H * 0.63, 11, '#ffd05a');
      var pulse = 0.6 + 0.4 * Math.sin(world.time * 4);
      ctx.globalAlpha = pulse;
      title('CLICK TO ENTER', H * 0.76, 18, '#8affd8');
      ctx.globalAlpha = 1;
      lines(['Difficulty: ' + ui.difficultyName + '   (press 1/2/3 to change)'], H * 0.86, 10, 'rgba(160,175,195,0.8)', 14);
    } else if (ui.state === 'paused') {
      panel(0.6);
      title('PAUSED', H * 0.4, 34, '#ffd05a');
      lines(['Click to resume  ·  ESC resume  ·  R restart  ·  N new level'], H * 0.52, 11, 'rgba(200,215,235,0.85)', 16);
    } else if (ui.state === 'dead') {
      panel(clamp(ui.t / 1.2, 0, 0.8));
      title('YOU DIED', H * 0.36, 44, '#ff4a3a');
      lines(ui.stats, H * 0.5, 12, 'rgba(220,225,235,0.9)', 18);
      if (ui.t > 1) {
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(world.time * 4);
        title('CLICK TO TRY AGAIN', H * 0.78, 16, '#8affd8');
        ctx.globalAlpha = 1;
      }
    } else if (ui.state === 'win') {
      panel(clamp(ui.t / 1.2, 0, 0.75));
      title('LEVEL CLEARED', H * 0.32, 38, '#8affd8');
      title('THE SILVER FORGE IS SILENT', H * 0.32 + 24 * u, 12, '#8fb8d8');
      lines(ui.stats, H * 0.5, 12, 'rgba(220,225,235,0.95)', 18);
      title('RATING: ' + ui.rating, H * 0.5 + ui.stats.length * 18 * u + 14 * u, 18, '#ffd05a');
      if (ui.t > 1) {
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(world.time * 4);
        title('CLICK FOR THE NEXT LEVEL', H * 0.82, 16, '#8affd8');
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  };

  Q2.HUD = HUD;
})(window.Q2);
