// Menús desplegables con el estilo de la app. Cada <select> de la página se esconde (sigue ahí: guarda el valor, el
// "required" y los eventos) y en su lugar sale un botón con el mismo aspecto que un campo. Al tocarlo se abre una hoja
// desde abajo con las opciones, con el visto en la elegida (y un buscador si son muchas). Al elegir se cambia el valor del
// <select> y se dispara su evento "change": el resto del código no se entera de la diferencia.
import { icon } from './icons.mjs';

const SEARCH_FROM = 10; // con más opciones que estas aparece el buscador
let dlg = null;
let current = null; // { select, btn }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function titleOf(select) {
  const label = select.id && document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
  return select.getAttribute('aria-label') || label?.textContent.trim() || 'Elegir';
}

function paintButton(select, btn) {
  const o = select.selectedOptions[0];
  btn.querySelector('.selbtn-t').textContent = o?.textContent ?? '';
  btn.classList.toggle('empty', !o || o.value === '');
  btn.disabled = select.disabled;
}

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'sheet sel-sheet';
  dlg.setAttribute('aria-labelledby', 'sel-title');
  dlg.innerHTML = `<header class="sheet-head"><h2 id="sel-title"></h2><button type="button" class="sheet-x" data-sel-close aria-label="Cerrar">${icon('x')}</button></header>
    <div class="sel-find" hidden><input type="search" id="sel-q" placeholder="Buscar…" autocomplete="off" aria-label="Buscar"></div>
    <div class="sheet-body sel-body"><ul class="sel-list" role="listbox"></ul></div>`;
  document.body.append(dlg);
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg || ev.target.closest('[data-sel-close]')) return dlg.close(); // el fondo oscuro también cierra
    const row = ev.target.closest('[data-i]');
    if (!row || row.disabled || !current) return;
    const { select, btn } = current;
    const changed = select.selectedIndex !== Number(row.dataset.i);
    select.selectedIndex = Number(row.dataset.i);
    paintButton(select, btn);
    dlg.close();
    btn.focus({ preventScroll: true });
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  dlg.addEventListener('input', (ev) => {
    if (ev.target.id !== 'sel-q') return;
    const q = norm(ev.target.value.trim());
    for (const li of dlg.querySelectorAll('.sel-list li')) li.hidden = Boolean(q) && !norm(li.textContent).includes(q);
  });
  dlg.addEventListener('close', () => { current = null; });
  return dlg;
}

function open(select, btn) {
  const d = ensureDialog();
  current = { select, btn };
  d.querySelector('#sel-title').textContent = titleOf(select);
  const opts = [...select.options];
  d.querySelector('.sel-find').hidden = opts.length <= SEARCH_FROM;
  d.querySelector('#sel-q').value = '';
  // Una opción con `hidden` es solo el texto de relleno del botón ("Otra moneda…"): no se ofrece como opción.
  d.querySelector('.sel-list').innerHTML = opts.map((o, i) => {
    if (o.hidden) return '';
    const on = i === select.selectedIndex;
    return `<li role="presentation"><button type="button" role="option" class="sel-opt${on ? ' on' : ''}" data-i="${i}" aria-selected="${on}" ${o.disabled ? 'disabled' : ''}>
      <span class="sel-opt-t">${esc(o.textContent)}</span>${on ? icon('check', 'sel-ck') : ''}</button></li>`;
  }).join('');
  d.showModal();
  d.querySelector('.sel-opt.on')?.scrollIntoView({ block: 'center' });
}

function enhance(select) {
  if (select.dataset.sel || select.closest('dialog.sel-sheet')) return;
  select.dataset.sel = '1';
  select.classList.add('sel-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const btn = document.createElement('button');
  btn.type = 'button';
  // Hereda las clases del <select> (por ejemplo "chip"): así un menú dentro de una fila de chips sigue viéndose como chip.
  btn.className = `selbtn ${[...select.classList].filter((c) => c !== 'sel-native').join(' ')}`.trim();
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-label', titleOf(select));
  btn.innerHTML = `<span class="selbtn-t"></span>${icon('chevron', 'selbtn-ch')}`;
  btn.addEventListener('click', () => open(select, btn));
  select.after(btn);
  paintButton(select, btn);
}

// Convierte los <select> que haya y los que aparezcan después (la pantalla se dibuja de nuevo a cada cambio).
export function initSelects() {
  const run = () => document.querySelectorAll('select:not([data-sel])').forEach(enhance);
  run();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; run(); });
  }).observe(document.body, { childList: true, subtree: true });
  // Si otro código cambia el valor de un <select> y avisa, el botón lo refleja.
  document.addEventListener('change', (ev) => {
    const s = ev.target;
    if (s instanceof HTMLSelectElement && s.dataset.sel) paintButton(s, s.nextElementSibling);
  });
}
