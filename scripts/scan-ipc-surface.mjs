#!/usr/bin/env node
/**
 * Extract the contextBridge surface a built renderer bundle expects.
 *
 * Point it at any JS bundle (or a module name from the installed app) and it
 * reports which `window.<ns>.<method>` calls the code makes — including
 * optional-chained (`window.ns?.method`) ones, which a naive scan misses and
 * which are exactly the calls that blow up bootstrap.
 *
 *   node scan-ipc-surface.mjs                       # all HermesOffice modules
 *   node scan-ipc-surface.mjs docs                  # one module
 *   node scan-ipc-surface.mjs /path/to/bundle.js    # any file
 *   node scan-ipc-surface.mjs docs --json           # machine-readable
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const HO_RESOURCES =
  process.env.HO_RESOURCES || '/Applications/HermesOffice.app/Contents/Resources'

/** module names the app ships, each with its own preload namespace */
const MODULES = ['docs', 'slides', 'sheets', 'pdf']

/** namespaces the HermesOffice renderers pull from contextBridge */
const NAMESPACES = ['desktop', 'desktopApi', 'slidesApi', 'pdfApi', 'projectApi', 'aiOffice']

// ── locate the main bundle of a module ────────────────────────────────────
function moduleBundle(mod) {
  const dir = join(HO_RESOURCES, 'modules', mod, 'renderer', 'assets')
  if (!existsSync(dir)) return null
  // the entry bundle is the largest .js that is not a locale chunk
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, size: statSync(join(dir, f)).size }))
    .sort((a, b) => b.size - a.size)
  return files.length ? join(dir, files[0].f) : null
}

// ── the scan ──────────────────────────────────────────────────────────────
function scan(file) {
  const src = readFileSync(file, 'utf8')
  const out = {}

  for (const ns of NAMESPACES) {
    // direct: window.desktop.foo    optional: window.desktop?.foo
    const direct = new Set()
    const optional = new Set()

    for (const m of src.matchAll(new RegExp(`window\\.${ns}\\.(\\w+)`, 'g'))) direct.add(m[1])
    for (const m of src.matchAll(new RegExp(`window\\.${ns}\\?\\.(\\w+)`, 'g'))) optional.add(m[1])

    if (direct.size || optional.size) {
      out[ns] = {
        total: new Set([...direct, ...optional]).size,
        optionalOnly: [...optional].filter((m) => !direct.has(m)).sort(),
        methods: [...direct].sort(),
      }
    }
  }
  return out
}

// ── main ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const target = args.find((a) => !a.startsWith('--'))

const jobs = []
if (!target) {
  for (const mod of ['docs', 'slides', 'sheets', 'pdf']) {
    const b = moduleBundle(mod)
    if (b) jobs.push([mod, b])
    else console.error(`! no bundle for module "${mod}"`)
  }
} else if (MODULES.includes(target)) {
  // A bare module name wins over a same-named local path (e.g. ./docs), which
  // would otherwise be read as a directory.
  const b = moduleBundle(target)
  if (!b) { console.error(`no bundle found for module "${target}"`); process.exit(1) }
  jobs.push([target, b])
} else if (existsSync(target) && statSync(target).isFile()) {
  jobs.push([basename(target), target])
} else if (existsSync(target)) {
  console.error(`"${target}" is a directory, not a bundle — pass a module name (${MODULES.join(', ')}) or a .js file`)
  process.exit(1)
} else {
  const b = moduleBundle(target)
  if (!b) { console.error(`no bundle found for "${target}"`); process.exit(1) }
  jobs.push([target, b])
}

const report = {}
for (const [label, file] of jobs) report[label] = { bundle: file, surface: scan(file) }

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const [label, { bundle, surface }] of Object.entries(report)) {
    console.log(`\n=== ${label} ===\n${bundle}`)
    for (const [ns, info] of Object.entries(surface)) {
      console.log(`  window.${ns} — ${info.total} method(s)`)
      if (info.optionalOnly.length) {
        console.log(`    optional-chained only (easy to miss): ${info.optionalOnly.join(', ')}`)
      }
      console.log(`    ${info.methods.join(', ')}`)
    }
    if (!Object.keys(surface).length) console.log('  (no contextBridge usage found)')
  }
}
