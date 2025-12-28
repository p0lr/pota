// ADI Globe Mapper - Minimal JS
// Reads ADIF, deduplicates by CALL, maps connections using Globe.gl

// --- ADIF Parsing ---
function parseADIF(text) {
  let i = 0;
  const N = text.length;
  const records = [];
  let currentFields = [];
  let inHeader = true;

  function readNextTag() {
    const start = text.indexOf('<', i);
    if (start === -1) return null;
    const gt = text.indexOf('>', start + 1);
    if (gt === -1) return null;
    const raw = text.substring(start + 1, gt).trim();
    i = gt + 1;
    return { raw };
  }

  while (i < N) {
    const t = readNextTag();
    if (!t) break;
    const raw = t.raw;
    const rawLower = raw.toLowerCase();
    if (rawLower === 'eoh') {
      inHeader = false;
      continue;
    }
    if (rawLower === 'eor') {
      if (currentFields.length > 0) {
        records.push({ fields: currentFields });
        currentFields = [];
      }
      continue;
    }
    const m = raw.match(/^([^:]+)(?::(\d+))?/);
    if (!m) continue;
    const tag = m[1].trim();
    const tagUpper = tag.toUpperCase();
    const len = m[2] ? parseInt(m[2], 10) : null;
    let value = '';
    if (len !== null) {
      value = text.substr(i, len);
      i += len;
    } else {
      const nextLT = text.indexOf('<', i);
      if (nextLT === -1) {
        value = text.substring(i).trim();
        i = N;
      } else {
        value = text.substring(i, nextLT).trim();
        i = nextLT;
      }
    }
    if (!inHeader) {
      currentFields.push({ tag: tagUpper, value });
    }
  }
  if (currentFields.length > 0) {
    records.push({ fields: currentFields });
  }
  return records;
}

// --- Deduplication by CALL ---
function dedupeRecords(records) {
  const groups = new Map();
  records.forEach((rec, idx) => {
    const callField = rec.fields.find(f => f.tag && f.tag === 'CALL');
    const call = callField ? String(callField.value).trim().toUpperCase() : null;
    const filled = rec.fields.reduce((n, f) => n + (String(f.value || '').trim().length > 0 ? 1 : 0), 0);
    if (!call) {
      const key = `__NO_CALL_${idx}`;
      groups.set(key, [{ rec, filled }]);
    } else {
      if (!groups.has(call)) groups.set(call, []);
      groups.get(call).push({ rec, filled });
    }
  });
  const deduped = [];
  groups.forEach(arr => {
    arr.sort((a, b) => b.filled - a.filled);
    deduped.push(arr[0].rec);
  });
  return deduped;
}

// --- Maidenhead to Lat/Lon ---
function maidenToLatLon(grid) {
  if (!grid) return null;
  grid = String(grid).trim().toUpperCase();
  if (grid.length < 2) return null;
  const A = 'A'.charCodeAt(0);
  let lon = -180 + (grid.charCodeAt(0) - A) * 20;
  let lat = -90 + (grid.charCodeAt(1) - A) * 10;
  if (grid.length >= 4) {
    lon += parseInt(grid[2], 10) * 2;
    lat += parseInt(grid[3], 10) * 1;
  }
  if (grid.length >= 6) {
    lon += (grid.charCodeAt(4) - A) * (2 / 24);
    lat += (grid.charCodeAt(5) - A) * (1 / 24);
  }
  if (grid.length >= 8) {
    lon += parseInt(grid[6], 10) * (2 / 240);
    lat += parseInt(grid[7], 10) * (1 / 240);
  }
  let lonRes = 20, latRes = 10;
  const len = Math.min(grid.length, 8);
  if (len >= 2) { lonRes = 20; latRes = 10; }
  if (len >= 4) { lonRes = 2; latRes = 1; }
  if (len >= 6) { lonRes = 2 / 24; latRes = 1 / 24; }
  if (len >= 8) { lonRes = 2 / 240; latRes = 1 / 240; }
  lon += lonRes / 2;
  lat += latRes / 2;
  return { lat, lon };
}

