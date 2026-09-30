/*
 * player.js — keyboard/mouse input, first-person movement physics,
 * damage response and the view-model animation.
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;
  var W = Q2.weapons;

  var EYE_STAND = 0.62;
  var EYE_CROUCH = 0.34;
  var RADIUS = 0.28;
  var WALK_SPEED = 5.2;
  var CROUCH_SPEED = 2.2;
  var AIR_ACCEL = 1.7;      /* fraction of the wish vector gained per second */
  var GROUND_ACCEL = 15;    /* snappy on the ground, Quake-like air control */
  var FRICTION = 11;        /* only applied when there is no movement input */
  var GRAVITY = 22;
  var JUMP_VZ = 6.6;

  /* ---------------- input ---------------- */

  function Input(canvas) {
    this.canvas = canvas;
    this.keys = {};
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.fire = false;
    this.altFire = false;
    this.wheel = 0;
    this.locked = false;
    this.sensitivity = 1;
    this.invertY = false;
    this.pressed = {};
    this._handlers = [];
  }

  Input.prototype.on = function (target, type, fn, opts) {
    target.addEventListener(type, fn, opts || false);
    this._handlers.push([target, type, fn]);
  };

  Input.prototype.attach = function (game) {
    var self = this;

    this.on(window, 'keydown', function (e) {
      var k = e.key.toLowerCase();
      if (['tab', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].indexOf(k) >= 0) e.preventDefault();
      if (!self.keys[k]) self.pressed[k] = true;
      self.keys[k] = true;
      if (e.repeat) return;          /* no auto-repeat for game commands */
      game.onKey(k, e);
    });
    this.on(window, 'keyup', function (e) {
      self.keys[e.key.toLowerCase()] = false;
    });
    this.on(window, 'blur', function () {
      self.keys = {};
      self.fire = false;
      self.altFire = false;
    });

    this.on(this.canvas, 'mousedown', function (e) {
      game.onGesture();
      if (!self.locked) {
        /* fire the click too: if pointer lock is unavailable the mouse is the
           only way to shoot, and the arrow keys cover looking */
        if (e.button === 0) self.fire = true;
        if (e.button === 2) self.altFire = true;
        game.requestLock();
        return;
      }
      if (e.button === 0) self.fire = true;
      if (e.button === 2) self.altFire = true;
    });
    this.on(window, 'mouseup', function (e) {
      if (e.button === 0) self.fire = false;
      if (e.button === 2) self.altFire = false;
    });
    this.on(this.canvas, 'contextmenu', function (e) { e.preventDefault(); });

    this.on(window, 'mousemove', function (e) {
      if (!self.locked) return;
      self.mouseDX += e.movementX || 0;
      self.mouseDY += e.movementY || 0;
    });

    this.on(window, 'wheel', function (e) {
      if (!self.locked) return;
      self.wheel += Math.sign(e.deltaY);
    }, { passive: true });

    this.on(document, 'pointerlockchange', function () {
      self.locked = (document.pointerLockElement === self.canvas);
      game.onLockChange(self.locked);
    });
    this.on(document, 'pointerlockerror', function () {
      self.locked = false;
      game.onLockChange(false);
    });
  };

  Input.prototype.consume = function () {
    var d = { dx: this.mouseDX, dy: this.mouseDY, wheel: this.wheel };
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
    return d;
  };

  Input.prototype.wasPressed = function (k) {
    if (this.pressed[k]) { this.pressed[k] = false; return true; }
    return false;
  };

  Input.prototype.clearPressed = function () { this.pressed = {}; };

  /* ---------------- player ---------------- */

  function Player(x, y) {
    this.x = x; this.y = y; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.angle = 0; this.pitch = 0;
    this.radius = RADIUS;
    this.height = EYE_STAND;
    /* collision body for projectiles: feet at z, head at z + bodyH */
    this.bodyH = 1.0;
    this.health = 120;
    this.maxHealth = 100;
    this.armor = 50;
    this.alive = true;
    this.ammo = { nail: 40, shell: 0, rocket: 0, cell: 0 };
    this.guns = { fist: true, nail: false, shotgun: false, rocket: false, thunder: false };
    this.weapon = 'fist';
    this.pendingWeapon = null;
    this.switchTimer = 0;
    this.fireTimer = 0;
    this.fireAnim = 0;
    this.recoil = 0;
    this.kickView = 0;
    this.bob = 0;
    this.bobAmp = 0;
    this.onGround = true;
    this.crouching = false;
    this.crouch = 0;
    this.stepTimer = 0;
    this.hasKey = false;
    this.megaT = 0;
    this.invuln = 0;
    this.damageFlash = 0;
    this.pickupFlash = 0;
    this.yaw = 0;
    this.roll = 0;
    this.landDust = 0;
    this.kills = 0;
    this.shots = 0;
    this.deathT = 0;
    this.viewTime = 0;
  }

  Player.prototype.selectWeapon = function (key) {
    if (!this.guns[key] || key === this.weapon) return false;
    this.pendingWeapon = key;
    this.switchTimer = 0.22;
    Q2.sound.play('switchWeapon', 0.35);
    return true;
  };

  Player.prototype.cycleWeapon = function (dir) {
    var have = W.ORDER.filter(function (k) { return this.guns[k]; }, this);
    if (have.length < 2) return;
    var i = have.indexOf(this.weapon);
    if (i < 0) i = 0;
    var next = have[(i + dir + have.length) % have.length];
    this.selectWeapon(next);
  };

  Player.prototype.update = function (dt, world) {
    var inp = world.input;
    this.viewTime += dt;

    /* --- look --- */
    var m = inp.consume();
    var sens = 0.0022 * inp.sensitivity;
    this.angle += m.dx * sens;
    this.pitch -= m.dy * sens * (inp.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -0.72, 0.72);
    if (this.angle > Math.PI) this.angle -= util.TAU;
    if (this.angle < -Math.PI) this.angle += util.TAU;

    /* keyboard look (arrows) for machines without a mouse */
    var kl = 1.9 * dt;
    if (inp.keys['arrowleft']) this.angle -= kl;
    if (inp.keys['arrowright']) this.angle += kl;
    if (inp.keys['arrowup']) this.pitch = clamp(this.pitch + kl * 0.6, -0.72, 0.72);
    if (inp.keys['arrowdown']) this.pitch = clamp(this.pitch - kl * 0.6, -0.72, 0.72);

    if (!this.alive) {
      this.deathT += dt;
      this.pitch = util.approach(this.pitch, -0.5, 3, dt);
      this.height = util.approach(this.height, 0.22, 4, dt);
      this.vx = util.approach(this.vx, 0, 6, dt);
      this.vy = util.approach(this.vy, 0, 6, dt);
      return;
    }

    /* --- weapon switching --- */
    if (m.wheel) this.cycleWeapon(m.wheel > 0 ? 1 : -1);
    if (this.switchTimer > 0) {
      this.switchTimer -= dt;
      if (this.switchTimer <= 0 && this.pendingWeapon) {
        this.weapon = this.pendingWeapon;
        this.pendingWeapon = null;
        this.fireTimer = Math.max(this.fireTimer, 0.08);
      }
    }

    /* --- crouch --- */
    this.crouching = !!(inp.keys['control'] || inp.keys['c']);
    this.crouch = util.approach(this.crouch, this.crouching ? 1 : 0, 14, dt);
    this.height = util.lerp(EYE_STAND, EYE_CROUCH, this.crouch);
    this.bodyH = util.lerp(1.0, 0.62, this.crouch);

    /* --- movement --- */
    var fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    var rx = -fy, ry = fx;
    var mf = 0, ms = 0;
    if (inp.keys['w']) mf += 1;
    if (inp.keys['s']) mf -= 1;
    if (inp.keys['a']) ms -= 1;
    if (inp.keys['d']) ms += 1;
    var len = Math.hypot(mf, ms);
    if (len > 1) { mf /= len; ms /= len; }

    var maxSpeed = this.crouching ? CROUCH_SPEED : WALK_SPEED;
    if (this.megaT > 0) { this.megaT -= dt; maxSpeed *= 1.25; }

    var wishX = (fx * mf + rx * ms) * maxSpeed;
    var wishY = (fy * mf + ry * ms) * maxSpeed;

    var accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;
    if (this.onGround) {
      if (len > 0) {
        var k = clamp(accel * dt, 0, 1);
        this.vx += (wishX - this.vx) * k;
        this.vy += (wishY - this.vy) * k;
      } else {
        /* stop cleanly when the keys are released */
        var f = Math.exp(-FRICTION * dt);
        this.vx *= f; this.vy *= f;
        if (Math.hypot(this.vx, this.vy) < 0.05) { this.vx = 0; this.vy = 0; }
      }
      var gs = Math.hypot(this.vx, this.vy);
      var cap = maxSpeed * 1.02;
      if (gs > cap) { this.vx *= cap / gs; this.vy *= cap / gs; }
    } else if (len > 0) {
      /* in the air we accelerate along the wish direction and do not clamp
         the resulting speed: that is what makes rocket/strafe jumps work */
      var ux2 = (fx * mf + rx * ms), uy2 = (fy * mf + ry * ms);
      var ul = Math.hypot(ux2, uy2) || 1;
      this.vx += (ux2 / ul) * accel * maxSpeed * dt;
      this.vy += (uy2 / ul) * accel * maxSpeed * dt;
    }

    /* jump */
    if ((inp.keys[' ']) && this.onGround && !this.crouching) {
      this.vz = JUMP_VZ;
      this.onGround = false;
      Q2.sound.play('jump', 0.28);
    }

    this.vz -= GRAVITY * dt;

    /* integrate with wall sliding */
    var E = Q2.entities;
    var nx = this.x, ny = this.y;
    var stepX = this.vx * dt, stepY = this.vy * dt;
    if (!E.blocked(world.map, nx + stepX, ny, this.radius)) nx += stepX;
    else this.vx *= -0.05;
    if (!E.blocked(world.map, nx, ny + stepY, this.radius)) ny += stepY;
    else this.vy *= -0.05;

    /* doors: open them by walking into the doorway */
    var cell = world.map.at(Math.floor(nx), Math.floor(ny));
    var di = world.map.doorIdx[cell];
    if (di >= 0) {
      var door = world.map.doors[di];
      if (door.locked && !this.hasKey) {
        if (!door.warned) { door.warned = true; world.message('DOOR IS LOCKED — FIND THE ACCESS KEY', '#ff7a5a'); Q2.sound.play('door', 0.4); }
      } else {
        door.warned = false;
        world.map.openDoor(di, this.hasKey);
      }
    }

    this.x = nx; this.y = ny;
    this.z += this.vz * dt;
    if (this.z <= 0) {
      if (!this.onGround && this.vz < -6) {
        var fall = (-this.vz - 6) * 2.2;
        if (fall > 1) this.damage(fall, world, 'fall');
        Q2.sound.play('land', clamp(0.25 + fall * 0.03, 0, 0.7));
        world.shake = Math.min(1, world.shake + clamp(fall * 0.03, 0, 0.4));
        E.burst(world, this.x, this.y, 0.05, 6, Q2.art.fx.spark, { speed: 1.5, size: 0.16, life: 0.3, up: 1, grav: 4 });
      }
      this.z = 0;
      this.vz = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    /* head bob + footsteps */
    var speed = Math.hypot(this.vx, this.vy);
    this.bob += dt * (6 + speed * 1.6);
    this.bobAmp = util.approach(this.bobAmp, this.onGround ? clamp(speed / WALK_SPEED, 0, 1) : 0, 8, dt);
    this.stepTimer -= dt * speed * 0.62;
    if (this.stepTimer <= 0 && this.onGround && speed > 0.6) {
      this.stepTimer = 1;
      Q2.sound.play('step', clamp(0.10 + speed * 0.02, 0, 0.28));
    }

    /* hazard floors */
    var dmgRate = world.map.dmg[cell];
    if (dmgRate > 0) {
      this.damage(dmgRate * dt * (this.crouching ? 1.4 : 1), world, 'lava');
      if (Math.random() < dt * 8) {
        E.burst(world, this.x, this.y, 0.05, 1, Q2.art.fx.spark, { speed: 1, size: 0.2, life: 0.4, up: 3, grav: 2 });
      }
    }

    /* --- shooting --- */
    if (this.fireTimer > 0) this.fireTimer -= dt;
    if (inp.fire && this.fireTimer <= 0 && !this.pendingWeapon) {
      W.fire(this, this.weapon, world);
      this.shots++;
    }
    if ((inp.altFire || inp.keys['f']) && this.fireTimer <= 0) {
      /* alt fire: same gun, wider cone — also the keyboard fire key */
      W.fire(this, this.weapon, world);
      this.shots++;
    }

    /* view model animation decay */
    this.fireAnim = util.approach(this.fireAnim, 0, 9, dt);
    this.kickView = util.approach(this.kickView, 0, 10, dt);
    this.recoil = util.approach(this.recoil, 0, 12, dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
    this.pickupFlash = Math.max(0, this.pickupFlash - dt * 3);
    if (this.invuln > 0) this.invuln -= dt;

    /* view roll from strafing, Quake-style lean */
    var lat = this.vx * rx + this.vy * ry;
    this.roll = util.approach(this.roll, clamp(-lat / maxSpeed, -1, 1) * 0.035, 8, dt);
    this.yaw = util.approach(this.yaw, clamp(-lat / maxSpeed, -1, 1) * 0.02, 6, dt);
  };

  Player.prototype.damage = function (amount, world, source, sx, sy) {
    if (!this.alive || amount <= 0) return;
    if (this.invuln > 0 && source !== 'lava') return;
    var a = this.armor;
    if (a > 0) {
      var absorbed = Math.min(a, amount * 0.4);
      this.armor -= absorbed;
      amount -= absorbed;
    }
    this.health -= amount;
    this.damageFlash = Math.min(1.4, this.damageFlash + amount * 0.035 + 0.25);
    world.shake = Math.min(1.4, world.shake + clamp(amount * 0.02, 0.05, 0.4));
    if (sx !== undefined) { world.hurtDir = world.angleOf(sx, sy); world.hurtT = 1; }
    Q2.sound.play('pain' + (this.health > 60 ? 0 : (this.health > 25 ? 1 : 2)), 0.55);
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deathT = 0;
      world.playerDied(source);
    }
  };

  Q2.player = {
    Player: Player,
    Input: Input,
    EYE_STAND: EYE_STAND,
    RADIUS: RADIUS
  };
})(window.Q2);
