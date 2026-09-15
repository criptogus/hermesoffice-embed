# hermesoffice-embed

Open and edit **.docx / .xlsx / .pptx / .pdf** inside a Hermes pane — using the
real HermesOffice editor engines, not a reimplementation.

```bash
hermes plugins install criptogus/hermesoffice-embed
```

## What it does

Adds a **HermesOffice** pane, a status-bar chip, a `/hermesoffice` page, a
sidebar row and a palette command to Hermes Desktop. Documents open in an
embedded editor, are edited in place, and save back to disk as real Office
files.

| Flow | How |
|---|---|
| Open + edit | click a document in the pane → editor renders inside the pane |
| Open in the Hermes preview pane | preview icon on the row |
| Create a document | `Doc` / `Planilha` / `Slides` buttons |
| Save | ⌘S in the editor — writes the file on disk |
| Filter | search field above the list |

## How it works

Electron apps keep their built renderer on disk; the only thing tying it to
Electron is the preload's `contextBridge` layer. This plugin serves the
HermesOffice renderer bundles over HTTP and replaces that layer with `fetch()`:

```
Hermes Desktop
└── pane "HermesOffice"          desktop/plugin.js
    └── <iframe>  →  :3791/editor?file=…
                      └── bridge              desktop/server.mjs
                            ├── serves HermesOffice.app's renderer modules
                            ├── injects a shim that swaps contextBridge → HTTP
                            ├── reads/writes ~/Documents/HermesOffice
                            └── proxies AI turns to the Hermes gateway (:8642)
```

The shim (`desktop/shim.mjs`) wraps each namespace in a `Proxy` so any method it
does not implement returns a safe promise instead of `undefined` — an
unimplemented method must never throw during the renderer's `bootstrap()`.

## Requirements

- **macOS** and **HermesOffice.app** at `/Applications/HermesOffice.app`
  (the editor engines are read from the installed app).
- A running Hermes gateway for the in-editor AI panel (`:8642`, started with the
  app).

## Starting the bridge

The bridge must be running for the pane to work. Pick one:

```bash
# manual
./desktop/restart.sh

# install as a LaunchAgent (starts at login, restarts on crash)
./desktop/restart.sh --install-agent
./desktop/restart.sh --status
./desktop/restart.sh --uninstall-agent
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HOBRIDGE_PORT` | `3791` | bridge port |
| `HO_APP_PATH` | `/Applications/HermesOffice.app` | source of the editor modules |
| `HOBRIDGE_DOCS` | `~/Documents/HermesOffice` | documents folder |
| `HOBRIDGE_GATEWAY` | `http://127.0.0.1:8642` | Hermes gateway for AI |

## Module support

| Module | Surface | Status |
|---|---|---|
| **docs** (`.docx`) | `window.desktop`, 48 methods | **complete** — open/edit/save verified end to end |
| sheets (`.xlsx`) | `window.desktopApi`, 39 methods | opens and renders; `selectWorkbook` + `saveWorkbookEdits` wired, advanced workbook features stubbed |
| slides (`.pptx`) | `window.slidesApi`, 147 methods | opens and renders; open/save wired, advanced editing stubbed |
| pdf (`.pdf`) | `window.pdfApi`, 29 methods | opens and renders |

CI checks the exact surface per module with `scripts/scan-ipc-surface.mjs`.

## Development

```bash
# validate the plugin against the catalog admission gate
hermes plugins validate .

# load-test the desktop half without restarting the running app
node tests/desktop/plugin-load.test.mjs

# which contextBridge methods does a renderer bundle call?
node scripts/scan-ipc-surface.mjs            # all HermesOffice modules
node scripts/scan-ipc-surface.mjs docs --json

# debug a failing page: enables window.__hoErrors / __hoCalls / __hoMissing
./desktop/restart.sh --debug
```

To run the bridge from a checkout, point the desktop app at it by copying
`desktop/` into `<hermes home>/desktop-plugins/hermesoffice-embed/` — that is
exactly what `hermes plugins install` materializes.

## Known limits

- The bridge is a **local HTTP server** bound to `127.0.0.1`, with no
  authentication. Any local process can read/write the documents folder through
  it. Do not expose the port beyond loopback.
- The editor is served from the installed app, so a HermesOffice update changes
  the renderer under this plugin. The shim's `Proxy` fallback absorbs new methods
  as no-ops rather than crashing — check `window.__hoMissing` after an update to
  see what a flow now expects.
- Sheets/slides advanced operations are stubs; see the table above.

## License

MIT — see `LICENSE`.
