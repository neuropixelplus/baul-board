// NP+ RefBoards — frontend sin build. Config en config.js (URL + anon key).
const sb = supabase.createClient(window.BAUL_CONFIG.url, window.BAUL_CONFIG.anonKey);
const BUCKET = 'baul';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { me: null, boards: [], board: null, shots: [], filter: 'todos', kinds: new Set(), open: null, view: null };
const KIND_LABEL = { todos: 'Todo', shot: 'Shots', bg: 'BGs', asset: 'Assets', sheet: 'Sheets' };
const KIND_ONE = { shot: 'Shot', bg: 'BG', asset: 'Asset', sheet: 'Sheet' };
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

// `undo`: función que deshace; el aviso muestra el botón "Deshacer" (y Ctrl+Z) mientras está visible.
function toast(msg, ms = 2500, undo = null) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  toast.undo = undo;
  if (undo) {
    const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Deshacer';
    b.onclick = () => { t.hidden = true; toast.undo = null; undo(); };
    t.append(' ', b); ms = Math.max(ms, 8000);
  }
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; toast.undo = null; }, ms);
}
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || !toast.undo) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  e.preventDefault(); $('#toast').querySelector('button')?.click();
});
const now = () => new Date().toISOString();
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
    .select('*, renders(*), comments(*)').eq('board_id', state.board.id).is('deleted_at', null).order('sort').order('code');
  if (error) return toast(error.message);
  for (const s of data) {
    // nextV cuenta también los renders en la papelera, para no repetir versión al restaurar.
    s.nextV = 1 + Math.max(0, ...s.renders.map(r => +r.version.replace(/\D/g, '') || 0));
    s.renders = s.renders.filter(r => !r.deleted_at).sort((a, b) => a.created_at.localeCompare(b.created_at));
    s.comments.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  state.shots = data;
  await renderBoard();
  const want = new URLSearchParams(location.hash.slice(1)).get('s');
  if (state.open) openShot(state.shots.find(s => s.id === state.open.id), true);
  else if (want) { const s = state.shots.find(x => x.code === want); if (s) openShot(s); }
}
const latestRender = s => s.renders.find(r => r.id === s.approved_render_id) || s.renders.at(-1);

