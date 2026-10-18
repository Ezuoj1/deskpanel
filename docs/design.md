# 设计说明

这份文档记录"为什么代码这么写"，尤其是那些看起来绕了一圈的地方。改代码前建议先看一遍，能省掉不少重复踩坑。

## 1. 整体结构

```
┌───────────────────────────── Electron ─────────────────────────────┐
│  主进程 main.js                                                     │
│    · 两个窗口：面板 panelWin(380×268)、窄条 stripWin(51×142)         │
│    · 全局快捷键 / 托盘 / 全屏探测 / 四个模块的 IPC 中转               │
│    · 定时读 %TEMP%\deskpanel-*.json，把状态推给页面                   │
│                                                                    │
│  渲染进程 renderer/                                                 │
│    · 四宫格 + 四个模块面板；纯前端，不直接碰系统                       │
└────────────────────────────────────────────────────────────────────┘
              │ 启动（写 .cmd → shell.openPath）
              ▼
┌──────────────────────── native/ 小助手 ────────────────────────────┐
│  fullscreen-probe.ps1  全屏探测（Win32 + WinForms 屏幕尺寸）          │
│  smtc-helper.ps1       SMTC：歌曲信息 / 播放控制 / 音量               │
│  notif-helper.ps1      UserNotificationListener：系统通知             │
│  AudioVol.cs   → AudioVol.dll    Core Audio 单应用音量               │
│  SmtcCover.cs  → SmtcCover.exe   SMTC 缩略图（封面）                  │
│  IconGrab.cs   → IconGrab.exe    提取 exe/lnk 真实图标                │
└────────────────────────────────────────────────────────────────────┘
              │ 原子写 JSON / PNG
              ▼
        %TEMP%\deskpanel-media.json
        %TEMP%\deskpanel-notif.json
        %TEMP%\deskpanel-fs.txt
```

## 2. 主进程 ↔ 小助手：为什么用"临时文件 + 轮询"

Electron 目前**不能直接调 WinRT**（SMTC、通知中心都在 WinRT 里），必须让一个会 WinRT 的进程去查，再把结果递回来。

本来最自然的做法是 `child_process.spawn` 一个 PowerShell 子进程。实测在这台机器上**不行**：spawn 出来的进程立刻退出，拿不到 stdout（`cmd /c echo hello > file` 也一样失效）。

于是统一改成：

1. 主进程把命令写进 `%TEMP%\deskpanel-<tag>.cmd`；
2. 同目录写一个 `.vbs`，内容是 `WScript.Shell.Run "cmd /c ""<cmd>""", 0, False`（隐藏窗口）；
3. `shell.openPath(vbs)`，由系统去执行；
4. 小助手把结果**原子写**（`WriteAllText(tmp)` + `Move-Item`）到 JSON；
5. 主进程 `setInterval` 每 400–900ms 读一次，内容变了才推给页面。

配套的三个约束（踩过才知道）：

- **.cmd 里不能出现中文路径**，否则变成乱码、`cmd` 找不到目录。所有临时产物都放在 `%TEMP%`（ASCII）。
- **.ps1 带中文必须存 UTF-8 + BOM**。PowerShell 5.1 对无 BOM 文件按 ANSI 解码，中文注释会打断解析，把后面的语句一起吞掉（表现为某个变量永远是空字符串）。
- **小助手要自己写 pid 文件**，主进程重启小助手时先按 pid `taskkill`，否则会同时跑两个、互相覆盖 JSON。

## 3. 四个模块的取舍

### 3.1 全屏探测

轮询式：小助手每 500ms 用 `EnumWindows` 找"铺满整个屏幕的可见窗口"，跳过自己（按进程 pid 过滤），写一行 `full | hwnd | l | t | r | b | ...`。主进程读到 `full=1` 就隐藏面板，`false` 再延迟 1.2 秒恢复（防抖，避免切窗口瞬间闪烁）。

### 3.2 音乐：只认 QQ 音乐

- 用 `GlobalSystemMediaTransportControlsSessionManager` 拿所有媒体会话，**只保留** `SourceAppUserModelId` 命中白名单（`QQMusic` / `QQMusicAssistant` / `QQMusicPin` / `QQMusicService`）的那个。没有就是"未播放"。
  这是刻意的：SMTC 是系统级接口，不加过滤的话抖音、浏览器一出声就会串台。
- 播放控制走 `TryTogglePlayPauseAsync` / `TrySkipNextAsync` / `TrySkipPreviousAsync`。
- **进度条只读**：QQ 音乐返回 `canSeek=false`，`TryChangePlaybackPositionAsync` 无效，所以前端只显示进度、不提供拖动。
- **音量**：SMTC 没有音量接口，改为 Core Audio。`AudioVol.cs` 里封装 `IAudioSessionManager2` → `ISimpleAudioVolume`，按进程名 `QQMusic` 找会话读/写音量，**不动系统总音量**。
- **封面**：`MediaProperties.Thumbnail.OpenReadAsync()` 返回的是 WinRT 的 `IAsyncOperation`，PowerShell 里拿到的永远是个 `System.__ComObject`，强转 `IRandomAccessStream` / `IInputStream` 全失败，`AsStreamForRead` 也报找不到重载。改用 C#（`SmtcCover.cs`）**手写轮询** `IAsyncOperation.Status`，完成后再用 `DataReader` 读字节写成 JPEG。编译时不引用 `System.Runtime.WindowsRuntime.dll`（身份对不上，会 `CS0012`），只引 `WinMetadata` 下的 `.winmd`。

