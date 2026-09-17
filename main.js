'use strict';
/**
 * 周笺 · 主进程
 * - 无边框半透明置顶便签窗口（自定义拖动 / 八向缩放）
 * - 系统托盘常驻
 * - 开机自启（注册表 HKCU\...\Run，兼容便携版）
 * - 全部内容按周存盘，关窗即存
 */

const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('./src/store');
const weekUtil = require('./src/week');

const ARGV = process.argv.slice(1);
const isAutostart = ARGV.includes('--autostart');
const isSelfTest = ARGV.includes('--selftest');
const isShots = ARGV.includes('--shots');
const isDiag = ARGV.includes('--diag');
const forceOpaque = ARGV.includes('--no-transparency');

/* 透明窗口在部分 Windows 机器上会因「硬件加速 × DWM 合成」冲突渲染出黑底/黑框
   （electron/electron#40515）。关闭硬件加速对某些机器有效，但在另一些机器上会让窗口
   变成白底甚至完全不可见——所以**默认关闭**，只作为「兼容模式」开关供需要的人手动尝试。
   设置项 disableGpu（默认关）可在设置面板切换；启动参数 --no-gpu / --gpu 强制覆盖。
   必须在 app ready 之前决定。 */
function wantNoGpu() {
  if (ARGV.includes('--gpu')) return false;
  if (ARGV.includes('--no-gpu')) return true;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(resolveDataDir(), 'settings.json'), 'utf8'));
    return raw.disableGpu === true;       // 默认关闭
  } catch (_) { return false; }
}
if (wantNoGpu()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

// 截图模式用临时数据目录，避免污染真实数据
if (isShots && !process.env.ZHOUJIAN_DATA_DIR) {
  const tmp = path.join(require('os').tmpdir(), 'zhoujian-shots');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.env.ZHOUJIAN_DATA_DIR = tmp;
}

let store = null;
let noteWin = null;
let noteLite = false;      // 便签是否处于「只读内容态」（由渲染层同步过来）
let reviewWin = null;
let tray = null;
let quitting = false;
let boundsTimer = null;

/* ------------------------------------------------------------------ 数据目录 */

/* 默认数据目录：~/.zhoujian/data
   （跨构建 / 跨盘统一，不再随 exe 所在目录漂移；可用 ZHOUJIAN_DATA_DIR 覆盖） */
const DATA_HOME = path.join(os.homedir(), '.zhoujian', 'data');

function hasWeekData(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'weeks')).some(f => /^\d{4}-W\d{2}\.json$/.test(f));
  } catch (_) { return false; }
}

/* 旧版本可能留下数据的位置（按优先级） */
function legacyDataDirs() {
  const list = [];
  try { list.push(path.join(app.getPath('userData'), 'data')); } catch (_) {}
  if (app.isPackaged) {
    if (process.env.PORTABLE_EXECUTABLE_DIR) list.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
    try { list.push(path.join(path.dirname(app.getPath('exe')), 'data')); } catch (_) {}
  } else {
    list.push(path.join(__dirname, 'data'));
  }
  return list;
}

/* 递归复制（不覆盖已存在的文件），用于一次性迁移 */
function copyDirInto(src, dst) {
  try {
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name), d = path.join(dst, name);
      if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDirInto(s, d); }
      else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
    }
  } catch (_) {}
}

function resolveDataDir() {
  if (process.env.ZHOUJIAN_DATA_DIR) return process.env.ZHOUJIAN_DATA_DIR;

  let root = DATA_HOME;
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
  } catch (_) {
    // 家目录不可写 → 退回 userData/data
    root = path.join(app.getPath('userData'), 'data');
    try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
    return root;
  }

  /* 首次运行（新位置还空着）→ 从旧位置迁移一次，避免升级后"便签不见了" */
  const empty = !fs.existsSync(path.join(root, 'settings.json')) && !hasWeekData(root);
  if (empty) {
    for (const legacy of legacyDataDirs()) {
      if (path.resolve(legacy) === path.resolve(root)) continue;
      if (hasWeekData(legacy)) {
        copyDirInto(legacy, root);
        console.log('[周笺] 已从旧数据目录迁移：' + legacy + ' → ' + root);
        break;
      }
    }
  }
  return root;
}

