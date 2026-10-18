// =====================================================================
//  右上角控制台 · 主进程  v1.9
//
//  这一版最重要的改动：**不再逐帧改窗口尺寸**。
//  以前是“窗口在长大 + 内容在缩放”，两条时间线各走各的，所以看起来像两层，
//  而且每帧 setBounds 都要让系统重算磨砂背景，必然掉帧。
//
//  现在：
//    1) 两个窗口尺寸都固定（窄条 48×140、面板 380×268），永不改大小；
//    2) 展开/收起 = 显示/隐藏窗口 + 页面里一个 transform 动画（GPU 合成，60fps）；
//    3) 真正的“透出背后桌面”不是靠系统磨砂（Windows 的磨砂不可调、太浑浊），
//       而是：展开前先把面板那块屏幕抓下来，做一张模糊图垫在玻璃底下。
//       这样模糊半径、透明度都归我们控制，而且这张图跟玻璃是同一个元素，
//       缩放时一起动 —— 内外绝对同步。
// =====================================================================
const { app, BrowserWindow, screen, ipcMain, nativeTheme, Tray, Menu, nativeImage, desktopCapturer, globalShortcut, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const DEBUG = process.argv.includes('--panel-debug') || process.argv.includes('--automation');
const AUTOMATION = process.argv.includes('--automation');

const PANEL = { w: 380, h: 268 };
// 扩展坞：四宫格下方那条带箭头的手柄（DOCK_BAR）+ 展开后露出的扩展区（DOCK_AREA）。
// 关键：加手柄靠“把窗口加高 34px”腾地方，而不是压扁四宫格——
// 这样四宫格的尺寸和位置跟以前一模一样，用户看到的扩展只是往下长出来。
// 展开时同理，只加高 132px，宽度和顶部位置一个像素都不动。
const DOCK_BAR = 34;
const DOCK_AREA = 132;
const PANEL_BASE_H = PANEL.h + DOCK_BAR;
const STRIP = { w: 48, h: 140 };
const EDGE = 8;
const TOP_MARGIN = 25;
const STRIP_TOP = 140;

const EXPAND_MS = 320;
const COLLAPSE_MS = 260;

// ---------------- 设置 ----------------
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
// openAtLogin 默认 true：这是“常驻桌面右上角”的工具，开机就该在。
// slots：主区 4 个槽位 + 扩展区若干；null 表示“还没排过”，由页面按默认四宫格填。
// features.dock 是逃生开关：万一扩展坞出问题，改成 false 就退回纯四宫格。
let settings = {
  opacity: 0.32,
  blur: 26,
  openAtLogin: true,
  customBackground: false,
  dockOpen: false,
  slots: null,
  features: { dock: true },
};

function normalizeSlots(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const valid = ['launch', 'music', 'wallpaper', 'notify'];
  const pick = (v) => (valid.includes(v) ? v : null);
  const main = Array.isArray(raw.main) ? raw.main.slice(0, 4).map(pick) : [];
  while (main.length < 4) main.push(null);
  // 同一个模块不能同时出现在两个槽位里：以先出现的位置为准
  const seen = new Set();
  const dedupe = (id) => {
    if (!id || seen.has(id)) return null;
    seen.add(id);
    return id;
  };
  const mainOut = main.map(dedupe);
  const dock = Array.isArray(raw.dock) ? raw.dock.map(pick).map(dedupe) : [];
  return { main: mainOut, dock };
}

function loadSettings() {
  let hasLoginFlag = false;
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    hasLoginFlag = typeof raw.openAtLogin === 'boolean';
    settings = { ...settings, ...raw };
  } catch { /* 第一次运行 */ }
  if (typeof settings.openAtLogin !== 'boolean') settings.openAtLogin = true;
  if (typeof settings.customBackground !== 'boolean') settings.customBackground = false;
  if (typeof settings.dockOpen !== 'boolean') settings.dockOpen = false;
  settings.features = { dock: true, ...(settings.features && typeof settings.features === 'object' ? settings.features : {}) };
  settings.slots = normalizeSlots(settings.slots);
  // 第一次跑（老版本 settings.json 里没有这个字段）：默认帮他打开开机自启；
  // 之后一律以 settings 为准，不再每次启动都去改注册表（否则用户从任务管理器关掉也会被我们改回来）。
  settingsNeedsLoginSync = !hasLoginFlag;
}
let settingsNeedsLoginSync = false;

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) { log('[settings] 存盘失败', e.message); }
}

// ---------------- 开机自启 ----------------
// 开发模式（没打包成 exe）时 process.execPath 是 node_modules 里的 electron.exe，
// 光注册它只会打开一个空白的 Electron 窗口，所以必须把工程目录作为参数一起登记。
function loginItemArgs() {
  if (app.isPackaged) return [];
  return [app.getAppPath()];
}

// 我们在注册表 HKCU\...\Run 下面实际写了什么（Electron 用 app.name 当值名）
function loginRunKey() {
  return { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run' };
}

// 直接读注册表核对——getLoginItemSettings 在 dev 模式下经常对不上，注册表才是事实。
// 值名不一定等于 app.name：调用过 setAppUserModelId() 之后，Electron 会用那个 AppID
// （我们这里是 com.deskpanel.app）当值名，所以这里按“命令行里有没有我们的 exe/工程目录”来找。
function readRunEntry() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], { encoding: 'utf8', windowsHide: true });
    const exe = String(process.execPath || '').toLowerCase();
    const appPath = String(app.getAppPath() || '').toLowerCase();
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^HKEY/i.test(line) || !/REG_/i.test(line)) continue;
      const low = line.toLowerCase();
      if (exe && low.includes(exe)) return line;
      if (!app.isPackaged && appPath && low.includes(appPath)) return line;
    }
    return '';
  } catch (e) {
    return '';
  }
}

function loginState() {
  let os = {};
  try { os = app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs() }); } catch (e) { os = {}; }
  const entry = readRunEntry();
  return {
    // 以系统事实为准：注册表里真有这一条，或者系统自己说会启动
    enabled: !!entry || !!os.openAtLogin,
    openAtLogin: !!os.openAtLogin,
    willLaunch: !!os.executableWillLaunchAtLogin,
    execPath: process.execPath,
    args: loginItemArgs(),
    packaged: app.isPackaged,
    runEntry: entry,
  };
}

function applyLoginItem(enabled) {
  const on = !!enabled;
  settings.openAtLogin = on;
  saveSettings();
  try {
    app.setLoginItemSettings({
      openAtLogin: on,
      path: process.execPath,
      args: loginItemArgs(),
      openAsHidden: false,
    });
    log('[login] openAtLogin =', on, '|', JSON.stringify(loginState()));
  } catch (e) {
    log('[login] 设置开机自启失败', e.message);
  }
  return loginState();
}

function log(...args) { if (DEBUG) console.log(...args); }

// ---------------- 快捷启动：小本子 ----------------
// 存在 %APPDATA%\deskpanel\apps.json，每条长这样：
//   { id, name, path, icon }   icon 是 Electron 从 .lnk/.exe 里抠出来的 PNG（dataURL）
// 为什么要缓存图标：每次展开都去抠图标会慢，而且抠完的那份数据本来就不会变。
const APPS_PATH = path.join(app.getPath('userData'), 'apps.json');
// 图标算法改过几次（.lnk 的 ",0" 坑），用一个小版本号标记：对不上就全部重算一遍。
const ICONS_VER = '5';
const ICONS_VER_PATH = path.join(app.getPath('userData'), 'apps-icons.version');
let apps = [];

function loadApps() {
  try {
    const raw = JSON.parse(fs.readFileSync(APPS_PATH, 'utf8'));
    if (Array.isArray(raw)) apps = raw.filter(a => a && a.path);
  } catch { /* 第一次运行，空数组 */ }
}

function saveApps() {
  try {
    fs.mkdirSync(path.dirname(APPS_PATH), { recursive: true });
    fs.writeFileSync(APPS_PATH, JSON.stringify(apps, null, 2), 'utf8');
  } catch (e) { log('[apps] 存盘失败', e.message); }
}

// 问系统要这个文件的图标。失败就当没有图标（用首字母兜底），绝不因为图标挂掉整个添加流程。
// 坑 1：直接对 .lnk 取图标，系统只会给那张“白纸折角 + 快捷方式箭头”的通用图。
//       所以先顺着快捷方式找到它指向的 exe，再取那个 exe 的图标。
// 坑 2：快捷方式的 IconLocation 常常是 ",0"（等于“没指定图标文件”），
//       抖音就是这种。以前把它当路径直接丢给 getFileIcon 就必然失败，格子上只剩白纸。
function iconSource(file) {
  try {
    if (/\.lnk$/i.test(file)) {
      const sc = shell.readShortcutLink(file);
      if (sc) {
        const iconFile = String(sc.icon || '').replace(/,\s*-?\d+\s*$/, '').replace(/^"|"$/g, '').trim();
        if (iconFile && fs.existsSync(iconFile)) return iconFile;
        if (sc.target && fs.existsSync(sc.target)) return sc.target;
        if (iconFile) return iconFile;
      }
    }
  } catch (e) {
    log('[apps] 读快捷方式失败', file, e.message);
  }
  return file;
}

