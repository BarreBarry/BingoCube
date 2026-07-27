(async () => {
  "use strict";

  /* ===================== CUBE ENGINE ===================== */
  const SPACING = 62;
  const HALF = 30;

  const I = [[1,0,0],[0,1,0],[0,0,1]];
  function rot(axis, deg) {
    const a = deg * Math.PI / 180;
    const c = Math.round(Math.cos(a));
    const s = Math.round(Math.sin(a));
    if (axis === 'x') return [[1,0,0],[0,c,-s],[0,s,c]];
    if (axis === 'y') return [[c,0,s],[0,1,0],[-s,0,c]];
    return [[c,-s,0],[s,c,0],[0,0,1]];
  }
  function mul(A, B) {
    const R = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i=0;i<3;i++) for (let j=0;j<3;j++) {
      let sum=0; for (let k=0;k<3;k++) sum += A[i][k]*B[k][j];
      R[i][j]=sum;
    }
    return R;
  }
  function apply(M, v) {
    return [
      M[0][0]*v[0]+M[0][1]*v[1]+M[0][2]*v[2],
      M[1][0]*v[0]+M[1][1]*v[1]+M[1][2]*v[2],
      M[2][0]*v[0]+M[2][1]*v[1]+M[2][2]*v[2],
    ].map(Math.round);
  }

  const cubeEl = document.getElementById('cube');
  const cubies = [];

  /* ---------- multi-team game state ----------
     One-machine build: every team has its OWN stickers AND cube arrangement,
     all persisted in localStorage. Players pick a team and only see that cube;
     the host can switch between every team to view / edit / rotate each one. */
  let faceSeq = 0;
  const GAME_KEY = 'rubiksGame_v3';
  const DEFAULT_TEAMS = ['Team Alpha', 'Team Bravo', 'Team Charlie', 'Team Delta'];

  /* ---------- data source: Google Sheets ----------
     GitHub Pages stays purely static (no backend). One Google Sheet is the DB:
       READ  — everyone reads it via the Sheets API + a public API key
               (the sheet must be shared "Anyone with the link: Viewer").
       WRITE — the host signs in with Google; the write only succeeds if their
               Google account has EDIT access to the sheet. That IS the host gate.
     The game JSON is stored in column A, split into ~45k-char chunks (a cell holds
     max 50k chars). Leave SHEETS.id blank to fall back to localStorage (offline). */
  const SHEETS = {
    id:       '1xqrEpMRKyYLsECb8koFX92hFZcC5mVCiiKfW_N9CsOY',                       // sheet id from its URL:  /spreadsheets/d/<THIS_PART>/edit
    apiKey:   'AIzaSyAf__GW6zA_n1Pgl91syEZ_LrbtwRhuhkE',                            // Google Cloud API key (Sheets API) — used for public reads
    clientId: '659216119025-u8rtddip9kv9riabp205nc92plbbr9cp.apps.googleusercontent.com',   // OAuth Web client id — for host sign-in / writes
    tab:      'Sheet1',                                    // the tab that holds the data
  };
  const USE_SHEETS = !!(SHEETS.id && SHEETS.apiKey);
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
  let accessToken = '';                                    // host Google OAuth token (write); never a player's
  let tokenClient = null;

  async function loadGameRaw() {
    if (!USE_SHEETS) return localStorage.getItem(GAME_KEY);
    try {
      const range = encodeURIComponent(`${SHEETS.tab}!A1:A1000`);
      const r = await fetch(`${SHEETS_API}/${SHEETS.id}/values/${range}?key=${SHEETS.apiKey}&_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j.values) return null;
      const joined = j.values.map(row => (row && row[0]) || '').join('');   // reassemble the chunks
      return joined.trim() ? joined : null;
    } catch (e) { return null; }
  }
  // Returns true only if the write succeeded — i.e. this Google account can edit the sheet.
  async function saveGameRaw(json) {
    if (!USE_SHEETS) { localStorage.setItem(GAME_KEY, json); return true; }
    if (!accessToken) return false;
    const CHUNK = 45000, values = [];
    for (let i = 0; i < json.length; i += CHUNK) values.push([json.slice(i, i + CHUNK)]);
    if (values.length === 0) values.push(['']);
    const H = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' };
    try {
      const range = encodeURIComponent(`${SHEETS.tab}!A1:A${values.length}`);
      const r = await fetch(`${SHEETS_API}/${SHEETS.id}/values/${range}?valueInputOption=RAW`,
        { method: 'PUT', headers: H, body: JSON.stringify({ values }) });
      if (!r.ok) { if (r.status === 401) accessToken = ''; console.warn('Sheets save failed', r.status); return false; }
      // clear any stale rows left over from a previously larger save
      const below = encodeURIComponent(`${SHEETS.tab}!A${values.length + 1}:A100000`);
      await fetch(`${SHEETS_API}/${SHEETS.id}/values/${below}:clear`, { method: 'POST', headers: H });
      return true;
    } catch (e) { console.warn('Sheets save error', e); return false; }
  }

  let lastGameJSON = null;   // last game state this tab has seen (used to detect changes)

  let game;
  try { const raw0 = await loadGameRaw(); game = raw0 ? JSON.parse(raw0) : null; } catch (e) { game = null; }
  if (!game || !Array.isArray(game.teams) || !game.data) {
    game = { teams: DEFAULT_TEAMS.slice(), data: {} };
  }
  game.teams.forEach(t => { if (!game.data[t]) game.data[t] = { stickers: {}, cube: null }; });
  game.teams.forEach(t => { if (!('cube' in game.data[t])) game.data[t].cube = null; });   // per-team cube arrangement
  if (Array.isArray(game.cube)) {   // migrate an old shared arrangement onto each team, then drop it
    game.teams.forEach(t => { if (!Array.isArray(game.data[t].cube)) game.data[t].cube = game.cube.map(x => ({ R: x.R.map(r => r.slice()), pos: x.pos.slice() })); });
    delete game.cube;
  }
  if (typeof game.rowBonus !== 'number') game.rowBonus = 0;    // bonus per completed row/column
  if (typeof game.sideBonus !== 'number') game.sideBonus = 0;  // bonus per completed full face

  let hostMode = sessionStorage.getItem('rubiksHost') === '1';
  let myTeam = null;   // a player's team comes ONLY from their URL token (set at boot); no picker, no persistence
  let spectator = false;   // a ?view=all link lets anyone view all teams (read-only, no host powers)

  let activeTeam = game.teams[0];
  let stickerData = game.data[activeTeam].stickers;   // always points at the active team

  let _ghSaveTimer = null;
  function saveGame() {
    try {
      const j = JSON.stringify(game);
      lastGameJSON = j;                                   // optimistic: this tab already holds the new state
      if (USE_SHEETS) { clearTimeout(_ghSaveTimer); _ghSaveTimer = setTimeout(() => saveGameRaw(j), 2000); }  // coalesce writes
      else saveGameRaw(j);
    } catch (e) { console.warn('save failed', e); }
  }
  function saveData() { saveGame(); }                 // alias so existing edit code still works
  function getSticker(sid) { return stickerData[sid] || (stickerData[sid] = {}); }
  function doneCount(team) {
    const s = game.data[team] ? game.data[team].stickers : {};
    return Object.keys(s).filter(k => s[k] && s[k].done).length;
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  const FACES = [
    { n:[ 0, 0, 1], t:`translateZ(${HALF}px)`,                cls:'w' },
    { n:[ 0, 0,-1], t:`rotateY(180deg) translateZ(${HALF}px)`, cls:'w' },
    { n:[ 1, 0, 0], t:`rotateY(90deg) translateZ(${HALF}px)`,  cls:'w' },
    { n:[-1, 0, 0], t:`rotateY(-90deg) translateZ(${HALF}px)`, cls:'w' },
    { n:[ 0, 1, 0], t:`rotateX(90deg) translateZ(${HALF}px)`,  cls:'w' },
    { n:[ 0,-1, 0], t:`rotateX(-90deg) translateZ(${HALF}px)`, cls:'w' },
  ];

  function matrix3d(R, pos) {
    const tx = pos[0]*SPACING, ty = pos[1]*SPACING, tz = pos[2]*SPACING;
    const v = [
      R[0][0], R[1][0], R[2][0], 0,
      R[0][1], R[1][1], R[2][1], 0,
      R[0][2], R[1][2], R[2][2], 0,
      tx, ty, tz, 1
    ];
    return `matrix3d(${v.join(',')})`;
  }

  function makeCubie(pos) {
    const el = document.createElement('div');
    el.className = 'cubie';
    const stickers = [];   // exterior stickers on this cubie: {sid, n(local normal)}
    for (const f of FACES) {
      const fd = document.createElement('div');
      fd.className = 'face ' + f.cls;
      fd.style.transform = f.t;
      // A real, functional sticker is one on the OUTSIDE of the cube (54 total).
      // A face is exterior when its cubie sits on the surface in that face's
      // direction — and this split never changes as the cube turns, so we only
      // number and wire up the exterior faces once, here. Interior faces stay as
      // plain cream fillers (so the cube looks solid) and are never clickable.
      const exterior = (pos[0]*f.n[0] + pos[1]*f.n[1] + pos[2]*f.n[2]) === 1;
      if (exterior) {
        fd.dataset.sid = String(++faceSeq);       // numbered 1..54
        fd.style.pointerEvents = 'auto';
        const thumb = document.createElement('div'); thumb.className = 'thumb';
        const slabel = document.createElement('div'); slabel.className = 'slabel';
        fd.appendChild(thumb);
        fd.appendChild(slabel);
        stickers.push({ sid: fd.dataset.sid, n: f.n });
      }
      el.appendChild(fd);
    }
    const cubie = { el, R: I.map(r=>r.slice()), pos: pos.slice(), home: pos.slice(), stickers };
    render(cubie);
    cubeEl.appendChild(el);
    return cubie;
  }
  // The cube's logic uses a y-up frame, but the screen is y-down. Rendering the
  // logical rotation R directly leaves some cubies orientation-flipped after
  // x/z-axis turns (they show their blank inner face instead of the sticker).
  // Conjugating R by the y-flip gives the correct proper rotation for the screen.
  function screenR(R) {
    return [
      [ R[0][0], -R[0][1],  R[0][2]],
      [-R[1][0],  R[1][1], -R[1][2]],
      [ R[2][0], -R[2][1],  R[2][2]]
    ];
  }
  function cubieMatrix(c) {
    return matrix3d(screenR(c.R), [c.pos[0], -c.pos[1], c.pos[2]]);
  }
  function render(c) {
    c.el.style.transform = cubieMatrix(c);
  }

  for (let x=-1;x<=1;x++)
    for (let y=-1;y<=1;y++)
      for (let z=-1;z<=1;z++)
        cubies.push(makeCubie([x,y,z]));

  // paint each sticker face from its saved host data
  function applyFace(faceEl) {
    const d = stickerData[faceEl.dataset.sid] || {};
    faceEl.classList.toggle('done', !!d.done);
    const thumb = faceEl.querySelector('.thumb');
    const slabel = faceEl.querySelector('.slabel');
    if (d.img) { thumb.style.backgroundImage = `url("${d.img}")`; thumb.style.display = 'block'; }
    else { thumb.style.backgroundImage = ''; thumb.style.display = 'none'; }
    if (d.label) { slabel.textContent = d.label; slabel.style.display = 'flex'; }
    else { slabel.textContent = ''; slabel.style.display = 'none'; }
  }
  function applyAll() { document.querySelectorAll('#cube .face[data-sid]').forEach(applyFace); }
  applyAll();

  const MOVES = {
    U: { axis:'y', layer: 1, deg:-90 },
    D: { axis:'y', layer:-1, deg: 90 },
    R: { axis:'x', layer: 1, deg:-90 },
    L: { axis:'x', layer:-1, deg: 90 },
    F: { axis:'z', layer: 1, deg:-90 },
    B: { axis:'z', layer:-1, deg: 90 },
  };

  let busy = false;
  const history = [];

  function selectLayer(axis, layer) {
    const idx = axis==='x'?0:axis==='y'?1:2;
    return cubies.filter(c => c.pos[idx] === layer);
  }

  function animate(faceName, deg, cb) {
    if (busy) return;
    const mv = MOVES[faceName];
    if (!mv) return;
    busy = true;
    const group = selectLayer(mv.axis, mv.layer);
    const cssAxis = mv.axis;
    let screenDeg = deg;
    if (mv.axis === 'x' || mv.axis === 'z') screenDeg = -deg;
    const rotFn = cssAxis === 'x' ? 'rotateX' : cssAxis === 'y' ? 'rotateY' : 'rotateZ';

    for (const c of group) {
      const base = cubieMatrix(c);
      c.el.style.transition = 'transform .28s cubic-bezier(.3,.9,.35,1)';
      c.el.style.transform = `${rotFn}(${screenDeg}deg) ${base}`;
    }

    setTimeout(() => {
      const Rturn = rot(mv.axis, deg);
      for (const c of group) {
        c.R = mul(Rturn, c.R);
        c.pos = apply(Rturn, c.pos);
        c.el.style.transition = 'none';
        render(c);
      }
      void cubeEl.offsetWidth;
      saveCubeState();
      busy = false;
      if (cb) cb();
    }, 300);
  }

  function doMove(faceName, prime, record=true) {
    if (busy) return;
    const mv = MOVES[faceName];
    const deg = prime ? -mv.deg : mv.deg;
    if (record) history.push({ face: faceName, prime });
    animate(faceName, deg, checkSolved);
    setStatus('');
  }

  function isSolved() {
    for (const c of cubies) {
      const R = c.R;
      if (!(R[0][0]===1 && R[1][1]===1 && R[2][2]===1)) return false;
    }
    return true;
  }
  function checkSolved() {
    if (!scrambled) return;
    if (isSolved()) {
      setStatus('✓ Solved! Nicely done, adventurer.');
      scrambled = false;
    }
  }
  let scrambled = false;

  const statusEl = document.getElementById('status');
  function setStatus(t) { statusEl.innerHTML = t || '&nbsp;'; }

  const FACE_LIST = ['U','D','L','R','F','B'];

  /* ---------- sticker explanation (everyone) ---------- */
  const expTitle  = document.getElementById('expTitle');
  const expBody   = document.getElementById('expBody');
  const expMeta   = document.getElementById('expMeta');
  const expStatus = document.getElementById('expStatus');

  let selectedFace = null;

  function renderReadonly(faceEl) {
    const sid = faceEl.dataset.sid;
    const d = stickerData[sid] || {};
    expTitle.textContent = d.label ? d.label : ('Sticker #' + sid);
    expBody.textContent  = d.desc ? d.desc : 'No description has been set for this sticker yet.';
    expMeta.style.display = 'block';
    expStatus.textContent = d.done ? 'Complete' : 'Pending';
    expStatus.className = 'exp-status ' + (d.done ? 'done' : 'pending');
  }

  function showSticker(faceEl) {
    selectedFace = faceEl;
    renderReadonly(faceEl);
    if (hostMode) fillEditor(faceEl);
  }

  /* ---------- host mode ---------- */
  // ⚠ Change this to your own host password. (Client-side only — this keeps
  //    casual players out, but it is not high security since it lives in the file.)
  const HOST_PASSWORD = 'bingo';

  const hostBtn   = document.getElementById('hostBtn');
  const hostPanel = document.getElementById('hostPanel');
  const edSid     = document.getElementById('edSid');
  const edPreview = document.getElementById('edPreview');
  const edLabel   = document.getElementById('edLabel');
  const edCount   = document.getElementById('edCount');
  const edDesc    = document.getElementById('edDesc');
  const edDone    = document.getElementById('edDone');
  const edImageInput  = document.getElementById('edImageInput');
  const edImportInput = document.getElementById('edImportInput');
  const edPoints      = document.getElementById('edPoints');
  const edRowBonus    = document.getElementById('edRowBonus');
  const edSideBonus   = document.getElementById('edSideBonus');

  // host-only cube rotation buttons
  const turnControls = document.getElementById('turnControls');
  for (const f of FACE_LIST) {
    for (const prime of [false, true]) {
      const b = document.createElement('button');
      b.className = 'turn';
      b.textContent = f + (prime ? "'" : "");
      b.title = 'Turn ' + f + (prime ? " counter-clockwise" : " clockwise");
      b.addEventListener('click', () => doMove(f, prime));
      turnControls.appendChild(b);
    }
  }

  function setHostMode(on) {
    hostMode = on;
    sessionStorage.setItem('rubiksHost', on ? '1' : '0');
    hostBtn.textContent = on ? 'Host: log out' : 'Host login';
    hostBtn.title = on ? 'Host mode — click 5× quickly to log out' : '';
    applyRole();
    if (on && selectedFace) fillEditor(selectedFace);
  }

  // secret access: 5 clicks in quick succession on the invisible hotspot
  let tapCount = 0, lastTap = 0;
  const TAP_GAP = 600; // ms allowed between consecutive clicks
  hostBtn.addEventListener('click', () => {
    const now = Date.now();
    tapCount = (now - lastTap <= TAP_GAP) ? tapCount + 1 : 1;
    lastTap = now;
    if (tapCount < 5) return;
    tapCount = 0;
    if (hostMode) {
      setHostMode(false);
      if (USE_SHEETS && accessToken && window.google && google.accounts && google.accounts.oauth2) {
        try { google.accounts.oauth2.revoke(accessToken); } catch (e) {}
      }
      accessToken = '';
      return;
    }
    if (USE_SHEETS) {
      if (!(window.google && google.accounts && google.accounts.oauth2)) {
        alert('Google sign-in is still loading — try again in a moment.'); return;
      }
      if (!tokenClient) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: SHEETS.clientId,
          scope: 'https://www.googleapis.com/auth/spreadsheets',
          callback: async (resp) => {
            if (!resp || !resp.access_token) return;
            accessToken = resp.access_token;
            // Becoming host = proving this Google account can write the sheet.
            if (await saveGameRaw(JSON.stringify(game))) setHostMode(true);
            else alert('That Google account does not have edit access to the sheet, so it cannot host.');
          },
        });
      }
      tokenClient.requestAccessToken();   // opens the Google sign-in / consent popup
    } else {
      const pw = prompt('Enter host password:');
      if (pw === null) return;
      if (pw === HOST_PASSWORD) setHostMode(true);
      else alert('Incorrect password.');
    }
  });

  function fillEditor(faceEl) {
    const d = getSticker(faceEl.dataset.sid);
    edSid.textContent = '#' + faceEl.dataset.sid;
    edLabel.value = d.label || '';
    edCount.textContent = edLabel.value.length;
    edDesc.value = d.desc || '';
    edPoints.value = (d.points == null ? 1 : d.points);
    edDone.checked = !!d.done;
    if (d.img) { edPreview.style.backgroundImage = `url("${d.img}")`; edPreview.classList.remove('empty'); }
    else { edPreview.style.backgroundImage = ''; edPreview.classList.add('empty'); }
  }

  // reset the editor form to blank (no sticker selected)
  function clearEditor() {
    edSid.textContent = '—';
    edLabel.value = '';
    edCount.textContent = '0';
    edDesc.value = '';
    edPoints.value = '1';
    edDone.checked = false;
    edPreview.style.backgroundImage = '';
    edPreview.classList.add('empty');
  }

  // commit text / status edits for the selected sticker
  function commit() {
    if (!selectedFace) return;
    const d = getSticker(selectedFace.dataset.sid);
    d.label = edLabel.value.slice(0, 20);
    d.desc  = edDesc.value;
    d.points = Math.max(0, Math.floor(Number(edPoints.value) || 0));
    d.done  = edDone.checked;
    saveData();
    applyFace(selectedFace);
    renderReadonly(selectedFace);
    renderLeaderboard();
    renderTeamBar();
  }

  edLabel.addEventListener('input', () => { edCount.textContent = edLabel.value.length; commit(); });
  edDesc.addEventListener('input', commit);
  edPoints.addEventListener('input', commit);
  edDone.addEventListener('change', commit);

  // global scoring bonuses (apply to every team)
  function commitBonuses() {
    game.rowBonus = Math.max(0, Math.floor(Number(edRowBonus.value) || 0));
    game.sideBonus = Math.max(0, Math.floor(Number(edSideBonus.value) || 0));
    saveGame();
    renderLeaderboard();
  }
  edRowBonus.addEventListener('input', commitBonuses);
  edSideBonus.addEventListener('input', commitBonuses);

  // image upload — downscaled to keep storage small
  edImageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file || !selectedFace) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 200;
        let w = img.width, h = img.height;
        const scale = Math.min(1, MAX / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';        // flatten transparency onto white
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const d = getSticker(selectedFace.dataset.sid);
        d.img = cv.toDataURL('image/jpeg', 0.82);
        saveData();
        applyFace(selectedFace);
        fillEditor(selectedFace);
        renderReadonly(selectedFace);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';   // allow re-picking the same file
  });

  document.getElementById('edClearImg').addEventListener('click', () => {
    if (!selectedFace) return;
    delete getSticker(selectedFace.dataset.sid).img;
    saveData(); applyFace(selectedFace); fillEditor(selectedFace); renderReadonly(selectedFace);
  });

  document.getElementById('edClearSticker').addEventListener('click', () => {
    if (!selectedFace) return;
    if (!confirm('Clear all content on sticker #' + selectedFace.dataset.sid + '?')) return;
    delete stickerData[selectedFace.dataset.sid];
    saveData(); applyFace(selectedFace); fillEditor(selectedFace); renderReadonly(selectedFace);
    renderLeaderboard(); renderTeamBar();
  });

  // export / import the WHOLE game (all teams, their stickers + cube states)
  document.getElementById('edExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(game, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cube-game.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  });

  edImportInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.teams) || !parsed.data) throw new Error('bad');
        game = parsed;
        game.teams.forEach(t => { if (!game.data[t]) game.data[t] = { stickers: {}, cube: null }; });
        if (!Array.isArray(game.cube)) game.cube = null;
        if (typeof game.rowBonus !== 'number') game.rowBonus = 0;
        if (typeof game.sideBonus !== 'number') game.sideBonus = 0;
        ensureTokens();
        activeTeam = game.teams[0];
        saveGame();
        edRowBonus.value = game.rowBonus; edSideBonus.value = game.sideBonus;
        renderTeamBar(); renderTeamLinks(); renderLeaderboard();
        applyRole();
        alert('Game imported.');
      } catch (err) { alert('That file could not be read as a valid game export.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  /* ---------- orbit drag + zoom ---------- */
  const orbit = document.getElementById('orbit');
  const zoomer = document.getElementById('zoomer');
  const stage = document.getElementById('stage');
  let rotX = -28, rotY = -36;
  let zoom = 1;
  const ZOOM_MIN = 0.55, ZOOM_MAX = 2.2;
  function applyOrbit() {
    orbit.style.transform = `rotateX(${rotX}deg) rotateY(${rotY}deg)`;
  }
  function setZoom(z) {
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    zoomer.style.transform = `scale(${zoom})`;
  }
  applyOrbit();

  // mouse-wheel zoom over the cube
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.12 : 0.89));
  }, { passive: false });

  let dragging = false, px = 0, py = 0, moved = 0;
  stage.addEventListener('pointerdown', (e) => {
    dragging = true; px = e.clientX; py = e.clientY; moved = 0;
    orbit.style.transition = 'none';
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - px, dy = e.clientY - py;
    px = e.clientX; py = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    rotY += dx * 0.4;
    rotX -= dy * 0.4;
    rotX = Math.max(-89, Math.min(89, rotX));
    applyOrbit();
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    // treat as a click (not a drag) when the pointer barely moved
    if (moved < 6 && e) {
      // find the frontmost clickable sticker under the cursor (skips the cubie
      // container and any occluding non-face element)
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      const face = stack.find(el =>
        el.classList && el.classList.contains('face') && getComputedStyle(el).pointerEvents !== 'none');
      if (face) showSticker(face);
    }
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', () => { dragging = false; });

  /* ===================== TEAMS ===================== */
  const teamBadge      = document.getElementById('teamBadge');
  const hostBar        = document.getElementById('hostBar');
  const teamPicker     = document.getElementById('teamPicker');
  const boardBody      = document.getElementById('boardBody');
  const teamsInput     = document.getElementById('teamsInput');
  const teamLinks      = document.getElementById('teamLinks');

  // --- cube arrangement capture / restore (per team "progression") ---
  function captureCube() {
    return cubies.map(c => ({ R: c.R.map(r => r.slice()), pos: c.pos.slice() }));
  }
  function saveCubeState() {
    game.data[activeTeam].cube = captureCube();   // save THIS team's own arrangement
    saveGame();
    renderLeaderboard();         // rotating regroups rows/faces, so bonuses can change
  }
  function loadCubeState(state) {
    cubies.forEach((c, i) => {
      if (state && state[i]) {
        c.R = state[i].R.map(r => r.slice());
        c.pos = state[i].pos.slice();
      } else {
        c.R = I.map(r => r.slice());
        c.pos = c.home.slice();
      }
      c.el.style.transition = 'none';
      render(c);
    });
    void cubeEl.offsetWidth;
  }

  function resetExplanation() {
    expTitle.textContent = 'No sticker selected';
    expBody.textContent  = 'Click any sticker on the cube to reveal information about it.';
    expMeta.style.display = 'none';
  }

  // load a team's cube + stickers into the single rendered cube
  function switchTeam(name) {
    if (!game.teams.includes(name)) return;
    activeTeam = name;
    stickerData = game.data[name].stickers;
    loadCubeState(game.data[name].cube);   // this team's own arrangement
    applyAll();
    selectedFace = null;
    resetExplanation();
    clearEditor();
    renderTeamBar();
    renderLeaderboard();
    updateTeamUI();
  }

  // ---------- live sync ----------
  // Re-reads the shared game state and, if it changed since this tab last saw it,
  // re-applies it to the current view (cube arrangement, stickers, leaderboard,
  // bonuses). Runs on an interval and also fires instantly when another browser
  // tab writes. When hosted, this is exactly the loop that keeps players in sync
  // with the host over the network.
  async function pollGameState() {
    if (busy || hostMode) return;                       // host is the source of truth; only players/spectators poll
    const raw = await loadGameRaw();
    if (raw == null || raw === lastGameJSON) return;    // nothing new since last check
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return; }
    if (!parsed || !Array.isArray(parsed.teams) || !parsed.data) return;
    lastGameJSON = raw;
    game = parsed;
    // in-memory structural guards only — a refresh never writes back
    game.teams.forEach(t => { if (!game.data[t]) game.data[t] = { stickers: {}, cube: null }; });
    if (!Array.isArray(game.cube)) game.cube = null;
    if (typeof game.rowBonus !== 'number') game.rowBonus = 0;
    if (typeof game.sideBonus !== 'number') game.sideBonus = 0;
    // keep this viewer on their own team
    if (hostMode) {
      if (!game.teams.includes(activeTeam)) activeTeam = game.teams[0];
    } else {
      activeTeam = (myTeam && game.teams.includes(myTeam)) ? myTeam : game.teams[0];
    }
    stickerData = game.data[activeTeam].stickers;
    loadCubeState(game.data[activeTeam].cube);
    applyAll();
    renderTeamBar();
    renderTeamLinks();
    renderLeaderboard();
    updateTeamUI();
    if (edRowBonus) { edRowBonus.value = game.rowBonus; edSideBonus.value = game.sideBonus; }
    if (selectedFace) renderReadonly(selectedFace);
  }

  function updateTeamUI() {
    if (hostMode) {
      teamBadge.hidden = false;
      teamBadge.textContent = '👁 Host view — ' + activeTeam;
    } else if (spectator) {
      teamBadge.hidden = false;
      teamBadge.textContent = 'Spectator: viewing ' + activeTeam;
    } else if (myTeam) {
      teamBadge.hidden = false;
      teamBadge.textContent = 'Team: ' + myTeam;
    } else {
      teamBadge.hidden = true;
    }
    hostBar.querySelectorAll('.team-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.team === activeTeam);
    });
    if (teamsInput) teamsInput.value = game.teams.join('\n');
  }

  function renderTeamBar() {
    hostBar.innerHTML = '';
    const lbl = document.createElement('div');
    lbl.className = 'hb-label';
    lbl.textContent = 'Teams — click to view a cube';
    hostBar.appendChild(lbl);
    game.teams.forEach(t => {
      const chip = document.createElement('button');
      chip.className = 'team-chip' + (t === activeTeam ? ' active' : '');
      chip.dataset.team = t;
      chip.appendChild(document.createTextNode(t + ' '));
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = '(' + doneCount(t) + ')';
      chip.appendChild(cnt);
      chip.addEventListener('click', () => switchTeam(t));
      hostBar.appendChild(chip);
    });
  }

  // --- per-team links ( ?t=<random token> so links can't be guessed ) ---
  function currentBaseUrl() {
    return location.href.split('#')[0].split('?')[0];   // strip any existing query/hash
  }
  function genToken() {
    const b = new Uint8Array(9);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');  // 18 hex chars
  }
  function ensureTokens() {
    const used = new Set();
    game.teams.forEach(t => { if (game.data[t] && game.data[t].token) used.add(game.data[t].token); });
    game.teams.forEach(t => {
      if (!game.data[t].token) {
        let tok; do { tok = genToken(); } while (used.has(tok));
        used.add(tok); game.data[t].token = tok;
      }
    });
  }
  function regenToken(name) {
    const used = new Set(game.teams.map(t => game.data[t] && game.data[t].token).filter(Boolean));
    let tok; do { tok = genToken(); } while (used.has(tok));
    game.data[name].token = tok;
    saveGame();
    renderTeamLinks();
  }
  function teamUrl(name) {
    return currentBaseUrl() + '?t=' + encodeURIComponent(game.data[name].token || '');
  }
  function getUrlTeam() {
    let tok;
    try { tok = new URLSearchParams(location.search).get('t'); } catch (e) { tok = null; }
    if (!tok) return null;
    return game.teams.find(t => game.data[t] && game.data[t].token === tok) || null;
  }
  function copyLink(input, btn) {
    input.focus(); input.select(); input.setSelectionRange(0, 99999);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (!ok && navigator.clipboard) {
      try { navigator.clipboard.writeText(input.value); ok = true; } catch (e) {}
    }
    btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
  }
  function renderTeamLinks() {
    if (!teamLinks) return;
    teamLinks.innerHTML = '';
    game.teams.forEach(t => {
      const row = document.createElement('div'); row.className = 'link-row';
      const nm = document.createElement('span'); nm.className = 'link-name'; nm.textContent = t;
      const inp = document.createElement('input');
      inp.type = 'text'; inp.readOnly = true; inp.className = 'link-input'; inp.value = teamUrl(t);
      inp.addEventListener('focus', () => inp.select());
      const btn = document.createElement('button'); btn.textContent = 'Copy';
      btn.addEventListener('click', () => copyLink(inp, btn));
      const regen = document.createElement('button');
      regen.textContent = '↻'; regen.title = 'Generate a new link (the old one stops working)';
      regen.addEventListener('click', () => {
        if (confirm('Generate a new link for ' + t + '?\nThe current link will stop working.')) regenToken(t);
      });
      row.appendChild(nm); row.appendChild(inp); row.appendChild(btn); row.appendChild(regen);
      teamLinks.appendChild(row);
    });
    // extra public link: a spectator view of ALL teams (read-only, no host powers)
    const srow = document.createElement('div'); srow.className = 'link-row';
    const snm = document.createElement('span'); snm.className = 'link-name'; snm.textContent = 'Spectator (all)';
    const sinp = document.createElement('input');
    sinp.type = 'text'; sinp.readOnly = true; sinp.className = 'link-input'; sinp.value = currentBaseUrl() + '?view=all';
    sinp.addEventListener('focus', () => sinp.select());
    const sbtn = document.createElement('button'); sbtn.textContent = 'Copy';
    sbtn.addEventListener('click', () => copyLink(sinp, sbtn));
    srow.appendChild(snm); srow.appendChild(sinp); srow.appendChild(sbtn);
    teamLinks.appendChild(srow);
  }

  // Group a team's sticker layout into the six 3×3 faces of ITS cube. `state` is
  // that team's stored arrangement (array of {R,pos}); null/undefined = solved.
  function buildFaceGrids(state) {
    const grids = {};
    for (let i = 0; i < cubies.length; i++) {
      const c = cubies[i];
      if (!c.stickers) continue;
      const R = (state && state[i]) ? state[i].R : I;         // this cubie's logical rotation
      const pos = (state && state[i]) ? state[i].pos : c.home;
      for (const st of c.stickers) {
        const wn = apply(R, st.n);                   // this sticker's world normal (a unit axis)
        const k = wn[0] !== 0 ? 0 : (wn[1] !== 0 ? 1 : 2);
        const faceKey = 'xyz'[k] + (wn[k] > 0 ? '+' : '-');
        let u, v;                                    // its position within that face
        if (k === 0)      { u = pos[1]; v = pos[2]; }
        else if (k === 1) { u = pos[0]; v = pos[2]; }
        else              { u = pos[0]; v = pos[1]; }
        (grids[faceKey] || (grids[faceKey] = {}))[u + ',' + v] = st.sid;
      }
    }
    return grids;
  }
  // total highscore points for a team: per-sticker points + row/column + full-side bonuses
  function teamScore(team) {
    const S = (game.data[team] && game.data[team].stickers) || {};
    const done = sid => sid != null && S[sid] && S[sid].done;
    let score = 0;
    for (const sid in S) {
      if (S[sid].done) { const p = S[sid].points; score += (p == null ? 1 : (Number(p) || 0)); }
    }
    const grids = buildFaceGrids(game.data[team] ? game.data[team].cube : null);
    const rowBonus = Number(game.rowBonus) || 0;
    const sideBonus = Number(game.sideBonus) || 0;
    const A = [-1, 0, 1];
    for (const faceKey in grids) {
      const g = grids[faceKey];
      const at = (u, v) => g[u + ',' + v];
      const lines = [];
      for (const v of A) lines.push([at(-1, v), at(0, v), at(1, v)]);   // horizontal rows
      for (const u of A) lines.push([at(u, -1), at(u, 0), at(u, 1)]);   // vertical columns
      for (const ln of lines) if (ln.every(done)) score += rowBonus;
      let full = true;
      for (const u of A) for (const v of A) if (!done(at(u, v))) full = false;
      if (full) score += sideBonus;
    }
    return score;
  }

  function renderLeaderboard() {
    if (!boardBody) return;
    const rows = game.teams.map(t => ({ t, pts: teamScore(t) }));
    rows.sort((a, b) => b.pts - a.pts);
    const medals = ['🥇', '🥈', '🥉'];
    boardBody.innerHTML = '';
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      const rank = i < 3 ? `<span class="medal">${medals[i]}</span>` : (i + 1);
      tr.innerHTML = `<td class="rank">${rank}</td><td>${escapeHtml(r.t)}</td><td class="pts">${r.pts}</td>`;
      boardBody.appendChild(tr);
    });
  }

  // central view controller: decides host vs player and which cube is shown
  function applyRole() {
    document.body.classList.toggle('hostmode', hostMode);
    if (hostMode) {
      teamPicker.hidden = true;
      hostBar.hidden = false;
      if (!game.teams.includes(activeTeam)) activeTeam = game.teams[0];
      switchTeam(activeTeam);
    } else if (spectator) {
      teamPicker.hidden = true;
      hostBar.hidden = false;                 // team switcher visible; no host editor panel
      if (!game.teams.includes(activeTeam)) activeTeam = game.teams[0];
      switchTeam(activeTeam);
    } else {
      hostBar.hidden = true;
      if (myTeam && game.teams.includes(myTeam)) {
        teamPicker.hidden = true;
        switchTeam(myTeam);
      } else {
        teamPicker.hidden = false;
        updateTeamUI();
      }
    }
  }

  // host edits the team list
  document.getElementById('saveTeams').addEventListener('click', () => {
    const names = [...new Set(teamsInput.value.split('\n').map(s => s.trim()).filter(Boolean))];
    if (names.length === 0) { alert('Enter at least one team name.'); return; }
    const removed = game.teams.filter(t => !names.includes(t));
    const removedWithData = removed.filter(t =>
      game.data[t] && Object.keys(game.data[t].stickers).length);
    if (removedWithData.length &&
        !confirm('Remove team(s): ' + removedWithData.join(', ') + '\nThis deletes their cube and stickers. Continue?')) {
      return;
    }
    removed.forEach(t => delete game.data[t]);
    names.forEach(t => { if (!game.data[t]) game.data[t] = { stickers: {}, cube: null }; });
    game.teams = names;
    ensureTokens();
    if (!game.teams.includes(activeTeam)) activeTeam = game.teams[0];
    saveGame();
    renderTeamBar(); renderTeamLinks(); renderLeaderboard();
    switchTeam(activeTeam);
    const saved = document.getElementById('teamsSaved');
    saved.hidden = false;
    clearTimeout(saved._t);
    saved._t = setTimeout(() => { saved.hidden = true; }, 3000);
  });

  /* ---------- boot ---------- */
  ensureTokens();   // give every team a random, unguessable link token
  saveGame();
  // a player's team is decided SOLELY by the ?t=<token> in their link
  myTeam = getUrlTeam();
  try { spectator = new URLSearchParams(location.search).get('view') === 'all'; } catch (e) { spectator = false; }
  if (myTeam) activeTeam = myTeam;
  hostBtn.textContent = hostMode ? 'Host: log out' : 'Host login';
  edRowBonus.value = game.rowBonus;
  edSideBonus.value = game.sideBonus;
  renderTeamBar();
  renderTeamLinks();
  renderLeaderboard();
  applyRole();

  // live sync: auto-refresh from the shared state so players never have to reload.
  // Change REFRESH_MS to tune how often it checks (2s here).
  const REFRESH_MS = USE_SHEETS ? 120000 : 2000;   // Sheets: poll every 30s (well within a 2-min tolerance)
  lastGameJSON = await loadGameRaw();
  setInterval(pollGameState, REFRESH_MS);
  window.addEventListener('storage', (e) => { if (e.key === GAME_KEY) pollGameState(); });

})();
