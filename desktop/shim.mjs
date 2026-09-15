/**
 * HermesOffice Bridge — shim generator
 *
 * Generates the in-page shim that replaces Electron's contextBridge APIs with
 * HTTP calls to the bridge server, so the HermesOffice renderer bundles run
 * inside a plain browser page (Hermes preview pane / plugin pane).
 *
 * Namespaces covered (method lists derived from the shipped bundles):
 *   docs      window.desktop     47 methods   (full support)
 *   slides    window.slidesApi  146 methods   (core wired, rest stubbed)
 *   sheets    window.desktopApi  30 methods   (core wired, rest stubbed)
 *   pdf       window.pdfApi      29 methods   (core wired, rest stubbed)
 *   all       window.projectApi / window.aiOffice* / window.aiOfficeTabs
 *
 * A missing method is not harmless: the renderer calls them during bootstrap
 * and a throw there leaves the app on a blank page. Stubs return promises of
 * the shape the callers expect (null / [] / {ok:false}) rather than undefined.
 */

export function desktopShim({ port, gateway }) {
  return `<script>
/* HermesOffice Bridge Shim — Electron contextBridge → HTTP */
(function () {
  var API = 'http://127.0.0.1:${port}';
  var GW = '${gateway}';
  var QS = new URLSearchParams(location.search);

  /* ── transport ─────────────────────────────────────────────────── */
  function api(p, o) {
    window.__hoCalls = window.__hoCalls || [];
    window.__hoCalls.push({ t: Date.now(), method: (o && o.method) || 'GET', path: p });
    return fetch(API + p, o).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + p);
      return r.json();
    });
  }
  function get(p) { return api(p); }
  function post(p, d) {
    return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
  }
  function noop() { return Promise.resolve(); }
  function val(v) { return Promise.resolve(v); }
  function off() { return function () {}; }

  function b64ToBuf(b64) {
    var bin = atob(b64), len = bin.length, buf = new ArrayBuffer(len), view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
    return buf;
  }
  function bufToB64(buf) {
    var bytes = new Uint8Array(buf), bin = '';
    for (var i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /* Deep-link: ?file=<abs path> drives the pending-open flows. */
  function deepLinkFile() { return QS.get('file') || null; }
  function readDoc(path) {
    return post('/api/read-file', { path: path }).then(function (r) {
      if (!r || r.error) return null;
      return { path: r.path, name: r.name, data: b64ToBuf(r.data), hash: r.hash };
    });
  }

  /* ── AI streaming: SSE from the Hermes gateway → onAiStream handler ── */
  var aiHandlers = [];
  function emit(chunk) {
    aiHandlers.forEach(function (h) { try { h(chunk); } catch (e) {} });
  }
  function streamAi(request, ns) {
    var settings = (request && request.settings) || {};
    var rid = (request && request.requestId) || 'r-' + Date.now();
    fetch(GW + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (settings.apiKey || '') },
      body: JSON.stringify({
        model: settings.model || 'hermes',
        messages: (request && request.messages) || [],
        stream: true,
        max_tokens: (request && request.maxTokens) || 4096
      })
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('gateway HTTP ' + res.status);
      var reader = res.body.getReader(), decoder = new TextDecoder(), buf = '';
      (function pump() {
        reader.read().then(function (chunk) {
          if (chunk.done) { emit({ type: 'done', requestId: rid }); return; }
          buf += decoder.decode(chunk.value, { stream: true });
          var lines = buf.split('\\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data: ') !== 0) continue;
            var payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              var parsed = JSON.parse(payload);
              var d = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
              var text = (d && (d.content || d.reasoning_content)) || '';
              if (text) emit({ type: 'chunk', requestId: rid, content: text });
            } catch (e) { /* keep-alive frame */ }
          }
          pump();
        });
      })();
    }).catch(function (e) {
      emit({ type: 'error', requestId: rid, error: e.message });
    });
    return val(rid);
  }
  function onAiStream(handler) {
    aiHandlers.push(handler);
    return function () { aiHandlers = aiHandlers.filter(function (h) { return h !== handler; }); };
  }

  /* Common methods every module's API object shares. */
  function commonApi() {
    return {
      getLanguage: function () { return get('/api/language'); },
      onLanguageChanged: off,
      getTheme: function () { return get('/api/theme'); },
      onThemeChanged: off,
      getAiSettings: function () { return get('/api/ai-settings'); },
      setAiSettings: function (s) { return post('/api/ai-settings', s || {}); },
      aiGatewayStatus: function () { return get('/api/account-status'); },
      aiGatewayLogin: function () { return val(false); },
      aiStream: function (r) { return streamAi(r, 'common'); },
      aiStreamCancel: noop,
      onAiStream: onAiStream,
      webSearch: function () { return val([]); },
      aiWebSearch: function () { return val([]); },
      imageSearch: function () { return val([]); },
      generateImage: function () { return val(null); },
      fetchImage: function () { return val(null); },
      pickAttachments: function () { return val({ accepted: [], rejected: [] }); },
      addAttachmentPaths: function () { return val({ accepted: [], rejected: [] }); },
      addPastedImage: function () { return val({ accepted: [], rejected: [] }); },
      readAttachment: function (path, offset, maxChars) {
        return post('/api/read-attachment', { path: path, offset: offset, maxChars: maxChars });
      },
      readAttachmentImage: function (path) {
        return post('/api/read-image', { path: path }).then(function (r) { return r ? r.base64 : null; });
      },
      getPathForFile: function (f) { return (f && f.name) || ''; },
      getRecentFiles: function () { return get('/api/recents').then(function (r) { return r.entries || []; }); },
      onMenuCommand: off,
      onCloseSaveRequest: off,
      reportCloseSaveResult: noop,
      sendCloseSaveResult: noop,
      pickExportDir: function () { return val(null); },
      pickExportPdfPath: function () { return val(null); },
      exportPdf: function () { return val(null); },
      openExternal: noop,
      captureScreenSources: function () { return val([]); },
      captureScreenSource: function () { return val(null); }
    };
  }

  /* ── docs: window.desktop (47 methods, full support) ───────────── */
  var docsApi = Object.assign(commonApi(), {
    openDocx: function () { return val(null); },
    openDocxPath: function (path) { return readDoc(path); },
    openPath: function (path) { return readDoc(path); },
    consumePendingOpenDocx: function () {
      var f = deepLinkFile();
      return f ? readDoc(f) : val(null);
    },
    consumeNewBlankDoc: function () { return val(!deepLinkFile() && QS.get('blank') === '1'); },
    trackDocxFile: noop,
    onDocxExternalChange: off,

    saveDocx: function (path, data) {
      return post('/api/write-file', { path: path, data: bufToB64(data) })
        .then(function (r) { return r && r.ok ? { ok: true, path: r.path || path } : { ok: false, error: (r && r.error) || 'write failed' }; })
        .catch(function (e) { return { ok: false, error: e.message }; });
    },
    saveDocxAs: function (name, data) {
      return post('/api/save-as', { name: name, data: bufToB64(data) })
        .then(function (r) { return r && r.ok ? { ok: true, path: r.path } : { ok: false, error: (r && r.error) || 'save-as failed' }; })
        .catch(function (e) { return { ok: false, error: e.message }; });
    },
    saveDocxNew: function (name, data) {
      return post('/api/save-as', { name: name, data: bufToB64(data) })
        .then(function (r) { return r && r.ok ? { ok: true, path: r.path } : { ok: false, error: (r && r.error) || 'save-new failed' }; })
        .catch(function (e) { return { ok: false, error: e.message }; });
    },
    writeRecoveryCopy: noop,

    exportMarkdown: function () { return val(null); },
    printPdfBuffer: function () { return val(null); },
    saveMergedPdf: function () { return val(null); },
    pickImage: function () { return val(null); },

    onOpenDocx: off,
    onRenamedDocx: off,
    onTeardown: off,
    reportViewMenuState: noop,
    onCloseCheck: off,
    reportCloseCheck: noop,

    openNewTab: noop,
    listDocsTabs: function () { return val([]); },
    focusDocsTab: noop
  });

  /* ── slides: window.slidesApi (146 methods; core wired) ────────── */
  var slidesApi = Object.assign(commonApi(), {
    openPptx: function () {
      var f = deepLinkFile();
      if (!f) return val(null);
      return post('/api/read-file', { path: f }).then(function (r) {
        if (!r || r.error) return null;
        return { path: r.path, name: r.name, data: b64ToBuf(r.data) };
      });
    },
    consumePendingOpen: function () {
      var f = deepLinkFile();
      if (!f) return val(null);
      return post('/api/read-file', { path: f }).then(function (r) {
        if (!r || r.error) return null;
        return { path: r.path, name: r.name, data: b64ToBuf(r.data) };
      });
    },
    newBlank: function () { return val(null); },
    save: function (path, data) {
      var payload = data && data.byteLength !== undefined ? bufToB64(data) : (data || null);
      if (!payload) return val({ ok: false, error: 'no payload' });
      return post('/api/write-file', { path: path, data: payload })
        .then(function (r) { return r && r.ok ? { ok: true, path: r.path || path } : { ok: false, error: (r && r.error) || 'save failed' }; })
        .catch(function (e) { return { ok: false, error: e.message }; });
    },
    saveAs: function (name, data) {
      var payload = data && data.byteLength !== undefined ? bufToB64(data) : (data || null);
      if (!payload) return val({ ok: false, error: 'no payload' });
      return post('/api/save-as', { name: name, data: payload })
        .then(function (r) { return r && r.ok ? { ok: true, path: r.path } : { ok: false, error: (r && r.error) || 'save-as failed' }; })
        .catch(function (e) { return { ok: false, error: e.message }; });
    },
    isDirty: function () { return val(false); },
    onOpened: off,
    onRenamed: off,
    onAudienceNav: off,
    onShowInk: off,
    onShowSync: off
  });
  /* Stub the remaining slidesApi surface so bootstrap never throws. */
  var SLIDES_STUBS = ['addBlankSlide','addChart','addComment','addElement','addImageBytes','addInk','addMediaBytes','addSection','addSlide','addSlideWithLayout','addSmartArt','addTable','aiSnapshotRestore','analyzeMedia','applyHeaderFooter','applyTheme','audienceNav','audienceReady','batchEditTransform','beginHistoryBatch','clipboardExternal','cloudGenStatus','cloudGeneratePage','copyElements','copySlide','deleteComment','deleteElement','deleteSlide','duplicateElements','editBackground','editChart','editConnectorEndpoints','editFill','editImageFill','editPictureOpacity','editPictureSrcRect','editStroke','editTableCell','editTableStyle','editText','editTransform','endHistoryBatch','exportImages','findReplace','flipElements','getAnimations','getChartColorSchemes','getChartData','getComments','getHeaderFooter','getLayouts','getLink','getMediaData','getNotes','getRenderSlides','getRunLinks','getSections','getShapeKeys','getSlideLinks','getTransition','groupElements','hasSlideClipboard','htmlToPptx','insertImage','insertImageUrl','insertMedia','insertModel3d','listStyleTemplates','loadStyleTemplate','masterClose','masterDeleteElement','masterEditFill','masterEditStroke','masterEditText','masterEditTransform','masterEnter','masterOpen','moveSection','moveSlide','nativeClipboard','pasteElements','pasteSlide','presenterEnd','presenterInk','presenterStart','presenterSwap','presenterSync','printSlides','redo','removeSection','renameSection','reorderElement','repasteSlide','replacePictureBytes','replacePictureUrl','saveStyleSidecar','saveStyleTemplate','setAdvanceTimes','setAnimations','setAutoSavePref','setElementFont','setElementParagraphFormat','setLink','setNotes','setSlideHidden','setSlideLayout','setSlideSize','setTableCellAnchor','setTableColWidth','setTableRowHeight','setTextAnchor','setTransition','tableMerge','tableStructure','undo','ungroupElement'];
  SLIDES_STUBS.forEach(function (m) {
    if (!slidesApi[m]) slidesApi[m] = function () { return val(null); };
  });

  /* ── sheets: window.desktopApi (30 methods; core wired) ────────── */
  var sheetsApi = Object.assign(commonApi(), {
    selectWorkbook: function () {
      var f = deepLinkFile();
      if (!f) return val(null);
      return val({ path: f, name: f.split('/').pop() });
    },
    closeWorkbook: noop,
    autoRenameWorkbook: noop,
    writeWorkbookRecovery: noop,
    readWorkbookRange: function () { return val(null); },
    readWorkbookFormulas: function () { return val(null); },
    readWorkbookMedia: function () { return val(null); },
    readPivotDefinition: function () { return val(null); },
    readLocalImage: function () { return val(null); },
    recalcWorkbook: function () { return val(null); },
    saveWorkbookEdits: function (path, data) {
      var payload = data && data.byteLength !== undefined ? bufToB64(data) : (data || null);
      if (!payload) return val({ ok: false, error: 'no payload' });
      return post('/api/write-file', { path: path, data: payload })
        .then(function (r) { return r && r.ok ? { ok: true, path: r.path || path } : { ok: false, error: (r && r.error) || 'save failed' }; })
        .catch(function (e) { return { ok: false, error: e.message }; });
    }
  });

  /* ── pdf: window.pdfApi (29 methods; core wired) ───────────────── */
  var pdfApi = Object.assign(commonApi(), {
    readFile: function () {
      var f = deepLinkFile();
      if (!f) return val(null);
      return post('/api/read-file', { path: f }).then(function (r) {
        if (!r || r.error) return null;
        return { path: r.path, name: r.name, data: b64ToBuf(r.data) };
      });
    },
    consumePending: function () {
      var f = deepLinkFile();
      if (!f) return val(null);
      return post('/api/read-file', { path: f }).then(function (r) {
        if (!r || r.error) return null;
        return { path: r.path, name: r.name, data: b64ToBuf(r.data) };
      });
    },
    save: function (path, data) {
      var payload = data && data.byteLength !== undefined ? bufToB64(data) : (data || null);
      if (!payload) return val({ ok: false, error: 'no payload' });
      return post('/api/write-file', { path: path, data: payload })
        .then(function (r) { return r && r.ok ? { ok: true, path: r.path || path } : { ok: false, error: (r && r.error) || 'save failed' }; })
        .catch(function (e) { return { ok: false, error: e.message }; });
    },
    setDirty: noop,
    onSaveAsFlow: off,
    onSaveAsRequest: off,
    pagePreviewPng: function () { return val(null); },
    pageImagePng: function () { return val(null); },
    listPageImages: function () { return val([]); },
    listEditFonts: function () { return val([]); },
    validateTextEdits: function () { return val({ ok: true }); },
    insertPdf: function () { return val(null); },
    extractPages: function () { return val(null); },
    exportImages: function () { return val(null); }
  });

  /* ── install ───────────────────────────────────────────────────── */
  /* Defensive wrap: any method the shim does not implement must return a
   * promise rather than undefined — the renderers call into these namespaces
   * during bootstrap and a TypeError there leaves a blank page. */
  function safeNamespace(obj) {
    var KNOWN_MISSES = window.__hoMissing || (window.__hoMissing = {});
    return new Proxy(obj, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== 'string') return undefined;
        // event-registration style names get a disposer-returning stub
        if (/^on[A-Z]/.test(prop)) {
          KNOWN_MISSES[prop] = true;
          return function () { return function () {}; };
        }
        KNOWN_MISSES[prop] = true;
        return function () {
          if (window.__hoStrict) throw new Error('HO Bridge: unimplemented ' + prop);
          return Promise.resolve(null);
        };
      },
      has: function () { return true; }
    });
  }

  window.desktop = safeNamespace(docsApi);
  window.slidesApi = safeNamespace(slidesApi);
  window.desktopApi = safeNamespace(sheetsApi);
  window.pdfApi = safeNamespace(pdfApi);

  window.projectApi = {
    resolveChat: function () { return val(null); },
    appendChat: noop,
    loadChat: function () { return val(null); },
    rebindChat: noop,
    listProjects: function () { return val([]); },
    createProject: function () { return val({}); },
    renameProject: noop,
    deleteProject: noop,
    moveFile: noop,
    getTimeline: function () { return val([]); }
  };

  /* shell APIs (home screen / tab strip in the real app) */
  window.aiOffice = {
    recents: function () { return get('/api/recents'); },
    starred: function () { return get('/api/starred'); },
    statPaths: function () { return val([]); },
    toggleStar: function (p) { return post('/api/toggle-star', { path: p }); },
    openPath: function (p) { return post('/api/open-path', { path: p }); },
    browse: noop,
    newDoc: function () { return post('/api/new', { type: 'docx' }); },
    newSheet: function () { return post('/api/new', { type: 'xlsx' }); },
    newSlide: function () { return post('/api/new', { type: 'pptx' }); },
    removeRecent: noop,
    revealPath: noop,
    renameFile: function (p, n) { return post('/api/rename', { path: p, newName: n }); },
    duplicateFile: noop,
    deleteFiles: noop,
    openTrash: noop,
    getLanguage: function () { return get('/api/language'); },
    setLanguage: function (l) { return post('/api/language', { lang: l }); },
    accountStatus: function () { return get('/api/account-status'); },
    accountLogin: function () { return val(false); },
    accountLogout: noop,
    getAppVersion: function () { return get('/api/version'); },
    onboardingSeen: function () { return val(true); },
    setOnboardingSeen: noop,
    openGenTeam: noop
  };

  window.aiOfficeTabs = {
    list: function () { return val([]); },
    activate: noop, close: noop, showMenu: noop, showNewMenu: noop, reorder: noop,
    onChanged: off
  };

  window.aiOfficeProject = window.projectApi;
  window.aiOfficeUpdate = {
    check: function () { return val({ current: 'bridge', main: 'bridge', behind: 0, updated: false }); },
    onUpdate: off
  };

  console.log('[HO Bridge] shim ready — desktop:' + Object.keys(docsApi).length +
    ' slides:' + Object.keys(slidesApi).length +
    ' sheets:' + Object.keys(sheetsApi).length +
    ' pdf:' + Object.keys(pdfApi).length);
})();
</script>`
}
