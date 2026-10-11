// Fork: RAG picker in the chat bar.
//
// The RAG indicator next to the message box is always visible and names what
// chat and agent replies search: "All docs", one indexed folder (or one of its
// subfolders), or "Off". Clicking it opens a menu to switch scope, refresh a
// folder after its files change, or index another folder inside
// data/personal_docs. RAG defaults to ON (all folders), so there is nothing to
// remember to turn on.
//
// State lives with the other chat-bar toggles in localStorage:
//   toggles.rag        true/false   (checkbox #rag-toggle mirrors it)
//   toggles.rag_scope  absolute folder path, '' = all indexed folders
// chat.js sends rag_scope with each message when RAG is on; the server limits
// retrieval to that folder (src/rag_vector.py _in_scope).

import Storage from './storage.js';

const API = window.location.origin;
let menuEl = null;
let folders = { indexed: [], available: [], base: '' };
let busy = '';

function state() {
  const t = Storage.loadToggleState();
  return { on: t.rag !== undefined ? !!t.rag : true, scope: t.rag_scope || '' };
}

function save(on, scope) {
  const t = Storage.loadToggleState();
  t.rag = on;
  t.rag_scope = scope;
  Storage.saveToggleState(t);
  const chk = document.getElementById('rag-toggle');
  if (chk) chk.checked = on;
}

export function getRagScope() {
  const s = state();
  return s.on ? s.scope : '';
}

function scopeLabel(s) {
  if (!s.on) return 'RAG off';
  if (!s.scope) return 'All docs';
  for (const f of folders.indexed) {
    if (f.path === s.scope) return f.name;
    const sub = (f.subfolders || []).find((x) => x.path === s.scope);
    if (sub) return `${f.name}/${sub.name}`;
  }
  return s.scope.split('/').filter(Boolean).pop() || 'Folder';
}

export function render() {
  const btn = document.getElementById('rag-indicator-btn');
  if (!btn) return;
  const s = state();
  btn.style.display = '';
  btn.classList.toggle('active', s.on);
  btn.classList.toggle('rag-off', !s.on);
  const label = document.getElementById('rag-scope-label');
  if (label) label.textContent = scopeLabel(s);
  btn.title = s.on
    ? `Replies search ${s.scope ? 'this folder' : 'all your indexed folders'}. Click to change.`
    : 'Not searching your documents. Click to choose a folder.';
  const overflow = document.getElementById('overflow-rag-btn');
  if (overflow) overflow.classList.toggle('active', s.on);
}

async function loadFolders() {
  try {
    const res = await fetch(`${API}/api/personal/folders`, { credentials: 'same-origin' });
    if (res.ok) folders = await res.json();
  } catch (_) { /* keep last list */ }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function item(label, { value = null, checked = false, indent = 0, action = '', hint = '' } = {}) {
  const v = value === null ? '' : ` data-scope="${esc(value)}"`;
  const a = action ? ` data-action="${esc(action)}"` : '';
  const tip = action === 'refresh' ? ' title="Re-read this folder after its files change"' : '';
  return `<button type="button" class="rag-scope-item${checked ? ' checked' : ''}" style="padding-left:${12 + indent * 16}px"${v}${a}${tip}>`
    + `<span class="rag-scope-check">${checked ? '✓' : ''}</span><span class="rag-scope-name">${esc(label)}</span>`
    + (hint ? `<span class="rag-scope-hint">${esc(hint)}</span>` : '') + '</button>';
}

function menuHtml() {
  const s = state();
  let h = '<div class="rag-scope-title">Search my documents</div>';
  h += item('Off', { action: 'off', checked: !s.on });
  h += item('All indexed folders', { value: '', checked: s.on && !s.scope });
  for (const f of folders.indexed) {
    h += item(f.name, { value: f.path, checked: s.on && s.scope === f.path, hint: f.files ? `${f.files} files` : '' });
    for (const sub of f.subfolders || []) {
      h += item(sub.name, { value: sub.path, checked: s.on && s.scope === sub.path, indent: 1 });
    }
  }
  if (!folders.indexed.length) h += '<div class="rag-scope-empty">No folders indexed yet.</div>';
  h += '<div class="rag-scope-sep"></div>';
  const target = refreshTarget(s);
  if (target) h += item(`Refresh ${target.name}`, { action: 'refresh' });
  if (folders.available.length) {
    h += '<div class="rag-scope-title">Not indexed yet</div>';
    for (const f of folders.available) h += item(`Index ${f.name}`, { action: `add:${f.path}` });
  }
  h += `<form class="rag-scope-add"><input type="text" placeholder="Folder name, e.g. notes" aria-label="Folder to index">`
    + '<button type="submit">Index</button></form>';
  h += `<div class="rag-scope-status">${esc(busy)}</div>`;
  return h;
}

function refreshTarget(s) {
  if (!s.on) return null;
  if (!s.scope) return folders.indexed.length === 1 ? folders.indexed[0] : null;
  return folders.indexed.find((f) => s.scope === f.path || s.scope.startsWith(f.path + '/')) || null;
}

function position(btn) {
  const r = btn.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  menuEl.style.width = `${w}px`;
  menuEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  menuEl.style.bottom = `${window.innerHeight - r.top + 6}px`;
}

function draw(btn) {
  menuEl.innerHTML = menuHtml();
  position(btn);
}

async function indexFolder(path, btn) {
  busy = 'Indexing… this can take a minute.';
  draw(btn);
  try {
    const res = await fetch(`${API}/api/personal/add_directory`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: path }),
    });
    const data = await res.json().catch(() => ({}));
    busy = res.ok ? `Indexed ${data.indexed_count || 0} passages.` : `Could not index: ${data.detail || res.status}`;
    if (res.ok && data.directory) save(true, data.directory);
  } catch (e) {
    busy = `Could not index: ${e.message}`;
  }
  await loadFolders();
  render();
  if (menuEl) draw(btn);
}

