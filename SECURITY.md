# 安全策略

## 信息披露政策

如果你发现了安全漏洞，请通过 GitHub 的私密漏洞报告功能提交，**不要在公开的 Issue 中披露**：

**<https://github.com/talebook/moke/security/advisories/new>**

报告中请包含：

- 漏洞的简要描述与影响范围
- 复现步骤或概念验证（PoC）
- 受影响的版本或 commit

我们会在收到报告后尽快回复，并在修复发布前与你保持沟通。修复发布后，漏洞细节可以在公开渠道讨论。

## 安全更新策略

| 版本 | 支持状态 |
|---|---|
| 最新 Release | 提供安全修复 |
| `main` 分支 | 提供安全修复 |
| 旧版本 | 不提供安全修复 |

当安全漏洞被确认并修复后：

1. 发布新版本，在 Release Notes 中说明已修复的安全问题
2. 在 GitHub Security Advisory 中公开漏洞详情
3. 建议所有用户尽快升级到最新版本

可通过以下方式获取安全更新通知：

- Watch 本仓库的 Release
- 关注 [Releases 页面](../../releases)

