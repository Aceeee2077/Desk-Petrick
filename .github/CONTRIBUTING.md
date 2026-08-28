# Contributing / 贡献指南

Thanks for considering contributing to Petric — code, art, or docs! 🎉
感谢你愿意为 Petric 贡献代码、美术或文档！

## Development Environment / 开发环境

```bash
# Requirements: Node.js >= 18 / 环境要求：Node.js ≥ 18
npm install
npm run dev        # Build & launch the dev version / 构建 + 启动开发版本
npm run smoke      # Build & smoke self-check (deep diagnostics, exit code 0 = pass) / 构建 + 冒烟自检（含深度诊断，退出码 0 = 通过）
```

## Project Layout / 项目结构速览

```
src/main/     Main process (window / tray / IPC / AI requests / auto-launch) / 主进程
src/renderer/ Renderer (app.ts = pet animation & interactions; settings = panel; screenshot = README images) / 渲染层
src/shared/   Shared types & config (types.ts / config.ts / png.ts) / 共享类型与配置
scripts/      Build & tooling (sprite generator / asset copy / Electron launcher / set custom skin) / 构建与工具
```

## Commit Guidelines / 提交规范

- Branch naming: `feature/xxx`, `fix/xxx`, `docs/xxx` / 分支命名：`feature/xxx`、`fix/xxx`、`docs/xxx`
- Commit messages in Chinese or English are both fine; prefer `type(scope): description`,
  e.g. `fix(renderer): fix interactions triggered on transparent areas`, `feat(sprites): add rabbit skin`
  / Commit 信息用中文或英文均可，建议采用 `类型(范围): 描述` 的格式
- Before opening a PR, make sure: / PR 前请确保：
  - `npm run build` passes (sprites + TypeScript + asset copy) / `npm run build` 通过
  - `npm run smoke` passes / `npm run smoke` 通过
  - Meaningful feature changes include a short description (screenshots or GIFs welcome)
    / 有实际意义的功能改动附带简单说明（最好有演示 GIF 或截图）

## Ideas to Contribute / 可以贡献的方向

- 🎨 **New skins**: sprite sheets follow 4 rows × 4 columns (idle / walking / sleeping / click),
  32×32 frames, placed in `src/assets/sprites/`; or extend the generator in
  `scripts/generate-sprites.mjs` (procedural pixel art is a project highlight — new animal designs are welcome)
  / **新皮肤**：精灵表遵循 4 行 × 4 列、帧 32×32 的规范放入 `src/assets/sprites/`；或扩展生成器
- ✨ **New features**: see README "Bonus features" — Pomodoro mode, weather awareness, multi-monitor pets, etc.
  / **新功能**：见 README「额外加分项」——番茄钟、天气感知、多显示器多宠物等
- 🐛 **Bug fixes**: include reproduction steps and impact / **Bug 修复**：提交时说明复现步骤与影响
- 📖 **Docs**: README, tutorials, screenshots & demo GIFs / **文档**：README、教程、截图与演示 GIF

## Code of Conduct / 行为准则

Participating means you agree to the [CODE_OF_CONDUCT](./CODE_OF_CONDUCT.md).
参与本项目即表示同意遵守 [CODE_OF_CONDUCT](./CODE_OF_CONDUCT.md)。
