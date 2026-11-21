// Sunseat – Straßenbäume aus dem Hamburger Baumkataster (Urban Data Platform).
// Krone als Kugel; Höhe aus dem Kronendurchmesser geschätzt (das Kataster hat keine Höhe).

const API = 'https://api.hamburg.de/datasets/v1/strassenbaumkataster/collections/strassenbaumkataster_hh/items';
// Grob die Landesgrenze Hamburgs; außerhalb gibt es keine Daten
export const HAMBURG = { w: 8.42, s: 53.39, e: 10.34, n: 53.97 };
const EVERGREEN = /^(Pinus|Picea|Abies|Taxus|Thuja|Chamaecyparis|Ilex|Juniperus|Pseudotsuga|Cedrus|Tsuga|Sequoiadendron|Cupressus|Cryptomeria)/;

export function inHamburg(b) {
  return b.e > HAMBURG.w && b.w < HAMBURG.e && b.n > HAMBURG.s && b.s < HAMBURG.n;
}

/** Laub vorhanden? Laubbäume grob von Ende April bis Ende Oktober. */
export function leafOn(tree, date) {
  if (tree.evergreen) return true;
  const m = date.getMonth(), d = date.getDate();
  return (m > 3 || (m === 3 && d >= 25)) && m < 10;
}

/** Bäume in einem Ausschnitt laden (Längen-/Breitengrad); toLocal rechnet in lokale Meter um. */
export async function fetchTrees(b) {
  if (!inHamburg(b)) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${API}?f=json&limit=10000&bbox=${b.w},${b.s},${b.e},${b.n}`, { signal: ctrl.signal });
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    for (const f of j.features || []) {
      const cd = +f.properties?.kronendurchmesser;
      if (!(cd > 0)) continue;
      const coords = f.geometry?.type === 'MultiPoint' ? f.geometry.coordinates[0] : f.geometry?.coordinates;
      if (!coords) continue;
      const r0 = Math.min(cd, 20) / 2;
      const h = Math.max(5, Math.min(28, 4 + 1.2 * cd));     // Faustformel Straßenbaum
      out.push({ lon: coords[0], lat: coords[1], r: r0, zc: h - r0, h, evergreen: EVERGREEN.test(f.properties.gattung_latein || '') });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function toLocal(trees, proj) {
  return trees.map((t) => { const [x, y] = proj.toXY(t.lat, t.lon); return { ...t, x, y }; });
}

/** Schnelle Suche nach Kronen entlang eines Sonnenstrahls. */
export class TreeIndex {
  constructor(trees, cell = 25) {
    this.cell = cell;
    this.grid = new Map();
    this.trees = trees;
    trees.forEach((t, i) => {
      const k = this._key(Math.floor(t.x / cell), Math.floor(t.y / cell));
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, (a = []));
      a.push(i);
    });
  }

  _key(ix, iy) { return ix * 100003 + iy; }

  /** Liegt der Punkt (Augenhöhe eye) im Schatten einer belaubten Krone? */
  isShaded(x, y, sun, date, eye = 1.2) {
    if (!this.trees.length || sun.tanAlt <= 0) return false;
    const maxDist = Math.min(150, 30 / sun.tanAlt);
    const c = this.cell;
    const x1 = x + sun.dx * maxDist, y1 = y + sun.dy * maxDist;
    const cosA = 1 / Math.sqrt(1 + sun.tanAlt * sun.tanAlt), sinA = sun.tanAlt * cosA;
    const D = [sun.dx * cosA, sun.dy * cosA, sinA];
    for (let ix = Math.floor((Math.min(x, x1) - 12) / c); ix <= Math.floor((Math.max(x, x1) + 12) / c); ix++) {
      for (let iy = Math.floor((Math.min(y, y1) - 12) / c); iy <= Math.floor((Math.max(y, y1) + 12) / c); iy++) {
        const ids = this.grid.get(this._key(ix, iy));
        if (!ids) continue;
        for (const id of ids) {
          const t = this.trees[id];
          if (!leafOn(t, date)) continue;
          const vx = t.x - x, vy = t.y - y, vz = t.zc - eye;
          const along = vx * D[0] + vy * D[1] + vz * D[2];
          if (along <= 0) continue;
          const d2 = vx * vx + vy * vy + vz * vz - along * along;
          // Kronen lassen etwas Licht durch: nur der dichte Kern (85 % des Radius) zählt
          if (d2 < (t.r * 0.85) ** 2) return true;
        }
      }
    }
    return false;
  }
}

/** Höhenwinkel-Band (tan unten/oben), das Baumkronen in einer Richtung verdecken; [0,0] wenn keine. */
TreeIndex.prototype.bandTan = function (x, y, dx, dy, eye = 1.2, maxDist = 150) {
  let lo = Infinity, hi = 0;
  const c = this.cell, x1 = x + dx * maxDist, y1 = y + dy * maxDist;
  for (let ix = Math.floor((Math.min(x, x1) - 12) / c); ix <= Math.floor((Math.max(x, x1) + 12) / c); ix++) {
    for (let iy = Math.floor((Math.min(y, y1) - 12) / c); iy <= Math.floor((Math.max(y, y1) + 12) / c); iy++) {
      const ids = this.grid.get(this._key(ix, iy));
      if (!ids) continue;
      for (const id of ids) {
        const t = this.trees[id];
        const vx = t.x - x, vy = t.y - y;
        const along = vx * dx + vy * dy;
        if (along <= 0.5 || along > maxDist) continue;
        const lat = Math.abs(vx * dy - vy * dx);
        const r = t.r * 0.85;
        if (lat >= r) continue;
        const half = Math.sqrt(r * r - lat * lat);
        const a = (t.zc - half - eye) / along, b = (t.zc + half - eye) / along;
        if (b <= 0) continue;
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
    }
  }
  return hi > 0 ? [Math.max(0, lo), hi] : [0, 0];
};

/** Schattenellipsen der belaubten Kronen auf dem Boden (lokale Meter, gegen den Uhrzeigersinn). */
export function treeShadows(trees, sun, date) {
  const out = [];
  if (sun.altDeg <= 0.5) return out;
  const sinA = sun.tanAlt / Math.sqrt(1 + sun.tanAlt * sun.tanAlt);
  for (const t of trees) {
    if (!leafOn(t, date)) continue;
    const cx = t.x - sun.dx * (t.zc / sun.tanAlt), cy = t.y - sun.dy * (t.zc / sun.tanAlt);
    const a = t.r / sinA, bAx = t.r; // Halbachsen: entlang Sonnenrichtung gestreckt
    const poly = [];
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * 2 * Math.PI;
      const u = Math.cos(ang) * a, v = Math.sin(ang) * bAx;
      poly.push([cx + u * sun.dx - v * sun.dy, cy + u * sun.dy + v * sun.dx]);
    }
    out.push(poly);
  }
  return out;
}
