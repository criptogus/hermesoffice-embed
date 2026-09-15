#!/usr/bin/env node
/**
 * HermesOffice Bridge Server
 *
 * Serves the HermesOffice editor modules over HTTP so they can be embedded in
 * the Hermes desktop app (preview pane / plugin pane), and exposes the
 * Electron-side APIs those modules need as REST endpoints.
 *
 *   node server.mjs [--port 3791] [--app /Applications/HermesOffice.app]
 *
 * What it does:
 *   1. Serves modules/{docs,sheets,slides,pdf}/renderer/* straight from the
 *      installed HermesOffice.app bundle.
 *   2. Injects a shim (shim.mjs) that replaces window.desktop /
 *      window.projectApi (Electron contextBridge) with fetch() to this server.
 *   3. Provides file I/O, recents, theme, language and a gateway proxy for AI.
 */

import { createServer } from 'node:http'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync, copyFileSync, renameSync } from 'node:fs'
import { join, extname, basename, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { desktopShim } from './shim.mjs'

// ── Args / config ───────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const PORT = parseInt(arg('port', process.env.HOBRIDGE_PORT || '3791'), 10)
const HO_APP = arg('app', process.env.HO_APP_PATH || '/Applications/HermesOffice.app')
const HO_RESOURCES = join(HO_APP, 'Contents/Resources')
const DOCS_DIR = arg('docs', process.env.HOBRIDGE_DOCS || join(process.env.HOME, 'Documents/HermesOffice'))
const GATEWAY = arg('gateway', process.env.HOBRIDGE_GATEWAY || 'http://127.0.0.1:8642')
const DEBUG = process.argv.includes('--debug')

// ── MIME ────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
}

const MODULES = {
  docs: 'modules/docs/renderer',
  sheets: 'modules/sheets/renderer',
  slides: 'modules/slides/renderer',
  pdf: 'modules/pdf/renderer',
}

const EXTS = ['.docx', '.xlsx', '.pptx', '.pdf']

// ── Helpers ─────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve({ _raw: raw }) }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function sendFile(res, full, mime) {
  const buf = readFileSync(full)
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' })
  res.end(buf)
}

// ── Recents store ───────────────────────────────────────────────────────────

const RECENT_FILE = join(DOCS_DIR, '.bridge-recent.json')

function loadRecent() {
  try { return JSON.parse(readFileSync(RECENT_FILE, 'utf8')) } catch { return [] }
}

function saveRecent(list) {
  mkdirSync(DOCS_DIR, { recursive: true })
  writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2))
}

function entryFor(filePath) {
  const st = existsSync(filePath) ? statSync(filePath) : null
  return {
    path: filePath,
    name: basename(filePath),
    ext: extname(filePath).slice(1).toLowerCase(),
    mtimeMs: st ? st.mtimeMs : Date.now(),
    sizeBytes: st ? st.size : 0,
    starred: false,
  }
}

function touchRecent(filePath) {
  const list = loadRecent()
  const prev = list.find((r) => r.path === filePath)
  const next = list.filter((r) => r.path !== filePath)
  next.unshift({ ...entryFor(filePath), starred: prev ? prev.starred : false })
  saveRecent(next.slice(0, 300))
}

// ── Document operations ─────────────────────────────────────────────────────