// Electron 的 getFileIcon 对某些 exe 只会返回系统那张“通用白纸”（抖音就是），
// 而 Windows 自己的 ExtractAssociatedIcon 能拿到真 Logo。所以先用 IconGrab.exe 兜底。
const iconGrabExe = path.join(__dirname, '..', '..', 'native', 'IconGrab.exe');
// 注意：输出目录必须全 ASCII。runHidden 写的 .cmd 里出现中文路径会变乱码，cmd 找不到目录，
// IconGrab 静默失败（userData 是「右上角控制台」，踩过一次）。
const iconTempDir = path.join(require('os').tmpdir(), 'deskpanel-icons');

async function iconFromSystem(file) {
  if (!fs.existsSync(iconGrabExe) || !file || !fs.existsSync(file)) return '';
  let out = '';
  try {
    fs.mkdirSync(iconTempDir, { recursive: true });
    out = path.join(iconTempDir, 'ic-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.png');
    runHidden(`"${iconGrabExe}" "${file}" "${out}"`, 'icongrab');
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 70));
      if (fs.existsSync(out) && fs.statSync(out).size > 200) {
        const b64 = fs.readFileSync(out).toString('base64');
        try { fs.unlinkSync(out); } catch (e) { /* 忽略 */ }
        return 'data:image/png;base64,' + b64;
      }
    }
  } catch (e) {
    log('[apps] IconGrab 失败', e.message);
  }
  try { if (out && fs.existsSync(out)) fs.unlinkSync(out); } catch (e) { /* 忽略 */ }
  return '';
}

async function iconOf(file) {
  const src = iconSource(file);
  try {
    const img = await app.getFileIcon(src, { size: 'large' });
    const url = img && !img.isEmpty() ? img.toDataURL() : '';
    // 太小基本就是那张通用白纸（真图标一般 1.5KB 以上），换系统接口再试一次
    if (url && url.length > 1400) return url;
    const sys = await iconFromSystem(src);
    return sys || url;
  } catch (e) {
    log('[apps] 取图标失败', e.message);
    return await iconFromSystem(src);
  }
}



let stripWin = null;
let panelWin = null;
let tray = null;

let state = 'collapsed';
let closeGuard = null;
let expandingAt = 0;

let backdropCache = '';
let backdropAt = 0;
let grabbing = null;
let stripHideTimer = null;

// ---------------- 位置 ----------------
// 扩展坞展开状态：窗口高度 = 基础高度（四宫格 + 手柄）+ 扩展区高度
let dockOpen = false;

function panelHeight() {
  // 窗口高度永远是“全展开”的高度（2026-10-18 定稿第 3 版）：
  // 只要窗口尺寸不变，玻璃那层 blur(40px) 就不必重算，抽屉动画才不会卡。
  // 收起时多出来的 132px 靠 setShape 裁掉——看不见，也不接收鼠标。
  return PANEL_BASE_H + DOCK_AREA;
}

// 窗口形状：**不用 setShape**。实测它会让窗口在屏幕上彻底消失（属于 Electron 在
// 透明窗口上的已知坑），风险太大。收起时多出来的 132px 仍然是窗口的一部分，
// 点那里由页面判定为“点到外面”→ 直接收起面板（见 app.js 的 below-strip 处理）。
function applyPanelShape() {
  /* no-op：保留函数名，方便以后换方案 */
}

function computeBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    strip: { x: wa.x + wa.width - STRIP.w, y: wa.y + STRIP_TOP, width: STRIP.w, height: STRIP.h },
    panel: { x: wa.x + wa.width - PANEL.w - EDGE, y: wa.y + TOP_MARGIN, width: PANEL.w, height: panelHeight() },
  };
}

// 抽屉式展开（2026-10-18 定稿）：主进程不再逐帧改窗口高度。
// 逐帧 setBounds 会让整块玻璃（40px 模糊）每帧重算，实测掉到 33~44ms 一帧，看着就是“机械抖动”。
// 现在只有两次尺寸跳变（302↔434），中间的可视动画全在页面里用 clip-path 完成；
// 页面通过 IPC panel:height 告诉主进程什么时候该跳到哪个高度。
const DOCK_MS = 300;

// ---------------- 抓“背后桌面”做玻璃底图 ----------------
// 为什么抓屏：Windows 自带的磨砂（acrylic）不可调、太浑浊，
// 而网页的 backdrop-filter 看不到窗口外面的东西（浏览器只能模糊自己页面里的内容）。
// 所以只能“自己拍一张背后的照片，自己糊”。
// 调试用：--demo-backdrop=<图片路径> 时，玻璃底图换成这张图，
// 方便在“彩色背景”上看清玻璃的透明度与模糊效果（不影响正常抓屏逻辑）。
const DEMO_BACKDROP = (() => {
  const a = process.argv.find((s) => s.startsWith('--demo-backdrop='));
  return a ? a.slice('--demo-backdrop='.length) : '';
})();

async function grabBackdrop() {
  if (DEMO_BACKDROP) {
    try {
      const buf = fs.readFileSync(DEMO_BACKDROP);
      const ext = path.extname(DEMO_BACKDROP).toLowerCase();
      const mime = ext === '.webp' ? 'image/webp' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      return `data:${mime};base64,` + buf.toString('base64');
    } catch (e) { log('[backdrop] demo 读失败', e.message); }
  }
  if (grabbing) return grabbing;
  grabbing = (async () => {
    try {
      const d = screen.getPrimaryDisplay();
      const sf = d.scaleFactor;
      const b = computeBounds().panel;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(d.size.width * sf),
          height: Math.round(d.size.height * sf),
        },
      });
      const src = sources && sources[0];
      if (!src || src.thumbnail.isEmpty()) return '';
      const k = src.thumbnail.getSize().width / d.size.width;   // 实际像素 / 逻辑像素
      const cropped = src.thumbnail.crop({
        x: Math.max(0, Math.round(b.x * k)),
        y: Math.max(0, Math.round(b.y * k)),
        width: Math.round(b.width * k),
        height: Math.round(b.height * k),
      });
      const buf = cropped.toJPEG(88);
      backdropCache = 'data:image/jpeg;base64,' + buf.toString('base64');
      backdropAt = Date.now();
      log('[backdrop] 抓好了', cropped.getSize(), (buf.length / 1024).toFixed(0) + 'KB');
      // 调试时把抓到的原图存一份，方便肉眼确认“抓到的是背后的桌面”
      if (DEBUG) {
        try { fs.writeFileSync(path.join(__dirname, '..', '..', 'shots', 'backdrop-raw.jpg'), buf); } catch {}
      }
      return backdropCache;
    } catch (e) {
      log('[backdrop] 抓屏失败', e.message);
      return '';
    } finally {
      grabbing = null;
    }
  })();
  return grabbing;
}

// ---------------- 建窗口 ----------------
const NO_LIVE = process.argv.includes('--no-live');

