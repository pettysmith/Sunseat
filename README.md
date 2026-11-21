# Sunseat

Welche Café-Terrasse in deiner Nähe liegt gerade in der Sonne? Sunseat ist eine Web-App für den Homescreen (iPhone und Android). Sie läuft ohne Server, Konto oder API-Schlüssel.

## Was die App kann (Stufe 1)

- Standort per GPS, Ortssuche oder Schnellwahl (Schanze, Ottensen, Eppendorf, Innenstadt, Uhlenhorst)
- Cafés und Eisdielen im Umkreis von 300, 500 oder 800 m aus OpenStreetMap
- Für jedes Café: Sonne, Halbschatten oder Schatten, „Sonne bis …“ oder „Sonne ab …“, Sonnenminuten am Tag
- Öffnungszeiten ausgewertet (inkl. Feiertage in Hamburg), Hinweis auf Außenplätze
- Zeitregler für heute und die nächsten sechs Tage. Das Balkendiagramm über dem Regler zeigt, wie viele geöffnete Terrassen zu jeder Zeit in der Sonne liegen.
- Bewölkung und Sonnenscheindauer aus Open-Meteo. Ist es bewölkt, wird „Sonne“ als „bewölkt“ markiert.
- Eine Tagesleiste pro Café: oben Sonne und Schatten, unten die Öffnungszeit
- Funktioniert nach dem ersten Laden auch offline (nur die App selbst, nicht die Daten)

## Wie gerechnet wird

1. Overpass liefert Cafés im Umkreis und alle Gebäude im Umkreis + 250 m mit Umriss und Höhe (`height`, sonst `building:levels` × 3,2 m, sonst ein Schätzwert nach Gebäudeart).
2. Die Außenplätze werden an der nächsten Fassade des Gebäudes vermutet, in dem das Café liegt: 3 m davor, drei Punkte im Abstand von 4 m.
3. Für jeden 10-Minuten-Schritt zwischen Sonnenauf- und -untergang (SunCalc) geht von jedem Punkt ein Strahl Richtung Sonne. Ein Raster-Index (Amanatides-Woo) sucht die Gebäudekanten auf dem Weg. Liegt eine Kante unter der Gebäudehöhe, gilt der Punkt als verschattet.
4. Sonne gilt, wenn mindestens 2 von 3 Punkten frei sind.

Die Geometrie steckt in `shadow.js`, die Tests in `test/` (`npm test`, Node ≥ 20).

## Veröffentlichen mit GitHub Pages

Settings → Pages → „Deploy from a branch“ → Branch wählen, Ordner `/ (root)`. Die App liegt dann unter `https://<user>.github.io/Sunseat/`. Auf dem iPhone: in Safari öffnen → Teilen → „Zum Home-Bildschirm“.

Standort per GPS geht nur über HTTPS, also über GitHub Pages, nicht über eine lokal geöffnete Datei. Lokal testen: `python3 -m http.server` im Ordner und `http://localhost:8000` öffnen.

## Grenzen

- Die genaue Lage der Außenplätze ist geschätzt. An Ecken kann die Fassade die falsche sein.
- Fehlende Gebäudehöhen werden geschätzt. Bäume, Markisen und Schirme fehlen.
- Fehlen Öffnungszeiten oder Außenplätze in OSM, steht „unbekannt“.

## Nächste Stufen

2. Karte (MapLibre) mit Schattenflächen
3. Hamburger 3D-Stadtmodell (LoD2) und Straßenbäume statt OSM-Höhen
4. Favoriten, „noch X Minuten Sonne“, Feinschliff

## Quellen und Lizenzen

- Daten: © OpenStreetMap-Mitwirkende (ODbL), Open-Meteo (CC BY 4.0), Nominatim
- `vendor/suncalc.js`: SunCalc 1.9.0, BSD-2-Clause (`vendor/LICENSE-suncalc.txt`)
- `vendor/opening_hours.js`: opening_hours.js 3.16.0, unverändert, LGPL-3.0 (`vendor/LICENSE-opening_hours-LGPL-3.0.txt`). Quellcode: https://github.com/opening-hours/opening_hours.js
