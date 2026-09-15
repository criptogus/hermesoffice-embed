/**
 * HermesOffice Embed — Hermes desktop plugin
 *
 * Opens and edits .docx / .xlsx / .pptx / .pdf inside a Hermes pane, rendered
 * by the genuine HermesOffice editor bundles served by the local bridge
 * (default http://127.0.0.1:3791). Documents are read from and written to
 * ~/Documents/HermesOffice by that bridge, so edits land as real Office files.
 *
 * Start the bridge with:
 *   ~/.hermes/desktop-plugins/hermesoffice-embed/restart.sh
 *
 * Plain ESM, loaded uncompiled — UI is jsx() calls, not JSX syntax.
 * Only @hermes/plugin-sdk, react and react/jsx-runtime resolve.
 */

import {
  Badge,
  Button,
  cn,
  host,
  icons,
  Input,
  ScrollArea,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  Tip,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useState } from 'react'

const PORT = 3791
const BRIDGE = `http://127.0.0.1:${PORT}`

/** Bridge URL that opens `filePath` in the right editor module. */
const editorUrl = (filePath) => `${BRIDGE}/editor?file=${encodeURIComponent(filePath)}`

const ICON_FOR = {
  docx: icons.FileText,
  xlsx: icons.File,
  pptx: icons.MonitorPlay,
  pdf: icons.FileText,
}

const MODULE_FOR = { xlsx: 'sheets', pptx: 'slides', pdf: 'pdf', docx: 'docs' }

async function bridge(path, opts) {
  const res = await fetch(`${BRIDGE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`)
  return res.json()
}

// ── bridge health ─────────────────────────────────────────────────────────

function useBridgeHealth(intervalMs = 15000) {
  const [state, setState] = useState({ ok: false, checked: false, info: null })

  useEffect(() => {
    let alive = true
    const ping = async () => {
      try {
        const info = await bridge('/health')
        if (alive) setState({ ok: info?.status === 'ok', checked: true, info })
      } catch {
        if (alive) setState({ ok: false, checked: true, info: null })
      }
    }
    ping()
    const id = setInterval(ping, intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [intervalMs])

  return state
}

function Dot({ ok }) {
  return jsx('span', {
    className: cn(
      'inline-block h-2 w-2 shrink-0 rounded-full',
      ok ? 'bg-(--ui-green)' : 'bg-(--ui-yellow)'
    )
  })
}

// ── document row ──────────────────────────────────────────────────────────

function DocRow({ doc, active, onOpen, onPreview }) {
  const ext = (doc.ext || '').toLowerCase()
  const Icon = ICON_FOR[ext] || icons.FolderOpen

  return jsxs('div', {
    className: cn(
      'group flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors',
      active ? 'bg-(--ui-row-hover-background)' : 'hover:bg-(--ui-row-hover-background)'
    ),
    children: [
      jsx('button', {
        type: 'button',
        className: 'flex min-w-0 flex-1 items-center gap-2 text-left',
        title: doc.path,
        onClick: () => onOpen(doc),
        children: [
          jsx(Icon, { className: 'h-3.5 w-3.5 shrink-0 text-(--ui-text-quaternary)' }),
          jsxs('span', {
            className: 'min-w-0 flex-1',
            children: [
              jsx('span', {
                className: 'block truncate text-xs text-(--ui-text-primary)',
                children: doc.name
              }),
              jsx('span', {
                className: 'block truncate text-[0.625rem] text-(--ui-text-quaternary)',
                children: `${ext.toUpperCase()} · ${Math.max(1, Math.round((doc.sizeBytes || 0) / 1024))} KB`
              })
            ]
          })
        ]
      }),
      jsx(Tip, {
        label: 'Abrir no painel de preview do Hermes',
        children: jsx('button', {
          type: 'button',
          className: cn(
            'shrink-0 rounded p-1 text-(--ui-text-quaternary) opacity-0 transition-all',
            'group-hover:opacity-100 hover:bg-(--ui-row-hover-background) hover:text-(--ui-text-secondary)'
          ),
          'aria-label': 'Abrir no preview',
          onClick: () => onPreview(doc),
          children: jsx(icons.MonitorPlay, { className: 'h-3 w-3' })
        })
      })
    ]
  })
}

// ── embedded editor ───────────────────────────────────────────────────────

function EditorFrame({ doc, onBack, onSaved }) {
  const [nonce, setNonce] = useState(0)
  const ext = (doc.ext || '').toLowerCase()

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-1.5 border-b border-(--ui-stroke-secondary) px-2 py-1',
        children: [
          jsx('button', {
            type: 'button',
            className: 'rounded p-1 text-(--ui-text-quaternary) transition-colors hover:bg-(--ui-row-hover-background) hover:text-(--ui-text-secondary)',
            'aria-label': 'Voltar à lista',
            onClick: onBack,
            children: jsx(icons.ChevronLeft, { className: 'h-3 w-3' })
          }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate text-xs text-(--ui-text-secondary)',
            title: doc.path,
            children: doc.name
          }),
          jsx(Badge, { children: MODULE_FOR[ext] || 'docs' }),
          jsx('button', {
            type: 'button',
            className: 'rounded p-1 text-(--ui-text-quaternary) transition-colors hover:bg-(--ui-row-hover-background) hover:text-(--ui-text-secondary)',
            'aria-label': 'Recarregar',
            onClick: () => { setNonce((n) => n + 1); onSaved?.() },
            children: jsx(icons.RefreshCw, { className: 'h-3 w-3' })
          })
        ]
      }),
      jsx('iframe', {
        key: nonce,
        src: editorUrl(doc.path),
        title: doc.name,
        className: 'min-h-0 w-full flex-1 border-0',
        style: { background: '#ffffff', colorScheme: 'light' },
        allow: 'clipboard-read; clipboard-write',
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads'
      })
    ]
  })
}

