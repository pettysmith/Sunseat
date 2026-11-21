// Sunseat – Geometrie: Gebäudehöhen, Terrassen-Schätzung, Schattenwurf.
// Alles in einem lokalen metrischen System (x = Ost, y = Nord, Meter).

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

export function makeProjection(lat0, lon0) {
  const kx = M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

function parseLength(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  if (/ft|'/.test(s)) return n * 0.3048;
  return n;
}

const LEVEL_H = 3.2;
const DEFAULT_H = {
  house: 7, detached: 7, semidetached_house: 7, bungalow: 4, terrace: 9,
  garage: 3, garages: 3, shed: 3, carport: 3, hut: 3, kiosk: 3, roof: 4,
  container: 3, greenhouse: 3, toilets: 3, service: 3, transformer_tower: 6,
  apartments: 15, residential: 14, dormitory: 15, hotel: 18,
  church: 20, cathedral: 30, office: 15, commercial: 12, retail: 8,
  supermarket: 6, industrial: 10, warehouse: 9, school: 12, university: 15,
  hospital: 18, train_station: 15, parking: 10,
};
const FALLBACK_H = 12;

/** Höhe eines OSM-Gebäudes. estimated = true, wenn geraten. */
export function buildingHeight(tags = {}) {
  let h = parseLength(tags.height);
  let estimated = false;
  if (h == null) {
    const lv = parseLength(tags['building:levels']);
    if (lv != null) {
      const roof = parseLength(tags['roof:levels']) || 0;
      h = lv * LEVEL_H + roof * 2.5 + 1;
    }
  }
  if (h == null) {
    const type = tags.building || tags['building:part'];
    h = DEFAULT_H[type] ?? FALLBACK_H;
    estimated = true;
  }
  let minH = parseLength(tags.min_height);
  if (minH == null) {
    const ml = parseLength(tags['building:min_level']);
    minH = ml != null ? ml * LEVEL_H : 0;
  }
  if (!(h > minH)) h = minH + 3;
  return { h, minH, estimated };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Außenringe minus Innenringe. */
function pointInBuilding(x, y, b) {
  let inOuter = false;
  for (const r of b.outer) if (pointInRing(x, y, r)) { inOuter = true; break; }
  if (!inOuter) return false;
  for (const r of b.inner) if (pointInRing(x, y, r)) return false;
  return true;
}

export class ShadowIndex {
  /**
   * @param {Array<{outer:number[][][], inner:number[][][], h:number, minH:number}>} buildings
   */
  constructor(buildings, cell = 16) {
    this.cell = cell;
    this.buildings = buildings;
    this.grid = new Map();      // Kante -> Zellen
    this.bgrid = new Map();     // Gebäude -> Zellen (für Punkt-in-Gebäude)
    const ex = [];
    this.maxH = 0;
    buildings.forEach((b, bid) => {
      this.maxH = Math.max(this.maxH, b.h);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const ring of [...b.outer, ...b.inner]) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
          if (x1 === x2 && y1 === y2) continue;
          const id = ex.length / 7;
          ex.push(x1, y1, x2, y2, b.h, b.minH, bid);
          this._addBox(this.grid, Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2), id);
        }
        for (const [x, y] of ring) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (isFinite(minX)) this._addBox(this.bgrid, minX, minY, maxX, maxY, bid);
    });
    this.e = Float64Array.from(ex);
    this.stamp = new Uint32Array(ex.length / 7);
    this.stampN = 0;
  }

  _key(ix, iy) { return ix * 100003 + iy; }

  _addBox(grid, x0, y0, x1, y1, id) {
    const c = this.cell;
    for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++)
      for (let iy = Math.floor(y0 / c); iy <= Math.floor(y1 / c); iy++) {
        const k = this._key(ix, iy);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(id);
      }
  }

  /** Indizes aller Gebäude, in denen der Punkt liegt. */
  buildingsAt(x, y) {
    const c = this.cell;
    const ids = this.bgrid.get(this._key(Math.floor(x / c), Math.floor(y / c))) || [];
    return ids.filter((id) => pointInBuilding(x, y, this.buildings[id]));
  }

  /** Nächste Gebäudekante innerhalb maxDist (einfache Suche über Zellen). */
  nearestEdge(x, y, maxDist = 20, onlyBuilding = null) {
    const c = this.cell, e = this.e;
    const r = Math.ceil(maxDist / c);
    const cx = Math.floor(x / c), cy = Math.floor(y / c);
    let best = null;
    for (let ix = cx - r; ix <= cx + r; ix++)
      for (let iy = cy - r; iy <= cy + r; iy++) {
        const ids = this.grid.get(this._key(ix, iy));
        if (!ids) continue;
        for (const id of ids) {
          const o = id * 7;
          if (onlyBuilding != null && e[o + 6] !== onlyBuilding) continue;
          const x1 = e[o], y1 = e[o + 1], x2 = e[o + 2], y2 = e[o + 3];
          const dx = x2 - x1, dy = y2 - y1;
          const L2 = dx * dx + dy * dy;
          let t = ((x - x1) * dx + (y - y1) * dy) / L2;
          t = Math.max(0, Math.min(1, t));
          const qx = x1 + t * dx, qy = y1 + t * dy;
          const d = Math.hypot(x - qx, y - qy);
          if (d <= maxDist && (!best || d < best.d)) best = { d, qx, qy, x1, y1, x2, y2, bid: e[o + 6] };
        }
      }
    return best;
  }

  /**
   * Liegt Punkt (x,y) im Schatten? dir = Einheitsvektor Richtung Sonne (Boden),
   * tanAlt = tan(Sonnenhöhe). exclude = Set von Gebäude-IDs, die ignoriert werden.
   */
  isShaded(x, y, dx, dy, tanAlt, eye = 1.2, exclude = null) {
    if (tanAlt <= 0) return true;
    const maxDist = Math.min(600, Math.max(0, this.maxH - eye) / tanAlt);
    if (maxDist <= 0) return false;
    const c = this.cell, e = this.e;
    const stamp = ++this.stampN;
    // Amanatides-Woo-Traversal durch das Raster
    let ix = Math.floor(x / c), iy = Math.floor(y / c);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tDX = dx !== 0 ? Math.abs(c / dx) : Infinity;
    const tDY = dy !== 0 ? Math.abs(c / dy) : Infinity;
    let tMX = dx !== 0 ? ((dx > 0 ? (ix + 1) * c - x : x - ix * c) / Math.abs(dx)) : Infinity;
    let tMY = dy !== 0 ? ((dy > 0 ? (iy + 1) * c - y : y - iy * c) / Math.abs(dy)) : Infinity;
    let tCell = 0;
    while (tCell <= maxDist) {
      const ids = this.grid.get(this._key(ix, iy));
      if (ids) {
        for (const id of ids) {
          if (this.stamp[id] === stamp) continue;
          this.stamp[id] = stamp;
          const o = id * 7;
          if (exclude && exclude.has(e[o + 6])) continue;
          const ax = e[o], ay = e[o + 1];
          const ux = e[o + 2] - ax, uy = e[o + 3] - ay;
          const den = dx * uy - dy * ux;
          if (Math.abs(den) < 1e-12) continue;
          const wx = ax - x, wy = ay - y;
          const t = (wx * uy - wy * ux) / den;   // Abstand entlang Strahl
          const s = (wx * dy - wy * dx) / den;   // Position auf Kante
          if (t < 0.05 || t > maxDist || s < 0 || s > 1) continue;
          const z = eye + t * tanAlt;
          if (z < e[o + 4] && z >= e[o + 5]) return true;
        }
      }
      if (tMX < tMY) { tCell = tMX; tMX += tDX; ix += stepX; }
      else { tCell = tMY; tMY += tDY; iy += stepY; }
    }
    return false;
  }
}

