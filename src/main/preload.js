// 夹在主进程和页面中间的「前台」：只放行白名单里的几件事，别的免谈。
const { contextBridge, ipcRenderer } = require('electron');

// 主进程创建窗口时用 additionalArguments 告诉我们这个窗口是“窄条”还是“面板”
const kindArg = process.argv.find((a) => a.startsWith('--panel-kind='));
const KIND = kindArg ? kindArg.split('=')[1] : 'panel';
const NO_LIVE = process.argv.includes('--panel-no-live');

contextBridge.exposeInMainWorld('panel', {
  kind: KIND,
  noLive: NO_LIVE,

  info: () => ipcRenderer.invoke('env:info'),
  expand: (opt) => ipcRenderer.send('panel:expand', opt || {}),
  collapse: (reason) => ipcRenderer.send('panel:collapse', reason),

  // 动画真的播完了（主进程据此记“展开耗时”）
  animDone: () => ipcRenderer.send('panel:anim-done'),
  // 用户真的碰到面板了 → 把键盘焦点拿过来（Esc 才有接收者）
  grabFocus: () => ipcRenderer.send('panel:grab-focus'),

  // 启动一个程序（第二步“快捷启动”用；启动后主进程会自动收起控制台）
  launchApp: (target, args) => ipcRenderer.invoke('app:launch', { path: target, args }),

  // 快捷启动：列表 / 添加（弹系统选文件框，返回新增项）/ 删除 / 排序 / 改名
  appsList: () => ipcRenderer.invoke('apps:list'),
  appsAdd: () => ipcRenderer.invoke('apps:add'),
  appsRemove: (id) => ipcRenderer.invoke('apps:remove', id),
  appsReorder: (ids) => ipcRenderer.invoke('apps:reorder', ids),
  appsRename: (id, name) => ipcRenderer.invoke('apps:rename', { id, name }),

  // 音乐（SMTC）：读当前状态 / 发命令（playpause、next、prev、seek）
  mediaGet: () => ipcRenderer.invoke('media:get'),
  mediaCmd: (action, position) => ipcRenderer.send('media:cmd', { action, position }),
  onMediaState: (cb) => ipcRenderer.on('media:state', (_e, payload) => cb(payload)),

  // 壁纸（Wallpaper Engine 官方命令行）：列表 / 切换 / 停止恢复 / 打开 WE
  wallList: () => ipcRenderer.invoke('wall:list'),
  wallApply: (id) => ipcRenderer.invoke('wall:apply', id),
  wallControl: (action) => ipcRenderer.invoke('wall:control', action),
  wallOpen: () => ipcRenderer.invoke('wall:open'),

  // 通知：只在本机内存里，不上网
  notifList: () => ipcRenderer.invoke('notif:list'),
  notifRead: () => ipcRenderer.invoke('notif:read'),
  notifRemove: (id) => ipcRenderer.invoke('notif:remove', id),
  notifClear: () => ipcRenderer.invoke('notif:clear'),
  onNotifState: (cb) => ipcRenderer.on('notif:state', (_e, payload) => cb(payload)),

  // 设置：读数 / 存盘（透明度、模糊半径）
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.send('settings:set', patch || {}),

  // 主进程推“状态变了”
  onState: (cb) => ipcRenderer.on('view:set-state', (_e, payload) => cb(payload)),
  // 主进程推“背后桌面的照片（已裁好）”，用来当玻璃底图
  onBackdrop: (cb) => ipcRenderer.on('view:backdrop', (_e, payload) => cb(payload)),
  // 主进程说“用户想关掉它”，页面先决定能不能往里退一层
  onRequestClose: (cb) => ipcRenderer.on('view:request-close', (_e, payload) => cb(payload)),
  // 页面答复：这一下被我自己消化了（handled=true）还是可以真收起
  closeResult: (res) => ipcRenderer.send('panel:close-result', res || {}),

  // 调试：把实时背景的当前一帧存盘（验证“抓到的是真桌面”）
  saveLive: (dataUrl) => ipcRenderer.invoke('debug:save-live', dataUrl),
});
