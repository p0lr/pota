
// Minimal ADIF parser, deduplication, and mapping for globe UI
(function(){
  const fileInput = document.getElementById('fileInput');
  const processBtn = document.getElementById('processBtn');

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
      const tag = m[1].toUpperCase();
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
        currentFields.push({ tag, value });
      }
    }
    if (currentFields.length > 0) {
      records.push({ fields: currentFields });
    }
    return { records };
  }

  function dedupeRecords(records) {
    const groups = new Map();
    records.forEach((rec, idx) => {
      const callField = rec.fields.find(f => f.tag && f.tag.toUpperCase() === 'CALL');
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

  let _globe = null;
  function renderGlobe(contacts) {
    const el = document.getElementById('globe');
    if (!el) return;
    if (typeof window.Globe !== 'function' && typeof window.GlobeGL !== 'function') {
      console.error('Globe.gl library not loaded; map disabled');
      return;
    }
    if (!_globe) {
      const GlobeFactory = window.Globe || window.GlobeGL || window.Globe;
      _globe = GlobeFactory()(el)
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
        .backgroundColor('rgba(0,0,0,0)')
        .showGraticules(true)
        .arcsData([])
        .arcColor(() => '#ffd700')
        .arcStroke(0.15)
        .arcAltitude(0)
        .pointsData([])
        .pointAltitude(0)
        .pointColor('color')
        .pointRadius('size');
      // Load polygons (optional, can be removed for minimalism)
      (async () => {
        try {
          const countryUrl = 'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json';
          const statesUrl = 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';
          const [cRes, sRes] = await Promise.all([fetch(countryUrl), fetch(statesUrl)]);
          const cJson = cRes.ok ? await cRes.json() : null;
          const sJson = sRes.ok ? await sRes.json() : null;
          const cFeatures = (cJson && cJson.features) ? cJson.features.map(f => { f.properties = f.properties || {}; f.properties._layer = 'country'; return f; }) : [];
          const sFeatures = (sJson && sJson.features) ? sJson.features.map(f => { f.properties = f.properties || {}; f.properties._layer = 'state'; return f; }) : [];
          const all = cFeatures.concat(sFeatures);
          if (all.length) {
            _globe.polygonsData(all)
              .polygonAltitude(f => f.properties && f.properties._layer === 'state' ? 0.004 : 0.002)
              .polygonCapColor(f => f.properties && f.properties._layer === 'state' ? 'rgba(255,215,0,0.08)' : 'rgba(255,255,255,0.02)')
              .polygonSideColor(() => 'rgba(0,0,0,0)')
              .polygonStrokeColor(() => '#ffffff')
              .polygonsTransitionDuration(0)
              .polygonLabel(f => f.properties && (f.properties.name || f.properties.NAME || f.properties.STATE_NAME) ? (f.properties.name || f.properties.NAME || f.properties.STATE_NAME) : '');
          }
        } catch (err) { }
      })();
    }
    // Build arcs and points
    const arcs = [];
    const pointsMap = new Map();
    contacts.forEach(c => {
      if (!c.coord || !c.myCoord) return;
      arcs.push({
        startLat: c.myCoord.lat,
        startLng: c.myCoord.lon,
        endLat: c.coord.lat,
        endLng: c.coord.lon,
        color: '#ffd700',
        alt: 0
      });
      const aKey = `${c.myCoord.lat.toFixed(6)}_${c.myCoord.lon.toFixed(6)}`;
      if (!pointsMap.has(aKey)) pointsMap.set(aKey, { lat: c.myCoord.lat, lng: c.myCoord.lon, label: `My: ${c.myGrid}`, color: '#ff0000', size: 0.18 });
      const bKey = `${c.coord.lat.toFixed(6)}_${c.coord.lon.toFixed(6)}`;
      if (!pointsMap.has(bKey)) pointsMap.set(bKey, { lat: c.coord.lat, lng: c.coord.lon, label: `${c.call || ''} ${c.grid || ''}`, color: '#00ff00', size: 0.12 });
    });
    const points = Array.from(pointsMap.values());
    try {
      _globe.pointsData(points);
      _globe.arcsData(arcs);
      if (points.length) {
        const originPoint = points.find(p => p.label && p.label.startsWith('My:')) || points[0];
        _globe.pointOfView({ lat: originPoint.lat, lng: originPoint.lng, altitude: 2.5 }, 1000);
      }
    } catch (err) {
      console.error('Error updating globe data', err);
    }
  }

  function handleFile(text) {
    const parsed = parseADIF(text);
    const deduped = Array.isArray(parsed.records) ? dedupeRecords(parsed.records) : [];
    parsed.records = Array.isArray(deduped) ? deduped : [];
    try {
      if (!Array.isArray(parsed.records)) throw new Error('parsed.records is not an array');
      const contacts = parsed.records
        .map(rec => {
          const gridField = rec.fields.find(f => f.tag && ['GRIDSQUARE', 'GRID', 'GRIDSQ'].includes(f.tag.toUpperCase()));
          const callField = rec.fields.find(f => f.tag && f.tag.toUpperCase() === 'CALL');
          const myGridField = rec.fields.find(f => f.tag && f.tag.toUpperCase() === 'MY_GRIDSQUARE');
          const grid = gridField ? String(gridField.value).trim() : null;
          const call = callField ? String(callField.value).trim() : null;
          const myGrid = myGridField ? String(myGridField.value).trim() : null;
          if (!grid) return null;
          const coord = maidenToLatLon(grid);
          const myCoord = myGrid ? maidenToLatLon(myGrid) : null;
          return { grid, call, coord, myGrid, myCoord };
        })
        .filter(c => c && c.coord && c.myCoord);
      if (contacts && contacts.length) renderGlobe(contacts);
    } catch (e) {
      console.error('Globe render error', e);
    }
  }

  processBtn.addEventListener('click', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      handleFile(String(e.target.result));
    };
    reader.onerror = function (ev) { console.error('FileReader error', ev); };
    reader.readAsText(file);
  });
})();
