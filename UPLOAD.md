# 上传到 DSH 插件社区 — 操作指南

本插件是完全符合社区格式的 DSH bundle(`package.json` 声明 `dsh.bundle.patch` + `dsh.client`,
`cordis.patch.yml` 插入插件行),可被 `dsh plugin add` 安装。下面是发布到社区的三条路径,
可以全做,也可以只做第一条。

---

## 1. GitHub 仓库(推荐,必做)

### 1.1 创建仓库并推送

```bash
# 在 GitHub 上新建一个空仓库(不要勾选 README/.gitignore,避免冲突),比如:
#   https://github.com/new  → 仓库名: dsh-feishu-chat
# 然后在本机执行:
cd D:\deepseek\dsh-feishu-chat
git remote add origin https://github.com/<你的用户名>/dsh-feishu-chat.git
git push -u origin main
```

### 1.2 添加 topics

仓库页 → 右上角 `About` → ⚙ → Topics 填:

```
dsh-plugin  deepseek-harness  dsh  feishu  lark  bot
```

(带 `dsh-plugin` topic 后会自动出现在 https://github.com/topics/dsh-plugin 列表里)

### 1.3 发布前必须改的一处

`package.json` 里的 `repository.url` 目前是占位符:

```json
"repository": { "type": "git", "url": "git+https://github.com/<your-github-name>/dsh-feishu-chat.git" }
```

把它换成你的真实地址后再 commit/push。

### 1.4 安装验证(其他用户/你自己的命令)

```bash
# 直接从 GitHub 装(推荐,无需 npm 发布):
dsh plugin --profile web add github:Qing45/dsh-feishu-chat
# 或先 clone 到本地再装:
dsh plugin --profile web add D:\path\to\dsh-feishu-chat
```

装完重启 `dsh web`,打开 `设置 → 飞书` 配置 App ID/App Secret 即可。
本包**没有构建脚本**(prepare/build),所以 pnpm 不会要求 allowBuilds 审批,开箱即装。

---

## 2. 发布到 npm(可选,但能让 `dsh plugin add dsh-feishu-chat` 按名字直接装)

`dsh-feishu-chat` 已在 npm 上确认**可用**(原名 `dsh-feishu-bot` 被别人占用,故改名),直接发布即可。

### 发布步骤

```bash
npm login          # 没有 npm 账号先到 https://www.npmjs.com/signup 注册
cd D:\deepseek\dsh-feishu-chat
npm publish        # 会按 package.json 的 files 字段打包 lib/ client/ cordis.patch.yml 等
```

发布后验证:

```bash
npm view dsh-feishu-chat version
dsh plugin --profile web add dsh-feishu-chat
```

---

## 3. 收录进 awesome-dsh-plugin 精选列表(可选,推荐)

列表:https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
收录后 dsh-market 的插件市场快照(awesome-dsh-plugin.com/plugins.json)会自动带上你的插件。

1. Fork 仓库,clone 到本地
2. 编辑 `README.md`(英文)和 `README.zh.md`(中文),在 **Notifications & Integrations** 段加一行:

   ```markdown
   <你的用户名>/dsh-feishu-chat - 飞书机器人 ↔ DSH 双向聊天桥：飞书消息直达智能体并自动回复，设置页可换机器人凭证、切换工作区。
   ```
3. 按 `contributing.md` 要求(格式、排序、描述简洁)提交 PR

---

## 安全与合规提醒

- **凭证不提交**:App ID/App Secret 只存用户本机 `$DSH_HOME/feishu-bot/config.json`(已在 `.gitignore` 与
  `files` 之外),仓库不含任何密钥。
- **README 免责声明**:社区插件 = 第三方代码,安装即信任。README 已写明,若上榜建议保留。
- **TLS 说明**:`lib/feishu.js` 使用了 `rejectUnauthorized: false`(为兼容企业代理/损坏证书存储),
  README 已说明该取舍,请勿在公开讨论中淡化它。
- **工具名**:模型工具为 `feishu_send_message`,全局唯一,与动态插件时代的 `larkz_send_message` 无关。
