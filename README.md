# Forgotten Coordinates
Type a city, get its nearest "Ghost Twin": an abandoned settlement or ruin with coordinates, distance, bearing and a short history.

**Stack:** vanilla HTML/CSS/JS, Leaflet (CDN), Nominatim, Wikidata SPARQL, Wikipedia REST. No build, no API keys.

## Deploy
1. Drop these files in the repo root (including `preview.png` and the icons).
2. Connect the repo to Cloudflare; static assets are served as-is.

## Notes
- Wikidata classes: ghost town `Q74047` (includes abandoned villages) and archaeological site `Q839954`.
- Search radius is 500 km, widening to 2000 km if nothing is found.
- Browsers forbid setting `User-Agent` in `fetch`; Nominatim identifies the app via the Referer header.
- Nominatim allows ~1 request/second; this app makes one per search.