### 3.3 壁纸：只用官方命令行

- 找安装：先看环境变量 `DESKPANEL_WE`，再扫各盘 `SteamLibrary\steamapps\common\wallpaper_engine`，并解析 `libraryfolders.vdf` 里登记的其它库。
- 列表：`steamapps\workshop\content\431960\*\project.json`（标题/类型）+ 同目录 `preview.jpg`。
- 切换：`wallpaper64.exe -control openWallpaper -file "<project.json>"`；停止/恢复：`-control stop` / `play`。
- 当前是哪张：`-control getWallpaper` 实测没有输出，改读 WE 自己的 `config.json` 里 `general.wallpaperconfig.selectedwallpapers.Monitor0.file`，取路径倒数第二段当 id。
- 命令行本身也要经过 `.cmd`（`VBS → cmd → exe` 这一链），直接把带引号的参数塞进 `VBS Run` 会被 WE 忽略。

### 3.4 通知：只做系统通知中心

- `UserNotificationListener.RequestAccessAsync()` 在 Windows 11 上通常直接返回 `Allowed`，不需要打包成 MSIX。
- 小助手启动时先记录"已存在的通知 id"，**之后新增的才算新通知**（baseline），避免一启动就把历史通知全倒出来。
- 只留内存：主进程里是数组，退出时清空并删临时文件。
- **微信不做**：微信 4.x 是 Qt 自绘，不走 Windows 系统通知，`UserNotificationListener` 永远等不到；它的弹窗只有头像 + 名字 + 未读数、没有正文，无障碍树是空的。监听网络包、注入进程、读数据库这三条路明确不做。

### 3.5 快捷启动的图标

`app.getFileIcon()` 对一部分 exe 只返回系统"通用白纸"（抖音就是）。判定方式：dataURL 短于 1400 字符基本就是白纸，此时调用 `IconGrab.exe`（`Icon.ExtractAssociatedIcon`）重新提取 PNG。另外 `.lnk` 的 `IconLocation` 常常是 `,0`，要先剥掉这个后缀，再退到 `sc.target`。

## 4. 交互状态机

- 只有两级：`level 1`（四宫格）和 `level 2`（某个模块）。
- 面板与窄条是两个窗口：收起时 `hide()` 面板、`showInactive()` 窄条；展开反之。
- **点外面收起**用窗口 `blur` 实现，但要做两道过滤：
  1. 弹文件选择框期间置 `pickingApps` 标志，跳过收起；
  2. 用 `screen.getCursorScreenPoint()` 和窗口 `getBounds()` 复核光标是否真的在面板外（点自己格子时偶尔也会触发 blur）。
- **点内部空白退回四宫格**在渲染进程里判定：`level===2` 且点击目标不在 `.mod` / `button` / `.settings` 内 → `goLevel(1)`。
  注意：**不能再对整体容器做 `stopPropagation`**，否则 `document` 上的这个判定永远收不到事件（早期就是这么写的，导致点标题栏毫无反应）。
- 窄条窗口必须 `setFocusable(true)`。曾经为了"不抢焦点"设成 `false`，结果收起再展开之后，真实鼠标点击不再投递给渲染进程（`PostMessage` 模拟点击却正常）。
- 透明置顶窗口会被 Chromium 认为"不可见"而停止绘制，`webPreferences.backgroundThrottling` 必须设 `false`。

## 5. 已知坑速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 窗口不出现，报 `getPath` undefined | 环境里全局设了 `ELECTRON_RUN_AS_NODE` | 启动前清掉该变量（`start.cmd` 已处理） |
| 子进程立刻退出、没有输出 | Electron 里 `spawn` 不可用 | 写 `.cmd` → `shell.openPath` |
| 中文变量莫名变空 / 脚本报语法错 | `.ps1` 存成 UTF-8 无 BOM | 存成 UTF-8 + BOM |
| `Add-Type` 报"客户端没有所需的特权" | 从 `VBS → cmd → powershell` 链里现场编译 C# | 预编译成 dll/exe，`Assembly.LoadFrom` |
| 界面"冻住"不刷新 | 透明窗口被 Chromium 降频 | `backgroundThrottling: false` |
| 点窄条没反应 | 窗口 `setFocusable(false)` 后真实鼠标事件不再投递 | `setFocusable(true)` |
| 点标题栏没反应 | 容器上挂了 `stopPropagation`，`document` 收不到 | 去掉全局拦截，交给判定函数 |
| 图标是通用白纸 | `getFileIcon` 拿不到该 exe 的图标 | `IconGrab.exe` 兜底 + `ICONS_VER` 触发重算 |

## 6. 可以继续做的

- 打包成安装包（electron-builder），顺带解决"图标只支持 exe 而非商店应用"的问题。
- 给快捷启动加"打开文件所在位置"、拖入文件直接添加。
- 音乐模块加"喜欢/取消喜欢"（QQ 音乐没有公开接口，需要另找路）。
- 多显示器：目前面板固定主屏右上角，可根据光标所在屏决定位置。
