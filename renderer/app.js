'use strict';
/* ============================================================
   周笺 · 便签窗口逻辑
   ============================================================ */

const $ = (s) => document.querySelector(s);
const API = window.zb;
window.__zb = { ready: true };   // 供自检探针识别

const MIN_W = 250;
const MIN_H = 170;
const SCALE_MIN = 0.7;
const SCALE_MAX = 2.0;

const state = {
  key: null,
  data: { entries: [], summary: '' },
  settings: {},
  unitSize: { w: 372, h: 588 },   // 缩放 100% 时的窗口尺寸
  imgHint: '',
  addingFor: null,                // 正在给哪个条目加子任务（用于渲染输入行）
  lite: false,                    // 只读内容态（桌面上就是一张纸）
  editHeight: 0                   // 进只读态之前的窗口高度，回来时还原
};

let pending = null;
let saveTimer = null;
let dragNode = null;

/* ─────────────────────────── 小工具 ─────────────────────────── */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 220);
  }, ms);
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 17l-5.25 2.75 1-5.85L3.5 9.75l5.9-.85z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  addsub: '<svg viewBox="0 0 24 24"><path d="M5 6h6M5 6v6"/><path d="M13 12h6M16 9v6"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V6"/><path d="M6 11l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v13"/><path d="M6 13l6 6 6-6"/></svg>'
};

/* ─────────────────────────── 存盘 ─────────────────────────── */

function snapshot() {
  return JSON.parse(JSON.stringify({ entries: state.data.entries, summary: state.data.summary }));
}

function touch(immediate = false) {
  pending = { key: state.key, data: snapshot() };
  clearTimeout(saveTimer);
  if (immediate) return flush();
  saveTimer = setTimeout(flush, 400);
}

async function flush() {
  clearTimeout(saveTimer);
  if (!pending) return;
  const p = pending;
  pending = null;
  try {
    await API.saveWeek(p.key, p.data);
    flashSaved();
  } catch (e) {
    toast('保存失败：' + (e && e.message || e));
  }
}

let flashTimer = null;
function flashSaved() {
  const bar = $('#bar');
  bar.style.opacity = '.45';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { bar.style.opacity = '1'; }, 160);
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

/** 一条记录贡献的「可勾选单元」：有子任务按子任务算，否则算自己 */
function leavesOf(e) {
  return (e.children && e.children.length) ? e.children : [e];
}

function countLeaves(entries) {
  let total = 0, done = 0;
  for (const e of entries) {
    const ls = leavesOf(e);
    total += ls.length;
    done += ls.filter(x => x.done).length;
  }
  return { total, done };
}

function render() {
  const list = $('#list');
  const entries = state.data.entries;
  const open = entries.filter(e => !e.done);
  const done = entries.filter(e => e.done);

  const { total, done: doneN } = countLeaves(entries);
  const rate = total ? Math.round(doneN / total * 100) : 0;
  $('#bar').style.width = rate + '%';
  const subCount = entries.reduce((n, e) => n + (e.children ? e.children.length : 0), 0);
  $('#progress').title = total
    ? `本周完成 ${doneN}/${total}（${rate}%）` + (subCount ? `　含 ${subCount} 条子任务` : '')
    : '本周暂无条目';

  const frag = document.createDocumentFragment();

  if (!total) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.innerHTML = `<b>本周还是空的</b>
      在下面输入框记一条，<kbd>Enter</kbd> 即存盘<br>
      条目右侧的 <kbd>＋</kbd> 可以加子任务<br>
      <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd> 翻周 · <kbd>Ctrl</kbd>+<kbd>R</kbd> 回顾`;
    frag.appendChild(div);
  } else {
    open.forEach(e => frag.appendChild(groupEl(e)));
    if (done.length) {
      const s = document.createElement('div');
      s.className = 'sect';
      const sp = document.createElement('span');
      sp.textContent = `已完成 ${doneN}/${total}`;
      s.appendChild(sp);
      frag.appendChild(s);
      done.forEach(e => frag.appendChild(groupEl(e)));
    }
  }

  list.innerHTML = '';
  list.appendChild(frag);
  syncRoHead(doneN, total);
}

/** 只读态表头：周次 + 完成进度 */
function syncRoHead(doneN, total) {
  const wk = $('#roWeek'), pg = $('#roProg');
  if (!wk) return;
  const d = state.data;
  wk.textContent = d && d.short
    ? `${d.short}　${d.range || ''}${d.isCurrent ? '　· 本周' : ''}`
    : '—';
  if (pg) {
    if (typeof doneN === 'number' && total) {
      const all = doneN === total;
      pg.textContent = `${doneN}/${total}`;
      pg.classList.toggle('all', all);
    } else {
      pg.textContent = '';
      pg.classList.remove('all');
    }
  }
}

