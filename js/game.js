/*
 * game.js — boot, main loop, world state, damage rules, input glue.
 *
 * The `world` object passed to every update() is the single mutable game
 * state; it also carries the helper API the entity/player/weapon modules
 * call into (damageEnemy, splashDamage, message, panOf, ...).
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;
  var E = Q2.entities;
  var W = Q2.weapons;

  /* diff: how many monsters the generator places
   * hp:    enemy health multiplier
   * dmg:   damage enemies deal to the player
   * drop:  chance a killed monster leaves loot behind */
  var DIFFS = [
    { name: 'CASUAL', diff: 0.7, hp: 0.75, dmg: 0.6, drop: 0.85 },
    { name: 'NORMAL', diff: 1.0, hp: 1.0, dmg: 1.0, drop: 0.6 },
    { name: 'NIGHTMARE', diff: 1.45, hp: 1.5, dmg: 1.6, drop: 0.45 }
  ];

  /* ---------------- world ---------------- */

  function World(seed, difficulty) {
    this.seed = seed;
    this.difficulty = difficulty;
    var mult = (Game.ui && DIFFS[difficulty]) ? DIFFS[difficulty].diff : 1;
    this.map = Q2.maps.generate(seed, mult);
    this.rng = util.makeRng(seed ^ 0x5f3a2b1c);
    this.player = new Q2.player.Player(this.map.spawn.x, this.map.spawn.y);
    this.player.angle = this.faceOpenDirection();
    this.enemies = [];
    this.projectiles = [];
    this.items = [];
    this.particles = [];
    this.corpses = [];
    this.explosions = [];
    this.tracers = [];
    this.messages = [];
    this.time = 0;
    this.score = 0;
    this.input = Game.input;
    this.hud = Game.hud;
    this.shake = 0;
    this.muzzle = null;
    this.meleeSwing = 0;
    this.hurtT = 0;
    this.hurtDir = 0;
    this.lastWeapon = 'fist';
    this.lastStrafe = 0;
    this.showMap = true;
    this.totalEnemies = 0;
    this.kills = 0;
    this.hits = 0;
    this.secretFound = false;
    this.startTime = 0;
    this.targets = [];

    var self = this;
    this.map.enemies.forEach(function (sp) {
      var e = new E.Enemy(sp.type, sp.x, sp.y, { boss: sp.boss });
      e.hp = Math.round(e.hp * diffHealth());
      e.maxHp = e.hp;
      self.enemies.push(e);
    });
    this.map.items.forEach(function (sp) {
      self.items.push(new E.Item(sp.kind, sp.x, sp.y));
    });
    /* a few explosive canisters as set dressing that reward a good shot */
    var rng = util.makeRng(seed ^ 0x1234);
    var rooms = this.map.rooms.filter(function (r) { return r.kind === 'normal'; });
    for (var i = 0; i < Math.min(10, rooms.length * 2); i++) {
      var rm = rng.pick(rooms);
      var x = rng.int(rm.x + 1, rm.x + rm.w - 2) + 0.5;
      var y = rng.int(rm.y + 1, rm.y + rm.h - 2) + 0.5;
      if (self.map.solid[self.map.at(Math.floor(x), Math.floor(y))]) continue;
      self.items.push(new E.Item('env_canister', x, y));
    }
    for (var di2 = 0; di2 < this.enemies.length; di2++) {
      this.enemies[di2].dmgMult = diffDmg();
      this.enemies[di2].dropChance = diffDrop();
    }
    this.totalEnemies = this.enemies.length;
    this.rebuildTargets();
  }

  function diffHealth() { return Game.ui ? DIFFS[Game.ui.diffIndex].hp : 1; }
  function diffDmg() { return Game.ui ? DIFFS[Game.ui.diffIndex].dmg : 1; }
  function diffDrop() { return Game.ui ? DIFFS[Game.ui.diffIndex].drop : 0.6; }

  World.prototype.faceOpenDirection = function () {
    var p = this.player, map = this.map;
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * util.TAU;
      var x = p.x + Math.cos(a) * 1.6, y = p.y + Math.sin(a) * 1.6;
      if (!map.isSolid(Math.floor(x), Math.floor(y))) return a;
    }
    return 0;
  };

  World.prototype.rebuildTargets = function () {
    this.targets = this.enemies.filter(function (e) { return e.alive; });
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      if (it.alive && it.def.explosive) this.targets.push(it);
    }
  };

  /* --- helpers used by other modules --- */

  World.prototype.message = function (text, color) {
    this.messages.push({ text: text, color: color || '#e8e2c8', t: 2.6 });
    if (this.messages.length > 4) this.messages.shift();
  };

  World.prototype.distToPlayer = function (x, y) {
    return Math.sqrt(util.dist2(this.player.x, this.player.y, x, y));
  };

  World.prototype.angleOf = function (x, y) {
    return Math.atan2(y - this.player.y, x - this.player.x);
  };

  World.prototype.panOf = function (x, y) {
    var d = this.distToPlayer(x, y);
    if (d < 0.6) return 0;
    var rel = this.angleOf(x, y) - this.player.angle;
    return clamp(Math.sin(rel), -1, 1) * clamp(1 - d / 24, 0.1, 1);
  };

  World.prototype.giveGun = function (p, key, ammo) {
    var had = p.guns[key];
    p.guns[key] = true;
    var w = W.WEAPONS[key];
    if (w.ammo && ammo) p.ammo[w.ammo] = Math.min(400, p.ammo[w.ammo] + ammo);
    this.message((had ? '' : 'GOT THE ') + w.name, '#ffd05a');
    p.pickupFlash = 1;
    if (!had) p.selectWeapon(key);
  };

  World.prototype.damagePlayer = function (amount, x, y, source) {
    if (!this.player.alive) return;
    this.player.damage(amount, this, source, x, y);
  };

  World.prototype.damageEnemy = function (e, dmg, hx, hy, source, knock) {
    if (!e.alive) return;
    if (e.isItem) { this.damageItem(e, dmg); return; }
    e.hp -= dmg;
    e.alert = true;
    e.attention = 1;
    e.state = 'fight';
    e.painT = e.t.pain * clamp(dmg / 25, 0.2, 1.6);
    if (source !== 'environment' && source !== 'enemy') this.hits++;

    /* knockback away from the shot */
    var dx = e.x - hx, dy = e.y - hy;
    var d = Math.hypot(dx, dy) || 1;
    var k = (knock || 0) * dmg / (e.t.mass || 1);
    e.knockX += (dx / d) * k * 6;
    e.knockY += (dy / d) * k * 6;

    /* splash the neighbours: they heard it */
    for (var i = 0; i < this.enemies.length; i++) {
      var o = this.enemies[i];
      if (o === e || !o.alive) continue;
      if (util.dist2(o.x, o.y, e.x, e.y) < 100) { o.alert = true; o.attention = 1; }
    }

    E.burst(this, hx, hy, 0.6, 3, Q2.art.fx.blood[0], { speed: 2.4, size: 0.22, life: 0.35, up: 2 });
    Q2.sound.play('hitFlesh', clamp(0.5 - this.distToPlayer(e.x, e.y) / 40, 0.08, 0.5), this.panOf(e.x, e.y));

    if (e.hp <= 0) this.killEnemy(e, source);
  };

  World.prototype.killEnemy = function (e, source) {
    if (!e.alive) return;
    e.alive = false;
    e.deathT = 0;
    e.hp = 0;
    this.kills++;
    this.player.kills++;
    this.score = (this.score || 0) + e.t.score;
    this.corpses.push({ x: e.x, y: e.y, type: e.type, variant: (Math.random() * 2) | 0, age: 0 });
    E.burst(this, e.x, e.y, e.height * 0.5, e.boss ? 26 : 10, Q2.art.fx.blood[1],
      { speed: e.boss ? 6 : 3.5, size: 0.3, life: 0.6, up: 3.5 });
    Q2.sound.play('gib', e.boss ? 0.8 : 0.45, this.panOf(e.x, e.y));
    if (e.boss) {
      this.message('THE OVERLORD FALLS', '#ff8aff');
      this.shake = 1.2;
    }
    /* drops */
    var drop = e.t.drop || [];
    for (var i = 0; i < drop.length; i++) {
      if (Math.random() > (e.dropChance === undefined ? 0.6 : e.dropChance)) continue;
      var it = new E.Item(drop[i], e.x + (Math.random() - 0.5) * 0.4, e.y + (Math.random() - 0.5) * 0.4);
      this.items.push(it);
    }
    this.rebuildTargets();
  };

  World.prototype.damageItem = function (it, dmg) {
    if (!it.alive) return;
    it.hp -= dmg;
    if (it.hp <= 0) {
      it.alive = false;
      if (it.def.explosive) {
        this.splashDamage(it.x, it.y, 0.5, 90, 3.6, 'environment');
        E.spawnExplosionFx(this, it.x, it.y, 0.5, 1.2);
        Q2.sound.play('explosion', 0.8, this.panOf(it.x, it.y));
      }
      this.rebuildTargets();
    }
  };

  World.prototype.splashDamage = function (x, y, z, dmg, radius, owner) {
    var r2 = radius * radius;
    var self = this;
    function apply(t, isPlayer) {
      var d2 = util.dist2(x, y, t.x, t.y);
      if (d2 > r2) return;
      var dist = Math.sqrt(d2);
      var falloff = clamp(1 - dist / radius, 0, 1);
      var amount = dmg * falloff * falloff;
      if (amount <= 0) return;
      if (isPlayer) {
        self.damagePlayer(amount, x, y, 'splash');
      } else {
        self.damageEnemy(t, amount, x, y, owner, 1.2);
      }
      /* push */
      var nx = (t.x - x) / (dist || 1), ny = (t.y - y) / (dist || 1);
      var push = falloff * 6;
      if (isPlayer) {
        t.vx += nx * push; t.vy += ny * push;
        if (owner === 'player' && dist < radius * 0.7) t.vz = Math.max(t.vz, push * 0.9);
      } else if (t.alive) {
        t.knockX += nx * push; t.knockY += ny * push;
      }
    }
    for (var i = 0; i < this.enemies.length; i++) apply(this.enemies[i], false);
    if (this.player.alive) apply(this.player, true);
    for (var j = 0; j < this.items.length; j++) {
      var it = this.items[j];
      if (it.alive && it.def.explosive && util.dist2(x, y, it.x, it.y) < r2) {
        it.hp -= dmg * 0.6;
        if (it.hp <= 0) {
          it.alive = false;
          (function (ix, iy) {
            self.splashDamage(ix, iy, 0.5, 90, 3.6, 'environment');
            E.spawnExplosionFx(self, ix, iy, 0.5, 1.2);
            Q2.sound.play('explosion', 0.8, self.panOf(ix, iy));
          })(it.x, it.y);
        }
      }
    }
    this.rebuildTargets();
  };

  World.prototype.sparkWall = function (hit, dmg) {
    E.burst(this, hit.x, hit.y, 0.6, 4, Q2.art.fx.spark, { speed: 3, size: 0.14, life: 0.25, up: 1.5 });
    Q2.sound.play('hitArmor', clamp(0.4 - this.distToPlayer(hit.x, hit.y) / 40, 0.05, 0.4), this.panOf(hit.x, hit.y));
    /* blastable secret wall */
    var cell = this.map.at(hit.cellX, hit.cellY);
    if (this.map.secret[cell] && dmg >= 25) {
      if (this.map.destroy(hit.cellX, hit.cellY)) {
        this.map.secret[cell] = 0;
        this.message('A HIDDEN PASSAGE OPENS', '#c8a8ff');
        this.secretFound = true;
        this.score = (this.score || 0) + 500;
        E.burst(this, hit.x, hit.y, 0.5, 18, Q2.art.fx.explosion[0], { speed: 5, size: 0.4, life: 0.6, up: 3 });
        Q2.sound.play('explosion', 0.7, this.panOf(hit.x, hit.y));
        this.shake = Math.min(1, this.shake + 0.4);
      }
    }
  };

  World.prototype.reachExit = function () {
    if (Game.ui.state !== 'playing') return;
    Game.win(this);
  };

  World.prototype.playerDied = function (source) {
    Game.lose(this, source);
  };

  World.prototype.clockText = function () {
    var t = Math.max(0, this.time - this.startTime);
    var m = (t / 60) | 0, s = (t % 60) | 0;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  };

  World.prototype.objective = function () {
    if (!this.player.hasKey) return 'OBJECTIVE: FIND THE ACCESS KEY';
    return 'OBJECTIVE: REACH THE EXIT PORTAL';
  };

  /* --- per-frame world update --- */

  World.prototype.update = function (dt) {
    this.time += dt;
    var p = this.player;

    p.update(dt, this);
    this.lastStrafe = clamp((p.vx * -Math.sin(p.angle) + p.vy * Math.cos(p.angle)) / 4.6, -1, 1);

    var i;
    for (i = 0; i < this.enemies.length; i++) this.enemies[i].update(dt, this);
    for (i = this.projectiles.length - 1; i >= 0; i--) {
      var pr = this.projectiles[i];
      pr.update(dt, this);
      if (!pr.alive) this.projectiles.splice(i, 1);
    }
    for (i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      if (!it.alive) continue;
      it.update(dt, this);
      if (!it.isExit && !it.def.explosive && p.alive &&
        util.dist2(it.x, it.y, p.x, p.y) < 0.55 * 0.55 && Math.abs(p.z - it.z) < 1.2) {
        it.pickup(this);
      }
    }
    for (i = this.particles.length - 1; i >= 0; i--) {
      var pt = this.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) { this.particles.splice(i, 1); continue; }
      pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.z += pt.vz * dt;
      pt.vz -= (pt.grav === undefined ? 9 : pt.grav) * dt;
      pt.rot += pt.spin * dt;
      if (pt.z < 0.02) { pt.z = 0.02; pt.vz *= -0.25; pt.vx *= 0.6; pt.vy *= 0.6; }
      var cell = this.map.at(Math.floor(pt.x), Math.floor(pt.y));
      if (this.map.solid[cell]) { pt.z = Math.min(pt.z, 0.9); pt.vx *= -0.4; pt.vy *= -0.4; }
    }
    for (i = this.explosions.length - 1; i >= 0; i--) {
      this.explosions[i].t += dt;
      if (this.explosions[i].t >= this.explosions[i].dur) this.explosions.splice(i, 1);
    }
    for (i = this.corpses.length - 1; i >= 0; i--) {
      this.corpses[i].age += dt;
      if (this.corpses[i].age > 26) this.corpses.splice(i, 1);
    }
    for (i = this.messages.length - 1; i >= 0; i--) {
      this.messages[i].t -= dt;
      if (this.messages[i].t <= 0) this.messages.splice(i, 1);
    }
    for (i = this.tracers.length - 1; i >= 0; i--) {
      this.tracers[i].t += dt;
      if (this.tracers[i].t > this.tracers[i].dur) this.tracers.splice(i, 1);
    }
    /* doors slide */
    for (i = 0; i < this.map.doors.length; i++) {
      var d = this.map.doors[i];
      if (d.open !== d.target) {
        var was = d.open;
        d.open = clamp(d.open + (d.target > d.open ? dt * 1.6 : -dt * 1.1), 0, 1);
        if (was < 0.02 && d.open >= 0.02) Q2.sound.play('door', 0.35, this.panOf(d.x, d.y));
      }
    }
    this.shake = util.approach(this.shake, 0, 6, dt);
    if (this.muzzle) { this.muzzle.t += dt; if (this.muzzle.t > this.muzzle.dur) this.muzzle = null; }
    this.meleeSwing = Math.max(0, this.meleeSwing - dt * 4);
    this.hurtT = Math.max(0, this.hurtT - dt * 1.6);

    /* ambient intensity follows how many monsters are chasing you */
    var heat = 0;
    for (i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].alive && this.enemies[i].state === 'fight') heat++;
    }
    Q2.sound.setAmbient(true, clamp(heat / 6, 0, 1));
  };

  /* ---------------- game shell ---------------- */

  var Game = {
    ui: {
      state: 'title',   /* title | playing | paused | dead | win */
      t: 0,
      diffIndex: 1,
      difficultyName: 'NORMAL',
      stats: [],
      rating: ''
    },
    level: 1,
    baseSeed: (Math.random() * 1e9) | 0,
    fps: 60,
    frameMs: 16,
    running: false
  };
  Q2.Game = Game;

  Game.boot = function () {
    var self = this;
    this.display = document.getElementById('view');
    this.hud = new Q2.HUD(this.display);
    this.renderer = new Q2.Renderer(this.display);
    this.input = new Q2.player.Input(this.display);
    this.input.attach(this);
    this.world = new World(this.seedFor(), this.ui.diffIndex);
    this.ui.state = 'title';

    this.resize();
    window.addEventListener('resize', function () { self.resize(); });
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(function (t) { self.frame(t); });
  };

  Game.seedFor = function () {
    return (this.baseSeed + (this.level - 1) * 7919) >>> 0;
  };

  Game.resize = function () {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cw = window.innerWidth, ch = window.innerHeight;
    this.display.style.width = cw + 'px';
    this.display.style.height = ch + 'px';
    this.display.width = Math.max(320, Math.round(cw * dpr));
    this.display.height = Math.max(200, Math.round(ch * dpr));

    /* internal render height: adaptive, keeps the fill-rate sane. The real
     * browser also pays for putImageData + the scale-up blit, which this
     * number does not include, so start with headroom. */
    var target = clamp(Math.round(this.display.height * this.quality), 150, 340);
    var aspect = this.display.width / this.display.height;
    this.renderer.resize(Math.round(target * aspect), target);
    this.hud.mapDirty = true;
  };

  Game.quality = 0.34;

  Game.onGesture = function () {
    Q2.sound.unlock();
    var s = this.ui.state;
    if (s === 'title') this.start();
    else if (s === 'paused') this.resume();
    else if (s === 'dead') this.restart();
    else if (s === 'win') this.nextLevel();
    /* the click that entered the game should not also pull the trigger */
    if (s !== 'playing' && this.input) {
      var self = this;
      this.input.fire = false;
      this.input.altFire = false;
      setTimeout(function () { self.input.clearPressed(); }, 0);
    }
  };

  Game.requestLock = function () {
    var el = this.display;
    if (!el.requestPointerLock) return;
    try {
      var r = el.requestPointerLock({ unadjustedMovement: true });
      if (r && r.catch) r.catch(function () { });
    } catch (e) {
      try {
        var r2 = el.requestPointerLock();
        if (r2 && r2.catch) r2.catch(function () { });
      } catch (e2) { /* pointer lock unavailable: arrow keys still work */ }
    }
  };

  Game.onLockChange = function (locked) {
    this.locked = locked;
    if (!locked && this.ui.state === 'playing') {
      this._justUnlocked = performance.now();
      this.pause();
    }
  };

  Game.onKey = function (k, e) {
    var ui = this.ui;
    Q2.sound.unlock();
    if (k === 'm') { Q2.sound.setMuted(!Q2.sound.muted); this.world.message(Q2.sound.muted ? 'SOUND OFF' : 'SOUND ON', '#8fb8d8'); }
    if (ui.state === 'title') {
      if (k === '1' || k === '2' || k === '3') {
        ui.diffIndex = parseInt(k, 10) - 1;
        ui.difficultyName = DIFFS[ui.diffIndex].name;
        this.world.message('DIFFICULTY: ' + ui.difficultyName, '#ffd05a');
      }
      if (k === 'enter' || k === ' ') this.start();
      return;
    }
    if (k === 'escape') {
      if (ui.state === 'playing') this.pause();
      else if (ui.state === 'paused' && performance.now() - (this._justUnlocked || 0) > 400) this.resume();
      return;
    }
    if (ui.state === 'paused') {
      if (k === 'r') this.restart();
      if (k === 'n') { this.level++; this.restart(); }
      return;
    }
    if (ui.state === 'dead') {
      if (k === 'r' || k === 'enter') this.restart();
      return;
    }
    if (ui.state === 'win') {
      if (k === 'enter' || k === 'r') this.nextLevel();
      return;
    }
    var w = this.world;
    if (k === 'tab') w.showMap = !w.showMap;
    if (k === 'e') this.useKey();
    if (k >= '1' && k <= '5') {
      var key = W.ORDER[parseInt(k, 10) - 1];
      if (key) w.player.selectWeapon(key);
    }
    if (k === 'q') w.player.cycleWeapon(1);
    if (k === '[') w.player.cycleWeapon(-1);
    if (k === ']') w.player.cycleWeapon(1);
  };

  Game.useKey = function () {
    var w = this.world, p = w.player;
    /* open the door you are standing next to */
    var best = null, bd = 2.2;
    for (var i = 0; i < w.map.doors.length; i++) {
      var d = w.map.doors[i];
      var dd = Math.sqrt(util.dist2(d.x + 0.5, d.y + 0.5, p.x, p.y));
      if (dd < bd) { bd = dd; best = d; }
    }
    if (!best) return;
    if (best.locked && !p.hasKey) {
      w.message('DOOR IS LOCKED — FIND THE ACCESS KEY', '#ff7a5a');
      Q2.sound.play('door', 0.4);
      return;
    }
    w.map.openDoor(w.map.doors.indexOf(best), true);
  };

  /* ---------------- state transitions ---------------- */

  Game.start = function () {
    this.ui.state = 'playing';
    this.ui.t = 0;
    this.world.startTime = this.world.time;
    this.requestLock();
    this.world.message('LEVEL ' + this.level + ' — ' + DIFFS[this.ui.diffIndex].name, '#8affd8');
  };

  Game.pause = function () {
    if (this.ui.state !== 'playing') return;
    this.ui.state = 'paused';
    this.ui.t = 0;
    if (document.exitPointerLock) document.exitPointerLock();
  };

  Game.resume = function () {
    this.ui.state = 'playing';
    this.requestLock();
  };

  Game.restart = function () {
    this.world = new World(this.seedFor(), this.ui.diffIndex);
    this.world.input = this.input;
    this.hud.invalidateMap();
    this.ui.state = 'playing';
    this.ui.t = 0;
    this.requestLock();
  };

  Game.nextLevel = function () {
    this.level++;
    this.restart();
  };

  Game.statsFor = function (w) {
    var p = w.player;
    var acc = p.shots ? Math.round(100 * clamp(w.hits / p.shots, 0, 1)) : 0;
    return [
      'TIME      ' + w.clockText(),
      'KILLS     ' + w.kills + ' / ' + w.totalEnemies,
      'SCORE     ' + (w.score || 0),
      'SECRETS   ' + (w.secretFound ? '1 / 1' : '0 / 1'),
      'ACCURACY  ~' + acc + '%'
    ];
  };

  Game.win = function (w) {
    if (this.ui.state === 'win') return;
    this.ui.state = 'win';
    this.ui.t = 0;
    w.score = (w.score || 0) + 1000 + Math.max(0, 900 - Math.round(w.time * 2));
    w.score += w.player.kills * 50;
    if (w.secretFound) w.score += 500;
    this.ui.stats = this.statsFor(w);
    var ratio = w.kills / Math.max(1, w.totalEnemies);
    this.ui.rating = ratio > 0.9 ? 'GRUNT OF HONOUR'
      : ratio > 0.6 ? 'SLAYER'
        : ratio > 0.3 ? 'FIGHTER' : 'SURVIVOR';
    Q2.sound.play('win', 0.9);
    Q2.sound.setAmbient(false, 0);
    if (document.exitPointerLock) document.exitPointerLock();
  };

  Game.lose = function (w, source) {
    if (this.ui.state === 'dead') return;
    this.ui.state = 'dead';
    this.ui.t = 0;
    this.ui.stats = this.statsFor(w);
    this.ui.stats.unshift(source === 'fall' ? 'YOU FELL TO YOUR DEATH' : 'THE FORGE CLAIMS ANOTHER');
    Q2.sound.play('lose', 0.9);
    Q2.sound.setAmbient(false, 0);
    E.burst(w, w.player.x, w.player.y, 0.5, 14, Q2.art.fx.blood[2], { speed: 4, size: 0.3, life: 0.7, up: 3 });
    if (document.exitPointerLock) document.exitPointerLock();
  };

  /* ---------------- frame ---------------- */

  Game.frame = function (now) {
    var self = this;
    var dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) dt = 1 / 60;
    this.frameMs = this.frameMs * 0.9 + (dt * 1000) * 0.1;
    this.fps = Math.round(1000 / Math.max(0.001, this.frameMs));

    var w = this.world;
    var state = this.ui.state;
    this.ui.t += dt;

    if (state === 'playing') {
      w.update(dt);
    } else if (state === 'title') {
      w.time += dt;
      w.player.angle += dt * 0.12;
      w.player.pitch = Math.sin(w.time * 0.4) * 0.06;
      for (var j = 0; j < w.items.length; j++) w.items[j].update(dt, w);
      Q2.sound.setAmbient(false, 0);
    } else {
      /* paused / dead / win: keep the world breathing, no player control */
      w.time += dt;
      if (state === 'dead') {
        for (var k = 0; k < w.enemies.length; k++) w.enemies[k].update(dt, w);
        for (var m = w.projectiles.length - 1; m >= 0; m--) {
          w.projectiles[m].update(dt, w);
          if (!w.projectiles[m].alive) w.projectiles.splice(m, 1);
        }
        for (var pv = w.particles.length - 1; pv >= 0; pv--) {
          var pt = w.particles[pv];
          pt.life -= dt;
          if (pt.life <= 0) { w.particles.splice(pv, 1); continue; }
          pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.z += pt.vz * dt;
          pt.vz -= 9 * dt;
          if (pt.z < 0.02) pt.z = 0.02;
        }
        w.shake = util.approach(w.shake, 0, 6, dt);
        w.player.deathT += dt;
      }
    }

    this.renderer.render(w);
    this.renderer.present(w);
    this.hud.draw(w, this.ui);
    if (state !== 'playing') this.hud.overlay(w, this.ui);

    this.autoQuality();
    requestAnimationFrame(function (t) { self.frame(t); });
  };

  /* keep the frame budget: shrink the internal buffer if we are slow */
  Game.autoQuality = function () {
    var ms = this.frameMs;
    var now = performance.now();
    if (now - (this._lastQuality || 0) < 1200) return;
    if (ms > 26 && this.quality > 0.18) {
      this._lastQuality = now;
      this.quality = Math.max(0.18, this.quality - 0.06);
      this.resize();
    } else if (ms < 13 && this.quality < 0.5) {
      this._lastQuality = now;
      this.quality = Math.min(0.5, this.quality + 0.04);
      this.resize();
    }
  };

  /* ---------------- boot ---------------- */

  function boot() {
    try {
      Game.boot();
    } catch (err) {
      var el = document.getElementById('fatal');
      if (el) {
        el.style.display = 'block';
        el.textContent = 'Failed to start: ' + (err && err.message ? err.message : err);
      }
      throw err;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.Q2);
