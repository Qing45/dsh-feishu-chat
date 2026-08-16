// In-process Feishu WebSocket long-connection client.
// Port of the standalone daemon (protobuf frames + auto-ack + ping + reconnect),
// now living inside the host plugin with a clean stop() for fiber teardown.
import WebSocket from 'ws'
import protobuf from 'protobufjs'

// pbbp2 wire schema (matches the official SDK).
const PROTO = `
syntax = "proto3";
package pbbp2;
message Header {
  string key = 1;
  string value = 2;
}
message Frame {
  uint64 SeqID = 1;
  uint64 LogID = 2;
  int32 service = 3;
  int32 method = 4;
  repeated Header headers = 5;
  string payloadEncoding = 6;
  string payloadType = 7;
  bytes payload = 8;
  string LogIDNew = 9;
}
`
const root = protobuf.parse(PROTO, { keepCase: true }).root
const Frame = root.lookupType('pbbp2.Frame')

function encodeFrame(frame) {
  return Frame.encode(Frame.fromObject(frame)).finish()
}

function decodeFrame(buf) {
  const msg = Frame.decode(buf)
  // convert uint64 Long -> number (SeqID/LogID are small in practice)
  if (msg.SeqID && msg.SeqID.toNumber) msg.SeqID = msg.SeqID.toNumber()
  if (msg.LogID && msg.LogID.toNumber) msg.LogID = msg.LogID.toNumber()
  return msg
}

function headersToDict(headers) {
  const d = {}
  for (let i = 0; i < (headers || []).length; i++) {
    const h = headers[i]
    if (h && typeof h.key === 'string') d[h.key] = h.value
  }
  return d
}

// sum/seq fragment merging for split events.
class DataCache {
  constructor() {
    this.cache = new Map()
  }

  mergeData(messageId, sum, seq, traceId, data) {
    let entry = this.cache.get(messageId)
    if (!entry) {
      const buffer = new Array(sum)
      buffer[seq] = data
      this.cache.set(messageId, { buffer, traceId, messageId, createTime: Date.now() })
    } else {
      entry.buffer[seq] = data
    }
    const e = this.cache.get(messageId)
    if (e && e.buffer.every((it) => it !== undefined)) {
      let total = 0
      for (let i = 0; i < e.buffer.length; i++) total += e.buffer[i].length
      const merged = Buffer.alloc(total)
      let off = 0
      for (let i = 0; i < e.buffer.length; i++) {
        e.buffer[i].copy(merged, off)
        off += e.buffer[i].length
      }
      this.cache.delete(messageId)
      return merged
    }
    return null
  }

  sweepExpired() {
    const now = Date.now()
    for (const [k, v] of this.cache.entries()) {
      if (now - v.createTime > 10000) this.cache.delete(k)
    }
  }
}

export class FeishuWsClient {
  constructor({ client, onEvent, onStatus, onError }) {
    this.client = client
    this.onEvent = onEvent || (() => {})
    this.onStatus = onStatus || (() => {})
    this.onError = onError || (() => {})
    this.ws = null
    this.connectTimer = null
    this.pingTimer = null
    this.sweepTimer = null
    this.dataCache = new DataCache()
    this.serviceId = 0
    this.pingIntervalMs = 0
    this.closed = false
    this.phase = 'idle'
  }

  start() {
    this.closed = false
    this.connect()
  }