/** 一条记录 + 它的子任务（如果有）*/
function groupEl(e) {
  const frag = document.createDocumentFragment();
  frag.appendChild(itemEl(e, null, e));

  const adding = state.addingFor === e.id;
  const kids = e.children || [];
  if (kids.length || adding) {
    const box = document.createElement('ul');
    box.className = 'subs';
    box.dataset.parent = e.id;
    kids.forEach(c => box.appendChild(itemEl(c, e, e)));
    if (adding) box.appendChild(subInputRow(e, box));
    bindSubsDrop(box, e);
    frag.appendChild(box);
  }
  return frag;
}

/** 定位某个节点所在的数组（顶层 entries 或某个父任务的 children） */
function containerOf(node) {
  const top = state.data.entries;
  for (const e of top) {
    if (e === node) return { arr: top, owner: e, isTop: true };
    if (e.children) {
      for (const c of e.children) if (c === node) return { arr: e.children, owner: e, isTop: false };
    }
  }
  return null;
}

/** 父任务完成度由子任务推导，避免出现「父勾了子没做完」的矛盾 */
function syncDone(entry) {
  if (entry && entry.children && entry.children.length) {
    entry.done = entry.children.every(c => c.done);
  }
}

function mkBtn(cls, title, svg, onClick) {
  const b = document.createElement('button');
  b.className = 'mini ' + cls;
  b.title = title;
  b.innerHTML = svg;
  b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
  return b;
}

function itemEl(node, parentEntry, rootEntry) {
  const isChild = !!parentEntry;
  const kids = node.children || [];

  const li = document.createElement('li');
  li.className = 'item' + (isChild ? ' child' : '') +
                 (node.done ? ' done' : '') + (node.star ? ' starred' : '');
  li.dataset.id = node.id;
  if (isChild) li.dataset.parent = parentEntry.id;
  li.draggable = true;

  /* 勾选：父任务点一下等于全选/全不选它的子任务 */
  const chk = document.createElement('button');
  chk.className = 'chk';
  chk.title = kids.length ? `全选 / 全不选 ${kids.length} 个子任务` : '标记完成';
  chk.innerHTML = ICON.check;
  chk.addEventListener('click', () => {
    const next = !node.done;
    if (kids.length) {
      const t = new Date().toISOString();
      kids.forEach(c => { c.done = next; c.updatedAt = t; });
    }
    node.done = next;
    syncDone(rootEntry);
    touch(true); render();
  });

  const txt = document.createElement('div');
  txt.className = 'txt';
  txt.textContent = node.text;
  txt.title = '双击编辑';
  txt.addEventListener('dblclick', () => beginEdit(li, txt, node, rootEntry));

  li.append(chk, txt);

  /* 父任务的子任务进度 */
  if (kids.length) {
    const doneKids = kids.filter(c => c.done).length;
    const prog = document.createElement('span');
    prog.className = 'prog' + (doneKids === kids.length ? ' all' : '');
    prog.textContent = `${doneKids}/${kids.length}`;
    prog.title = `子任务完成 ${doneKids}/${kids.length}`;
    li.appendChild(prog);
  }

  const acts = document.createElement('div');
  acts.className = 'acts';

  if (!isChild) {
    acts.appendChild(mkBtn('addsub', '加子任务', ICON.addsub, () => openSubInput(node.id)));
  } else {
    acts.appendChild(mkBtn('up', '升级为独立条目', ICON.up, () => promoteChild(node, parentEntry)));
  }

  acts.appendChild(mkBtn('star' + (node.star ? ' on' : ''), node.star ? '取消重点' : '标记重点', ICON.star, () => {
    node.star = !node.star;
    touch(true);
    li.classList.toggle('starred', node.star);
    acts.querySelector('.star').classList.toggle('on', node.star);
  }));

  if (!isChild) {
    const idx = state.data.entries.indexOf(node);
    if (idx > 0) {
      acts.appendChild(mkBtn('down', `降为「${truncate(state.data.entries[idx - 1].text, 10)}」的子任务`, ICON.down,
        () => demoteEntry(node, idx)));
    }
  }

  acts.appendChild(mkBtn('del', '删除', ICON.trash, () => removeNode(node, rootEntry)));

  li.appendChild(acts);
  bindDrag(li, node);
  return li;
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function removeNode(node, rootEntry) {
  const c = containerOf(node);
  if (!c) return;
  if (node.children && node.children.length) {
    if (!confirm(`「${truncate(node.text, 16)}」下面还有 ${node.children.length} 个子任务，一并删除？`)) return;
  }
  c.arr.splice(c.arr.indexOf(node), 1);
  syncDone(c.owner);
  touch(true); render();
}

/** 子任务升级成独立条目，排到原父任务后面 */
function promoteChild(child, parentEntry) {
  const arr = parentEntry.children;
  const i = arr.indexOf(child);
  if (i < 0) return;
  arr.splice(i, 1);
  child.children = child.children || [];
  const p = state.data.entries.indexOf(parentEntry);
  state.data.entries.splice(p + 1, 0, child);
  syncDone(parentEntry);
  touch(true); render();
  toast('已升级为独立条目');
}

/** 顶层条目降为上一个条目的子任务 */
function demoteEntry(entry, idx) {
  const owner = state.data.entries[idx - 1];
  if (!owner) return;
  owner.children = owner.children || [];
  owner.children.push(entry);
  state.data.entries.splice(idx, 1);
  syncDone(owner);
  touch(true); render();
  toast(`已归到「${truncate(owner.text, 10)}」下面`);
}

/* ─────────────────────── 新增子任务的输入行 ─────────────────────── */

function subInputRow(entry, box) {
  const row = document.createElement('li');
  row.className = 'subinput';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '加子任务…  Enter 连续添加 · Esc 收起';
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const v = input.value.trim();
      if (!v) { closeSubInput(); return; }
      entry.children = entry.children || [];
      entry.children.push({
        id: uid(), text: v, done: false, star: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      syncDone(entry);
      touch(true);
      render();
      focusSubInput();          // 保持打开，方便连续录
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeSubInput();
    }
  });
  input.addEventListener('blur', () => {
    // 失焦时若没输入内容就收起来
    if (!input.value.trim() && state.addingFor === entry.id) {
      setTimeout(() => { if (!input.value.trim()) closeSubInput(); }, 120);
    }
  });
  row.appendChild(input);
  return row;
}