async function renderBoard() {
  const shots = state.shots.filter(s => (state.filter === 'todos' || s.status === state.filter)
    && (!state.kinds.size || state.kinds.has(s.kind || 'shot')));
  for (const b of $('#kinds').querySelectorAll('button')) {
    const n = b.dataset.k === 'todos' ? state.shots.length : state.shots.filter(s => (s.kind || 'shot') === b.dataset.k).length;
    b.textContent = `${KIND_LABEL[b.dataset.k]} ${n}`;
  }
  const url = await signedUrls(shots.flatMap(s => [s.sketch_path, latestRender(s)?.path]));
  const board = $('#board');
  board.querySelectorAll('.card').forEach(c => c.remove());
  for (const s of shots) {
    const r = latestRender(s);
    const open = s.comments.filter(c => !c.resolved).length;
    const el = document.createElement('article');
    el.className = 'card'; el.dataset.id = s.id; el.draggable = true;
    el.innerHTML = `
      <button class="del" title="Eliminar (va a la papelera)">✕</button>
      <button class="use" title="Usar esta imagen como render de otro shot (elegir de la lista)">↪ render de…</button>
      <button class="mv" title="Mover en la secuencia: elegir después de qué tarjeta va">⇅ Mover</button>
      <div class="pair">
        <div class="ph s" title="Arrastra el boceto sobre otra tarjeta para usarlo como render de esa">${s.sketch_path ? `<img loading="lazy" draggable="false" src="${url(s.sketch_path)}" alt="">` : 'sin boceto'}<span class="lbl">${(s.kind || 'shot') !== 'shot' ? KIND_LABEL[s.kind] : /_color$/.test(s.code) ? 'color' : 'boceto'}</span></div>
        <div class="ph r" ${r ? 'title="Arrastra el render a otra tarjeta (o a un espacio vacío) para moverlo solo a él"' : ''}>${r ? `<img loading="lazy" draggable="false" src="${url(r.path)}" alt="">` : 'sin render'}${r ? `<span class="lbl">${esc(r.version)}${r.id === s.approved_render_id ? ' ✓' : ''}</span>` : ''}${imgTools(!!r)}</div>
      </div>
      <div class="meta">
        <div class="row1"><span class="seq" title="Posición en la secuencia">${state.shots.indexOf(s) + 1}</span><span class="code">${esc(s.code)}</span><span class="pill ${s.status}">${s.status}</span>
          <select class="kind" title="Tipo">${Object.entries(KIND_ONE).map(([k, l]) => `<option value="${k}" ${k === (s.kind || 'shot') ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="grow"></span>
          <span class="muted small">${s.renders.length} render${s.renders.length === 1 ? '' : 's'}${open ? ` · 💬 ${open}` : ''}</span></div>
        ${s.title ? `<div class="muted">${esc(s.title)}</div>` : ''}
        <div class="who">${s.characters.map(c => `<span class="chip" title="${esc([c.where, c.look, c.action].filter(Boolean).join(' · '))}">${esc(c.name)}${c.where ? ' · ' + esc(c.where) : ''}</span>`).join('')}</div>
      </div>`;
    wireTools(el.querySelector('.ph.r'), s, r?.id);
    el.onclick = e => { if (e.target.closest('.kind, .tools')) return; if (e.target.closest('.del')) return deleteShot(s); if (e.target.closest('.use')) return pickTarget(s); if (e.target.closest('.mv')) return pickTarget(s, 'move'); openShot(s); };
    el.querySelector('.kind').onchange = e => setKind(s, e.target.value);
    dropTarget(el, files => uploadRenders(s, files));
    // Desde la franja de abajo (código): reordenar. Desde el render: se mueve solo ese render.
    // Desde el boceto: la tarjeta entera pasa a ser render de la otra.
    let from = 'sketch';
    el.onpointerdown = e => (from = e.target.closest('.meta') ? 'order' : r && e.target.closest('.ph.r') ? 'render' : 'sketch');
    el.addEventListener('dragstart', e => {
      if (e.target.closest?.('select')) return e.preventDefault();
      if (from === 'order') e.dataTransfer.setData(T_ORDER, s.id);
      else if (from === 'render') e.dataTransfer.setData(T_RENDER, `${s.id}/${r.id}`);
      else e.dataTransfer.setData(T_SHOT, s.id);
      e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging', 'drag-' + from);
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging', 'drag-order', 'drag-render', 'drag-sketch'));
    // En una sola columna se decide por arriba/abajo; con varias, por izquierda/derecha.
    const side = e => { const b = el.getBoundingClientRect();
      return (oneColumn() ? e.clientY > b.top + b.height / 2 : e.clientX > b.left + b.width / 2) ? 'after' : 'before'; };
    const clear = () => el.classList.remove('dragover', 'ins-before', 'ins-after', 'v');
    el.addEventListener('dragover', e => {
      if (!isInternal(e)) return;
      e.preventDefault(); e.stopPropagation(); clear();
      el.classList.add(e.dataTransfer.types.includes(T_ORDER) ? 'ins-' + side(e) : 'dragover');
      el.classList.toggle('v', oneColumn());
    });
    el.addEventListener('dragleave', clear);
    el.addEventListener('drop', e => {
      if (!isInternal(e)) return;
      e.preventDefault(); e.stopPropagation(); clear();
      const ord = e.dataTransfer.getData(T_ORDER);
      if (ord) { if (ord !== s.id) reorder(ord, s.id, side(e) === 'after'); return; }
      const [srcId, rid] = (e.dataTransfer.getData(T_RENDER) || '').split('/');
      if (rid) { if (srcId !== s.id) moveRender(state.shots.find(x => x.id === srcId), rid, s); return; }
      const id = e.dataTransfer.getData(T_SHOT);
      if (id && id !== s.id) mergeAsRender(state.shots.find(x => x.id === id), s);
    });
    board.appendChild(el);
  }
}

const T_SHOT = 'application/x-baul-shot', T_RENDER = 'application/x-baul-render', T_ORDER = 'application/x-baul-order';
const isInternal = e => [T_SHOT, T_RENDER, T_ORDER].some(t => e.dataTransfer.types.includes(t));
const run = async (...qs) => { for (const q of qs) { const { error } = await q; if (error) throw error; } };
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 5000); } loadShots(); };

// Eliminar = mandar a la papelera. Se deshace con el aviso, Ctrl+Z o desde la Papelera.
const deleteShot = guard(async s => {
  await run(sb.from('shots').update({ deleted_at: now() }).eq('id', s.id));
  if (state.open?.id === s.id) closeShot();
  toast(`${s.code} a la papelera`, 8000, guard(() => run(sb.from('shots').update({ deleted_at: null }).eq('id', s.id))));
});

const deleteRender = guard(async (s, r) => {
  const wasApproved = s.approved_render_id === r.id;
  await run(sb.from('renders').update({ deleted_at: now() }).eq('id', r.id),
    ...(wasApproved ? [sb.from('shots').update({ approved_render_id: null }).eq('id', s.id)] : []));
  state.view = null;
  toast(`Render ${r.version} de ${s.code} a la papelera`, 8000, guard(() => run(
    sb.from('renders').update({ deleted_at: null }).eq('id', r.id),
    ...(wasApproved ? [sb.from('shots').update({ approved_render_id: r.id }).eq('id', s.id)] : []))));
});

// La imagen (y renders/comentarios) de `src` pasan a `dst` como renders; `src` va a la papelera.
// Boceto soltado sobre una imagen a color: se invierte, el color es el render del boceto.
const mergeAsRender = guard(async (src, dst) => {
  if (!src?.sketch_path || !dst) return;
  if (/_color$/.test(dst.code) && !/_color$/.test(src.code)) [src, dst] = [dst, src];
  if ((src.kind || 'shot') !== 'shot' && !await ask(`${src.code} está marcado como ${KIND_ONE[src.kind]}. ¿Usarlo igual como render de ${dst.code}?`, 'Sí, usarlo')) return;
  let n = dst.nextV;
  const { data: r, error } = await sb.from('renders').insert({
    shot_id: dst.id, version: `v${n++}`, path: src.sketch_path, source: `PureRef ${src.code}`,
    created_by: state.me.name || state.me.email, note: src.notes }).select().single();
  if (error) throw error;
  const moved = src.renders.map(x => ({ id: x.id, version: x.version }));
  const cids = src.comments.map(c => c.id);
  await run(...src.renders.map(x => sb.from('renders').update({ shot_id: dst.id, version: `v${n++}` }).eq('id', x.id)),
    ...(cids.length ? [sb.from('comments').update({ shot_id: dst.id }).in('id', cids)] : []),
    sb.from('shots').update({ deleted_at: now() }).eq('id', src.id),
    ...(dst.status === 'pendiente' ? [sb.from('shots').update({ status: 'generado' }).eq('id', dst.id)] : []));
  toast(`${src.code} ahora es render ${r.version} de ${dst.code}`, 8000, guard(() => run(
    sb.from('renders').delete().eq('id', r.id),
    ...moved.map(x => sb.from('renders').update({ shot_id: src.id, version: x.version }).eq('id', x.id)),
    ...(cids.length ? [sb.from('comments').update({ shot_id: src.id }).in('id', cids)] : []),
    sb.from('shots').update({ deleted_at: null }).eq('id', src.id),
    sb.from('shots').update({ status: dst.status }).eq('id', dst.id))));
});

// Invierte boceto y render (el dibujo quedó como render del color). Un "_color" deja de serlo: pierde el sufijo.
const swapSketch = guard(async (s, r) => {
  const plain = s.code.replace(/_color$/, '');
  const fields = { sketch_path: r.path, updated_at: now() };
  if (plain !== s.code && !state.shots.some(x => x.code === plain)) {
    const { data: taken } = await sb.from('shots').select('id').eq('board_id', state.board.id).eq('code', plain).maybeSingle();
    if (!taken) fields.code = plain;
  }
  if (/^COLOR sin asignar/.test(s.title || '')) fields.title = null;
  await run(sb.from('shots').update(fields).eq('id', s.id),
    sb.from('renders').update({ path: s.sketch_path, source: `${r.source || ''} (invertido)`.trim() }).eq('id', r.id));
  if (fields.code) { s.code = fields.code; setHash(s); }
  toast(`Invertido: el boceto de ${fields.code || s.code} ahora es el dibujo y el color es render ${r.version}`, 6000);
});

// Orden de la secuencia: deja `id` antes o después de `targetId`. Si no hay hueco en `sort`, renumera el tablero.
const reorder = guard(async (id, targetId, after) => {
  const list = state.shots.filter(x => x.id !== id);
  const i = list.findIndex(x => x.id === targetId) + (after ? 1 : 0);
  const moving = state.shots.find(x => x.id === id);
  list.splice(i, 0, moving);
  const old = new Map(state.shots.map(x => [x.id, x.sort]));
  const prev = list[i - 1]?.sort, next = list[i + 1]?.sort;
  const changes = prev === undefined ? [[id, next - 10]] : next === undefined ? [[id, prev + 10]]
    : next - prev > 1 ? [[id, Math.floor((prev + next) / 2)]]
    : list.map((x, k) => [x.id, (k + 1) * 10]).filter(([xid, v]) => old.get(xid) !== v);
  const apply = pairs => run(...pairs.map(([xid, v]) => sb.from('shots').update({ sort: v }).eq('id', xid)));
  await apply(changes);
  toast(`${moving.code} movida ${after ? 'después de' : 'antes de'} ${state.shots.find(x => x.id === targetId).code}`, 6000,
    guard(() => apply(changes.map(([xid]) => [xid, old.get(xid)]))));
});

// Mueve solo un render de `src` a `dst`.
const moveRender = guard(async (src, rid, dst) => {
  const r = src?.renders.find(x => x.id === rid); if (!r) return;
  const version = `v${dst.nextV}`;
  const srcFields = {};
  if (src.approved_render_id === r.id) srcFields.approved_render_id = null;
  if (src.renders.length === 1 && src.status !== 'pendiente') srcFields.status = 'pendiente';
  await run(sb.from('renders').update({ shot_id: dst.id, version }).eq('id', r.id),
    ...(Object.keys(srcFields).length ? [sb.from('shots').update(srcFields).eq('id', src.id)] : []),
    ...(dst.status === 'pendiente' ? [sb.from('shots').update({ status: 'generado' }).eq('id', dst.id)] : []));
  toast(`Render ${r.version} de ${src.code} → ${version} de ${dst.code}`, 8000, guard(() => run(
    sb.from('renders').update({ shot_id: src.id, version: r.version }).eq('id', r.id),
    sb.from('shots').update({ approved_render_id: src.approved_render_id, status: src.status }).eq('id', src.id),
    sb.from('shots').update({ status: dst.status }).eq('id', dst.id))));
});

// Render soltado en un espacio vacío del tablero: sale como tarjeta propia (lo inverso de mergeAsRender).
const renderToCard = guard(async (src, rid) => {
  const r = src?.renders.find(x => x.id === rid); if (!r) return;
  let code = `${src.code}_${r.version}`;
  if (state.shots.some(x => x.code === code)) code += '_' + stamp().slice(9);
  const { data: s, error } = await sb.from('shots').insert({ board_id: state.board.id, code, sort: src.sort + 1,
    sketch_path: r.path, notes: `Sacado de ${src.code} (${r.version})` }).select().single();
  if (error) throw error;
  await run(sb.from('renders').update({ deleted_at: now() }).eq('id', r.id),
    ...(src.approved_render_id === r.id ? [sb.from('shots').update({ approved_render_id: null }).eq('id', src.id)] : []));
  toast(`Render ${r.version} de ${src.code} ahora es la tarjeta ${code}`, 8000, guard(() => run(
    sb.from('shots').delete().eq('id', s.id),
    sb.from('renders').update({ deleted_at: null }).eq('id', r.id),
    sb.from('shots').update({ approved_render_id: src.approved_render_id }).eq('id', src.id))));
});

// Elegir de una lista (sin arrastrar) el shot del que esta imagen es render; útil cuando el destino está lejos.
// mode 'move': elegir después de qué tarjeta va `src` en la secuencia (sin arrastrar).
function pickTarget(src, mode = 'render') {
  const move = mode === 'move';
  const m = document.createElement('div'); m.className = 'modal';
  // A la izquierda, grande, la imagen que se está asignando; a la derecha las opciones, con tamaño ajustable.
  m.innerHTML = `<div class="modal-box pick"><div class="row"><b>${move ? `¿Después de cuál va ${esc(src.code)}?` : `¿De qué shot es render ${esc(src.code)}?`}</b><span class="grow"></span>
      <label class="zoom">Tamaño <input type="range" class="pick-size" min="160" max="640" step="20"></label>
      ${move ? '<button class="ghost small" data-first>Al principio</button>' : ''}<button class="ghost small" data-close>Cancelar</button></div>
    <div class="pick-body"><figure class="pick-src"><img alt=""><figcaption>${esc(src.code)}</figcaption></figure>
      <div class="pick-right"><input class="pick-q" placeholder="Filtrar por código, título o personaje"><div class="pick-grid"></div></div></div></div>`;
  const grid = m.querySelector('.pick-grid'), input = m.querySelector('.pick-q'), size = m.querySelector('.pick-size');
  let w = 300; try { w = +localStorage.getItem('pickSize') || 300; } catch {}
  size.value = w; grid.style.setProperty('--pick-w', w + 'px');
  size.oninput = () => { grid.style.setProperty('--pick-w', size.value + 'px'); try { localStorage.setItem('pickSize', size.value); } catch {} };
  const srcPath = (move && latestRender(src)?.path) || src.sketch_path;
  signedUrls([srcPath]).then(u => { m.querySelector('.pick-src img').src = u(srcPath); });
  const opts = state.shots.filter(s => s.id !== src.id && (move || (s.kind || 'shot') === 'shot'));
  // Sugeridos (solo al asignar render): parecido de composición + cercanía en el orden original de PureRef.
  const score = new Map();
  if (!move) suggest(src, opts, score).finally(() => { score.done = true; draw(); });
  const draw = async () => {
    const q = input.value.trim().toLowerCase();
    let list = opts.filter(s => !q || [s.code, s.title, ...s.characters.map(c => c.name)].join(' ').toLowerCase().includes(q));
    if (score.size) list = [...list].sort((a, b) => (score.get(b.id) ?? -9) - (score.get(a.id) ?? -9));
    const best = score.size ? new Set([...score].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)) : new Set();
    const pic = s => (move && latestRender(s)?.path) || s.sketch_path;
    const url = await signedUrls(list.map(pic));
    grid.innerHTML = (!move && !score.done ? '<p class="muted small" style="grid-column:1/-1">Buscando bocetos parecidos…</p>' : '') + list.map(s => `<button class="ghost ${best.has(s.id) ? 'best' : ''}" data-id="${s.id}">${best.has(s.id) ? '<i class="star">★ parecido</i>' : ''}${pic(s) ? `<img loading="lazy" src="${url(pic(s))}" alt="">` : ''}<span><b>${state.shots.indexOf(s) + 1}</b> · ${esc(s.code)}${s.renders.length ? ` · ${s.renders.length} render` : ''}${s.title ? ` · <span class="muted">${esc(s.title)}</span>` : ''}</span></button>`).join('')
      || '<p class="muted">Nada coincide.</p>';
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey, true); };
  input.oninput = draw;
  m.onclick = e => {
    if (e.target === m || e.target.dataset.close !== undefined) return close();
    if (e.target.dataset.first !== undefined) { close(); return reorder(src.id, opts[0].id, false); }
    const id = e.target.closest('[data-id]')?.dataset.id; if (!id) return;
    close(); move ? reorder(src.id, id, true) : mergeAsRender(src, state.shots.find(s => s.id === id));
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(m); draw(); input.focus();
}

// Huella de composición: mapa de bordes 64×36 difuminado y normalizado (sirve para boceto y para render).
const featCache = new Map();
async function composition(path) {
  if (!featCache.has(path)) featCache.set(path, (async () => {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = (await signedUrls([path]))(path); await img.decode();
    const W = 64, H = 36, w2 = W * 2, h2 = H * 2, c = new OffscreenCanvas(w2, h2), g = c.getContext('2d');
    g.drawImage(img, 0, 0, w2, h2);
    const d = g.getImageData(0, 0, w2, h2).data, gray = new Float32Array(w2 * h2);
    for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * .3 + d[i * 4 + 1] * .59 + d[i * 4 + 2] * .11) / 255;
    const e = new Float32Array(W * H), p = (y, x) => gray[y * w2 + x];
    for (let y = 1; y < h2 - 1; y++) for (let x = 1; x < w2 - 1; x++) {
      const gx = p(y - 1, x + 1) + 2 * p(y, x + 1) + p(y + 1, x + 1) - p(y - 1, x - 1) - 2 * p(y, x - 1) - p(y + 1, x - 1);
      const gy = p(y + 1, x - 1) + 2 * p(y + 1, x) + p(y + 1, x + 1) - p(y - 1, x - 1) - 2 * p(y - 1, x) - p(y - 1, x + 1);
      e[(y >> 1) * W + (x >> 1)] += Math.hypot(gx, gy);
    }
    const b = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < H && xx >= 0 && xx < W) { sum += e[yy * W + xx]; n++; }
      }
      b[y * W + x] = sum / n;
    }
    const mean = b.reduce((a, v) => a + v, 0) / b.length; let norm = 0;
    for (let i = 0; i < b.length; i++) { b[i] -= mean; norm += b[i] * b[i]; }
    norm = Math.sqrt(norm) || 1; for (let i = 0; i < b.length; i++) b[i] /= norm;
    return b;
  })().catch(() => null));
  return featCache.get(path);
}
// Probado con los 14 pares ya asignados de la Parte 5: el boceto correcto sale 1º en 9 y entre los 5 primeros en 12.
async function suggest(src, opts, score) {
  const f0 = await composition(src.sketch_path); if (!f0) return;
  const num = x => +(x?.match(/P\d+_(\d{3})/)?.[1] ?? NaN), n0 = num(src.code);
  await Promise.all(opts.filter(o => o.sketch_path).map(async o => {
    const f = await composition(o.sketch_path); if (!f) return;
    let sim = 0; for (let i = 0; i < f.length; i++) sim += f[i] * f0[i];
    const dist = Math.abs(num(o.code) - n0);
    score.set(o.id, sim + (isNaN(dist) ? 0 : 0.5 * Math.exp(-dist / 3)));
  }));
}

// Papelera del tablero actual: shots y renders eliminados, con Restaurar.
async function openTrash() {
  if (!state.board) return;
  const [{ data: shots, error: e1 }, { data: rends, error: e2 }] = await Promise.all([
    sb.from('shots').select('id, code, sketch_path, deleted_at').eq('board_id', state.board.id)
      .not('deleted_at', 'is', null).order('deleted_at', { ascending: false }),
    sb.from('renders').select('id, version, path, deleted_at, shots!inner(code, board_id, deleted_at)').eq('shots.board_id', state.board.id)
      .not('deleted_at', 'is', null).order('deleted_at', { ascending: false }),
  ]);
  if (e1 || e2) return toast((e1 || e2).message, 5000);
  const items = [
    ...shots.map(s => ({ t: 'shots', id: s.id, path: s.sketch_path, label: s.code, at: s.deleted_at })),
    ...rends.filter(r => !r.shots.deleted_at).map(r => ({ t: 'renders', id: r.id, path: r.path, label: `${r.shots.code} · render ${r.version}`, at: r.deleted_at })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const url = await signedUrls(items.map(i => i.path));
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="modal-box trash"><div class="row"><b>Papelera · EP${state.board.episode} Parte ${state.board.part}</b><span class="grow"></span><button class="ghost small" data-close>Cerrar</button></div>
    ${items.map((i, k) => `<div class="trash-item"><img src="${url(i.path)}" alt=""><div><b>${esc(i.label)}</b><div class="muted small">${new Date(i.at).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}</div></div><button class="small" data-k="${k}">Restaurar</button></div>`).join('')
      || '<p class="muted">Vacía.</p>'}</div>`;
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey, true); };
  m.onclick = async e => {
    if (e.target === m || e.target.dataset.close !== undefined) return close();
    const i = items[e.target.dataset.k]; if (!i) return;
    const { error } = await sb.from(i.t).update({ deleted_at: null }).eq('id', i.id);
    if (error) return toast(error.message, 5000);
    e.target.closest('.trash-item').remove(); toast(`Restaurado ${i.label}`); loadShots();
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(m);
}
$('#trash').onclick = openTrash;

async function setKind(s, kind) {
  const fields = { kind, updated_at: new Date().toISOString() };
  if (kind !== 'shot' && /^COLOR sin asignar/.test(s.title || '')) fields.title = null; // ya está clasificada
  const { error } = await sb.from('shots').update(fields).eq('id', s.id);
  if (error) return toast(error.message);
  Object.assign(s, fields); toast(`${s.code} → ${KIND_ONE[kind]}`); renderBoard();
}
// Tipos: cada botón se prende/apaga (p.ej. solo Shots = omitir BGs, assets y sheets). Ninguno prendido = Todo.
function setKinds(kinds) {
  state.kinds = new Set(kinds);
  $('#kinds').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === 'todos' ? !state.kinds.size : state.kinds.has(b.dataset.k)));
  try { localStorage.setItem('kinds', JSON.stringify([...state.kinds])); } catch {}
  renderBoard();
}
$('#kinds').onclick = e => {
  const k = e.target.dataset?.k; if (!k) return;
  if (k === 'todos') return setKinds([]);
  const next = new Set(state.kinds); next.has(k) ? next.delete(k) : next.add(k);
  setKinds(next.size === 4 ? [] : next);
};
try { const saved = JSON.parse(localStorage.getItem('kinds') || '[]'); state.kinds = new Set(saved);
  $('#kinds').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === 'todos' ? !state.kinds.size : state.kinds.has(b.dataset.k))); } catch {}
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
      // Puede existir en la papelera (el código es único por tablero): entonces vuelve con la imagen nueva.
      const { data: exist } = await sb.from('shots').select('id').eq('board_id', state.board.id).eq('code', code).maybeSingle();
      const q = exist
        ? sb.from('shots').update({ sketch_path: path, deleted_at: null, updated_at: now() }).eq('id', exist.id)
        : sb.from('shots').insert({ board_id: state.board.id, code, sort, sketch_path: path });
      const { error } = await q; if (error) throw error;
      toast(`Subido ${code}`);
    } catch (e) { toast(`${code}: ${e.message}`, 5000); }
  }
  loadShots();
}
$('#add-shots').onchange = e => { addShots([...e.target.files]); e.target.value = ''; };
dropTarget($('#board'), addShots);
// Render soltado fuera de las tarjetas: sale como tarjeta propia.
$('#board').addEventListener('dragover', e => { if (e.dataTransfer.types.includes(T_RENDER)) e.preventDefault(); });
$('#board').addEventListener('drop', e => {
  const [srcId, rid] = (e.dataTransfer.getData(T_RENDER) || '').split('/'); if (!rid) return;
  e.preventDefault(); renderToCard(state.shots.find(x => x.id === srcId), rid);
});

