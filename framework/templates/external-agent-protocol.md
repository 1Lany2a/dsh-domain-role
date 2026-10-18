# 外部 Agent 接入协议

> ⚠️ **历史版本（v1）**：已被 `zcode-protocol.md`（v2）取代，仅保留作背景参考，**不再用于实际派发**。外部 agent 达成报告格式以 `zcode-protocol.md` 第七节为准（含 2026-08-30 的 5 段必填字段）。
> 适用：非 dsh 的 AI 编程工具（Cursor / Cline / Qoder 等）参与本机项目协作时，必须遵守本协议。
> 项目根：`{体系根}\<项目名>\`；统一 git 仓库，主干 `main`。
> 本协议与 dsh 的三级会话 + project_map 体系并存：外部 agent 不使用 project_map，靠 **git 分支 + 文件协议**参与。

## 接入前必读（开工前先读这几个文件）

1. `PROJECT.md` — 项目当前状态、最近变更、下一步、已知坑（**只读，不修改**）
2. `KNOWLEDGE.md` — 项目架构决策、接口约定、项目特有坑（**只读，不修改**）
3. `ROLES.md`（若存在）— 本项目特定角色分工与约定（**只读，不修改**）
4. `.dsh\missions\` 目录 — 当前有哪些活跃使命（避免撞同一文件）

## 铁律（违反 = 改动无效）

1. **一任务一分支**：开工前 `git checkout -b feature/<任务名>`，禁止直接改 `main`。
2. **唯一写者**：`PROJECT.md`、`KNOWLEDGE.md`、`ROLES.md` **只有主会话（dsh）能写**，外部 agent 不得修改这三个文件。你的改动信息通过 git 分支 + 达成报告传递，主会话统一汇总。
3. **pre-commit hook 约束**：项目已安装 git pre-commit hook，**自动拦截**任何对 `PROJECT.md` / `KNOWLEDGE.md` 的直接提交。即使外部 agent 绕过唯一写者规则尝试 `git commit`，hook 会让提交失败。主会话提交共享文档时需先 `touch .main-writer-flag` 创建放行标记（提交后自动删除），外部 agent **不应使用此标记**——外部 agent 的正确做法是只改代码，共享文档由主会话统一更新。
4. **先看后改**：改任何文件前，先看 `.dsh\missions\` 有没有别的使命在碰同一文件；有冲突 → 停下，等用户裁决，不抢写。
5. **小步提交**：一个功能/修复一次 commit，message 用英文：`fix: <简述>` / `feat: <简述>` / `refactor: <简述>`。
6. **不扩大范围**：只改任务要求的文件；中途要扩大改动范围 → 先通知用户，不许悄悄改别的。

## 工作流（每个任务固定循环）

```
1. 读 PROJECT.md + KNOWLEDGE.md（了解项目）+ 看 .dsh\missions\（查冲突）
2. git checkout -b feature/<任务名>
3. 改代码（小步 commit）
4. 写达成报告：.dsh\missions\<任务名>.md（见下方模板）
5. 结束（不合并，不写 PROJECT.md——主会话统一做）
```

## 达成报告模板（`.dsh\missions\<任务名>.md`）

```markdown
# 使命达成报告：<任务名>

- 分支：feature/<任务名>
- 完成时间：YYYY-MM-DD
- 改了什么：（一句话功能描述）
- 涉及文件：（清单）
- 验收：（逐条对照任务要求，怎么验证的）
- 未完成/遗留：（没有则写"无"）
- 踩坑/注意：（给主会话合并时参考；没有则写"无"）
```

## 冲突处理

- 改前看 `.dsh\missions\` 有活跃使命碰同一文件 → 停下，通知用户
- 用户裁决：合并使命 / 排队 / 拆分范围
- 不得各自为战

## 禁止事项清单

- ❌ 直接改 `main` 分支
- ❌ 修改 `PROJECT.md` / `KNOWLEDGE.md` / `ROLES.md`（hook 会自动拦截提交）
- ❌ 使用 `.main-writer-flag`（那是主会话专用放行标记，外部 agent 不该碰共享文档）
- ❌ 改任务范围外的文件（除非先通知用户）
- ❌ 提交不写 commit message 或写中文 message
- ❌ 删除 `.dsh\missions\` 里别人的达成报告

## 与 dsh 体系的分工

| 角色 | 工具 | 职责 |
|---|---|---|
| 主会话 | dsh | 统筹规划 + 合并所有分支 + 唯一写者更新共享文档 |
| dsh 子会话 | dsh + `tools\mission.mjs` | declare 使命 → 分支执行 → complete |
| 副会话 | dsh / 本地模型 | 答疑解惑 |
| **外部 agent** | Cursor/Cline/Qoder 等 | 按本协议开分支执行，不碰共享文档 |

## 外部 agent 接入步骤（给用户操作）

1. 在外部工具里打开项目目录 `{体系根}\<项目名>\`
2. 把本协议内容作为"系统提示/规则/约定"喂给该工具（或放在项目根 `EXTERNAL-AGENT.md` 让工具自动读）
3. 派任务时，告诉它分支名（`feature/<任务名>`）和任务范围
4. 完成后检查它有没有违反铁律（尤其有没有碰 PROJECT.md）