function makeWindow(kind, bounds) {
  const isStrip = kind === 'strip';
  const win = new BrowserWindow({
    ...bounds,
    type: 'toolbar',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    // 两个窗口都用「真透明」，磨砂由我们自己在页面里画（见 grabBackdrop）
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 悬浮窗经常被别的窗口“盖住”或不在前台，Chromium 默认会降频/停画，
      // 结果就是界面看起来“冻住不动”。关掉节流，动画和缩略图才跟得上。
      backgroundThrottling: false,
      additionalArguments: [
        `--panel-kind=${kind}`,
        `--panel-debug=${DEBUG ? 1 : 0}`,
        ...(NO_LIVE ? ['--panel-no-live'] : []),
      ],
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setSkipTaskbar(true);
  // 注意：这里以前开过 setContentProtection(true)（把本窗口从录屏里排除）。
  // 副作用是剪映/QQ/微信等录屏工具会遇到“受保护窗口”而抓黑或直接报错，
  // 用户要能正常录屏，所以**彻底不开**这个开关。
  // 代价：实时背景那路视频流会把面板自己也拍进去（画面里套一层淡淡的虚影），
  // 所以实时视频用低分辨率 + 未就绪时退回静态底图，把虚影压到几乎看不出来。
  win.loadFile(
    path.join(__dirname, '..', 'renderer', 'index.html'),
    DEBUG ? { query: { kind, debug: '1' } } : { query: { kind } }
  );

  win.webContents.on('console-message', (...args) => {
    // 兼容两种签名：老版 (event, level, message, line, sourceId)，新版 (event, details)
    const d = args[1];
    if (d && typeof d === 'object' && 'message' in d) {
      log(`[${kind}]`, d.message, d.lineNumber != null ? `(${d.sourceId}:${d.lineNumber})` : '');
    } else {
      log(`[${kind}]`, args[2], args[3] != null ? `(line ${args[3]} @ ${args[4]})` : '');
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (kind !== 'panel') return;
    if (input.type !== 'keyDown') return;
    if (input.key !== 'Escape') return;
    e.preventDefault();
    // Esc 统一走一条路：让页面先决定“退一层还是收起”
    win.webContents.send('view:request-close', { reason: 'esc' });
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log(`[${kind}-gone]`, JSON.stringify(d)));
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(
      `JSON.stringify({kind: (window.panel && window.panel.kind) || 'NO-PRELOAD',
        body: document.body.className,
        stripHidden: (document.getElementById('strip') || {}).hidden,
        panelHidden: (document.getElementById('panel') || {}).hidden,
        w: innerWidth, h: innerHeight})`
    ).then((r) => log(`[${kind}] dom`, r)).catch((e) => log(`[${kind}] dom err`, e.message));
  });
  return win;
}

function createWindows() {
  const b = computeBounds();
  log('[bounds]', JSON.stringify(b));

  stripWin = makeWindow('strip', b.strip);
  panelWin = makeWindow('panel', b.panel);

  stripWin.once('ready-to-show', () => {
    // 这里必须保持「可聚焦」：一旦设成不可聚焦（WS_EX_NOACTIVATE），
    // 窗口从隐藏状态重新 showInactive 回来之后，真实鼠标点击就再也送不进渲染进程了
    // ——只有 PostMessage 能进去（2026-10-17 实测，这就是“点窄条没反应、只有快捷键好用”的原因）。
    stripWin.setFocusable(true);
    stripWin.showInactive();
    log('[strip] shown', JSON.stringify(stripWin.getBounds()));
  });

  panelWin.once('ready-to-show', () => {
    panelWin.setFocusable(false);
    // 收起状态下，面板窗口一律“不接收鼠标”，彻底杜绝点穿透
    panelWin.setIgnoreMouseEvents(true, { forward: true });
    dockOpen = false;
    applyPanelShape();                 // 只露出 302，下面 132 既看不见也不挡鼠标
    log('[panel] ready (hidden)', JSON.stringify(panelWin.getBounds()));
  });

  // 焦点离开 → 立刻收起（用户 2026-10-17 明确要求：只要点控制台以外任何地方就消失，
  // 不管是点桌面、还是直接去点微信/浏览器，优先级最高）。
  // 但“失焦”本身也会在点自己家按钮时偶尔抖一下，所以再拿光标位置复核一次：
  // 光标还在面板里面，就当没这回事；只有光标确实跑到外面了才收。
  panelWin.on('blur', () => {
    if (state !== 'expanded' && state !== 'animating') return;
    // 正在弹“选软件”的系统对话框：那个框一弹出我们必然失焦，这时收起来会显得像闪退
    if (pickingApps) { log('[blur] 正在选文件，忽略这次失焦'); return; }
    let inside = false;
    try {
      const b = panelWin.getBounds();
      const pt = screen.getCursorScreenPoint();
      // 窗口永远 434 高，但收起时下面 132px 是被 setShape 裁掉的（点那里等于点桌面），
      // 所以判“在不在面板里”只能用当前真正露出来的高度。
      const visH = PANEL_BASE_H + (dockOpen ? DOCK_AREA : 0);
      inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + visH;
    } catch (e) { inside = false; }
    if (inside) { log('[blur] 光标还在面板里，忽略这次失焦'); return; }
    log('[blur] 焦点离开控制台 → 收起');
    collapse('blur');
  });

  panelWin.on('closed', () => { panelWin = null; });
  stripWin.on('closed', () => { stripWin = null; });

  // 点窗口的 ✕ 只收到托盘，不真退出（用户只允许从托盘右键「退出」彻底结束）。
  // 面板的 ✕ 走 collapse：窗口滑回窄条，托盘图标一直留着；窄条自己的 ✕ 才真隐藏。
  const hideOnClose = (win, tag, onHide) => {
    win.on('close', (e) => {
      if (app.isQuitting) return;
      e.preventDefault();
      log('[close] ' + tag + ' 关闭 → 收到托盘');
      try {
        if (typeof onHide === 'function') onHide();
        else win.hide();
      } catch (err) { }
    });
  };
  hideOnClose(panelWin, 'panel', () => {
    if (state === 'expanded' || state === 'animating') collapse('close-btn');
    else panelWin.hide();
  });
  hideOnClose(stripWin, 'strip');
}

// ---------------- 扩展坞 ----------------
// 页面点手柄 → 这里只记状态 + 通知页面；窗口尺寸自始至终不动（永远是 434）。
// 真正的“展开”是页面把 .glass 的高度从 302 过渡到 434，再配合 setShape 开关可点击区域。
function setDock(open) {
  const want = !!open;
  if (want === dockOpen) return { ok: true, open: dockOpen, changed: false };
  dockOpen = want;
  settings.dockOpen = want;
  saveSettings();
  log('[dock]', want ? '展开扩展区' : '收起扩展区');
  if (!panelWin || panelWin.isDestroyed()) return { ok: true, open: dockOpen, changed: true };
  if (panelWin.webContents) panelWin.webContents.send('view:dock', { open: dockOpen });
  return { ok: true, open: dockOpen, changed: true };
}

// ---------------- 展开 / 收起 ----------------// 打开方式只有一种：点击窄条（或托盘/快捷键）。悬停自动展开已彻底删除。
async function expand({ focus = true, reason = 'click' } = {}) {
  if (!panelWin || state === 'expanded') return;
  // 全屏应用正在跑：默认不出来（用户主动按快捷键/点托盘时才破例）
  if (fullscreenOn && !fsOverride && reason !== 'hotkey' && reason !== 'tray' && reason !== 'tray-click' && reason !== 'tray-dblclick' && reason !== 'second-instance') {
    log('[expand] 全屏中，忽略', reason);
    return;
  }
  const t0 = Date.now();

  // 每次打开都从“只显示主四宫格”开始（用户 2026-10-18 定死）：
  // 扩展坞不记忆上次状态，必须由用户主动点箭头才展开。
  if (dockOpen) {
    dockOpen = false;
    settings.dockOpen = false;
    saveSettings();
  }
  if (panelWin.webContents) panelWin.webContents.send('view:dock', { open: false });

  state = 'expanded';
  expandingAt = t0;
  log('[expand]', reason);

  // 背景必须是“按下快捷键这一瞬间”的画面：
  // 之前是拿“上一次收起后 260ms 拍的缓存”，所以切了窗口再呼出，看到的还是上一张（滞后一张）。
  // 现在每次展开都先抓一张新的；抓的时候面板还没显示，画面里没有自己，是干净的。
  // 为了不让快捷键明显变慢：缓存还新鲜（<250ms）就直接用，否则等这一张（一般 60~150ms）。
  const bdAge = Date.now() - backdropAt;
  let freshShot = '';
  if (!backdropCache || bdAge > 250) {
    const tc = Date.now();
    freshShot = await Promise.race([
      grabBackdrop(),
      new Promise((r) => setTimeout(() => r(''), 450)),
    ]);
    log('[backdrop] 展开前重抓', (Date.now() - tc) + 'ms', freshShot ? 'ok' : '超时/失败');
  }

  // 先让窗口出来，绝不为了等截图把展开卡住。
  panelWin.setIgnoreMouseEvents(false);
  panelWin.setAlwaysOnTop(true, 'screen-saver');
  panelWin.setBounds(computeBounds().panel);
  // 现在只有“点击打开”，所以一律抢焦点：Esc、点外部都能正常工作。
  panelWin.setFocusable(true);
  panelWin.show();
  applyPanelShape();                   // 每次打开都从“只露出四宫格”的形状开始
  panelWin.webContents.send('view:set-state', { state: 'expanded', reason, phase: 'animating' });

  // 窄条晚一点再藏：让它看起来是“边框长成了面板”，而不是边框先消失、面板再冒出来
  clearTimeout(stripHideTimer);
  stripHideTimer = setTimeout(() => { if (state !== 'collapsed' && stripWin) stripWin.hide(); }, 170);

  const shotNow = freshShot || backdropCache;
  if (shotNow) {
    panelWin.webContents.send('view:backdrop', { data: shotNow });
  }
  log('[timing] 窗口出现耗时', (Date.now() - t0) + 'ms');

  // 完全没底图（极端情况：抓屏一直失败）才在显示后补一次。
  if (!shotNow) {
    grabBackdrop().then((shot) => {
      if (shot && panelWin && !panelWin.isDestroyed() && state !== 'collapsed') {
        panelWin.webContents.send('view:backdrop', { data: shot });
      }
    });
  }

  if (focus) {
    panelWin.focus();
  }
}

function collapse(reason = 'manual') {
  if (!panelWin || state === 'collapsed') return;
  log('[collapse]', reason);
  state = 'collapsed';
  clearTimeout(closeGuard);
  clearTimeout(stripHideTimer);
  panelWin.setFocusable(false);
  panelWin.webContents.send('view:set-state', { state: 'collapsing', reason });
  // 全屏应用正在前台时，窄条也不要出来（否则游戏画面边上会露出一条）
  if (stripWin && !(fullscreenOn && !fsOverride)) stripWin.showInactive();

  setTimeout(() => {
    if (!panelWin || state !== 'collapsed') return;
    panelWin.hide();
    // 窗口藏起来后再补一刀：彻底不接收鼠标，避免任何“点到看不见的东西”
    panelWin.setIgnoreMouseEvents(true, { forward: true });
    panelWin.webContents.send('view:set-state', { state: 'collapsed', reason });
    // 趁面板看不见，偷偷把下一张静态底图抓好：这样下次打开时底图是新的，
    // 而且显示期间永远不会中途换图（换图会闪一下）。
    setTimeout(() => {
      if (state !== 'collapsed') return;
      grabBackdrop().catch(() => {});
    }, 260);
  }, COLLAPSE_MS + 10);
}

function requestClose(reason) {
  if (!panelWin || state !== 'expanded') return;
  clearTimeout(closeGuard);
  panelWin.webContents.send('view:request-close', { reason });
  closeGuard = setTimeout(() => collapse(reason), 120);
}

// ---------------- 全屏应用（游戏 / 全屏电影）----------------
// 判定：前台窗口矩形 == 整块屏幕（±2px），且不是桌面、不是外壳、不是我们自己的窗口。
// 用一个常驻的 PowerShell 子进程每 500ms 报一次——比每秒新起一个进程省得多。
const ourHwnds = new Set();
let fsProc = null;
let fsTimer = null;
let fsFile = path.join(process.env.TEMP || process.env.TMP || '.', 'deskpanel-fs.txt');
let fsStartedAt = 0;
let fsOffTimer = null;
let fullscreenOn = false;
let fsOverride = false;        // 全屏中用户主动按了快捷键 → 尊重他，不再自动藏
let hiddenByFullscreen = false;

function hwndOf(win) {
  try { return win.getNativeWindowHandle().readBigUInt64LE(0).toString(); } catch (e) { return '0'; }
}

function refreshHwnds() {
  ourHwnds.clear();
  [panelWin, stripWin].forEach((w) => { if (w && !w.isDestroyed()) ourHwnds.add(hwndOf(w)); });
}

function startFullscreenWatch() {
  if (fsProc || fsTimer) return;
  const script = path.join(__dirname, '..', '..', 'native', 'fullscreen-probe.ps1');
  if (!fs.existsSync(script)) { log('[fullscreen] 探测脚本缺失', script); return; }
  try { fs.rmSync(fsFile, { force: true }); } catch (e) { /* 旧文件删不掉也无妨 */ }
  fsStartedAt = Date.now();

  // 为什么绕这么一圈：直接 spawn 子进程在这台机器上会被拒（起来就退）。
  // 现在走「.vbs 隐藏窗口 → cmd /c → powershell」，既不闪黑框也不依赖 spawn。
  // 结果不走管道，由探测脚本写进下面那个小文件，我们定时读。
  const outLog = path.join(path.dirname(fsFile), 'deskpanel-probe-out.txt');
  // 末尾的 > 重定向很关键：PowerShell 的 Add-Type 会在后台启动编译器，
  // 没有有效的标准输出句柄时它会失败（隐藏窗口里启动就会遇到这个坑）。
  const inner = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" -OutFile "${fsFile}" -ParentPid ${process.pid} > "${outLog}" 2>&1`;
  runHidden(inner, 'probe').then((err) => {
    if (err) log('[fullscreen] 启动探测失败', err);
  }).catch((e) => log('[fullscreen] 启动探测异常', e.message));

  let lastOk = 0;
  let warned = false;
  fsTimer = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(fsFile, 'utf8'); } catch (e) { text = ''; }
    const line = text.trim();
    if (line) {
      lastOk = Date.now();
      onFullscreenLine(line);
    } else if (!warned && Date.now() - fsStartedAt > 6000) {
      warned = true;
      log('[fullscreen] 注意：还没拿到全屏探测结果，全屏自动隐藏可能失效（其余功能不受影响）');
    }
  }, 300);
  log('[fullscreen] 探测已启动');
}

