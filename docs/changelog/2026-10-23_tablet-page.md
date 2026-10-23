# 2026-10-23 平板专用页（设备分流 / 48 格铺一页 / X/Y 自适应）

需求与 11 条决策见 [spec/tablet-page.md](../spec/tablet-page.md)；本页记录**实现**与实测。

一句话：同一个网址，**短边 ≥ 640 px 的设备自动进 `/tablet.html`**——平板把手机的**六页左右并排**铺成
一屏 **48 个方形按钮**（每页仍是 2 列 × 4 行，页间留一道更宽的缝，读作 12 列 × 4 行，编号与手机逐格相同）；
顶栏切到 X/Y 时控制面**自适应**到底座里最大的正方形；**平板没有 Digital Fader**。协议、Bridge、DAW 映射**零改动**。

> **同日修订（重要）**：第一版做成了 "8 列 × 6 行、一行 = 一页"。用户看到截图后给了图并说明
> "shortcut pad 的样式不是我想要的样子，我想要的是如图所示布置和手机一样" —— 即**六页保持各自的
> 2 列 × 4 行、左右并排**（每 2 列一组、组间留更宽的缝）。已按此重做：平板页改为 **6 个独立的
> `createGrid(page = p)` 实例**（每页就是一个手机的 2×4 网格），`padgrid.js` 因此**回到零改动**
> （只补了头部注释里的第三个宿主），`paintFlat` / `cols/rows` 那套"拉平成一格"的改法全部撤掉。

---

## 改动

### 新增 `web/device.js`（设备分流，唯一的新概念）

| 内容 | 说明 |
|------|------|
| 判定 | `min(innerWidth, innerHeight) >= 640` → 平板。**不用 UA**：iPadOS 13 起 Safari 自称 Mac，按 UA 判会永远认成电脑 |
| 路由声明 | 页面在 `<html data-route="home\|phone\|tablet">` 上声明自己是谁；脚本同步放在 `<head>`，**首次绘制前**完成跳转（不闪手机版） |
| 规则 | 首页 / 手机专用页 → 平板进 `/tablet.html`；`/tablet.html` → 手机进 `/pad.html`；已在对的页面什么都不做 |
| 覆盖 | `?device=phone` / `?device=tablet` / `?device=auto`，写 `localStorage`；页脚有「手机版 / 平板版」链接 |
| 跳转 | `location.replace()`：不让"平板打开 `/` 被送走"在后退栈里留一条死循环 |

### 新增 `web/tablet.html` + `web/tablet.js`（平板宿主）

- **顶栏两个视图**：`48 格` / `X/Y`，右侧连接状态；`MIDI Deck` 品牌名替代返回键（平板首页就是这一页）。
- **六页并排**：为每一页建一个 `createGrid(el, { page: p })`，六个 2×4 网格放进一条 flex 行；
  页间距由 JS 按格子大小算（0.5 格），所以"六页"一眼看得出来。编号仍由 padgrid 按 `p×8+s` 算。
- **正方形保证**：`size = min((可用宽 − 6×页内缝) / (12 + 5×0.5), (可用高 − 3×页内缝) / 4)`，
  每页宽高由**同一个 size** 推出；`ResizeObserver` / `resize` / `orientationchange` / `load` 都会重量。
- **字号**：`clamp(12px, 格子 × 0.22, 22px)` —— 12 列并排后格子比手机小，照手机那档字号会挤成三行。
- **X/Y**：直接加载手机那份 `xy.js`（`tablet.html` 备齐同样的 id），行为与手机完全一致；
  横屏时控制项在**右栏 300 px**，pad 取舞台里最大的正方形（竖屏上下排）。
- **切视图先 `releaseAll()`**：格子被藏起后 `pointerup` 可能送不到，DAW 会留一条关不掉的 Note。
- **没有 Digital Fader**：页面不列、不加载 `fusion.js`；平板上打开 `/fader.html` 会被 `device.js` 送回平板页。

### 改动的既有文件

