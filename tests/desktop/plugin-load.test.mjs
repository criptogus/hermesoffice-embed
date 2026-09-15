#!/usr/bin/env node
/**
 * Load-test for the hermesoffice-embed desktop plugin.
 *
 * Evaluates plugin.js the way the desktop app does — same import surface
 * (@hermes/plugin-sdk, react, react/jsx-runtime) — with a mock ctx, and
 * asserts every registration is well-formed. Catches ReferenceErrors and
 * bad SDK imports without restarting the running app.
 *
 *   node test-plugin-load.mjs
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The plugin lives in desktop/ in the repo, but flat in an install
 *  (<hermes home>/desktop-plugins/<id>/plugin.js). Resolve whichever exists. */
const PLUGIN = [
  join(HERE, 'plugin.js'),                 // installed layout
  join(HERE, '..', '..', 'desktop', 'plugin.js'), // package layout
].find((p) => existsSync(p))
if (!PLUGIN) {
  console.error('plugin.js not found — expected next to this test or in ../../desktop/')
  process.exit(2)
}
const SANDBOX = join(HERE, '.test-sandbox')
const NM = join(SANDBOX, 'node_modules')

const failures = []
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`)
  else { console.log(`  ✗ ${label} ${detail}`); failures.push(label) }
}

// ── Where the real react lives (same version the desktop bundles) ─────────
const HERMES_NM = join(process.env.HOME, '.hermes', 'hermes-agent', 'node_modules')
for (const pkg of ['react', 'react-dom']) {
  if (!existsSync(join(HERMES_NM, pkg))) {
    console.error(`missing ${pkg} in ${HERMES_NM} — cannot run the load test`)
    process.exit(2)
  }
}

// ── Sandbox with the mock SDK + linked react ─────────────────────────────
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(join(NM, '@hermes', 'plugin-sdk'), { recursive: true })

// Icon set mirrors the real SDK bundle (verified against sdk-*.js).
const ICONS = ['ChevronLeft','ChevronRight','X','Plus','File','FileText','Folder',
  'FolderOpen','ExternalLink','Search','Pencil','Trash2','Star','Clock','History',
  'Info','RefreshCw','MonitorPlay','Palette']

writeFileSync(join(NM, '@hermes', 'plugin-sdk', 'index.mjs'), `
export const icons = {
${ICONS.map((n) => `  ${n}: function ${n}(props){ const R = globalThis.__HO_REACT__; const p = { ...(props||{}) }; delete p.children; delete p.key; return R.createElement('svg', { 'data-icon': '${n}', ...p }) }`).join(',\n')}
}
export const host = {
  revealPane: (id) => { (globalThis.__revealCalls || (globalThis.__revealCalls = [])).push(id) },
  paneVisibility: () => ({ get: () => true, subscribe: () => () => {} }),
  state: {
    cwd: { get: () => '/tmp', subscribe: () => () => {} },
    gateway: { get: () => 'test', subscribe: () => () => {} },
  },
  request: async () => ({}),
  notify: () => {},
  navigate: () => {},
  onEvent: () => () => {},
}
export const cn = (...a) => a.filter(Boolean).join(' ')
const C = (name) => function Comp(props){
  const R = globalThis.__HO_REACT__
  const p = { ...(props || {}) }
  delete p.children
  delete p.key            // jsx() passes key separately; the mock must not spread it
  return R.createElement(name, p, props && props.children)
}
export const Badge = C('span')
export const Button = C('button')
export const Input = C('input')
export const ScrollArea = C('div')
export const Tip = C('span')
export const Separator = C('hr')
export const PALETTE_AREA = 'commandPalette'
export const THEMES_AREA = 'themes'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebarNav'
export const KEYBINDS_AREA = 'keybinds'
`)
writeFileSync(join(NM, '@hermes', 'plugin-sdk', 'package.json'),
  JSON.stringify({ name: '@hermes/plugin-sdk', version: '0.0.0-test', type: 'module', main: 'index.mjs' }, null, 2))

for (const pkg of ['react', 'react-dom']) {
  symlinkSync(join(HERMES_NM, pkg), join(NM, pkg))
}

// Materialise the plugin in the sandbox so bare specifiers resolve.
writeFileSync(join(SANDBOX, 'plugin.test.mjs'), readFileSync(PLUGIN, 'utf8'))
writeFileSync(join(SANDBOX, 'package.json'), JSON.stringify({ type: 'module' }, null, 2))

// The plugin always runs in a renderer, so it may touch `window` at register
// time (route/hash handling). Give the harness the minimum it needs rather
// than making production code defensive about an environment it never sees.
const hashListeners = []
globalThis.window = {
  location: { hash: '' },
  addEventListener: (type, fn) => { if (type === 'hashchange') hashListeners.push(fn) },
  removeEventListener: () => {},
}
globalThis.hashListeners = hashListeners

// ── Load ──────────────────────────────────────────────────────────────────
let plugin
let paneId
let editorPaneId
try {
  const React = (await import(join(NM, 'react', 'index.js'))).default ?? await import(join(NM, 'react', 'index.js'))
  globalThis.__HO_REACT__ = React
  const mod = await import(join(SANDBOX, 'plugin.test.mjs'))
  plugin = mod.default
  paneId = mod.PANE_ID
  editorPaneId = mod.EDITOR_PANE_ID
  console.log('\n1. module loads')
  ok('plugin.js parses and evaluates', true)
} catch (e) {
  console.log('\n1. module loads')
  ok('plugin.js parses and evaluates', false, `→ ${e.message}`)
  console.log('\n' + (e.stack || e.message))
  process.exit(1)
}

// ── Shape ─────────────────────────────────────────────────────────────────
console.log('\n2. plugin shape')
ok('has string id', typeof plugin?.id === 'string')
ok('id matches folder name', plugin?.id === 'hermesoffice-embed', `got "${plugin?.id}"`)
ok('has name', typeof plugin?.name === 'string')
ok('has register()', typeof plugin?.register === 'function')

// ── Registration ──────────────────────────────────────────────────────────
console.log('\n3. registrations')
const registered = []
const ctx = {
  register: (r) => registered.push(r),
  registerMany: (rs) => rs.forEach((r) => registered.push(r)),
  storage: { get: () => null, set: () => {}, remove: () => {} },
  rest: async () => ({}),
}

try {
  plugin.register(ctx)
  ok('register(ctx) runs without throwing', true)
} catch (e) {
  ok('register(ctx) runs without throwing', false, `→ ${e.message}`)
  console.log(e.stack)
}

const byId = Object.fromEntries(registered.map((r) => [r.id, r]))
ok('registers a pane', byId.pane?.area === 'panes')
ok('pane has a render fn', typeof byId.pane?.render === 'function')
ok('pane declares placement + width',
  byId.pane?.data?.placement === 'right' && !!byId.pane?.data?.width,
  JSON.stringify(byId.pane?.data))
ok('registers a statusbar chip', registered.some((r) => r.area === 'statusBar.right'))
ok('registers a route page', registered.some((r) => r.area === 'routes'))
ok('registers a sidebar nav row', registered.some((r) => r.area === 'sidebarNav'))
ok('registers a palette command', registered.some((r) => r.area === 'commandPalette'))
ok('no duplicate ids', new Set(registered.map((r) => r.id)).size === registered.length)

// ── Render smoke test ─────────────────────────────────────────────────────
console.log('\n4. render smoke test')
const { renderToStaticMarkup } = await import(join(NM, 'react-dom', 'server.node.js')).catch(() => import(join(NM, 'react-dom', 'server.js')))

for (const r of registered) {
  if (typeof r.render !== 'function') continue
  try {
    const el = r.render()
    if (el) renderToStaticMarkup(el)
    ok(`render() #${r.id} produces a valid element tree`, true)
  } catch (e) {
    ok(`render() #${r.id} produces a valid element tree`, false, `→ ${e.message}`)
  }
}

