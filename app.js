// Baúl Board — frontend sin build. Config en config.js (URL + anon key).
const sb = supabase.createClient(window.BAUL_CONFIG.url, window.BAUL_CONFIG.anonKey);
const BUCKET = 'baul';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { me: null, boards: [], board: null, shots: [], filter: 'todos', open: null, view: null };
const urlCache = new Map(); // path -> {url, exp}

// Confirmación dentro de la página: confirm()/prompt() nativos no aparecen en algunos navegadores integrados.
// Con `fields` devuelve los valores escritos (o null); sin ellos, true/false.
function ask(msg, okLabel = 'Sí', fields = []) {
  return new Promise(resolve => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<form class="modal-box"><p></p>${fields.map(f => `<input required placeholder="${esc(f)}">`).join('')}
      <div class="row"><button type="button" class="ghost" data-a="0">Cancelar</button><button type="submit"></button></div></form>`;
    m.querySelector('p').textContent = msg;
    m.querySelector('[type=submit]').textContent = okLabel;
    const done = v => { m.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(fields.length ? null : false); } };
    m.onclick = e => { if (e.target === m || e.target.dataset?.a === '0') done(fields.length ? null : false); };
    m.querySelector('form').onsubmit = e => { e.preventDefault(); done(fields.length ? [...m.querySelectorAll('input')].map(i => i.value.trim()) : true); };
    document.addEventListener('keydown', key, true);
    document.body.appendChild(m);
    (m.querySelector('input') || m.querySelector('[type=submit]')).focus();
  });
}

function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
async function signedUrls(paths) {
  const now = Date.now();
  const need = [...new Set(paths.filter(p => p && !(urlCache.get(p)?.exp > now)))];
  if (need.length) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
    if (error) throw error;
    for (const d of data) if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: now + 3300e3 });
  }
  return p => urlCache.get(p)?.url ?? '';
}
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const ext = f => (f.name.match(/\.\w+$/)?.[0] || '.jpg').toLowerCase();
async function uploadFile(file, path) {
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type });
  if (error) throw error;
  return path;
}
const basePath = (b, code) => `EP${b.episode}/P${b.part}/${slug(code)}`;

// ---------- auth ----------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  const email = session.user.email.toLowerCase();
  const { data: m } = await sb.from('members').select('*').eq('email', email).maybeSingle();
  // Sin cerrar sesión: cuando lo agreguen a members, basta con recargar.
  if (!m) { showLogin(`${email} entró, pero no tiene acceso todavía. Pídeselo a René y recarga la página.`); $('#login-form').hidden = true; return; }
  state.me = m;
  $('#me').textContent = m.name || email;
  $('#login').hidden = true; $('#app').hidden = false;
  await loadBoards();
  subscribe();
}
function showLogin(msg = '') { $('#login').hidden = false; $('#app').hidden = true; $('#login-msg').textContent = msg; }
$('#login-form').onsubmit = async e => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  $('#login-msg').textContent = error ? error.message : `Listo: revisa ${email} y abre el enlace.`;
};
$('#logout').onclick = async () => { await sb.auth.signOut(); location.reload(); };
sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_IN' && !state.me) boot(); });

// ---------- boards ----------
async function loadBoards() {
  const { data } = await sb.from('boards').select('*').order('episode').order('part');
  state.boards = data || [];
  const want = new URLSearchParams(location.hash.slice(1)).get('b');
  state.board = state.boards.find(b => `${b.episode}-${b.part}` === want) || state.boards.at(-1) || null;
  $('#board-select').innerHTML = state.boards.map(b =>
    `<option value="${b.id}" ${b === state.board ? 'selected' : ''}>EP${b.episode} · Parte ${b.part}${b.title && !/^EP\d/.test(b.title) ? ' — ' + esc(b.title) : ''}</option>`).join('');
  await loadShots();
}
$('#board-select').onchange = e => { state.board = state.boards.find(b => b.id === e.target.value); setHash(); loadShots(); };
$('#new-board').onclick = async () => {
  const v = await ask('Nuevo tablero', 'Crear', ['Episodio (número)', 'Parte (número)']); if (!v) return;
  const [ep, part] = v; if (!+ep || !+part) return toast('Episodio y parte deben ser números');
  const { data, error } = await sb.from('boards').insert({ episode: +ep, part: +part, title: `EP${+ep} · Parte ${+part}` }).select().single();
  if (error) return toast(error.message);
  location.hash = `b=${data.episode}-${data.part}`; loadBoards();
};
function setHash(shot) {
  const b = state.board; if (!b) return;
  history.replaceState(null, '', `#b=${b.episode}-${b.part}${shot ? '&s=' + encodeURIComponent(shot.code) : ''}`);
}

async function loadShots() {
  if (!state.board) { $('#board').querySelectorAll('.card').forEach(c => c.remove()); return; }
  const { data, error } = await sb.from('shots')
    .select('*, renders(*), comments(*)').eq('board_id', state.board.id).order('sort').order('code');
  if (error) return toast(error.message);
  for (const s of data) { s.renders.sort((a, b) => a.created_at.localeCompare(b.created_at)); s.comments.sort((a, b) => a.created_at.localeCompare(b.created_at)); }
  state.shots = data;
  await renderBoard();
  const want = new URLSearchParams(location.hash.slice(1)).get('s');
  if (state.open) openShot(state.shots.find(s => s.id === state.open.id), true);
  else if (want) { const s = state.shots.find(x => x.code === want); if (s) openShot(s); }
}
const latestRender = s => s.renders.find(r => r.id === s.approved_render_id) || s.renders.at(-1);

async function renderBoard() {
  const shots = state.shots.filter(s => state.filter === 'todos' || s.status === state.filter);
  const url = await signedUrls(shots.flatMap(s => [s.sketch_path, latestRender(s)?.path]));
  const board = $('#board');
  board.querySelectorAll('.card').forEach(c => c.remove());
  for (const s of shots) {
    const r = latestRender(s);
    const open = s.comments.filter(c => !c.resolved).length;
    const el = document.createElement('article');
    el.className = 'card'; el.dataset.id = s.id; el.draggable = true;
    el.title = 'Arrastra esta tarjeta sobre otra para usar su imagen como render de esa';
    el.innerHTML = `
      <button class="del" title="Eliminar shot">✕</button>
      <div class="pair">
        <div class="ph">${s.sketch_path ? `<img loading="lazy" src="${url(s.sketch_path)}" alt="">` : 'sin boceto'}<span class="lbl">boceto</span></div>
        <div class="ph">${r ? `<img loading="lazy" src="${url(r.path)}" alt="">` : 'sin render'}${r ? `<span class="lbl">${esc(r.version)}${r.id === s.approved_render_id ? ' ✓' : ''}</span>` : ''}</div>
      </div>
      <div class="meta">
        <div class="row1"><span class="code">${esc(s.code)}</span><span class="pill ${s.status}">${s.status}</span><span class="grow"></span>
          <span class="muted small">${s.renders.length} render${s.renders.length === 1 ? '' : 's'}${open ? ` · 💬 ${open}` : ''}</span></div>
        ${s.title ? `<div class="muted">${esc(s.title)}</div>` : ''}
        <div class="who">${s.characters.map(c => `<span class="chip" title="${esc([c.where, c.look, c.action].filter(Boolean).join(' · '))}">${esc(c.name)}${c.where ? ' · ' + esc(c.where) : ''}</span>`).join('')}</div>
      </div>`;
    el.onclick = e => { if (e.target.closest('.del')) return deleteShot(s); openShot(s); };
    dropTarget(el, files => uploadRender(s, files[0]));
    // Tarjeta sobre tarjeta: la imagen de la arrastrada pasa a ser render de la otra.
    el.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-baul-shot', s.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('application/x-baul-shot')) return;
      e.preventDefault(); el.classList.add('dragover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', e => {
      const id = e.dataTransfer.getData('application/x-baul-shot');
      el.classList.remove('dragover');
      if (!id || id === s.id) return;
      e.preventDefault(); e.stopPropagation();
      mergeAsRender(state.shots.find(x => x.id === id), s);
    });
    board.appendChild(el);
  }
}

async function deleteShot(s) {
  if (!await ask(`¿Eliminar el shot ${s.code} con sus ${s.renders.length} render(s) y comentarios?`)) return;
  const { error } = await sb.from('shots').delete().eq('id', s.id);
  if (error) return toast(error.message);
  toast(`Eliminado ${s.code}`); if (state.open?.id === s.id) closeShot(); loadShots();
}

async function deleteRender(s, r) {
  if (!await ask(`¿Eliminar el render ${r.version} de ${s.code}?`)) return;
  if (s.approved_render_id === r.id) await sb.from('shots').update({ approved_render_id: null }).eq('id', s.id);
  const { error } = await sb.from('renders').delete().eq('id', r.id);
  if (error) return toast(error.message);
  toast(`Render ${r.version} eliminado`); state.view = null; loadShots();
}

// La imagen (y renders/comentarios) de `src` pasan a `dst` como renders; `src` se elimina.
async function mergeAsRender(src, dst) {
  if (!src || !src.sketch_path) return;
  if (!await ask(`¿Usar la imagen de ${src.code} como render de ${dst.code}? (${src.code} desaparece del tablero)`)) return;
  try {
    let n = dst.renders.length;
    const { data: r, error } = await sb.from('renders').insert({
      shot_id: dst.id, version: `v${++n}`, path: src.sketch_path, source: `PureRef ${src.code}`,
      created_by: state.me.name || state.me.email, note: src.notes }).select().single();
    if (error) throw error;
    for (const old of src.renders) {
      const { error: e2 } = await sb.from('renders').update({ shot_id: dst.id, version: `v${++n}` }).eq('id', old.id);
      if (e2) throw e2;
    }
    if (src.comments.length) await sb.from('comments').update({ shot_id: dst.id }).eq('shot_id', src.id);
    const { error: e3 } = await sb.from('shots').delete().eq('id', src.id); if (e3) throw e3;
    if (dst.status === 'pendiente') await sb.from('shots').update({ status: 'generado' }).eq('id', dst.id);
    toast(`${src.code} ahora es render ${r.version} de ${dst.code}`);
    loadShots();
  } catch (e) { toast(e.message, 5000); }
}
$('#filters').onclick = e => {
  const f = e.target.dataset?.f; if (!f) return;
  state.filter = f; $('#filters').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === f));
  renderBoard();
};
$('#zoom').oninput = e => document.documentElement.style.setProperty('--card-w', e.target.value + 'px');