/** Sonnenrichtung aus SunCalc-Position (Azimut ab Süd, im Uhrzeigersinn). */
export function sunVector(pos) {
  const bearing = pos.azimuth + Math.PI; // ab Nord, im Uhrzeigersinn
  return {
    dx: Math.sin(bearing),
    dy: Math.cos(bearing),
    tanAlt: Math.tan(pos.altitude),
    bearingDeg: ((bearing * 180) / Math.PI + 360) % 360,
    altDeg: (pos.altitude * 180) / Math.PI,
  };
}

const OFFSET = 3;   // Meter vor der Fassade
const SPREAD = 4;   // Meter links/rechts entlang der Fassade

/**
 * Schätzt Sitzpunkte einer Außenterrasse: nächste Fassade des Gebäudes,
 * in dem (oder an dem) das Café liegt, 3 m nach außen versetzt, 3 Punkte entlang.
 */
export function terraceSamples(index, x, y) {
  const host = index.buildingsAt(x, y);
  let edge = null;
  if (host.length) edge = index.nearestEdge(x, y, 80, host[0]);
  else {
    const near = index.nearestEdge(x, y, 6);
    if (near) edge = near;
  }
  if (!edge) {
    return { samples: [[x, y], [x - 3, y], [x + 3, y]], facadeDeg: null, mode: 'point' };
  }
  const ux0 = edge.x2 - edge.x1, uy0 = edge.y2 - edge.y1;
  const L = Math.hypot(ux0, uy0);
  const ux = ux0 / L, uy = uy0 / L;
  let nx = -uy, ny = ux;
  // Normale nach außen (weg vom Gebäude) ausrichten
  const probe = index.buildingsAt(edge.qx + nx * 0.5, edge.qy + ny * 0.5);
  if (probe.includes(edge.bid)) { nx = -nx; ny = -ny; }
  const tq = (edge.qx - edge.x1) * ux + (edge.qy - edge.y1) * uy;
  const samples = [];
  for (const off of [0, -SPREAD, SPREAD]) {
    const t = Math.max(0.5, Math.min(L - 0.5, tq + off));
    const sx = edge.x1 + ux * t + nx * OFFSET, sy = edge.y1 + uy * t + ny * OFFSET;
    if (index.buildingsAt(sx, sy).length === 0) samples.push([sx, sy]);
  }
  if (!samples.length) samples.push([edge.qx + nx * OFFSET, edge.qy + ny * OFFSET]);
  const facadeDeg = ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360;
  return { samples, facadeDeg, mode: 'facade' };
}