function onFullscreenLine(line) {
  const p = line.split(/\s+/);
  if (p.length < 2) return;
  refreshHwnds();
  const on = p[0] === '1' && !ourHwnds.has(p[1]);
  if (on === fullscreenOn) return;
  fullscreenOn = on;
  log('[fullscreen]', on ? '检测到全屏应用 → 隐藏控制台' : '全屏结束');
  if (on) {
    if (fsOffTimer) { clearTimeout(fsOffTimer); fsOffTimer = null; }
    if (fsOverride) return;
    if (state === 'expanded') collapse('fullscreen');
    hideAllByFullscreen();
  } else {
    fsOverride = false;
    // 退出全屏不立刻把窄条弹回来：游戏里偶尔会有一瞬间别的窗口抢到前台，
    // 那会让检测“闪”一下。等它稳定 1.2 秒仍然不是全屏，再把窄条还回去。
    if (hiddenByFullscreen && !fsOffTimer) {
      fsOffTimer = setTimeout(() => {
        fsOffTimer = null;
        if (fullscreenOn) return;
        hiddenByFullscreen = false;
        if (state === 'collapsed' && stripWin && !stripWin.isDestroyed()) stripWin.showInactive();
      }, 1200);
    }
  }
}

function hideAllByFullscreen() {
  hiddenByFullscreen = true;
  setTimeout(() => {
    if (!fullscreenOn || fsOverride) return;
    if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
    if (stripWin && !stripWin.isDestroyed()) stripWin.hide();
  }, COLLAPSE_MS + 60);
}

// ---------------- 音乐：SMTC 小助手 ----------------
// 为什么要小助手：网页层（Electron）不会说 Windows 的 WinRT 语言，
// 而 PowerShell 会。所以由它去调微软官方的媒体控制接口，
// 把「放的是什么歌 / 什么状态 / 播到第几秒」写成一个小 JSON 给我们读；
// 我们想暂停/切歌时，就把一条命令写进另一个小文件，它读走执行。
// 全程只读状态 + 调官方命令，不碰 QQ 音乐进程。
const mediaDir = process.env.TEMP || process.env.TMP || '.';
const mediaStateFile = path.join(mediaDir, 'deskpanel-media.json');
const mediaCmdFile = path.join(mediaDir, 'deskpanel-media-cmd.json');
const mediaCoverFile = path.join(mediaDir, 'deskpanel-media-cover.jpg');
const mediaCoverExe = path.join(__dirname, '..', '..', 'native', 'SmtcCover.exe');
const mediaLogFile = path.join(mediaDir, 'deskpanel-media-out.txt');
const mediaPidFile = path.join(mediaDir, 'deskpanel-media.json.pid');
let mediaTimer = null;
let mediaStartedAt = 0;
let mediaSeq = 0;
let mediaLast = null;
let mediaRaw = '';
let mediaRestarts = 0;

// 干掉还在跑的小助手：重启前必须先清场，不然旧的那个也在写同一个 JSON，
// 界面就会在两首歌之间来回跳（这个坑真踩过）。
function killMediaHelper() {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(mediaPidFile, 'utf8').trim(), 10); } catch (e) { pid = 0; }
  if (!(pid > 0)) return;
  runHidden(`taskkill /F /PID ${pid} > nul 2>&1`, 'kill-media')
    .catch(() => { /* 杀不掉就算了，父进程检查也会让它自己退 */ });
}