| 文件 | 改动 |
|------|------|
| `web/padgrid.js` | **代码零改动**（已回到 HEAD 版本）：六个页面各是一个默认的 2×4 网格实例，`page` 参数把编号算成 `p×8+s`；只在头部注释补了 `/tablet.html` 这第三个宿主 |
| `web/index.html` / `pad.html` / `fader.html` / `xy.html` | `<html data-route="…">` + 加载 `device.js`；padgrid 版本号 `v=2 → v=3` |
| `web/index.html` | 页脚加「平板版」链接 |
| `bridge/server.py` | GUI 提示改成"手机/平板浏览器打开…（手机选模块，平板自动进平板版）"；**同时恢复**上一轮被中断的 `_web_dir()` 修复（静态目录必须是带 `index.html` 的 `web/`，爬不到盘符根 `F:/`，否则 `add_static` 会抛 `empty name` 让 START 整个失败） |
| `tests/pages_smoke.mjs` | 桩 DOM 支持每页视口、`documentElement.dataset.route`、`location.replace`、初始 class、动态建节点；新增平板页与设备分流的一组断言（六页并排 / 每页 2×4 / 编号 / 视图切换 / 手机平板分流） |
| `tests/bridge_boot_check.py` | 真的起 Bridge，抓 `/`、`/tablet.html`、`/device.js`、`/tablet.js`；恢复 `_web_dir` 契约的 3 条 |
| `tools/shoot.mjs` | 支持逐页视口；新增 `tablet-home` / `tablet-pad` / `tablet-from-pad` / `tablet-xy` / `tablet-portrait` / `tablet-xy-portrait` 六张平板截图；**每次运行改用新的浏览器配置目录**（原来固定 `%TEMP%\phoneshots-profile`，改完 CSS 再拍拿到的还是上一版 —— 这次被坑过一次） |

### 文档

- 新增 [spec/tablet-page.md](../spec/tablet-page.md)（T1–T11）、本 changelog。
- `CONTEXT.md` 新增 **Device（设备与入口）**：Tablet Page / Device Route / Flat Grid，并写明"48 格是同一批按钮的第二个显示位"。
- `shortcut-pad.md §4.1` 原来那句"平板按屏幕等比放大"已被取代：平板改走专用页（48 格）。
- `README.md`（手机连接 + 文档索引）、`docs/roadmap.md`、`tests/README.md` 同步。

---

## 实测

- **平板截图**（Edge 无头，1180×820；脚本 `tools/shoot.mjs`）：
  - `tablet-home.png` / `tablet-pad.png` / `tablet-from-pad.png` **三张逐字节相同** → 打开 `/` 与
    平板误开 `/pad.html` 都真的落在 `/tablet.html`；
  - **六页左右并排**：每页 2 列 × 4 行、约 74×74 px 的方格（正方形），页间距 ≈37 px（半格），
    六组从左到右就是手机的第 1–6 页；
  - `tablet-xy.png`：pad 696×696（舞台里最大正方形），控制项在右栏；快速预设默认高亮 X/Y Pad（CC20/21）；
  - `tablet-portrait.png` / `tablet-xy-portrait.png`（820×1180）：同一套"六页并排"竖过来（格子约 51 px），
    X/Y 控制项改成上下排（竖屏输入框限宽 96 px，不再被拉成 260 px）。
- **桩测试**（`pages_smoke.mjs` 平板块）：六页 × 8 格 = 48、每页 CSS/JS 都是 2 列 × 4 行、默认显示 48 格视图、
  每页 44×96 → 每格 18×18（宽高同源 = 正方形）、六页按页序并排（`[0,0]=P0C0 [1,0]=P1C0 [5,7]=P5C7`）、
  **第 6 页第 8 格发编号 47**、松开配同编号 up、切视图自动松开按住的格、X/Y 面 300×300、
  平板页不引用 `fader.html`/`fusion.js`、三个手机页都声明 `data-route="phone"`。
- **设备分流**：390×844 首页**不跳**；1024×768 首页跳 `/tablet.html`。
- **全部套件通过**：10 个套件、**430 项**（vibrato 64 / protocol 21 / boot 13 / ui 51 / pad 74 /
  port 12 / xy 21 / pages 142 / mode_b 26 / exe 6）。
- **打包**：`bridge/dist/MIDI Deck.exe` 已重打包（`MIDI Deck.spec`，18.2 MB），
  `exe_web_check.py` 6/6 —— 快照里的 `web/` 与工作树逐字节一致，`server.py` 也比 exe 旧。
  直接起这个 exe（`--no-gui --no-ssl --port 8794`）再抓页面：`/`、`/tablet.html`、`/device.js`、
  `/tablet.js` 全部 200。

---

## 真机待确认

- iPad Safari 的 `100dvh` / 安全区 / 触摸与双指行为（当前结论来自 Edge 无头 + 桩测试）。
- iPad 没有马达，`navigator.vibrate` 会静默跳过 —— 按下的"确认"只剩形变与变暗（与手机同一条结论，D25）。
- 短边 640：iPad 分屏（约 507）会被判成手机，需要 `?device=tablet`；桌面浏览器（短边 ≥ 640）
  看到的是平板页。是否要单独给桌面一档，等实际用起来再定。
- **竖屏下 12 列并排**：820 宽时格子约 51 px，能用但偏小；如果实际主要用竖屏，再商量是建议横屏
  还是给竖屏换一种折法（先不动）。