function openSubInput(entryId) {
  state.addingFor = entryId;
  render();
  focusSubInput();
}

function closeSubInput() {
  state.addingFor = null;
  render();
}

function focusSubInput() {
  if (!state.addingFor) return;
  const el = document.querySelector(`.subs[data-parent="${state.addingFor}"] .subinput input`);
  if (el) el.focus();
}

function beginEdit(li, txt, node, rootEntry) {
  if (state.lite) return;          // 只读态下双击是"进入编辑"，不是改这一条
  li.draggable = false;
  txt.contentEditable = 'true';
  txt.focus();
  const r = document.createRange();
  r.selectNodeContents(txt);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(r);

  const finish = (commit) => {
    txt.contentEditable = 'false';
    li.draggable = true;
    const v = txt.innerText.replace(/\u00a0/g, ' ').trim();
    if (commit && v && v !== node.text) {
      node.text = v;
      node.updatedAt = new Date().toISOString();
      touch(true); render();
    } else if (commit && !v) {
      // 内容被清空 → 删掉这一条（有子任务时保留父任务，避免误删整串）
      if (!(node.children && node.children.length)) {
        const c = containerOf(node);
        if (c) { c.arr.splice(c.arr.indexOf(node), 1); syncDone(c.owner); }
      } else {
        node.text = '（未命名）';
      }
      touch(true); render();
    } else {
      txt.textContent = node.text;
    }
  };

  txt.addEventListener('blur', () => finish(true), { once: true });
  txt.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); txt.blur(); }
    if (ev.key === 'Escape') { ev.preventDefault(); txt.textContent = node.text; txt.blur(); }
  });
}

/* ─────────────────── 只读内容态（桌面上的一张纸） ─────────────────── */

/**
 * 默认只显示内容：没有标题栏、输入框、操作按钮，窗口高度自动贴合内容。
 * 双击便签 → 进入编辑态；编辑态按 Esc 或点标题栏的「眼睛」按钮收回。
 * settings.liteMode 是启动偏好（持久化），state.lite 是本次运行的实时状态。
 */
const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

async function setLite(on, opts) {
  const o = opts || {};
  const was = state.lite;
  state.lite = !!on;
  document.body.classList.toggle('lite', state.lite);
  try { await API.setLite(state.lite); } catch (_) {}

  if (state.lite) {
    if (panelOpen) togglePanel(false);
    const sw = $('#summaryWrap');
    if (sw) sw.hidden = true;
    render();
    if (!was && o.resize !== false) await fitLite();
  } else {
    if (was && o.resize !== false) await restoreEditHeight();
    const sw = $('#summaryWrap');
    if (sw) sw.hidden = !(state.data.summary || '').trim();
    await nextFrame();
    const inp = $('#input');
    if (inp) inp.focus();
  }
  return state.lite;
}

