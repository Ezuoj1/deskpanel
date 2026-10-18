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
  function applyTone(luma) {
    const light = luma > LUMA_LIGHT;
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

  // ---------- 层 1 / 层 2 ----------
  const MODULES = {
    launch: { title: '快捷启动', sub: '添加 / 排序 / 启动软件' },
    music: { title: '音乐', sub: '控制当前播放器' },
    wallpaper: { title: '壁纸', sub: 'Wallpaper Engine' },
    notify: { title: '通知', sub: '授权 / 脱敏列表' },
  };

  // 整个控制台一收起（Esc / 点外部 / 快捷键 / 点 ✕），内部状态必须强制回到“主四宫格”。
  // 否则下次呼出会残留上次的设置面板、或者某个放大的工作区。
  // 放在 collapsed（窗口已经 hide 之后）执行：这时看不见，切换不会有跳变。
  function resetView() {
    if (settingsOpen) toggleSettings(false);
    if (level !== 1) goLevel(1);
    log('[reset] 收起后视图重置为四宫格');
  }

  function goLevel(n, mod) {
    level = n;
    stage.dataset.level = String(n);
    // 层 2 里可能装不同模块：快捷启动 / 音乐 / 壁纸 / 通知各有自己的面板
    const isMusic = n === 2 && mod === 'music';
    const isWall = n === 2 && mod === 'wallpaper';
    const isNotif = n === 2 && mod === 'notify';
    modBody.hidden = isMusic || isWall || isNotif;
    modMusic.hidden = !isMusic;
    modWall.hidden = !isWall;
    if (modNotify) modNotify.hidden = !isNotif;
    if (n === 2 && MODULES[mod]) {
      if (modTitle) modTitle.textContent = MODULES[mod].title;
      if (modSub) modSub.textContent = MODULES[mod].sub;
      t1.textContent = MODULES[mod].title;
      t2.textContent = '点空白 / Esc 返回上一级';
      hintEsc.textContent = 'Esc 返回四宫格';
    } else {
      t1.textContent = '控制台';
      t2.textContent = '阶段 1.9 · 整块玻璃';
      hintEsc.textContent = 'Esc / 点外部 收起';
    }
    btnBack.hidden = n !== 2;
    btnGear.style.display = n === 2 ? 'none' : '';   // 层 2 让位给返回键，避免两个按钮叠一起
    log('level ->', n, mod || '');
  }

  // 层 2 的“内部空白”= 控制台里面、但不在卡片（工作区）上的地方：标题栏、边距。
  // 点这里等于按 ESC：退回四宫格。点卡片内部不算（那是工作区），
  // 点控制台外面由主进程的 blur 直接收起整个面板。
  document.addEventListener('click', (e) => {
    if (level !== 2) return;
    const inMod = !!(e.target.closest && e.target.closest('.mod'));
    if (inMod) return;
    if (e.target.closest('button')) return;
    if (e.target.closest('.settings')) return;
    goLevel(1);
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

  document.querySelectorAll('.cell').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      goLevel(2, el.dataset.module);
      // 进音乐模块时先要一份最新状态，别等下一个推送周期
      if (el.dataset.module === 'music' && API && API.mediaGet) {
        API.mediaGet().then(renderMedia).catch(() => {});
      }
      if (el.dataset.module === 'wallpaper') loadWalls();
      if (el.dataset.module === 'launch') loadApps();
      if (el.dataset.module === 'notify') {
        loadNotifs().then(() => {
          // 点开列表就算“已读”：红点马上消失，但条目还留着给你看
          if (API && API.notifRead) API.notifRead();
          setBadge(0);
        });
      }
    });
  });

  btnBack.addEventListener('click', (e) => { e.stopPropagation(); goLevel(1); });

  // ---------- 扩展坞 + 槽位（本次结构升级） ----------
  // 设计要点：
  //   · 四宫格仍然是“主槽位”，固定 4 个位置；模块被挪走后原地留虚线空卡，不许后面的格子顶上。
  //   · 扩展区里的格子复用 .cell 本身（同一个 DOM 元素，只是 appendChild 换个爹），
  //     所以点击、拖拽、红点这些监听一个都不会丢。
  //   · 动画分两层：主进程改窗口高度（只有 Y 变），页面改 .dock-area 的高度（CSS 190ms）。
  const dockEl = document.getElementById('dock');
  const dockBar = document.getElementById('dock-bar');
  const l1Grid = document.getElementById('l1-grid');
  const dockGrid = document.getElementById('dock-grid');
  const slotsEl = document.getElementById('slots');
  const cCustomBg = document.getElementById('c-custombg');
  const vCustomBg = document.getElementById('v-custombg');
  const tCustomBg = document.getElementById('t-custombg');

  // 模块登记表：id 与 data-module 对应，element 就是页面上原来那个 button
  const REGISTRY = Array.from(document.querySelectorAll('.cell'))
    .filter((el) => el.dataset && el.dataset.module)
    .map((el) => {
      const ct = el.querySelector('.ct');
      return { id: el.dataset.module, title: ct ? ct.textContent : el.dataset.module, el };
    });
  const MODULE_IDS = REGISTRY.map((r) => r.id);

  // 默认排法：四个都在主槽位，扩展区空着（跟升级前一模一样）
  let slots = { main: MODULE_IDS.slice(0, 4), dock: [] };
  let dockOpen = false;

  function makeEmptySlot() {
    const d = document.createElement('div');
    d.className = 'cell empty';
    d.innerHTML = '<span class="cs">空槽位</span>';
    return d;
  }

  function paintSlots() {
    const byId = new Map(REGISTRY.map((r) => [r.id, r]));
    if (l1Grid) {
      l1Grid.innerHTML = '';
      for (let i = 0; i < 4; i += 1) {
        const id = slots.main[i];
        l1Grid.appendChild(id && byId.has(id) ? byId.get(id).el : makeEmptySlot());
      }
    }
    if (dockGrid) {
      dockGrid.innerHTML = '';
      if (!slots.dock.length) {
        const hint = document.createElement('div');
        hint.className = 'dock-hint';
        hint.textContent = '扩展区还空着 · 设置 → 模块放在哪';
        dockGrid.appendChild(hint);
      } else {
        slots.dock.forEach((id) => { if (byId.has(id)) dockGrid.appendChild(byId.get(id).el); });
      }
    }
  }

  // 主进程回来的槽位数据一律过一遍：非法 id 丢掉、同一模块只留第一次出现
  function applySlots(raw) {
    if (!raw || typeof raw !== 'object') return;
    const seen = new Set();
    const main = [];
    for (let i = 0; i < 4; i += 1) {
      const id = Array.isArray(raw.main) ? raw.main[i] : null;
      if (id && MODULE_IDS.includes(id) && !seen.has(id)) { seen.add(id); main.push(id); }
      else main.push(null);
    }
    const dock = [];
    (Array.isArray(raw.dock) ? raw.dock : []).forEach((id) => {
      if (id && MODULE_IDS.includes(id) && !seen.has(id)) { seen.add(id); dock.push(id); }
    });
    slots = { main, dock };
    paintSlots();
    buildSlotSelects();
  }

  function persistSlots() {
    if (API && API.slotsSet) API.slotsSet(slots).catch(() => {});
  }

  function buildSlotSelects() {
    if (!slotsEl) return;
    slotsEl.innerHTML = '';
    REGISTRY.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'slot-row';
      const name = document.createElement('span');
      name.className = 'sname';
      name.textContent = r.title;
      const sel = document.createElement('select');
      sel.className = 'slot-sel';
      [['main:0', '主槽位 1'], ['main:1', '主槽位 2'], ['main:2', '主槽位 3'], ['main:3', '主槽位 4'], ['dock', '扩展区']]
        .forEach(([v, t]) => {
          const op = document.createElement('option');
          op.value = v; op.textContent = t;
          sel.appendChild(op);
        });
      const cur = slots.main.indexOf(r.id);
      sel.value = cur >= 0 ? 'main:' + cur : 'dock';
      sel.addEventListener('change', () => assign(r.id, sel.value));
      row.appendChild(name);
      row.appendChild(sel);
      slotsEl.appendChild(row);
    });
  }

  // 把某个模块放到目标位置；目标位置上原本的人被挤到扩展区（不让他凭空消失）
  function assign(id, target) {
    const from = slots.main.indexOf(id);
    if (from >= 0) slots.main[from] = null;
    else slots.dock = slots.dock.filter((x) => x !== id);
    if (target === 'dock') {
      if (!slots.dock.includes(id)) slots.dock.push(id);
    } else {
      const idx = Number(String(target).split(':')[1]) || 0;
      const occupant = slots.main[idx];
      slots.main[idx] = id;
      if (occupant && occupant !== id && !slots.main.includes(occupant) && !slots.dock.includes(occupant)) {
        slots.dock.push(occupant);
      }
    }
    paintSlots();
    buildSlotSelects();
    persistSlots();
  }

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

  // instant=true：不播过渡，直接跳到目标状态（打开面板时主进程强制收起扩展坞用）
  function paintDock(open, instant) {
    const wasOpen = dockOpen;
    dockOpen = !!open;
    if (!dockEl) return;
    if (instant) {
      clearTimeout(dockTimer);
      document.body.classList.add('dock-instant');
      dockEl.classList.toggle('open', dockOpen);
      document.body.classList.toggle('dock-clip', !dockOpen);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.classList.remove('dock-instant');
      }));
      dockShape(dockOpen);
    } else {
      dockEl.classList.toggle('open', dockOpen);
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
  // 预留：以后要换底图/取色，都在这个函数里加，调用方不用改
  function applyCustomBackground(on) {
    const live = !!on;
    document.body.classList.toggle('has-custom-bg', live);
    emitSettings({ customBackground: live });
  }

  function paintCustomBg(on) {
    const live = !!on;
    if (cCustomBg) cCustomBg.checked = live;
    if (vCustomBg) vCustomBg.textContent = live ? '已开启' : '已关闭';
    if (tCustomBg) tCustomBg.textContent = live ? '已开启（底图替换还没接）' : '换自己的底图（下一步做取色 / 图片）';
    applyCustomBackground(live);
  }

  if (cCustomBg) {
    cCustomBg.addEventListener('change', () => {
      const want = cCustomBg.checked;
      paintCustomBg(want);
      if (API && API.setSettings) API.setSettings({ customBackground: want });
    });
  }

  // 先按默认四宫格铺一遍，别等 settings 回来才显示
  paintSlots();
  buildSlotSelects();
  window.__slots = () => JSON.parse(JSON.stringify(slots));   // 调试用

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
        requestAnimationFrame(() => {
          document.documentElement.style.setProperty('--cards-delay', '200ms');
          document.body.classList.add('cards-in');
        });
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

    API.onRequestClose(() => {
      // 先看自己能不能往里退一层
      let handled = false;
      if (settingsOpen) { toggleSettings(false); handled = true; }
      else if (level === 2) { goLevel(1); handled = true; }
      API.closeResult({ handled });
    });

    API.getSettings().then((s) => {
      if (!s) return;
      applyLook(s.opacity, s.blur);
      // 扩展坞永远从收起开始（用户 2026-10-18 定死）：只在用户点箭头后才展开
      paintDock(false, true);
      paintCustomBg(!!s.customBackground);
      if (s.slots) applySlots(s.slots);
      if (s.features && s.features.dock === false && dockEl) dockEl.hidden = true;
    }).catch(() => {});

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
