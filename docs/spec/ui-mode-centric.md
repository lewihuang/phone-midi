# 主页 UI — 以 Mode 为中心的信息架构

> 状态：初版已实现  
> 创建：2026-07-09  
> 取代：全局「校准设备」+ 单一 calBadge 设计

---

## 1. 问题

旧主页假设 **整机一次校准**：

- 全局按钮「校准设备」
- 单一 badge「尚未校准抬手范围」
- 模式选择器启动后才出现

与「Mode A / B 各自校准、Mode C 无需校准」冲突。

---

## 2. 设计原则

1. **Mode 是一等公民** — 先选控制方式，再校准、再运行  
2. **校准从属于 Mode** — 仅 A/B 显示校准入口与状态  
3. **禁止全局校准状态** — 不用一个 badge 代表整机  
4. **启动前可选 Mode、可校准** — 不必连 Bridge  

---

## 3. 主页结构（下拉选择）

```
┌ 状态：未连接 ─────────────────────┐
│ 控制方式  [▼ A · 抬手推子      ]   │
│ 说明文案 + ●已校准/○未校准 [校准]  │  ← A/B 显示校准行；C 隐藏
├ [ 启动 · {当前 Mode 名} ] ─────────┤
├ ── 运行中显示 ──                  │
│ 大数字 / 条 / CC 映射 / [发送中]   │
└──────────────────────────────────┘
```

### 交互

- **下拉** 选择 Mode（A/B/C 互斥）
- 选中后显示 **说明** + **校准状态/链接**（仅 A/B）
- 「去校准」链到 `/calibrate-lift.html` 或 `/calibrate-flip.html`
- 启动：A/B 未校准时仍可启动但警告
- URL：`/?mode=B` 深链  

---

## 4. 校准页

| URL | 标题 | profile |
|-----|------|---------|
| `/calibrate-lift.html` | 校准 · 抬手推子 (A) | `lift` |
| `/calibrate-flip.html` | 校准 · 翻转推子 (B) | `flip` |
| `/calibrate.html` | 跳转 hub → lift | — |

共享 `calibrate-wizard.js`，由 `data-profile` 驱动文案与 storage。

---

## 5. 文件清单（本阶段）

| 文件 | 变更 |
|------|------|
| `web/index.html` | 模式下拉 + 校准行 |
| `web/app.js` | `selectMode` / `refreshModeSetup` |
| `web/fusion.js` | PROFILES lift/flip |
| `web/calibrate-wizard.js` | 新建，替代 calibrate.js |
| `web/calibrate-lift.html` | 新建 |
| `web/calibrate-flip.html` | 新建 |
| `web/calibrate.html` | hub 重定向 |

---

## 6. 迁移

- `phone-midi/calibration/v1` → 首次读 lift 时迁移到 `lift/v1`  
- 老用户：仅 A 卡片亮绿灯，B 仍为未校准  