function listDocs() {
  mkdirSync(DOCS_DIR, { recursive: true })
  const starMap = new Map(loadRecent().map((r) => [r.path, r.starred]))
  const out = []
  for (const name of readdirSync(DOCS_DIR)) {
    if (name.startsWith('.')) continue
    const ext = extname(name).toLowerCase()
    if (!EXTS.includes(ext)) continue
    const full = join(DOCS_DIR, name)
    const st = statSync(full)
    if (!st.isFile()) continue
    out.push({
      path: full,
      name,
      ext: ext.slice(1),
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      starred: starMap.get(full) === true,
    })
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

function uniquePath(name) {
  let candidate = join(DOCS_DIR, name)
  if (!existsSync(candidate)) return candidate
  const ext = extname(name)
  const base = basename(name, ext)
  let i = 1
  do {
    candidate = join(DOCS_DIR, `${base} (${i})${ext}`)
    i++
  } while (existsSync(candidate))
  return candidate
}

/** Build a minimal valid OOXML package and zip it into place. */
function createBlank(type) {
  mkdirSync(DOCS_DIR, { recursive: true })
  const ext = type === 'xlsx' ? '.xlsx' : type === 'pptx' ? '.pptx' : '.docx'
  const target = uniquePath(`Untitled${ext}`)
  const tmp = join(DOCS_DIR, `.tmp-${randomUUID().slice(0, 8)}`)

  const write = (rel, content) => {
    const full = join(tmp, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  try {
    if (ext === '.docx') {
      write('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
      write('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
      write('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`)
      write('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`)
    } else if (ext === '.xlsx') {
      write('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`)
      write('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)
      write('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`)
      write('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`)
      write('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`)
    } else {
      write('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`)
      write('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`)
      write('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`)
      write('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`)
      write('ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`)
      write('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
</p:sld>`)
    }

    // zip the folder contents (execFileSync — no shell, no quoting hazards)
    const zipOut = `${tmp}.zip`
    execFileSync('/usr/bin/zip', ['-r', '-q', '-X', zipOut, '.'], { cwd: tmp, stdio: 'pipe' })
    copyFileSync(zipOut, target)
    unlinkSync(zipOut)
  } finally {
    try { execFileSync('/bin/rm', ['-rf', tmp], { stdio: 'pipe' }) } catch {}
  }

  touchRecent(target)
  return target
}

// ── HTML rewriting ──────────────────────────────────────────────────────────

function rewriteHtml(html, { module }) {
  // 1. Relax CSP so the shim and localhost fetches are allowed.
  html = html.replace(
    /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i,
    '$1' + [
      "default-src 'self' http://127.0.0.1:*",
      "script-src 'self' 'unsafe-inline' http://127.0.0.1:*",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: http://127.0.0.1:*",
      "font-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "worker-src 'self' blob:",
      "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* ws://localhost:*",
    ].join('; ') + '$2'
  )

  // 2. Error collector FIRST so module-eval failures are visible.
  const probe = DEBUG
    ? `<script>
window.__hoErrors = [];
window.addEventListener('error', function (e) {
  window.__hoErrors.push({ kind: 'error', msg: e.message, src: e.filename, line: e.lineno, col: e.colno });
});
window.addEventListener('unhandledrejection', function (e) {
  window.__hoErrors.push({ kind: 'rejection', msg: (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason) });
});
var __hoOrigError = console.error;
console.error = function () {
  window.__hoErrors.push({ kind: 'console', msg: Array.prototype.map.call(arguments, String).join(' ') });
  return __hoOrigError.apply(console, arguments);
};
</script>`
    : ''

  // 3. The shim must run before the module script evaluates.
  const shim = desktopShim({ port: PORT, gateway: GATEWAY })

  if (html.includes('</head>')) {
    html = html.replace('</head>', probe + shim + '</head>')
  } else {
    html = probe + shim + html
  }

  return html
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname

  // Request log — lets an external observer confirm the plugin pane is live
  if (process.env.HOBRIDGE_LOG_REQUESTS) {
    try {
      const ua = req.headers['user-agent'] || ''
      const origin = req.headers['origin'] || req.headers['referer'] || ''
      writeFileSync(
        process.env.HOBRIDGE_LOG_REQUESTS,
        `${new Date().toISOString()}\t${req.method}\t${p}\torigin=${origin}\tua=${ua.slice(0, 60)}\n`,
        { flag: 'a' }
      )
    } catch {}
  }

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    // ── Health ──
    if (p === '/health') {
      return sendJson(res, {
        status: 'ok',
        port: PORT,
        docsDir: DOCS_DIR,
        app: HO_APP,
        appPresent: existsSync(HO_RESOURCES),
        gateway: GATEWAY,
      })
    }

    // ── Document listing / creation ──
    if (p === '/api/docs') return sendJson(res, { docs: listDocs() })

    if (p === '/api/recents') {
      const recent = loadRecent()
      const q = url.searchParams
      const ext = q.get('ext')
      const offset = parseInt(q.get('offset') || '0', 10)
      const limit = parseInt(q.get('limit') || '50', 10)
      const filtered = ext ? recent.filter((r) => r.ext === ext) : recent
      return sendJson(res, {
        entries: filtered.slice(offset, offset + limit),
        total: filtered.length,
        totalAll: recent.length,
      })
    }

    if (p === '/api/starred') {
      const starred = loadRecent().filter((r) => r.starred)
      return sendJson(res, { entries: starred, total: starred.length, totalAll: starred.length })
    }

    if (p === '/api/toggle-star' && req.method === 'POST') {
      const { path } = await readBody(req)
      const list = loadRecent()
      const hit = list.find((r) => r.path === path)
      if (hit) hit.starred = !hit.starred
      else if (existsSync(path)) list.unshift({ ...entryFor(path), starred: true })
      saveRecent(list)
      return sendJson(res, { ok: true })
    }

    if (p === '/api/new' && req.method === 'POST') {
      const body = await readBody(req)
      const created = createBlank(body.type || 'docx')
      return sendJson(res, { path: created, name: basename(created) })
    }

    // ── File I/O ──
    if (p === '/api/read-file' && req.method === 'POST') {
      const { path } = await readBody(req)
      if (!path || !existsSync(path)) return sendJson(res, { error: 'not-found', path }, 404)
      const buf = readFileSync(path)
      touchRecent(path)
      return sendJson(res, {
        path,
        name: basename(path),
        data: buf.toString('base64'),
        hash: createHash('sha256').update(buf).digest('hex'),
        size: buf.length,
      })
    }

    if (p === '/api/write-file' && req.method === 'POST') {
      const { path, data } = await readBody(req)
      if (!path || typeof data !== 'string') return sendJson(res, { error: 'bad-request' }, 400)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, Buffer.from(data, 'base64'))
      touchRecent(path)
      return sendJson(res, { ok: true, path, size: statSync(path).size })
    }

    if (p === '/api/save-as' && req.method === 'POST') {
      const { name, data } = await readBody(req)
      if (typeof data !== 'string') return sendJson(res, { error: 'bad-request' }, 400)
      mkdirSync(DOCS_DIR, { recursive: true })
      const target = uniquePath(name || 'Untitled.docx')
      writeFileSync(target, Buffer.from(data, 'base64'))
      touchRecent(target)
      return sendJson(res, { ok: true, path: target, name: basename(target) })
    }

    if (p === '/api/rename' && req.method === 'POST') {
      const { path, newName } = await readBody(req)
      if (!path || !newName || !existsSync(path)) return sendJson(res, { ok: false, error: 'not-found' })
      const target = join(dirname(path), basename(newName))
      renameSync(path, target)
      const list = loadRecent().map((r) => (r.path === path ? { ...r, path: target, name: basename(target) } : r))
      saveRecent(list)
      return sendJson(res, { ok: true, path: target })
    }

    if (p === '/api/duplicate' && req.method === 'POST') {
      const { path } = await readBody(req)
      if (!path || !existsSync(path)) return sendJson(res, { ok: false })
      const ext = extname(path)
      const target = uniquePath(`${basename(path, ext)} copy${ext}`)
      copyFileSync(path, target)
      touchRecent(target)
      return sendJson(res, { ok: true, path: target })
    }

    if (p === '/api/delete' && req.method === 'POST') {
      const { paths } = await readBody(req)
      const list = loadRecent()
      for (const target of paths || []) {
        try { if (existsSync(target)) unlinkSync(target) } catch {}
      }
      saveRecent(list.filter((r) => !(paths || []).includes(r.path)))
      return sendJson(res, { ok: true })
    }

    if (p === '/api/read-attachment' && req.method === 'POST') {
      const { path, offset = 0, maxChars = 50000 } = await readBody(req)
      if (!path || !existsSync(path)) return sendJson(res, { ok: false, error: 'not-found' })
      const text = readFileSync(path, 'utf8')
      return sendJson(res, {
        ok: true, name: basename(path), totalChars: text.length, offset,
        text: text.slice(offset, offset + maxChars),
      })
    }

    if (p === '/api/read-image' && req.method === 'POST') {
      const { path } = await readBody(req)
      if (!path || !existsSync(path)) return sendJson(res, null)
      return sendJson(res, { base64: readFileSync(path).toString('base64'), name: basename(path) })
    }

    // ── Settings the modules read at boot ──
    if (p === '/api/theme') {
      if (req.method === 'POST') return sendJson(res, { ok: true })
      return sendJson(res, process.env.HOBRIDGE_THEME || 'system')
    }

    if (p === '/api/language') {
      if (req.method === 'POST') return sendJson(res, { ok: true })
      return sendJson(res, process.env.HOBRIDGE_LANG || 'pt')
    }

    if (p === '/api/ai-settings') {
      if (req.method === 'POST') return sendJson(res, { ok: true })
      return sendJson(res, { provider: 'hermes', apiKey: process.env.HERMES_API_KEY || '', model: '' })
    }

    if (p === '/api/account-status') {
      return sendJson(res, { loggedIn: true, email: 'Hermes (bridge)' })
    }

    if (p === '/api/version') return sendJson(res, '1.0.0-bridge')
    if (p === '/api/tabs') return sendJson(res, [])
    if (p === '/api/projects') return sendJson(res, [])

    // ── Gateway proxy (lets the page call Hermes without CORS surprises) ──
    if (p === '/api/ai/chat' && req.method === 'POST') {
      const body = await readBody(req)
      const upstream = await fetch(`${GATEWAY}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.HERMES_API_KEY ? { Authorization: `Bearer ${process.env.HERMES_API_KEY}` } : {}),
        },
        body: JSON.stringify({ ...body, stream: false }),
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
      return res.end(text)
    }

    // ── Static module assets ──
    for (const [name, dir] of Object.entries(MODULES)) {
      const prefix = `/${name}`
      if (p === prefix) { res.writeHead(302, { Location: `${prefix}/index.html` }); return res.end() }
      if (!p.startsWith(`${prefix}/`)) continue

      const rel = p.slice(prefix.length) || '/index.html'
      const full = join(HO_RESOURCES, dir, decodeURIComponent(rel))
      if (!existsSync(full) || !statSync(full).isFile()) break

      const ext = extname(full)
      if (ext === '.html') {
        const html = rewriteHtml(readFileSync(full, 'utf8'), { module: name })
        res.writeHead(200, { 'Content-Type': MIME['.html'] })
        return res.end(html)
      }
      // .mjs and .js both need a JS mime or the module loader refuses them
      const mime = MIME[ext] || (ext === '.mjs' ? MIME['.mjs'] : 'application/octet-stream')
      if (ext === '.mjs' || ext === '.js') {
        const buf = readFileSync(full)
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' })
        return res.end(buf)
      }
      return sendFile(res, full, mime)
    }

    // ── Editor deep-link: /editor?file=<abs path> ──
    if (p === '/editor' || p === '/') {
      const file = url.searchParams.get('file') || ''
      const ext = extname(file).toLowerCase()
      const module = ext === '.xlsx' ? 'sheets' : ext === '.pptx' ? 'slides' : ext === '.pdf' ? 'pdf' : 'docs'
      const target = file
        ? `${module}/index.html?file=${encodeURIComponent(file)}&bridge=1`
        : `${module}/index.html?bridge=1`
      res.writeHead(302, { Location: `/${target}` })
      return res.end()
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end(`Not found: ${p}`)
  } catch (err) {
    console.error('[bridge]', err.stack || err.message)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal error: ' + err.message)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const ok = existsSync(HO_RESOURCES)
  console.log(`\n  HermesOffice Bridge  →  http://127.0.0.1:${PORT}`)
  console.log(`  app       : ${HO_APP} ${ok ? '' : '  ⚠️  NOT FOUND'}`)
  console.log(`  documents : ${DOCS_DIR}`)
  console.log(`  gateway   : ${GATEWAY}`)
  console.log(`  debug     : ${DEBUG ? 'on (/editor + window.__hoErrors)' : 'off (--debug to enable)'}`)
  console.log(`\n  Try: http://127.0.0.1:${PORT}/editor?file=<abs path to a .docx>\n`)
})
