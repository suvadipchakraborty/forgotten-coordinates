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

/* ---------- cache + network ---------- */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('fc:' + k)); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem('fc:' + k, JSON.stringify(v)); } catch (_) {} }
};
async function http(url, opt = {}, ms = 25000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  if (opt.signal) opt.signal.addEventListener('abort', () => ctl.abort());
  try { return await fetch(url, { ...opt, signal: ctl.signal }); } finally { clearTimeout(t); }
}

/* ---------- APIs ---------- */
async function geocode(city) {
  const r = await http(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`, { headers: { Accept: 'application/json' } }, 12000);
  if (!r.ok) throw new Error('The geocoder is unavailable. Try again shortly.');
  const j = await r.json();
  if (!j.length) throw new Error(`No place found for "${city}". Check the spelling or add a country.`);
  return { lat: +j[0].lat, lon: +j[0].lon, display: j[0].display_name };
}
// P31/P279? (one subclass hop) is far cheaper for Wikidata than the full P279* tree walk
async function ghostSites(c, radiusKm, signal, retry = true) {
  const q = `SELECT ?item ?itemLabel ?coord ?wikiTitle ?dist WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${c.lon} ${c.lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
    bd:serviceParam wikibase:distance ?dist .
  }
  VALUES ?class { wd:Q74047 wd:Q839954 }
  ?item wdt:P31/wdt:P279? ?class .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?wikiTitle .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?dist LIMIT 3`;
  try {
    const r = await http(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { Accept: 'application/sparql-results+json' }, signal });
    if (!r.ok) throw new Error('busy');
    const j = await r.json();
    return j.results.bindings.map(b => {
      const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(b.coord.value);
      return { name: b.itemLabel.value, lon: +m[1], lat: +m[2], title: b.wikiTitle.value };
    }).filter(s => !/^Q\d+$/.test(s.name));
  } catch (e) {
    if (signal && signal.aborted) throw e;
    if (retry) { await new Promise(r => setTimeout(r, 800)); return ghostSites(c, radiusKm, signal, false); }
    throw new Error('The archive (Wikidata) is busy. Try again in a moment.');
  }
}
// first 10 sentences of the article (not just the one-line intro), plus photo and link, in one request
async function page(title) {
  const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&prop=extracts|pageimages|info&exsentences=10&explaintext=1&exsectionformat=plain&piprop=thumbnail&pithumbsize=900&inprop=url&titles=' + encodeURIComponent(title);
  const r = await http(u, {}, 12000);
  if (!r.ok) return null;
  const p = Object.values((await r.json()).query.pages)[0];
  const paras = (p.extract || '').split(/\n+/).map(s => s.trim()).filter(s => s.length > 60 || /[.!?]$/.test(s));
  return { paras, thumb: p.thumbnail && p.thumbnail.source, url: p.fullurl };
}

/* ---------- UI ---------- */
function setStatus(msg, err, busy) { const s = $('status'); s.textContent = msg; s.className = 'status' + (err ? ' err' : '') + (busy ? ' busy' : ''); }
function shortName(d) { return d.split(',')[0].trim(); }

function draw(city, site) {
  if (!map) {
    map = L.map('map', { worldCopyJump: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 18, className: 'dark-tiles' }).addTo(map);
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
  const f = n => n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString();
  current = { cityName, name: site.name, distance: `${Math.round(km)} km / ${Math.round(mi)} mi`, coords: fmtCoord(site) };
  $('name').textContent = site.name;
  $('coords').textContent = fmtCoord(site);
  $('dist').textContent = `${f(km)} km (${f(mi)} mi)`;
  $('dir').textContent = `${dir} of ${cityName}`;
  const st = $('story'); st.textContent = '';
  const paras = info.paras && info.paras.length ? info.paras : ['No written record survives in the archive for this site.'];
  paras.forEach(t => { const p = document.createElement('p'); p.textContent = t; st.appendChild(p); });
  const ph = $('photo');
  if (info.thumb) { $('img').src = info.thumb; $('img').alt = `Archival view of ${site.name}`; $('cap').textContent = site.name; ph.hidden = false; } else ph.hidden = true;
  $('wiki').href = info.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(site.title.replace(/ /g, '_'))}`;
  draw(city, site);
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function run(q) {
  const btn = $('go'); btn.disabled = true;
  const key = q.toLowerCase(), hit = store.get(key);
  try {
    if (hit && Date.now() - hit.t < 6048e5) { show(hit.city, hit.site, hit.info); setStatus(''); return; }
    setStatus('Locating the city…', false, true);
    const city = await geocode(q);
    setStatus('Searching the archives for the nearest ghost…', false, true);
    const c2 = new AbortController();
    const near = ghostSites(city, 500), far = ghostSites(city, 2000, c2.signal).catch(() => []); // run both at once
    let sites = await near;
    if (sites.length) c2.abort(); else { setStatus('Nothing within 500 km. Widening the search…', false, true); sites = await far; }
    if (!sites.length) throw new Error('No ghost twin found nearby. Try a different city.');
    setStatus('Reading the historical record…', false, true);
    const infos = await Promise.all(sites.map(s => page(s.title).catch(() => null)));
    let k = infos.findIndex(i => i && i.paras.join(' ').length > 120);
    if (k < 0) k = infos.findIndex(Boolean);
    if (k < 0) k = 0;
    const site = sites[k], info = infos[k] || { paras: [] };
    store.set(key, { t: Date.now(), city, site, info });
    show(city, site, info);
    setStatus('');
  } catch (err) {
    setStatus(err.message || 'Something went wrong. Check your connection and retry.', true);
  } finally { btn.disabled = false; }
}
$('form').addEventListener('submit', e => { e.preventDefault(); const q = $('city').value.trim(); if (q) run(q); });
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { $('city').value = c.textContent; run(c.textContent); }));
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(current.coords); $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy', 1500); } catch (_) {} });

/* ---------- tabs ---------- */
function tab(n) {
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== n);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === n));
  if (n === 'explore' && map) setTimeout(() => map.invalidateSize(), 60);
  scrollTo(0, 0); history.replaceState(null, '', '#' + n);
}
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); tab(b.dataset.tab); }));
if (location.hash === '#about') tab('about');

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