  // Clean teardown: clear timers, drop listeners, terminate the socket.
  stop() {
    this.closed = true
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null }
    if (this.ws) {
      try { this.ws.removeAllListeners() } catch (e) { /* ignore */ }
      try { this.ws.terminate() } catch (e) { /* ignore */ }
      this.ws = null
    }
    this.phase = 'stopped'
  }

  reconnectSoon(delayMs) {
    if (this.closed) return
    if (this.connectTimer) return
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      this.connect()
    }, delayMs)
  }

  async connect() {
    if (this.closed) return
    try {
      const cfg = await this.client.wsEndpoint()
      const wsUrl = cfg.data.URL
      const clientCfg = cfg.data.ClientConfig || {}
      const qs = new URL(wsUrl).searchParams
      this.serviceId = Number(qs.get('service_id') || 0)
      this.pingIntervalMs = (clientCfg.PingInterval || 90) * 1000
      this.phase = 'got-endpoint'
      this.onStatus({ phase: this.phase, serviceId: this.serviceId, pingIntervalMs: this.pingIntervalMs })

      this.ws = new WebSocket(wsUrl, { perMessageDeflate: false })
      this.ws.binaryType = 'nodebuffer'

      this.ws.on('open', () => {
        this.phase = 'open'
        this.onStatus({ phase: this.phase })
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.pingTimer = setInterval(() => this.sendPing(), this.pingIntervalMs)
        if (this.sweepTimer) clearInterval(this.sweepTimer)
        this.sweepTimer = setInterval(() => this.dataCache.sweepExpired(), 5000)
        if (this.sweepTimer.unref) this.sweepTimer.unref()
      })

      this.ws.on('message', (data) => this.handleMessage(data))
      this.ws.on('error', (e) => this.onError('ws error: ' + (e && e.message ? e.message : String(e))))
      this.ws.on('close', (code, reason) => {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
        if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null }
        this.phase = 'reconnecting'
        this.onStatus({ phase: this.phase, code, reason: reason ? String(reason) : '' })
        this.reconnectSoon(3000)
      })
    } catch (err) {
      this.phase = 'retrying'
      this.onError('connect config failed: ' + (err && err.message ? err.message : String(err)))
      this.onStatus({ phase: this.phase })
      this.reconnectSoon(5000)
    }
  }

  sendPing() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const frame = {
      SeqID: 0,
      LogID: 0,
      service: this.serviceId,
      method: 0, // control
      headers: [{ key: 'type', value: 'ping' }],
    }
    try { this.ws.send(encodeFrame(frame)) } catch (e) { /* ignore */ }
  }

  sendAck(originalFrame, respPayload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const headers = (originalFrame.headers || []).slice()
    headers.push({ key: 'biz_rt', value: '0' })
    const payload = Buffer.from(JSON.stringify(respPayload), 'utf8')
    const frame = {
      SeqID: originalFrame.SeqID || 0,
      LogID: originalFrame.LogID || 0,
      service: this.serviceId,
      method: originalFrame.method || 0,
      headers,
      payloadType: 'application/json',
      payloadEncoding: 'utf8',
      payload,
    }
    try { this.ws.send(encodeFrame(frame)) } catch (e) {
      this.onError('send ack failed: ' + (e && e.message ? e.message : String(e)))
    }
  }

  handleMessage(data) {
    if (!Buffer.isBuffer(data)) {
      try { data = Buffer.from(String(data), 'utf8') } catch (e) { return }
    }
    let frame
    try { frame = decodeFrame(data) } catch (e) {
      this.onError('decode failed: ' + (e && e.message ? e.message : String(e)))
      return
    }
    if (frame.method === 1) this.handleEventFrame(frame)
  }

  handleEventFrame(frame) {
    const hdr = headersToDict(frame.headers)
    const type = hdr.type
    if (type === 'event' || type === 'card') {
      const sum = Number(hdr.sum || 1)
      const seq = Number(hdr.seq || 0)
      const messageId = hdr.message_id || ''
      const traceId = hdr.trace_id || ''
      const merged = this.dataCache.mergeData(
        messageId, sum, seq, traceId,
        Buffer.isBuffer(frame.payload) ? frame.payload : Buffer.from(frame.payload || []),
      )
      if (merged) {
        const text = merged.toString('utf8')
        let eventObj = null
        try { eventObj = JSON.parse(text) } catch (e) { eventObj = { _raw: text } }
        this.onEvent({ message_id: messageId, trace_id: traceId, event: eventObj })
        // Auto ack with {code:200}
        this.sendAck(frame, { code: 200 })
      }
    } else if (type === 'pong') {
      let cfg = null
      if (frame.payload && frame.payload.length) {
        try { cfg = JSON.parse(Buffer.from(frame.payload).toString('utf8')) } catch (e) { /* ignore */ }
      }
      if (cfg && cfg.PingInterval) {
        this.pingIntervalMs = cfg.PingInterval * 1000
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.pingTimer = setInterval(() => this.sendPing(), this.pingIntervalMs)
      }
      this.onStatus({ phase: 'pong', config: cfg })
    }
  }
}
