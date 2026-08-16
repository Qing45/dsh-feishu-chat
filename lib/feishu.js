// Feishu Open Platform HTTPS client (in-process, no subprocess needed).
// Uses rejectUnauthorized:false so the long connection works behind corporate
// MITM proxies / on Windows boxes with broken certificate stores.
import https from 'node:https'
import { URL } from 'node:url'

const FEISHU_API = 'https://open.feishu.cn/open-apis'

export function httpRequest(urlStr, method = 'GET', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const opts = {
      method: method.toUpperCase(),
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: headers || {},
      rejectUnauthorized: false,
    }
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    if (payload !== null) opts.headers['Content-Length'] = payload.length
    const req = https.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch (e) { /* keep null */ }
        resolve({ status: res.statusCode, json, body: text })
      })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

export class FeishuClient {
  constructor(getCreds) {
    this.getCreds = getCreds
    this.tokenCache = null
    this.tokenExpiresAt = 0
  }

  resetToken() {
    this.tokenCache = null
    this.tokenExpiresAt = 0
  }

  creds() {
    const { appId, appSecret } = this.getCreds()
    if (!appId || !appSecret) throw new Error('feishu not configured — set App ID / App Secret in 设置 → 飞书')
    return { appId, appSecret }
  }

  async token() {
    const now = Date.now()
    if (this.tokenCache && this.tokenExpiresAt > now + 60000) return this.tokenCache
    const { appId, appSecret } = this.creds()
    const r = await httpRequest(
      FEISHU_API + '/auth/v3/tenant_access_token/internal',
      'POST',
      { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ app_id: appId, app_secret: appSecret }),
    )
    const d = r.json
    if (!d || d.code !== 0) throw new Error('feishu token: code=' + (d && d.code) + ' msg=' + (d && d.msg))
    this.tokenCache = d.tenant_access_token
    this.tokenExpiresAt = now + (d.expire - 300) * 1000
    return this.tokenCache
  }

  async sendMessage(chatId, text) {
    const tok = await this.token()
    const body = { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: String(text || '').slice(0, 4000) }) }
    const r = await httpRequest(
      FEISHU_API + '/im/v1/messages?receive_id_type=chat_id',
      'POST',
      { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + tok },
      JSON.stringify(body),
    )
    const d = r.json
    if (!d || d.code !== 0) throw new Error('feishu send: code=' + (d && d.code) + ' msg=' + (d && d.msg))
    return d
  }

  // The WebSocket long-connection endpoint (camelCase body, ROOT domain).
  async wsEndpoint() {
    const { appId, appSecret } = this.creds()
    const r = await httpRequest(
      'https://open.feishu.cn/callback/ws/endpoint',
      'POST',
      { 'Content-Type': 'application/json; charset=utf-8', locale: 'zh', 'User-Agent': 'dsh-feishu-chat/1.0' },
      JSON.stringify({ AppID: appId, AppSecret: appSecret }),
    )
    if (!r.json || r.json.code !== 0 || !r.json.data || !r.json.data.URL) {
      throw new Error('getWsConfig failed: status=' + r.status + ' body=' + (r.body || '').slice(0, 200))
    }
    return r.json
  }
}