/* ------------------------------------------------------------------ 开机自启 */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = '周笺';
/** 改名前留下的启动项，首次运行顺手清掉，免得开机多启一个已经不存在的程序 */
const LEGACY_RUN_NAMES = ['周签'];

/** 便携版真实 exe 路径（electron-builder portable 会解压到临时目录，需用这个环境变量） */
function stableExe() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return process.env.PORTABLE_EXECUTABLE_FILE;
  if (app.isPackaged) return process.execPath;
  return null;
}

function autoStartEntry() {
  const exe = stableExe();
  if (!exe) {
    // 开发模式：用 electron.exe + 项目目录
    return { path: process.execPath, args: [__dirname, '--autostart'] };
  }
  return { path: exe, args: ['--autostart'] };
}

/** 写进注册表的命令行（路径一律加引号） */
function autoStartCommand() {
  const { path: exePath, args } = autoStartEntry();
  return [`"${exePath}"`].concat(args.map(a => (/\s/.test(a) ? `"${a}"` : a))).join(' ');
}

function regExe() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
}

/** 清掉改名前遗留的启动项（reg.exe 不可用时静默跳过） */
function cleanupLegacyAutostart() {
  if (!regUsable) return;
  for (const n of LEGACY_RUN_NAMES) {
    try {
      execFileSync(regExe(), ['delete', RUN_KEY, '/v', n, '/f'],
        { windowsHide: true, timeout: 4000 });
    } catch (_) { /* 本来就没有，正常 */ }
  }
}

/**
 * 直查注册表读回启动项。
 * reg.exe 可能被安全软件 / 企业策略拦掉，所以：
 *  - 只试一次，失败即标记不可用，之后不再重复拉起进程
 *  - 用 available 字段区分「明确不存在」和「查不了」
 */
let regUsable = true;
let regError = null;

