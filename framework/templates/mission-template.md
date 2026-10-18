# 使命登记模板（`tools\mission.mjs` 中文速查）

> **定位（2026-08-27 调整）**：这是**主会话写三段式任务指令时的字段速查**——确保三段式里把 declare 需要的字段都写全。
> 域会话不需要读本文件：三段式任务指令（`mission-dispatch-三段式.txt`）本身已包含 declare 全部字段指引。
> **工具在 2026-10-01 换成本地脚本**：`project_map` 插件没随 dsh 桌面端迁移且作者已停更 → 改用 `node {体系根}\tools\mission.mjs`（同目录、同 JSON 格式，索引零改动即可读）。完整命令表见 `project-map-cheatsheet.md`。
> 参数是英文长选项（固定），但**值全部可用中文**。只需记 6 项。

## 键名速查

| 参数 | 填什么 | 示例 |
|---|---|---|
| `--name` | 使命短名（**英文**短横线，用于分支 `feature/<name>`） | `fix-login-bug` |
| `--feature` | 本次要改的功能（一句话，中文） | 修复登录 token 过期问题 |
| `--untouched` | 明确不动什么（边界，中文） | 不动数据库结构、不动公共工具函数签名 |
| `--files` | 涉及文件/目录（**逗号分隔**） | `"src/auth/"` |
| `--acceptance` | 验收标准（可勾选，中文） | 登录态保持 24h 不失效；旧 token 自动刷新 |
| `--session` | 登记它的会话 id（**别漏**，漏了索引只能靠 cwd 兜底、可能归错项目） | `session-xxxxxxxx-…` |

## 一句话中文登记（推荐用法）

> **注册使命：修登录 bug。改 src/auth 下的登录逻辑，不动数据库结构。验收：登录态保持 24 小时，旧 token 自动刷新。**

AI 转译结果：
```
node {体系根}\tools\mission.mjs declare ^
  --name fix-login-bug ^
  --feature "修复登录 token 过期问题" ^
  --untouched "不动数据库结构" ^
  --files "src/auth/" ^
  --acceptance "登录态保持24h不失效；旧token自动刷新" ^
  --session session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## 常见预设（直接复制改）

| 场景 | 命令骨架 |
|---|---|
| 修 bug | `declare --name fix-<简述> --feature "<修什么>" --untouched "<不碰什么>" --files "<文件>" --acceptance "<验证方式>" --session <id>` |
| 加功能 | `declare --name feat-<简述> --feature "<新功能>" --untouched "<不碰什么>" --files "<文件>" --acceptance "<功能可用标准>" --session <id>` |
| 重构 | `declare --name refactor-<简述> --feature "<重构目标>" --untouched "<行为不变>" --files "<文件>" --acceptance "<原有测试全过>" --session <id>` |

## 注意

- `name` 建议用英文短横线：它同时是分支名 `feature/<name>`，中文名会导致分支名含中文。
- 其余字段值全中文，无限制。
- **`--session` 漏了不会报错**，但索引会退回 cwd 兜底 → 可能把这条使命归到别的项目（静默）。declare 会回显"归属项目 + 依据"，**肉眼核对一下**。
- 中途范围变化：**先更新使命再继续**，不许悄悄扩大范围。

## 达成报告 5 段格式（2026-08-30 定，写进三段式【执行协议】第 4 步）

三段式里【执行协议】第 4 步必须带达成报告格式说明，域会话 `complete` 时按此输出。

> **格式唯一源＝`templates\dispatch-template.md` 的「达成报告（必填字段）」节**（2026-10-18 用户拍板 L1④：同一份格式原来在 6 处各写一遍，改一处必漏五处）。
> 本节**不再复制字段清单**；派发到域会话时，把 dispatch-template 的那节原文贴进三段式即可（域会话也不用回来读本文件）。
