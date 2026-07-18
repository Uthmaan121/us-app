// Free, no-API-key venue search for the date planner.
// Geocodes the typed location with Nominatim, then finds real nearby
// venues with the Overpass API — both are free public OpenStreetMap
// services, no signup or payment required.

const CONTACT_UA = 'us-couple-app/1.0 (contact: hyphen080@gmail.com)';

// Map each date idea to the OSM tags that represent it. Multiple entries
// mean "any of these" for that idea.
const CATEGORY_MAP = {
  'Movie Night':    [['amenity', 'cinema']],
  'Fancy Dinner':   [['amenity', 'restaurant']],
  'Sunrise Walk':   [['leisure', 'park'], ['natural', 'beach']],
  'Theme Park':     [['tourism', 'theme_park']],
  'Bake Together':  [['shop', 'bakery']],
  'Beach Day':      [['natural', 'beach']],
  'Gaming':         [['leisure', 'amusement_arcade']],
  'Picnic':         [['leisure', 'park']],
  'Paint Date':     [['leisure', 'arts_centre'], ['shop', 'art']],
  'Stargazing':     [['tourism', 'viewpoint'], ['leisure', 'park']],
  'Spa Day':        [['leisure', 'spa'], ['shop', 'beauty']],
  'Road Trip':      [['tourism', 'attraction'], ['tourism', 'viewpoint']],
  'Bowling':        [['leisure', 'bowling_alley']],
  'Dessert Run':    [['shop', 'ice_cream'], ['amenity', 'cafe']],
  'Theatre / Show': [['amenity', 'theatre']],
  'Swimming':       [['leisure', 'swimming_pool']],
};
const DEFAULT_TAGS = [['amenity', 'restaurant'], ['tourism', 'attraction']];

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, d = Math.PI / 180;
  const dlat = (lat2 - lat1) * d, dlon = (lon2 - lon1) * d;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin(dlon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function detectHalal(tags) {
  const diet = (tags['diet:halal'] || '').toLowerCase();
  if (diet === 'yes' || diet === 'only') return true;
  if (diet === 'no') return false;
  const cuisine = (tags.cuisine || '').toLowerCase();
  if (cuisine.includes('halal')) return true;
  return null;
}

function buildAddress(tags, fallbackLocation) {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'] || tags['addr:suburb'],
    tags['addr:postcode'],
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : `Near ${fallbackLocation}`;
}

async function geocode(location) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`;
  const r = await fetch(url, { headers: { 'User-Agent': CONTACT_UA, 'Accept-Language': 'en' } });
  if (!r.ok) throw new Error(`Location lookup failed (HTTP ${r.status}).`);
  const data = await r.json();
  if (!data.length) throw new Error(`Couldn't find "${location}". Try a more specific place name.`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

// Overpass's main public instance rate-limits fairly aggressively — fall
// back to mirror instances so a single busy server doesn't fail the search.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

async function queryOverpass(tagPairs, lat, lon, radius = 8000) {
  const clauses = tagPairs.map(([k, v]) =>
    `node["${k}"="${v}"](around:${radius},${lat},${lon});way["${k}"="${v}"](around:${radius},${lat},${lon});`
  ).join('\n');
  const query = `[out:json][timeout:20];(${clauses});out center 40;`;
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CONTACT_UA },
        body: 'data=' + encodeURIComponent(query),
      });
      if (r.status === 429 || r.status >= 500) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      if (!r.ok) throw new Error(`Venue search failed (HTTP ${r.status}).`);
      const data = await r.json();
      return data.elements || [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Venue search failed (${lastErr?.message || 'unknown error'}). The free map service may be busy — try again in a moment.`);
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { dateType, location } = JSON.parse(event.body || '{}');
    if (!location || !location.trim()) return err(400, 'Enter a location to search.');

    const { lat, lon } = await geocode(location.trim());
    const tagPairs = CATEGORY_MAP[dateType] || DEFAULT_TAGS;
    const elements = await queryOverpass(tagPairs, lat, lon);

    const seen = new Set();
    const results = elements
      .filter(el => el.tags && el.tags.name)
      .filter(el => { if (seen.has(el.tags.name)) return false; seen.add(el.tags.name); return true; })
      .map(el => {
        const elLat = el.lat ?? el.center?.lat;
        const elLon = el.lon ?? el.center?.lon;
        return {
          name: el.tags.name,
          address: buildAddress(el.tags, location.trim()),
          rating: null,
          isHalal: detectHalal(el.tags),
          halalSource: el.tags['diet:halal'] || el.tags.cuisine ? 'OpenStreetMap listing' : null,
          halalQuote: el.tags['diet:halal'] ? `diet:halal = ${el.tags['diet:halal']}` : null,
          costOne: null,
          costTwo: null,
          description: null,
          website: el.tags.website || el.tags['contact:website'] || null,
          _dist: (elLat != null && elLon != null) ? haversine(lat, lon, elLat, elLon) : 999,
        };
      })
      .sort((a, b) => a._dist - b._dist)
      .slice(0, 6)
      .map(({ _dist, ...rest }) => rest);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors() },
      body: JSON.stringify({ results }),
    };
  } catch (e) {
    return err(500, e.message || 'Search failed.');
  }
}

function err(status, message) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify({ error: message }) };
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}