/** 收起时把窗口高度缩到刚好装下内容，像张真便签 */
async function fitLite() {
  const card = $('#card'), list = $('#list');
  const sCard = card.getAttribute('style') || '';
  const sList = list.getAttribute('style') || '';
  try {
    await nextFrame();
    if (!state.lite) return;
    const b = await API.getBounds();
    if (!state.editHeight) state.editHeight = b.height;

    // 注意：内容没溢出时 list.scrollHeight 返回的是元素自身高度，量不到真实内容，
    // 所以临时把高度约束放开，量完再还原。
    card.style.height = 'auto';
    list.style.flex = 'none';
    list.style.overflow = 'visible';
    await nextFrame();
    const contentH = card.offsetHeight;
    card.setAttribute('style', sCard);
    list.setAttribute('style', sList);
    await nextFrame();

    const need = Math.ceil(contentH + 7 * 2 + 8);   // body 上下 padding + 一点呼吸空间
    const maxH = Math.round((window.screen.availHeight || 900) * 0.72);
    let h = Math.max(118, Math.min(need, maxH));
    if (Math.abs(h - b.height) > 3) {
      await API.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
    }

    // 自纠正：还差一点就补上（行高/边距的小误差很难一次算准）
    await nextFrame();
    if (!state.lite) return;
    const over = list.scrollHeight - list.clientHeight;
    if (over > 2 && h < maxH) {
      h = Math.min(h + over + 6, maxH);
      await API.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
    }
  } catch (_) {
    try { card.setAttribute('style', sCard); list.setAttribute('style', sList); } catch (_) {}
  }
}

/** 回到编辑态时还原之前的窗口高度 */
async function restoreEditHeight() {
  try {
    if (!state.editHeight) return;
    const b = await API.getBounds();
    if (Math.abs(b.height - state.editHeight) < 3) return;
    await API.setBounds({ x: b.x, y: b.y, width: b.width, height: state.editHeight });
  } catch (_) {}
}

/* ─────────────────────────── 拖拽排序 ─────────────────────────── */

function clearMarks() {
  document.querySelectorAll('.item').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  document.querySelectorAll('.subs').forEach(el => el.classList.remove('drop-into'));
}

function findNode(id) {
  for (const e of state.data.entries) {
    if (e.id === id) return e;
    for (const c of (e.children || [])) if (c.id === id) return c;
  }
  return null;
}

/**
 * 拖拽规则：
 *  · 落在同一层级的条目上 → 在该层内换位
 *  · 落在别的层级的条目上 → 移入那一层
 *  · 落在某条目的子任务空白区 → 追加成它的子任务
 * 不允许把父任务塞进自己的子任务下面（会造成自引用）。
 */
function bindDrag(li, node) {
  li.addEventListener('dragstart', (e) => {
    if (li.querySelector('.txt[contenteditable="true"]')) { e.preventDefault(); return; }
    dragNode = node;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', node.id); } catch (_) {}
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearMarks();
    dragNode = null;
  });
  li.addEventListener('dragover', (e) => {
    if (!dragNode || dragNode === node) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearMarks();
    li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const after = li.classList.contains('drop-after');
    clearMarks();
    if (!dragNode || dragNode === node) return;
    if (dragNode === node) return;

    const src = containerOf(dragNode);
    const dst = containerOf(node);
    if (!src || !dst) return;
    // 目标层的所有者就是被拖的节点 → 会形成自引用，拒绝
    if (!dst.isTop && dst.owner === dragNode) return;

    src.arr.splice(src.arr.indexOf(dragNode), 1);
    let to = dst.arr.indexOf(node);
    if (to < 0) to = dst.arr.length;
    dst.arr.splice(after ? to + 1 : to, 0, dragNode);

    if (!src.isTop) syncDone(src.owner);
    syncDone(dst.owner);
    touch(true); render();
  });
}