function startMediaHelper() {
  if (mediaTimer) return;
  const script = path.join(__dirname, '..', '..', 'native', 'smtc-helper.ps1');
  if (!fs.existsSync(script)) { log('[media] 小助手脚本缺失', script); return; }  try { fs.rmSync(mediaStateFile, { force: true }); } catch (e) { /* 删不掉就算了 */ }
  try { fs.rmSync(mediaCmdFile, { force: true }); } catch (e) { /* 同上 */ }
  mediaStartedAt = Date.now();

  // 走隐藏窗口那条路：不用 spawn（会被拒），也不会弹出黑框
  const inner = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" -OutFile "${mediaStateFile}" -CmdFile "${mediaCmdFile}" -CoverFile "${mediaCoverFile}" -CoverExe "${mediaCoverExe}" -ParentPid ${process.pid} > "${mediaLogFile}" 2>&1`;
  runHidden(inner, 'media').then((err) => {
    if (err) log('[media] 小助手启动失败', err);
  }).catch((e) => log('[media] 小助手启动异常', e.message));

  mediaTimer = setInterval(pollMedia, 400);
  log('[media] 小助手已启动');
}

function pollMedia() {
  let text = '';
  try { text = fs.readFileSync(mediaStateFile, 'utf8'); } catch (e) { text = ''; }
  if (!text) {
    // 小助手要是起不来（比如被拦），最多自己重试两次，然后老实报一句
    if (mediaRestarts < 2 && Date.now() - mediaStartedAt > 8000) {
      mediaRestarts++;
      log('[media] 没拿到状态，重启小助手（第', mediaRestarts, '次）');
      clearInterval(mediaTimer);
      mediaTimer = null;
      killMediaHelper();
      mediaStartedAt = Date.now();
      setTimeout(startMediaHelper, 900);
    }
    return;
  }
  if (text === mediaRaw) return;
  mediaRaw = text;
  let st;
  try { st = JSON.parse(text); } catch (e) { return; }
  if (st && st.ok) mediaStartedAt = Date.now();
  // 封面：小助手把缩略图写成临时文件，这里换成界面能直接加载的 file:// 地址；
  // 带上 stamp（文件修改时间）当版本号，换歌时浏览器才会重新取图而不是用旧缓存。
  if (st && st.ok && st.coverStamp && fs.existsSync(mediaCoverFile)) {
    const p = mediaCoverFile.replace(/\\/g, '/');
    st.coverUrl = 'file:///' + encodeURI(p).replace(/#/g, '%23') + '?v=' + encodeURIComponent(st.coverStamp);
  } else if (st) {
    st.coverUrl = '';
  }
  mediaLast = st;
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('media:state', st);
  }
}

// ---------- 通知模块 ----------
// 读 Windows 通知中心：QQ、Edge、邮件这些走系统 toast 的都能读到标题和正文。
// 微信 4.x 不发系统通知（Qt 自绘弹窗，且弹窗里没有正文），微信部分已永久暂停，
// 不再做任何监听/注入/读库的尝试。
// 所有内容只活在内存 + 一个临时 JSON 里，关闭控制台就删干净，绝不上网。
const notifStateFile = path.join(mediaDir, 'deskpanel-notif.json');
const notifPidFile = path.join(mediaDir, 'deskpanel-notif.json.pid');
const notifLogFile = path.join(mediaDir, 'deskpanel-notif-out.txt');
let notifTimer = null;
let notifStartedAt = 0;
let notifRestarts = 0;
let notifRaw = '';
let notifList = [];        // [{id, app, title, body, ts, kind}]
const notifSeen = new Set(); // 已经收录过的 id
let notifUnread = 0;
let notifAccess = '';

function killNotifHelper() {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(notifPidFile, 'utf8').trim(), 10); } catch (e) { pid = 0; }
  if (!(pid > 0)) return;
  runHidden(`taskkill /F /PID ${pid} > nul 2>&1`, 'kill-notif').catch(() => { });
}

function pushNotifState() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('notif:state', { items: notifList, unread: notifUnread, access: notifAccess });
  }
}

function startNotifHelper() {
  if (notifTimer) return;
  const script = path.join(__dirname, '..', '..', 'native', 'notif-helper.ps1');
  if (!fs.existsSync(script)) { log('[notif] 小助手脚本缺失', script); return; }
  // 上一轮留下的东西（状态、pid、启动脚本、日志）先清干净，别把旧通知当新的
  for (const f of [notifStateFile, notifPidFile, notifLogFile,
    path.join(mediaDir, 'deskpanel-notif.cmd'), path.join(mediaDir, 'deskpanel-notif.vbs')]) {
    try { fs.rmSync(f, { force: true }); } catch (e) { }
  }
  notifStartedAt = Date.now();
  const inner = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" -OutFile "${notifStateFile}" -PidFile "${notifPidFile}" -ParentPid ${process.pid} > "${notifLogFile}" 2>&1`;
  runHidden(inner, 'notif').then((err) => {
    if (err) log('[notif] 小助手启动失败', err);
  }).catch((e) => log('[notif] 小助手启动异常', e.message));
  notifTimer = setInterval(pollNotif, 700);
  log('[notif] 小助手已启动');
}

function pollNotif() {
  let text = '';
  try { text = fs.readFileSync(notifStateFile, 'utf8'); } catch (e) { text = ''; }
  if (!text) {
    if (notifRestarts < 2 && Date.now() - notifStartedAt > 8000) {
      notifRestarts++;
      log('[notif] 没拿到数据，重启小助手（第', notifRestarts, '次）');
      clearInterval(notifTimer);
      notifTimer = null;
      killNotifHelper();
      notifStartedAt = Date.now();
      setTimeout(startNotifHelper, 900);
    }
    return;
  }
  if (text === notifRaw) return;
  notifRaw = text;
  let st;
  try { st = JSON.parse(text); } catch (e) { return; }
  if (!st || !st.ok) return;
  notifStartedAt = Date.now();
  if (st.access) notifAccess = st.access;

  let added = 0;
  const list = Array.isArray(st.items) ? st.items : [];
  for (let i = list.length - 1; i >= 0; i--) {  // 老的先入，新的会插到最前面
    const it = list[i];
    if (!it || !it.id || notifSeen.has(it.id)) continue;
    notifSeen.add(it.id);
    notifList.unshift({
      id: String(it.id),
      app: String(it.app || '通知'),
      title: String(it.title || ''),
      body: String(it.body || ''),
      ts: Number(it.ts) || Date.now(),
      kind: String(it.kind || 'system')
    });
    added++;
  }
  if (notifList.length > 60) notifList = notifList.slice(0, 60);
  if (added) {
    notifUnread += added;
    log('[notif] 新增', added, '条，未读', notifUnread);
    pushNotifState();
  }
}

// 从控制台里启动程序 → 启动后立刻收起，绝不挡着新开的软件
async function launchAndHide(target, args) {
  const t = String(target || '').trim();
  if (!t) return { ok: false, error: '没有可启动的路径' };

  // 先确认文件真的在，不在就别白收起一次
  let exists = true;
  try { exists = fs.existsSync(t); } catch (e) { exists = true; }
  if (!exists) {
    const msg = '找不到这个文件：' + t;
    log('[launch] 失败', msg);
    return { ok: false, error: msg };
  }

  // 先启动，成功了再收起——启动失败就把面板留在脸上，好让你看见失败提示
  let err = '';
  try {
    if (args) {
      // 带启动参数时，用隐藏窗口的 cmd 执行（等价于你在“运行”里敲一行命令）
      err = await runHidden(`start "" "${t}" ${String(args)}`, 'launch');
    } else {
      // .lnk / .exe / 文件夹 都交给系统外壳，效果和双击完全一样
      err = await shell.openPath(t);
    }
  } catch (e) {
    err = e.message || String(e);
  }
  if (err) {
    log('[launch] 失败', err);
    return { ok: false, error: err };
  }
  collapse('launch');
  return { ok: true };
}

// ---------------- 壁纸（Wallpaper Engine 官方命令行） ----------------
// 官方文档：wallpaper64.exe -control openWallpaper -file <project.json>
// 我们不逆向、不碰它的核心文件，只用它自己公开的命令行接口。
// 但 Electron 里 spawn 会被拒，所以同样走「写 .vbs → shell.openPath」这条路，
// 用 .vbs 是为了不闪黑框（Run 的第二个参数 0 = 隐藏窗口）。

function steamLibraries() {
  const libs = new Set();
  const seeds = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam', 'E:\\Steam', 'F:\\Steam', 'G:\\Steam',
    'D:\\SteamLibrary', 'E:\\SteamLibrary', 'F:\\SteamLibrary', 'G:\\SteamLibrary',
  ];
  for (const s of seeds) libs.add(s);
  const seen = new Set();
  for (const lib of Array.from(libs)) {
    for (const vdf of [path.join(lib, 'steamapps', 'libraryfolders.vdf'),
                       path.join(lib, 'config', 'libraryfolders.vdf')]) {
      if (seen.has(vdf) || !fs.existsSync(vdf)) continue;
      seen.add(vdf);
      try {
        const t = fs.readFileSync(vdf, 'utf8');
        const re = /"path"\s+"([^"]+)"/g;
        let m;
        while ((m = re.exec(t))) libs.add(m[1].replace(/\\\\/g, '\\'));
      } catch (e) { /* 读不了就跳过 */ }
    }
  }
  return Array.from(libs);
}