function readRunEntry() {
  if (!regUsable) return { available: false, exists: null, value: '', error: regError };
  try {
    const out = execFileSync(regExe(), ['query', RUN_KEY, '/v', RUN_NAME],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    const m = /REG_SZ\s+(.+?)\s*$/m.exec(out);
    return { available: true, exists: true, value: m ? m[1].trim() : '' };
  } catch (e) {
    if (e && e.status === 1) return { available: true, exists: false, value: '' };  // 明确不存在
    regUsable = false;
    regError = String(e && e.message || e);
    return { available: false, exists: null, value: '', error: regError };
  }
}

/** 用 Electron 原生 API 读回（部分环境下不可靠，仅作参考） */
function readRunViaElectron() {
  const { path: exePath, args } = autoStartEntry();
  let open = false;
  try { open = app.getLoginItemSettings({ path: exePath, args }).openAtLogin; } catch (_) {}
  return { available: false, exists: open, value: '', unreliable: true };
}

/** 返回 { available, exists, value }；available=false 表示无法可信校验 */
function readAutoStart() {
  const r = readRunEntry();
  if (r.available) return r;
  return readRunViaElectron();
}

/**
 * 开关开机自启。
 * 主路径用 Electron 原生 setLoginItemSettings（不依赖外部程序，
 * 不受命令行黑名单影响）；再用注册表直查做校验。
 * 注意：reg.exe 被拦时 Electron 的读回并不可靠，
 * 这种情况标记 verified=false 而不是报失败，避免误报。
 */
function applyAutoStart(enabled) {
  const { path: exePath, args } = autoStartEntry();
  const cmd = autoStartCommand();
  const want = !!enabled;

  let nativeErr = null;
  try {
    app.setLoginItemSettings({ openAtLogin: want, path: exePath, args, name: RUN_NAME });
    if (!want) cleanupLegacyAutostart();      // 关掉时把旧名字的启动项一并清掉
  } catch (e) {
    nativeErr = String(e && e.message || e);
  }

  const reg = readRunEntry();
  let ok, enabledNow, actual = '', source;
  if (reg.available) {
    source = 'registry';
    enabledNow = reg.exists;
    actual = reg.value || '';
    ok = !nativeErr && reg.exists === want;
  } else {
    // 无法可信校验：不报失败，交由界面提示"已写入但未能校验"
    source = 'unverified';
    enabledNow = want;
    ok = !nativeErr;
  }

  return {
    ok,
    enabled: enabledNow,
    verified: reg.available,
    target: cmd,
    actual,
    source,
    error: ok ? null : (nativeErr ||
      (want ? '写入后注册表读回为空，可能被安全软件或组策略拦截' : '删除后注册表项依然存在'))
  };
}

/* ------------------------------------------------------------------ 便签窗口 */

function noteWindowOptions() {
  const s = store.getSettings();
  const b = s.bounds || {};
  // 截图模式用不透明窗口：透明窗口在本环境不参与合成，capturePage 会拿到旧帧
  const transparent = !!s.transparency && !forceOpaque && !isShots;
  const opt = {
    width: Math.max(260, b.width || 372),
    height: Math.max(180, b.height || 588),
    minWidth: 320,
    minHeight: 170,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#1b1e24',
    hasShadow: !transparent,
    thickFrame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,        // 任务栏不显示：只留托盘图标 + 桌面便签（托盘点击可唤出）
    show: false,
    alwaysOnTop: !!s.alwaysOnTop,
    title: '周笺',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  };
  if (typeof b.x === 'number' && typeof b.y === 'number') { opt.x = b.x; opt.y = b.y; }
  const icon = iconPath();
  if (icon) opt.icon = icon;
  return opt;
}

function iconPath() {
  const p = path.join(__dirname, 'assets', 'icon.png');
  return fs.existsSync(p) ? p : null;
}

function clampToScreen(bounds) {
  try {
    const displays = screen.getAllDisplays();
    const visible = displays.some(d => {
      const wa = d.workArea;
      return bounds.x + 40 < wa.x + wa.width && bounds.x + bounds.width - 40 > wa.x &&
             bounds.y + 20 < wa.y + wa.height && bounds.y + 30 > wa.y;
    });
    if (!visible) {
      const wa = screen.getPrimaryDisplay().workArea;
      bounds.x = wa.x + wa.width - bounds.width - 24;
      bounds.y = wa.y + 24;
    }
  } catch (_) {}
  return bounds;
}

function createNoteWindow() {
  if (noteWin && !noteWin.isDestroyed()) { noteWin.show(); noteWin.focus(); return noteWin; }
  const opt = noteWindowOptions();
  noteWin = new BrowserWindow(opt);

  if (opt.x === undefined) {
    const wa = screen.getPrimaryDisplay().workArea;
    const b = clampToScreen({ x: wa.x + wa.width - opt.width - 24, y: wa.y + 24, width: opt.width, height: opt.height });
    noteWin.setBounds(b);
  }

  noteWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  /* 置顶：窗口隐藏时的置顶调用会被系统丢掉，
     所以统一放到「窗口真正显示出来之后」再打，并持续兜底。 */
  const wantTop = () => !!(store && store.getSettings().alwaysOnTop);
  noteWin.once('ready-to-show', () => {
    const s = store.getSettings();
    if (!(isAutostart && s.startMinimized)) noteWin.show();
    noteWin.webContents.send('boot', { autostart: isAutostart });
    if (wantTop()) {
      enforceTop(noteWin, 'ready-to-show', { force: true });
      startTopWatchdog(noteWin);
    }
  });
  noteWin.on('show', () => { if (wantTop()) enforceTop(noteWin, 'show', { force: true }); });
  noteWin.on('focus', () => { if (wantTop()) enforceTop(noteWin, 'focus', { force: true }); });
  noteWin.on('blur', () => {
    if (!wantTop()) return;
    // 失焦正是"被别的窗口（含置顶窗口）盖住"的时候，连着重申几次抢回来
    [0, 300, 900, 1800].forEach(ms =>
      setTimeout(() => enforceTop(noteWin, 'blur+' + ms, { force: true }), ms));
  });

  noteWin.on('close', (e) => {
    persistBounds();
    if (!quitting && store.getSettings().closeToTray) {
      e.preventDefault();
      noteWin.hide();
    }
  });

  noteWin.on('closed', () => { stopTopWatchdog(); noteWin = null; });

  const onGeom = () => schedulePersistBounds();
  noteWin.on('move', onGeom);
  noteWin.on('resize', onGeom);

  noteWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return noteWin;
}

function schedulePersistBounds() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistBounds, 400);
}