/** 子任务区的空白处：接住拖进来的条目，追加成子任务 */
function bindSubsDrop(box, entry) {
  box.addEventListener('dragover', (e) => {
    if (!dragNode || dragNode === entry) return;
    if (e.target !== box) return;          // 只认空白区，条目上的交给 item 自己处理
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    box.classList.add('drop-into');
  });
  box.addEventListener('dragleave', (e) => {
    if (e.target === box) box.classList.remove('drop-into');
  });
  box.addEventListener('drop', (e) => {
    if (e.target !== box) return;
    e.preventDefault();
    e.stopPropagation();
    clearMarks();
    if (!dragNode || dragNode === entry) return;
    const src = containerOf(dragNode);
    if (!src) return;
    src.arr.splice(src.arr.indexOf(dragNode), 1);
    entry.children = entry.children || [];
    entry.children.push(dragNode);
    if (!src.isTop) syncDone(src.owner);
    syncDone(entry);
    touch(true); render();
  });
}

/* ─────────────────────────── 新增条目 ─────────────────────────── */

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
}

function addEntry() {
  const ta = $('#input');
  const text = ta.value.replace(/\s+$/, '').trim();
  if (!text) { ta.focus(); return; }
  const t = new Date().toISOString();
  state.data.entries.push({
    id: uid(), text, done: false, star: false, children: [],
    createdAt: t, updatedAt: t
  });
  ta.value = '';
  autoGrow(ta);
  touch(true);
  render();
  $('#list').scrollTop = $('#list').scrollHeight;
  ta.focus();
}

/* ─────────────────────────── 周切换 ─────────────────────────── */

async function loadWeek(key, { focusInput = false } = {}) {
  await flush();
  state.key = key;
  state.addingFor = null;
  const d = await API.describe(key);
  $('#weekTitle').textContent = `${d.year} 年第 ${d.week} 周`;
  const cur = await API.currentWeek();
  $('#weekRange').textContent = d.range + (key === cur ? '　· 本周' : '');
  $('#weekRange').classList.toggle('dim', key !== cur);

  const w = await API.loadWeek(key);
  state.data = {
    entries: w.entries || [], summary: w.summary || '',
    title: `${d.year} 年第 ${d.week} 周`, short: `第 ${d.week} 周`, range: d.range, isCurrent: key === cur
  };

  const sw = $('#summaryWrap');
  $('#summary').value = state.data.summary;
  sw.hidden = !state.data.summary.trim();

  render();
  if (focusInput) $('#input').focus();
}

/* ─────────────────────────── 布局缩放 ─────────────────────────── */

function applyScaleVar(s) {
  document.documentElement.style.setProperty('--scale', s);
}

async function setScale(s, persist = true) {
  s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(s * 100) / 100));
  const prev = state.settings.scale || 1;
  state.settings.scale = s;
  applyScaleVar(s);
  $('#scaleVal').textContent = Math.round(s * 100) + '%';

  if (state.settings.scaleWindow && Math.abs(s - prev) > 0.001) {
    const w = Math.round(state.unitSize.w * s);
    const h = Math.round(state.unitSize.h * s);
    const b = await API.getBounds();
    await API.setBounds({ x: b.x, y: b.y, width: w, height: h });
  }
  if (persist) await API.patchSettings({ scale: s });
}

/* ─────────────────────────── 八向缩放 ─────────────────────────── */

function bindGrips() {
  document.querySelectorAll('.grip').forEach((g) => {
    let drag = null;
    g.addEventListener('pointerdown', async (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const b = await API.getBounds();
      if (!b) return;
      drag = { dir: g.dataset.dir, sx: e.screenX, sy: e.screenY, b };
      try { g.setPointerCapture(e.pointerId); } catch (_) {}
    });
    g.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.screenX - drag.sx;
      const dy = e.screenY - drag.sy;
      const b = { x: drag.b.x, y: drag.b.y, width: drag.b.width, height: drag.b.height };
      const d = drag.dir;
      if (d.includes('e')) b.width = Math.max(MIN_W, drag.b.width + dx);
      if (d.includes('s')) b.height = Math.max(MIN_H, drag.b.height + dy);
      if (d.includes('w')) {
        const w = Math.max(MIN_W, drag.b.width - dx);
        b.x = drag.b.x + (drag.b.width - w);
        b.width = w;
      }
      if (d.includes('n')) {
        const h = Math.max(MIN_H, drag.b.height - dy);
        b.y = drag.b.y + (drag.b.height - h);
        b.height = h;
      }
      API.setBounds(b);
    });
    const end = async () => {
      if (!drag) return;
      drag = null;
      const b = await API.getBounds();
      const s = state.settings.scale || 1;
      if (b) state.unitSize = { w: b.width / s, h: b.height / s };
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
  });
}

/* ─────────────────────────── 设置面板 ─────────────────────────── */

let panelOpen = false;
function togglePanel(force) {
  panelOpen = force === undefined ? !panelOpen : !!force;
  $('#panel').hidden = !panelOpen;
}

