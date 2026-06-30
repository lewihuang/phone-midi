# 2026-06-30 初始文档体系建立

## 变更
- `CONTEXT.md` — 新建。领域术语表（传感器源、轴、映射、连接等概念定义）
- `docs/adr/0001-web-first-architecture.md` — 新建。Web MVP → Native Android 渐进架构决策
- `docs/adr/0002-json-mapping-config.md` — 新建。JSON 映射配置文件格式决策
- `docs/roadmap.md` — 新建。Phase 1-4 分期实现路线图
- `README.md` — 更新。项目说明

## 原因
基于参考项目 Phone-MIDI-Controller 分析 + 同类项目调研后，确定 Web-first 技术路线。文档先行，指导后续分期实现。

## 影响
- 现有 Flutter 代码暂保留，Phase 3 时参考
- Phase 1 将新建 `bridge/` 和 `web/` 目录（独立于现有 Flutter 项目）