function findWe() {
  if (process.env.DESKPANEL_WE && fs.existsSync(path.join(process.env.DESKPANEL_WE, 'config.json'))) {
    return process.env.DESKPANEL_WE;
  }
  for (const lib of steamLibraries()) {
    const p = path.join(lib, 'steamapps', 'common', 'wallpaper_engine');
    if (fs.existsSync(path.join(p, 'config.json'))) return p;
  }
  return null;
}

function weWorkshopRoot(install) {
  const cands = [];
  if (install) {
    // <steamapps>\common\wallpaper_engine  → 往上是 <steamapps>
    const steamapps = path.dirname(path.dirname(install));
    cands.push(path.join(steamapps, 'workshop', 'content', '431960'));
  }
  for (const lib of steamLibraries()) {
    cands.push(path.join(lib, 'steamapps', 'workshop', 'content', '431960'));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0] || '';
}

// 当前壁纸：WE 的 config.json 里 selectedwallpapers.Monitor0.file
// 形如 F:/.../workshop/content/431960/2711019123/scene.pkg —— 倒数第二段就是壁纸 id
function currentWallpaperId(install) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(install, 'config.json'), 'utf8'));
    let userCfg = null;
    for (const k of Object.keys(cfg)) {
      const v = cfg[k];
      if (v && typeof v === 'object' && v.general) { userCfg = v; break; }
    }
    const sel = userCfg && userCfg.general && userCfg.general.wallpaperconfig
      && userCfg.general.wallpaperconfig.selectedwallpapers;
    if (!sel) return null;
    const first = Object.values(sel)[0];
    if (!first || !first.file) return null;
    const parts = String(first.file).replace(/\\/g, '/').split('/');
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  } catch (e) {
    return null;
  }
}

function listWallpapers() {
  const install = findWe();
  if (!install) {
    return { ok: false, error: '没找到 Wallpaper Engine（它装在 Steam 里吗？）' };
  }
  const wshop = weWorkshopRoot(install);
  const items = [];
  if (wshop && fs.existsSync(wshop)) {
    let names = [];
    try { names = fs.readdirSync(wshop); } catch (e) { names = []; }
    for (const name of names) {
      const dir = path.join(wshop, name);
      const pj = path.join(dir, 'project.json');
      if (!fs.existsSync(pj)) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { meta = {}; }
      const pv = path.join(dir, 'preview.jpg');
      items.push({
        id: name,
        title: meta.title || name,
        type: meta.type || '',
        project: pj,
        preview: fs.existsSync(pv) ? pv : '',
      });
    }
  }
  items.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-CN'));
  return { ok: true, items, current: currentWallpaperId(install), install, workshop: wshop };
}

// 用隐藏的 VBScript 调 WE 命令行（不闪黑框）
// 组合拳：VBS（隐藏窗口）→ cmd（负责引号解析）→ wallpaper64.exe
// 直接用 VBS 的 Run 带引号参数会被 WE 忽略，必须借 cmd 这一层，已实测。
async function weRun(argsText) {
  const install = findWe();
  if (!install) return { ok: false, error: '没找到 Wallpaper Engine' };
  const exe = path.join(install, process.arch === 'ia32' ? 'wallpaper32.exe' : 'wallpaper64.exe');
  if (!fs.existsSync(exe)) return { ok: false, error: '找不到 wallpaper64.exe' };
  const err = await runHidden(`"${exe}" ${argsText}`, 'we');
  if (err) return { ok: false, error: err };
  return { ok: true };
}

// 把一段命令行藏起来跑：写 .cmd → 由 .vbs 以隐藏窗口启动 cmd /c。
// 这样既不用 spawn（这台机器会被拒），也不会弹出黑色控制台窗口。
function runHidden(cmdBody, tag) {
  const dir = fsDir();
  const cmdPath = path.join(dir, `deskpanel-${tag}.cmd`);
  const vbsPath = path.join(dir, `deskpanel-${tag}.vbs`);
  try {
    fs.writeFileSync(cmdPath, '@echo off\r\n' + cmdBody + '\r\n', 'utf8');
  } catch (e) {
    return Promise.resolve('写启动器失败：' + e.message);
  }
  const line = 'CreateObject("WScript.Shell").Run "cmd /c " & Chr(34) & "'
    + cmdPath + '" & Chr(34), 0, False\r\n';
  const bytes = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(line, 'utf16le')]);
  try {
    fs.writeFileSync(vbsPath, bytes);
  } catch (e) {
    return Promise.resolve('写 VBS 失败：' + e.message);
  }
  return shell.openPath(vbsPath);
}

function fsDir() { return path.dirname(fsFile); }

// ---------------- 托盘 ----------------
// 兜底图标：万一 assets/ 里那两张 png 找不到（打包漏文件、被安全软件删了），
// 用一段内嵌的 32×32 PNG 顶上，保证托盘一定看得见，而不是“程序在跑但找不到图标”。
const TRAY_FALLBACK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMQSURBVFhH1dZNTxpBGAdwjh49euxH8OitfIIuCAiKMsqyiviGdlUQENpDm/ZQE3sgTZu+HFqamNY0TWrSi4ceOPbYQ6VbFVEEWVhY1mr1aXa3GBmRWRSa9J88NzK/Z2bnBZ3uf82CS+wK0JI+QBf180gt/DdNTRiVOkIu0R10Ha4F6TIE6DIsOEXwD5XAP1QE36BcAsw78nEW5X3ziL+Bj3GlhBG0hxgpEnSVpaBLgro4KsAcKsCsI68U289HWZTuwMfUnDAt6UPMIR+S4UbxAR7YgRzM2A+k6f59Gz42MUGXNBhiJOk6+O3+A5iRy56FaXsmghuXRsYXmUNoHp4Fb18GJnszS7h1IeqyN3PmKj7Vuw9TvWmYtO25cfMsyk6/5jevj6dh0roneSzJTtxWssj8WmopbtuDCesujFlTq7itzP5KR61BfNyagrGeHbiwCiG67GsUfxQQIHpPgOVIoSFcacC8Ha1qIEhLca344ztFSKd+w/kI+RN48qCgDbckYdSc3D3Dw4hvbwSvl9dRgYirDWyDx8Kpn0F9WMi4n85DLnOCm1Upi6cQdGeIuNu8JZd6Q/qdooGEa5l9JS+X82TctAXDRs6rroBTdJNwebe/eyHiVs18WikS8RHTJjBGTr2e/ahoI+HyUXv6UMCtmnn7LE/Eh7t/Am3gfEoD8p8JEi6f88BwDo6PTnHvQu5Op4k4Y+TARXGDSgMsKnWQ8Mo5X3lewr2qfPlc0oQrDRi5rr8HUaebcxQ4El65ZD7GSnBUYyXi6yJ47SltuCEhIcS1nTUw6xCWtOCVSyYykYX3rwRlw314I8D9uX3tMzf8kKv6PWAR36kV13LJEHBwUt8NVQ0oTQzkVv8JfivxFbeVsH18Z6txmkrUnn0lXnvG10p8iEpUv4K14rVnY63AndRGHN08t/MvSxhxbVO2TKzpOMW141bdTFjTkWbg8rJrmnmtjFl39eM9qfWr4Rvf6m64RjLas2PwWHZiHnNS0oCvOakN9Z5vRUZM23p396ZvxLQZkZ/UStEUp6+6XjXkD/bbIMB5g4BlAAAAAElFTkSuQmCC';

