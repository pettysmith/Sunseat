// Sunseat – Horizontprofile für alle Cafés und Bars eines Gebiets vorab berechnen.
//
// Für jeden Ort werden (wie in der App) drei Sitzpunkte vor der Fassade geschätzt. Für jeden
// Sitzpunkt wird in 36 Richtungen (alle 10°) bestimmt, wie hoch Gebäude in den Himmel ragen
// und welches Höhenband Baumkronen verdecken. Die App vergleicht dann nur noch
// „Sonnenhöhe > Horizont in Sonnenrichtung?“ – für jeden Zeitpunkt, ohne neu zu rechnen.
//
// Aufruf (Node ≥ 22, mit Proxy: NODE_USE_ENV_PROXY=1):
//   node tools/precompute-horizons.mjs [w s e n] > data/horizons.json
import { VectorTile, Pbf } from '../vendor/vector-tile.js';
import { makeProjection, ShadowIndex, terraceSamples } from '../shadow.js';
import { fetchTrees, toLocal, TreeIndex } from '../trees.js';

const [W, S, E, N] = process.argv.length >= 6 ? process.argv.slice(2, 6).map(Number) : [9.88, 53.535, 10.10, 53.605];
const Z = 14, PAD_M = 450, BINS = 36, EYE = 1.2;
const n = 2 ** Z;
const lon2x = (lon) => (lon + 180) / 360;
const lat2y = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const x2lon = (x) => x * 360 - 180;
const y2lat = (y) => (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const proj = makeProjection((S + N) / 2, (W + E) / 2);
const padLat = PAD_M / 110540, padLon = PAD_M / (111320 * Math.cos((((S + N) / 2) * Math.PI) / 180));
const tiles = [];
for (let x = Math.floor(lon2x(W - padLon) * n); x <= Math.floor(lon2x(E + padLon) * n); x++)
  for (let y = Math.floor(lat2y(N + padLat) * n); y <= Math.floor(lat2y(S - padLat) * n); y++) tiles.push([x, y]);

const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const tileUrl = tj.tiles[0];
log(`Gebiet ${W},${S} – ${E},${N}: ${tiles.length} Kacheln`);

const buildings = [], pois = new Map(), trees = [];
async function loadTile([x, y]) {
  const url = tileUrl.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 204 || r.status === 404) return;
      if (!r.ok) throw new Error(r.status);
      const vt = new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer())));
      const ring = (rg) => { const p = rg.map(([lo, la]) => proj.toXY(la, lo)); const a = p[0], b = p[p.length - 1]; if (a[0] !== b[0] || a[1] !== b[1]) p.push([a[0], a[1]]); return p; };
      const polys = (f) => { const g = f.toGeoJSON(x, y, Z).geometry; return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; };
      const bl = vt.layers.building;
      for (let i = 0; bl && i < bl.length; i++) {
        const f = bl.feature(i);
        const h = +f.properties.render_height || 0;
        if (h <= 0) continue;
        for (const poly of polys(f)) { const rs = poly.map(ring); buildings.push({ outer: [rs[0]], inner: rs.slice(1), h, minH: +f.properties.render_min_height || 0 }); }
      }
      const pl = vt.layers.poi;
      for (let i = 0; pl && i < pl.length; i++) {
        const f = pl.feature(i);
        const sub = f.properties.subclass;
        const kind = sub === 'cafe' ? 'cafe' : (sub === 'bar' || sub === 'pub' || sub === 'biergarten') ? 'bar' : null;
        if (!kind || !f.properties.name) continue;
        const g = f.toGeoJSON(x, y, Z).geometry;
        if (g.type !== 'Point') continue;
        const [lon, lat] = g.coordinates;
        if (lon < W || lon > E || lat < S || lat > N) continue;
        pois.set('t' + f.id, { id: 't' + f.id, name: f.properties.name, kind, sub, lat, lon });
      }
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}
for (let i = 0; i < tiles.length; i += 6) {
  await Promise.all(tiles.slice(i, i + 6).map(loadTile));
  log(`Kacheln ${Math.min(i + 6, tiles.length)}/${tiles.length}, Gebäude ${buildings.length}, Orte ${pois.size}`);
}
// Bäume (Hamburger Baumkataster) für das Gebiet ohne Rand (Kronen wirken nur auf kurze Distanz)
const treeTiles = tiles.filter(([x, y]) => x2lon((x + 1) / n) > W - 0.002 && x2lon(x / n) < E + 0.002 && y2lat(y / n) > S - 0.002 && y2lat((y + 1) / n) < N + 0.002);
for (let i = 0; i < treeTiles.length; i += 2) {
  const got = await Promise.all(treeTiles.slice(i, i + 2).map(([x, y]) => fetchTrees({ w: x2lon(x / n), e: x2lon((x + 1) / n), n: y2lat(y / n), s: y2lat((y + 1) / n) })));
  for (const g of got) trees.push(...toLocal(g, proj));
  log(`Baumkacheln ${Math.min(i + 2, treeTiles.length)}/${treeTiles.length}, Bäume ${trees.length}`);
}

