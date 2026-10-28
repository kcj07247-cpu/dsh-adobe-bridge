/**
 * dsh-adobe-bridge — drive Adobe apps from DeepSeek Harness.
 *
 * After Effects has no COM surface, so this plugin hosts a small loopback
 * bridge that an AE CEP panel polls; Illustrator and Photoshop are driven
 * through Windows COM (PowerShell + DoJavaScript).
 *
 * @module dsh-adobe-bridge
 */
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)
const BRIDGE_PORT = 8791
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`
const HERE = dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-adobe-bridge'
export const inject = ['tools']

/* ------------------------------------------------------------------ bridge */

let bridgeServer
const queue = []
const waiters = []
const executing = new Map()
let seq = 0
let panelSeenAt = 0
let lastResult = null

function sendJson(res, code, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function startBridge() {
  if (bridgeServer !== undefined) return
  bridgeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'OPTIONS') return sendJson(res, 204)

    if (url.pathname === '/next' && req.method === 'GET') {
      panelSeenAt = Date.now()
      if (queue.length > 0) {
        const cmd = queue.shift()
        executing.set(cmd.id, cmd)
        return sendJson(res, 200, { id: cmd.id, script: cmd.script })
      }
      const waitMs = Math.min(25000, Math.max(1, Number(url.searchParams.get('wait') ?? 20)) * 1000)
      const waiter = { res, timer: null }
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        sendJson(res, 204)
      }, waitMs)
      waiters.push(waiter)
      return
    }

    if (url.pathname === '/exec' && req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch {
        return sendJson(res, 400, { ok: false, error: 'bad json' })
      }
      const script = typeof body.script === 'string' ? body.script : ''
      if (script.length === 0) return sendJson(res, 400, { ok: false, error: 'missing script' })

      const id = ++seq
      const timeoutMs = Math.min(600000, Math.max(1000, Number(body.timeoutMs) || 120000))
      let settled = false
      const finish = (payload, code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        sendJson(res, code, payload)
      }
      const cmd = {
        id,
        script,
        onResult: (result, error) => finish({ ok: !error, id, result, error: error ?? null }, 200),
      }
      const timer = setTimeout(() => {
        const index = queue.indexOf(cmd)
        if (index >= 0) queue.splice(index, 1)
        executing.delete(id)
        finish({ ok: false, id, error: 'timeout waiting for the AE panel' }, 504)
      }, timeoutMs)

      if (waiters.length > 0) {
        const waiter = waiters.shift()
        clearTimeout(waiter.timer)
        executing.set(id, cmd)
        sendJson(waiter.res, 200, { id, script })
      } else {
        queue.push(cmd)
      }
      return
    }

    if (url.pathname === '/result' && req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch {
        return sendJson(res, 400, { ok: false })
      }
      const cmd = executing.get(body.id)
      if (cmd !== undefined) {
        executing.delete(body.id)
        cmd.onResult(body.result, body.error)
      }
      lastResult = { id: body.id, result: body.result, error: body.error ?? null, at: Date.now() }
      return sendJson(res, 200, { ok: true })
    }

    if (url.pathname === '/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        panelSeenAt,
        panelOnline: Date.now() - panelSeenAt < 30000,
        queued: queue.length,
        executing: executing.size,
        lastResult,
      })
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  })

  bridgeServer.on('error', (error) => {
    // Someone else (the standalone server.cjs) already owns the port: that is
    // fine, both speak the same protocol.
    if (error?.code === 'EADDRINUSE') return
    throw error
  })
  bridgeServer.listen(BRIDGE_PORT, '127.0.0.1')
}

/* ------------------------------------------------------------------- tools */

async function aeStatus() {
  const response = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(4000) })
  return await response.json()
}

async function aeEval(script, timeoutMs) {
  let status
  try {
    status = await aeStatus()
  } catch {
    throw new Error('AE 桥未运行：先在 AE 里打开 DSH AE Bridge 面板，并确认本地桥已启动')
  }
  if (!status.panelOnline) {
    throw new Error('AE 面板未连接：打开 After Effects，并在「窗口 → 扩展 → DSH AE Bridge」打开面板')
  }
  const response = await fetch(`${BRIDGE_URL}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 15000),
  })
  const payload = await response.json()
  if (!payload.ok) throw new Error(payload.error ?? 'AE 执行失败')
  return String(payload.result ?? '')
}

async function comEval(app, script) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-adobe-'))
  const file = join(dir, 'script.jsx')
  try {
    await writeFile(file, script, 'utf8')
    const runner = app === 'ps' ? 'ps-run.ps1' : 'ai-run.ps1'
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, runner), '-ScriptFile', file],
      { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
    )
    return stdout.trim()
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const SCRIPT_HELP =
  'The script is ExtendScript evaluated inside the app (no shell). Return a string; ' +
  'for a visual check export a frame/file to an absolute path and then read that file.'

export function apply(ctx) {
  startBridge()

  ctx.tools.register(defineTool({
    name: 'adobe_status',
    description: 'Check whether the local Adobe bridge is up and whether the After Effects CEP panel is connected. ' +
      'Call this first when Adobe operations fail.',
    parameters: {},
    execute: async () => {
      let status
      try {
        status = await aeStatus()
      } catch {
        return [{ type: 'text', text: 'bridge: down (no listener on 127.0.0.1:8791)' }]
      }
      return [{
        type: 'text',
        text: `bridge: up | AE panel: ${status.panelOnline ? 'online' : 'offline'} | queued: ${status.queued}`,
      }]
    },
  }))

  ctx.tools.register(defineTool({
    name: 'adobe_ae_eval',
    description: 'Run ExtendScript inside the running After Effects instance through the CEP bridge and return its string result. ' +
      'Use for creating comps, layers, keyframes, effects and expressions, and for exporting frames with ' +
      'comp.saveFrameToPng(time, new File("C:/abs/path.png")). ' + SCRIPT_HELP,
    parameters: {
      script: { type: 'string', required: true, description: 'ExtendScript source. Wrap in an IIFE and return a string.' },
      timeoutMs: { type: 'integer', description: 'Execution timeout in milliseconds (default 120000).' },
    },
    execute: async (args) => {
      const result = await aeEval(args.script, args.timeoutMs ?? 120000)
      return [{ type: 'text', text: result.length === 0 ? '(empty result)' : result }]
    },
  }))

  ctx.tools.register(defineTool({
    name: 'adobe_ai_eval',
    description: 'Run ExtendScript inside Adobe Illustrator through Windows COM and return its result. ' +
      'Illustrator must be installed; it is launched automatically if closed. ' +
      'Coordinates are in points with the origin at the bottom-left. ' + SCRIPT_HELP,
    parameters: {
      script: { type: 'string', required: true, description: 'Illustrator ExtendScript source returning a string.' },
    },
    execute: async (args) => {
      const out = await comEval('ai', args.script)
      return [{ type: 'text', text: out.length === 0 ? '(empty result)' : out }]
    },
  }))

  ctx.tools.register(defineTool({
    name: 'adobe_ps_eval',
    description: 'Run ExtendScript inside Adobe Photoshop through Windows COM and return its result. ' + SCRIPT_HELP,
    parameters: {
      script: { type: 'string', required: true, description: 'Photoshop ExtendScript source returning a string.' },
    },
    execute: async (args) => {
      const out = await comEval('ps', args.script)
      return [{ type: 'text', text: out.length === 0 ? '(empty result)' : out }]
    },
  }))

  ctx.effect(() => () => {
    if (bridgeServer !== undefined) {
      bridgeServer.close()
      bridgeServer = undefined
    }
  }, 'dsh-adobe-bridge: loopback server')
}