function trayImage() {
  // 绝对路径依次试：打包后 __dirname 在 asar 里，也能读到 asar 内的静态资源
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'tray-32.png'),
    path.join(__dirname, '..', '..', 'assets', 'tray-16.png'),
    path.join(process.resourcesPath || '', 'app', 'assets', 'tray-32.png'),
    path.join(process.resourcesPath || '', 'assets', 'tray-32.png'),
  ];
  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        log('[tray] 图标来源', p, JSON.stringify(img.getSize()));
        return img.resize({ width: 16, height: 16 });
      }
    } catch (e) { log('[tray] 读图标失败', p, e.message); }
  }
  log('[tray] 静态图标都不可用，用内嵌兜底图标');
  return nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_FALLBACK_PNG);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const loginOn = (() => { try { return loginState().enabled; } catch (e) { return settings.openAtLogin !== false; } })();
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开控制台',
      click: () => expand({ focus: true, reason: 'tray' }),
    },
    {
      label: '设置…',
      click: () => {
        expand({ focus: true, reason: 'tray' });
        setTimeout(() => {
          try { panelWin && panelWin.webContents.send('view:open-settings'); } catch (e) { }
        }, 420);
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: loginOn,
      click: (item) => { applyLoginItem(item.checked); rebuildTrayMenu(); },
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  log('[tray] 菜单已重建：打开控制台 / 设置… / 开机自启(' + (loginOn ? '✔' : '✘') + ') / 退出');
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(trayImage());
  } catch (e) {
    log('[tray] 创建失败', e.message);
    return;
  }
  tray.setToolTip('右上角控制台 · Ctrl+Alt+Space');
  rebuildTrayMenu();
  tray.on('click', () => { if (state === 'expanded') collapse('tray-click'); else expand({ focus: true, reason: 'tray-click' }); });
  tray.on('double-click', () => expand({ focus: true, reason: 'tray-dblclick' }));
  log('[tray] 已创建');
}

// ---------------- IPC ----------------
ipcMain.handle('env:info', () => {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  return {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    scale: d.scaleFactor,
    size: `${d.size.width}×${d.size.height}`,
    workArea: `${wa.width}×${wa.height}`,
    dark: nativeTheme.shouldUseDarkColors,
    contentPos: { x: wa.x + wa.width - PANEL.w - EDGE, y: wa.y + TOP_MARGIN },
    opacity: settings.opacity,
    blur: settings.blur,
    state,
  };
});

ipcMain.handle('settings:get', () => settings);

// 扩展坞：页面在动画开始/结束时告诉主进程“现在该露出多高”，主进程只改窗口形状。
// 窗口本身的尺寸从不改变（永远 434），这样玻璃的 blur 不会被反复重算。
ipcMain.on('panel:shape', (_e, open) => {
  dockOpen = !!open;
  applyPanelShape();
});
ipcMain.handle('panel:set-dock', (_e, open) => setDock(!!open));

// 槽位分配：页面传 { main:[id|null×4], dock:[id…] }，主进程校验后落盘
ipcMain.handle('slots:set', (_e, slots) => {
  settings.slots = normalizeSlots(slots);
  saveSettings();
  log('[slots] 已保存', JSON.stringify(settings.slots));
  return settings.slots;
});

// 开机自启：给页面里的开关用
ipcMain.handle('login:get', () => loginState());
ipcMain.handle('login:set', (_e, enabled) => {
  const st = applyLoginItem(!!enabled);
  rebuildTrayMenu();
  return st;
});

// 调试用：把页面里“实时背景”的当前一帧存成图片，方便肉眼确认抓到的是真桌面
ipcMain.handle('debug:save-live', async (_e, dataUrl) => {
  try {
    const b64 = String(dataUrl).split(',')[1] || '';
    const buf = Buffer.from(b64, 'base64');
    const out = path.join(__dirname, '..', '..', 'shots', 'live-frame.jpg');
    fs.writeFileSync(out, buf);
    log('[debug] live 帧已存', out, (buf.length / 1024).toFixed(0) + 'KB');
    return true;
  } catch (e) { log('[debug] 存帧失败', e.message); return false; }
});

ipcMain.on('settings:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  const next = { ...settings, ...patch };
  if (typeof next.opacity === 'number') next.opacity = Math.max(0.05, Math.min(1, next.opacity));
  if (typeof next.blur === 'number') next.blur = Math.max(0, Math.min(40, next.blur));
  if (typeof next.customBackground === 'boolean') next.customBackground = next.customBackground;
  if (typeof next.openAtLogin === 'boolean') next.openAtLogin = next.openAtLogin;
  // 槽位/扩展坞这类有结构的字段不允许从这条通道乱写，只走各自的 IPC
  next.slots = settings.slots;
  next.dockOpen = settings.dockOpen;
  next.features = settings.features;
  settings = next;
  saveSettings();
  log('[settings] 已保存', JSON.stringify(settings));
});

ipcMain.on('panel:expand', (_e, opt) => expand(opt || {}));
ipcMain.on('panel:collapse', (_e, reason) => collapse(reason || 'renderer'));
ipcMain.on('panel:request-close', (_e, reason) => requestClose(reason || 'renderer-request'));

// 用户碰到面板 → 拿焦点（悬停展开时之前是不抢焦点的，会导致 Esc 没接收者）
ipcMain.on('panel:grab-focus', () => {
  if (panelWin && !panelWin.isDestroyed() && state !== 'collapsed') {
    try { panelWin.setFocusable(true); panelWin.focus(); } catch (e) { log('[focus] 失败', e.message); }
  }
});

ipcMain.on('panel:close-result', (_e, res) => {
  clearTimeout(closeGuard);
  if (res && res.handled) { log('[close] 页面退了一层'); return; }
  collapse((res && res.reason) || 'renderer');
});

// 页面动画播完 → 记录耗时
ipcMain.on('panel:anim-done', () => {
  if (!expandingAt) return;
  log('[timing] 展开动画播完', (Date.now() - expandingAt) + 'ms');
  expandingAt = 0;
});

// 从控制台里启动程序（第二步“快捷启动”就用这个口子）：
// 启动的同时把自己收起来，绝不挡着刚打开的软件。
ipcMain.handle('app:launch', async (_e, payload) => {
  const p = payload || {};
  log('[launch] 请求', p.path, p.args || '');
  const r = await launchAndHide(p.path, p.args);
  if (r && r.ok === false) log('[launch] 失败', r.error);
  return r;
});

ipcMain.handle('media:get', () => mediaLast);

// ---------------- 通知：读 / 删 / 清空 / 标记已读 ----------------
ipcMain.handle('notif:list', () => ({ items: notifList, unread: notifUnread, access: notifAccess }));

ipcMain.handle('notif:read', () => {
  if (notifUnread !== 0) {
    notifUnread = 0;
    pushNotifState();
  }
  return { ok: true };
});

ipcMain.handle('notif:remove', (_e, id) => {
  const nid = String(id || '');
  const before = notifList.length;
  notifList = notifList.filter((n) => n.id !== nid);
  if (notifList.length === before) return { ok: false };
  if (notifUnread > 0) notifUnread = Math.max(0, notifUnread - 1);
  pushNotifState();
  return { ok: true };
});

ipcMain.handle('notif:clear', () => {
  notifList = [];
  notifUnread = 0;
  pushNotifState();
  return { ok: true };
});

// ---------------- 快捷启动：增删改 ----------------
// 注意：弹系统文件选择框会让窗口失焦，而失焦=收起。所以弹框期间挂个“别收”的牌子。
let pickingApps = false;

ipcMain.handle('apps:list', async () => {
  // 早期版本对 .lnk 取图标会拿到通用白纸，且写进 apps.json 缓存了下来。
  // 这里按 ICONS_VER 做一次性重算：老数据自动升级，用户不用删了重加。
  let ver = '';
  try { ver = fs.readFileSync(ICONS_VER_PATH, 'utf8').trim(); } catch (e) { ver = ''; }
  if (ver !== ICONS_VER) {
    for (const a of apps) {
      const ico = await iconOf(a.path);
      if (ico) a.icon = ico;
    }
    saveApps();
    try { fs.writeFileSync(ICONS_VER_PATH, ICONS_VER, 'utf8'); } catch (e) { /* 无所谓 */ }
    log('[apps] 图标已按新版规则重算', apps.length, '个');
  } else {
    for (const a of apps) {
      if (!a.icon) {
        const ico = await iconOf(a.path);
        if (ico) { a.icon = ico; saveApps(); }
      }
    }
  }
  return apps;
});