// ── pane ──────────────────────────────────────────────────────────────────

function OfficePane() {
  const { ok: online, checked, info } = useBridgeHealth()
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await bridge('/api/docs')
      setDocs(data.docs || [])
    } catch {
      setError('Sem conexão com o bridge do HermesOffice.')
      setDocs([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (online) refresh()
    else if (checked) setLoading(false)
  }, [online, checked, refresh])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? docs.filter((d) => d.name.toLowerCase().includes(q)) : docs
  }, [docs, query])

  const create = useCallback(async (type) => {
    setBusy(true)
    try {
      const r = await bridge('/api/new', { method: 'POST', body: JSON.stringify({ type }) })
      if (r?.path) {
        await refresh()
        setActive({ path: r.path, name: r.name || r.path.split('/').pop(), ext: type })
      }
    } catch (e) {
      host.notify({ kind: 'error', message: `Falha ao criar documento: ${e.message}` })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const openInPreview = useCallback((doc) => {
    const url = editorUrl(doc.path)
    host.request('preview.open', { url })
    host.notify({ kind: 'info', message: `${doc.name} aberto no preview` })
  }, [])

  if (active) {
    return jsx(EditorFrame, {
      doc: active,
      onBack: () => { setActive(null); refresh() },
      onSaved: refresh,
    })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-2 px-3 pt-3 pb-2',
        children: [
          jsx(icons.FolderOpen, { className: 'h-3.5 w-3.5 text-(--ui-accent)' }),
          jsx('span', { className: 'flex-1 text-xs font-medium', children: 'HermesOffice' }),
          jsxs('span', {
            className: 'flex items-center gap-1 text-[0.625rem] text-(--ui-text-quaternary)',
            children: [jsx(Dot, { ok: online }), online ? 'online' : 'offline']
          })
        ]
      }),

      checked && !online && jsxs('div', {
        className: 'mx-3 mb-2 flex flex-col gap-1.5 rounded-md border border-(--ui-yellow) bg-(--ui-bg-secondary) p-2.5 text-[0.6875rem] leading-relaxed',
        children: [
          jsx('span', { className: 'font-medium text-(--ui-text-primary)', children: 'Bridge offline' }),
          jsx('span', {
            className: 'text-(--ui-text-secondary)',
            children: 'Inicie o servidor para editar documentos dentro do Hermes:'
          }),
          jsx('code', {
            className: 'block truncate rounded bg-(--ui-bg-elevated) px-1.5 py-1 font-mono text-[0.625rem] text-(--ui-text-secondary)',
            children: 'restart.sh'
          }),
          jsx(Button, {
            variant: 'secondary',
            onClick: () => host.notify({
              kind: 'info',
              message: 'Rode: ~/.hermes/desktop-plugins/hermesoffice-embed/restart.sh'
            }),
            children: 'Como iniciar'
          })
        ]
      }),

      jsxs('div', {
        className: 'flex shrink-0 items-center gap-1 px-3 pb-2',
        children: [
          jsx(Button, { size: 'sm', disabled: busy || !online, onClick: () => create('docx'), children: 'Doc' }),
          jsx(Button, { size: 'sm', disabled: busy || !online, onClick: () => create('xlsx'), children: 'Planilha' }),
          jsx(Button, { size: 'sm', disabled: busy || !online, onClick: () => create('pptx'), children: 'Slides' }),
          jsx('span', { className: 'flex-1' }),
          jsx('button', {
            type: 'button',
            disabled: !online,
            className: 'rounded p-1 text-(--ui-text-quaternary) transition-colors hover:bg-(--ui-row-hover-background) hover:text-(--ui-text-secondary) disabled:opacity-40',
            'aria-label': 'Atualizar lista',
            onClick: refresh,
            children: jsx(icons.RefreshCw, { className: 'h-3 w-3' })
          })
        ]
      }),

      jsx('div', {
        className: 'shrink-0 px-3 pb-2',
        children: jsx(Input, {
          value: query,
          placeholder: 'Filtrar documentos…',
          className: 'h-7 text-xs',
          onChange: (e) => setQuery(e.target.value)
        })
      }),

      jsx(ScrollArea, {
        className: 'min-h-0 flex-1',
        children: jsx('div', {
          className: 'flex flex-col gap-0.5 px-2 pb-3',
          children: loading
            ? jsx('div', { className: 'px-2 py-3 text-center text-xs text-(--ui-text-quaternary)', children: 'Carregando…' })
            : error
              ? jsx('div', { className: 'px-2 py-3 text-xs text-(--ui-yellow)', children: error })
              : filtered.length === 0
                ? jsx('div', {
                    className: 'px-2 py-3 text-center text-xs text-(--ui-text-quaternary)',
                    children: query ? 'Nenhum resultado' : 'Nenhum documento encontrado'
                  })
                : filtered.map((d) =>
                    jsx(DocRow, {
                      key: d.path,
                      doc: d,
                      active: false,
                      onOpen: setActive,
                      onPreview: openInPreview
                    })
                  )
        })
      }),

      info && jsxs('div', {
        className: 'shrink-0 border-t border-(--ui-stroke-secondary) px-3 py-1.5 text-[0.5625rem] text-(--ui-text-quaternary)',
        children: [
          jsx('div', { className: 'truncate', children: info.docsDir }),
          jsx('div', { className: 'truncate', children: `bridge :${info.port}` })
        ]
      })
    ]
  })
}

