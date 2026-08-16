// Persistent runtime settings: bot credentials + bound workspace.
// Stored at $DSH_HOME/feishu-bot/config.json (DSH_HOME defaults to ~/.dsh).
// NEVER commit this file — it holds your App Secret.
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const DEFAULTS = { appId: '', appSecret: '', workspaceId: null }

export function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'feishu-bot', 'config.json')
}

export function loadConfig() {
  try {
    const p = configPath()
    if (!existsSync(p)) return { ...DEFAULTS }
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch (e) {
    return { ...DEFAULTS }
  }
}

export function saveConfig(config) {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf8')
  return config
}
