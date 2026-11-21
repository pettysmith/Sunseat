# Sunseat

Sonnen-Karte für Hamburg (und überall sonst): Wo fällt gerade Sonne auf den Boden? Die Web-App läuft ohne Server, Konto oder API-Schlüssel.

## Was die Karte zeigt

- **Warme Fläche:** Hier fällt zur gewählten Zeit Sonne auf den Boden.
- **Leicht abgedunkelt:** Schatten von Gebäuden und Dachflächen
- **Wasser** bleibt neutral.
- Zeitregler von Sonnenaufgang bis -untergang in 5-Minuten-Schritten, dazu Tage für die nächste Woche, Sonnenhöhe und -richtung und die Bewölkung als Vorhersage
- Die Kartenposition steht im Link (`#zoom/lat/lon`) und lässt sich teilen.

## Genauigkeit in Hamburg

- **Straßenbäume:** Das Baumkataster der Stadt (über 1000 Bäume pro km²) fließt überall in die Karte und in die Berechnung an den Sitzplätzen ein. Jede Krone wird als Kugel angenähert, Radius aus dem Kronendurchmesser. Die Höhe ist geschätzt (4 m + 1,2 × Kronendurchmesser), weil das Kataster keine Höhe enthält. Laubbäume zählen nur von Ende April bis Ende Oktober, Nadelbäume immer.
- **3D-Stadtmodell (LoD2):** Tippst du einen Ort an, lädt die App das 3D-Gebäudemodell für 500 × 500 m drumherum (dauert einige Sekunden). Dort ersetzt es die OSM-Gebäude: Jede Dach- und Wandfläche wird entlang der Sonnenrichtung projiziert, so zählen auch Giebel und Staffelgeschosse. Die Detailansicht zeigt, womit gerechnet wurde. Die Koordinaten liefert die Schnittstelle auf 1 m gerundet.
- **Wetter:** Sonnenscheindauer und Bewölkung von Open-Meteo. Bei weniger als 15 Minuten Sonnenschein in der Stunde gilt es als bedeckt. Dann werden Sonnenflächen und Punkte blass, und statt „Sonne“ steht „Frei, aber bewölkt“.

## Cafés und Bars

- Weiter herausgezoomt (Zoomstufe 13 bis 15) zeigt die Karte nur die Orte, die gerade Sonne haben. Die Liste heißt dann „N Sonnenplätze im Ausschnitt“.
- Ab Zoomstufe 15 erscheinen alle Cafés, Bars, Kneipen und Biergärten als Punkte: orange in der Sonne, halb orange im Halbschatten, grau im Schatten, hohl bei geschlossen.
- Die Sonne wird am geschätzten Sitzplatz berechnet: 3 m vor der nächsten Fassade, an drei Punkten nebeneinander.
- Die Liste im Panel ist sortiert nach Sonne jetzt, Sonne später, Schatten und geschlossen. Zu jedem Ort steht dort „Sonne bis …“ oder „Sonne ab …“ und „Geöffnet bis …“ oder „Geschlossen · öffnet …“.
- Filter: Geöffnet (zur gewählten Uhrzeit, Orte ohne Angaben werden ausgeblendet und gezählt), In der Sonne, Cafés, Bars, Außenplätze
- Detailansicht: Sonnenverlauf des Tages, Öffnungszeiten der Woche, Außenplätze, Route, Website, Telefon und ein Link, um fehlende Angaben in OSM einzutragen.
- Die Daten kommen aus OpenStreetMap über Overpass (mit `opening_hours`, ausgewertet von opening_hours.js inkl. Hamburger Feiertagen). Antwortet Overpass nicht, zeigt die App sofort Name und Lage aus den Kartenkacheln, dann ohne Öffnungszeiten.

## Wie gerechnet wird

1. Gebäudeumrisse mit Höhen (`render_height`, aus OSM `height` bzw. `building:levels`) kommen aus den Vektorkacheln von OpenFreeMap (Zoomstufe 14). Geladen wird der sichtbare Ausschnitt plus 450 m Rand, damit auch Schatten von außerhalb ankommen.
2. Für den Sonnenstand (SunCalc) wirft jede Wand ein Schattenviereck vom Fuß bis zur Länge Höhe ÷ tan(Sonnenhöhe). Auch Wände zu Innenhöfen werfen Schatten.
3. Schatten und Dächer werden portionsweise in eine Maske gezeichnet und dann unter den Straßennamen auf die Karte gelegt. Ein einziger Riesenpfad wäre bei Zoom 14 minutenlang beim Füllen. Alles andere an Land bekommt die Sonnenfarbe.

Aufbau: `shadow.js` (Geometrie), `trees.js` (Baumkataster), `lod2.js` (3D-Stadtmodell), `sunlayer.js` (Kacheln laden, Sonne zeichnen), `places.js` (Cafés und Bars, Öffnungszeiten, Sonne am Sitzplatz), `app.js` (Karte und Bedienung). Tests: `npm test`.

## Grenzen

- Fehlt in OSM die Höhe eines Gebäudes, nutzen die Kacheln einen Standardwert.
- Bäume, Markisen und Gelände fehlen.
- Unter Zoomstufe 14 wird nichts gerechnet.

## Veröffentlichen

Settings → Pages → „Deploy from a branch“ → Branch und Ordner `/ (root)`. In Safari öffnen, dann Teilen → „Zum Home-Bildschirm“. Lokal: `python3 -m http.server`.

## Icon

`icons/icon.svg`: eine Sonnenscheibe, schräg geteilt in Sonne (#f5a524) und Schatten (#8a8f99). Die PNGs (180, 192, 512, maskierbar 512, Favicon 32) sind daraus gerendert.

## Quellen und Lizenzen

- Karte und Gebäude: [OpenFreeMap](https://openfreemap.org), © OpenMapTiles, Daten © OpenStreetMap-Mitwirkende (ODbL)
- Cafés und Bars: OpenStreetMap über Overpass-API
- 3D-Gebäudemodell LoD2-DE Hamburg und Straßenbaumkataster Hamburg: Freie und Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung bzw. BUKEA, über die Urban Data Platform (api.hamburg.de), Lizenz Datenlizenz Deutschland – Namensnennung 2.0
- Bewölkung: Open-Meteo (CC BY 4.0)
- `vendor/maplibre-gl.js` MapLibre GL JS 5.24.1 (BSD-3-Clause), `vendor/suncalc.js` SunCalc 1.9.0 (BSD-2-Clause), `vendor/vector-tile.js` gebündelt aus @mapbox/vector-tile 2 (BSD-3-Clause), pbf 4 (BSD-3-Clause), @mapbox/point-geometry (ISC), `vendor/opening_hours.js` opening_hours.js 3.16.0, unverändert (LGPL-3.0, `vendor/LICENSE-opening_hours-LGPL-3.0.txt`)
