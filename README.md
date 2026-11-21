# Sunseat

Welche Café-Terrasse in deiner Nähe liegt gerade in der Sonne? Sunseat ist eine Web-App für den Homescreen (iPhone und Android). Sie läuft ohne Server, Konto oder API-Schlüssel.

## Was die App kann

- Karte über den ganzen Bildschirm wie bei Google Maps: Suchleiste oben, Filter-Chips (☀️ Sonne jetzt, 🕐 Geöffnet, 🪑 Draußen sitzen, 🍦 Eis, Umkreis)
- Gelbe Flächen auf der Karte bekommen Sonne, blaue liegen im Schatten. Die Flächen wandern mit dem Zeitregler.
- Café-Pins: sonnige Cafés leuchten gelb mit ☀️ und Namen, Cafés im Schatten sind grau, geschlossene verblasst
- Panel zum Hochziehen mit Zeitregler, Tagesauswahl (mit vorhergesagten Sonnenstunden) und der Liste „Sonnenplätze offen“
- Detailansicht pro Café: „Sonne bis 14:00 – noch 2 h“, Sonnenkurve des Tages, Öffnungszeiten, Route, Teilen, Link zu den Google-Bewertungen
- Eigene Bewertungen: Sterne, Schlagworte (Decken, Heizstrahler, Hunde ok …) und Notiz, gespeichert auf dem Gerät
- Sonnen-Note (0–5 ☀) pro Café und Tag, berechnet aus den Sonnenminuten
- 3D-Ansicht mit den Gebäudehöhen, mit denen gerechnet wird
- Bewölkung und Temperatur von Open-Meteo
- Funktioniert nach dem ersten Laden auch offline (die App, nicht die Daten)

### Warum keine Google-Bewertungen in der App?

Nach den Nutzungsbedingungen der Google Maps Platform dürfen Inhalte aus Google Places, also auch Bewertungen, nicht zusammen mit einer Karte angezeigt werden, die nicht von Google ist. Außerdem bräuchte die App dafür einen kostenpflichtigen API-Schlüssel. Der Knopf „Google“ öffnet deshalb das Café direkt in Google Maps.

## Wie gerechnet wird

1. Overpass liefert Cafés im Umkreis und alle Gebäude im Umkreis + 250 m mit Umriss und Höhe (`height`, sonst `building:levels` × 3,2 m, sonst ein Schätzwert nach Gebäudeart).
2. Die Außenplätze werden an der nächsten Fassade des Gebäudes vermutet, in dem das Café liegt: 3 m davor, drei Punkte im Abstand von 4 m.
3. Für jeden 10-Minuten-Schritt zwischen Sonnenauf- und -untergang (SunCalc) geht von jedem Punkt ein Strahl Richtung Sonne. Ein Raster-Index (Amanatides-Woo) sucht die Gebäudekanten auf dem Weg. Liegt eine Kante unter der Gebäudehöhe, gilt der Punkt als verschattet.
4. Sonne gilt, wenn mindestens 2 von 3 Punkten frei sind.

Aufbau: `shadow.js` (Geometrie), `data.js` (Laden und Rechnen), `map.js` (Karte), `app.js` (Oberfläche). Tests in `test/` (`npm test`, Node ≥ 20).

## Veröffentlichen mit GitHub Pages

Settings → Pages → „Deploy from a branch“ → Branch wählen, Ordner `/ (root)`. Die App liegt dann unter `https://<user>.github.io/Sunseat/`. Auf dem iPhone: in Safari öffnen → Teilen → „Zum Home-Bildschirm“.

Standort per GPS geht nur über HTTPS, also über GitHub Pages, nicht über eine lokal geöffnete Datei. Lokal testen: `python3 -m http.server` im Ordner und `http://localhost:8000` öffnen.

## Grenzen

- Die genaue Lage der Außenplätze ist geschätzt. An Ecken kann die Fassade die falsche sein.
- Fehlende Gebäudehöhen werden geschätzt. Bäume, Markisen und Schirme fehlen.
- Fehlen Öffnungszeiten oder Außenplätze in OSM, steht „unbekannt“.

## Nächste Stufen

3. Hamburger 3D-Stadtmodell (LoD2) und Straßenbäume statt OSM-Höhen
4. Favoriten, „noch X Minuten Sonne“, Feinschliff

## Quellen und Lizenzen

- Daten: © OpenStreetMap-Mitwirkende (ODbL), Open-Meteo (CC BY 4.0), Nominatim
- Grundkarte: OpenFreeMap (© OpenMapTiles, © OpenStreetMap-Mitwirkende). Ist sie nicht erreichbar, zeigt die Karte nur die eigenen Gebäude und Schatten.
- `vendor/maplibre-gl.js`: MapLibre GL JS 5.24.1, BSD-3-Clause (`vendor/LICENSE-maplibre.txt`)
- `vendor/suncalc.js`: SunCalc 1.9.0, BSD-2-Clause (`vendor/LICENSE-suncalc.txt`)
- `vendor/opening_hours.js`: opening_hours.js 3.16.0, unverändert, LGPL-3.0 (`vendor/LICENSE-opening_hours-LGPL-3.0.txt`). Quellcode: https://github.com/opening-hours/opening_hours.js
