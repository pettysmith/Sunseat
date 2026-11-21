// Sunseat – Hamburger 3D-Gebäudemodell LoD2 (Urban Data Platform, CityJSON).
// Wird nur für die Umgebung eines ausgewählten Ortes geladen (die Schnittstelle braucht
// etwa 14 ms pro Gebäude). Jede Dach- und Wandfläche wird entlang der Sonnenrichtung auf
// den Boden projiziert – so werden Dachformen (Giebel, Staffelgeschosse) berücksichtigt.

const API = 'https://api.hamburg.de/datasets/v1/lod2_hamburg/collections/building/items';
const CRS = 'http://www.opengis.net/def/crs/EPSG/0/5555'; // ETRS89 / UTM 32N + DHHN2016 (Meter)

/** ETRS89 UTM (Zone 32) -> [lat, lon] in Grad (GRS80). */
export function utmToLatLon(E, N, zone = 32) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000;
  const mu = N / k0 / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
  const C1 = ep2 * c * c, T1 = t * t;
  const N1 = a / Math.sqrt(1 - e2 * s * s);
  const R1 = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
  const D = x / (N1 * k0);
  const lat = p1 - ((N1 * t) / R1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / c;
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

/** CityJSON -> Gebäude in lokalen Metern: { faces: [[[x,y,z],…]], footprint: [[[x,y],…]], z0, zMax, bbox } */
export function parseCityJSON(cj, proj) {
  const { scale, translate } = cj.transform || { scale: [1, 1, 1], translate: [0, 0, 0] };
  const V = cj.vertices.map(([x, y, z]) => {
    const E = x * scale[0] + translate[0], N = y * scale[1] + translate[1], H = z * scale[2] + translate[2];
    const [lat, lon] = utmToLatLon(E, N);
    const [lx, ly] = proj.toXY(lat, lon);
    return [lx, ly, H];
  });
  const out = [];
  for (const [id, obj] of Object.entries(cj.CityObjects || {})) {
    const geom = (obj.geometry || []).find((g) => String(g.lod).startsWith('2')) || obj.geometry?.[0];
    if (!geom) continue;
    let surfaces;
    if (geom.type === 'Solid') surfaces = geom.boundaries[0];
    else if (geom.type === 'MultiSurface' || geom.type === 'CompositeSurface') surfaces = geom.boundaries;
    else continue;
    const sem = geom.semantics;
    const typeOf = (k) => sem?.surfaces?.[sem.values?.[0]?.[k] ?? sem.values?.[k]]?.type;
    const faces = [], footprint = [];
    let z0 = Infinity, zMax = -Infinity, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    surfaces.forEach((surface, k) => {
      const ring = surface[0].map((i) => V[i]);
      if (ring.length < 3) return;
      for (const [x, y, z] of ring) {
        if (z < z0) z0 = z; if (z > zMax) zMax = z;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      if (typeOf(k) === 'GroundSurface') footprint.push(ring.map(([x, y]) => [x, y]));
      else faces.push(ring);
    });
    if (!faces.length || !isFinite(z0)) continue;
    out.push({ id, faces, footprint, z0, zMax, bbox: [minX, minY, maxX, maxY] });
  }
  return out;
}

/** LoD2 für einen Ausschnitt laden (bbox in Grad). */
export async function fetchLod2(b, proj, signal) {
  const r = await fetch(`${API}?f=cityjson&limit=10000&crs=${encodeURIComponent(CRS)}&bbox=${b.w},${b.s},${b.e},${b.n}`, { signal });
  if (!r.ok) throw new Error('LoD2 ' + r.status);
  return parseCityJSON(await r.json(), proj);
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Projektion einer Fläche auf die Ebene in Höhe zRef entlang der Sonnenrichtung. */
function project(face, sun, zRef) {
  return face.map(([x, y, z]) => {
    const t = (z - zRef) / sun.tanAlt;
    return [x - sun.dx * t, y - sun.dy * t];
  });
}

export class Lod2Index {
  constructor(buildings, cell = 20) {
    this.buildings = buildings;
    this.cell = cell;
    this.grid = new Map();
    this.maxRel = 0;
    buildings.forEach((b, i) => {
      this.maxRel = Math.max(this.maxRel, b.zMax - b.z0);
      const [x0, y0, x1, y1] = b.bbox;
      for (let ix = Math.floor(x0 / cell); ix <= Math.floor(x1 / cell); ix++)
        for (let iy = Math.floor(y0 / cell); iy <= Math.floor(y1 / cell); iy++) {
          const k = ix * 100003 + iy;
          let a = this.grid.get(k);
          if (!a) this.grid.set(k, (a = []));
          a.push(i);
        }
    });
    // Ausdehnung des geladenen Gebiets (für den Übergang zu den OSM-Gebäuden)
    this.area = buildings.reduce((a, b) => [Math.min(a[0], b.bbox[0]), Math.min(a[1], b.bbox[1]), Math.max(a[2], b.bbox[2]), Math.max(a[3], b.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  }

  covers(x, y, margin = 0) {
    const [x0, y0, x1, y1] = this.area;
    return x >= x0 + margin && x <= x1 - margin && y >= y0 + margin && y <= y1 - margin;
  }

  /** Gebäude, in deren Grundriss der Punkt liegt (die eigenen Wände zählen dann nicht). */
  buildingsAt(x, y) {
    const ids = this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(y / this.cell)) || [];
    return new Set(ids.filter((i) => this.buildings[i].footprint.some((r) => pointInRing(x, y, r))));
  }

  isShaded(x, y, sun, eye = 1.2, exclude = null) {
    if (sun.tanAlt <= 0) return true;
    const maxDist = Math.min(450, (this.maxRel + 2) / sun.tanAlt);
    const c = this.cell, seen = new Set();
    // Zellen entlang des Strahls in halben Zellschritten abtasten (dazu die Nachbarzellen)
    for (let d = 0; d <= maxDist + c; d += c / 2) {
      const cx = Math.floor((x + sun.dx * d) / c), cy = Math.floor((y + sun.dy * d) / c);
      for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
        const ids = this.grid.get(ix * 100003 + iy);
        if (!ids) continue;
        for (const i of ids) {
          if (seen.has(i) || exclude?.has(i)) continue;
          seen.add(i);
          const b = this.buildings[i];
          const zEye = b.z0 + eye;
          if (b.zMax <= zEye) continue;
          for (const f of b.faces) {
            if (!f.some((v) => v[2] > zEye)) continue;
            if (pointInRing(x, y, project(f, sun, zEye))) return true;
          }
        }
      }
    }
    return false;
  }

  /** Schattenflächen am Boden: projizierte Dach- und Wandflächen. */
  shadowPolys(sun) {
    const out = [];
    if (sun.altDeg <= 0.5) return out;
    for (const b of this.buildings) for (const f of b.faces) out.push(orient(project(f, sun, b.z0)));
    return out;
  }

  /** Grundrisse (für die Dachfläche auf der Karte). */
  footprints() {
    const out = [];
    for (const b of this.buildings) for (const r of b.footprint) out.push(orient(r.slice()));
    return out;
  }
}

function orient(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a < 0 ? poly.reverse() : poly;
}
