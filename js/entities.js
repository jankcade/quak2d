/*
 * entities.js — enemies, projectiles, pickups, particles, corpses.
 *
 * Every entity is a plain object with update(dt, world). `world` is the
 * game's mutable state: { map, player, enemies, projectiles, items,
 * particles, corpses, time, ...helpers }.
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;
  var art = Q2.art;

  /* ---------------- type table ---------------- */

  var TYPES = {
    grunt: {
      hp: 30, speed: 2.1, radius: 0.30, height: 1.0, score: 100,
      attack: 'hitscan', damage: 7, spread: 0.10, rate: 1.15, range: 13,
      sight: 17, preferred: 5.0, pain: 0.35, mass: 1, splash: 0, drop: ['ammo_nails', 'health_small']
    },
    soldier: {
      hp: 60, speed: 2.4, radius: 0.34, height: 1.15, score: 200,
      attack: 'projectile', sprite: 'plasmaBlue', damage: 12, spread: 0.04, rate: 1.4,
      range: 16, sight: 20, speed2: 9, preferred: 7.0, pain: 0.25, mass: 1.6,
      drop: ['ammo_cells', 'armor_shard']
    },
    hound: {
      hp: 45, speed: 4.3, radius: 0.36, height: 0.8, score: 150,
      attack: 'melee', damage: 16, rate: 0.85, range: 2.0,
      /* melee monsters have to cross the room, so they spot you early, and
         they press right into contact so the bite actually lands */
      sight: 16, preferred: 0.8, pain: 0.45, mass: 1.2, drop: []
    },
    mage: {
      hp: 70, speed: 1.7, radius: 0.34, height: 1.3, score: 300,
      attack: 'projectile', sprite: 'plasmaGreen', damage: 15, spread: 0.06, rate: 1.9,
      range: 17, sight: 21, speed2: 7.5, preferred: 8.5, pain: 0.2, mass: 1.6, float: true,
      drop: ['ammo_cells', 'health_small']
    },
    fiend: {
      hp: 200, speed: 2.6, radius: 0.5, height: 1.35, score: 500,
      attack: 'projectile', sprite: 'plasmaRed', damage: 14, spread: 0.16, rate: 1.5,
      range: 12, sight: 18, speed2: 8, burst: 3, preferred: 3.5, pain: 0.12, mass: 3,
      drop: ['ammo_rockets', 'health_large']
    },
    boss: {
      hp: 900, speed: 2.2, radius: 0.72, height: 2.0, score: 2000,
      attack: 'projectile', sprite: 'plasmaRed', damage: 22, spread: 0.10, rate: 1.25,
      range: 20, sight: 24, speed2: 9.5, burst: 5, preferred: 6.5, pain: 0.04, mass: 12,
      drop: ['megahealth', 'armor']
    }
  };

  Q2.enemyTypes = TYPES;

  /* ---------------- shared helpers ---------------- */

  /* slide a circle against the grid, axis separated */
  function moveCircle(map, e, dx, dy) {
    var r = e.radius;
    var x = e.x, y = e.y;
    var nx = x + dx;
    if (!blocked(map, nx, y, r)) x = nx;
    var ny = y + dy;
    if (!blocked(map, x, ny, r)) y = ny;
    e.x = x; e.y = y;
  }

  function blocked(map, x, y, r) {
    var steps = [[r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]];
    for (var i = 0; i < steps.length; i++) {
      if (map.isSolid(Math.floor(x + steps[i][0]), Math.floor(y + steps[i][1]))) return true;
    }
    return false;
  }

  /* grid DDA: true if nothing solid between the two points */
  function lineOfSight(map, x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return true;
    var stepX = Math.sign(dx), stepY = Math.sign(dy);
    var tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
    var tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
    var mapX = Math.floor(x0), mapY = Math.floor(y0);
    var tMaxX = dx === 0 ? Infinity : ((stepX > 0 ? (mapX + 1 - x0) : (x0 - mapX)) / Math.abs(dx));
    var tMaxY = dy === 0 ? Infinity : ((stepY > 0 ? (mapY + 1 - y0) : (y0 - mapY)) / Math.abs(dy));
    var t = 0, guard = 0;
    while (t < 1 && guard++ < 4096) {
      if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; mapX += stepX; }
      else { t = tMaxY; tMaxY += tDeltaY; mapY += stepY; }
      if (t > 1) break;
      if (map.blocksSight(mapX, mapY)) return false;
    }
    return true;
  }

  /* march a ray, returning the first hit on geometry or an entity.
   * Entities are tested with a proper circle/segment intersection over each
   * grid step so fast shots cannot pass between two crossings. */
  function castRay(map, ents, ox, oy, dx, dy, maxDist) {
    var stepX = Math.sign(dx), stepY = Math.sign(dy);
    var tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
    var tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
    var mapX = Math.floor(ox), mapY = Math.floor(oy);
    var tMaxX = dx === 0 ? Infinity : ((stepX > 0 ? (mapX + 1 - ox) : (ox - mapX)) / Math.abs(dx));
    var tMaxY = dy === 0 ? Infinity : ((stepY > 0 ? (mapY + 1 - oy) : (oy - mapY)) / Math.abs(dy));
    var dist = 0, guard = 0;

    function entityHit(t0, t1) {
      var best = null, bestT = Infinity;
      for (var i = 0; i < ents.length; i++) {
        var e = ents[i];
        if (!e.alive || e.solid === false) continue;
        var r = e.radius;
        /* segment (ox,oy)+t*(dx,dy) for t in [t0,t1] vs circle (e.x,e.y,r) */
        var mx = ox - e.x, my = oy - e.y;
        var b = mx * dx + my * dy;
        var c = mx * mx + my * my - r * r;
        var disc = b * b - c;
        if (disc < 0) continue;
        var sq = Math.sqrt(disc);
        var t = -b - sq;
        if (t < t0) t = -b + sq;
        if (t > t1 || t < 0) continue;
        if (t < bestT) { bestT = t; best = e; }
      }
      return best ? { entity: best, dist: bestT } : null;
    }

    while (guard++ < 512) {
      var next, side;
      if (tMaxX < tMaxY) { next = tMaxX; tMaxX += tDeltaX; mapX += stepX; side = 0; }
      else { next = tMaxY; tMaxY += tDeltaY; mapY += stepY; side = 1; }
      if (next > maxDist) next = maxDist;
      var eh = entityHit(dist, next);
      if (eh) {
        return {
          type: 'entity', entity: eh.entity, dist: eh.dist,
          x: ox + dx * eh.dist, y: oy + dy * eh.dist, nx: -dx, ny: -dy
        };
      }
      dist = next;
      if (dist >= maxDist) return null;
      if (map.blocksSight(mapX, mapY)) {
        return {
          type: 'wall', dist: dist, x: ox + dx * dist, y: oy + dy * dist,
          cellX: mapX, cellY: mapY, side: side,
          nx: side === 0 ? -stepX : 0, ny: side === 1 ? -stepY : 0
        };
      }
    }
    return null;
  }

  /* ---------------- particles ---------------- */

  function addParticle(world, p) {
    p.life = p.life || 0.5;
    p.maxLife = p.life;
    p.size = p.size || 0.35;
    p.spin = p.spin || 0;
    p.rot = p.rot || 0;
    p.fade = p.fade === undefined ? 1 : p.fade;
    world.particles.push(p);
    return p;
  }

  function burst(world, x, y, z, n, sprite, opts) {
    opts = opts || {};
    var rng = world.rng;
    for (var i = 0; i < n; i++) {
      var a = rng.next() * util.TAU;
      var sp = (opts.speed || 3) * (0.3 + rng.next());
      addParticle(world, {
        x: x, y: y, z: z,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        vz: (opts.up === undefined ? 2.2 : opts.up) * rng.next() + 0.5,
        sprite: sprite, size: (opts.size || 0.3) * (0.6 + rng.next() * 0.8),
        life: (opts.life || 0.5) * (0.6 + rng.next() * 0.7),
        grav: opts.grav === undefined ? 9 : opts.grav,
        fade: 1, rot: rng.next() * 6.28, spin: (rng.next() - 0.5) * 8
      });
    }
  }

  function spawnExplosionFx(world, x, y, z, scale) {
    world.explosions.push({ x: x, y: y, z: z, t: 0, dur: 0.42, scale: scale || 1 });
    burst(world, x, y, z, Math.round(10 * scale), art.fx.spark, { speed: 6 * scale, size: 0.22, life: 0.5, up: 4 });
  }

  /* ---------------- projectiles ---------------- */

  function Projectile(o) {
    this.x = o.x; this.y = o.y; this.z = o.z || 0.6;
    this.vx = o.vx; this.vy = o.vy; this.vz = o.vz || 0;
    this.sprite = o.sprite || art.fx.plasmaBlue;
    this.size = o.size || 0.35;
    this.damage = o.damage || 10;
    this.splash = o.splash || 0;
    this.splashRadius = o.splashRadius || 3;
    this.owner = o.owner || 'player';
    this.life = o.life || 6;
    this.alive = true;
    this.solid = false;
    this.trail = 0;
    this.gravity = o.gravity || 0;
    this.sound = o.sound || null;
    this.pierce = 0;
    this.radius = 0.12;
  }

  Projectile.prototype.update = function (dt, world) {
    this.life -= dt;
    if (this.life <= 0) { this.explode(world); return; }
    var speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    var dist = speed * dt;
    var dx = this.vx * dt, dy = this.vy * dt;
    /* substep so fast rockets cannot tunnel through walls */
    var steps = Math.max(1, Math.ceil(dist / 0.25));
    for (var s = 0; s < steps; s++) {
      var sx = dx / steps, sy = dy / steps;
      var nx = this.x + sx, ny = this.y + sy;
      if (world.map.isSolid(Math.floor(nx), Math.floor(ny))) {
        this.explode(world);
        return;
      }
      this.x = nx; this.y = ny;
      this.z += this.vz * dt / steps;
      if (this.gravity) this.vz -= this.gravity * dt / steps;
      if (this.z < 0.05) { this.z = 0.05; this.explode(world); return; }
      /* hit an entity */
      var hit = hitEntity(world, this);
      if (hit) { this.hitEntity(world, hit); if (!this.alive) return; }
    }
    this.trail += dt;
    if (this.trail > 0.03) {
      this.trail = 0;
      addParticle(world, {
        x: this.x, y: this.y, z: this.z, vx: 0, vy: 0, vz: 0,
        sprite: this.sprite, size: this.size * 0.8, life: 0.18, grav: 0, fade: 0.6,
        rot: 0, spin: 0
      });
    }
  };

  function hitEntity(world, p) {
    var list = p.owner === 'player' ? world.targets : [world.player];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e.alive) continue;
      var dx = e.x - p.x, dy = e.y - p.y;
      var rr = e.radius + p.size * 0.6;
      if (dx * dx + dy * dy < rr * rr) {
        /* vertical body box: the player is a crouching-capable capsule, not
           just an eye point, so plasma at chest height has to connect */
        var top = e.z + (e.bodyH || e.height);
        if (p.z > e.z - 0.35 && p.z < top + 0.35) return e;
      }
    }
    return null;
  }

  Projectile.prototype.hitEntity = function (world, e) {
    if (this.splash > 0) { this.explode(world); return; }
    if (e === world.player) {
      world.damagePlayer(this.damage, this.x, this.y, 'plasma');
    } else if (e.isItem) {
      world.damageItem(e, this.damage);
    } else {
      world.damageEnemy(e, this.damage, this.x, this.y, this.owner === 'player' ? world.lastWeapon : 'enemy', 0);
    }
    burst(world, this.x, this.y, this.z, 5, art.fx.spark, { speed: 3, size: 0.18, life: 0.3, up: 2 });
    this.alive = false;
  };

  Projectile.prototype.explode = function (world) {
    if (!this.alive) return;
    this.alive = false;
    if (this.splash > 0) {
      world.splashDamage(this.x, this.y, this.z, this.splash, this.splashRadius, this.owner);
      spawnExplosionFx(world, this.x, this.y, this.z, this.splashRadius / 3);
      Q2.sound.play('explosion', clamp(0.9 - world.distToPlayer(this.x, this.y) / 30, 0.05, 0.9),
        world.panOf(this.x, this.y), 0.9 + world.rng.next() * 0.25);
    } else {
      burst(world, this.x, this.y, this.z, 4, art.fx.spark, { speed: 2.5, size: 0.16, life: 0.25, up: 1.5 });
    }
  };

  /* ---------------- enemy ---------------- */

  function Enemy(type, x, y, opts) {
    var t = TYPES[type] || TYPES.grunt;
    this.type = type;
    this.t = t;
    this.x = x; this.y = y; this.z = 0;
    this.vx = 0; this.vy = 0;
    this.radius = t.radius;
    this.height = t.height;
    this.hp = t.hp;
    this.maxHp = t.hp;
    this.alive = true;
    this.solid = true;
    this.boss = !!(opts && opts.boss);
    this.angle = (opts && opts.angle) || 0;
    this.state = 'idle';
    this.cooldown = 0.5 + Math.random() * 0.8;
    this.animT = Math.random() * 4;
    this.painT = 0;
    this.deathT = 0;
    this.frame = 0;
    this.alert = false;
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.strafeT = 1 + Math.random() * 2;
    this.burstLeft = 0;
    this.burstT = 0;
    this.homeX = x; this.homeY = y;
    this.knockX = 0; this.knockY = 0;
    this.floatPhase = Math.random() * 6.28;
    this.attention = 0;
    /* set from the difficulty by the world */
    this.dmgMult = 1;
    this.dropChance = 0.6;
  }

  Enemy.prototype.update = function (dt, world) {
    var t = this.t;
    if (!this.alive) {
      this.deathT += dt;
      return;
    }
    this.animT += dt;

    var p = world.player;
    var dx = p.x - this.x, dy = p.y - this.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
    var sight = t.sight || (t.range + 6);
    var los = dist < sight && p.alive && lineOfSight(world.map, this.x, this.y, p.x, p.y);

    if (los && p.alive) {
      if (!this.alert) {
        this.alert = true;
        Q2.sound.play('spawn', clamp(0.5 - dist / 40, 0.03, 0.5), world.panOf(this.x, this.y));
      }
      this.state = 'fight';
      this.attention = 1;
    } else {
      this.attention = clamp(this.attention - dt * 0.4, 0, 1);
      if (this.attention <= 0) this.state = 'idle';
    }

    /* pain stagger */
    if (this.painT > 0) {
      this.painT -= dt;
      moveCircle(world.map, this, this.vx * dt, this.vy * dt);
      this.vx = util.approach(this.vx, 0, 6, dt);
      this.vy = util.approach(this.vy, 0, 6, dt);
      return;
    }

    var want = t.preferred;
    var speed = t.speed * (this.boss ? 1 : 1);
    var mvx = 0, mvy = 0;

    if (this.state === 'fight' && p.alive) {
      var ux = dx / dist, uy = dy / dist;
      /* keep range: approach, back off, and strafe. The dead band scales with
         the preferred distance so melee monsters press into contact. */
      var band = Math.min(1.2, want * 0.4 + 0.25);
      var radial = 0;
      if (dist > want + band) radial = 1;
      else if (dist < want - band) radial = -1;
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeT = 1 + Math.random() * 2.2; this.strafe = Math.random() < 0.5 ? 1 : -1; }
      var sx = -uy * this.strafe, sy = ux * this.strafe;
      mvx = (ux * radial + sx * 0.75) * speed;
      mvy = (uy * radial + sy * 0.75) * speed;
      this.angle = Math.atan2(dy, dx);

      /* separation from other enemies so they do not stack */
      for (var i = 0; i < world.enemies.length; i++) {
        var o = world.enemies[i];
        if (o === this || !o.alive) continue;
        var ox = this.x - o.x, oy = this.y - o.y;
        var od = ox * ox + oy * oy;
        var minD = (this.radius + o.radius) * 1.15;
        if (od < minD * minD && od > 0.0001) {
          var f = (minD - Math.sqrt(od)) / minD;
          mvx += (ox / Math.sqrt(od)) * f * speed * 1.6;
          mvy += (oy / Math.sqrt(od)) * f * speed * 1.6;
        }
      }

      /* attack: only inside weapon range, and only with a clear shot */
      this.cooldown -= dt;
      if (this.burstLeft > 0) {
        this.burstT -= dt;
        if (this.burstT <= 0) { this.burstLeft--; this.burstT = 0.14; fireAt(this, world, ux, uy); }
      } else if (this.cooldown <= 0 && los && dist < t.range + 0.4) {
        if (t.burst) { this.burstLeft = t.burst; this.burstT = 0; }
        else fireAt(this, world, ux, uy);
        this.cooldown = t.rate * (0.8 + Math.random() * 0.5);
      }
    } else {
      /* idle: wander around the post so the level feels inhabited, and so a
         player who shoots from a distance draws a crowd */
      this.wanderT = (this.wanderT || 0) - dt;
      if (this.wanderT <= 0) {
        this.wanderT = 1.5 + Math.random() * 3;
        var a = Math.random() * util.TAU;
        this.wanderX = Math.cos(a);
        this.wanderY = Math.sin(a);
      }
      var hx = this.homeX - this.x, hy = this.homeY - this.y;
      var hd = Math.sqrt(hx * hx + hy * hy);
      if (hd > 2.4) {
        mvx = (hx / hd) * speed * 0.4;
        mvy = (hy / hd) * speed * 0.4;
        this.angle = Math.atan2(hy, hx);
      } else {
        mvx = this.wanderX * speed * 0.22;
        mvy = this.wanderY * speed * 0.22;
        if (mvx || mvy) this.angle = Math.atan2(mvy, mvx);
      }
    }

    /* lava / hazard floors hurt */
    var cell = world.map.at(Math.floor(this.x), Math.floor(this.y));
    var cellDmg = world.map.dmg[cell];
    if (cellDmg > 0) {
      this.hp -= cellDmg * dt * 0.6;
      if (this.hp <= 0) { world.killEnemy(this, 'environment'); return; }
    }

    /* knockback impulse decays */
    mvx += this.knockX; mvy += this.knockY;
    this.knockX = util.approach(this.knockX, 0, 8, dt);
    this.knockY = util.approach(this.knockY, 0, 8, dt);

    this.vx = util.approach(this.vx, mvx, 9, dt);
    this.vy = util.approach(this.vy, mvy, 9, dt);
    moveCircle(world.map, this, this.vx * dt, this.vy * dt);

    /* floaters hover */
    if (t.float) {
      this.floatPhase += dt * 2.4;
      this.z = 0.25 + Math.sin(this.floatPhase) * 0.18;
    }

    /* open doors it walks into (enemies cannot pick locks) */
    var di = world.map.doorIdx[cell];
    if (di >= 0) world.map.openDoor(di, false);

    /* animation frame from horizontal speed */
    var sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    this.frame = Math.floor(this.animT * (2 + sp * 2.2)) % 4;
  };

  function fireAt(e, world, ux, uy) {
    var t = e.t;
    var kind = t.attack;
    var pan = world.panOf(e.x, e.y);
    var vol = clamp(0.85 - world.distToPlayer(e.x, e.y) / 26, 0.05, 0.85);
    var dmg = t.damage * (e.dmgMult || 1);
    if (kind === 'melee') {
      Q2.sound.play('pain' + (e.type === 'hound' ? 2 : 0), vol * 0.7, pan, 0.7);
      var p = world.player;
      var d = util.dist2(e.x, e.y, p.x, p.y);
      if (d < (e.radius + p.radius + 1.2) * (e.radius + p.radius + 1.2)) {
        world.damagePlayer(dmg, e.x, e.y, 'claw');
      }
      burst(world, e.x + ux * 0.6, e.y + uy * 0.6, 0.6, 4, art.fx.spark, { speed: 2, size: 0.15, life: 0.2, up: 1 });
      return;
    }
    if (kind === 'hitscan') {
      Q2.sound.play('enemyShoot0', vol, pan, 0.9 + Math.random() * 0.2);
      var a = Math.atan2(uy, ux) + (Math.random() - 0.5) * t.spread;
      var dx = Math.cos(a), dy = Math.sin(a);
      var hit = castRay(world.map, [world.player], e.x + dx * 0.6, e.y + dy * 0.6, dx, dy, t.range + 6);
      if (hit && hit.type === 'entity' && hit.entity === world.player) {
        world.damagePlayer(dmg, hit.x, hit.y, 'bullet');
      } else if (hit) {
        burst(world, hit.x, hit.y, 0.7, 3, art.fx.spark, { speed: 2, size: 0.12, life: 0.2, up: 1 });
      }
      return;
    }
    /* projectile */
    Q2.sound.play(e.type === 'fiend' ? 'enemyShoot2' : (e.type === 'boss' ? 'enemyShoot2' : 'enemyShoot1'),
      vol, pan, 0.9 + Math.random() * 0.2);
    var ang = Math.atan2(uy, ux) + (Math.random() - 0.5) * t.spread;
    var sp = t.speed2 || 8;
    world.projectiles.push(new Projectile({
      x: e.x + Math.cos(ang) * (e.radius + 0.25),
      y: e.y + Math.sin(ang) * (e.radius + 0.25),
      z: e.z + e.height * 0.55,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      vz: e.type === 'fiend' ? 1.2 : 0,
      sprite: art.fx[t.sprite || 'plasmaBlue'],
      size: e.boss ? 0.5 : 0.32,
      damage: dmg,
      owner: 'enemy',
      life: 5
    }));
  }

  /* ---------------- items ---------------- */

  var ITEM_DEFS = {
    health_small: { sprite: 'health', label: 'MEDKIT', sound: 'pickupHealth', apply: function (p, w) { p.health = Math.min(p.maxHealth, p.health + 25); w.message('+25 HEALTH', '#7ce88f'); } },
    health_large: { sprite: 'health', label: 'SUPERSHELL', sound: 'pickupHealth', apply: function (p, w) { p.health = Math.min(p.maxHealth + 50, p.health + 75); w.message('+75 HEALTH', '#7ce88f'); } },
    megahealth: { sprite: 'megahealth', label: 'MEGA HEALTH', sound: 'pickupHealth', apply: function (p, w) { p.health = Math.max(p.health, 200); p.healthCap = 200; p.maxHealth = 200; p.megaT = 20; w.message('MEGA HEALTH! 200', '#7fd8ff'); } },
    armor_shard: { sprite: 'armorShard', label: 'ARMOR SHARD', sound: 'pickupArmor', apply: function (p, w) { p.armor = Math.min(200, p.armor + 25); w.message('+25 ARMOR', '#7ce88f'); } },
    armor: { sprite: 'armor', label: 'COMBAT ARMOR', sound: 'pickupArmor', apply: function (p, w) { p.armor = Math.min(200, p.armor + 100); w.message('+100 ARMOR', '#7ce88f'); } },
    ammo_nails: { sprite: 'ammoNails', label: 'NAILS', sound: 'pickupAmmo', apply: function (p, w) { p.ammo.nail += 50; w.message('+50 NAILS', '#ffd070'); } },
    ammo_shells: { sprite: 'ammoShells', label: 'SHELLS', sound: 'pickupAmmo', apply: function (p, w) { p.ammo.shell += 12; w.message('+12 SHELLS', '#ffd070'); } },
    ammo_rockets: { sprite: 'ammoRockets', label: 'ROCKETS', sound: 'pickupAmmo', apply: function (p, w) { p.ammo.rocket += 6; w.message('+6 ROCKETS', '#ffd070'); } },
    ammo_cells: { sprite: 'ammoCells', label: 'CELLS', sound: 'pickupAmmo', apply: function (p, w) { p.ammo.cell += 40; w.message('+40 CELLS', '#ffd070'); } },
    gun_nail: { sprite: 'gunNail', label: 'NAILGUN', sound: 'pickupWeapon', gun: 'nail', ammo: 'nail', give: 40, apply: function (p, w) { w.giveGun(p, 'nail', 40); } },
    gun_shotgun: { sprite: 'gunShotgun', label: 'SHOTGUN', sound: 'pickupWeapon', gun: 'shotgun', ammo: 'shell', give: 10, apply: function (p, w) { w.giveGun(p, 'shotgun', 10); } },
    gun_rocket: { sprite: 'gunRocket', label: 'ROCKET LAUNCHER', sound: 'pickupWeapon', gun: 'rocket', ammo: 'rocket', give: 4, apply: function (p, w) { w.giveGun(p, 'rocket', 4); } },
    gun_thunder: { sprite: 'gunThunder', label: 'THUNDER GUN', sound: 'pickupWeapon', gun: 'thunder', ammo: 'cell', give: 30, apply: function (p, w) { w.giveGun(p, 'thunder', 30); } },
    key: { sprite: 'key', label: 'ACCESS KEY', sound: 'key', apply: function (p, w) { p.hasKey = true; w.message('ACCESS KEY TAKEN', '#ffd070'); } },
    exit: { sprite: 'secret', label: 'EXIT', special: 'exit' },
    env_canister: { sprite: 'envCanister', label: 'CANISTER', solid: true, hp: 20, explosive: true }
  };

  Q2.itemDefs = ITEM_DEFS;

  function Item(kind, x, y) {
    var d = ITEM_DEFS[kind] || ITEM_DEFS.health_small;
    this.kind = kind;
    this.def = d;
    this.x = x; this.y = y;
    this.z = 0.15;
    this.radius = 0.32;
    this.alive = true;
    this.solid = !!d.solid;
    this.hp = d.hp || 0;
    this.spin = Math.random() * 6.28;
    this.bob = Math.random() * 6.28;
    this.maxHp = d.hp || 0;
    this.isExit = d.special === 'exit';
    this.height = this.isExit ? 1.6 : 0.6;
    this.isItem = true;
    this.score = 0;
    this.radius = this.radius || 0.32;
  }

  Item.prototype.update = function (dt, world) {
    this.spin += dt * 1.6;
    this.bob += dt * 2.2;
    if (this.isExit) {
      var p = world.player;
      if (p.alive && util.dist2(this.x, this.y, p.x, p.y) < 0.55 * 0.55) world.reachExit();
    }
  };

  Item.prototype.pickup = function (world) {
    var d = this.def;
    if (d.apply) d.apply(world.player, world);
    if (d.sound) {
      Q2.sound.play(d.sound, 0.6, world.panOf(this.x, this.y));
    }
    burst(world, this.x, this.y, 0.5, 6, art.fx.spark, { speed: 1.6, size: 0.14, life: 0.3, up: 2, grav: 2 });
    this.alive = false;
  };

  Q2.entities = {
    TYPES: TYPES,
    Enemy: Enemy,
    Projectile: Projectile,
    Item: Item,
    ITEM_DEFS: ITEM_DEFS,
    moveCircle: moveCircle,
    blocked: blocked,
    lineOfSight: lineOfSight,
    castRay: castRay,
    addParticle: addParticle,
    burst: burst,
    spawnExplosionFx: spawnExplosionFx
  };
})(window.Q2);
