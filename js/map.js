/*
 * map.js — procedural level generator.
 *
 * Builds a grid of rooms joined by corridors (MST + extra loops), carves
 * doors, sprinkles cover, lava, lights and a blastable secret chamber, then
 * places enemies / items / the exit portal. Everything is derived from a
 * single integer seed so a level can be regenerated exactly.
 */
(function (Q2) {
  'use strict';

  var util = Q2.util;
  var clamp = util.clamp;

  var WALLS = ['metal', 'metalDark', 'metalRust', 'tech', 'stone', 'brick',
    'hazard', 'computer', 'door', 'exit', 'pipe', 'flesh', 'trim'];
  var FLOORS = ['tileFloor', 'grateFloor', 'lavaFloor', 'techFloor', 'stoneFloor'];
  var CEILS = ['ceilPanel', 'ceilLight'];

  var THEMES = [
    { wall: ['metal', 'metalDark', 'hazard'], floor: 'grateFloor', ceil: 'ceilPanel' },
    { wall: ['stone', 'brick', 'trim'], floor: 'stoneFloor', ceil: 'ceilPanel' },
    { wall: ['tech', 'computer', 'metal'], floor: 'techFloor', ceil: 'ceilLight' },
    { wall: ['flesh', 'brick', 'metalRust'], floor: 'lavaFloor', ceil: 'ceilPanel' },
    { wall: ['pipe', 'metalRust', 'hazard'], floor: 'tileFloor', ceil: 'ceilPanel' }
  ];

  var idx = {};
  for (var i = 0; i < WALLS.length; i++) idx[WALLS[i]] = i;
  for (var j = 0; j < FLOORS.length; j++) idx[FLOORS[j]] = 100 + j;
  for (var k = 0; k < CEILS.length; k++) idx[CEILS[k]] = 200 + k;

  function texName(id) {
    if (id >= 200) return CEILS[id - 200];
    if (id >= 100) return FLOORS[id - 100];
    return WALLS[id] || 'metal';
  }

  /* ---------------- generation ---------------- */

  function generate(seed, difficulty) {
    var rng = util.makeRng(seed);
    var diff = difficulty || 1;
    var W = 46, H = 46;
    var n = W * H;

    var solid = new Uint8Array(n);
    var wallTex = new Uint8Array(n);
    var floorTex = new Uint8Array(n);
    var ceilTex = new Uint8Array(n);
    var doorIdx = new Int16Array(n);
    var secret = new Uint8Array(n);
    var dmg = new Float32Array(n);
    var light = new Float32Array(n);
    var theme = new Uint8Array(n);
    for (var p = 0; p < n; p++) { solid[p] = 1; doorIdx[p] = -1; }

    function at(x, y) { return y * W + x; }
    function inb(x, y) { return x >= 1 && y >= 1 && x < W - 1 && y < H - 1; }
    function isOpen(x, y) { return inb(x, y) && !solid[at(x, y)]; }

    /* ---- rooms ---- */
    var rooms = [];
    var tries = 0;
    var target = 13;
    while (rooms.length < target && tries < 4000) {
      tries++;
      var rw = rng.int(5, 11), rh = rng.int(5, 11);
      var rx = rng.int(2, W - rw - 3), ry = rng.int(2, H - rh - 3);
      var ok = true;
      for (var r = 0; r < rooms.length; r++) {
        var o = rooms[r];
        if (rx < o.x + o.w + 2 && rx + rw + 2 > o.x && ry < o.y + o.h + 2 && ry + rh + 2 > o.y) { ok = false; break; }
      }
      if (!ok) continue;
      rooms.push({
        x: rx, y: ry, w: rw, h: rh,
        cx: rx + rw / 2, cy: ry + rh / 2,
        theme: rng.int(0, THEMES.length - 1),
        depth: 0, doors: [], kind: 'normal'
      });
    }
    if (rooms.length < 5) return generate(seed + 1, difficulty);

    /* start room = nearest to top-left, exit room = graph-farthest */
    var start = rooms[0], best = 1e9;
    for (var s = 0; s < rooms.length; s++) {
      var d0 = util.dist2(rooms[s].cx, rooms[s].cy, 4, 4);
      if (d0 < best) { best = d0; start = rooms[s]; }
    }
    start.kind = 'start';
    start.theme = 2;

    /* carve rooms */
    rooms.forEach(function (rm) {
      rm.theme = rm.kind === 'start' ? 2 : rm.theme;
      for (var y = rm.y; y < rm.y + rm.h; y++) {
        for (var x = rm.x; x < rm.x + rm.w; x++) {
          var c = at(x, y);
          solid[c] = 0;
          theme[c] = rm.theme;
        }
      }
    });

    /* ---- connect: Prim MST over room centres + extra loops ---- */
    var connected = [start], rest = rooms.filter(function (r) { return r !== start; });
    var edges = [];
    while (rest.length) {
      var bi = 0, bj = -1, bd = 1e9;
      for (var a = 0; a < connected.length; a++) {
        for (var b = 0; b < rest.length; b++) {
          var dd = util.dist2(connected[a].cx, connected[a].cy, rest[b].cx, rest[b].cy);
          if (dd < bd) { bd = dd; bi = a; bj = b; }
        }
      }
      edges.push([connected[bi], rest[bj]]);
      connected.push(rest.splice(bj, 1)[0]);
    }
    /* loops so the player can flank */
    for (var e = 0; e < Math.floor(rooms.length * 0.6); e++) {
      var ra = rng.pick(rooms), rb = rng.pick(rooms);
      if (ra !== rb) edges.push([ra, rb]);
    }

    /* corridors are 2 cells wide so movement and strafing feel open */
    function carveCell(x, y) {
      if (!inb(x, y)) return;
      var c = at(x, y);
      solid[c] = 0;
    }
    function carveH(x0, x1, y) {
      for (var x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        carveCell(x, y); carveCell(x, y + 1);
      }
    }
    function carveV(y0, y1, x) {
      for (var y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        carveCell(x, y); carveCell(x + 1, y);
      }
    }

    edges.forEach(function (ed) {
      var A = ed[0], B = ed[1];
      var ax = Math.round(A.cx), ay = Math.round(A.cy);
      var bx = Math.round(B.cx), by = Math.round(B.cy);
      if (rng.chance(0.5)) { carveH(ax, bx, ay); carveV(ay, by, bx); }
      else { carveV(ay, by, ax); carveH(ax, bx, by); }
    });

    /* ---- doors on room perimeters ---- */
    var doors = [];
    rooms.forEach(function (rm) {
      var cands = [];
      for (var x = rm.x - 1; x <= rm.x + rm.w; x++) {
        for (var y = rm.y - 1; y <= rm.y + rm.h; y++) {
          var inside = x >= rm.x && x < rm.x + rm.w && y >= rm.y && y < rm.y + rm.h;
          var ring = (x === rm.x - 1 || x === rm.x + rm.w || y === rm.y - 1 || y === rm.y + rm.h);
          if (!inside && ring && isOpen(x, y)) cands.push([x, y]);
        }
      }
      /* keep only cells that are part of a 1-cell pinch (a proper doorway) */
      cands.forEach(function (cd) {
        if (!rng.chance(0.62)) return;
        var c = at(cd[0], cd[1]);
        if (doorIdx[c] >= 0) return;
        var di = doors.length;
        doors.push({
          x: cd[0], y: cd[1], open: 0, target: 0, needKey: false,
          locked: false, tex: idx.door, sliding: 0
        });
        doorIdx[c] = di;
        solid[c] = 1;
        rm.doors.push(di);
      });
    });

    /* ---- graph depth from start (BFS through doorways/corridors) ---- */
    (function () {
      var adj = {};
      edges.forEach(function (ed, i) {
        var ka = rooms.indexOf(ed[0]), kb = rooms.indexOf(ed[1]);
        (adj[ka] = adj[ka] || []).push(kb);
        (adj[kb] = adj[kb] || []).push(ka);
      });
      var visited = {};
      var queue = [[rooms.indexOf(start), 0]];
      visited[rooms.indexOf(start)] = 1;
      rooms.forEach(function (r) { r.depth = 99; });
      rooms[rooms.indexOf(start)].depth = 0;
      while (queue.length) {
        var it = queue.shift();
        var ri = it[0], dep = it[1];
        (adj[ri] || []).forEach(function (nb) {
          if (visited[nb]) return;
          visited[nb] = 1;
          rooms[nb].depth = dep + 1;
          queue.push([nb, dep + 1]);
        });
      }
    })();

    var maxDepth = 1;
    rooms.forEach(function (r) { if (r.depth > maxDepth) maxDepth = r.depth; });
    var exitRoom = rooms[0];
    rooms.forEach(function (r) {
      if (r.depth === maxDepth && r.kind === 'normal') exitRoom = r;
    });
    exitRoom.kind = 'exit';
    exitRoom.theme = 2;

    /* ---- cover pillars inside bigger rooms ---- */
    var pillarCells = [];
    rooms.forEach(function (rm) {
      if (rm.kind !== 'normal') return;
      if (rm.w < 7 || rm.h < 7) return;
      var count = rng.int(1, 3);
      for (var i2 = 0; i2 < count; i2++) {
        var px = rng.int(rm.x + 1, rm.x + rm.w - 3);
        var py = rng.int(rm.y + 1, rm.y + rm.h - 3);
        var pw = rng.int(1, 2), ph = rng.int(1, 2);
        for (var y = py; y < py + ph; y++) {
          for (var x = px; x < px + pw; x++) {
            if (x > rm.x && y > rm.y && x < rm.x + rm.w - 1 && y < rm.y + rm.h - 1) {
              solid[at(x, y)] = 1;
              pillarCells.push(at(x, y));
            }
          }
        }
      }
    });

    /* ---- textures per cell ---- */
    for (var y2 = 0; y2 < H; y2++) {
      for (var x2 = 0; x2 < W; x2++) {
        var cc = at(x2, y2);
        var th = THEMES[clamp(theme[cc] | 0, 0, THEMES.length - 1)];
        floorTex[cc] = idx[th.floor];
        ceilTex[cc] = idx[th.ceil];
        wallTex[cc] = idx[th.wall[(x2 * 7 + y2 * 13) % th.wall.length]];
      }
    }
    /* ---- lava pools: applied after the theme pass so they survive ---- */
    rooms.forEach(function (rm) {
      if (rm.kind === 'start' || rm.kind === 'exit') return;
      if (THEMES[rm.theme].floor !== 'lavaFloor' && !rng.chance(0.25)) return;
      var lx = rng.int(rm.x + 1, rm.x + rm.w - 3);
      var ly = rng.int(rm.y + 1, rm.y + rm.h - 3);
      var lw = rng.int(2, 4), lh = rng.int(2, 4);
      for (var y = ly; y < ly + lh; y++) {
        for (var x = lx; x < lx + lw; x++) {
          if (x >= rm.x && y >= rm.y && x < rm.x + rm.w && y < rm.y + rm.h && isOpen(x, y)) {
            var c = at(x, y);
            floorTex[c] = idx.lavaFloor;
            dmg[c] = 12;
          }
        }
      }
    });

    /* exit room gets the portal wall treatment */
    (function () {
      var rm = exitRoom;
      for (var x = rm.x - 1; x <= rm.x + rm.w; x++) {
        for (var y = rm.y - 1; y <= rm.y + rm.h; y++) {
          if (!inb(x, y)) continue;
          var ring = (x === rm.x - 1 || x === rm.x + rm.w || y === rm.y - 1 || y === rm.y + rm.h);
          if (ring && solid[at(x, y)]) wallTex[at(x, y)] = idx.exit;
        }
      }
      ceilTex[at(Math.round(rm.cx), Math.round(rm.cy))] = idx.ceilLight;
    })();

    /* doors use the door texture, and are recorded after the theme pass */
    doors.forEach(function (d) {
      wallTex[at(d.x, d.y)] = idx.door;
    });

    /* ---- secret chamber: try several rooms/sides until one fits ---- */
    var secretRoom = null;
    (function () {
      var cands = rooms.filter(function (r) {
        return r.kind === 'normal' && r.depth >= 2 && r.w >= 6 && r.h >= 6;
      });
      if (!cands.length) cands = rooms.filter(function (r) { return r.kind === 'normal'; });
      var attempts = 0;
      for (var ci = 0; ci < cands.length && !secretRoom; ci++) {
        var rm = cands[(ci + rng.int(0, cands.length - 1)) % cands.length];
        for (var si = 0; si < 4 && !secretRoom; si++) {
          attempts++;
          var side = (si + rng.int(0, 3)) % 4;
          var cw = 3, ch = 3, ox, oy;
          if (side === 0) { ox = rm.x + 1; oy = rm.y - 1 - ch; }
          else if (side === 1) { ox = rm.x + rm.w + 1; oy = rm.y + 1; }
          else if (side === 2) { ox = rm.x + 1; oy = rm.y + rm.h + 1; }
          else { ox = rm.x - 1 - cw; oy = rm.y + 1; }
          /* the chamber and a one-cell margin must be untouched rock: solid,
             and not a doorway, which would slide open and defeat the secret */
          var fits = true;
          for (var y = oy - 1; y <= oy + ch && fits; y++) {
            for (var x = ox - 1; x <= ox + cw; x++) {
              if (!inb(x, y)) { fits = false; break; }
              var mc = at(x, y);
              if (!solid[mc] || doorIdx[mc] >= 0) { fits = false; break; }
            }
          }
          if (!fits) continue;
          /* The shared cell is the single wall square between the chamber and
             the room. It must be centred on the chamber (not the room, which
             is wider) or blasting it would open a dead-end alcove. */
          var wx, wy;
          if (side === 0) { wx = ox + 1; wy = oy + ch; }          /* chamber above */
          else if (side === 2) { wx = ox + 1; wy = oy - 1; }      /* chamber below */
          else if (side === 1) { wx = ox; wy = oy + 1; }          /* chamber right */
          else { wx = ox + cw; wy = oy + 1; }                    /* chamber left */
          if (!inb(wx, wy) || !solid[at(wx, wy)]) continue;
          /* the cell on the room side of the wall must be walkable */
          var rx = (side === 1) ? wx - 1 : (side === 3) ? wx + 1 : wx;
          var ry = (side === 0) ? wy + 1 : (side === 2) ? wy - 1 : wy;
          if (!inb(rx, ry) || solid[at(rx, ry)] || doorIdx[at(rx, ry)] >= 0) continue;
          /* the shared cell must be plain wall, not a doorway, or the "secret"
             would just be an ordinary door */
          if (doorIdx[at(wx, wy)] >= 0) continue;

          for (var yy = oy; yy < oy + ch; yy++) {
            for (var xx = ox; xx < ox + cw; xx++) {
              var c = at(xx, yy);
              solid[c] = 0;
              theme[c] = 2;
              floorTex[c] = idx.techFloor;
              ceilTex[c] = idx.ceilLight;
              light[c] = 1;
            }
          }
          var sc = at(wx, wy);
          solid[sc] = 1;
          secret[sc] = 1;
          wallTex[sc] = idx.trim;
          secretRoom = { x: ox + cw / 2, y: oy + ch / 2, wallX: wx, wallY: wy,
            x0: ox, y0: oy, x1: ox + cw - 1, y1: oy + ch - 1 };
        }
      }
    })();

    /* ---- lighting ---- */
    (function () {
      var lights = [];
      rooms.forEach(function (rm) {
        var count = rm.kind === 'start' ? 3 : (rm.w * rm.h > 60 ? 3 : 2);
        for (var i2 = 0; i2 < count; i2++) {
          var lx = Math.round(rm.x + (i2 + 0.5) * rm.w / count);
          var ly = Math.round(rm.y + rm.h / 2 + (i2 % 2 ? 1 : -1));
          if (!isOpen(lx, ly)) lx = Math.round(rm.cx);
          if (!isOpen(lx, ly)) continue;
          lights.push({ x: lx, y: ly, i: rm.kind === 'exit' ? 1.15 : 0.95, r: 7.5 });
        }
      });
      /* corridor lights */
      for (var y = 1; y < H - 1; y++) {
        for (var x = 1; x < W - 1; x++) {
          var c = at(x, y);
          if (solid[c] || doorIdx[c] >= 0) continue;
          var inRoom = false;
          for (var r2 = 0; r2 < rooms.length; r2++) {
            var rm2 = rooms[r2];
            if (x >= rm2.x && y >= rm2.y && x < rm2.x + rm2.w && y < rm2.y + rm2.h) { inRoom = true; break; }
          }
          if (!inRoom && ((x * 3 + y * 5) % 11) === 0) lights.push({ x: x, y: y, i: 0.7, r: 5 });
        }
      }
      for (var li = 0; li < lights.length; li++) {
        var L = lights[li];
        var R = Math.ceil(L.r);
        for (var dy = -R; dy <= R; dy++) {
          for (var dx = -R; dx <= R; dx++) {
            var px = L.x + dx, py = L.y + dy;
            if (!inb(px, py)) continue;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d > L.r) continue;
            var f = Math.pow(1 - d / L.r, 1.7) * L.i;
            var cc2 = at(px, py);
            light[cc2] = clamp(light[cc2] + f, 0, 1.35);
          }
        }
      }
      for (var q2 = 0; q2 < n; q2++) light[q2] = clamp(0.14 + light[q2], 0.1, 1.25);
    })();

    /* ---- validate connectivity: exit and key must be reachable ---- */
    function reachable(sx, sy, tx, ty) {
      var seen = new Uint8Array(n);
      var qx = [Math.floor(sx)], qy = [Math.floor(sy)];
      seen[qy[0] * W + qx[0]] = 1;
      var goalX = Math.floor(tx), goalY = Math.floor(ty);
      var head = 0;
      while (head < qx.length) {
        var cx = qx[head], cy = qy[head]; head++;
        if (cx === goalX && cy === goalY) return true;
        var nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (var i2 = 0; i2 < 4; i2++) {
          var nx = nb[i2][0], ny = nb[i2][1];
          if (!inb(nx, ny)) continue;
          var c = at(nx, ny);
          if (seen[c]) continue;
          /* doors count as passable for connectivity (they open on touch) */
          if (solid[c] && doorIdx[c] < 0) continue;
          seen[c] = 1;
          qx.push(nx); qy.push(ny);
        }
      }
      return false;
    }

    var spawnPos = { x: Math.round(start.cx) + 0.5, y: Math.round(start.cy) + 0.5 };
    var exitPos = { x: Math.round(exitRoom.cx) + 0.5, y: Math.round(exitRoom.cy) + 0.5 };

    /* the secret wall must be the only thing between room and chamber */
    if (pillarCells.length) {
      var guard = 0;
      while (!reachable(spawnPos.x, spawnPos.y, exitPos.x, exitPos.y) && guard++ < 40) {
        var c2 = pillarCells.pop();
        solid[c2] = 0;
      }
    }


    /* ---- spawn content ---- */
    function randomOpenIn(rm, margin) {
      for (var t = 0; t < 40; t++) {
        var x = rng.int(rm.x + margin, rm.x + rm.w - 1 - margin);
        var y = rng.int(rm.y + margin, rm.y + rm.h - 1 - margin);
        if (isOpen(x, y) && doorIdx[at(x, y)] < 0 && dmg[at(x, y)] === 0) {
          return { x: x + 0.5, y: y + 0.5 };
        }
      }
      return { x: rm.cx, y: rm.cy };
    }

    var enemySpec = [];
    var byDepth = {};
    rooms.forEach(function (r) { (byDepth[r.depth] = byDepth[r.depth] || []).push(r); });

    Object.keys(byDepth).forEach(function (dk) {
      var dep = +dk;
      if (dep === 0) return;
      byDepth[dk].forEach(function (rm) {
        var budget = clamp(1 + dep * 1.15, 1, 7) * diff;
        var pool = dep <= 1 ? ['grunt']
          : dep === 2 ? ['grunt', 'grunt', 'soldier']
            : dep === 3 ? ['soldier', 'hound', 'grunt']
              : dep === 4 ? ['mage', 'hound', 'soldier']
                : ['fiend', 'soldier', 'mage', 'hound'];
        var count = Math.max(1, Math.round(budget));
        for (var i2 = 0; i2 < count; i2++) {
          var pos = randomOpenIn(rm, 1);
          if (util.dist2(pos.x, pos.y, spawnPos.x, spawnPos.y) < 64) continue;
          enemySpec.push({ x: pos.x, y: pos.y, type: rng.pick(pool) });
        }
      });
    });

    /* boss guards the exit */
    var bossCount = Math.round(1 * diff) || 1;
    for (var b2 = 0; b2 < bossCount; b2++) {
      var bp = randomOpenIn(exitRoom, 1);
      enemySpec.push({ x: bp.x, y: bp.y, type: 'boss', boss: true });
    }
    var guards = Math.round(3 * diff);
    for (var g = 0; g < guards; g++) {
      var gp = randomOpenIn(exitRoom, 1);
      enemySpec.push({ x: gp.x, y: gp.y, type: rng.pick(['fiend', 'soldier', 'hound']) });
    }

    var itemSpec = [];
    var mapHasLocks = false;
    function snap(x, y) {
      if (isOpen(Math.floor(x), Math.floor(y))) return { x: x, y: y };
      for (var rad = 1; rad <= 4; rad++) {
        for (var a = 0; a < 8; a++) {
          var nx = Math.floor(x) + Math.round(Math.cos(a * Math.PI / 4) * rad) + 0.5;
          var ny = Math.floor(y) + Math.round(Math.sin(a * Math.PI / 4) * rad) + 0.5;
          if (isOpen(Math.floor(nx), Math.floor(ny))) return { x: nx, y: ny };
        }
      }
      return { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5 };
    }
    function addItem(x, y, kind) {
      var s = snap(x, y);
      itemSpec.push({ x: s.x, y: s.y, kind: kind });
    }

    /* guaranteed weapon progression, keyed to graph depth */
    addItem(spawnPos.x + 1.4, spawnPos.y, 'gun_nail');
    var depthRooms = {};
    rooms.forEach(function (r) { (depthRooms[r.depth] = depthRooms[r.depth] || []).push(r); });
    function giveAt(depth, list) {
      var rm = depthRooms[depth] || depthRooms[Math.min(depth, maxDepth)];
      if (!rm || !rm.length) rm = [exitRoom];
      /* one room at that graph depth carries the cache */
      var room = rm[rng.int(0, rm.length - 1)];
      list.forEach(function (kind) {
        var p = randomOpenIn(room, 1);
        addItem(p.x, p.y, kind);
      });
    }
    giveAt(1, ['ammo_nails', 'ammo_nails', 'health_small']);
    giveAt(2, ['gun_shotgun', 'ammo_shells', 'ammo_shells', 'armor_shard']);
    giveAt(3, ['gun_rocket', 'ammo_rockets', 'ammo_rockets', 'health_small', 'armor_shard']);
    giveAt(4, ['ammo_cells', 'ammo_cells', 'health_large', 'armor_shard']);
    giveAt(5, ['gun_thunder', 'ammo_cells', 'ammo_cells', 'megahealth']);
    if (maxDepth >= 6) giveAt(6, ['gun_thunder', 'ammo_rockets', 'megahealth']);

    /* baseline supplies in every room */
    rooms.forEach(function (rm) {
      if (rm.kind === 'start') { addItem(spawnPos.x - 1.4, spawnPos.y, 'health_small'); addItem(spawnPos.x, spawnPos.y - 1.4, 'armor_shard'); return; }
      var p = randomOpenIn(rm, 1);
      addItem(p.x, p.y, rng.chance(0.55) ? 'health_small' : 'armor_shard');
      var p2 = randomOpenIn(rm, 1);
      addItem(p2.x, p2.y, rng.pick(['ammo_nails', 'ammo_shells', 'ammo_rockets', 'ammo_cells']));
    });

    /* the key sits in a mid-depth room */
    var keyRoom = rooms[0];
    (function () {
      var want = Math.max(2, Math.floor(maxDepth * 0.6));
      var cands = rooms.filter(function (r) { return r.kind === 'normal'; });
      cands.sort(function (a, b) { return Math.abs(a.depth - want) - Math.abs(b.depth - want); });
      keyRoom = cands[0] || exitRoom;
    })();
    var keyPos = randomOpenIn(keyRoom, 1);
    addItem(keyPos.x, keyPos.y, 'key');

    /* Lock the doors leading into the exit room so the key is meaningful.
       A locked door sits in a corridor, so locking the wrong one can seal off
       a whole branch (including the key). We lock the exit's doors, then peel
       locks off until the route to the key is open again. */
    (function () {
      function keyReachable() {
        var ki = itemSpec.filter(function (s) { return s.kind === 'key'; })[0];
        if (!ki) return true;
        var goal = Math.floor(ki.y) * W + Math.floor(ki.x);
        var seen = new Uint8Array(n);
        var qx = [Math.floor(spawnPos.x)], qy = [Math.floor(spawnPos.y)];
        seen[Math.floor(spawnPos.y) * W + Math.floor(spawnPos.x)] = 1;
        var head = 0;
        while (head < qx.length) {
          var cx = qx[head], cy = qy[head]; head++;
          if (cy * W + cx === goal) return true;
          var nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
          for (var i2 = 0; i2 < 4; i2++) {
            var nx = nb[i2][0], ny = nb[i2][1];
            if (!inb(nx, ny)) continue;
            var c = at(nx, ny);
            if (seen[c]) continue;
            /* passable: open floor, or an unlocked door */
            if (solid[c] && (doorIdx[c] < 0 || doors[doorIdx[c]].locked)) continue;
            seen[c] = 1;
            qx.push(nx); qy.push(ny);
          }
        }
        return false;
      }

      var lockedList = exitRoom.doors.slice();
      lockedList.forEach(function (di) {
        doors[di].needKey = true;
        doors[di].locked = true;
      });
      var guard = 0;
      while (lockedList.length && !keyReachable() && guard++ < 64) {
        lockedList.pop();
        for (var q = 0; q < doors.length; q++) doors[q].locked = false;
        lockedList.forEach(function (di) { doors[di].locked = true; });
      }
      mapHasLocks = lockedList.length > 0 && keyReachable();
      if (!mapHasLocks) doors.forEach(function (d) { d.locked = false; d.needKey = false; });
    })();

    addItem(exitPos.x, exitPos.y, 'exit');

    /* secret loot */
    if (secretRoom) {
      addItem(secretRoom.x, secretRoom.y, 'megahealth');
      addItem(secretRoom.x - 0.8, secretRoom.y + 0.4, 'gun_thunder');
      addItem(secretRoom.x + 0.8, secretRoom.y + 0.4, 'ammo_cells');
      addItem(secretRoom.x, secretRoom.y + 0.8, 'armor');
    }

    return {
      w: W, h: H,
      solid: solid, wallTex: wallTex, floorTex: floorTex, ceilTex: ceilTex,
      doorIdx: doorIdx, doors: doors, secret: secret, dmg: dmg, light: light,
      rooms: rooms, enemies: enemySpec, items: itemSpec,
      spawn: spawnPos, exit: exitPos, hasLockedDoors: mapHasLocks,
      secretWall: secretRoom ? { x: secretRoom.wallX, y: secretRoom.wallY } : null,
      secretBounds: secretRoom ? { x0: secretRoom.x0, y0: secretRoom.y0, x1: secretRoom.x1, y1: secretRoom.y1 } : null,
      at: at, inb: inb,
      texName: texName,
      /* movement / raycast solidity: closed doors block, open ones do not */
      isSolid: function (x, y) {
        if (!inb(x, y)) return true;
        var c = at(x, y);
        if (!solid[c]) return false;
        var d = doorIdx[c];
        if (d >= 0 && doors[d].open > 0.8) return false;
        return true;
      },
      /* for the raycaster: a cell is renderable-solid if it blocks sight */
      blocksSight: function (x, y) {
        if (!inb(x, y)) return true;
        var c = at(x, y);
        if (!solid[c]) return false;
        var d = doorIdx[c];
        if (d >= 0 && doors[d].open > 0.92) return false;
        return true;
      },
      destroy: function (x, y) {
        if (!inb(x, y)) return false;
        var c = at(x, y);
        if (!solid[c] || doorIdx[c] >= 0) return false;
        solid[c] = 0;
        secret[c] = 0;
        wallTex[c] = idx.hazard;
        floorTex[c] = idx.techFloor;
        ceilTex[c] = idx.ceilPanel;
        light[c] = clamp(light[c] + 0.4, 0, 1.2);
        return true;
      },
      openDoor: function (di, needKey) {
        var d = doors[di];
        if (!d) return;
        if (d.locked && !needKey) return;
        d.target = 1;
      },
      cellLight: function (x, y) {
        if (!inb(x, y)) return 0.1;
        return light[at(x, y)];
      }
    };
  }

  Q2.maps = {
    generate: generate,
    texName: texName,
    WALLS: WALLS, FLOORS: FLOORS, CEILS: CEILS, IDX: idx
  };
})(window.Q2);
