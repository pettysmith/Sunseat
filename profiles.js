// Sunseat – vorab berechnete Horizontprofile (data/horizons.json, erzeugt mit
// tools/precompute-horizons.mjs). Für jeden Sitzpunkt: in 36 Richtungen die Höhe, bis zu der
// Gebäude in den Himmel ragen, und das Höhenband der Baumkronen. Ob Sonne ist, ist dann nur
// noch ein Vergleich – für beliebig viele Orte und jeden Zeitpunkt sofort.

let loading = null;

export function loadProfiles() {
  loading ||= fetch('data/horizons.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j) return null;
      const places = j.places.map(([id, name, sub, lat, lon, facade, n, b64]) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { id: 'h:' + id, tileId: id, name, sub, kind: sub === 'cafe' ? 'cafe' : 'bar', lat, lon, facadeDeg: facade < 0 ? null : facade, n, bytes };
      });
      return { bbox: j.bbox, bins: j.bins, generated: j.generated, places };
    })
    .catch(() => null);
  return loading;
}

export function covers(data, lat, lon) {
  if (!data) return false;
  const [w, s, e, n] = data.bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

/** Laub an Straßenbäumen (Laubbäume grob Ende April bis Ende Oktober). */
function leafOn(date) {
  const m = date.getMonth(), d = date.getDate();
  return (m > 3 || (m === 3 && d >= 25)) && m < 10;
}

/** Anteil der Sitzpunkte in der Sonne (0..1), -1 wenn die Sonne unter dem Horizont steht. */
export function sunFraction(pl, sun, bins) {
  if (sun.altDeg <= 0.5) return -1;
  const f = sun.bearingDeg / (360 / bins) - 0.5;
  const fl = Math.floor(f), w = f - fl;
  const i0 = ((fl % bins) + bins) % bins, i1 = (i0 + 1) % bins, near = w < 0.5 ? i0 : i1;
  const leaf = sun.date ? leafOn(sun.date) : true;
  const b = pl.bytes, alt = sun.altDeg;
  let lit = 0;
  for (let s = 0; s < pl.n; s++) {
    const o = s * bins * 3;
    const horizon = b[o + i0] * (1 - w) + b[o + i1] * w;
    if (alt <= horizon) continue;
    if (leaf) {
      const lo = b[o + bins + near], hi = b[o + 2 * bins + near];
      if (hi > 0 && alt >= lo && alt <= hi) continue;
    }
    lit++;
  }
  return lit / pl.n;
}

export function timeline(pl, suns, bins) {
  const arr = new Float32Array(suns.length);
  for (let i = 0; i < suns.length; i++) arr[i] = sunFraction(pl, suns[i], bins);
  return arr;
}