// --- Globe Rendering ---
let globe = null;
function renderGlobe(contacts) {
  const el = document.getElementById('globe');
  if (!el) return;
  if (!globe) {
    globe = Globe()(el)
      .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
      .backgroundColor('rgba(0,0,0,0)')
      .showGraticules(true)
      .arcColor(() => '#ffd700')
      .arcStroke(0.15)
      .arcAltitude(0)
      .pointAltitude(0)
      .pointColor('color')
      .pointRadius('size');

    // Add country and US state boundaries using GeoJSON
    Promise.all([
      fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json').then(res => res.json()),
      fetch('https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json').then(res => res.json())
    ]).then(([countries, states]) => {
      // Tag features for styling
      const countryFeatures = countries.features.map(f => { f.properties._layer = 'country'; return f; });
      const stateFeatures = states.features.map(f => { f.properties._layer = 'state'; return f; });
      const allFeatures = countryFeatures.concat(stateFeatures);
      globe.polygonsData(allFeatures)
        .polygonCapColor(f => f.properties && f.properties._layer === 'state' ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.04)')
        .polygonSideColor(() => 'rgba(0,0,0,0)')
        .polygonStrokeColor(f => f.properties && f.properties._layer === 'state' ? '#cccccc' : '#888')
        .polygonAltitude(f => f.properties && f.properties._layer === 'state' ? 0.004 : 0.003);
      // Re-apply arcs and points after polygons load
      if (globe.__pendingArcs) globe.arcsData(globe.__pendingArcs);
      if (globe.__pendingPoints) globe.pointsData(globe.__pendingPoints);
    });
  }
  const arcs = [];
  const points = [];
  contacts.forEach(c => {
    if (!c.coord || !c.myCoord) return;
    // Arc: gold, altitude 0
    arcs.push({
      startLat: c.myCoord.lat,
      startLng: c.myCoord.lon,
      endLat: c.coord.lat,
      endLng: c.coord.lon,
      color: '#ffd700',
      alt: 0
    });
    // Start point: red, altitude 0
    points.push({ lat: c.myCoord.lat, lng: c.myCoord.lon, label: `My: ${c.myGrid}`, color: '#ff0000', size: 0.18, altitude: 0 });
    // End point: green, altitude 0
    points.push({ lat: c.coord.lat, lng: c.coord.lon, label: `${c.call || ''} ${c.grid || ''}`, color: '#00ff00', size: 0.12, altitude: 0 });
  });
  globe.__pendingPoints = points;
  globe.__pendingArcs = arcs;
  globe.pointsData(points);
  globe.arcsData(arcs);
  if (points.length) {
    const originPoint = points.find(p => p.label && p.label.startsWith('My:')) || points[0];
    globe.pointOfView({ lat: originPoint.lat, lng: originPoint.lng, altitude: 2.5 }, 1000);
  }
}

// --- UI Logic ---
const fileInput = document.getElementById('adiFile');
const mapBtn = document.getElementById('mapBtn');
let fileText = '';
fileInput.addEventListener('change', e => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) { mapBtn.disabled = true; return; }
  const reader = new FileReader();
  reader.onload = function (ev) {
    fileText = String(ev.target.result);
    mapBtn.disabled = false;
  };
  reader.onerror = function () { fileText = ''; mapBtn.disabled = true; };
  reader.readAsText(file);
});
mapBtn.addEventListener('click', () => {
  if (!fileText) return;
  const records = parseADIF(fileText);
  const deduped = dedupeRecords(records);
  const contacts = deduped.map(rec => {
    const gridField = rec.fields.find(f => f.tag && ['GRIDSQUARE', 'GRID', 'GRIDSQ'].includes(f.tag.trim().toUpperCase()));
    const callField = rec.fields.find(f => f.tag && f.tag.trim().toUpperCase() === 'CALL');
    const myGridField = rec.fields.find(f => f.tag && f.tag.trim().toUpperCase() === 'MY_GRIDSQUARE');
    const grid = gridField ? String(gridField.value).trim() : null;
    const call = callField ? String(callField.value).trim() : null;
    const myGrid = myGridField ? String(myGridField.value).trim() : null;
    if (!grid) return null;
    const coord = maidenToLatLon(grid);
    const myCoord = myGrid ? maidenToLatLon(myGrid) : null;
    return { grid, call, coord, myGrid, myCoord };
  }).filter(c => c && c.coord && c.myCoord);
  renderGlobe(contacts);
});