ipcMain.handle('apps:add', async () => {
  if (!panelWin || panelWin.isDestroyed()) return { ok: false, error: '面板没准备好' };
  pickingApps = true;
  let picked = [];
  try {
    const r = await dialog.showOpenDialog(panelWin, {
      title: '选择要放进控制台的软件',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      defaultPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
      filters: [
        { name: '快捷方式 / 程序', extensions: ['lnk', 'url', 'exe', 'bat', 'cmd'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (!r.canceled) picked = r.filePaths || [];
  } catch (e) {
    log('[apps] 选文件失败', e.message);
    return { ok: false, error: e.message };
  } finally {
    pickingApps = false;
  }
  if (!picked.length) return { ok: true, added: 0 };

  let added = 0;
  for (const file of picked) {
    if (apps.some(a => a.path.toLowerCase() === file.toLowerCase())) continue;
    const base = path.basename(file).replace(/\.(lnk|url|exe|bat|cmd)$/i, '');
    apps.push({
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: base,
      path: file,
      icon: await iconOf(file),
    });
    added++;
  }
  if (added) saveApps();
  log('[apps] 添加', added, '条，现在共', apps.length);
  return { ok: true, added, apps };
});

ipcMain.handle('apps:remove', (_e, id) => {
  const before = apps.length;
  apps = apps.filter(a => a.id !== id);
  if (apps.length !== before) saveApps();
  log('[apps] 删除', id, '现在共', apps.length);
  return { ok: true, apps };
});

// 拖拽排序：页面把新顺序的 id 数组发上来，我们照着重排（只认认识的 id，防止页面瞎传）
ipcMain.handle('apps:reorder', (_e, ids) => {
  if (!Array.isArray(ids)) return { ok: false, apps };
  const map = new Map(apps.map(a => [a.id, a]));
  const next = [];
  for (const id of ids) {
    const a = map.get(id);
    if (a) { next.push(a); map.delete(id); }
  }
  for (const a of map.values()) next.push(a);
  apps = next;
  saveApps();
  log('[apps] 排序已保存');
  return { ok: true, apps };
});

// 改名字（自定义名称）
ipcMain.handle('apps:rename', (_e, payload) => {
  const p = payload || {};
  const a = apps.find(x => x.id === p.id);
  if (!a) return { ok: false, error: '没有这一条' };
  const name = String(p.name || '').trim().slice(0, 24);
  if (!name) return { ok: false, error: '名字不能是空的' };
  a.name = name;
  saveApps();
  log('[apps] 改名', a.path, '→', name);
  return { ok: true, apps };
});


// 页面点播放/切歌时走这里：把命令写进小文件，小助手读走执行
ipcMain.on('media:cmd', (_e, payload) => {
  const p = payload || {};
  if (!p.action) return;
  const seq = ++mediaSeq;
  const body = { seq, action: String(p.action) };
  if (typeof p.position === 'number' && isFinite(p.position)) body.position = p.position;
  try {
    fs.writeFileSync(mediaCmdFile, JSON.stringify(body), 'utf8');
    log('[media] 命令', body.action, body.position === undefined ? '' : Math.round(body.position) + 's');
  } catch (e) {
    log('[media] 写命令失败', e.message);
  }
});

ipcMain.on('backdrop:refresh', () => {
  // 展开状态下刷新底图：先把面板藏起来 30ms 再拍，拍到的是干净的桌面
  if (!panelWin || state !== 'expanded') return;
  panelWin.setOpacity(0);
  setTimeout(async () => {
    const shot = await grabBackdrop();
    if (panelWin && !panelWin.isDestroyed()) {
      panelWin.setOpacity(1);
      if (shot) panelWin.webContents.send('view:backdrop', { data: shot });
    }
  }, 40);
});

// ---------- 壁纸模块 IPC ----------
ipcMain.handle('wall:list', () => listWallpapers());

ipcMain.handle('wall:apply', async (_e, id) => {
  const list = listWallpapers();
  if (!list.ok) return list;
  const item = (list.items || []).find((x) => x.id === String(id));
  if (!item) return { ok: false, error: '没找到这个壁纸：' + id };
  const r = await weRun(`-control openWallpaper -file "${item.project}"`);
  log('[wall] 切换', item.title, r.ok ? '已发出' : r.error);
  return r;
});

ipcMain.handle('wall:control', async (_e, action) => {
  const map = { stop: '-control stop', play: '-control play', mute: '-control mute', unmute: '-control unmute' };
  const arg = map[String(action)];
  if (!arg) return { ok: false, error: '不支持的操作：' + action };
  const r = await weRun(arg);
  log('[wall] 控制', action, r.ok ? '已发出' : r.error);
  return r;
});

ipcMain.handle('wall:open', async () => {
  const install = findWe();
  if (!install) return { ok: false, error: '没找到 Wallpaper Engine' };
  const exe = path.join(install, process.arch === 'ia32' ? 'wallpaper32.exe' : 'wallpaper64.exe');
  const err = await shell.openPath(exe);
  return err ? { ok: false, error: err } : { ok: true };
});

// ---------------- 单实例 ----------------
// 开机自启 + 手动双击很容易同时起来两个：那会出现两个托盘图标、两套媒体/通知小助手，
// 互相抢同一个临时文件。所以只允许一个实例，第二次启动直接让它退出，
// 顺便把已经存在的那一个叫到前面来（用户体感是“点了就出来”）。
if (!app.requestSingleInstanceLock()) {
  log('[single] 已经有一个控制台在跑，这次启动直接退出');
  app.exit(0);
} else {
  app.on('second-instance', () => {
    log('[single] 又启动了一次，把现有控制台叫出来');
    if (fullscreenOn) { fsOverride = true; hiddenByFullscreen = false; }
    expand({ focus: true, reason: 'second-instance' });
  });
}

// ---------------- 启动 ----------------
app.whenReady().then(() => {
  app.setAppUserModelId('com.deskpanel.app');
  loadSettings();
  // 扩展坞永远从“收起”开始：打开控制台只给主四宫格，展开要用户自己点箭头
  dockOpen = false;
  loadApps();

  // 开机自启：只有第一次运行（settings.json 里没这个字段）才自动写一次注册表，
  // 之后完全听用户的（页面开关 / 托盘勾选），我们不擅自改回来。
  if (settingsNeedsLoginSync) applyLoginItem(true);

  // 实时背景：把“屏幕本身”作为一路视频流给面板页面（不落地、不存盘）。
  // 页面里用 CSS filter: blur() 现糊现用，所以背后开抖音/换壁纸都是实时变化的。
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (!sources || !sources.length) { callback({}); return; }
        callback({ video: sources[0] });
      } catch (e) {
        log('[live] 取屏幕源失败', e.message);
        callback({});
      }
    }, { useSystemPicker: false });
  } catch (e) {
    log('[live] 注册屏幕流处理器失败', e.message);
  }

  createWindows();
  createTray();
  startFullscreenWatch();
  startMediaHelper();
  startNotifHelper();

  // 全局快捷键：Ctrl+Alt+空格 —— 显示 / 隐藏 来回切。
  // 全屏游戏里也允许按：此时给它一个“例外通行证”，不再被自动隐藏顶掉。
  const accel = 'CommandOrControl+Alt+Space';
  const ok = globalShortcut.register(accel, () => {
    log('[hotkey]', accel, state, fullscreenOn ? '(全屏中)' : '');
    if (state === 'expanded') {
      collapse('hotkey');
      return;
    }
    if (fullscreenOn) {
      fsOverride = true;
      hiddenByFullscreen = false;
    }
    expand({ focus: true, reason: 'hotkey' });
  });
  log('[hotkey] 注册', accel, ok ? '成功' : '失败（可能被别的软件占用）');
  // 开机就把底图抓一份，第一次展开不用等
  setTimeout(() => grabBackdrop(), 1200);

  if (AUTOMATION) {
    const js = (code) => panelWin && panelWin.webContents.executeJavaScript(code).catch(() => {});
    setTimeout(() => expand({ focus: false, reason: 'auto' }), 2500);
    setTimeout(() => js("window.__dumpLive && window.__dumpLive()"), 3600);
    setTimeout(() => js("document.querySelector('.cell[data-module=\"launch\"]').click()"), 6000);
    setTimeout(() => js("(function(){ document.getElementById('btn-gear').click(); })()"), 7500);
    setTimeout(() => js(
      "(function(){ var r=document.getElementById('r-opacity');" +
      " r.value=12; r.dispatchEvent(new Event('input')); })()"
    ), 8000);
    setTimeout(() => js(
      "(function(){ var r=document.getElementById('r-opacity');" +
      " r.value=70; r.dispatchEvent(new Event('input')); })()"
    ), 9500);
    setTimeout(() => js("(function(){ document.getElementById('btn-gear').click(); })()"), 11000);
    // 测试“点开应用后自动收起”：真的去启动一个程序
    setTimeout(() => js("window.panel.launchApp('C:\\\\Windows\\\\System32\\\\cmd.exe')"), 12000);
    setTimeout(() => requestClose('auto-outside'), 16000);
    setTimeout(() => collapse('auto-end'), 17000);
  }
});

app.on('window-all-closed', () => {});

// 退出时把小助手一起收掉，别留个 PowerShell 在后台转圈
app.on('before-quit', () => {
  if (mediaTimer) { clearInterval(mediaTimer); mediaTimer = null; }
  killMediaHelper();
  if (notifTimer) { clearInterval(notifTimer); notifTimer = null; }
  killNotifHelper();
  // 退出即清：把通知的临时文件删干净（内存里的本来就跟进程一起没了）
  notifList = [];
  notifSeen.clear();
  for (const f of [notifStateFile, notifPidFile]) {
    try { fs.rmSync(f, { force: true }); } catch (e) { }
  }
});
