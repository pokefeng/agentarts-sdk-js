# Contributing to agentarts-sdk-js



## 开发环境搭建

见 README。



## 发布（npm）

维护者通过推送 tag 触发 [`.github/workflows/publish-npm.yml`](.github/workflows/publish-npm.yml)，自动发布四个包（各自独立发布，不判断包之间的先后依赖）：

1. `@huaweicloud/huaweicloud-sdk-agentidentity`
2. `@huaweicloud/agentarts-sdk`
3. `@huaweicloud/agentarts-protocol-a2a`
4. `@huaweicloud/agentarts-protocol-agui`

仓库设置：

- **Secrets → `NPM_TOKEN`**：npm Automation token，需具备 `@huaweicloud` scope 的发布权限；
- **Variables（可选）**：`NPM_REGISTRY_URL`（默认 `https://registry.npmjs.org`）、
  `NPM_PROVENANCE=true`（仅对 npmjs 启用 provenance）。

发布步骤：

```bash
pnpm install
pnpm changeset            # 描述本次变更，生成 changeset 文件
pnpm changeset version    # 更新包版本与 CHANGELOG
git add . && git commit -m "chore(release): v0.0.2"
git tag v0.0.2            # 必须与 @huaweicloud/agentarts-sdk 的 version 一致
git push origin main --tags
```

工作流会先执行构建、类型检查、单元测试与四个包的打包校验（tarball 必须包含
`dist/index.js`、`README.md`、`LICENSE`，且不含未改写的 `workspace:` 依赖），
然后依次发布四个包，互不等待；目标版本已存在时自动跳过，便于重复打 tag 或只升其中一个包。
也可以在 **Actions → Publish to npm → Run workflow** 中以 `dry_run=true` 手动验证（只构建/测试/打包，不发布）。

> tag 版本以 `@huaweicloud/agentarts-sdk` 为准；其余三个包按其自身 `version` 发布，
> 与 tag 不一致时工作流会给出告警。
> 版本解析与 tag 校验集中在 [`scripts/publish-meta.mjs`](scripts/publish-meta.mjs)，
> 可本地运行 `node scripts/publish-meta.mjs` 预检。



## 提交规范

使用约定式提交：`feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`



## PR 流程

1. Fork 仓库

2. 创建分支 `feat/xxx`

3. 提交代码

4. 发起 Pull Request

5. 至少 2 人 Review + CI 通过后合并



## Issue 规范

使用 Bug Report / Feature Request 模板

