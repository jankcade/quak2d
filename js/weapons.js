/*
 * weapons.js — weapon definitions, firing, hitscan, recoil and the
 * first-person view model animation.
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;
  var art = Q2.art;
  var E = Q2.entities;

  var WEAPONS = {
    fist: {
      id: 0, name: 'FIST', slot: 1, ammo: null, use: 0, damage: 22,
      rate: 0.42, kind: 'melee', range: 1.6, kick: 0.10, sound: null,
      view: art.views.fist, spread: 0, pellets: 1, splash: 0, auto: false
    },
    nail: {
      id: 1, name: 'NAILGUN', slot: 2, ammo: 'nail', use: 1, damage: 11,
      rate: 0.105, kind: 'hitscan', range: 26, kick: 0.055, sound: 'shoot1',
      view: art.views.nail, spread: 0.018, pellets: 1, splash: 0, auto: true,
      muzzle: 0.55
    },
    shotgun: {
      id: 2, name: 'SHOTGUN', slot: 3, ammo: 'shell', use: 1, damage: 8,
      rate: 0.62, kind: 'hitscan', range: 20, kick: 0.30, sound: 'shoot2',
      view: art.views.shotgun, spread: 0.075, pellets: 8, splash: 0, auto: false,
      muzzle: 0.9
    },
    rocket: {
      id: 3, name: 'ROCKET LAUNCHER', slot: 4, ammo: 'rocket', use: 1, damage: 70,
      rate: 0.85, kind: 'projectile', range: 30, kick: 0.34, sound: 'shoot3',
      view: art.views.rocket, spread: 0.01, pellets: 1, splash: 70, splashRadius: 3.4,
      auto: false, speed: 14, muzzle: 1, selfKick: 3.2, grav: 0.6
    },
    thunder: {
      id: 4, name: 'THUNDER GUN', slot: 5, ammo: 'cell', use: 9, damage: 34,
      rate: 0.72, kind: 'projectile', range: 30, kick: 0.30, sound: 'shoot4',
      view: art.views.thunder, spread: 0.02, pellets: 1, splash: 40, splashRadius: 2.8,
      auto: true, speed: 13, muzzle: 1, selfKick: 0
    }
  };

  var ORDER = ['fist', 'nail', 'shotgun', 'rocket', 'thunder'];
  ORDER.forEach(function (k) { WEAPONS[k].key = k; });

  Q2.WEAPONS = WEAPONS;
  Q2.WEAPON_ORDER = ORDER;

  /* ---------------- firing ---------------- */

  function canFire(player, w) {
    if (!w.ammo) return true;
    return (player.ammo[w.ammo] || 0) >= w.use;
  }

  /* Fire one shot. world provides castRay, damageEnemy, splashDamage, ... */
  function fire(player, key, world) {
    var w = WEAPONS[key];
    if (!w) return false;
    if (!canFire(player, w)) {
      Q2.sound.play('empty', 0.35);
      player.fireTimer = 0.25;
      return false;
    }
    if (w.ammo) player.ammo[w.ammo] -= w.use;

    player.fireTimer = w.rate;
    player.fireAnim = 1;
    player.recoil += w.kick;
    player.kickView = Math.min(1.4, player.kickView + w.kick * 2.2);
    world.shake = Math.min(1.1, world.shake + w.kick * (w.kind === 'projectile' ? 1.1 : 0.55));
    world.lastWeapon = key;

    var spread = w.spread * (player.crouching ? 0.55 : 1) * (player.onGround ? 1 : 1.7);

    if (w.sound) {
      Q2.sound.play(w.sound, 0.85, 0, 0.96 + Math.random() * 0.08);
    }

    /* muzzle flash anchored to the gun */
    world.muzzle = { t: 0, dur: 0.09, key: key, power: w.muzzle || 0.6 };

    for (var p = 0; p < w.pellets; p++) {
      var ang = player.angle + (Math.random() - 0.5) * spread * 2;
      /* 2D ray direction is unit length; dz is the rise per unit of distance */
      var dx = Math.cos(ang), dy = Math.sin(ang);
      var dz = Math.tan(player.pitch);

      if (w.kind === 'melee') {
        meleeHit(player, w, world, ang);
        break;
      }
      if (w.kind === 'hitscan') {
        hitscan(player, w, world, dx, dy, dz, ang);
      } else {
        spawnProjectile(player, w, world, dx, dy, dz);
      }
    }

    /* rocket self-propulsion (Quake-ish rocket jumping, nerfed) */
    if (w.selfKick && player.onGround) {
      player.vz = Math.max(player.vz, 0);
    }
    return true;
  }

  function meleeHit(player, w, world, ang) {
    Q2.sound.play('hitFlesh', 0.4);
    var dx = Math.cos(ang), dy = Math.sin(ang);
    var hit = E.castRay(world.map, world.targets, player.x, player.y, dx, dy, w.range + 0.6);
    if (hit && hit.type === 'entity') {
      world.damageEnemy(hit.entity, w.damage, hit.x, hit.y, 'fist', 1.5);
    }
    world.meleeSwing = 1;
  }

  function hitscan(player, w, world, dx, dy, dz, ang) {
    var hit = E.castRay(world.map, world.targets, player.x, player.y, dx, dy, w.range);
    if (!hit) return;
    var hz = 0.62 + dz * hit.dist;   /* height of the ray where it landed */

    if (hit.type === 'entity') {
      var e = hit.entity;
      /* the ray is cast in 2D, so confirm the shot's height really meets the
         target: firing over a grunt's head must not hit him */
      if (hz >= e.z - 0.2 && hz <= e.z + e.height + 0.2) {
        world.damageEnemy(e, w.damage, hit.x, hit.y, w.name, 0.6);
      }
    } else {
      /* wall spark, and blastable secrets */
      world.sparkWall(hit, w.damage);
    }
    world.tracers.push({
      x0: player.x + dx * 0.4, y0: player.y + dy * 0.4, z0: 0.62,
      x1: hit.x, y1: hit.y, z1: hz,
      t: 0, dur: 0.06
    });
  }

  function spawnProjectile(player, w, world, dx, dy, dz) {    var sp = w.speed || 12;
    var ox = player.x + dx * 0.5, oy = player.y + dy * 0.5;
    var pr = new E.Projectile({
      x: ox, y: oy, z: 0.62 + dz * 0.5,
      vx: dx * sp, vy: dy * sp, vz: dz * sp,
      sprite: w.key === 'thunder' ? art.fx.plasmaBlue : art.fx.rocket,
      size: w.splashRadius ? 0.34 : 0.25,
      damage: w.damage,
      splash: w.splash,
      splashRadius: w.splashRadius,
      owner: 'player',
      life: 6,
      gravity: w.grav || 0
    });
    world.projectiles.push(pr);
    if (w.selfKick) {
      /* firing a rocket at your own feet launches you */
      var fwd = Math.max(0, -dz);
      player.vz = Math.max(player.vz, w.selfKick * (0.5 + fwd));
      player.onGround = false;
    }
  }

  function key_is_rocket(w) { return w.name.indexOf('ROCKET') === 0; }

  Q2.weapons = {
    WEAPONS: WEAPONS,
    ORDER: ORDER,
    fire: fire,
    canFire: canFire
  };
})(window.Q2);