async function syncSettingsUI() {
  const s = state.settings;
  $('#opacity').value = Math.round((s.opacity ?? 0.97) * 100);
  $('#opacityVal').textContent = Math.round((s.opacity ?? 0.97) * 100) + '%';
  $('#scaleVal').textContent = Math.round((s.scale || 1) * 100) + '%';
  $('#scaleWindow').checked = !!s.scaleWindow;
  $('#liteMode').checked = s.liteMode !== false;
  $('#topStrong').checked = s.topStrong !== false;
  $('#startMinimized').checked = !!s.startMinimized;
  $('#closeToTray').checked = !!s.closeToTray;
  $('#showTray').checked = !!s.showTray;
  document.querySelectorAll('#themePick button').forEach(b => b.classList.toggle('sel', b.dataset.t === s.theme));

  const info = await API.info();
  $('#dataPath').textContent = info.dataDir;
  $('#dataPath').title = info.dataDir;
  $('#verLine').textContent = `周笺 v${info.version} · ${info.packaged ? '正式版' : '开发模式'}`;

  // 启动项探测走异步，绝不阻塞界面初始化
  API.autostartState().then((st) => {
    const el = $('#autoStart');
    el.checked = !!st.enabled;
    el.disabled = !st.supported;
    el.title = st.supported ? ('启动项：' + (st.target || '')) : '当前平台不支持';
  }).catch(() => {
    const el = $('#autoStart');
    el.disabled = true;
    el.title = '无法读取启动项状态';
  });
}

function bindPanel() {
  $('#btnMore').addEventListener('click', async (e) => { e.stopPropagation(); togglePanel(); if (panelOpen) syncSettingsUI(); });
  document.addEventListener('click', (e) => {
    if (!panelOpen) return;
    if ($('#panel').contains(e.target) || $('#btnMore').contains(e.target)) return;
    togglePanel(false);
  });

  $('#segScale').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = Number(b.dataset.s);
    if (d === 0) await setScale(1);
    else await setScale((state.settings.scale || 1) + d * 0.05);
  });

  $('#opacity').addEventListener('input', async (e) => {
    const v = Number(e.target.value) / 100;
    $('#opacityVal').textContent = e.target.value + '%';
    state.settings.opacity = v;
    await API.setOpacity(v);
    await API.patchSettings({ opacity: v });
  });

  $('#themePick').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    await setTheme(b.dataset.t);
  });

  const bindToggle = (sel, key, after) => {
    $(sel).addEventListener('change', async (e) => {
      const v = e.target.checked;
      state.settings[key] = v;
      try {
        await API.patchSettings({ [key]: v });
      } catch (err) {
        e.target.checked = !v;
        state.settings[key] = !v;
        toast('设置失败：' + (err && err.message || err));
      }
      if (after) after(v);
    });
  };
  bindToggle('#scaleWindow', 'scaleWindow');
  bindToggle('#liteMode', 'liteMode');
  bindToggle('#topStrong', 'topStrong', () => API.reassertTop().then(refreshPinIcon).catch(() => {}));
  bindToggle('#startMinimized', 'startMinimized');
  bindToggle('#closeToTray', 'closeToTray');
  bindToggle('#showTray', 'showTray');
  bindToggle('#autoStart', 'autoStart', (v) => toast(v ? '已设置开机自启' : '已取消开机自启'));

  $('#btnOpenData').addEventListener('click', () => API.revealData());
  $('#btnRefloat').addEventListener('click', async () => {
    const r = await API.reassertTop();
    await refreshPinIcon();
    toast(r && r.actual ? '已重新置顶，当前生效' : '置顶指令已发出，但系统读回仍未生效');
  });
  $('#btnReview2').addEventListener('click', () => { togglePanel(false); API.openReview(state.key); });
  $('#btnReview').addEventListener('click', () => API.openReview(state.key));

  $('#btnExport').addEventListener('click', async () => {
    try {
      const r = await API.exportMd();
      toast('已导出 Markdown');
      API.revealFile(r.file);
    } catch (e) { toast('导出失败：' + e.message); }
  });

  $('#btnClear').addEventListener('click', async () => {
    if (!state.data.entries.length) { toast('本周本来就是空的'); return; }
    if (!confirm(`确定要清空「${$('#weekTitle').textContent}」的全部 ${state.data.entries.length} 条记录吗？\n（旧版本会保留在 data/weeks/.backup 里）`)) return;
    state.data.entries = [];
    state.data.summary = '';
    $('#summary').value = '';
    touch(true);
    render();
    toast('已清空本周');
  });

  $('#btnQuit').addEventListener('click', () => API.quit());
}