log('Baue Index …');
const index = new ShadowIndex(buildings);
const tindex = new TreeIndex(trees);
const deg = (t) => Math.min(90, Math.max(0, Math.round((Math.atan(t) * 180) / Math.PI)));
const out = [];
let k = 0;
const t0 = Date.now();
for (const p of pois.values()) {
  const [x, y] = proj.toXY(p.lat, p.lon);
  const ts = terraceSamples(index, x, y);
  const bytes = new Uint8Array(ts.samples.length * BINS * 3);
  ts.samples.forEach(([sx, sy], si) => {
    const ex = index.buildingsAt(sx, sy);
    const exSet = ex.length ? new Set(ex) : null;
    for (let b = 0; b < BINS; b++) {
      const az = ((b + 0.5) * 360) / BINS * (Math.PI / 180);
      const dx = Math.sin(az), dy = Math.cos(az);
      const [lo, hi] = tindex.bandTan(sx, sy, dx, dy, EYE);
      const o = si * BINS * 3;
      bytes[o + b] = deg(index.horizonTan(sx, sy, dx, dy, EYE, exSet));
      bytes[o + BINS + b] = deg(lo);
      bytes[o + 2 * BINS + b] = deg(hi);
    }
  });
  out.push([p.id, p.name, p.sub, +p.lat.toFixed(6), +p.lon.toFixed(6), ts.facadeDeg == null ? -1 : Math.round(ts.facadeDeg), ts.samples.length, Buffer.from(bytes).toString('base64')]);
  if (++k % 250 === 0) log(`Orte ${k}/${pois.size} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
if (process.env.VERIFY) {
  // Profil gegen Strahlrechnung prüfen: zufällige Sonnenstände (Hamburg, über das Jahr)
  const { sunVector } = await import('../shadow.js');
  // vendor/suncalc.js ist ein UMD-Skript: mit einem kleinen CommonJS-Rahmen laden
  const { readFileSync } = await import('node:fs');
  const mod = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../vendor/suncalc.js', import.meta.url), 'utf8'))(mod, mod.exports);
  const SunCalc = mod.exports;
  let same = 0, total = 0, fracDiff = 0;
  const byId = new Map(out.map((r) => [r[0], r]));
  for (const p of pois.values()) {
    const r = byId.get(p.id);
    const bytes = Buffer.from(r[7], 'base64');
    const [x, y] = proj.toXY(p.lat, p.lon);
    const ts = terraceSamples(index, x, y);
    for (let k = 0; k < 20; k++) {
      const d = new Date(Date.UTC(2027, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28), 6 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60)));
      const sun = { ...sunVector(SunCalc.getPosition(d, p.lat, p.lon)), date: d };
      if (sun.altDeg <= 1) continue;
      const leaf = ((m, dd) => (m > 3 || (m === 3 && dd >= 25)) && m < 10)(d.getMonth(), d.getDate());
      let litRay = 0, litProf = 0;
      ts.samples.forEach(([sx, sy], si) => {
        const ex = index.buildingsAt(sx, sy);
        const shaded = index.isShaded(sx, sy, sun.dx, sun.dy, sun.tanAlt, EYE, ex.length ? new Set(ex) : null) || (leaf && tindex.isShaded(sx, sy, sun, d, EYE) && trees.length);
        if (!shaded) litRay++;
        const f = sun.bearingDeg / 10 - 0.5, fl = Math.floor(f), w = f - fl, i0 = ((fl % 36) + 36) % 36, i1 = (i0 + 1) % 36, near = w < 0.5 ? i0 : i1, o = si * 108;
        const hor = bytes[o + i0] * (1 - w) + bytes[o + i1] * w;
        let ok = sun.altDeg > hor;
        if (ok && leaf) { const lo = bytes[o + 36 + near], hi = bytes[o + 72 + near]; if (hi > 0 && sun.altDeg >= lo && sun.altDeg <= hi) ok = false; }
        if (ok) litProf++;
      });
      const n = ts.samples.length;
      total++;
      if ((litRay / n >= 0.6) === (litProf / n >= 0.6)) same++;
      fracDiff += Math.abs(litRay - litProf) / n;
    }
  }
  log(`Prüfung: ${total} Stichproben, gleiche Aussage Sonne/keine Sonne: ${((same / total) * 100).toFixed(1)} %, mittlere Abweichung des Sonnenanteils ${((fracDiff / total) * 100).toFixed(1)} %`);
}
process.stdout.write(JSON.stringify({
  v: 1,
  generated: new Date().toISOString(),
  bbox: [W, S, E, N],
  bins: BINS,
  eye: EYE,
  format: '[id, name, art, lat, lon, fassade°, sitzpunkte, base64(je Sitzpunkt: 36× Gebäudehorizont°, 36× Baumband unten°, 36× Baumband oben°)]',
  sources: 'Gebäude und Orte: OpenFreeMap/OpenMapTiles, © OpenStreetMap-Mitwirkende (ODbL); Bäume: Straßenbaumkataster Hamburg (dl-de/by-2.0)',
  places: out,
}));
log(`Fertig: ${out.length} Orte in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