// ── Contract conformance per area ─────────────────────────────────────────
// Registration SHAPE bugs are silent: a malformed contribution registers, logs
// nothing, and renders nothing. Assert each area's contract explicitly.
//   palette:     data.id + data.label + data.run  (the registry does
//                `{ id: data.id, area, data }` — a top-level `run` is dead)
//   routes:      data.path ('/x') + render
//   sidebar.nav: data.path ('/x') + data.label
console.log('\n5. contribution contracts')
const palette = registered.filter((r) => r.area === 'commandPalette')
ok('every palette row has data.id', palette.every((r) => typeof r.data?.id === 'string'), JSON.stringify(palette.map((r) => r.data?.id)))
ok('every palette row has data.label', palette.every((r) => typeof r.data?.label === 'string'))
ok('every palette row has data.run (not top-level)', palette.every((r) => typeof r.data?.run === 'function'))
ok('no palette row relies on a top-level run', palette.every((r) => r.run === undefined))

const routes = registered.filter((r) => r.area === 'routes')
ok('every route starts with "/"', routes.every((r) => String(r.data?.path || '').startsWith('/')))
ok('every route has a render fn', routes.every((r) => typeof r.render === 'function'))
ok('route paths are single-segment', routes.every((r) => !String(r.data?.path || '').slice(1).includes('/')))

