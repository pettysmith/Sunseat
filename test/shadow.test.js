import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowIndex, buildingHeight, terraceSamples, sunFraction, sunVector, makeProjection } from '../shadow.js';

const box = (x0, y0, x1, y1, h) => ({ outer: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]], inner: [], h, minH: 0 });
const sunAt = (bearingDeg, altDeg) => sunVector({ azimuth: (bearingDeg * Math.PI) / 180 - Math.PI, altitude: (altDeg * Math.PI) / 180 });

test('Höhen aus Tags', () => {
  assert.equal(buildingHeight({ height: '21.5' }).h, 21.5);
  assert.equal(buildingHeight({ 'building:levels': '5' }).h, 5 * 3.2 + 1);
  assert.equal(buildingHeight({ building: 'house' }).estimated, true);
});

test('Haus südlich wirft Schatten, nördlich nicht', () => {
  // Haus 20 m hoch, 10–30 m südlich des Punktes
  const idx = new ShadowIndex([box(-20, -30, 20, -10, 20)]);
  const south30 = sunAt(180, 30);   // tan30*10 = 5.8 m < 20 m
  assert.equal(idx.isShaded(0, 0, south30.dx, south30.dy, south30.tanAlt), true);
  const south70 = sunAt(180, 70);   // tan70*10 = 27 m > 20 m
  assert.equal(idx.isShaded(0, 0, south70.dx, south70.dy, south70.tanAlt), false);
  const north = sunAt(0, 20);
  assert.equal(idx.isShaded(0, 0, north.dx, north.dy, north.tanAlt), false);
  const west = sunAt(270, 10);
  assert.equal(idx.isShaded(0, 0, west.dx, west.dy, west.tanAlt), false);
});

test('Weit entferntes Hochhaus bei tiefer Sonne', () => {
  const idx = new ShadowIndex([box(-10, -210, 10, -190, 60)]);
  const s = sunAt(180, 14);         // tan14*190 = 47 m < 60 m
  assert.equal(idx.isShaded(0, 0, s.dx, s.dy, s.tanAlt), true);
});

test('Terrasse vor Südfassade: Sonne aus Süden ja, aus Norden Eigenschatten', () => {
  // Café-Gebäude 0..20 x 0..15, Café-Punkt knapp innen an der Südfassade
  const idx = new ShadowIndex([box(0, 0, 20, 15, 15)]);
  const t = terraceSamples(idx, 10, 1);
  assert.equal(t.mode, 'facade');
  assert.ok(Math.abs(t.facadeDeg - 180) < 1, 'Fassade nach Süden');
  for (const [, y] of t.samples) assert.ok(y < 0);
  assert.equal(sunFraction(idx, t.samples, sunAt(180, 15)), 1);
  assert.equal(sunFraction(idx, t.samples, sunAt(0, 15)), 0);
  assert.equal(sunFraction(idx, t.samples, sunAt(180, -2)), null);
});

test('Projektion ist umkehrbar', () => {
  const p = makeProjection(53.55, 9.99);
  const [x, y] = p.toXY(53.556, 9.98);
  const [la, lo] = p.toLatLon(x, y);
  assert.ok(Math.abs(la - 53.556) < 1e-9 && Math.abs(lo - 9.98) < 1e-9);
});

test('Schattenfläche zeigt von der Sonne weg und hat die richtige Länge', async () => {
  const { shadowShapes } = await import('../shadow.js');
  const shapes = shadowShapes([box(0, 0, 10, 10, 10)], sunAt(180, 45)); // Sonne aus Süden, 45° → 10 m Schatten nach Norden
  const ys = shapes.flat().map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...ys) - 20) < 1e-9);
  assert.ok(Math.min(...ys) >= 0);
  assert.equal(shadowShapes([box(0, 0, 10, 10, 10)], sunAt(180, -1)).length, 0);
});

