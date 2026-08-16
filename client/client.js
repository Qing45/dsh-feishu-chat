// dsh-feishu-chat client bundle: registers the 设置 → 飞书 settings page
// (bot credentials form + workspace picker + connection status).
// Hand-authored CJS bundle for window.__ModuleLoader__ (no build step);
// the only external is the loader module table's `react`.
// Host communication goes through the same-origin HTTP routes in lib/routes.js.
window.__ModuleLoader__.load({ id: "dsh-feishu-chat", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react')
const h = React.createElement
const { useState, useEffect, useCallback } = React

const name = "feishu-bot"
const inject = ["slots"]

const PHASE_TEXT = {
  idle: '未连接',
  stopped: '已停止',
  'got-endpoint': '获取连接端点…',
  open: '已连接 ✅',
  reconnecting: '连接断开，重连中…',
  retrying: '连接失败，重试中…',
  pong: '已连接 ✅',
}

function FeishuSettingsPage() {
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [configured, setConfigured] = useState(false)
  const [wsState, setWsState] = useState(null)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState({ kind: 'idle', text: '' })

  const load = useCallback(() => {
    fetch('/feishu-bot/config', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { setAppId(d.appId || ''); setConfigured(!!d.configured) })
      .catch((e) => setNotice({ kind: 'error', text: '加载配置失败: ' + e.message }))
    fetch('/feishu-bot/workspaces', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setWsState)
      .catch(() => {})
    fetch('/feishu-bot/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const save = () => {
    setBusy(true); setNotice({ kind: 'idle', text: '' })
    fetch('/feishu-bot/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: appId.trim(), appSecret: appSecret.trim() }),
    })
      .then((r) => r.json())
      .then((d) => {
        setBusy(false)
        if (d.ok) {
          setNotice({ kind: 'ok', text: '已保存，正在重新连接…' })
          setAppSecret('')
          setTimeout(load, 1200)
        } else {
          setNotice({ kind: 'error', text: '保存失败: ' + (d.error || 'unknown') })
        }
      })
      .catch((e) => { setBusy(false); setNotice({ kind: 'error', text: '保存失败: ' + e.message }) })
  }

  const switchTo = (id) => {
    setBusy(true); setNotice({ kind: 'idle', text: '' })
    fetch('/feishu-bot/switch-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
      .then((r) => r.json())
      .then((d) => {
        setBusy(false)
        if (d.ok) { load(); setNotice({ kind: 'ok', text: '已切换到所选工作区' }) }
        else setNotice({ kind: 'error', text: '切换失败: ' + (d.error || 'unknown') })
      })
      .catch((e) => { setBusy(false); setNotice({ kind: 'error', text: '切换失败: ' + e.message }) })
  }

  const workspaces = (wsState && wsState.workspaces) || []
  const currentId = (wsState && wsState.currentId) || null
  const wsPhase = (status && status.wsPhase) || 'idle'

  const cardStyle = { border: '1px solid rgba(128,128,128,0.28)', borderRadius: '8px', padding: '14px 16px', margin: '0 0 12px', maxWidth: '560px', width: '100%', boxSizing: 'border-box', overflow: 'hidden', background: 'transparent' }
  const titleStyle = { fontWeight: 600, fontSize: '14px', margin: '0 0 10px' }
  const fieldStyle = { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 8px', fontSize: '13px' }
  const inputStyle = { flex: 1, padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', fontSize: '13px', minWidth: '0' }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', margin: '4px 0', borderRadius: '6px', cursor: 'pointer', border: '1px solid transparent', fontSize: '13px', background: 'transparent', color: 'inherit', width: '100%', boxSizing: 'border-box', minWidth: '0', textAlign: 'left' }
  const activeStyle = { ...rowStyle, background: 'rgba(88,140,255,0.14)', borderColor: 'rgba(88,140,255,0.5)' }
  const btnStyle = { padding: '6px 16px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '13px', background: 'var(--accent, #2f81f7)', color: '#fff', opacity: busy ? 0.6 : 1, disabled: busy }

  return h('div', { style: { padding: '4px' } },
    // ---- bot config ----
    h('div', { style: cardStyle },
      h('div', { style: titleStyle }, '飞书机器人配置'),
      h('div', { style: fieldStyle },
        h('label', { style: { width: '92px', flex: 'none', opacity: 0.75 } }, 'App ID'),
        h('input', { style: inputStyle, value: appId, placeholder: 'cli_xxxxxxxxxxxx', onChange: (e) => setAppId(e.target.value) })),
      h('div', { style: fieldStyle },
        h('label', { style: { width: '92px', flex: 'none', opacity: 0.75 } }, 'App Secret'),
        h('input', { style: inputStyle, type: 'password', value: appSecret,
          placeholder: configured ? '已配置，留空保持不变' : '请输入 App Secret',
          onChange: (e) => setAppSecret(e.target.value) })),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' } },
        h('button', { style: btnStyle, disabled: busy, onClick: save }, busy ? '保存中…' : '保存并重新连接'),
        configured
          ? h('span', { style: { color: '#3fb950', fontSize: '12px' } }, '✓ 已配置 ' + (status && status.wsPhase === 'open' ? '· 长连接在线' : ''))
          : h('span', { style: { color: '#999', fontSize: '12px' } }, '未配置')),
      h('div', { style: { marginTop: '8px', fontSize: '12px', opacity: 0.8 } },
        '连接状态: ' + (PHASE_TEXT[wsPhase] || wsPhase),
        status && status.workspace && status.workspace.title ? ' · 工作区: ' + status.workspace.title : '')),
    // ---- workspace picker ----
    h('div', { style: cardStyle },
      h('div', { style: titleStyle }, '飞书 → 工作区'),
      h('div', { style: { fontSize: '12px', opacity: 0.8, margin: '0 0 6px' } },
        '飞书消息将路由到所选工作区的最新会话。点击工作区即可切换。'),
      workspaces.length === 0
        ? h('div', { style: { color: '#999', fontSize: '12px' } }, '未发现工作区')
        : workspaces.map((w) => {
            const active = w.id === currentId
            return h('div', {
              key: w.id,
              style: active ? activeStyle : rowStyle,
              onClick: () => { if (!busy && !active) switchTo(w.id) },
            },
              h('span', { style: { fontSize: '13px', opacity: 0.7, width: '14px', flex: 'none' } }, active ? '●' : '○'),
              h('span', { style: { fontWeight: active ? 600 : 400, fontSize: '13px', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: '1' } }, w.title),
              h('span', { style: { color: '#888', fontSize: '11px', marginLeft: 'auto', maxWidth: '180px', minWidth: '0', flexShrink: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                w.path + (w.sessionCount != null ? ' (' + w.sessionCount + ')' : '')),
              active ? h('span', { style: { color: '#588cff', fontSize: '11px', marginLeft: '8px', flex: 'none' } }, '当前') : null)
          })),
    // ---- notice ----
    notice.kind === 'ok' ? h('div', { style: { color: '#3fb950', fontSize: '12px' } }, notice.text) : null,
    notice.kind === 'error' ? h('div', { style: { color: '#e5534b', fontSize: '12px' } }, notice.text) : null,
    h('div', { style: { color: '#999', fontSize: '11px', maxWidth: '560px' } },
      '凭证只保存在本机 ' + (typeof process !== 'undefined' && process.env && process.env.DSH_HOME ? process.env.DSH_HOME : '~/.dsh') + '/feishu-bot/config.json，不会上传。'))
}

function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'feishu',
    order: 30,
    label: () => '飞书',
  }, () => h(FeishuSettingsPage, null)))
}

exports.name = name
exports.inject = inject
exports.apply = apply
return module.exports;
} });
