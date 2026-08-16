// Incoming Feishu message routing: resolve a parent agent for the bound
// workspace's session, delegate the message to a subagent, and send the
// subagent's text reply back to the Feishu chat.
export class FeishuRouter {
  constructor({ ctx, client, getBound, log, logErr }) {
    this.ctx = ctx
    this.client = client
    this.getBound = getBound
    this.log = log
    this.logErr = logErr
    this.seen = new Set()
    this.subagentParent = null
    this.providerName = null
    this.lastChatByUser = {}
  }

  resetParent() {
    this.subagentParent = null
  }

  // Feishu event payload is double-nested: event.event.message / event.event.sender.
  extractEventFields(raw) {
    const ev = (raw && raw.event) || raw || {}
    const inner = (ev.event && typeof ev.event === 'object') ? ev.event : ev
    const msg = (inner && inner.message) || ev.message || {}
    const sender = (inner && inner.sender && inner.sender.sender_id) || {}
    return { msg, senderOpenId: sender.open_id || sender.union_id || sender.user_id || '' }
  }

  // Parent resolution order:
  // 1) the current conversation's initiator (when available)
  // 2) the bound session's live agent (agents.get)
  // 3) resume a non-live session (last resort)
  async resolveParent() {
    const bound = this.getBound()
    if (this.subagentParent) return this.subagentParent
    const agents = this.ctx.get('agents')
    try {
      const ini = agents && agents.currentInitiator && agents.currentInitiator()
      if (ini) { this.subagentParent = { agent: ini }; this.log('parent = initiator'); return this.subagentParent }
    } catch (e) { this.logErr('initiator lookup failed:', String(e)) }
    if (bound.sessionId) {
      try {
        const live = agents && agents.get && agents.get(bound.sessionId)
        if (live) { this.subagentParent = { agent: live }; this.log('parent = live agent of bound session'); return this.subagentParent }
      } catch (e) { this.logErr('live agent lookup failed:', String(e)) }
    }
    // 2b) any LIVE agent whose session cwd is inside the bound workspace —
    // e.g. the user's current web session, which has a working LLM route.
    if (bound.path) {
      try {
        const inWorkspace = (agents.list() || []).find((a) => {
          try {
            const cwd = a.session && a.session.header && a.session.header.cwd
            return !!cwd && cwd.toLowerCase() === bound.path.toLowerCase()
          } catch (e2) { return false }
        })
        if (inWorkspace) { this.subagentParent = { agent: inWorkspace }; this.log('parent = live agent in workspace'); return this.subagentParent }
      } catch (e) { this.logErr('workspace live agent lookup failed:', String(e)) }
    }
    if (!bound.sessionId) return null
    try {
      const agentLoop = this.ctx.get('agentLoop')
      const handle = await agentLoop.resume(this.ctx, { resumeSessionId: bound.sessionId })
      this.subagentParent = handle
      this.log('parent = resumed agent')
      return handle
    } catch (e) {
      this.logErr('resume failed:', String(e))
      return null
    }
  }

  async handleIncoming(m) {
    if (!m || !m.event) return
    const { msg, senderOpenId } = this.extractEventFields(m.event)
    const chatId = msg.chat_id || ''
    const messageId = msg.message_id || ''
    const messageType = msg.message_type || 'text'
    let text = ''
    try {
      const parsed = JSON.parse(msg.content || '{}')
      if (messageType === 'text') text = parsed.text || ''
      else text = '[' + messageType + ']'
    } catch (e) { text = msg.content || '' }
    if (!messageId) { this.logErr('skip: no message_id'); return }
    if (this.seen.has(messageId)) return
    this.seen.add(messageId)
    if (!text || !chatId) { this.logErr('skip: empty text/chatId'); return }

    const bound = this.getBound()
    this.lastChatByUser[bound.sessionId] = chatId
    this.lastChatByUser['__last__'] = chatId
    this.log('📨 from=' + senderOpenId + ' chat=' + chatId + ' text=' + JSON.stringify(text.slice(0, 80)))

    let parent
    try { parent = await this.resolveParent() } catch (e) { this.logErr('resolveParent failed:', String(e)); return }
    if (!parent || !parent.agent) { this.logErr('no parent agent available'); return }

    const subagents = this.ctx.get('subagents')
    if (!subagents || !subagents.start) { this.logErr('no subagents service'); return }
    const prov = this.providerName || (subagents.list && subagents.list()[0])
    if (!prov) { this.logErr('no subagent provider registered'); return }

    const promptText =
      '[飞书入站消息]\n' +
      'chat_id: ' + chatId + '\n' +
      'sender_open_id: ' + senderOpenId + '\n' +
      'message_id: ' + messageId + '\n' +
      '当前工作区: ' + (bound.title || '?') + ' (' + (bound.path || '?') + ')\n' +
      '\n' + text +
      '\n\n[System: 请用纯文本回复。host 会自动把你的回复发回这个飞书聊天。不要调用任何飞书工具。]'

    let replyText = ''
    let stopReason = ''
    try {
      // The child inherits the parent's provider/model route. A cold-resumed
      // parent may carry no model selection, which fails the child's first
      // step instantly; fall back to the deployment's default selection.
      const popt = (parent.agent && parent.agent.options) || {}
      let agentOptions
      if (!popt.provider || !popt.model) {
        try {
          const adm = this.ctx.get('agentDefaultModel')
          const sel = adm && adm.currentSelection && adm.currentSelection()
          if (sel && sel.provider && sel.model) agentOptions = { provider: sel.provider, model: sel.model }
        } catch (e) { this.logErr('default model lookup failed:', String(e)) }
      }
      const run = await subagents.start(prov, {
        label: 'feishu:' + senderOpenId,
        prompt: [{ type: 'text', text: promptText }],
        parent: parent.agent,
        signal: new AbortController().signal,
        ...agentOptions !== undefined ? { agentOptions } : {},
      })
      try {
        const result = await run.result
        stopReason = (result && result.stopReason) || ''
        const out = (result && result.output) || []
        this.log('subagent stopReason=' + stopReason + ' blocks=' + out.length + ' shape=' + JSON.stringify(out.slice(0, 3)))
        for (let i = 0; i < out.length; i++) {
          const block = out[i]
          if (block && block.type === 'text' && block.text) replyText += block.text
        }
        if (!replyText) {
          // Diagnostic: what did the child actually do?
          try {
            const child = run.localAgent
            const events = child && child.session ? child.session.events : null
            if (events && events.length) {
              const tail = events.slice(-8).map((e) => {
                const t = (e && e.type) || '?'
                return t + (e && e.data && e.data.error ? ':ERR' : '')
              }).join(',')
              this.log('child event tail: ' + tail)
            }
          } catch (e2) { this.logErr('child diag failed:', String(e2)) }
        }
      } finally {
        try { await run.dispose() } catch (e3) { this.logErr('run dispose failed:', String(e3)) }
      }
    } catch (e) { this.logErr('subagent failed:', String(e)) }

    if (!replyText) replyText = '(no reply from agent; stop=' + stopReason + ')'
    try {
      const chatTarget = this.lastChatByUser[bound.sessionId] || this.lastChatByUser['__last__'] || chatId
      await this.client.sendMessage(chatTarget, replyText)
      this.log('✅ replied to ' + chatTarget + ' (' + replyText.length + ' chars)')
    } catch (e) { this.logErr('send failed:', String(e)) }
  }
}
