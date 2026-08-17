# dsh-feishu-chat

Feishu (Lark) bot bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): send a message to your Feishu bot and your DSH agent answers; the agent can also push messages back to Feishu.

[中文说明](README.zh.md)

## Features

- **Connect your Feishu bot by filling in App ID / App Secret** — install the plugin, open `设置 → 飞书`, paste the two values from Feishu Open Platform → your app → 凭证与基础信息, click **保存并重新连接**, and the long connection comes up immediately. No config files to edit by hand.
- **Switch the bound workspace at any time** — the same settings page lists every workspace the profile knows about (name + path + last activity). Click any row to retarget inbound Feishu messages to that workspace; the choice persists and the router reroutes live without restarting the harness.
- **Two-way chat** — Feishu messages arrive over the official WebSocket long connection (`im.message.receive_v1`) and are delegated to a subagent of the **bound workspace's** latest session; the text reply is sent back to the same chat automatically.
- **Agent → Feishu tool** — the model gets a `feishu_send_message` tool, so any session can push a message to the last chat that contacted DSH (or a given `chat_id`).
- **Robust long connection** — protobuf frame decode (`pbbp2`), automatic ack, ping keep-alive, fragment merging (`sum`/`seq`), and reconnect with backoff, all in-process; stopping or updating the plugin tears everything down cleanly.

## Install

```bash
# from npm (once published) or from this repo:
dsh plugin --profile web add dsh-feishu-chat
# or directly from GitHub:
dsh plugin --profile web add github:Qing45/dsh-feishu-chat
```

Then restart `dsh web` and open `设置 → 飞书`:

1. **Connect the bot** — fill in the **App ID** and **App Secret** (Feishu Open Platform → your app → 凭证与基础信息), click **保存并重新连接**. The status line turns green when the long connection is up.
2. **Pick the workspace** — the workspace list shows every workspace the profile knows about (name + path + last activity). Click any row to bind it; inbound Feishu messages will be routed to that workspace's latest session from now on. Switch any time, no restart needed.

> ⚠️ This plugin is community third-party code — installing it runs it with your own permissions. Check the source before installing. Credentials stay local in `$DSH_HOME/feishu-bot/config.json` and are never committed or uploaded.

## How it works

| Piece | File | Role |
| --- | --- | --- |
| Host entry | `lib/index.js` | Cordis plugin (`export const name` + `export function apply`), wires config, router, WS client, tool and HTTP routes |
| Feishu API | `lib/feishu.js` | `node:https` helpers: tenant token, send message, WS endpoint |
| WS client | `lib/ws.js` | in-process long connection: protobuf `pbbp2.Frame`, auto-ack, ping, fragment merge, reconnect |
| Router | `lib/router.js` | inbound message → resolve parent agent (initiator → live agent → resume) → subagent → reply |
| Config | `lib/config.js` | `$DSH_HOME/feishu-bot/config.json` persistence |
| Routes | `lib/routes.js` | HTTP routes for the settings UI (same-origin writes only) |
| Client | `client/client.js` | `window.__ModuleLoader__.load` bundle registering the `设置 → 飞书` section |

The package is a standard DSH bundle: `package.json` declares `dsh.bundle.patch` (layer insertion) and `dsh.client` (web bundle), and `cordis.patch.yml` inserts the plugin row into the profile tree.

## Development / local install without a GUI restart

The profile's own patch layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) is hot-reloaded:

```bash
pnpm --dir "$DSH_HOME/profiles/web" add /path/to/dsh-feishu-chat
```

Then append to `cordis.patch.yml`:

```yaml
- insert:
    - id: feishu-bot
      name: 'dsh-feishu-chat'
```

Refresh the browser — the settings section appears without restarting the harness.

## Caveats

- One subagent is spawned per inbound message (no queueing); replies may arrive out of order under a burst.
- The TLS verification is relaxed (`rejectUnauthorized: false`) so the long connection works behind corporate MITM proxies / broken certificate stores; review this trade-off for your environment.
- The tool name is `feishu_send_message`; `chat_id` defaults to the most recent chat that contacted DSH.

## License

MIT