async function setTheme(t) {
  state.settings.theme = t;
  document.documentElement.dataset.theme = t;
  document.querySelectorAll('#themePick button').forEach(b => b.classList.toggle('sel', b.dataset.t === t));
  await API.patchSettings({ theme: t });
}

/* ─────────────────────────── 快捷键 ─────────────────────────── */

function bindKeys() {
  document.addEventListener('keydown', async (e) => {
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); API.openReview(state.key); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); await setScale((state.settings.scale || 1) + 0.05); return; }
    if (mod && e.key === '-') { e.preventDefault(); await setScale((state.settings.scale || 1) - 0.05); return; }
    if (mod && e.key === '0') { e.preventDefault(); await setScale(1); return; }
    if (mod && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      if (state.lite) await setLite(false);
      $('#input').focus();
      return;
    }

    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); await loadWeek(await API.shiftKey(state.key, -1), { focusInput: true }); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); await loadWeek(await API.shiftKey(state.key, 1), { focusInput: true }); return; }
    if (e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); await loadWeek(await API.currentWeek(), { focusInput: true }); return; }

    if (e.key === 'Escape') {
      if (panelOpen) togglePanel(false);
      else if (document.activeElement === $('#input')) $('#input').blur();
      else if (!state.lite) await setLite(true);          // 编辑态按 Esc → 收回只读态
    }
  });
}

/* ─────────────────────────── 启动 ─────────────────────────── */

/**
 * 刷新标题栏图钉状态。
 * 配置意图(want) 与系统实际状态(actual) 分开对待：
 *  - 两者一致 → 正常高亮 / 正常灰
 *  - want=true 但 actual=false（置顶被系统丢弃）→ 显示告警色，提示可点击重新置顶
 */
async function refreshPinIcon() {
  const want = !!state.settings.alwaysOnTop;
  let actual = want, level = '';
  try {
    const st = await API.topState();
    if (st) {
      if (typeof st.actual === 'boolean') actual = st.actual;
      if (st.level) level = st.level;
    }
  } catch (_) {}
  const el = $('#btnPin');
  el.classList.toggle('on', want);
  el.classList.toggle('warn', want && !actual);
  el.title = !want
    ? '窗口未置顶（点击置顶）'
    : (actual ? `窗口已置顶（点击取消）\n置顶层级：${level}` : '置顶被系统丢掉了，点一下重新置顶');
  const ts = $('#topState');
  if (ts) {
    ts.textContent = !want ? '已关闭' : (actual ? '生效中' : '未生效');
    ts.className = 'dim' + (want && !actual ? ' warnTxt' : '');
    ts.title = level ? '置顶层级：' + level : '';
  }
  return { want, actual };
}

/** 所有事件绑定必须在任何 await 之前完成，保证界面立刻可交互 */
function bindUI() {
  $('#btnAdd').addEventListener('click', addEntry);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addEntry(); }
  });
  $('#input').addEventListener('input', (e) => autoGrow(e.target));
  $('#prev').addEventListener('click', async () => loadWeek(await API.shiftKey(state.key, -1)));
  $('#next').addEventListener('click', async () => loadWeek(await API.shiftKey(state.key, 1)));
  $('#weekTitle').addEventListener('click', async () => loadWeek(await API.currentWeek()));
  $('#weekRange').addEventListener('click', async () => loadWeek(await API.currentWeek()));

  $('#btnSum').addEventListener('click', () => {
    const w = $('#summaryWrap');
    w.hidden = !w.hidden;
    if (!w.hidden) $('#summary').focus();
  });
  $('#summary').addEventListener('input', (e) => {
    state.data.summary = e.target.value;
    touch();
  });

  $('#btnPin').addEventListener('click', async () => {
    const { want, actual } = await refreshPinIcon();
    // 「配置说要置顶、实际却没置顶」时，点击应当视为重新置顶，而不是把它关掉
    const next = (want && !actual) ? true : !want;
    const r = await API.setAlwaysOnTop(next);
    state.settings.alwaysOnTop = next;
    const now = await refreshPinIcon();
    if (next) {
      toast(now.actual ? '已置顶' : '置顶指令已发出（若仍无效请看设置里的置顶状态）');
    } else {
      toast('已取消置顶');
    }
    return r;
  });

  $('#btnMin').addEventListener('click', () => API.minimize());
  $('#btnFold').addEventListener('click', () => setLite(true));
  // 只读态：双击便签任意位置进入编辑
  $('#list').addEventListener('dblclick', (e) => {
    if (!state.lite) return;
    if (e.target.closest('.subinput')) return;
    setLite(false);
  });
  $('#roHead').addEventListener('dblclick', () => { if (state.lite) setLite(false); });
  $('#btnClose').addEventListener('click', () => {
    if (state.settings.closeToTray !== false) { flush(); API.hide(); toast('已收起到托盘'); }
    else API.close();
  });
}

