# 2026-09-26 产品改名 MIDI Deck + 换程序图标

## 背景

项目已经不只是一把推子了：**Digital Fader（手机推子）/ Shortcut Pad（宏命令按钮）/ X/Y Pad（二维控制面）**
是三个并列模块。而 PC 端程序还叫「手机推子.exe」「手机推子 · Phone MIDI Bridge」，名字与产品对不上。

用户原话："顺便把软件名字也改了，现在已经不只是推子了……PC 窗口也叫这个名字，不要副标题，
exe 文件名也一样，手机端不要副标题"。

---

## 改了什么

| | 改前 | 改后 |
|---|---|---|
| 产品名 | 手机推子 / Phone MIDI Bridge / Phone MIDI Controller | **MIDI Deck** |
| PC 窗口标题 | `手机推子 · Phone MIDI Bridge`（精简态是 `手机推子 · 精简`） | **`MIDI Deck`**（两态都一样，无副标题） |
| 打包产物 | `bridge/dist/手机推子.exe` | **`bridge/dist/MIDI Deck.exe`** |
| 程序图标 | PyInstaller 默认图标 | **`bridge/midi-deck.ico`**（自己生成，见下） |
| 手机端模块名 | 手机推子 / 模拟按钮 | **Digital Fader / Shortcut Pad** |
| 手机端页面标题 | `手机推子 · MIDI Deck` 之类 | 只留模块名（`Digital Fader` / `Shortcut Pad` / `延迟诊断` / `校准 · 抬手推子`） |
| 首页 | 大标题 + "选一个功能模块" + 两张带说明的卡片 | 大标题 + 两张**只有名字**的卡片（用户：不要副标题） |
| 证书 CN / 帮助文本 / 端口占用报错 | Phone MIDI Bridge / 手机推子 | MIDI Deck |
| 打包 spec | `bridge/手机推子.spec`（gitignore，本机） | `bridge/midi-deck.spec`（同样 gitignore） |

**刻意没动的**（用户："你不建议改的不改"）：

- 配置目录 `%APPDATA%\phone-midi-bridge` —— 改名会让 `pad.json`（48 个按钮布局）、`window.json`、
  `xy.json`、证书全部"凭空消失"，收益为零。
- 仓库名与本机目录 `phone_midi`（Gitee 远端也是 `phone-midi`）—— 所有文档链接、远端、本机路径都要动。
- **历史 changelog 里的旧名字**（`2026-06-30_*`、`2026-09-17_*`、`2026-09-19_*` 里的
  `phone-midi-bridge.exe` / `手机推子.exe`）—— 那是当时的记录，改了就是伪造历史。
  只有"活的"文档（README / spec / guide / CONTEXT）跟着改。

---

## 图标：几个矩形拼一个 Mixer

用户："帮我换掉 exe 文件的 ico，可以用几个简单的矩形来模拟一个 Mixer 的样子"。
本机**没有 Pillow**，所以 `tools/make_icon.py` 用**纯标准库**自己写 ICO 容器
（每张图 = `BITMAPINFOHEADER` + 自下而上的 BGRA 像素 + AND 掩码），零依赖、可复现、能进仓库。

- 图形：深底 `#0B0C0A`（与程序界面同色）+ 4 根竖直**通道条**（矩形）+ 每根条上一个横向**推子帽**
  （矩形），帽停在 4 个不同高度，其中一根用 `#00E676`（程序的身份色）。外加 1px 内描边，
  免得贴在浅色任务栏上糊成一片。
- **小尺寸自动简化**：≥48 px 用 4 根通道条，16/24/32 px 用 3 根并把线加粗 —— 否则缩到任务栏就是一团。
- 尺寸：16 / 24 / 32 / 48 / 64 / 128 / 256，7 张。
- 用法：`python tools/make_icon.py [--preview out.png]`（`--preview` 导出放大预览图给人看）。

**验证**：从 exe 里把 7 张图逐字节找回来 —— `ico images embedded verbatim in exe: 7 / 7`。

---

## 打包命令（变了，记在这里）

```powershell
cd bridge
pyinstaller --noconfirm --distpath dist --workpath build "midi-deck.spec"
```

`.spec` 里两处关键行：`name='MIDI Deck'`、`icon='midi-deck.ico'`。
`.spec` 是 gitignore 的（本机文件），所以**从零复现**的等价命令是：

```powershell
pyinstaller --noconfirm --onefile --noconsole --name "MIDI Deck" --icon midi-deck.ico `
  --add-data "config;config" --add-data "../web;web" server.py
```

---

## 顺手修掉的一个隐患

`tests/exe_web_check.py` 把 exe 路径**写死**成 `bridge/dist/手机推子.exe` —— 改名会让这条检查
（"别让过期快照看起来像好的"）**静默变成 SKIP**，而那正是它存在的意义。现在改成
**按 mtime 取 `dist/` 里最新的 `.exe`**，并把找到的文件名打印出来。产品名再改也不会失效。

---

## 我在这轮里犯的一个错，值得记下来

改名脚本里我用 PowerShell 哈希表传"旧串 → 新串"，但 PowerShell 会**把单元素数组拍平**：
`$pair` 从"一对字符串"变成了"一个字符串"，于是 `$pair[0]` / `$pair[1]` 取到的是**字符串的第 0/1 个字符**——
等于执行了"把 `D` 换成 `i`"，把 `tests/pages_smoke.mjs` 里的 `DOM` 改成 `iOM`、`DEFAULTS` 改成 `iEFAULTS`，
另外三个被同一循环写过的文件也中了招（幸好测试立刻炸了：`Cannot read properties of undefined`）。

**处置**：`git checkout --` 回滚那 4 个文件 → 全库扫一遍 `iOM` / `iEFAULTS` 之类的痕迹（确认没有别的残留）
→ 改用**逐条精确替换**重做。

**教训**：批量文本替换不要用 shell 的嵌套数组传参；要么逐条 `edit`，要么写 Python 脚本
（本项目里 `rename_product.py` 那种形式是对的，出问题的是我图省事的那个 shell 循环）。

---

## 测试与验证

- 全套 **283 项**通过（8 个套件），其中 `exe_web_check` 用新 exe 名 + 自动发现跑通。
- 截图：`%TEMP%\phoneshots_v8\`（首页卡片只剩名字、各页标题只留模块名）。
- 图标预览：`python tools/make_icon.py --preview %TEMP%\icon.png` 或看 `%TEMP%\midtdeck-icon-preview.png`。

## 用户需要做的一件事

桌面上指向 `手机推子.exe` 的**快捷方式已失效**（文件名变了）。要么手动重建一个指向
`bridge/dist/MIDI Deck.exe` 的快捷方式，要么让 agent 生成一个。
