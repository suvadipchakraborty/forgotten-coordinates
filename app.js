'use strict';
const SITE = 'https://forgotten-coordinates.suvadipchakraborty.workers.dev';
const $ = id => document.getElementById(id);
const R = 6371; // km
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
const COMPASS = ['North','North-East','East','South-East','South','South-West','West','North-West'];
let map, layer, current = null;

/* ---------- math ---------- */
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const compass = b => COMPASS[Math.round(b / 45) % 8];
function fmtCoord(p) {
  return `${Math.abs(p.lat).toFixed(4)}° ${p.lat >= 0 ? 'N' : 'S'}, ${Math.abs(p.lon).toFixed(4)}° ${p.lon >= 0 ? 'E' : 'W'}`;
}
function arcPoints(a, b, n = 64) { // great-circle interpolation
  const la1 = rad(a.lat), lo1 = rad(a.lon), la2 = rad(b.lat), lo2 = rad(b.lon);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  if (d === 0) return [[a.lat, a.lon]];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    pts.push([deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))]);
  }
  return pts;
}

/* ---------- APIs ---------- */
async function geocode(city) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`,
    { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('The geocoder is unavailable. Try again shortly.');
  const j = await r.json();
  if (!j.length) throw new Error(`No place found for "${city}". Check the spelling or add a country.`);
  return { lat: +j[0].lat, lon: +j[0].lon, display: j[0].display_name };
}
async function ghostSites(c, radiusKm) {
  const q = `SELECT ?item ?itemLabel ?coord ?wikiTitle ?dist WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${c.lon} ${c.lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
    bd:serviceParam wikibase:distance ?dist .
  }
  VALUES ?class { wd:Q74047 wd:Q839954 }
  ?item wdt:P31/wdt:P279* ?class .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?wikiTitle .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?dist LIMIT 3`;
  const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,
    { headers: { 'Accept': 'application/sparql-results+json' } });
  if (!r.ok) throw new Error('The archive (Wikidata) is busy. Try again in a moment.');
  const j = await r.json();
  return j.results.bindings.map(b => {
    const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(b.coord.value);
    return { name: b.itemLabel.value, lon: +m[1], lat: +m[2], title: b.wikiTitle.value };
  }).filter(s => !/^Q\d+$/.test(s.name));
}
async function summary(title) {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
  if (!r.ok) return null;
  const j = await r.json();
  return { text: j.extract || '', thumb: j.thumbnail && j.thumbnail.source, url: j.content_urls && j.content_urls.desktop.page };
}

/* ---------- UI ---------- */
function setStatus(msg, err) { const s = $('status'); s.textContent = msg; s.className = 'status' + (err ? ' err' : ''); }
function shortName(d) { return d.split(',')[0].trim(); }

function draw(city, site) {
  if (!map) {
    map = L.map('map', { worldCopyJump: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO', subdomains: 'abcd', maxZoom: 19 }).addTo(map);
  }
  if (layer) layer.remove();
  layer = L.layerGroup().addTo(map);
  L.marker([city.lat, city.lon], { icon: L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) })
    .bindTooltip(shortName(city.display)).addTo(layer);
  L.marker([site.lat, site.lon], { icon: L.divIcon({ className: '', html: '<div class="ruin">&#9760;</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) })
    .bindTooltip(site.name).addTo(layer);
  const line = L.polyline(arcPoints(city, site), { color: '#d9a441', weight: 2, opacity: .9, className: 'arc' }).addTo(layer);
  $('result').hidden = false;
  map.invalidateSize();
  map.fitBounds(line.getBounds(), { padding: [50, 50], maxZoom: 9 });
}

function show(city, site, info) {
  const km = haversine(city, site), mi = km * 0.621371, dir = compass(bearing(city, site));
  const cityName = shortName(city.display);
  const dist = km < 10 ? km.toFixed(1) : Math.round(km);
  current = { cityName, name: site.name, distance: `${Math.round(km)} km / ${Math.round(mi)} mi`, coords: fmtCoord(site) };
  $('name').textContent = site.name;
  $('coords').textContent = fmtCoord(site);
  $('badge').textContent = `[ ${dist} km (${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi) ${dir} of ${cityName} ]`;
  $('story').textContent = info.text || 'No written record survives in the archive for this site.';
  const ph = $('photo');
  if (info.thumb) { $('img').src = info.thumb; $('img').alt = `Archival view of ${site.name}`; $('cap').textContent = site.name; ph.hidden = false; } else ph.hidden = true;
  const w = $('wiki'); w.href = info.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(site.title.replace(/ /g, '_'))}`;
  draw(city, site);
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('city').value.trim(); if (!q) return;
  const btn = $('go'); btn.disabled = true;
  try {
    setStatus('Locating the city…');
    const city = await geocode(q);
    setStatus('Searching the archives for the nearest ghost…');
    let sites = await ghostSites(city, 500);
    if (!sites.length) { setStatus('Nothing within 500 km. Widening the search…'); sites = await ghostSites(city, 2000); }
    if (!sites.length) throw new Error('No ghost twin found nearby. Try a different city.');
    let pick = null, info = null;
    for (const s of sites) { // nearest first; fall back if no historical notes
      const i = await summary(s.title);
      if (i && i.text.length > 60) { pick = s; info = i; break; }
      if (!pick && i) { pick = s; info = i; }
    }
    if (!pick) { pick = sites[0]; info = { text: '' }; }
    show(city, pick, info);
    setStatus('');
  } catch (err) {
    setStatus(err.message || 'Something went wrong. Check your connection and retry.', true);
  } finally { btn.disabled = false; }
});

/* ---------- share ---------- */
$('share').addEventListener('click', async () => {
  if (!current) return;
  const text = `The ghost twin of ${current.cityName} is ${current.name} (${current.distance} away at ${current.coords}). Discovered on Forgotten Coordinates: ${SITE}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Forgotten Coordinates', text });
    else { await navigator.clipboard.writeText(text); setStatus('Copied to clipboard.'); }
  } catch (_) { /* share cancelled */ }
});

/* ---------- PWA ---------- */
let deferred = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; });
window.addEventListener('appinstalled', () => { $('install').hidden = true; });
$('install').addEventListener('click', async () => {
  if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; }
  else setStatus('Use your browser menu: "Install app" or "Add to Home Screen".');
});
if (window.matchMedia('(display-mode: standalone)').matches) $('install').hidden = true;
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