test('Innenhof bleibt frei und bekommt Schatten von den Hofwänden', async () => {
  const { shadowShapes, roofRings } = await import('../shadow.js');
  // Block 0..40 mit Hof 10..30, 15 m hoch, Sonne aus Süden 45°
  const b = { outer: [[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]]], inner: [[[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]]], h: 15, minH: 0 };
  const rings = roofRings([b]);
  assert.equal(rings.length, 2);
  const area = (p) => p.reduce((a, [x1, y1], i) => { const [x2, y2] = p[(i + 1) % p.length]; return a + x1 * y2 - x2 * y1; }, 0);
  assert.ok(area(rings[0]) > 0 && area(rings[1]) < 0);
  const shapes = shadowShapes([b], sunAt(180, 45), 600, { footprints: false });
  // Südwand des Hofes (y=30, Innenseite) wirft Schatten bis y=45; Hof-Nordwand y=10 Schatten nach Norden in den Hof bis y=25
  const ys = shapes.flat().map((p) => p[1]);
  assert.ok(ys.some((y) => Math.abs(y - 25) < 1e-9));
});

test('Baumkrone beschattet nur belaubt und nur in Sonnenrichtung', async () => {
  const { TreeIndex, leafOn } = await import('../trees.js');
  // Baum 6 m südlich, Krone r=4 m, Mittelpunkt 8 m hoch
  const tree = { x: 0, y: -6, r: 4, zc: 8, h: 12, evergreen: false };
  const idx = new TreeIndex([tree]);
  const sun = sunAt(180, 45);       // Strahl von (0,0,1.2) nach Süden: bei 6 m Abstand Höhe 7.2 m → trifft die Krone
  const juni = new Date('2027-06-21T12:00:00'), jan = new Date('2027-01-15T12:00:00');
  assert.equal(leafOn(tree, juni), true);
  assert.equal(leafOn(tree, jan), false);
  assert.equal(idx.isShaded(0, 0, sun, juni), true);
  assert.equal(idx.isShaded(0, 0, sun, jan), false);
  assert.equal(idx.isShaded(0, 0, sunAt(0, 45), juni), false);   // Sonne aus Norden
  assert.equal(idx.isShaded(0, 0, sunAt(180, 80), juni), false);  // Sonne fast senkrecht: Strahl geht über die Krone
});

test('UTM-Umrechnung und LoD2-Schatten eines Giebeldachs', async () => {
  const { utmToLatLon, Lod2Index } = await import('../lod2.js');
  // Referenzwerte aus pyproj (EPSG:25832 -> 4326)
  const [lat, lon] = utmToLatLon(563797, 5935006);
  assert.ok(Math.abs(lat - 53.5600517) < 1e-6 && Math.abs(lon - 9.9631506) < 1e-6);
  // Haus 10 x 10 m, 6 m Traufe (y=0 und y=10), First 12 m bei y=5, 20 m südlich des Punktes
  const y0 = -30, y1 = -20, z0 = 0;
  const v = (x, y, z) => [x, y, z];
  const faces = [
    [v(-5, y0, 0), v(5, y0, 0), v(5, y0, 6), v(-5, y0, 6)],          // Südwand
    [v(-5, y1, 0), v(5, y1, 0), v(5, y1, 6), v(-5, y1, 6)],          // Nordwand
    [v(-5, y0, 6), v(5, y0, 6), v(5, -25, 12), v(-5, -25, 12)],      // Dach Süd
    [v(-5, y1, 6), v(5, y1, 6), v(5, -25, 12), v(-5, -25, 12)],      // Dach Nord
  ];
  const b = { id: 'h', faces, footprint: [[[-5, y0], [5, y0], [5, y1], [-5, y1]]], z0, zMax: 12, bbox: [-5, y0, 5, y1] };
  const idx = new Lod2Index([b]);
  const sun = (alt) => ({ dx: 0, dy: -1, tanAlt: Math.tan((alt * Math.PI) / 180), altDeg: alt });
  // Strahl nach Süden aus 1,2 m Höhe: bei 20 m Abstand (Nordwand) Höhe 1,2 + 20·tan
  assert.equal(idx.isShaded(0, 0, sun(10)), true);   // 4,7 m an der Nordwand, 6,0 m am First-Abstand 25 m < 12 m
  assert.equal(idx.isShaded(0, 0, sun(30)), false);  // 12,7 m an der Nordwand, 15,6 m am First > 12 m
});