async function boot() {
  /* ① 先把交互接好 —— 不依赖任何 IPC / 磁盘 / 系统调用 */
  bindUI();
  bindGrips();
  bindPanel();
  bindKeys();

  window.addEventListener('blur', () => touch(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) touch(true); });

  API.onMainEvent(async (msg) => {
    if (!msg) return;
    if (msg.type === 'settings-changed') {
      state.settings = await API.settings();
      document.documentElement.dataset.theme = state.settings.theme || 'ink';
      applyScaleVar(state.settings.scale || 1);
      await refreshPinIcon();
      syncSettingsUI();
    }
    if (msg.type === 'week-saved' && msg.week === state.key && !pending) {
      const w = await API.loadWeek(state.key);
      state.data = { entries: w.entries || [], summary: w.summary || '' };
      if (document.activeElement !== $('#summary')) $('#summary').value = state.data.summary;
      render();
    }
    if (msg.type === 'lite-on') setLite(true);
    if (msg.type === 'lite-off') setLite(false);
  });
  API.onFocusWeek(async (wk) => { if (wk) await loadWeek(wk); });

  /* ② 再装配状态。任何一步失败都不能让界面变砖 */
  try {
    state.settings = (await API.settings()) || {};
  } catch (_) { state.settings = {}; }

  document.documentElement.dataset.theme = state.settings.theme || 'ink';
  applyScaleVar(state.settings.scale || 1);

  try {
    const b = await API.getBounds();
    const sc = state.settings.scale || 1;
    if (b) state.unitSize = { w: b.width / sc, h: b.height / sc };
  } catch (_) {}

  if (typeof state.settings.opacity === 'number') {
    API.setOpacity(state.settings.opacity).catch(() => {});
  }
  refreshPinIcon().catch(() => {});

  try {
    await loadWeek(await API.currentWeek());
  } catch (e) {
    toast('加载本周数据失败：' + (e && e.message || e));
  }

  // 默认进只读内容态：桌面上先是一张纸，双击才展开编辑
  if (state.settings.liteMode !== false) {
    await setLite(true);
  } else {
    await nextFrame();
    const inp = $('#input');
    if (inp) inp.focus();
  }

  syncSettingsUI().catch(() => {});
  $('#list').scrollTop = 0;
}

boot();

/* ============================================================
   自检钩子：只在内存里注入数据做渲染验证，绝不触发存盘
   ============================================================ */
window.__zbTest = {
  inject(entries) {
    clearTimeout(saveTimer);
    pending = null;                       // 掉丢弃未落盘的改动，避免把测试数据写进真实文件
    state.addingFor = null;
    state.data.entries = entries;
    render();
    const q = (s) => document.querySelectorAll(s);
    return {
      topItems: q('#list > .item').length,
      subs: q('#list .subs').length,
      childItems: q('#list .item.child').length,
      progs: Array.from(q('#list .prog')).map(el => el.textContent),
      addSubBtns: q('#list .mini.addsub').length,
      upBtns: q('#list .mini.up').length,
      downBtns: q('#list .mini.down').length,
      barWidth: document.querySelector('#bar').style.width
    };
  },
  clickSubAdd(index) {
    const btns = document.querySelectorAll('#list .mini.addsub');
    if (!btns[index]) return 'no-button';
    btns[index].click();
    const id = state.addingFor;
    const input = document.querySelector('.subs[data-parent="' + id + '"] .subinput input');
    return { addingFor: id, hasInput: !!input, focused: input === document.activeElement };
  },
  lite(on, resize) { return setLite(!!on, { resize: !!resize }); },
  liteState() {
    const disp = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display : 'missing';
    };
    return {
      lite: state.lite,
      bodyLite: document.body.classList.contains('lite'),
      titlebar: disp('#titlebar'),
      composer: disp('.composer'),
      panel: disp('#panel'),
      roHead: disp('#roHead'),
      chk: disp('#list .chk'),
      acts: disp('#list .acts'),
      prog: disp('#list .prog'),
      roWeek: (document.querySelector('#roWeek') || {}).textContent || '',
      roProg: (document.querySelector('#roProg') || {}).textContent || ''
    };
  },
  reload() { return loadWeek(state.key); }
};