async function refreshFolder(folder, btn) {
  busy = `Refreshing ${folder.name}…`;
  draw(btn);
  try {
    // Remove then re-add, so passages from edited or deleted files go away.
    await fetch(`${API}/api/personal/remove_directory?directory=${encodeURIComponent(folder.path)}`,
      { method: 'DELETE', credentials: 'same-origin' });
  } catch (_) { /* re-add below either way */ }
  const keep = state();
  await indexFolder(folder.path, btn);
  save(keep.on, keep.scope);
  render();
  if (menuEl) draw(btn);
}

function close() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  document.removeEventListener('mousedown', onOutside, true);
  const btn = document.getElementById('rag-indicator-btn');
  if (btn) btn.classList.remove('expanded');
}

function onOutside(e) {
  const btn = document.getElementById('rag-indicator-btn');
  if (menuEl && !menuEl.contains(e.target) && !(btn && btn.contains(e.target))) close();
}

async function open(btn) {
  if (menuEl) { close(); return; }
  busy = '';
  menuEl = document.createElement('div');
  menuEl.className = 'rag-scope-menu';
  menuEl.setAttribute('role', 'menu');
  document.body.appendChild(menuEl);
  btn.classList.add('expanded');
  draw(btn);
  document.addEventListener('mousedown', onOutside, true);
  menuEl.addEventListener('click', (e) => {
    const b = e.target.closest('button.rag-scope-item');
    if (!b) return;
    const action = b.dataset.action || '';
    if (action === 'off') { save(false, state().scope); render(); close(); return; }
    if (action === 'refresh') { const t = refreshTarget(state()); if (t) refreshFolder(t, btn); return; }
    if (action.startsWith('add:')) { indexFolder(action.slice(4), btn); return; }
    if (b.dataset.scope !== undefined) { save(true, b.dataset.scope); render(); close(); }
  });
  menuEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = menuEl.querySelector('.rag-scope-add input');
    const v = (input && input.value || '').trim();
    if (v) indexFolder(v, btn);
  });
  await loadFolders();
  if (menuEl) draw(btn);
  render();
}

export function initRagScope() {
  const btn = document.getElementById('rag-indicator-btn');
  if (!btn || btn.dataset.ragScopeInit) return;
  btn.dataset.ragScopeInit = '1';
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(btn); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuEl) close(); });
  const s = state();
  save(s.on, s.scope);  // persist the ON default the first time
  render();
  loadFolders().then(render);
}

window.RagScope = { render, getRagScope, initRagScope };