// ── full page ─────────────────────────────────────────────────────────────

function OfficePage() {
  return jsx('div', {
    className: 'h-full w-full',
    children: jsx(OfficePane, {})
  })
}

// ── statusbar chip ────────────────────────────────────────────────────────

function OfficeChip() {
  const { ok } = useBridgeHealth(20000)
  return jsx(Tip, {
    label: ok ? 'HermesOffice online — clique para abrir o editor' : 'HermesOffice bridge offline',
    children: jsx('button', {
      type: 'button',
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--ui-row-hover-background) hover:text-foreground'
      ),
      onClick: () => host.navigate('/hermesoffice'),
      children: [jsx(Dot, { key: 'dot', ok }), jsx('span', { key: 'lbl', children: 'Office' })]
    })
  })
}

// ── registration ──────────────────────────────────────────────────────────

export default {
  id: 'hermesoffice-embed',
  name: 'HermesOffice Embed',
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'HermesOffice',
      data: { placement: 'right', width: '420px' },
      render: () => jsx(OfficePane, {})
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 140,
      render: () => jsx(OfficeChip, {})
    })

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/hermesoffice' },
        render: () => jsx(OfficePage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: '/hermesoffice', label: 'HermesOffice', codicon: 'file-code' }
      },
      {
        id: 'cmd-open',
        area: PALETTE_AREA,
        data: { label: 'HermesOffice: abrir documentos', codicon: 'file-code' },
        run: () => host.navigate('/hermesoffice')
      }
    ])
  }
}