const nav = registered.filter((r) => r.area === 'sidebarNav')
ok('every nav row has data.path + data.label', nav.every((r) => String(r.data?.path || '').startsWith('/') && Boolean(r.data?.label)))
ok('every nav row pairs with a registered route', nav.every((r) => routes.some((p) => p.data?.path === r.data?.path)))

// The codicon must be one the app actually ships a glyph for, or the row
// renders an invisible box. These names are proven by bundled plugins.
const PROVEN_CODICONS = new Set(['project', 'circle-outline', 'watch', 'sync', 'play-circle',
  'pass', 'inbox', 'graph', 'eye', 'error', 'archive', 'plug'])
ok('nav codicons are proven-good', nav.every((r) => PROVEN_CODICONS.has(r.data?.codicon)),
  JSON.stringify(nav.map((r) => r.data?.codicon)))

// Two panes with distinct roles: the LIST belongs in the sidebar, the EDITOR
// belongs in the central area. Getting this wrong crams the editor into the
// sidebar column, and a reveal id that disagrees with the registration targets
// nothing at all.
console.log('\n6. pane wiring')
const panes = registered.filter((r) => r.area === 'panes')
ok('registers two panes', panes.length === 2, `got ${panes.length}`)

const listPane = panes.find((r) => r.id === 'pane')
const editorPane = panes.find((r) => r.id === 'editor')
ok('a list pane exists', Boolean(listPane))
ok('an editor pane exists', Boolean(editorPane))
ok('list pane sits in the sidebar (placement right)', listPane?.data?.placement === 'right', JSON.stringify(listPane?.data))
ok('editor pane is a MAIN-area pane', editorPane?.data?.placement === 'main', JSON.stringify(editorPane?.data))
ok('editor pane docks into the workspace centre',
  editorPane?.data?.dock?.pane === 'workspace' && editorPane?.data?.dock?.pos === 'center',
  JSON.stringify(editorPane?.data?.dock))

ok('module exports PANE_ID', typeof paneId === 'string', typeof paneId)
ok('PANE_ID = <pluginId>:<listPaneContributionId>',
  paneId === `${plugin.id}:${listPane?.id}`,
  `PANE_ID=${paneId} vs ${plugin.id}:${listPane?.id}`)
ok('module exports EDITOR_PANE_ID', typeof editorPaneId === 'string', typeof editorPaneId)
ok('EDITOR_PANE_ID = <pluginId>:<editorPaneContributionId>',
  editorPaneId === `${plugin.id}:${editorPane?.id}`,
  `EDITOR_PANE_ID=${editorPaneId} vs ${plugin.id}:${editorPane?.id}`)
ok('the two pane ids differ', paneId !== editorPaneId)

rmSync(SANDBOX, { recursive: true, force: true })
// The hash bridge is how a sidebar-row click reaches us: the row sets the
// hash, we reveal the pane. Prove it fires, and only for our route.
ok('binds a hashchange listener', hashListeners.length === 1, `got ${hashListeners.length}`)
const realHost = (await import(join(SANDBOX, 'plugin.test.mjs')))
window.location.hash = '#/hermesoffice'
hashListeners.forEach((fn) => fn())
const revealCalls = globalThis.__revealCalls || []
ok('our route triggers a reveal', revealCalls.length === 1, `got ${revealCalls.length}`)
ok('the reveal targets PANE_ID', revealCalls[0] === paneId, `${revealCalls[0]} vs ${paneId}`)
window.location.hash = '#/cron'
hashListeners.forEach((fn) => fn())
ok('a foreign route does NOT reveal', revealCalls.length === 1, `got ${revealCalls.length}`)

rmSync(SANDBOX, { recursive: true, force: true })
console.log(`\n${failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures.length} FAILURE(S)`}`)
if (failures.length) { failures.forEach((f) => console.log('   -', f)); process.exit(1) }
console.log(`   ${registered.length} registrations: ${registered.map((r) => r.id).join(', ')}`)