// Imágenes desde el explorador, otra pestaña del navegador o el portapapeles.
// Hay que copiar los datos antes de cualquier await: el navegador los vacía al terminar el evento.
const snapshot = dt => ({ files: [...(dt.files || [])], html: dt.getData('text/html'), uri: dt.getData('text/uri-list') });
const hasImageData = dt => !isInternal({ dataTransfer: dt }) && ['Files', 'text/uri-list', 'text/html'].some(t => dt.types.includes(t));
async function imagesFrom(snap) {
  const files = snap.files.filter(f => f.type.startsWith('image/'));
  if (files.length) return files;
  let src = snap.html && new DOMParser().parseFromString(snap.html, 'text/html').querySelector('img')?.getAttribute('src');
  if (!src) src = snap.uri.split(/\r?\n/).find(l => l && !l.startsWith('#'))?.trim();
  if (!src) return [];
  try {
    const res = await fetch(src); if (!res.ok) throw new Error(res.status);
    const blob = await res.blob(); if (!blob.type.startsWith('image/')) throw new Error(blob.type);
    const e = blob.type.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*/, '');
    return [new File([blob], `web_${stamp()}.${e}`, { type: blob.type })];
  } catch {
    toast('Esa página no deja copiar la imagen así. Clic derecho en la imagen → Copiar imagen, y aquí Ctrl+V.', 7000);
    return [];
  }
}
// Nombres genéricos del portapapeles ("image.png") → código único, para no pisar otra tarjeta.
const named = files => files.map((f, i) => /^(image|imagen|blob|unnamed|untitled)\b/i.test(f.name)
  ? new File([f], `pegado_${stamp()}_${i + 1}${ext(f)}`, { type: f.type }) : f);