/** Anteil der Sitzpunkte in der Sonne (0..1), null wenn Sonne unter dem Horizont. */
export function sunFraction(index, samples, sun) {
  if (sun.altDeg <= 0.5) return null;
  let lit = 0;
  for (const [x, y] of samples) {
    const ex = new Set(index.buildingsAt(x, y));
    if (!index.isShaded(x, y, sun.dx, sun.dy, sun.tanAlt, 1.2, ex.size ? ex : null)) lit++;
  }
  return lit / samples.length;
}

/** Overpass-JSON -> Gebäude in lokalen Koordinaten. */
export function buildingsFromOverpass(elements, proj) {
  const out = [];
  const ring = (geom) => geom.map((p) => proj.toXY(p.lat, p.lon));
  for (const el of elements) {
    const tags = el.tags || {};
    if (!tags.building && !tags['building:part']) continue;
    if (tags.building === 'no' || tags['building:part'] === 'no') continue;
    if (tags.building === 'roof' && !tags.height) continue; // Dächer/Überdachungen werfen kaum relevanten Schatten
    const { h, minH, estimated } = buildingHeight(tags);
    if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
      out.push({ outer: [ring(el.geometry)], inner: [], h, minH, estimated, id: 'w' + el.id });
    } else if (el.type === 'relation' && el.members) {
      const outer = [], inner = [];
      for (const m of el.members) {
        if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
        (m.role === 'inner' ? inner : outer).push(ring(m.geometry));
      }
      if (outer.length) out.push({ outer, inner, h, minH, estimated, id: 'r' + el.id });
    }
  }
  return out;
}

export function compass(deg) {
  const n = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return n[Math.round(deg / 22.5) % 16];
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Schattenflächen aller Gebäude für einen Sonnenstand, als Liste von Polygonen
 * (lokale Meter, alle gegen den Uhrzeigersinn, damit sie sich beim Füllen mit
 * „nonzero“ vereinigen). Pro Wand ein Viereck aus Wand und ihrem Schatten,
 * auch für Wände zu Innenhöfen. footprints = true fügt die Grundrisse hinzu.
 */
export function shadowShapes(buildings, sun, maxLen = 600, { footprints = true } = {}) {
  const out = [];
  if (sun.altDeg <= 0.5) return out;
  const ccw = (poly) => (signedArea(poly) < 0 ? poly.reverse() : poly);
  for (const b of buildings) {
    const L = Math.min(maxLen, b.h / sun.tanAlt);
    if (!(L > 0.2)) continue;
    const ox = -sun.dx * L, oy = -sun.dy * L;
    for (const ring of [...b.outer, ...b.inner]) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        if (x1 === x2 && y1 === y2) continue;
        out.push(ccw([[x1, y1], [x2, y2], [x2 + ox, y2 + oy], [x1 + ox, y1 + oy]]));
      }
    }
    if (footprints) for (const ring of b.outer) out.push(ccw(ring.slice(0, -1).map((p) => [p[0], p[1]])));
  }
  return out;
}

/** Dachflächen: Außenringe gegen, Innenhöfe im Uhrzeigersinn – „nonzero“ lässt die Höfe frei. */
export function roofRings(buildings) {
  const out = [];
  for (const b of buildings) {
    for (const r of b.outer) { const p = r.slice(0, -1); if (signedArea(p) < 0) p.reverse(); out.push(p); }
    for (const r of b.inner) { const p = r.slice(0, -1); if (signedArea(p) > 0) p.reverse(); out.push(p); }
  }
  return out;
}
