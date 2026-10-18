# 本仓未包含什么（以及为什么）

> 这一份是**发布时的裁剪记录**，给维护者看，也给别人一个「为什么有些引用指向不存在的文件」的答案。

## 按拍板 O3＝A 排除

- **会话存档**（宿主侧运行数据，含全部往来记录）
- **真实在任声明册**（domains.json，含真实 session id）
- **projectlog/**（开发审计日志：含操作内幕、失败记录、本机路径）
- **_pages/ 里的截图与大 PNG**（0.6–1.3 MB 级；本仓的图一律用 SVG）
- **本机绝对路径与用户名**（统一换成 {体系根} / ~ 等占位符，见 docs/paths.md）

## 模板侧的裁剪

- SYSTEM-changelog.md（270 KB 内部变更史：含真实项目名/会话 id/操作内幕 ⇒ O3 排除）
- 断链修复-任务卡-*.md（5 张，指向具体项目且已全部闭环）
- 项目PROJECT.md改造-任务卡x5.md（同上）
- 悬空skill引用-任务卡-3项目.md（同上）
- b类自动化-skill方案-任务书.md（未定稿方案）
- mission-dispatch-三段式.txt（已退役）
- project-map-cheatsheet.md（已停更插件的小抄）

## 工具侧的裁剪

- check-session-model.mjs
- reasoning-forward-oracle.mjs
- think-loss-scan.mjs（本机诊断脚本，依赖宿主内部实现）

## 已知后果

- 部分框架文档里提到的 SYSTEM-changelog.md 不在本仓 ⇒ 那是**有意**的（历史不公开）。
- 任务卡类模板不在本仓 ⇒ 引用它们的地方会断链，属预期。

## 知识库

按 O8＝C：知识库（坑与经验）**不随本仓公开**。