function dropTarget(el, onFiles) {
  el.addEventListener('dragover', e => { if (!hasImageData(e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', async e => {
    el.classList.remove('dragover');
    if (!hasImageData(e.dataTransfer)) return;
    e.preventDefault(); e.stopPropagation();
    const files = named(await imagesFrom(snapshot(e.dataTransfer)));
    if (files.length) onFiles(files);
  });
}

// Ctrl+V: con un shot abierto → render de ese shot; con el mouse sobre una tarjeta → render de esa; si no → tarjetas nuevas.
document.addEventListener('paste', async e => {
  if ($('#app').hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector('.modal')) return;
  const snap = snapshot(e.clipboardData);
  if (!snap.files.length && !snap.html) return;
  const target = !$('#detail').hidden ? state.open
    : state.shots.find(s => s.id === document.querySelector('.card:hover')?.dataset.id);
  // En el detalle, con el mouse sobre el boceto o un render: se reemplaza esa imagen.
  const over = !$('#detail').hidden && document.querySelector('#compare figure:hover')?.dataset.t;
  e.preventDefault();
  const files = named(await imagesFrom(snap));
  if (!files.length) return;
  if (over) replaceImage(target, over, files[0]);
  else if (target) uploadRenders(target, files); else addShots(files);
});

// Botones sobre una imagen: editar en Photoshop y reemplazar desde el disco (sin imagen: subir una).
const imgTools = has => `<div class="tools">${has ? '<button class="t-ps" title="Editar en Photoshop: al guardar vuelve sola aquí">✎ Editar</button>' : ''}<label class="t-rep" title="${has ? 'Reemplazar por otra imagen del disco (o mouse encima + Ctrl+V)' : 'Subir render desde el disco'}">${has ? '⟳ Reemplazar' : '+ Render'}<input type="file" accept="image/*" hidden></label></div>`;
function wireTools(box, s, which) {
  const t = box?.querySelector('.tools'); if (!t) return;
  t.onclick = e => e.stopPropagation();
  t.querySelector('.t-ps')?.addEventListener('click', () => editInPhotoshop(s, which));
  t.querySelector('input').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    which ? replaceImage(s, which, f) : uploadRenders(s, [f]); };
}
const oneColumn = () => getComputedStyle($('#board')).gridTemplateColumns.split(' ').length === 1;

// Reemplaza el boceto (`which` = 'sketch') o un render (id) por otra imagen. El archivo viejo queda en Storage (Deshacer).
const replaceImage = guard(async (s, which, file) => {
  const r = which === 'sketch' ? null : s.renders.find(x => x.id === which);
  if (!r && which !== 'sketch') return;
  const path = await uploadFile(file, `${basePath(state.board, s.code)}/${r ? 'render_' + r.version : 'sketch'}_${stamp()}${ext(file)}`);
  const q = (p) => r ? sb.from('renders').update({ path: p }).eq('id', r.id) : sb.from('shots').update({ sketch_path: p, updated_at: now() }).eq('id', s.id);
  const old = r ? r.path : s.sketch_path;
  await run(q(path));
  toast(`${r ? 'Render ' + r.version : 'Boceto'} de ${s.code} reemplazado`, 8000, guard(() => run(q(old))));
});

// Pide abrir la imagen en Photoshop: el ayudante de tu PC (ps-helper.mjs) toma el pedido; al guardar allá, vuelve sola.
async function editInPhotoshop(s, which) {
  const r = which === 'sketch' ? null : s.renders.find(x => x.id === which);
  const { data, error } = await sb.from('ps_requests').insert({
    target: r ? 'renders' : 'shots', row_id: r ? r.id : s.id, path: r ? r.path : s.sketch_path,
    base: basePath(state.board, s.code), prefix: r ? 'render_' + r.version : 'sketch',
    label: `${s.code}_${r ? r.version : 'boceto'}`, requested_by: state.me.email }).select().single();
  if (error) return toast(error.message, 5000);
  toast('Abriendo en Photoshop… Cada vez que guardes (Ctrl+S) se actualiza aquí.', 6000);
  // Si en unos segundos nadie lo tomó, el ayudante no está abierto.
  setTimeout(async () => {
    const { data: q } = await sb.from('ps_requests').select('picked_at').eq('id', data.id).single();
    if (!q?.picked_at) toast('El ayudante de Photoshop no está abierto en tu PC: doble clic en "Editar con Photoshop.cmd" (carpeta baul-board).', 9000);
  }, 6000);
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
    $('#d-kind').value = s.kind || 'shot';
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
  const fig = (src, cap, t = '') => `<figure data-t="${t}" title="${t ? 'Mouse encima + Ctrl+V = reemplazar esta imagen' : ''}"><figcaption>${cap}</figcaption>${src ? `<img src="${src}" alt="">` : '<div class="muted">—</div>'}${t ? imgTools(true) : ''}</figure>`;
  const r = s.renders.find(x => x.id === state.view);
  const last = latestRender(s);
  let meta = '';
  if (state.view === 'sketch') { cmp.className = 'compare single'; cmp.innerHTML = fig(sketch, 'Boceto', 'sketch'); }
  else if (state.view?.startsWith?.('f')) { cmp.className = 'compare single'; cmp.innerHTML = fig(url(frames[+state.view.slice(1)]), `Frame ${+state.view.slice(1) + 2}`); }
  else if (state.view === 'wipe' && last) {
    cmp.className = 'compare single';
    cmp.innerHTML = `<figure><figcaption>Cortina: boceto ← → ${esc(last.version)} (mueve el mouse)</figcaption><div class="wipe"><img src="${url(last.path)}" alt=""><img class="top" src="${sketch}" alt=""><div class="bar"></div></div></figure>`;
    const w = cmp.querySelector('.wipe'), top = w.querySelector('.top'), bar = w.querySelector('.bar');
    const set = x => { const p = Math.max(0, Math.min(1, x)); top.style.clipPath = `inset(0 ${100 - p * 100}% 0 0)`; bar.style.left = p * 100 + '%'; };
    set(.5); w.onmousemove = e => { const b = w.getBoundingClientRect(); set((e.clientX - b.left) / b.width); };
  } else if (r) {
    cmp.className = 'compare';
    cmp.innerHTML = fig(sketch, 'Boceto', 'sketch') + fig(url(r.path), `Render ${esc(r.version)}${r.id === s.approved_render_id ? ' · aprobado' : ''}`, r.id);
    meta = [r.source, r.created_by, new Date(r.created_at).toLocaleString('es')].filter(Boolean).join(' · ');
  } else { cmp.className = 'compare single'; cmp.innerHTML = fig(sketch, 'Boceto · sin render todavía', 'sketch'); }
  $('#render-meta').textContent = meta;
  const delBtn = $('#del-render');
  delBtn.hidden = !r; delBtn.onclick = () => deleteRender(s, r);
  $('#out-render').hidden = !r; $('#out-render').onclick = () => { closeShot(); renderToCard(s, r.id); };
  $('#swap-render').hidden = !r || !s.sketch_path; $('#swap-render').onclick = () => swapSketch(s, r);
  // Editar / Reemplazar van encima de cada imagen (imgTools).
  cmp.querySelectorAll('figure[data-t]').forEach(f => f.dataset.t && wireTools(f, s, f.dataset.t));
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
$('#d-kind').onchange = e => setKind(state.open, e.target.value);
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

async function uploadRenders(s, files) {
  if (!s || !files?.length) return;
  try {
    let n = s.nextV ?? s.renders.length + 1;
    const done = [];
    for (const file of files) {
      const version = `v${n++}`;
      const path = await uploadFile(file, `${basePath(state.board, s.code)}/render_${version}_${stamp()}${ext(file)}`);
      const { error } = await sb.from('renders').insert({ shot_id: s.id, version, path, source: file.name, created_by: state.me.name || state.me.email });
      if (error) throw error;
      done.push(version);
    }
    await sb.from('shots').update({ status: 'generado', updated_at: now() }).eq('id', s.id);
    toast(`Render ${done.join(', ')} subido a ${s.code}`);
  } catch (e) { toast(e.message, 5000); }
  loadShots();
}
$('#up-render').onchange = e => { uploadRenders(state.open, [...e.target.files]); e.target.value = ''; };
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
dropTarget($('#compare'), files => uploadRenders(state.open, files));

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