// Nuevos shots: un shot por imagen, código = nombre del archivo.
async function addShots(files) {
  if (!state.board) return toast('Crea un tablero primero');
  let sort = (state.shots.at(-1)?.sort ?? 0);
  for (const f of files) {
    const code = f.name.replace(/\.\w+$/, '');
    sort += 10;
    try {
      const path = await uploadFile(f, `${basePath(state.board, code)}/sketch_${stamp()}${ext(f)}`);
      const exist = state.shots.find(s => s.code === code);
      const q = exist
        ? sb.from('shots').update({ sketch_path: path, updated_at: new Date().toISOString() }).eq('id', exist.id)
        : sb.from('shots').insert({ board_id: state.board.id, code, sort, sketch_path: path });
      const { error } = await q; if (error) throw error;
      toast(`Subido ${code}`);
    } catch (e) { toast(`${code}: ${e.message}`, 5000); }
  }
  loadShots();
}
$('#add-shots').onchange = e => { addShots([...e.target.files]); e.target.value = ''; };
dropTarget($('#board'), addShots, true);

function dropTarget(el, onFiles, onlySelf = false) {
  el.addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); e.stopPropagation(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', e => {
    el.classList.remove('dragover');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault(); e.stopPropagation(); onFiles(files);
  });
}

