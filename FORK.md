# 这份 fork 改了什么

上游：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。本仓库是它的**自用魔改分支**，
基线是上游 `v0.4.1`（tag 仍在），改动全部落在 `main` 上。

## 新增能力

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 长期事实记忆 | 对话中自动提炼 / `/remember` `/memory` `/forget` | 存 `$DSH_HOME/dsh-pet/memory-facts.json`，每次装配提示词现算注入 |
| 记忆面板 | 右侧栏「桌宠记忆」标签 | 查看 / 新增 / 修改 / 删除 / 清空，与事实文件同步 |
| 主动搭话 | 配置 `proactiveEnabled` | 空闲阈值、每小时上限、安静时段（支持跨午夜）、冷却 |
| 可配对话键 | 配置 `hotkeys.chat` | 悬停裸键，默认 `l` |
| 「桌宠」预设 | 新建对话选择器 | 只读会话（`tool-fs` 仅开 `read`/`readImage`），人格 + 事实段随每次装配现算 |
| 界面 | 设置页 → 快捷键 | 显示服务里当前生效的键帽，改绑后跟着变 |
| 应用级快捷键 | `Ctrl+L`（macOS ⌘+L） | 打开侧栏「桌宠对话」；Web 端保留 `Ctrl+Shift+P`（浏览器占用 `Ctrl+L`） |

## 目录

- `dsh-pet/` —— npm 包本体（`src/` 是源码，`lib/` 是 tsdown 产物，不入库）
- `API.md` / `CONFIG.md` —— 上游文档，本 fork 补了事实记忆接口与新增配置键

## 构建与安装

```powershell
# 依赖 + 构建（产物在 dsh-pet/lib）
pnpm --dir dsh-pet install
pnpm --dir dsh-pet build

# 打包并装进 DSH profile（先退出 DSH，装完再开）
pnpm --dir dsh-pet pack --pack-destination <产物目录>
pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add "file:<产物目录>/dsh-pet-0.4.1.tgz"
```

> pnpm 对相同版本的 `file:` 包会判 `Already up to date`（`--force` 也无效），
> 换包内容时先删掉 `node_modules/dsh-pet` 再 `add`。

## 回滚

```powershell
pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add dsh-pet@0.4.1
```

用户配置与对话记忆在 `$DSH_HOME/dsh-pet/`（`main-config.jsonc`、`memory.json`、`memory-facts.json`），
升级/回滚都不会动它们；改配置前建议先备份。

## 与上游的差异怎么看

```powershell
git diff v0.4.1        # 全部改动
git log v0.4.1..main   # 三个提交：事实记忆与面板 / 预设必填项修复 / Ctrl+L
```
