# dsh-feishu-chat

飞书机器人 ↔ [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 双向聊天桥：给飞书机器人发消息，DSH 智能体自动回复；智能体也能主动往飞书发消息。

## 功能

- **填写 App ID / App Secret 即可连接飞书机器人** — 装好插件，打开 `设置 → 飞书`，把飞书开放平台 → 你的应用 → 凭证与基础信息 里两项值粘进去，点**保存并重新连接**，长连接就起来了，全程不需要手改配置文件。
- **随时切换绑定工作区** — 同一个设置页会列出 profile 已知的所有工作区（名称 + 路径 + 最近活动时间），点哪一行就把入站飞书消息重新路由到那个工作区；选择会被持久化，路由器在线热切换，无需重启 DSH。
- **双向聊天** — 飞书消息经官方 WebSocket 长连接（`im.message.receive_v1`）到达 DSH，委派给**当前绑定工作区**最新会话的子代理处理，纯文本回复自动发回原聊天。
- **智能体 → 飞书工具** — 模型获得 `feishu_send_message` 工具，任意会话都能把消息推给最近联系过 DSH 的飞书聊天（或指定 `chat_id`）。
- **稳定的长连接** — protobuf 帧解码（`pbbp2`）、自动 ack、ping 保活、`sum`/`seq` 分片合并、断线退避重连，全部在宿主进程内完成；停止或更新插件时全部清理干净。

## 安装

```bash
# 从 npm（发布后）或本仓库：
dsh plugin --profile web add dsh-feishu-chat
# 或直接从 GitHub：
dsh plugin --profile web add github:Qing45/dsh-feishu-chat
```

重启 `dsh web`，打开 `设置 → 飞书`：

1. **连接机器人** — 填写机器人 **App ID** 与 **App Secret**（飞书开放平台 → 你的应用 → 凭证与基础信息），点**保存并重新连接**。状态行变绿就表示长连接已建立。
2. **选择工作区** — 工作区列表展示 profile 已知的所有工作区（名称 + 路径 + 最近活动时间）。点哪一行就绑定哪个，入站飞书消息就会路由到该工作区最新会话。之后可以随时切换，无需重启。

> ⚠️ 本插件是社区第三方代码 —— 安装即表示你信任该来源。凭证只保存在本机 `$DSH_HOME/feishu-bot/config.json`，不会被提交或上传。

## 工作原理

| 组成 | 文件 | 职责 |
| --- | --- | --- |
| Host 入口 | `lib/index.js` | Cordis 插件（`export const name` + `export function apply`），串联配置、路由、WS、工具与 HTTP 路由 |
| 飞书 API | `lib/feishu.js` | `node:https` 助手：租户令牌、发消息、WS 端点 |
| WS 客户端 | `lib/ws.js` | 进程内长连接：protobuf `pbbp2.Frame`、自动 ack、ping、分片合并、重连 |
| 路由 | `lib/router.js` | 入站消息 → 解析父代理（initiator → live agent → resume）→ 子代理 → 回复 |
| 配置 | `lib/config.js` | `$DSH_HOME/feishu-bot/config.json` 持久化 |
| HTTP 路由 | `lib/routes.js` | 设置页所用路由（写操作仅限同源） |
| Client | `client/client.js` | `window.__ModuleLoader__.load` bundle，注册 `设置 → 飞书` 页面 |

本包是标准 DSH bundle：`package.json` 声明 `dsh.bundle.patch`（层插入）与 `dsh.client`（web bundle），`cordis.patch.yml` 把插件行插入 profile 树。

## 本地开发安装（免重启 GUI）

profile 自己的补丁层（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）支持热加载：

```bash
pnpm --dir "$DSH_HOME/profiles/web" add /path/to/dsh-feishu-chat
```

然后在 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: feishu-bot
      name: 'dsh-feishu-chat'
```

刷新浏览器即可在设置页看到「飞书」，无需重启。

## 注意事项

- 每条入站消息会生成一个子代理（无排队），突发消息时回复可能乱序。
- 出于兼容（企业代理 / 证书存储损坏的环境），TLS 校验被放宽（`rejectUnauthorized: false`），请自行评估该取舍。
- 工具名为 `feishu_send_message`；省略 `chat_id` 时发给最近联系过 DSH 的飞书聊天。

## License

MIT