function persistBounds() {
  if (!noteWin || noteWin.isDestroyed()) return;
  try {
    const b = noteWin.getBounds();
    const s = store.getSettings();
    const next = { x: b.x, y: b.y, width: b.width };
    // 只读态的高度是「贴合内容」自动算出来的，别让它盖掉编辑态记住的高度
    if (!noteLite) next.height = b.height;
    store.patchSettings({ bounds: Object.assign({}, s.bounds, next) });
  } catch (_) {}
}

function showNote() {
  const w = createNoteWindow();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/* ------------------------------------------------------------------ 回顾窗口 */

function createReviewWindow(focusWeek) {
  if (reviewWin && !reviewWin.isDestroyed()) {
    reviewWin.show(); reviewWin.focus();
    if (focusWeek) reviewWin.webContents.send('focus-week', focusWeek);
    return reviewWin;
  }
  reviewWin = new BrowserWindow({
    width: 1060, height: 720, minWidth: 820, minHeight: 520,
    frame: false, transparent: false, backgroundColor: '#14161b',
    resizable: true, show: false, title: '周笺 · 回顾', skipTaskbar: true,
    icon: iconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  reviewWin.loadFile(path.join(__dirname, 'renderer', 'review.html'));
  reviewWin.once('ready-to-show', () => {
    reviewWin.show();
    if (focusWeek) reviewWin.webContents.send('focus-week', focusWeek);
  });
  reviewWin.on('closed', () => { reviewWin = null; });
  return reviewWin;
}

/* ------------------------------------------------------------------ 托盘 */

function trayImage() {
  const p = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  const ip = iconPath();
  if (ip) {
    const img = nativeImage.createFromPath(ip).resize({ width: 16, height: 16 });
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  const s = store.getSettings();
  return Menu.buildFromTemplate([
    { label: '显示便签', click: () => showNote() },
    {
      label: noteLite ? '展开编辑（双击便签同效）' : '收起为只读',
      click: () => {
        showNote();
        noteLite = !noteLite;
        notifyNote({ type: noteLite ? 'lite-on' : 'lite-off' });
      }
    },
    { label: '隐藏便签', click: () => noteWin && !noteWin.isDestroyed() && noteWin.hide() },
    { type: 'separator' },
    { label: '打开回顾面板…', click: () => createReviewWindow(weekUtil.weekKey()) },
    { label: '打开数据目录', click: () => shell.openPath(store.root) },
    { type: 'separator' },
    {
      label: '窗口置顶', type: 'checkbox', checked: !!s.alwaysOnTop,
      click: (mi) => setAlwaysOnTop(mi.checked)
    },
    {
      label: '立即重新置顶', enabled: !!s.alwaysOnTop,
      click: () => {
        enforceTop(noteWin, 'tray-manual', { force: true });
        showNote();
      }
    },
    {
      label: '开机自动启动', type: 'checkbox', checked: !!s.autoStart,
      click: (mi) => {
        const r = applyAutoStart(mi.checked);
        store.patchSettings({ autoStart: mi.checked && r.ok });
        if (!r.ok) {
          dialog.showErrorBox('开机自启设置失败',
            (r.error || '未知原因') + '\n\n目标：' + (r.target || ''));
        }
        refreshTray();
        notifyNote({ type: 'settings-changed' });
      }
    },
    { type: 'separator' },
    { label: '退出周笺', click: () => { quitting = true; app.quit(); } }
  ]);
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
  const s = store.getSettings();
  tray.setToolTip(`周笺 · ${weekUtil.describe(weekUtil.weekKey()).title}`);
  if (!s.showTray) { tray.destroy(); tray = null; }
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  if (!store.getSettings().showTray) return null;
  try {
    tray = new Tray(trayImage());
    tray.setToolTip('周笺');
    refreshTray();
    tray.on('click', () => showNote());
    tray.on('double-click', () => showNote());
  } catch (_) { tray = null; }
  return tray;
}

/**
 * 开关置顶（唯一入口）。
 * 注意：不要在这里直接单次调用 setAlwaysOnTop，一律走 applyTop 的「先摘后挂」，
 * 否则在透明窗口上可能被系统丢弃、出现"点了没反应"。
 */
function setAlwaysOnTop(v) {
  const on = !!v;
  store.patchSettings({ alwaysOnTop: on });
  let actual = null;
  if (noteWin && !noteWin.isDestroyed()) {
    if (on) {
      enforceTop(noteWin, 'toggle-on', { force: true });
      startTopWatchdog(noteWin);
      actual = noteWin.isAlwaysOnTop();
    } else {
      stopTopWatchdog();
      actual = applyTop(noteWin, false);
    }
  }
  refreshTray();
  notifyNote({ type: 'settings-changed' });
  return { want: on, actual };
}

function notifyNote(msg) {
  if (noteWin && !noteWin.isDestroyed()) noteWin.webContents.send('main:event', msg);
  if (reviewWin && !reviewWin.isDestroyed()) reviewWin.webContents.send('main:event', msg);
}

/* ------------------------------------------------------------------ 置顶守护 */

/**
 * Windows 实测（Electron 44 / Windows 10 19045）：
 *   只有带高层级的 setAlwaysOnTop(true, '<level>') 真正生效。
 *   这些全部无效：setAlwaysOnTop(true) / (true,'floating') / 先 false 再 true /
 *   只靠构造参数 alwaysOnTop:true —— isAlwaysOnTop() 读回 false，
 *   桌面截图也确认窗口确实没在最上层。
 * 不同机器 / Electron 版本可用的层级不一定一样，所以启动时把候选层级全试一遍，
 * 记住「最弱的可用层级」和「最强的可用层级」，再按设置选一个用。
 */
const TOP_LEVEL_CANDIDATES = [
  null,             // 不带 level（系统默认）
  'floating',
  'torn-off-menu',
  'modal-panel',
  'main-menu',
  'status',
  'pop-up-menu',
  'screen-saver'    // 最高，能压过其他置顶窗口
];

let topLevels = null;      // 探测结果：可用的层级数组（从弱到强）
let topTimer = null;
let lastTopAssert = null;

function setTop(win, level) {
  if (level) win.setAlwaysOnTop(true, level);
  else win.setAlwaysOnTop(true);
}

/** 把候选层级挨个试一遍，记录哪些真的能生效 */
function probeTopLevels(win) {
  const ok = [];
  for (const lv of TOP_LEVEL_CANDIDATES) {
    try {
      win.setAlwaysOnTop(false);
      setTop(win, lv);
      if (win.isAlwaysOnTop()) ok.push(lv);
    } catch (_) {}
  }
  topLevels = ok;
  lastTopAssert = {
    at: new Date().toISOString(), reason: 'probe', ok: ok.length > 0,
    levels: ok.map(v => v === null ? '默认' : v)
  };
  return ok;
}

/** 当前该用哪个层级：topStrong 决定用最强的还是最弱的可用层级 */
function currentTopLevel() {
  const list = topLevels || [];
  if (!list.length) return 'screen-saver';            // 一个都没探到，仍然把最强指令发出去
  const strong = store ? store.getSettings().topStrong !== false : true;
  return strong ? list[list.length - 1] : list[0];
}

/** 稳定版置顶：按选定的层级打，返回操作后的真实状态 */
function applyTop(win, on) {
  if (!win || win.isDestroyed()) return false;
  try {
    if (!on) {
      win.setAlwaysOnTop(false);
      return win.isAlwaysOnTop();
    }
    if (!topLevels) probeTopLevels(win);
    win.setAlwaysOnTop(false);
    setTop(win, currentTopLevel());
    if (!win.isAlwaysOnTop()) probeTopLevels(win);   // 缓存失效了（换了机器/显示器）就重探
    return win.isAlwaysOnTop();
  } catch (e) {
    lastTopAssert = { at: new Date().toISOString(), ok: false, error: String(e && e.message || e) };
    return false;
  }
}

/**
 * 确保窗口处于置顶。
 * opts.force = true 时无论读回如何都重新打一次（用于"被别的置顶窗口压住"后抢回最上层）；
 * 窗口还没显示出来时按 400ms 重试，最多 6 次；
 * 打完之后读回仍是 false 时，按 250ms 再补打，最多 3 次。
 */
function enforceTop(win, reason, opts) {
  const o = opts || {};
  if (!win || win.isDestroyed()) return null;
  if (!store || !store.getSettings().alwaysOnTop) return null;

  if (!win.isVisible()) {
    const n = o.attempt || 0;
    if (n < 6) setTimeout(() => enforceTop(win, reason, { force: o.force, attempt: n + 1 }), 400);
    return null;
  }
  if (!o.force && win.isAlwaysOnTop()) {
    lastTopAssert = { at: new Date().toISOString(), reason, ok: true, skipped: true, level: currentTopLevel() };
    return true;
  }
  const ok = applyTop(win, true);
  // 强制重申时再补一次 moveTop：同级置顶窗口之间"谁最后激活谁在上"，
  // 这能把便签重新提到那一层的最上面。
  if (ok && o.force) { try { win.moveTop(); } catch (_) {} }
  lastTopAssert = { at: new Date().toISOString(), reason, ok, retry: o.retry || 0, level: currentTopLevel() };
  if (!ok) {
    const n = o.retry || 0;
    if (n < 3) setTimeout(() => enforceTop(win, reason + '+retry', { force: true, retry: n + 1 }), 250);
  }
  return ok;
}

/**
 * 守护定时器：
 *  · 每 1.5 秒检查一次，读回 false 立刻补打；
 *  · 每 3 秒强制重打一次 + moveTop —— 同级置顶窗口之间"谁最后激活谁在上"，
 *    定期重打可以把便签重新提到最上层。实测：对手无论用低档还是同档置顶，
 *    重申都能把最上层抢回来，这就是"被别的置顶窗口压住"的解药。
 */
function startTopWatchdog(win) {
  stopTopWatchdog();
  let ticks = 0;
  const loop = () => {
    if (!win || win.isDestroyed()) return;
    if (!store.getSettings().alwaysOnTop) { stopTopWatchdog(); return; }
    ticks++;
    enforceTop(win, 'watchdog#' + ticks, { force: ticks % 2 === 0 });
    topTimer = setTimeout(loop, 1500);
    if (topTimer.unref) topTimer.unref();
  };
  topTimer = setTimeout(loop, 400);
  if (topTimer.unref) topTimer.unref();
}

function stopTopWatchdog() {
  if (topTimer) { clearTimeout(topTimer); topTimer = null; }
}

/* ------------------------------------------------------------------ IPC */

function registerIPC() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    dataDir: store.root,
    packaged: app.isPackaged,
    platform: process.platform
  }));

  ipcMain.handle('store:settings', () => store.getSettings());
  ipcMain.handle('store:patchSettings', (e, patch) => {
    const next = store.patchSettings(patch || {});
    if (patch && typeof patch.autoStart === 'boolean') {
      const r = applyAutoStart(patch.autoStart);
      if (!r.ok) { store.patchSettings({ autoStart: false }); throw new Error(r.error); }
    }
    if (patch && typeof patch.showTray === 'boolean') {
      if (patch.showTray) createTray(); else if (tray) { tray.destroy(); tray = null; }
    }
    if (patch && typeof patch.alwaysOnTop === 'boolean') setAlwaysOnTop(patch.alwaysOnTop);
    refreshTray();
    notifyNote({ type: 'settings-changed' });
    return next;
  });

  ipcMain.handle('store:loadWeek', (e, key) => store.loadWeek(key));
  ipcMain.handle('store:saveWeek', (e, key, data) => store.saveWeek(key, data));
  ipcMain.handle('store:listWeeks', () => store.listWeeks());
  ipcMain.handle('store:search', (e, q) => store.search(q));
  ipcMain.handle('store:stats', () => store.stats());
  ipcMain.handle('store:deleteWeek', (e, key) => store.deleteWeek(key));
  ipcMain.handle('store:exportMd', () => store.exportMarkdown());
  ipcMain.handle('store:weekMarkdown', (e, key) => store.weekToMarkdown(key));
  ipcMain.handle('store:revealData', () => shell.openPath(store.root));
  ipcMain.handle('store:revealFile', (e, p) => shell.showItemInFolder(p));

  ipcMain.handle('util:describe', (e, key) => weekUtil.describe(key));
  ipcMain.handle('util:currentWeek', () => weekUtil.weekKey());
  ipcMain.handle('util:shiftKey', (e, key, delta) => weekUtil.shiftKey(key, delta));
  ipcMain.handle('util:recentKeys', (e, n) => {
    const cur = weekUtil.weekKey();
    const out = [];
    for (let i = 0; i < (n || 12); i++) out.push(weekUtil.shiftKey(cur, -i));
    return out;
  });

  ipcMain.handle('win:getBounds', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    return w ? w.getBounds() : null;
  });
  ipcMain.handle('win:setLite', (e, v) => {
    noteLite = !!v;
    refreshTray();
    return noteLite;
  });
  ipcMain.handle('win:setBounds', (e, b) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || !b) return null;
    const next = {
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.max(250, Math.round(b.width)), height: Math.max(170, Math.round(b.height))
    };
    w.setBounds(next);
    return w.getBounds();
  });
  ipcMain.handle('win:setOpacity', (e, v) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) { try { w.setOpacity(Math.min(1, Math.max(0.2, Number(v) || 1))); } catch (_) {} }
    return true;
  });
  ipcMain.handle('win:setAlwaysOnTop', (e, v) => setAlwaysOnTop(v));
  ipcMain.handle('win:minimize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.minimize();
  });
  ipcMain.handle('win:hide', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.hide();
  });
  ipcMain.handle('win:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.close();
  });
  ipcMain.handle('win:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('win:isOnTop', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    return w ? w.isAlwaysOnTop() : false;
  });
  ipcMain.handle('win:toggleMaximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('win:isMaximized', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    return w ? w.isMaximized() : false;
  });
  ipcMain.handle('win:focus', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) { w.show(); w.focus(); }
  });
  ipcMain.handle('clipboard:write', (e, text) => {
    const { clipboard } = require('electron');
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  });
  ipcMain.handle('win:setResizable', (e, v) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setResizable(!!v);
  });

  ipcMain.handle('app:openReview', (e, week) => { createReviewWindow(week); return true; });
  ipcMain.handle('app:broadcast', (e, msg) => { notifyNote(msg); return true; });
  ipcMain.handle('app:openExternal', (e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
  ipcMain.handle('app:autostartState', () => {
    const entry = readAutoStart();
    const cmd = autoStartCommand();
    return {
      enabled: !!entry.exists,
      target: cmd,
      actual: entry.value || '',
      matched: (entry.value || '') === cmd,
      source: readRunEntry().available ? 'registry' : 'electron',
      supported: process.platform === 'win32'
    };
  });
  ipcMain.handle('app:setAutostart', (e, v) => {
    const r = applyAutoStart(!!v);
    store.patchSettings({ autoStart: !!r.enabled });
    refreshTray(); notifyNote({ type: 'settings-changed' });
    return r;
  });
  ipcMain.handle('app:diag', () => ({
    alwaysOnTop: noteWin && !noteWin.isDestroyed() ? noteWin.isAlwaysOnTop() : null,
    visible: noteWin && !noteWin.isDestroyed() ? noteWin.isVisible() : null,
    setting: store.getSettings().alwaysOnTop,
    lastAssert: lastTopAssert,
    bounds: noteWin && !noteWin.isDestroyed() ? noteWin.getBounds() : null,
    dataDir: store.root,
    autostart: readAutoStart(),
    autostartTarget: autoStartCommand(),
    regUsable
  }));
  ipcMain.handle('app:reassertTop', () => {
    enforceTop(noteWin, 'manual', { force: true });
    return { last: lastTopAssert, actual: noteWin && !noteWin.isDestroyed() ? noteWin.isAlwaysOnTop() : null };
  });
  ipcMain.handle('app:topState', () => ({
    want: !!(store && store.getSettings().alwaysOnTop),
    actual: noteWin && !noteWin.isDestroyed() ? noteWin.isAlwaysOnTop() : null,
    visible: noteWin && !noteWin.isDestroyed() ? noteWin.isVisible() : null,
    level: topLevels === null ? '未探测'
      : (currentTopLevel() || '默认') + '（可用：' + (topLevels.map(v => v === null ? '默认' : v).join(', ') || '无') + '）',
    last: lastTopAssert
  }));
}

/* ------------------------------------------------------------------ 生命周期 */

/* 自检 / 截图 / 诊断模式要能跟正常运行中的实例并存，所以跳过单实例锁 */
const isBatchMode = isSelfTest || isShots || isDiag;
const gotLock = isBatchMode ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  if (!isBatchMode) app.on('second-instance', () => { showNote(); });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.boss.zhoujian');

    store = new Store(resolveDataDir());
    registerIPC();

    if (isSelfTest) {
      const { runSelfTest } = require('./src/selftest');
      const report = await runSelfTest({
        app, store, weekUtil, createNoteWindow, applyAutoStart, createTray, iconPath,
        readRunEntry, readAutoStart, setAlwaysOnTop, getTopLevels: () => topLevels
      });
      const out = path.join(__dirname, 'selftest-report.json');
      try { fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8'); } catch (_) {}
      app.exit(report.pass ? 0 : 1);
      return;
    }

    if (isShots) {
      const { runShots } = require('./src/shots');
      await runShots({ app, store, weekUtil, createNoteWindow, createReviewWindow });
      return;
    }

    if (isDiag) {
      const report = { at: new Date().toISOString(), electron: process.versions.electron, stages: [] };
      const win = createNoteWindow();
      await new Promise(res => win.webContents.once('did-finish-load', res));
      report.stages.push(['建窗后(隐藏)', win.isAlwaysOnTop(), win.isVisible()]);
      await new Promise(r => setTimeout(r, 1500));
      win.show();
      await new Promise(r => setTimeout(r, 400));
      report.stages.push(['show 后', win.isAlwaysOnTop(), win.isVisible()]);
      await new Promise(r => setTimeout(r, 1200));
      report.stages.push(['show 后 1.6s（等 first-show 守护）', win.isAlwaysOnTop(), win.isVisible()]);

      // 走真实业务路径重申一次
      enforceTop(win, 'diag-manual', { force: true });
      await new Promise(r => setTimeout(r, 500));
      report.stages.push(['reassert 后', win.isAlwaysOnTop(), win.isVisible()]);
      report.reassert = lastTopAssert;

      report.setting = store.getSettings().alwaysOnTop;
      report.topLevels = topLevels === null ? null : topLevels.map(v => v === null ? '默认' : v);
      report.topLevelUsed = currentTopLevel() || '默认';
      report.lastTopAssert = lastTopAssert;
      report.dom = await win.webContents.executeJavaScript(`(() => ({
        pinIconOn: document.querySelector('#btnPin').classList.contains('on'),
        pinTitle: document.querySelector('#btnPin').title,
        title: (document.querySelector('#weekTitle')||{}).textContent
      }))()`).catch(e => ({ error: String(e.message) }));
      report.dataDir = store.root;
      report.autostart = readAutoStart();
      fs.writeFileSync(path.join(__dirname, 'diag-report.json'), JSON.stringify(report, null, 2), 'utf8');
      win.destroy();
      app.exit(0);
      return;
    }

    createNoteWindow();
    createTray();

    // 首次运行：延后同步系统启动项状态，不拖慢启动
    if (!store.getSettings().firstRunDone) {
      setTimeout(() => {
        try {
          cleanupLegacyAutostart();
          const r = readAutoStart();
          // 只有在能可信校验时才回写，避免 reg.exe 不可用时把状态写错
          if (r.available) store.patchSettings({ autoStart: !!r.exists, firstRunDone: true });
          else store.patchSettings({ firstRunDone: true });
          refreshTray();
        } catch (_) {}
      }, 1500);
    }

    app.on('activate', () => showNote());
  });

  app.on('before-quit', () => {
    quitting = true;
    persistBounds();
  });

  app.on('window-all-closed', () => {
    // 关窗不退出：托盘常驻，用户从托盘退出
    if (!store || !store.getSettings().showTray) app.quit();
  });
}

process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'zhoujian-error.log'),
      `[${new Date().toISOString()}] ${err && err.stack || err}\n`);
  } catch (_) {}
});
