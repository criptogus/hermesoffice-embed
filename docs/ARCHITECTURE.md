# Architecture

## The problem

HermesOffice is an Electron app. Its renderers are built bundles on disk, and
the only thing tying them to Electron is the preload's `contextBridge` layer
(`window.desktop`, `window.slidesApi`, `window.desktopApi`, `window.pdfApi`)
talking over IPC to the main process. In a plain browser page none of that
exists, so the bundle throws on boot.

## The approach

Serve the built renderer over HTTP and replace that layer with `fetch()`.

```
┌─ Hermes Desktop ────────────────────────────────────────────────┐
│  pane "HermesOffice"                          desktop/plugin.js │
│    └── <iframe src=":3791/editor?file=…">                       │
│          │                                                      │
│          │ HTML + assets, with the shim injected before </head> │
│          ▼                                                      │
│  ┌─ bridge (desktop/server.mjs, loopback :3791) ───────────────┐│
│  │  /docs /sheets /slides /pdf  ← HermesOffice.app/…/modules/  ││
│  │  /api/*                      ← recents, file I/O, settings  ││
│  │  /api/ai/chat → Hermes gateway :8642                         ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

Three pieces carry the weight:

**1. Content injection, not rewriting.** The bridge serves the app's own
`index.html` and inserts the shim right before `</head>`. Module scripts are
deferred, so an inline classic `<script>` there runs first. It also relaxes the
packaged CSP to allow `http://127.0.0.1:*` in `script-src`, `connect-src` and
`img-src` — the shipped CSP blocks both the shim and the AI stream.

**2. A defensive shim.** The renderers call ~260 methods across four namespaces,
and a single missing one is fatal: `bootstrap()` throws and the page stays
blank. Rather than chase the list, each namespace is wrapped in a `Proxy` whose
`get` returns a safe promise for anything unimplemented (`on[A-Z]*` names get a
disposer-returning stub). The exact surface per module is checked by
`scripts/scan-ipc-surface.mjs`, which scans for **both** `window.ns.method` and
`window.ns?.method` — a scan that misses the optional-chained form leaves the
very calls that break boot invisible.

**3. Return contracts honoured.** A stub that returns the wrong *shape* is worse
than a missing one: the app reports failure while the write already succeeded.
`saveDocx` must return `{ ok, path?, error? }` (read from the renderer's call
site, not guessed) — returning `true` makes the UI announce "Falha ao salvar"
with the file already on disk.

## Why the desktop half is a directory

Electron materializes a unified package's `desktop/` folder into
`<hermes home>/desktop-plugins/<name>/`. Keeping the bridge and its modules
inside `desktop/` means the whole runtime arrives together, with no path to get
wrong.

## Security posture

The bridge is loopback-only with no authentication: any local process can
read and write the documents folder through it. That is treated as acceptable
because it adds no reach beyond what a local process already has on those files,
but it is the reason the port must never be exposed beyond `127.0.0.1`.

Loading a desktop plugin is explicitly **not** a capability boundary: it is
evaluated as ESM in the renderer realm with full app authority. The isolation
is error isolation only.
