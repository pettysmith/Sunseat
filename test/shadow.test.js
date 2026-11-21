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