// ---------- detalle ----------
async function openShot(s, keepView = false) {
  if (!s) return closeShot();
  const changed = state.open?.id !== s.id;
  state.open = s; setHash(s);
  if (changed || !keepView || !s.renders.some(r => r.id === state.view)) state.view = latestRender(s)?.id ?? 'sketch';
  $('#detail').hidden = false;
  if (changed || !keepView) {
    $('#d-code').value = s.code; $('#d-title').value = s.title ?? '';
    $('#d-notes').value = s.notes ?? ''; $('#d-prompt').value = s.prompt ?? '';
    renderChars();
  }
  $('#d-status').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.s === s.status));
  await renderViewer();
  renderComments();
}
function closeShot() { state.open = null; $('#detail').hidden = true; setHash(); }
$('#d-close').onclick = closeShot;
function step(d) {
  const list = state.shots; const i = list.findIndex(s => s.id === state.open?.id);
  if (i >= 0 && list[i + d]) openShot(list[i + d]);
}
$('#d-prev').onclick = () => step(-1); $('#d-next').onclick = () => step(1);
document.addEventListener('keydown', e => {
  if ($('#detail').hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === 'Escape') { document.querySelector('.lightbox')?.remove() ?? closeShot(); }
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

async function renderViewer() {
  const s = state.open;
  const frames = s.extra_frames || [];
  const url = await signedUrls([s.sketch_path, ...frames, ...s.renders.map(r => r.path)]);
  const tabs = [
    ...s.renders.map(r => `<button data-v="${r.id}" class="${r.id === state.view ? 'on' : ''} ${r.id === s.approved_render_id ? 'ok' : ''}">${esc(r.version)}</button>`),
    s.renders.length ? `<button data-v="wipe" class="${state.view === 'wipe' ? 'on' : ''}" title="Cortina boceto/render">Cortina</button>` : '',
    `<button data-v="sketch" class="${state.view === 'sketch' ? 'on' : ''}">Solo boceto</button>`,
    ...frames.map((p, i) => `<button data-v="f${i}" class="${state.view === 'f' + i ? 'on' : ''}">Frame ${i + 2}</button>`),
  ];
  $('#view-tabs').innerHTML = tabs.join('');
  $('#view-tabs').onclick = e => { const v = e.target.dataset?.v; if (v) { state.view = v; renderViewer(); } };
  const cmp = $('#compare');
  const sketch = s.sketch_path ? url(s.sketch_path) : '';
  const fig = (src, cap) => `<figure><figcaption>${cap}</figcaption>${src ? `<img src="${src}" alt="">` : '<div class="muted">—</div>'}</figure>`;
  const r = s.renders.find(x => x.id === state.view);
  const last = latestRender(s);
  let meta = '';
  if (state.view === 'sketch') { cmp.className = 'compare single'; cmp.innerHTML = fig(sketch, 'Boceto'); }
  else if (state.view?.startsWith?.('f')) { cmp.className = 'compare single'; cmp.innerHTML = fig(url(frames[+state.view.slice(1)]), `Frame ${+state.view.slice(1) + 2}`); }
  else if (state.view === 'wipe' && last) {
    cmp.className = 'compare single';
    cmp.innerHTML = `<figure><figcaption>Cortina: boceto ← → ${esc(last.version)} (mueve el mouse)</figcaption><div class="wipe"><img src="${url(last.path)}" alt=""><img class="top" src="${sketch}" alt=""><div class="bar"></div></div></figure>`;
    const w = cmp.querySelector('.wipe'), top = w.querySelector('.top'), bar = w.querySelector('.bar');
    const set = x => { const p = Math.max(0, Math.min(1, x)); top.style.clipPath = `inset(0 ${100 - p * 100}% 0 0)`; bar.style.left = p * 100 + '%'; };
    set(.5); w.onmousemove = e => { const b = w.getBoundingClientRect(); set((e.clientX - b.left) / b.width); };
  } else if (r) {
    cmp.className = 'compare';
    cmp.innerHTML = fig(sketch, 'Boceto') + fig(url(r.path), `Render ${esc(r.version)}${r.id === s.approved_render_id ? ' · aprobado' : ''}`);
    meta = [r.source, r.created_by, new Date(r.created_at).toLocaleString('es')].filter(Boolean).join(' · ');
  } else { cmp.className = 'compare single'; cmp.innerHTML = fig(sketch, 'Boceto · sin render todavía'); }
  $('#render-meta').textContent = meta;
  const delBtn = $('#del-render');
  delBtn.hidden = !r; delBtn.onclick = () => deleteRender(s, r);
  cmp.querySelectorAll('figure > img').forEach(img => img.onclick = () => {
    const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${img.src}">`;
    lb.onclick = () => lb.remove(); document.body.appendChild(lb);
  });
}

async function patchShot(fields) {
  const s = state.open;
  const { error } = await sb.from('shots').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', s.id);
  if (error) return toast(error.message);
  Object.assign(s, fields);
}
$('#d-status').onclick = async e => {
  const st = e.target.dataset?.s; if (!st) return;
  const fields = { status: st };
  const viewing = state.open.renders.find(r => r.id === state.view);
  if (st === 'aprobado') fields.approved_render_id = viewing?.id ?? latestRender(state.open)?.id ?? null;
  await patchShot(fields);
  if (st === 'cambios' && !$('#comment-text').value) { $('#comment-text').focus(); $('#comment-text').placeholder = '¿Qué cambiamos?'; }
  openShot(state.open, true); renderBoard();
};
for (const [sel, key] of [['#d-title', 'title'], ['#d-notes', 'notes'], ['#d-prompt', 'prompt']])
  $(sel).onchange = e => patchShot({ [key]: e.target.value || null }).then(renderBoard);
$('#d-code').onchange = e => {
  const v = e.target.value.trim(); if (!v) return (e.target.value = state.open.code);
  patchShot({ code: v }).then(() => { setHash(state.open); renderBoard(); });
};

function renderChars() {
  const s = state.open;
  $('#chars').innerHTML = s.characters.map((c, i) => `
    <div class="char" data-i="${i}">
      <input class="name" data-k="name" value="${esc(c.name)}" placeholder="Nombre">
      <input data-k="where" value="${esc(c.where)}" placeholder="Dónde (izq, centro…)">
      <button class="ghost small" data-del="${i}" title="Quitar">✕</button>
      <input class="full" data-k="look" value="${esc(c.look)}" placeholder="Cómo se ve (sheet, ropa, rasgo clave)">
      <input class="full" data-k="action" value="${esc(c.action)}" placeholder="Qué hace / a dónde mira">
    </div>`).join('') || '<p class="muted small">Sin personajes. Agrega quién es quién para no confundirlos.</p>';
}
$('#chars').onchange = e => {
  const i = +e.target.closest('.char')?.dataset.i; const k = e.target.dataset.k; if (!k) return;
  const chars = structuredClone(state.open.characters); chars[i][k] = e.target.value;
  patchShot({ characters: chars }).then(renderBoard);
};
$('#chars').onclick = e => {
  const d = e.target.dataset?.del; if (d === undefined) return;
  const chars = state.open.characters.filter((_, i) => i !== +d);
  patchShot({ characters: chars }).then(() => { renderChars(); renderBoard(); });
};
$('#add-char').onclick = () => {
  const chars = [...state.open.characters, { name: '', where: '', look: '', action: '' }];
  patchShot({ characters: chars }).then(() => { renderChars(); $('#chars .char:last-child .name').focus(); });
};

function renderComments() {
  const s = state.open;
  const ver = id => s.renders.find(r => r.id === id)?.version;
  $('#comments').innerHTML = s.comments.map(c => `
    <div class="cm ${c.resolved ? 'resolved' : ''}">
      <div class="h"><b>${esc(c.author)}</b>${c.render_id ? `<span>sobre ${esc(ver(c.render_id) ?? 'render')}</span>` : ''}<span>${new Date(c.created_at).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}</span>
        <span class="grow"></span><button class="ghost" data-res="${c.id}">${c.resolved ? 'Reabrir' : 'Resuelto'}</button></div>
      <p>${esc(c.body)}</p>
    </div>`).join('') || '<p class="muted small">Sin comentarios.</p>';
}
$('#comments').onclick = async e => {
  const id = e.target.dataset?.res; if (!id) return;
  const c = state.open.comments.find(x => x.id === id);
  const { error } = await sb.from('comments').update({ resolved: !c.resolved }).eq('id', id);
  if (error) return toast(error.message);
  c.resolved = !c.resolved; renderComments(); renderBoard();
};
$('#comment-form').onsubmit = async e => {
  e.preventDefault();
  const body = $('#comment-text').value.trim(); if (!body) return;
  const s = state.open;
  const render_id = $('#comment-on-render').checked ? (s.renders.find(r => r.id === state.view)?.id ?? latestRender(s)?.id ?? null) : null;
  const { data, error } = await sb.from('comments').insert({ shot_id: s.id, render_id, author: state.me.name || state.me.email, body }).select().single();
  if (error) return toast(error.message);
  if (!s.comments.some(c => c.id === data.id)) s.comments.push(data);
  $('#comment-text').value = ''; renderComments(); renderBoard();
};

async function uploadRender(s, file) {
  if (!file) return;
  try {
    const version = `v${s.renders.length + 1}`;
    const path = await uploadFile(file, `${basePath(state.board, s.code)}/render_${version}_${stamp()}${ext(file)}`);
    const { error } = await sb.from('renders').insert({ shot_id: s.id, version, path, source: file.name, created_by: state.me.name || state.me.email });
    if (error) throw error;
    await sb.from('shots').update({ status: 'generado', updated_at: new Date().toISOString() }).eq('id', s.id);
    toast(`Render ${version} subido a ${s.code}`);
    loadShots();
  } catch (e) { toast(e.message, 5000); }
}
$('#up-render').onchange = e => { uploadRender(state.open, e.target.files[0]); e.target.value = ''; };
$('#up-sketch').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const path = await uploadFile(f, `${basePath(state.board, state.open.code)}/sketch_${stamp()}${ext(f)}`);
  await patchShot({ sketch_path: path }); loadShots();
};
$('#up-frames').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  const paths = [];
  for (const [i, f] of files.entries()) paths.push(await uploadFile(f, `${basePath(state.board, state.open.code)}/frame_${stamp()}_${i}${ext(f)}`));
  await patchShot({ extra_frames: [...(state.open.extra_frames || []), ...paths] }); loadShots();
};
dropTarget($('#compare'), files => uploadRender(state.open, files[0]));

// ---------- tiempo real ----------
function subscribe() {
  let t;
  const refresh = () => { clearTimeout(t); t = setTimeout(loadShots, 400); };
  sb.channel('board')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'shots' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'renders' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, refresh)
    .subscribe();
}

boot();
