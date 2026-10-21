// =====================================================================
//  右上角控制台 · 页面逻辑  v1.9
//
//  这一版的关键约定：
//   · 面板窗口尺寸永远不变（380×268），所以这里不做任何“跟着窗口大小缩放”的事；
//   · 展开/收起只动一个元素（.glass）的 transform + opacity，GPU 合成，不触发重排；
//   · 玻璃底图是主进程抓的“背后桌面照片”，垫在 .glass 里面一起动，所以内外同步。
// =====================================================================
const API = window.panel;
const KIND = API ? API.kind : 'panel';
const NO_LIVE = API ? !!API.noLive : false;
const DEBUG = location.search.includes('debug=1');
const log = (...a) => { if (DEBUG) console.log(...a); };

// 出错时把“到底哪一行”打出来（否则只能看到一句 Uncaught TypeError）
window.addEventListener('error', (e) => {
  console.log('[error]', e.message, '→', e.filename, 'line', e.lineno, 'col', e.colno);
  if (e.error && e.error.stack) console.log('[stack]', e.error.stack.replace(/\n/g, ' | '));
});

// 动画参数要和主进程一致（320ms 展开 / 260ms 收起）
const EXPAND_MS = 320;
const COLLAPSE_MS = 260;
const STRIP_W = 48, STRIP_H = 140;      // 窄条尺寸
const PANEL_W = 380, PANEL_H = 268;     // 面板尺寸
const TOP_GAP = 25;                     // 面板离工作区顶部
const STRIP_TOP = 140;                  // 窄条离工作区顶部
const S0 = STRIP_W / PANEL_W;           // 起始缩放 ≈ 0.126
const DY0 = (STRIP_TOP - TOP_GAP) + STRIP_H / 2 - (PANEL_H * S0) / 2;  // 让缩放后的小块落在窄条中心

// ---------------- 窄条 ----------------
if (KIND === 'strip') {
  const strip = document.getElementById('strip');
  strip.hidden = false;
  document.body.classList.add('is-strip');
  // 硬核保险：这个窗口里根本不该存在面板那一坨 DOM，直接删掉，
  // 这样“点到看不见的按钮”在物理上就不可能发生。
  const strayPanel = document.getElementById('panel');
  if (strayPanel) strayPanel.remove();

  // 打开方式只有一个：点击。
  // （悬停自动展开已经按用户要求彻底删除，相关 mouseenter / 定时器全部清掉）
  strip.addEventListener('mousedown', () => { strip.classList.add('press'); });
  strip.addEventListener('mouseup', () => { strip.classList.remove('press'); });
  // 用 pointerdown 直接展开：不等 click（click 要等鼠标抬起，还可能被别的因素吞掉）。
  // 收起状态下这条边只做一件事——展开，绝不会碰到里面的任何按钮。
  strip.addEventListener('pointerdown', (e) => {
    log('strip pointerdown', Math.round(e.clientX), Math.round(e.clientY));
    API && API.expand({ focus: true, reason: 'strip-down' });
  });
  strip.addEventListener('click', () => {
    log('strip click');
    API && API.expand({ focus: true, reason: 'click' });
  });

  // 输入探针：鼠标事件到底有没有送到这个窗口（排查“点不动”用）
  let movedOnce = false;
  document.addEventListener('mousemove', (e) => {
    if (movedOnce) return;
    movedOnce = true;
    log('first mousemove', Math.round(e.clientX), Math.round(e.clientY));
  });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    log('pointerdown', Math.round(e.clientX), Math.round(e.clientY),
      'target=', t && t.id ? '#' + t.id : (t && t.className) || String(t));
  });
}

