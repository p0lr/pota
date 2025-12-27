// ADIF parser + rewriter: removes duplicate CALLs, prefers the most-complete record,
// injects POTA_REF into header and each QSO, writes one line per contact, and logs a summary.
console.log('app.js load');
window.addEventListener('error', e => console.error('Window error:', e && e.message, e && e.error));
window.addEventListener('unhandledrejection', e => console.error('Unhandled rejection:', e && e.reason));
(function(){
  console.log('app IIFE start');
  const fileInput = document.getElementById('fileInput');
  const parkRefInput = document.getElementById('parkRef');
  const processBtn = document.getElementById('processBtn');
  const preview = document.getElementById('preview');
  const logEl = document.getElementById('log');
  const downloadLink = document.getElementById('downloadLink');

  function log(...args){
    logEl.textContent += args.join(' ') + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Parse ADIF into header (array of {tag,value}) and records (array of {fields: [{tag,value}, ...]})
  function parseADIF(text){
    let i = 0;
    const N = text.length;
    const header = [];
    const records = [];
    let currentFields = [];
    let inHeader = true;

    function readNextTag(){
      const start = text.indexOf('<', i);
      if(start === -1) return null;
      const gt = text.indexOf('>', start+1);
      if(gt === -1) return null;
      const raw = text.substring(start+1, gt).trim();
      i = gt + 1;
      return {raw, start, gt};
    }

    while(i < N){
      const t = readNextTag();
      if(!t) break;
      const raw = t.raw;
      const rawLower = raw.toLowerCase();

      if(rawLower === 'eoh'){
        inHeader = false;
        // record header end marker
        header.push({tag:'EOH', value:''});
        continue;
      }
      if(rawLower === 'eor'){
        // push current record
        if(currentFields.length > 0){
          records.push({fields: currentFields});
          currentFields = [];
        }
        continue;
      }

      const m = raw.match(/^([^:]+)(?::(\d+))?/);
      if(!m) continue;
      const tag = m[1].toUpperCase();
      const len = m[2] ? parseInt(m[2], 10) : null;

      let value = '';
      if(len !== null){
        value = text.substr(i, len);
        i += len;
      } else {
        const nextLT = text.indexOf('<', i);
        if(nextLT === -1){
          value = text.substring(i).trim();
          i = N;
        } else {
          value = text.substring(i, nextLT).trim();
          i = nextLT;
        }
      }

      if(inHeader){
        header.push({tag, value});
      } else {
        currentFields.push({tag, value});
      }
    }

    // if last record didn't end with EOR but had fields, push it
    if(currentFields.length > 0){
      records.push({fields: currentFields});
    }

    return {header, records};
  }

  // Choose the preferred record among duplicates by CALL: the record with more non-empty fields
  function dedupeRecords(records){
    const groups = new Map(); // CALL -> [{rec, filled}, ...]
    const before = records.length;

    records.forEach((rec, idx) => {
      const callField = rec.fields.find(f => f.tag && f.tag.toUpperCase() === 'CALL');
      const call = callField ? String(callField.value).trim().toUpperCase() : null;
      const filled = rec.fields.reduce((n, f) => n + (String(f.value || '').trim().length > 0 ? 1 : 0), 0);
      if(!call){
        const key = `__NO_CALL_${idx}`;
        groups.set(key, [{rec, filled, call: null}]);
      } else {
        if(!groups.has(call)) groups.set(call, []);
        groups.get(call).push({rec, filled, call});
      }
    });

    const deduped = [];
    const duplicateSummary = []; // {call, count, removed}

    groups.forEach((arr, key) => {
      if(arr.length === 1){
        deduped.push(arr[0].rec);
      } else {
        // choose the record with the highest filled count; if tie, keep first
        arr.sort((a,b) => b.filled - a.filled);
        deduped.push(arr[0].rec);
        const callName = arr[0].call || key;
        duplicateSummary.push({call: callName, count: arr.length, removed: arr.length - 1});
      }
    });

    const removed = before - deduped.length;
    return {deduped, before, removed, after: deduped.length, duplicateSummary};
  }

  // Build ADIF: header lines, then one line per record (tags concatenated) ending with <EOR>
  function buildADIF(parsed, parkRef){
    const lines = [];
    const header = parsed.header || [];
    const records = parsed.records || [];

    // header tags (preserve order) but skip EOH marker when copying
    let hasPota = header.some(h => h.tag && h.tag.toUpperCase() === 'POTA_REF');
    header.forEach(h => {
      if(!h.tag) return;
      if(h.tag.toUpperCase() === 'EOH') return; // skip here; we'll add EOH after header
      const v = h.value || '';
      lines.push(`<${h.tag}:${String(v).length}>${v}`);
    });
    if(!hasPota && parkRef){
      lines.push(`<POTA_REF:${parkRef.length}>${parkRef}`);
    }
    lines.push('<EOH>');

    // For each record, ensure POTA_REF present and output one line containing all tags
    records.forEach(rec => {
      const fields = rec.fields.slice(); // array of {tag,value}
      // check if POTA_REF exists
      const has = fields.some(f => f.tag.toUpperCase() === 'POTA_REF');
      if(parkRef && !has){
        fields.push({tag: 'POTA_REF', value: parkRef});
      }
      // build single-line record: concatenate each tag:value then append <EOR>
      const recordParts = fields.map(f => {
        const v = f.value || '';
        return `<${f.tag}:${String(v).length}>${v}`;
      });
      const line = recordParts.join('') + '<EOR>';
      lines.push(line);
    });

    return lines.join('\n') + '\n';
  }

  // --- Map/Globe support: Maidenhead -> lat/lon ---

  function maidenToLatLon(grid){
    if(!grid) return null;
    grid = String(grid).trim().toUpperCase();
    if(grid.length < 2) return null;
    const A = 'A'.charCodeAt(0);
    // field
    let lon = -180 + (grid.charCodeAt(0) - A) * 20;
    let lat = -90 + (grid.charCodeAt(1) - A) * 10;
    // square
    if(grid.length >= 4){
      lon += parseInt(grid[2],10) * 2;
      lat += parseInt(grid[3],10) * 1;
    }
    // subsquare
    if(grid.length >= 6){
      lon += (grid.charCodeAt(4) - A) * (2/24);
      lat += (grid.charCodeAt(5) - A) * (1/24);
    }
    // extended
    if(grid.length >= 8){
      lon += parseInt(grid[6],10) * (2/240);
      lat += parseInt(grid[7],10) * (1/240);
    }
    // compute center offset based on precision
    let lonRes = 20, latRes = 10;
    const len = Math.min(grid.length,8);
    if(len >= 2) { lonRes = 20; latRes = 10; }
    if(len >= 4) { lonRes = 2; latRes = 1; }
    if(len >= 6) { lonRes = 2/24; latRes = 1/24; }
    if(len >= 8) { lonRes = 2/240; latRes = 1/240; }
    lon += lonRes/2;
    lat += latRes/2;
    return {lat: lat, lon: lon};
  }

  // --- Globe.gl rendering ---
  let _globe = null;

  function renderGlobe(contacts){
    const el = document.getElementById('globe');
    if(!el) return;
    console.log('renderGlobe called, contacts count:', contacts && contacts.length);

    if(typeof window.Globe !== 'function' && typeof window.GlobeGL !== 'function'){
      log('Globe.gl library not loaded; map disabled');
      return;
    }

    // Initialize Globe if needed
    if(!_globe){
      const GlobeFactory = window.Globe || window.GlobeGL || window.Globe;
        try{
          _globe = GlobeFactory()(el)
            .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
            .backgroundColor('rgba(0,0,0,0)')
            .showGraticules(true)
            .arcsData([])
            // use a fixed gold color for arcs and keep them flat on the surface
            .arcColor(() => '#ffd700')
            .arcStroke(0.15)
            .arcAltitude(0)
            .pointsData([])
            // keep points flat on the globe surface (zero altitude)
            .pointAltitude(0)
            .pointColor('color')
            .pointRadius('size');
          // load country and state polygons (GeoJSON) and render them
          (async ()=>{
            try{
              const countryUrl = 'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json';
              const statesUrl = 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';
              const [cRes, sRes] = await Promise.all([fetch(countryUrl), fetch(statesUrl)]);
              const cJson = cRes.ok ? await cRes.json() : null;
              const sJson = sRes.ok ? await sRes.json() : null;
              const cFeatures = (cJson && cJson.features) ? cJson.features.map(f=>{f.properties = f.properties||{}; f.properties._layer='country'; return f;}) : [];
              const sFeatures = (sJson && sJson.features) ? sJson.features.map(f=>{f.properties = f.properties||{}; f.properties._layer='state'; return f;}) : [];
              const all = cFeatures.concat(sFeatures);
              if(all.length){
                _globe.polygonsData(all)
                  .polygonAltitude(f => f.properties && f.properties._layer === 'state' ? 0.004 : 0.002)
                  .polygonCapColor(f => f.properties && f.properties._layer === 'state' ? 'rgba(255,215,0,0.08)' : 'rgba(255,255,255,0.02)')
                  .polygonSideColor(() => 'rgba(0,0,0,0)')
                  .polygonStrokeColor(() => '#ffffff')
                  .polygonsTransitionDuration(0)
                  .polygonLabel(f => f.properties && (f.properties.name || f.properties.NAME || f.properties.STATE_NAME) ? (f.properties.name || f.properties.NAME || f.properties.STATE_NAME) : '');
              }
            }catch(err){ console.error('Failed loading polygons', err); }
          })();
      }catch(err){
        console.error('Globe initialization failed', err);
        log('Globe initialization failed; check console for details');
        return;
      }
    }
    // expose globe for debug in browser console
    try{ window.__POTA_GLOBE = _globe; }catch(e){}

    // Build arcs and unique points
    const arcs = [];
    const pointsMap = new Map();
    contacts.forEach(c => {
      if(!c.coord || !c.myCoord) return;
      arcs.push({
        startLat: c.myCoord.lat,
        startLng: c.myCoord.lon,
        endLat: c.coord.lat,
        endLng: c.coord.lon,
        color: '#ffd700',
        alt: 0
      });

      const aKey = `${c.myCoord.lat.toFixed(6)}_${c.myCoord.lon.toFixed(6)}`;
      if(!pointsMap.has(aKey)) pointsMap.set(aKey, {lat: c.myCoord.lat, lng: c.myCoord.lon, label: `My: ${c.myGrid}` , color: '#ff0000', size: 0.18});
      const bKey = `${c.coord.lat.toFixed(6)}_${c.coord.lon.toFixed(6)}`;
      if(!pointsMap.has(bKey)) pointsMap.set(bKey, {lat: c.coord.lat, lng: c.coord.lon, label: `${c.call || ''} ${c.grid || ''}`, color: '#00ff00', size: 0.12});
    });

    const points = Array.from(pointsMap.values());

    // Update globe data (works whether globe is newly created or already initialized)
    try{
      console.log('Updating globe with', points.length, 'points and', arcs.length, 'arcs');
      _globe.pointsData(points);
      _globe.arcsData(arcs);
      if(points.length){
        const originPoint = points.find(p => p.label && p.label.startsWith('My:')) || points[0];
        _globe.pointOfView({lat: originPoint.lat, lng: originPoint.lng, altitude: 2.5}, 1000);
      }
    }catch(err){
      console.error('Error updating globe data', err);
      log('Error updating globe data; check console');
    }
  }

  function handleFile(text, parkRef){
    log('Parsing ADIF...');
    const parsed = parseADIF(text);
    log(`Header tags: ${parsed.header.map(h=>h.tag).filter(Boolean).join(', ')}`);
    log(`Records parsed: ${parsed.records.length}`);

    // Remove duplicates by CALL
    const dedupeResult = dedupeRecords(parsed.records);
    log(`Contacts (original): ${dedupeResult.before}`);
    log(`Duplicates removed: ${dedupeResult.removed}`);
    log(`Contacts (unique): ${dedupeResult.after}`);

    // replace parsed.records with deduped list
    parsed.records = dedupeResult.deduped;

    // Update the new Summary UI elements with counts and duplicates
    const totalOriginalEl = document.getElementById('totalOriginal');
    const totalRemovedEl = document.getElementById('totalRemoved');
    const totalUniqueEl = document.getElementById('totalUnique');
    const duplicatesListEl = document.getElementById('duplicatesList');
    if(totalOriginalEl) totalOriginalEl.textContent = String(dedupeResult.before);
    if(totalRemovedEl) totalRemovedEl.textContent = String(dedupeResult.removed);
    if(totalUniqueEl) totalUniqueEl.textContent = String(dedupeResult.after);
    if(duplicatesListEl){
      duplicatesListEl.innerHTML = '';
      if(dedupeResult.duplicateSummary && dedupeResult.duplicateSummary.length){
        dedupeResult.duplicateSummary.forEach(d => {
          const li = document.createElement('li');
          li.textContent = `${d.call} — ${d.count} entries (removed ${d.removed})`;
          duplicatesListEl.appendChild(li);
        });
      } else {
        const li = document.createElement('li');
        li.textContent = 'No duplicate calls found.';
        duplicatesListEl.appendChild(li);
      }
    }

    // Determine station callsign for filename: prefer STATION_CALLSIGN in first record, then header STATION_CALLSIGN, then CALL, then MY_CALL
    function findHeaderTag(tagNames){
      tagNames = Array.isArray(tagNames) ? tagNames : [tagNames];
      for(const t of tagNames){
        const h = parsed.header.find(x => x.tag && x.tag.toUpperCase() === t.toUpperCase());
        if(h && String(h.value || '').trim().length) return String(h.value).trim();
      }
      return null;
    }

    function findFirstRecordTag(tagName){
      if(!parsed.records || parsed.records.length === 0) return null;
      const f = parsed.records[0].fields.find(x => x.tag && x.tag.toUpperCase() === tagName.toUpperCase());
      return f && String(f.value || '').trim().length ? String(f.value).trim() : null;
    }

    let stationCall = findFirstRecordTag('STATION_CALLSIGN') || findHeaderTag(['STATION_CALLSIGN','CALL','MY_CALL']) || 'UNKNOWN';
    stationCall = stationCall.toUpperCase().replace(/\s+/g,'');

    // Inject STATION_CALLSIGN into each record if missing
    parsed.records.forEach(rec => {
      const hasStation = rec.fields.some(f => f.tag && f.tag.toUpperCase() === 'STATION_CALLSIGN');
      if(!hasStation){
        rec.fields.push({tag: 'STATION_CALLSIGN', value: stationCall});
      }
    });

    // Render globe arcs per record using MY_GRIDSQUARE -> GRIDSQUARE
    try{
      const contacts = parsed.records.map(rec => {
        const gridField = rec.fields.find(f => f.tag && ['GRIDSQUARE','GRID','GRIDSQ'].includes(f.tag.toUpperCase()));
        const callField = rec.fields.find(f => f.tag && f.tag.toUpperCase() === 'CALL');
        const myGridField = rec.fields.find(f => f.tag && f.tag.toUpperCase() === 'MY_GRIDSQUARE');
        const grid = gridField ? String(gridField.value).trim() : null;
        const call = callField ? String(callField.value).trim() : null;
        const myGrid = myGridField ? String(myGridField.value).trim() : null;
        const coord = grid ? maidenToLatLon(grid) : null;
        const myCoord = myGrid ? maidenToLatLon(myGrid) : null;
        return {grid, call, coord, myGrid, myCoord};
      }).filter(c => c.coord && c.myCoord);
      if(contacts && contacts.length) renderGlobe(contacts);
    }catch(e){
      console.error('Globe render error', e);
    }

    // Determine a date: prefer QSO_DATE from first record, else header, else today
    function extractDateFromRecord(rec){
      const f = rec.fields.find(x => x.tag && x.tag.toUpperCase() === 'QSO_DATE');
      if(!f || !f.value) return null;
      const v = String(f.value).trim();
      const m = v.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
      if(m) return {year:m[1], month:m[2], day:m[3]};
      return null;
    }

    let ymd = null;
    if(parsed.records && parsed.records.length > 0){
      ymd = extractDateFromRecord(parsed.records[0]);
    }
    if(!ymd){
      const hdrDate = findHeaderTag(['QSO_DATE','DATE']);
      if(hdrDate){
        const m = String(hdrDate).match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
        if(m) ymd = {year:m[1], month:m[2], day:m[3]};
      }
    }
    if(!ymd){
      const dt = new Date();
      const yy = dt.getFullYear();
      const mm = String(dt.getMonth()+1).padStart(2,'0');
      const dd = String(dt.getDate()).padStart(2,'0');
      ymd = {year: String(yy), month: mm, day: dd};
    }

    const parkPart = parkRef && parkRef.length ? parkRef.replace(/\s+/g,'') : 'NOPARK';
    const out = buildADIF(parsed, parkRef);
    preview.value = out;
    const blobUrl = URL.createObjectURL(new Blob([out], {type:'text/plain'}));
    downloadLink.href = blobUrl;

    // Filename format: CALLSIGN_YEAR-MONTH-DAY_PARK.adi
    const filename = `${stationCall}_${ymd.year}-${ymd.month}-${ymd.day}_${parkPart}.adi`;
    downloadLink.download = filename;
    downloadLink.classList.remove('hidden');
    log(`Ready: click Download to save the ADI for upload to POTA.app — filename: ${filename}`);
  }

  processBtn.addEventListener('click', ()=>{
    console.log('processBtn clicked');
    const file = fileInput.files && fileInput.files[0];
    if(file) console.log('Selected file:', file.name, 'size:', file.size);
    const parkRef = (parkRefInput.value || '').trim();
    if(!file){ log('No file selected'); return; }
    if(!parkRef){ log('Warning: no park ref provided — ADIF will be created without POTA_REF'); }
    const reader = new FileReader();
    reader.onload = function(e){
      console.log('file loaded into memory, calling handleFile');
      handleFile(String(e.target.result), parkRef);
    };
    reader.onerror = function(ev){ console.error('FileReader error', ev); log('Error reading file'); };
    reader.readAsText(file);
  });

})();