// ---------------- 面板 ----------------
if (KIND === 'panel') {
  const panelEl = document.getElementById('panel');
  const glass = document.getElementById('glass');
  const backdrop = document.getElementById('backdrop');
  const live = document.getElementById('live');
  const settings = document.getElementById('settings');
  const stage = document.querySelector('.stage');
  const l2 = document.getElementById('view-l2');
  const t1 = document.getElementById('t1');
  const t2 = document.getElementById('t2');
  const modTitle = document.getElementById('mod-title');
  const modSub = document.getElementById('mod-sub');
  const btnGear = document.getElementById('btn-gear');
  const btnBack = document.getElementById('btn-back');
  const btnClose = document.getElementById('btn-close');
  const rOpacity = document.getElementById('r-opacity');
  const rBlur = document.getElementById('r-blur');
  const vOpacity = document.getElementById('v-opacity');
  const vBlur = document.getElementById('v-blur');
  const cLogin = document.getElementById('c-login');
  const vLogin = document.getElementById('v-login');
  const tLogin = document.getElementById('t-login');
  // 设置里的「提醒方式」：系统通知 / 应用内气泡
  const cNotify = document.getElementById('c-notify');
  const hintEsc = document.getElementById('hint-esc');

  // 音乐模块
  const modBody = document.getElementById('mod-body');
  const modMusic = document.getElementById('mod-music');
  const mTitle = document.getElementById('m-title');
  const mArtist = document.getElementById('m-artist');
  const mCur = document.getElementById('m-cur');
  const mDur = document.getElementById('m-dur');
  const mSeek = document.getElementById('m-fill');
  const mBar = mSeek ? mSeek.parentElement : null;
  const mPlay = document.getElementById('m-play');
  const mPrev = document.getElementById('m-prev');
  const mNext = document.getElementById('m-next');
  const mArtImg = document.getElementById('m-art-img');
  const mArtIco = document.getElementById('m-art-ico');
  const mVol = document.getElementById('m-vol');
  const mVolT = document.getElementById('m-vol-t');
  const mPlayIco = document.getElementById('m-play-ico');

  // 壁纸模块
  const modWall = document.getElementById('mod-wall');
  const wGrid = document.getElementById('w-grid');
  const wCur = document.getElementById('w-cur');
  const wStop = document.getElementById('w-stop');
  const wPlay = document.getElementById('w-play');
  const wOpen = document.getElementById('w-open');

  // 通知模块
  const modNotify = document.getElementById('mod-notify');
  const nList = document.getElementById('n-list');
  const nEmpty = document.getElementById('n-empty');
  const nClear = document.getElementById('n-clear');
  const nBadge = document.getElementById('n-badge');

  // 快捷启动模块
  const lGrid = document.getElementById('l-grid');
  const lAdd = document.getElementById('l-add');
  const lBrowse = document.getElementById('l-browse');
  const lEmpty = document.getElementById('l-empty');
  const lHint = document.getElementById('l-hint');

  // 效率工具（便签 / 待办）
  const modEff = document.getElementById('mod-eff');
  const eBadge = document.getElementById('e-badge');
  const eTabNote = document.getElementById('e-tab-note');
  const eTabTodo = document.getElementById('e-tab-todo');
  const eLeadWrap = document.getElementById('e-lead-wrap');
  const eLead = document.getElementById('e-lead');
  const ePaneNote = document.getElementById('e-pane-note');
  const ePaneTodo = document.getElementById('e-pane-todo');
  const eNoteInput = document.getElementById('e-note-input');
  const eNoteSave = document.getElementById('e-note-save');
  const eNoteList = document.getElementById('e-note-list');
  const eNoteEmpty = document.getElementById('e-note-empty');
  const eNoteCount = document.getElementById('e-note-count');
  const eTodoText = document.getElementById('e-todo-text');
  const eTodoTime = document.getElementById('e-todo-time');
  const eTodoPrio = document.getElementById('e-todo-prio');
  const eTodoAdd = document.getElementById('e-todo-add');
  const eTodoList = document.getElementById('e-todo-list');
  const eTodoEmpty = document.getElementById('e-todo-empty');

  panelEl.hidden = false;
  // 面板窗口里也不需要窄条那套 DOM，一并删掉，避免任何遮挡/穿透
  const strayStrip = document.getElementById('strip');
  if (strayStrip) strayStrip.remove();
  let level = 1;
  let current = null;
  let settingsOpen = false;

  // 调试：面板里点到了什么（定位“点了没反应”用）
  document.addEventListener('pointerdown', (e) => {
    // 用户一碰面板就把键盘焦点要过来：否则（悬停展开时）Esc 没有接收者，按了像没反应
    if (API && API.grabFocus) API.grabFocus();
    const t = e.target;
    log('panel pointerdown', Math.round(e.clientX), Math.round(e.clientY),
      'target=', t && t.id ? '#' + t.id : (t && t.className) || String(t));
  });

  // ---------- 实时背景（屏幕视频流，不是截图） ----------
  // 原理：主进程把“整个屏幕”作为一路视频流交给这个页面，页面把这块视频按
  // “面板在屏幕上的位置”精确摆到玻璃下面，再用 CSS filter: blur() 实时模糊。
  // 所以背后开着抖音/换壁纸，玻璃里是跟着动的。
  let liveInfo = null;
  // 模糊层“降分辨率渲染”：元素按 1/K 的尺寸布局，再用 transform 放大 K 倍，
  // 模糊半径同样除以 K —— 观感一样，但 GPU 要糊的像素少了 K² 倍（40px 全屏模糊太重，
  // 玻璃一改尺寸就要重算一遍，这就是抽屉动画卡顿的来源）。
  const LIVE_DOWN = 3;

  function placeLive() {
    if (!liveInfo) return;
    const [wStr, hStr] = String(liveInfo.size).split('×');
    const cssW = Number(wStr) / liveInfo.scale;
    const cssH = Number(hStr) / liveInfo.scale;
    const k = LIVE_DOWN;
    live.style.width = (cssW / k) + 'px';
    live.style.height = (cssH / k) + 'px';
    live.style.left = (-liveInfo.contentPos.x / k) + 'px';
    live.style.top = (-liveInfo.contentPos.y / k) + 'px';
    live.style.transformOrigin = '0 0';
    live.style.transform = `scale(${k})`;
  }

  async function startLive() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      log('live 不支持');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // 故意要低分辨率：一是省 GPU，二是把“拍到面板自己”的那层虚影糊得更淡
        video: { frameRate: 30, width: 640, height: 360 },
        audio: false,
      });
      live.srcObject = stream;
      await live.play().catch(() => {});
      glass.classList.add('is-live');
      placeLive();
      const track = stream.getVideoTracks()[0];
      if (track) track.onended = () => glass.classList.remove('is-live');
      log('live 已启动', live.videoWidth + 'x' + live.videoHeight);
    } catch (e) {
      log('live 启动失败', e.message);
    }
  }

  // 实时桌面视频开关：面板显示期间关掉（见 onState 里的注释：避免自己拍自己造成闪烁）
  function setLiveEnabled(on) {
    if (!glass) return;
    if (on) {
      if (live.srcObject) glass.classList.add('is-live');
    } else {
      glass.classList.remove('is-live');
    }
  }

  // 从背景画面里取一小块算平均亮度，决定用深色字还是白色字。
  // 优先用实时视频；实时关掉时用主进程拍的静态底图（两者都代表“面板背后是什么”）。
  // 判定结果直接落到 body 的 .on-light 上——字、图标、卡片底、描边一起换，
  // 不会出现“字变黑了但图标还是白的”这种半截状态。
  const LUMA_LIGHT = 0.55;   // 取 65 分位的亮度，超过它就换深色字
  let lastLuma = 0.5;        // 关掉自定义染色时要靠它恢复字色
  function applyTone(luma) {
    // 开了自定义背景色时，玻璃的底色由用户选的颜色决定，
    // 这时候不该再按“背后的桌面亮不亮”来换字色（否则深色主题配深色字）。
    if (document.body.classList.contains('has-tint')) {
      // 染色时字色由「桌面亮度 + 色相亮度」的混合结果决定，所以这里不能直接 return：
      // 记下新亮度，再让 applyTint 重算一次（否则启动那一刻算出来的字色会一直用下去）。
      lastLuma = luma;
      applyTint(tint, true);
      return;
    }
    const light = luma > LUMA_LIGHT;
    lastLuma = luma;
    if (document.body.classList.contains('on-light') === light) return;
    document.body.classList.toggle('on-light', light);
    log('[tone] 背景亮度', luma.toFixed(2), light ? '→ 深色字' : '→ 白色字');
  }

  // 平均亮度会被“一大片黑窗框”拉低（黑白壁纸就是典型），导致明明背景很亮却判定成暗。
  // 改用 65 分位亮度：只要“相当一部分区域是亮的”就按亮背景处理，字更稳。
  function toneLuma(ctx, w, h) {
    const px = ctx.getImageData(0, 0, w, h).data;
    const arr = [];
    for (let i = 0; i < px.length; i += 4 * 7) {
      arr.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    }
    if (!arr.length) return 0.5;
    arr.sort((a, b) => a - b);
    const idx = Math.min(arr.length - 1, Math.floor(arr.length * 0.65));
    return arr[idx] / 255;
  }

  function sampleInk() {
    const useLive = glass.classList.contains('is-live') && live.videoWidth;
    const bd = document.querySelector('.backdrop');
    const useBd = !useLive && bd && bd.src && bd.complete && bd.naturalWidth;
    if (!useLive && !useBd) return;
    try {
      const c = document.createElement('canvas');
      c.width = 32; c.height = 24;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(useLive ? live : bd, 0, 0, 32, 24);
      const luma = toneLuma(ctx, 32, 24);
      applyTone(luma);
      log('背景平均亮度', luma.toFixed(2), useLive ? '(live)' : '(backdrop)');
    } catch (e) { log('取样失败', e.message); }
  }

  // 调试：把当前实时帧存一份（主程序会写到 shots\live-frame.jpg）
  function dumpLiveFrame() {
    if (!live.videoWidth || !API || !API.saveLive) return;
    try {
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720;
      c.getContext('2d').drawImage(live, 0, 0, 1280, 720);
      API.saveLive(c.toDataURL('image/jpeg', 0.85));
    } catch (e) { log('存帧失败', e.message); }
  }

  // ---------- 外观变量 ----------
  function applyLook(op, blur) {
    const root = document.documentElement.style;
    root.setProperty('--op', String(op));
    root.setProperty('--blur', blur + 'px');
    vOpacity.textContent = Math.round(op * 100) + '%';
    vBlur.textContent = blur + 'px';
    rOpacity.value = String(Math.round(op * 100));
    rBlur.value = String(blur);
  }

  // ---------- 展开 / 收起动画（只动 transform + opacity） ----------
  // 起始偏移要按“当前窗口实际高度”现算：扩展坞展开后窗口是 434 高，
  // 还用写死的 268 算，缩小的那块就落不到窄条中心、动画会歪。
  function dynDY0() {
    const w = window.innerWidth || PANEL_W;
    const h = window.innerHeight || PANEL_H;
    const s0 = STRIP_W / w;
    return (STRIP_TOP - TOP_GAP) + STRIP_H / 2 - (h * s0) / 2;
  }

  function animateOpen() {
    if (current) current.cancel();
    current = glass.animate([
      { transform: `translateY(${dynDY0()}px) scale(${STRIP_W / (window.innerWidth || PANEL_W)})`, opacity: 0, borderRadius: '12px' },
      { transform: 'translateY(0px) scale(1)', opacity: 1, borderRadius: '20px' },
    ], {
      duration: EXPAND_MS,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'both',
    });
    current.onfinish = () => {
      glass.style.transform = 'none';
      glass.style.opacity = '1';
      if (API) API.animDone();
    };
  }

  function animateClose() {
    if (current) current.cancel();
    current = glass.animate([
      { transform: 'translateY(0px) scale(1)', opacity: 1, borderRadius: '20px' },
      { transform: `translateY(${dynDY0()}px) scale(${STRIP_W / (window.innerWidth || PANEL_W)})`, opacity: 0, borderRadius: '12px' },
    ], {
      duration: COLLAPSE_MS,
      easing: 'cubic-bezier(0.4, 0, 0.7, 0.2)',
      fill: 'both',
    });
  }

  // ---------- 卡片 = 工作区（同一个实体放大 / 缩回） ----------
  // 没有第二层 overlay：点开的卡片自己从格子位置长到舞台中央，关上时原路缩回。
  // 卡片的 DOM 全程是同一个节点，里面的 .work 装着它自己的工作区。
  let openState = null;      // { id, ghost, parent }
  let openAnim = null;
  let openSeq = 0;
  let cardsTimer = 0;

  const MODULES = {
    launch: { title: '快捷启动', sub: '添加 / 排序 / 启动软件' },
    music: { title: '音乐', sub: '控制当前播放器' },
    wallpaper: { title: '壁纸', sub: 'Wallpaper Engine' },
    notify: { title: '通知', sub: '授权 / 脱敏列表' },
    efficiency: { title: '效率工具', sub: '便签 / 待办' },
  };

  // 整个控制台一收起（Esc / 点外部 / 快捷键 / 点 ✕），内部状态必须强制回到“主四宫格”。
  function resetView() {
    if (settingsOpen) toggleSettings(false);
    exitEditing();
    if (level === 2) closeCard(true);
    log('[reset] 收起后视图重置为四宫格');
  }

  function setHeader(n, mod) {
    const meta = n === 2 ? MODULES[mod] : null;
    if (meta) {
      t1.textContent = meta.title;
      t2.textContent = '点空白 / Esc 返回上一级';
      hintEsc.textContent = 'Esc 返回四宫格';
    } else {
      t1.textContent = '控制台';
      t2.textContent = '阶段 1.9 · 整块玻璃';
      hintEsc.textContent = 'Esc / 点外部 收起';
    }
    btnBack.hidden = n !== 2;
    btnGear.style.display = n === 2 ? 'none' : '';
  }

  function openCard(el) {
    if (!el || level === 2 || editing || openState) return;
    el.classList.remove('closing');
    const rec = cards.get(el.dataset.module);
    if (!rec) return;
    const src = el.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const parent = el.parentNode;
    const ghost = document.createElement('div');
    ghost.className = 'cell-ghost';
    parent.insertBefore(ghost, el);
    // 同一个节点搬到舞台上，从格子矩形长到铺满舞台
    stage.appendChild(el);
    el.classList.add('open');
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    const from = `translate(${src.left - s.left}px, ${src.top - s.top}px) scale(${src.width / s.width}, ${src.height / s.height})`;
    el.style.transformOrigin = '0 0';
    el.style.transform = from;
    if (rec.mod) rec.mod.hidden = false;
    document.body.classList.add('module-open');
    level = 2;
    stage.dataset.level = '2';
    setHeader(2, el.dataset.module);
    if (el.dataset.module === 'efficiency') loadEff();
    if (openAnim) { try { openAnim.cancel(); } catch (e) {} }
    setSortableEnabled(false);
    const token = ++openSeq;
    // CSS transition + transitionend，不用 setTimeout 死等
    el.style.transition = 'none';
    el.style.transform = from;
    void el.offsetWidth;
    el.style.transition = 'transform 340ms cubic-bezier(0.2, 0.9, 0.24, 1)';
    el.style.transform = 'none';
    el.addEventListener('transitionend', function onEnd(ev) {
      if (ev.propertyName !== 'transform') return;
      el.removeEventListener('transitionend', onEnd);
      if (token !== openSeq) return;
      el.style.transition = '';
      el.style.transform = '';
    });
    openState = { id: el.dataset.module, ghost, parent };
  }

  function finishClose(el, rec, ghost, parent) {
    document.body.classList.remove('module-open');
    openState = null;
    // 同一帧：藏掉动画层 + 立刻亮出四宫格（先禁掉 l1 的 opacity 过渡，避免淡入缓冲）
    const l1 = document.getElementById('view-l1');
    if (l1) l1.style.transition = 'none';
    level = 1;
    stage.dataset.level = '1';
    if (el) {
      el.classList.remove('open');
      el.classList.remove('closing');
      el.style.position = '';
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.height = '';
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.style.transition = '';
      el.style.pointerEvents = '';
      if (rec && rec.mod) rec.mod.hidden = true;
      if (parent && ghost && ghost.parentNode) parent.insertBefore(el, ghost);
    }
    if (ghost && ghost.parentNode) ghost.remove();
    if (l1) { void l1.offsetWidth; l1.style.transition = ''; }
    setHeader(1);
    setSortableEnabled(true);
  }

  function closeCard(instant) {
    if (level !== 2 || !openState) return;
    const st = openState;
    if (st.closing && !instant) return;
    st.closing = true;
    const rec = cards.get(st.id);
    const el = rec && rec.el;
    document.body.classList.remove('module-open');   // 扩展区在缩回过程中要露出来
    if (openAnim) { try { openAnim.cancel(); } catch (e) {} openAnim = null; }
    if (!el || !st.ghost || !st.ghost.isConnected) {
      finishClose(el, rec, st.ghost, st.parent);
      return;
    }
    const s = stage.getBoundingClientRect();
    const g = st.ghost.getBoundingClientRect();
    const to = `translate(${g.left - s.left}px, ${g.top - s.top}px) scale(${g.width / s.width}, ${g.height / s.height})`;
    // 内容先淡出：到 80% 前必须全透明，绝不能缩到卡片大小还挤着大界面的字
    el.classList.add('closing');
    if (instant) {
      ++openSeq;
      el.style.transformOrigin = '0 0';
      el.style.transform = to;
      finishClose(el, rec, st.ghost, st.parent);
      return;
    }
    const token = ++openSeq;
    el.style.transition = 'transform 320ms cubic-bezier(0.45, 0.05, 0.2, 1)';
    el.style.transform = to;
    el.addEventListener('transitionend', function onEnd(ev) {
      if (ev.target !== el || ev.propertyName !== 'transform') return;
      el.removeEventListener('transitionend', onEnd);
      if (token !== openSeq) return;
      finishClose(el, rec, st.ghost, st.parent);
    });
  }

  function enterModule(el, mod) {
    const c = cards.get(mod);
    if (c) openCard(c.el);
  }
  function exitModule() { closeCard(false); }

  document.addEventListener('click', (e) => {
    if (level !== 2) return;
    const inMod = !!(e.target.closest && e.target.closest('.mod'));
    if (inMod) return;
    if (e.target.closest('button')) return;
    if (e.target.closest('.settings')) return;
    exitModule();
  });

  // 面板窗口永远是 434 高（这样抽屉动画才不用改窗口尺寸）。
  // 扩展坞收起时，下面那 132px 是透明的、但窗口还在——点那里必须当“点到了控制台外面”，
  // 直接把整个面板收起来（否则会像点了块死玻璃）。
  document.addEventListener('pointerdown', (e) => {
    if (!document.body.classList.contains('dock-clip')) return;   // 扩展区展开着就别管
    if (e.clientY <= 302) return;
    if (API && API.collapse) API.collapse('below-strip');
  }, true);

  // ---------- 音乐：显示与操作 ----------
  // 状态由主进程推来（主进程读小助手写的 JSON），这里只管画和发命令。
  let mediaState = null;
  let mediaAt = 0;          // 收到状态的时刻：两次更新之间用它推算进度
  let mediaCoverUrl = '';

  const fmt = (s) => {
    const v = Math.max(0, Math.round(Number(s) || 0));
    return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
  };

  function setPlayIco(playing) {
    mPlayIco.firstChild.setAttribute('d', playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
  }

  // 进度条：只画宽度，不接受任何点击/拖动
  function setFill(pos, dur) {
    if (!mSeek) return;
    const p = Number(pos) || 0;
    const d = Number(dur) || 0;
    const pct = d > 0 ? Math.max(0, Math.min(100, (p / d) * 100)) : 0;
    mSeek.style.width = pct.toFixed(2) + '%';
  }

  // 封面：主进程从系统媒体接口取到缩略图后写成临时文件，这里直接显示；
  // 拿不到（播放器不给封面 / 还没放歌）就退回那枚音符图标。
  function setCover(url) {
    if (!mArtImg || !mArtIco) return;
    if (!url) {
      if (mediaCoverUrl) { mediaCoverUrl = ''; mArtImg.removeAttribute('src'); }
      mArtImg.hidden = true;
      mArtIco.hidden = false;
      return;
    }
    if (url === mediaCoverUrl) return;
    mediaCoverUrl = url;
    mArtImg.onerror = () => {
      mArtImg.hidden = true;
      mArtIco.hidden = false;
    };
    mArtImg.onload = () => {
      mArtImg.hidden = false;
      mArtIco.hidden = true;
    };
    mArtImg.src = url;
  }

  // 音量滑块：拖动时先按本地值显示，1.5 秒内不让后台回读把它拽回去
  let volHold = 0;
  let volTimer = 0;

  function setVol(v) {
    const has = typeof v === 'number' && v >= 0;
    mVol.disabled = !has;
    if (!has) {
      mVolT.textContent = '—';
      return;
    }
    const pct = Math.round(v * 100);
    if (performance.now() > volHold) mVol.value = String(pct);
    mVolT.textContent = pct + '%';
  }

  function renderMedia(st) {
    mediaState = st;
    mediaAt = performance.now();
    if (!st || !st.ok) {
      mTitle.textContent = '未在播放';
      mArtist.textContent = '打开 QQ 音乐放一首歌';
      mCur.textContent = '0:00';
      mDur.textContent = '0:00';
      setFill(0, 0);
      setCover('');
      setVol(-1);
      mPlay.disabled = true;
      mPrev.disabled = true;
      mNext.disabled = true;
      setPlayIco(false);
      return;
    }
    const playing = !!st.playing;
    mTitle.textContent = st.title || '未命名曲目';
    mArtist.textContent = [st.artist, st.album].filter(Boolean).join(' · ') || st.app || '未知来源';
    mCur.textContent = fmt(st.position);
    mDur.textContent = fmt(st.duration);
    setFill(st.position, st.duration);
    setCover(st.coverUrl || '');
    setVol(Number(st.volume));
    mPlay.disabled = !(st.canPlay || st.canPause);
    mPrev.disabled = !st.canPrev;
    mNext.disabled = !st.canNext;
    setPlayIco(playing);
  }

  // 两次状态更新之间自己往前推一点，进度条才不会一格一格跳
  setInterval(() => {
    if (!mediaState || !mediaState.ok || !mediaState.playing) return;
    const dt = (performance.now() - mediaAt) / 1000;
    const pos = (mediaState.position || 0) + dt;
    mCur.textContent = fmt(pos);
    setFill(pos, mediaState.duration || 0);
  }, 250);

  mPlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!mediaState || !mediaState.ok) return;
    API && API.mediaCmd(mediaState.playing ? 'pause' : 'play');
  });
  mPrev.addEventListener('click', (e) => { e.stopPropagation(); API && API.mediaCmd('prev'); });
  mNext.addEventListener('click', (e) => { e.stopPropagation(); API && API.mediaCmd('next'); });

  // 拖音量：边拖边发（80ms 节流），松手再补一次，避免拖动时刷 60 次命令
  mVol.addEventListener('input', (e) => {
    e.stopPropagation();
    const v = Number(mVol.value);
    mVolT.textContent = v + '%';
    volHold = performance.now() + 1500;
    clearTimeout(volTimer);
    volTimer = setTimeout(() => { API && API.mediaCmd('volume', v / 100); }, 80);
  });
  mVol.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = Number(mVol.value);
    mVolT.textContent = v + '%';
    volHold = performance.now() + 1500;
    API && API.mediaCmd('volume', v / 100);
  });

  // ---------- 快捷启动 ----------
  // 列表存在主进程（apps.json）。这里只管画格子、发增删和排序请求。
  // 图标是主进程用系统接口从 .lnk/.exe 里抠出来的图片，存不下就用首字母兜底。
  let appList = [];
  let dragId = null;   // 正在拖的那条的 id

  function initialChar(name) {
    const s = String(name || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }

  function renderApps() {
    if (!lGrid) return;
    lGrid.innerHTML = '';
    const has = appList.length > 0;
    if (lEmpty) lEmpty.hidden = has;
    if (lHint) {
      lHint.textContent = has
        ? '点图标启动 · 拖动排序 · 右键删除'
        : '点右上角的 + 添加软件';
    }
    for (const a of appList) {
      const el = document.createElement('div');
      el.className = 'l-item';
      el.draggable = true;
      el.dataset.id = a.id;
      el.title = a.name + '\n' + a.path;

      const ico = document.createElement('div');
      ico.className = 'l-ico';
      if (a.icon) {
        const img = document.createElement('img');
        img.src = a.icon;
        img.alt = '';
        img.draggable = false;
        ico.appendChild(img);
      } else {
        ico.classList.add('fallback');
        ico.textContent = initialChar(a.name);
      }

      const name = document.createElement('div');
      name.className = 'l-name';
      name.textContent = a.name;

      const del = document.createElement('button');
      del.className = 'l-del';
      del.title = '从控制台移除（不会卸载软件）';
      del.textContent = '×';

      el.append(ico, name, del);
      lGrid.appendChild(el);
    }
  }

  async function loadApps() {
    if (!API || !API.appsList) return;
    let r = [];
    try { r = await API.appsList(); } catch (e) { r = []; }
    appList = Array.isArray(r) ? r : [];
    renderApps();
  }

  // 真启动：主进程启动成功后会自己收起控制台
  async function launchItem(a) {
    if (!a || !API || !API.launchApp) return;
    if (lHint) lHint.textContent = '正在打开 ' + a.name + ' …';
    let r;
    try { r = await API.launchApp(a.path); } catch (e) { r = { ok: false, error: e.message }; }
    if (r && r.ok === false && lHint) {
      lHint.textContent = '打不开：' + (r.error || '未知原因');
      setTimeout(renderApps, 2600);
    }
  }

  async function addApps() {
    if (!API || !API.appsAdd) return;
    if (lHint) lHint.textContent = '正在打开选择框…';
    let r;
    try { r = await API.appsAdd(); } catch (e) { r = { ok: false, error: e.message }; }
    if (!r || !r.ok) {
      if (lHint) lHint.textContent = '添加失败：' + ((r && r.error) || '未知原因');
      setTimeout(renderApps, 2600);
      return;
    }
    if (Array.isArray(r.apps)) appList = r.apps;
    renderApps();
    if (lHint) {
      lHint.textContent = r.added ? ('已添加 ' + r.added + ' 个') : '没有新增（可能已经加过了）';
      setTimeout(renderApps, 2000);
    }
  }

  async function removeApp(a) {
    if (!a || !API || !API.appsRemove) return;
    let r;
    try { r = await API.appsRemove(a.id); } catch (e) { r = { ok: false, error: e.message }; }
    if (r && Array.isArray(r.apps)) appList = r.apps;
    renderApps();
    if (lHint) {
      lHint.textContent = '已移除 ' + a.name + '（点 + 可以加回来）';
      setTimeout(renderApps, 2400);
    }
  }

  // 拖拽排序：拖动时实时把被拖的格子插到鼠标所在格子的前/后，松手才真的存盘
  if (lGrid) {
    lGrid.addEventListener('dragstart', (e) => {
      const el = e.target.closest('.l-item');
      if (!el) return;
      dragId = el.dataset.id;
      el.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
    });
    lGrid.addEventListener('dragend', () => {
      dragId = null;
      lGrid.querySelectorAll('.l-item').forEach((n) => n.classList.remove('dragging', 'over'));
    });
    lGrid.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const over = e.target.closest('.l-item');
      lGrid.querySelectorAll('.l-item').forEach((n) => n.classList.toggle('over', n === over && n.dataset.id !== dragId));
      if (!over || over.dataset.id === dragId) return;
      const from = appList.findIndex((x) => x.id === dragId);
      const to = appList.findIndex((x) => x.id === over.dataset.id);
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = appList.splice(from, 1);
      appList.splice(to, 0, moved);
      renderApps();
    });
    lGrid.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!dragId || !API || !API.appsReorder) return;
      let r;
      try { r = await API.appsReorder(appList.map((x) => x.id)); } catch (err) { r = null; }
      if (r && Array.isArray(r.apps)) appList = r.apps;
      renderApps();
    });
  }

  if (lAdd) lAdd.addEventListener('click', (e) => { e.stopPropagation(); addApps(); });
  if (lBrowse) lBrowse.addEventListener('click', (e) => { e.stopPropagation(); addApps(); });

  if (lGrid) {
    lGrid.addEventListener('click', (e) => {
      const del = e.target.closest('.l-del');
      const el = e.target.closest('.l-item');
      if (!el) return;
      const a = appList.find((x) => x.id === el.dataset.id);
      if (!a) return;
      e.stopPropagation();
      if (del) { removeApp(a); return; }
      launchItem(a);
    });
    lGrid.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('.l-item');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const a = appList.find((x) => x.id === el.dataset.id);
      if (a) removeApp(a);
    });
  }

  // ---------- 壁纸（Wallpaper Engine 官方命令行） ----------
  // 缩略图直接读 workshop 里的 preview.jpg，不复制、不缓存，改了就跟着变。
  let wallBusy = false;

  function fileUrl(p) {
    return encodeURI('file:///' + String(p).replace(/\\/g, '/'));
  }

  async function loadWalls() {
    if (!API || !API.wallList) { wCur.textContent = '壁纸模块未连接'; return; }
    wCur.textContent = '正在读取壁纸…';
    let r;
    try { r = await API.wallList(); } catch (e) { r = { ok: false, error: e.message }; }
    if (!r || !r.ok) {
      wGrid.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'w-empty';
      d.textContent = (r && r.error) || '读取失败';
      wGrid.appendChild(d);
      wCur.textContent = '🖼 读取失败';
      return;
    }
    const items = r.items || [];
    const curId = r.current;
    const curItem = items.find((x) => x.id === curId);
    wCur.textContent = curItem ? ('当前：' + curItem.title) : ('共 ' + items.length + ' 张壁纸');
    wGrid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'w-item' + (it.id === curId ? ' cur' : '');
      el.title = it.title + (it.type ? ' · ' + it.type : '');
      if (it.preview) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = fileUrl(it.preview);
        img.alt = it.title;
        img.addEventListener('error', () => { log('thumb error', it.preview); });
        el.appendChild(img);
      }
      const nm = document.createElement('div');
      nm.className = 'w-nm';
      nm.textContent = it.title;
      el.appendChild(nm);
      el.addEventListener('click', (e) => { e.stopPropagation(); applyWall(it); });
      frag.appendChild(el);
    }
    wGrid.appendChild(frag);
    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'w-empty';
      d.textContent = '没找到已下载的壁纸（先在 Wallpaper Engine 里订阅/下载几张）';
      wGrid.appendChild(d);
    }
  }

  async function applyWall(it) {
    if (wallBusy) { return; }
    wallBusy = true;
    wCur.textContent = '正在切换：' + it.title;
    try {
      const r = await API.wallApply(it.id);
      if (!r || !r.ok) {
        wCur.textContent = '切换失败：' + ((r && r.error) || '未知原因');
      } else {
        wCur.textContent = '已切换：' + it.title;
        setTimeout(() => { loadWalls(); }, 1000);
      }
    } catch (e) {
      wCur.textContent = '切换失败：' + e.message;
    }
    wallBusy = false;
  }

  wStop.addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await API.wallControl('stop');
    wCur.textContent = (r && r.ok) ? '已停止壁纸' : ('停止失败：' + ((r && r.error) || '未知原因'));
  });
  wPlay.addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await API.wallControl('play');
    wCur.textContent = (r && r.ok) ? '已恢复壁纸' : ('恢复失败：' + ((r && r.error) || '未知原因'));
  });
  wOpen.addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await API.wallOpen();
    if (!r || !r.ok) wCur.textContent = '打开失败：' + ((r && r.error) || '未知原因');
  });

  // ---------- 通知：列表 / 红点 ----------
  // 数据只在主进程内存里，这里只负责画。点 × 删一条，右上角「清空」全清。
  let notifItems = [];
  let notifUnread = 0;

  function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function setBadge(n) {
    notifUnread = n;
    if (!nBadge) return;
    nBadge.hidden = !(n > 0);
    nBadge.textContent = n > 99 ? '99+' : String(n);
  }

  function fmtTs(ts) {
    const d = new Date(Number(ts) || Date.now());
    const now = new Date();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function renderNotif(payload) {
    if (!nList) return;
    const items = Array.isArray(payload && payload.items) ? payload.items : notifItems;
    notifItems = items;
    if (typeof (payload && payload.unread) === 'number') setBadge(payload.unread);

    nList.textContent = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'n-item';
      row.dataset.id = it.id;
      row.title = (it.app ? it.app + '：' : '') + (it.title || '') + '\n' + (it.body || '');

      const top = document.createElement('div');
      top.className = 'n-top';
      const app = document.createElement('span');
      app.className = 'n-app';
      app.textContent = clip(it.app, 12);
      const ts = document.createElement('span');
      ts.className = 'n-ts';
      ts.textContent = fmtTs(it.ts);
      top.appendChild(app);
      top.appendChild(ts);

      const txt = document.createElement('div');
      txt.className = 'n-txt';
      const t1 = document.createElement('span');
      t1.className = 'n-title';
      // 有的应用（QQ）第一条文本是个没意义的“.”，主进程已经清空了，这里退回显示应用名
      t1.textContent = clip(it.title, 15) || clip(it.app, 12) || '（无标题）';
      txt.appendChild(t1);
      const body = clip(it.body, 15);
      if (body) {
        const sep = document.createElement('span');
        sep.className = 'n-sep';
        sep.textContent = ' · ';
        const t2 = document.createElement('span');
        t2.textContent = body;
        txt.appendChild(sep);
        txt.appendChild(t2);
      }

      const del = document.createElement('button');
      del.className = 'n-del';
      del.title = '删掉这一条';
      del.textContent = '×';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!API || !API.notifRemove) return;
        await API.notifRemove(it.id);
        notifItems = notifItems.filter((x) => x.id !== it.id);
        renderNotif({ items: notifItems });
      });

      row.appendChild(top);
      row.appendChild(txt);
      row.appendChild(del);
      nList.appendChild(row);
    }

    if (nEmpty) nEmpty.hidden = items.length > 0;
    if (nClear) nClear.disabled = items.length === 0;
  }

  async function loadNotifs() {
    if (!API || !API.notifList) return;
    try {
      const r = await API.notifList();
      renderNotif(r || {});
    } catch (e) { /* 读不到就先空着 */ }
  }

  if (nClear) {
    nClear.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!API || !API.notifClear) return;
      await API.notifClear();
      notifItems = [];
      renderNotif({ items: [] });
    });
  }

  document.addEventListener('click', (e) => {
    const cell = e.target.closest && e.target.closest('.cell[data-module]');
    if (!cell) return;
    if (level === 2) return;                 // 打开的工作区内部点击，交给各模块自己处理
    if (editing || Date.now() < justSortedUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    const mod = cell.dataset.module;
    openCard(cell);
    // 进模块时先要一份最新状态，别等下一个推送周期
    if (mod === 'music' && API && API.mediaGet) API.mediaGet().then(renderMedia).catch(() => {});
    if (mod === 'wallpaper') loadWalls();
    if (mod === 'launch') loadApps();
    if (mod === 'notify') {
      loadNotifs().then(() => {
        if (API && API.notifRead) API.notifRead();
        setBadge(0);
      });
    }
  }, true);

  btnBack.addEventListener('click', (e) => { e.stopPropagation(); exitModule(); });

  // ---------- 扩展坞 + 卡片顺序（一维数组） ----------
  // 设计要点（2026-10-19 定稿）：
  //   · 五个功能就是五张卡，只有“顺序”，没有槽位、没有空位；
  //   · 一维数组的前 4 个渲染进四宫格，第 5 个起渲染进底部扩展区；
  //   · 拖到别的位置 = 改数组顺序，后面的卡整体前移/后移；
  //   · 卡片 DOM 全程复用（只 appendChild 换个爹），点击/红点/拖拽监听都不会丢。
  const dockEl = document.getElementById('dock');
  const dockBar = document.getElementById('dock-bar');
  const l1Grid = document.getElementById('l1-grid');
  const dockGrid = document.getElementById('dock-grid');
  const cCustomBg = document.getElementById('c-custombg');
  const vCustomBg = document.getElementById('v-custombg');
  const tCustomBg = document.getElementById('t-custombg');
  const tintRow = document.getElementById('tint-row');
  const tintCustom = document.getElementById('tint-custom');

  // 一张卡 = 一个常驻 DOM：.tile 是图标面，.work 里装着原来的模块面板。
  // 点开时就是这张卡自己长到舞台上（不再有 #view-l2 这一层），缩回时原路变回卡片。
  const cards = new Map();
  let order = [];
  let dockOpen = false;
  const MAIN_COUNT = 4;
  const MODULE_IDS = Object.keys(MODULES);

  function buildCards() {
    const modMap = {
      launch: 'mod-body',
      music: 'mod-music',
      wallpaper: 'mod-wall',
      notify: 'mod-notify',
      efficiency: 'mod-eff',
    };
    document.querySelectorAll('.cell[data-module]').forEach((old) => {
      const id = old.dataset.module;
      const article = document.createElement('article');
      article.className = 'cell';
      article.dataset.module = id;
      article.tabIndex = 0;
      const tile = document.createElement('div');
      tile.className = 'tile';
      while (old.firstChild) tile.appendChild(old.firstChild);
      const work = document.createElement('div');
      work.className = 'work';
      const mod = document.getElementById(modMap[id]);
      if (mod) { mod.hidden = true; work.appendChild(mod); }
      article.appendChild(tile);
      article.appendChild(work);
      old.replaceWith(article);
      cards.set(id, { el: article, tile, work, mod });
    });
    if (l2) l2.hidden = true;
  }

  // 主进程/老配置回来的数据统一压成一维顺序；非法 id、重复 id 丢掉，缺的补到末尾。
  function normalizeLocalOrder(raw) {
    let arr = [];
    if (Array.isArray(raw)) {
      arr = raw.slice();
    } else if (raw && typeof raw === 'object') {
      arr = (Array.isArray(raw.main) ? raw.main : []).concat(Array.isArray(raw.dock) ? raw.dock : []);
    }
    const seen = new Set();
    const out = [];
    for (const v of arr) {
      if (typeof v !== 'string' || !MODULE_IDS.includes(v) || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    MODULE_IDS.forEach((id) => { if (!seen.has(id)) out.push(id); });
    return out;
  }

  // 只按 order 渲染：0..3 主区，4.. 扩展区。没有模块的位置不存在（不画空卡）。
  // 全程复用同一批 DOM 节点，只换父节点。
  function paintOrder() {
    if (!cards.size) return;
    l1Grid.textContent = '';
    dockGrid.textContent = '';
    order.forEach((id, i) => {
      const rec = cards.get(id);
      if (!rec) return;
      rec.el.dataset.index = String(i);
      (i < MAIN_COUNT ? l1Grid : dockGrid).appendChild(rec.el);
    });
  }

  function applyOrder(raw) {
    order = normalizeLocalOrder(raw);
    paintOrder();
  }

  function persistOrder() {
    if (API && API.orderSet) API.orderSet(order).catch(() => {});
  }

  // ---------- iOS 风格：右键长按 → 全部抖动 → 拖拽互换（SortableJS） ----------
  // 手写 Pointer 事件已删。这里直接用 SortableJS 1.15.7（vendor/sortable.min.js）：
  //   button:2 右键；delay:300 长按；两个容器同组，可跨主区/扩展区拖。
  let editing = false;
  let dockWasClosed = false;
  let justSortedUntil = 0;
  const sortables = [];
  let magnetCell = null;
  let magnetRects = null;
  let dragFollower = null;
  let dragGrab = null;

  function enterEditing() {
    if (editing) return;
    editing = true;
    document.body.classList.add('editing');
    document.body.classList.add('cards-done');
    document.body.classList.remove('cards-in');
    cards.forEach((rec, id) => rec.el.style.setProperty('--jd', `${(order.indexOf(id) % 5) * 37}ms`));
    dockWasClosed = false;
    if (order.length > MAIN_COUNT && !dockOpen) {
      dockWasClosed = true;
      paintDock(true, true);
    }
    log('[order] 进入编辑态');
  }

  function exitEditing() {
    if (!editing) return;
    editing = false;
    stopFollower();
    document.body.classList.remove('editing');
    document.querySelectorAll('.cell.sortable-chosen').forEach((c) => c.classList.remove('sortable-chosen'));
    if (dockWasClosed) {
      dockWasClosed = false;
      paintDock(false, true);
    }
    log('[order] 退出编辑态');
  }

  function collectOrder() {
    const ids = [];
    [l1Grid, dockGrid].forEach((grid) => {
      if (!grid) return;
      grid.querySelectorAll('.cell[data-module]').forEach((c) => ids.push(c.dataset.module));
    });
    return ids;
  }

  function flopCards(ids, rects) {
    ids.forEach((id) => {
      const rec = cards.get(id);
      const or = rects[id];
      if (!rec || !or) return;
      const nr = rec.el.getBoundingClientRect();
      const dx = or.left - nr.left;
      const dy = or.top - nr.top;
      if (!dx && !dy) return;
      rec.el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    });
  }

  // 把目标卡“磁吸”到拖拽卡原来的坑位：只动目标卡，占位符永远留在 A
  function clearMagnet(instant) {
    if (!magnetCell) return;
    const el = magnetCell;
    magnetCell = null;
    el.classList.remove('magnet-move');
    if (instant) {
      el.style.transition = 'none';
      el.style.transform = '';
      void el.offsetWidth;
      el.style.transition = '';
      return;
    }
    el.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
    el.style.transform = '';
    const done = () => {
      el.style.transition = '';
      el.removeEventListener('transitionend', done);
    };
    el.addEventListener('transitionend', done);
  }

  function setMagnet(cell) {
    if (cell === magnetCell) return;
    clearMagnet(false);
    if (!cell || !magnetRects || !magnetRects.draggedEl) return;
    const a = magnetRects.get(magnetRects.draggedEl);
    const b = magnetRects.get(cell);
    if (!a || !b) return;
    magnetCell = cell;
    cell.classList.add('magnet-move');
    cell.style.transition = 'none';
    cell.style.transform = `translate(${Math.round(a.left - b.left)}px, ${Math.round(a.top - b.top)}px)`;
    void cell.offsetWidth;
    cell.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
  }

  // 用拖拽开始时记下的原始格子坐标判定悬停，目标卡飞走后也不会丢命中
  function onDragPointerMove(e) {
    if (dragFollower && dragGrab) {
      dragFollower.style.left = Math.round(dragGrab.left + e.clientX - dragGrab.x) + 'px';
      dragFollower.style.top = Math.round(dragGrab.top + e.clientY - dragGrab.y) + 'px';
    }
    if (!magnetRects) return;
    let hit = null;
    for (const [el, r] of magnetRects) {
      if (el === magnetRects.draggedEl) continue;
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        hit = el;
        break;
      }
    }
    setMagnet(hit);
  }

  // 跟手实体：就是被拎起那张卡的完整外观（白底、图标、文字），用 fixed 坐标咬住光标
  function startFollower(item, evt) {
    stopFollower();
    const r = item.getBoundingClientRect();
    const oe = evt.originalEvent || {};
    const g = item.cloneNode(true);
    g.classList.remove('sortable-ghost', 'sortable-chosen', 'sortable-drag', 'open', 'closing', 'magnet-move');
    g.classList.add('drag-follower');
    g.style.width = r.width + 'px';
    g.style.height = r.height + 'px';
    g.style.left = r.left + 'px';
    g.style.top = r.top + 'px';
    document.body.appendChild(g);
    dragFollower = g;
    dragGrab = {
      x: typeof oe.clientX === 'number' ? oe.clientX : r.left + r.width / 2,
      y: typeof oe.clientY === 'number' ? oe.clientY : r.top + r.height / 2,
      left: r.left,
      top: r.top,
    };
  }

  function stopFollower() {
    if (dragFollower && dragFollower.parentNode) dragFollower.parentNode.removeChild(dragFollower);
    dragFollower = null;
    dragGrab = null;
  }

  function bindSortable() {
    if (!window.Sortable || sortables.length) return;
    [l1Grid, dockGrid].forEach((grid) => {
      if (!grid) return;
      const s = new window.Sortable(grid, {
        group: { name: 'panel-modules', pull: true, put: true },
        animation: 150,
        delay: 300,
        delayOnTouchOnly: false,
        button: 2,
        forceFallback: true,
        fallbackOnBody: true,
        fallbackTolerance: 3,
        filter: '.cell.open',
        ghostClass: 'sortable-ghost',
        fallbackClass: 'sortable-fallback',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        onStart: (evt) => {
          enterEditing();
          magnetRects = new Map();
          document.querySelectorAll('.cell[data-module]').forEach((c) => {
            magnetRects.set(c, c.getBoundingClientRect());
          });
          magnetRects.draggedEl = evt.item;
          startFollower(evt.item, evt);
          window.addEventListener('pointermove', onDragPointerMove, true);
        },
        // 禁止 Sortable 自己改 DOM：原位占位必须死死钉在 A，不许跟着鼠标跑
        onMove: () => false,
        onEnd: (evt) => {
          window.removeEventListener('pointermove', onDragPointerMove, true);
          const draggedId = evt.item && evt.item.dataset.module;
          const targetEl = magnetCell;
          const targetId = targetEl && targetEl.dataset.module;
          clearMagnet(true);
          magnetRects = null;
          stopFollower();
          if (draggedId && targetId && draggedId !== targetId) {
            const from = order.indexOf(draggedId);
            const to = order.indexOf(targetId);
            if (from >= 0 && to >= 0 && from !== to) {
              const arr = order.slice();
              arr[from] = targetId;
              arr[to] = draggedId;
              order = arr;
              document.body.classList.add('cards-done');
              document.body.classList.remove('cards-in');
              paintOrder();
              persistOrder();
              log('[order] 互换', draggedId, '<->', targetId, JSON.stringify(order));
            }
          }
          justSortedUntil = Date.now() + 450;
          exitEditing();
        },
      });
      sortables.push(s);
    });
    log('[order] SortableJS 已绑定');
  }

  function setSortableEnabled(on) {
    sortables.forEach((s) => { try { s.option('disabled', !on); } catch (e) {} });
  }

  // 编辑态点空白退出；右键菜单在卡片上禁掉，否则系统菜单会打断长按
  document.addEventListener('click', (e) => {
    if (!editing) return;
    if (e.target.closest && e.target.closest('.cell')) return;
    exitEditing();
  });
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest && e.target.closest('.cell[data-module]')) e.preventDefault();
  });
  window.addEventListener('blur', () => { exitEditing(); });
  // 抽屉动画（2026-10-18 定稿第 5 版）：
  //   · 窗口永远 434、玻璃也永远 434 → 一次 layout / blur 重算都不会发生；
  //   · 动画只碰 clip-path（合成层，实测帧间隔 5~6ms，全程无空档）；
  //   · 收起状态靠 setShape(302) 把下面 132px 从窗口上裁掉，那里点下去等于点桌面。
  const DOCK_MS = 300;
  let dockTimer = 0;

  function dockShape(open) {
    if (API && API.setShape) API.setShape(!!open);
  }

  function dockLayout(open) {
    if (open) {
      dockShape(true);                              // 先把 132px 纳入窗口（还夹着，看不见）
      document.body.classList.remove('dock-clip');  // 松开夹子 → clip 动画 300ms
    } else {
      document.body.classList.add('dock-clip');     // 夹上 → 动画收起
      clearTimeout(dockTimer);
      dockTimer = setTimeout(() => dockShape(false), DOCK_MS + 30);   // 收完再从窗口上裁掉
    }
  }

  // instant=true：不播过渡、也不播格子入场动画，直接跳到目标状态
  // （从工作区缩回时要把扩展区“提前摆好”，不能再等 300ms 的抽屉动画）
  function paintDock(open, instant) {
    const wasOpen = dockOpen;
    dockOpen = !!open;
    if (!dockEl) return;
    if (instant) {
      clearTimeout(dockTimer);
      document.body.classList.add('dock-instant');
      document.body.classList.add('dock-noanim');
      document.body.classList.remove('dock-anim');
      dockEl.classList.toggle('open', dockOpen);
      document.body.classList.toggle('dock-clip', !dockOpen);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.classList.remove('dock-instant');
      }));
      dockShape(dockOpen);
    } else {
      document.body.classList.remove('dock-noanim');
      dockEl.classList.toggle('open', dockOpen);
      document.body.classList.toggle('dock-anim', dockOpen);
      if (wasOpen !== dockOpen) dockLayout(dockOpen);
    }
  }

  if (dockBar) {
    dockBar.addEventListener('click', (e) => {
      e.stopPropagation();
      const want = !dockOpen;
      paintDock(want);                       // 页面这边先动，主进程同时开始改窗口高度
      if (API && API.setDock) API.setDock(want).catch(() => {});
    });
  }
  // 主进程只在“强制复位”时通知（例如打开控制台时把扩展坞拨回收起）；
  // 用户点手柄那一次自己已经改过状态了，这里的回声要忽略，否则会把动画打断。
  if (API && API.onDock) API.onDock(({ open }) => { if (!!open !== dockOpen) paintDock(open, true); });

  // ---------- 自定义背景（这一版只存开关，不动颜色） ----------
  let settingsListeners = [];
  function onSettingsChanged(cb) { if (typeof cb === 'function') settingsListeners.push(cb); }
  function emitSettings(patch) {
    settingsListeners.forEach((cb) => { try { cb(patch); } catch (err) { log('settings listener 出错', err.message); } });
  }
  // ---------- 效率工具（便签 / 待办） ----------
  // 数据在 main 的 eff.json 里，这里只做渲染；每次增删都重新拉一次快照（数据量很小）。
  let effData = { notes: [], todos: [], dueCount: 0 };
  let effTab = 'note';

  function textClip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    const arr = Array.from(t);
    return arr.length > n ? arr.slice(0, n).join('') + '…' : t;
  }

  function fmtWhen(v) {
    if (!v) return '不设时间';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '不设时间';
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (sameDay(d, now)) return `今天 ${hm}`;
    if (sameDay(d, tomorrow)) return `明天 ${hm}`;
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  }

  function todoClass(t) {
    if (t.done) return 'done';
    if (!t.dueAt) return '';
    const left = new Date(t.dueAt).getTime() - Date.now();
    if (left <= 0) return 'overdue';
    if (left <= 30 * 60 * 1000) return 'soon';
    return '';
  }

  // 0 普通 / 1 重要 / 2 次要；优先级只影响同一截止时间下的排序
  const PRIO_NAME = ['普通', '重要', '次要'];
  const prioWeight = (p) => (p === 1 ? 0 : (p === 2 ? 2 : 1));

  // 未完成在前 → 截止时间近到远（没设时间排最后）→ 同一时间按优先级 → 创建早的在前；
  // 已完成沉底、按完成时间倒序
  function sortTodos(list) {
    const arr = (list || []).slice();
    arr.sort((a, b) => {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      if (a.done) return (b.doneAt || 0) - (a.doneAt || 0);
      const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      if (ta !== tb) return ta - tb;
      const wa = prioWeight(a.prio);
      const wb = prioWeight(b.prio);
      if (wa !== wb) return wa - wb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    return arr;
  }

  // datetime-local 的 value 要本地时间字符串，直接塞时间戳它不认
  function toLocalInput(v) {
    const d = v ? new Date(v) : null;
    if (!d || isNaN(d.getTime())) return '';
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function paintEffBadge(n) {
    const k = Number(n) || 0;
    if (!eBadge) return;
    if (k > 0) { eBadge.hidden = false; eBadge.textContent = k > 99 ? '99+' : String(k); }
    else { eBadge.hidden = true; eBadge.textContent = '0'; }
  }

  // 置顶的在前 → 其余按更新时间倒序
  function sortNotes(list) {
    return (list || []).slice().sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
    });
  }

  function paintNoteCount(v) {
    if (!eNoteCount) return;
    const s = typeof v === 'string' ? v : (eNoteInput ? eNoteInput.value : '');
    eNoteCount.textContent = s.length + ' / 4000';
  }

  function renderNotes() {
    if (!eNoteList) return;
    const list = sortNotes(effData.notes);
    if (eNoteEmpty) eNoteEmpty.hidden = list.length > 0;
    eNoteList.innerHTML = '';
    list.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'e-item note' + (it.pinned ? ' pinned' : '');
      const pin = document.createElement('button');
      pin.className = 'pin';
      pin.title = it.pinned ? '取消置顶' : '置顶';
      pin.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
      pin.addEventListener('click', (e) => { e.stopPropagation(); toggleNotePin(it.id); });
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = textClip(it.text, 30);
      txt.title = it.text + '\n（点一下修改）';
      txt.addEventListener('click', (e) => { e.stopPropagation(); beginEditNote(it, row); });
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = fmtWhen(it.updatedAt || it.createdAt);
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = '删除这条便签';
      x.addEventListener('click', (e) => { e.stopPropagation(); removeNote(it.id); });
      row.appendChild(pin); row.appendChild(txt); row.appendChild(when); row.appendChild(x);
      eNoteList.appendChild(row);
    });
  }

  // 点便签正文 → 就地变成输入框（不弹新窗、不离开这一层）
  function beginEditNote(it, row) {
    if (!row || row.querySelector('.e-edit')) return;
    row.classList.add('editing');
    const area = document.createElement('textarea');
    area.className = 'e-edit';
    area.maxLength = 4000;
    area.value = it.text;
    const bar = document.createElement('div');
    bar.className = 'e-editbar';
    const tip = document.createElement('span');
    tip.className = 'e-hint';
    tip.textContent = 'Ctrl+Enter 保存';
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'e-btn';
    ok.textContent = '保存';
    bar.appendChild(tip); bar.appendChild(cancel); bar.appendChild(ok);
    row.appendChild(area); row.appendChild(bar);
    const finish = (save) => {
      if (!row.isConnected) return;
      if (!save) { renderNotes(); return; }
      const v = area.value.trim();
      // 空内容不落盘（主进程也有一道），只提示，不把原文冲掉
      if (!v) { tip.textContent = '内容不能为空'; area.focus(); return; }
      saveNoteText(it.id, v);
      paintNoteCount();
    };
    cancel.addEventListener('click', (e) => { e.stopPropagation(); finish(false); });
    ok.addEventListener('click', (e) => { e.stopPropagation(); finish(true); });
    area.addEventListener('input', () => paintNoteCount(area.value));
    area.addEventListener('click', (e) => e.stopPropagation());
    area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
    });
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    paintNoteCount(area.value);
  }

  async function saveNoteText(id, text) {
    try { paintEff(await API.effNoteUpdate(id, text)); } catch (e) { log('[eff] 改便签失败', e.message); }
  }

  async function toggleNotePin(id) {
    try { paintEff(await API.effNotePin(id)); } catch (e) { log('[eff] 置顶失败', e.message); }
  }

  function renderTodos() {
    if (!eTodoList) return;
    const list = sortTodos(effData.todos);
    if (eTodoEmpty) eTodoEmpty.hidden = list.length > 0;
    eTodoList.innerHTML = '';
    list.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'e-item todo ' + todoClass(t) + (t.prio ? ' p' + t.prio : '');
      const ck = document.createElement('input');
      ck.type = 'checkbox';
      ck.className = 'ck';
      ck.checked = !!t.done;
      ck.addEventListener('change', (e) => { e.stopPropagation(); toggleTodo(t.id); });
      const flag = document.createElement('button');
      flag.className = 'flag' + (t.prio ? ' f' + t.prio : '');
      flag.title = '优先级：' + PRIO_NAME[t.prio || 0] + '（点一下换）';
      flag.addEventListener('click', (e) => { e.stopPropagation(); cycleTodoPrio(t); });
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = textClip(t.text, 11);
      txt.title = t.text;
      const when = document.createElement('button');
      when.className = 'when';
      when.textContent = fmtWhen(t.dueAt);
      when.title = t.dueAt ? '点一下改截止时间' : '点一下设截止时间';
      when.addEventListener('click', (e) => { e.stopPropagation(); beginEditDue(t, row); });
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = '删除这条待办';
      x.addEventListener('click', (e) => { e.stopPropagation(); removeTodo(t.id); });
      row.appendChild(ck); row.appendChild(flag); row.appendChild(txt); row.appendChild(when); row.appendChild(x);
      eTodoList.appendChild(row);
    });
  }

  // 点时间 → 行内展开时间编辑器：保存 / 清除 / 取消，改完重新拉快照
  function beginEditDue(t, row) {
    if (!row || row.querySelector('.e-timeedit')) return;
    // 同时只留一个时间编辑器，避免几行一起撑高
    const open = eTodoList && eTodoList.querySelector('.e-item.todo.editing');
    if (open && open !== row) {
      open.classList.remove('editing');
      const old = open.querySelector('.e-timeedit');
      if (old) old.remove();
    }
    row.classList.add('editing');
    const wrap = document.createElement('div');
    wrap.className = 'e-timeedit';
    const inp = document.createElement('input');
    inp.type = 'datetime-local';
    inp.className = 'e-input e-time';
    inp.value = toLocalInput(t.dueAt);
    const clear = document.createElement('button');
    clear.className = 'ghost';
    clear.textContent = '清除';
    clear.title = '清掉截止时间';
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'e-btn';
    ok.textContent = '保存';
    wrap.appendChild(inp); wrap.appendChild(clear); wrap.appendChild(cancel); wrap.appendChild(ok);
    row.appendChild(wrap);
    const finish = async (value) => {
      try { paintEff(await API.effTodoUpdate(t.id, { dueAt: value })); } catch (e) { log('[eff] 改时间失败', e.message); }
    };
    const readValue = () => (inp.value ? new Date(inp.value).getTime() : 0);
    clear.addEventListener('click', (e) => { e.stopPropagation(); finish(0); });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); renderTodos(); });
    ok.addEventListener('click', (e) => { e.stopPropagation(); finish(readValue()); });
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(readValue()); }
    });
    inp.focus();
  }

  async function cycleTodoPrio(t) {
    const next = ((Number(t.prio) || 0) + 1) % 3;
    try { paintEff(await API.effTodoUpdate(t.id, { prio: next })); } catch (e) { log('[eff] 改优先级失败', e.message); }
  }

  function paintEffTabs() {
    const isNote = effTab === 'note';
    if (eTabNote) eTabNote.classList.toggle('is-on', isNote);
    if (eTabTodo) eTabTodo.classList.toggle('is-on', !isNote);
    if (ePaneNote) ePaneNote.hidden = !isNote;
    if (ePaneTodo) ePaneTodo.hidden = isNote;
    if (eLeadWrap) eLeadWrap.hidden = isNote;
  }

  function paintEff(st) {
    effData = {
      notes: (st && st.notes) || [],
      todos: (st && st.todos) || [],
      dueCount: (st && st.dueCount) || 0,
    };
    renderNotes();
    renderTodos();
    paintEffBadge(effData.dueCount);
  }

  async function loadEff() {
    if (!API || !API.effGet) return;
    try { paintEff(await API.effGet()); } catch (e) { log('[eff] 读取失败', e.message); }
  }

  async function addNote() {
    if (!eNoteInput) return;
    const text = eNoteInput.value.trim();
    if (!text) { eNoteInput.focus(); return; }
    try {
      const st = await API.effNoteAdd(text);
      eNoteInput.value = '';
      paintNoteCount();
      paintEff(st);
    } catch (e) { log('[eff] 保存便签失败', e.message); }
  }

  async function removeNote(id) {
    try { paintEff(await API.effNoteRemove(id)); } catch (e) { log('[eff] 删便签失败', e.message); }
  }

  async function addTodo() {
    const text = (eTodoText && eTodoText.value || '').trim();
    if (!text) { if (eTodoText) eTodoText.focus(); return; }
    const raw = (eTodoTime && eTodoTime.value) || '';
    const dueAt = raw ? new Date(raw).getTime() : 0;
    const prio = Number(eTodoPrio && eTodoPrio.value) || 0;
    try {
      const st = await API.effTodoAdd({ text, dueAt, prio });
      if (eTodoText) eTodoText.value = '';
      if (eTodoTime) eTodoTime.value = '';
      if (eTodoPrio) eTodoPrio.value = '0';
      paintEff(st);
      if (eTodoText) eTodoText.focus();
    } catch (e) { log('[eff] 添加待办失败', e.message); }
  }

  async function toggleTodo(id) {
    try { paintEff(await API.effTodoToggle(id)); } catch (e) { log('[eff] 勾选待办失败', e.message); }
  }

  async function removeTodo(id) {
    try { paintEff(await API.effTodoRemove(id)); } catch (e) { log('[eff] 删待办失败', e.message); }
  }

  if (eTabNote) eTabNote.addEventListener('click', (e) => { e.stopPropagation(); effTab = 'note'; paintEffTabs(); });
  if (eTabTodo) eTabTodo.addEventListener('click', (e) => { e.stopPropagation(); effTab = 'todo'; paintEffTabs(); });
  if (eNoteSave) eNoteSave.addEventListener('click', (e) => { e.stopPropagation(); addNote(); });
  if (eTodoAdd) eTodoAdd.addEventListener('click', (e) => { e.stopPropagation(); addTodo(); });
  if (eNoteInput) {
    eNoteInput.addEventListener('input', paintNoteCount);
    eNoteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); addNote(); }
    });
    paintNoteCount();
  }
  if (eTodoText) {
    eTodoText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addTodo(); }
    });
  }
  if (eLead) {
    eLead.addEventListener('change', () => {
      if (API && API.setSettings) API.setSettings({ remindLead: Number(eLead.value) });
    });
  }
  // 提醒方式：改完立刻落盘，下一次到点就按新方式弹
  if (cNotify) {
    cNotify.addEventListener('change', () => {
      if (API && API.setSettings) API.setSettings({ notifyStyle: cNotify.value === 'bubble' ? 'bubble' : 'native' });
    });
  }
  paintEffTabs();

  // 自定义背景：真正给玻璃染色（色相存在 settings.tint，透明度仍然跟“不透明度”滑块联动）
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    if (!m) return { r: 111, g: 140, b: 255 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  let tint = '#6f8cff';

  function applyTint(hex, on) {
    const { r, g, b } = hexToRgb(hex);
    tint = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    document.documentElement.style.setProperty('--tint', tint);
    document.documentElement.style.setProperty('--tint-rgb', `${r}, ${g}, ${b}`);
    document.body.classList.toggle('has-tint', !!on);
    // 染色之后，字色要跟着“染出来的底色”走，而不是跟桌面走：
    // 深色（雾蓝/紫/石墨）→ 白字；浅色（琥珀/绿）→ 深字。
    if (on) {
      // 染色是半透明的，最终底色 = 桌面亮度为主 + 一点点色相亮度：
      // 只按色相算会翻车（深蓝配白字，压在亮网页上却成了浅紫底 + 白字，看不清）。
      const tintLum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const base = (typeof lastLuma === 'number') ? lastLuma : 0.5;
      const eff = base * 0.68 + tintLum * 0.32;
      document.body.classList.toggle('on-light', eff > 0.58);
    } else {
      applyTone(lastLuma);   // 关掉染色，交还给“看背景亮度”的那套
    }
    if (tintRow) tintRow.hidden = !on;
    if (tintCustom) tintCustom.value = tint;
    document.querySelectorAll('.sw').forEach((el) => {
      el.classList.toggle('on', String(el.dataset.tint).toLowerCase() === tint);
    });
    emitSettings({ tint });
  }

  function applyCustomBackground(on) {
    const live = !!on;
    document.body.classList.toggle('has-custom-bg', live);
    applyTint(tint, live);
    emitSettings({ customBackground: live });
  }

  function paintCustomBg(on) {
    const live = !!on;
    if (cCustomBg) cCustomBg.checked = live;
    if (vCustomBg) vCustomBg.textContent = live ? '已开启' : '已关闭';
    if (tCustomBg) tCustomBg.textContent = live ? '已开启（下面挑个颜色）' : '换自己的底图（可自选颜色）';
    applyCustomBackground(live);
  }

  if (cCustomBg) {
    cCustomBg.addEventListener('change', () => {
      const want = cCustomBg.checked;
      paintCustomBg(want);
      if (API && API.setSettings) API.setSettings({ customBackground: want, tint });
    });
  }

  // 色板：点一下立刻预览 + 落盘（落盘不代表要等，先应用再存）
  if (tintRow) {
    tintRow.addEventListener('click', (e) => {
      const sw = e.target && e.target.closest ? e.target.closest('.sw') : null;
      if (!sw) return;
      const hex = sw.dataset.tint;
      applyTint(hex, true);
      if (API && API.setSettings) API.setSettings({ tint: hex, customBackground: true });
      if (cCustomBg) cCustomBg.checked = true;
      paintCustomBg(true);
    });
  }
  if (tintCustom) {
    // input 期间只预览（拖动取色器时实时变色），change 才落盘
    tintCustom.addEventListener('input', () => applyTint(tintCustom.value, true));
    tintCustom.addEventListener('change', () => {
      applyTint(tintCustom.value, true);
      if (API && API.setSettings) API.setSettings({ tint, customBackground: true });
      if (cCustomBg) cCustomBg.checked = true;
      paintCustomBg(true);
    });
  }

  // 先按默认顺序铺一遍，别等 settings 回来才显示
  order = normalizeLocalOrder(null);
  paintOrder();
  window.__order = () => order.slice();   // 调试用

  btnClose.addEventListener('click', (e) => { e.stopPropagation(); if (API) API.collapse('close-btn'); });

  // ---------- 内部 / 外部的严格分界 ----------
  // 规矩（用户 2026-10-17 定死）：
  //   · 点在「工作区卡片内部」→ 什么都不发生（交给卡片自己的按钮）；
  //   · 点在「控制台内部、卡片外的空白」→ 退回四宫格（等同 Esc）；
  //   · 点在「控制台外面」→ 整体收起（主进程按失焦识别）。
  // 所以这里**不能**再对整体做 stopPropagation，否则 document 上的空白判定永远收不到事件。
  // 需要吞掉事件的按钮自己会 stopPropagation（btnBack / btnClose / btnGear 等）。

  // ---------- 设置浮层 ----------
  function toggleSettings(on) {
    settingsOpen = on === undefined ? !settingsOpen : on;
    settings.hidden = !settingsOpen;
    settings.classList.toggle('is-on', settingsOpen);
    btnGear.classList.toggle('is-on', settingsOpen);
    if (settingsOpen) syncLogin();
  }

  btnGear.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
  settings.addEventListener('click', (e) => e.stopPropagation());

  // 点设置面板**外面**的任何地方 → 立刻关掉设置（层级不动，四宫格还是四宫格）。
  // 用捕获阶段：卡片、按钮这些自己会 stopPropagation 的元素也拦不住它，
  // 所以“点另一个工作区”既能关设置、又能正常进入那个工作区。
  // 点齿轮本身要排除，否则它先关再开、等于点不动。
  document.addEventListener('click', (e) => {
    if (!settingsOpen) return;
    const t = e.target;
    if (t && t.closest && (t.closest('#settings') || t.closest('#btn-gear') || t.closest('.settings'))) return;
    log('settings close -> 点了面板外面');
    toggleSettings(false);
  }, true);

  // ---------- 开机自启 ----------
  // 显示的是“注册表里到底有没有”，不是我们自己的字段——以系统事实为准。
  function paintLogin(st) {
    const on = !!(st && st.enabled);
    cLogin.checked = on;
    if (!st) { vLogin.textContent = '读取失败'; return; }
    if (vLogin) vLogin.textContent = on ? '已开启' : '已关闭';
    if (tLogin) {
      tLogin.textContent = st.runEntry
        ? '注册表已写入，下次开机自动出现'
        : (on ? '已开启，但注册表里还没看到（下次启动会补写）' : '开机时不会自动运行');
    }
    cLogin.title = (st.execPath || '') + (st.args && st.args.length ? ' ' + st.args.join(' ') : '');
  }

  async function syncLogin() {
    if (!API || !API.loginGet) return;
    try { paintLogin(await API.loginGet()); } catch (e) { paintLogin(null); }
  }

  if (cLogin) {
    cLogin.addEventListener('change', async () => {
      const want = cLogin.checked;
      if (vLogin) vLogin.textContent = want ? '写入中…' : '移除中…';
      try {
        const st = await API.loginSet(want);
        paintLogin(st);
      } catch (e) {
        paintLogin(null);
      }
    });
  }

  let saveTimer = null;
  function onSlider() {
    const op = Number(rOpacity.value) / 100;
    const blur = Number(rBlur.value);
    applyLook(op, blur);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => API && API.setSettings({ opacity: op, blur }), 260);
  }
  rOpacity.addEventListener('input', onSlider);
  rBlur.addEventListener('input', onSlider);

  // ---------- 和主进程对话 ----------
  if (API) {
    API.onBackdrop(({ data }) => {
      if (!data) return;
      prepareBackdrop(data);
    });

    // 处理底图：①抹掉抓屏时被拍进去的“我们自己的窄条”；②判平均亮度决定字色
    function prepareBackdrop(dataUrl) {
      const tmp = new Image();
      tmp.onload = () => {
        try {
          const w = tmp.naturalWidth, h = tmp.naturalHeight;
          if (!w || !h) return;
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(tmp, 0, 0, w, h);

          // 窄条窗口正好落在面板的右侧边上，抓屏时会被一起拍进来。
          // 用左边几个像素横向拉伸，把那一竖条盖掉（后面还有 26px 模糊，看不出接缝）。
          // 注意用“当前视口”而不是写死的 380×268——扩展坞展开后高度会变。
          const vw = window.innerWidth || PANEL_W;
          const vh = window.innerHeight || PANEL_H;
          const kx = w / vw, ky = h / vh;
          const bandX = (vw - STRIP_W - 4) * kx;
          const dstX = (vw - STRIP_W) * kx;
          const dstY = (STRIP_TOP - TOP_GAP) * ky;
          const dstH = STRIP_H * ky;
          const srcW = Math.max(2, Math.round(4 * kx));
          ctx.drawImage(c, Math.round(bandX - srcW), Math.round(dstY), srcW, Math.round(dstH),
            Math.round(dstX), Math.round(dstY), Math.round(w - dstX), Math.round(dstH));

          // 亮度：决定整套配色（字/图标/卡片底一起换），不是只切字色。
          const luma = toneLuma(ctx, w, h);
          applyTone(luma);
          log('backdrop 平均亮度', luma.toFixed(2));

          backdrop.src = c.toDataURL('image/jpeg', 0.9);
        } catch (e) {
          log('底图处理失败', e.message);
          backdrop.src = dataUrl;
        }
      };
      tmp.onerror = () => { backdrop.src = dataUrl; };
      tmp.src = dataUrl;
    }

    API.onState(({ state }) => {
      log('state', state);
      // 面板一出现就把“实时桌面视频”关掉，改用主进程提前拍好的静态底图：
      //   · 实时那路是整屏捕获，会把面板自己也拍进去（画面里套一层虚影），
      //     而玻璃又是半透明的 → 自己拍自己，会造成“一闪一闪”的反馈闪烁；
      //   · 静态底图是面板还没显示时拍的，没有自拍，动画期间也不会有任何逐帧变化。
      setLiveEnabled(state === 'collapsed');
      // 四个工作区卡片的二次入场。
      // 只调“外框→卡片”的这一段等待：外框 320ms，让卡片在 200ms 就开始起跳，
      // 也就是外框还没完全撑满、卡片已经紧跟着弹出来，中间不留空档。
      // （每张卡片自己的时长/曲线、以及卡片之间的错峰都没动。）
      if (state === 'expanded') {
        document.body.classList.remove('cards-in');
        document.body.classList.remove('cards-done');
        requestAnimationFrame(() => {
          document.documentElement.style.setProperty('--cards-delay', '200ms');
          document.body.classList.add('cards-in');
        });
        // 入场动画跑完切到静态态：只认 animationend，不用 setTimeout 估时长
        const firstCard = l1Grid && l1Grid.querySelector('.cell');
        if (firstCard) {
          const onCardsIn = (ev) => {
            if (ev.animationName !== 'cardIn') return;
            firstCard.removeEventListener('animationend', onCardsIn);
            document.body.classList.add('cards-done');
            document.body.classList.remove('cards-in');
          };
          firstCard.addEventListener('animationend', onCardsIn);
        }
      } else if (state === 'collapsing') {
        document.body.classList.remove('cards-in');
      } else if (state === 'collapsed') {
        resetView();
      }
      if (state === 'expanded') animateOpen();
      else if (state === 'collapsing') animateClose();
    });

    // 音乐状态推送
    API.onMediaState((st) => renderMedia(st));
    if (API.mediaGet) API.mediaGet().then(renderMedia).catch(() => {});

    // 通知推送：主进程收到新通知就推过来，这里只管刷列表 + 红点
    if (API.onNotifState) API.onNotifState((p) => renderNotif(p));
    loadNotifs();

    // 托盘点「设置…」→ 把设置浮层打开
    if (API.onOpenSettings) API.onOpenSettings(() => toggleSettings(true));
    syncLogin();

    // 快捷启动：先拉一次列表，这样第一次展开就有内容
    loadApps();

    // 先把五张卡搭好（每张卡里装它自己的工作区），再按保存的一维顺序摆进主区/扩展区
    buildCards();
    applyOrder(null);
    bindSortable();
    document.body.classList.add('cards-done');

    API.onRequestClose(() => {
      // 正在输入框里：Esc 只取消焦点，不关面板、不退工作区（用户 2026-10-19 要求）
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable);
      if (typing) {
        try { ae.blur(); } catch (e) { }
        API.closeResult({ handled: true });
        return;
      }
      // 先看自己能不能往里退一层
      let handled = false;
      if (settingsOpen) { toggleSettings(false); handled = true; }
      else if (editing) { exitEditing(); handled = true; }
      else if (level === 2) { exitModule(); handled = true; }
      API.closeResult({ handled });
    });

    API.getSettings().then((s) => {
      if (!s) return;
      applyLook(s.opacity, s.blur);
      // 扩展坞永远从收起开始（用户 2026-10-18 定死）：只在用户点箭头后才展开
      paintDock(false, true);
      // 先定色相，再按开关应用（避免先用默认色闪一下）
      tint = /^#[0-9a-f]{6}$/i.test(String(s.tint || '')) ? String(s.tint).toLowerCase() : '#6f8cff';
      applyTint(tint, false);
      paintCustomBg(!!s.customBackground);
      if (eLead) eLead.value = String([0, 5, 10].includes(Number(s.remindLead)) ? Number(s.remindLead) : 0);
      if (cNotify) cNotify.value = s.notifyStyle === 'bubble' ? 'bubble' : 'native';
      if (s.order) applyOrder(s.order);
      if (s.features && s.features.dock === false && dockEl) dockEl.hidden = true;
    }).catch(() => {});

    // 效率工具：到点未完成数量（模块格子红点）
    if (API.onEffState) API.onEffState((p) => { paintEffBadge(p && p.dueCount); });
    // 点待办通知 → 直接落到「效率工具 / 待办」这一层
    if (API.onOpenModule) API.onOpenModule((p) => {
      if (!p || p.module !== 'efficiency') return;
      effTab = p.tab === 'todo' ? 'todo' : 'note';
      paintEffTabs();
      enterModule(null, 'efficiency');
    });
    loadEff();

    API.info().then((i) => {
      liveInfo = i;
      document.documentElement.classList.toggle('dark', !!i.dark);
      if (!NO_LIVE) startLive();
      window.__dumpLive = dumpLiveFrame;
    }).catch(() => {});
  }

  // 帧率自测（只在调试时打印）
  if (DEBUG) {
    let frames = 0, t0 = performance.now();
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - t0 >= 1000) {
        log('fps ≈', Math.round((frames * 1000) / (now - t0)));
        frames = 0; t0 = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
