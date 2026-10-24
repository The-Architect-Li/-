/**
 * Browser half of dsh-inkwell — the 小说工坊 side panel.
 *
 * HAND-WRITTEN `__ModuleLoader__` SHELL, same shape as the shipped bundles: the
 * host's client module graph calls `factory(require)` and takes the returned
 * `{ apply, inject }`. No bundler runs over this file, and none may: a build
 * step would rewrite the loader envelope.
 *
 * WHERE THIS PANEL LIVES. The web shell's right column (`rightbar`) is already
 * occupied by the right Sidebar, and there is no second right-hand seat. The
 * supported way to add UI there is a **tab type** in that Sidebar:
 *
 *   1. `ctx.sidebarRightTabs.register(definition)` — the type: kind, chip title,
 *      guide entry. Static, registered once.
 *   2. `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <id> }, Body)`
 *      — the body, dispatched by that id.
 *   3. `ctx.sidebarRight.openTab('inkwell')` — open it.
 *
 * WHAT IT SHOWS. A drawer of drawers: 世界观 / 人物设计 / 剧情设计 / 正文, each
 * with its own count, each expandable down to individual entries. The host
 * half (`src/panel/tree.ts`) does the folding, so this file only draws: every
 * row arrives with its own label, count, chip and children.
 *
 * MAKING A BOOK. `novel_project action="init"` in the conversation is still the
 * fast path, but a panel that can only watch is a panel a writer stops opening.
 * 「新建」 browses the host's disks one level at a time (`/api/inkwell/dirs`) and
 * creates the project in the directory picked (`/api/inkwell/init`). Both go
 * through the same `ProjectStore` the tool uses; the panel adds no new power,
 * only a second door.
 *
 * STYLE. No stylesheet is shipped: a 47 KB `client.css` is what the recycle-bin
 * bundle carries for one screen. The panel draws with neutral, theme-relative
 * colours (`currentColor` and `color-mix`) and inherits the host's font, so it
 * follows light and dark themes without a palette of its own.
 */
window.__ModuleLoader__.load({
  id: 'dsh-inkwell',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    /** Tab kind and implementation id; the id doubles as the slot dispatch key. */
    const KIND = 'inkwell'
    const ID = 'dsh-inkwell'

    /** Host routes (`src/panel/serve.ts`). */
    const API_SNAPSHOT = '/api/inkwell/snapshot'
    const API_DIRS = '/api/inkwell/dirs'
    const API_INIT = '/api/inkwell/init'
    const API_ROLES = '/api/inkwell/roles'
    const API_ENTRY = '/api/inkwell/entry'

    /** The one header a write request must carry (CSRF guard, host-side). */
    const WRITE_HEADER = { 'x-dsh-plugin': 'inkwell' }

    /** Chip and guide copy. */
    const LABEL = '小说工坊'

    /**
     * The client context, captured by `apply`.
     *
     * The views below are defined beside `apply`, not inside it, because the
     * bundle is one factory: a module-scope handle is how a view reaches a host
     * service without threading `ctx` through every component.
     */
    let hostContext = null

    /**
     * Open the host's own directory chooser.
     *
     * `uiWorkspace` ships with the web shell, so it is read lazily instead of
     * being declared in `inject`: a host without it keeps the bundle loaded and
     * falls back to the in-panel browser below.
     *
     * @returns the picked absolute directory, or `null` when the host has no
     *   chooser or the operator cancelled.
     */
    function pickHostDirectory() {
      const current = hostContext
      if (current === null) return Promise.resolve(null)
      const service = typeof current.get === 'function' ? current.get('uiWorkspace') : current.uiWorkspace
      if (service === undefined || service === null || typeof service.pickDirectory !== 'function') {
        return Promise.resolve(null)
      }
      return Promise.resolve(service.pickDirectory()).then((path) => (typeof path === 'string' && path !== '' ? path : null))
    }

    /** How often a visible panel re-reads the book, in ms. */
    const POLL_MS = 15000

    /** Phase names as the studio speaks them. */
    const PHASE_LABEL = {
      premise: '前提',
      canon: '设定',
      outline: '章纲',
      drafting: '写正文',
      review: '审稿',
      done: '完稿',
    }

    /** Section glyphs; monochrome so they inherit the theme. */
    const SECTION_ICON = {
      world: '◎',
      cast: '◍',
      plot: '◷',
      text: '✎',
    }

    /** Tone → colour. `currentColor` keeps light and dark themes working. */
    const TONE_STYLE = {
      done: { opacity: 0.95 },
      todo: { opacity: 1 },
      warn: { color: 'color-mix(in srgb, #c9822f 82%, currentColor)' },
      muted: { opacity: 0.5 },
    }

    /**
     * Read the panel payload for one session.
     * @param sessionId - the calling session, which decides the book.
     * @param root - an explicit book directory, when the writer made one just now.
     * @param signal - aborts the request when the tab hides or unmounts.
     * @returns the payload, or throws with the host's message.
     */
    async function loadPanel(sessionId, root, signal) {
      const params = []
      if (sessionId) params.push(`session=${encodeURIComponent(sessionId)}`)
      if (root) params.push(`root=${encodeURIComponent(root)}`)
      const url = params.length > 0 ? `${API_SNAPSHOT}?${params.join('&')}` : API_SNAPSHOT
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * List one directory level on the host.
     * @param path - absolute directory, or empty for the home directory.
     * @returns the listing.
     */
    async function loadDirs(path) {
      const url = path ? `${API_DIRS}?path=${encodeURIComponent(path)}` : API_DIRS
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Create a book in a directory.
     * @param dir - absolute parent directory for the project.
     * @param title - the book's title.
     * @param targetWords - planned length, `0` for "not set".
     * @returns the created (or already existing) book.
     */
    async function createBook(dir, title, targetWords) {
      const response = await fetch(API_INIT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...WRITE_HEADER },
        body: JSON.stringify({ dir, title, targetWords }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Read the page behind one tree row.
     *
     * @param sessionId - the calling session.
     * @param root - an explicit book directory, when the panel pinned one.
     * @param kind - `character`, `world`, or `chapter`.
     * @param key - the name, or the chapter number as a string.
     * @param signal - aborts the request when the view unmounts.
     * @returns the entry payload.
     */
    async function loadEntry(sessionId, root, kind, key, signal) {
      const params = [`kind=${encodeURIComponent(kind)}`, `key=${encodeURIComponent(key)}`]
      if (sessionId) params.push(`session=${encodeURIComponent(sessionId)}`)
      if (root) params.push(`root=${encodeURIComponent(root)}`)
      const response = await fetch(`${API_ENTRY}?${params.join('&')}`, {
        headers: { accept: 'application/json' },
        signal,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Read the agent team and the models the host can route to.
     * @param sessionId - the calling session.
     * @param root - an explicit book directory, when the panel pinned one.
     * @param signal - aborts the request when the view unmounts.
     * @returns `{ roles, providers, noBook, catalogUnavailable, root }`.
     */
    async function loadTeam(sessionId, root, signal) {
      const params = []
      if (sessionId) params.push(`session=${encodeURIComponent(sessionId)}`)
      if (root) params.push(`root=${encodeURIComponent(root)}`)
      const url = params.length > 0 ? `${API_ROLES}?${params.join('&')}` : API_ROLES
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Set one role's model route in this book.
     *
     * An empty string clears the field on the host side, which is exactly what
     * the "跟随全局" option means — so the picker sends `''` rather than
     * omitting the key, and the host stores the suppression.
     *
     * @param sessionId - the calling session.
     * @param root - an explicit book directory, when the panel pinned one.
     * @param body - `{ role, provider?, model?, reasoningEffort?, maxTokens?, reset? }`.
     * @returns the refreshed team payload.
     */
    async function saveRole(sessionId, root, body) {
      const params = []
      if (sessionId) params.push(`session=${encodeURIComponent(sessionId)}`)
      if (root) params.push(`root=${encodeURIComponent(root)}`)
      const url = params.length > 0 ? `${API_ROLES}?${params.join('&')}` : API_ROLES
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...WRITE_HEADER },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /** Where a role's effective route comes from, as the team page labels it. */
    const ROLE_SOURCE = {
      book: '本书指定',
      global: '全局默认',
      inherit: '跟随会话',
    }

    /**
     * Format a number with thousands separators.
     * @param n - the number, possibly `NaN` before the first load.
     * @returns the formatted string.
     */
    function num(n) {
      return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0'
    }

    /** Shared inline styles: one object per role, spread at use sites. */
    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'inherit',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '6px 4px 14px',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px 8px',
      },
      bookIcon: { opacity: 0.7, fontSize: '12px' },
      bookTitle: {
        fontWeight: 600,
        fontSize: '13px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      pill: {
        border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
        borderRadius: '999px',
        padding: '0 6px',
        fontSize: '10.5px',
        opacity: 0.7,
        whiteSpace: 'nowrap',
        lineHeight: '16px',
      },
      spacer: { flex: '1 1 auto' },
      iconButton: {
        border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        font: 'inherit',
        fontSize: '11px',
        padding: '1px 7px',
        cursor: 'pointer',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      primaryButton: {
        border: '1px solid color-mix(in srgb, currentColor 34%, transparent)',
        background: 'color-mix(in srgb, currentColor 12%, transparent)',
        color: 'inherit',
        borderRadius: '6px',
        font: 'inherit',
        fontSize: '11.5px',
        padding: '3px 10px',
        cursor: 'pointer',
      },
      // The bottom entry point. Full width, labelled, and larger than a header
      // icon on purpose: 设置 has to be findable without hunting for a gear.
      settingsRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        width: '100%',
        margin: '4px 0 0',
        padding: '11px 10px',
        border: 'none',
        borderTop: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      settingsIcon: {
        fontSize: '17px',
        lineHeight: '1',
        opacity: '0.85',
        flex: '0 0 auto',
      },
      settingsLabel: {
        fontSize: '13.5px',
        fontWeight: '500',
        letterSpacing: '0.01em',
      },
      // The page behind a row: label above value, so long prose wraps cleanly
      // instead of being squeezed into a two-column table.
      entryBlock: {
        padding: '2px 10px 0',
      },
      entryLabel: {
        fontSize: '10.5px',
        opacity: '0.5',
        letterSpacing: '0.02em',
      },
      entryValue: {
        fontSize: '12px',
        lineHeight: '1.55',
        paddingBottom: '7px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      entryListHead: {
        fontSize: '10.5px',
        opacity: '0.5',
        padding: '4px 10px 1px',
      },
      entryItem: {
        fontSize: '12px',
        lineHeight: '1.5',
        padding: '0 10px 2px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      // The second-level header's trail: 人物设计 › 主角 › 沈砚.
      crumb: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '10.5px',
        opacity: 0.5,
        padding: '0 10px 4px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      },
      editField: { padding: '0 10px 6px' },
      editLabel: {
        fontSize: '10.5px',
        opacity: 0.5,
        letterSpacing: '0.02em',
        paddingBottom: '2px',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 6px',
        borderRadius: '6px',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1.7',
        padding: '6px 8px',
        borderRadius: '6px',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        minHeight: '84px',
        resize: 'vertical',
      },
      // A chapter's prose: a column of paragraphs, not one pre-wrapped blob.
      prose: {
        padding: '0 10px 4px',
        fontSize: '12.5px',
        lineHeight: '1.75',
      },
      proseLine: {
        margin: '0 0 9px',
        textIndent: '2em',
        wordBreak: 'break-word',
      },
      blocked: {
        margin: '2px 10px 8px',
        padding: '6px 8px',
        borderRadius: '6px',
        fontSize: '11px',
        lineHeight: '1.55',
        whiteSpace: 'pre-wrap',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
      },
      editHint: {
        padding: '0 10px 8px',
        fontSize: '10.5px',
        opacity: 0.5,
      },
      editBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 10px 6px',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 8px',
        borderRadius: '6px',
        cursor: 'default',
        minHeight: '22px',
      },
      rowHover: { background: 'color-mix(in srgb, currentColor 7%, transparent)' },
      rowSelected: { background: 'color-mix(in srgb, currentColor 14%, transparent)' },
      glyph: { width: '13px', textAlign: 'center', opacity: 0.75, flex: '0 0 auto', fontSize: '11px' },
      label: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      aside: { opacity: 0.5, fontSize: '10.5px', whiteSpace: 'nowrap', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis' },
      count: {
        fontSize: '10.5px',
        opacity: 0.55,
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        borderRadius: '999px',
        padding: '0 5px',
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      },
      sectionHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        padding: '7px 8px 4px',
        fontWeight: 600,
        fontSize: '12.5px',
        cursor: 'pointer',
      },
      sectionCount: {
        fontSize: '10.5px',
        opacity: 0.55,
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        borderRadius: '999px',
        padding: '0 6px',
        lineHeight: '16px',
      },
      note: {
        border: '1px dashed color-mix(in srgb, currentColor 20%, transparent)',
        borderRadius: '8px',
        padding: '10px 12px',
        opacity: 0.8,
        margin: '4px 8px',
      },
      error: {
        border: '1px solid color-mix(in srgb, #d9534f 45%, transparent)',
        color: '#d9534f',
        borderRadius: '8px',
        padding: '8px 10px',
        whiteSpace: 'pre-wrap',
        margin: '4px 8px',
      },
      footer: {
        marginTop: 'auto',
        padding: '8px 8px 0',
        fontSize: '10.5px',
        opacity: 0.45,
        wordBreak: 'break-all',
      },
      dirPath: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '10.5px',
        opacity: 0.75,
        wordBreak: 'break-all',
        padding: '2px 8px',
      },
      input: {
        border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        font: 'inherit',
        fontSize: '11.5px',
        padding: '3px 7px',
        width: '100%',
        boxSizing: 'border-box',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '3px', padding: '4px 8px' },
      fieldLabel: { fontSize: '10.5px', opacity: 0.55 },
      actions: { display: 'flex', gap: '6px', padding: '8px 8px 4px', alignItems: 'center' },
      spacerBlock: { height: '6px' },
      select: {
        border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        font: 'inherit',
        fontSize: '11px',
        padding: '1px 4px',
        maxWidth: '100%',
        minWidth: 0,
      },
      roleCard: {
        border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
        borderRadius: '8px',
        padding: '6px 8px',
        margin: '6px 8px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
      roleHead: { display: 'flex', alignItems: 'center', gap: '6px' },
      roleName: { fontWeight: 600, fontSize: '12px' },
      roleDuty: { fontSize: '10.5px', opacity: 0.55, lineHeight: 1.45 },
      roleEffective: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '10.5px',
        opacity: 0.65,
        wordBreak: 'break-all',
      },
      fieldRow: { display: 'flex', alignItems: 'center', gap: '6px' },
      fieldName: { width: '46px', flex: '0 0 auto', fontSize: '10.5px', opacity: 0.55 },
      settingRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px',
        borderRadius: '6px',
        cursor: 'pointer',
        margin: '2px 8px',
      },
    }

    /**
     * One tree row, recursive through its children.
     *
     * @param props - the row, its depth, collapse state and selection.
     * @returns the row element, plus its children when expanded.
     */
    function Row(props) {
      const { row, depth, collapsed, onToggle, selected, onSelect } = props
      const hasChildren = Array.isArray(row.children) && row.children.length > 0
      const open = hasChildren && !collapsed.has(row.id)
      const toneStyle = (row.tone && TONE_STYLE[row.tone]) || null
      const isSelected = selected === row.id
      const style = {
        ...S.row,
        paddingLeft: `${8 + depth * 14}px`,
        ...(isSelected ? S.rowSelected : {}),
      }
      const glyph = hasChildren ? (open ? '▾' : '▸') : row.kind ? '◦' : '▫'
      const head = h(
        'div',
        {
          key: 'row',
          style,
          title: row.aside ? `${row.label} · ${row.aside}` : row.label,
          onClick: () => onSelect(row),
        },
        h('span', { style: S.glyph, onClick: hasChildren ? (event) => { event.stopPropagation(); onToggle(row.id) } : undefined }, glyph),
        h('span', { style: { ...S.label, ...(toneStyle || {}) } }, row.label),
        row.aside ? h('span', { style: S.aside }, row.aside) : null,
        row.chip ? h('span', { style: { ...S.pill, ...(toneStyle || {}) } }, row.chip) : null,
        typeof row.count === 'number' ? h('span', { style: S.count }, num(row.count)) : null,
      )
      if (!hasChildren || !open) return [head]
      const children = row.children.map((child) =>
        h(Row, {
          key: child.id,
          row: child,
          depth: depth + 1,
          collapsed,
          onToggle,
          selected,
          onSelect,
        }),
      )
      return [head, ...children]
    }

    /**
     * One drawer: its heading (with count) and its rows.
     *
     * @param props - the section, collapse state and selection.
     * @returns the section element.
     */
    function Section(props) {
      const { section, collapsed, onToggle, selected, onSelect } = props
      const open = !collapsed.has(section.id)
      return h(
        'div',
        { key: section.id },
        h(
          'div',
          { style: S.sectionHead, onClick: () => onToggle(section.id) },
          h('span', { style: S.glyph }, SECTION_ICON[section.id] || '▫'),
          h('span', null, section.label),
          h('span', { style: S.sectionCount }, num(section.count)),
        ),
        open
          ? section.rows.length === 0
            ? h('div', { style: { ...S.aside, padding: '2px 8px 4px 30px' } }, '还没有内容')
            : section.rows.map((row) =>
                h(Row, {
                  key: row.id,
                  row,
                  depth: 1,
                  collapsed,
                  onToggle,
                  selected,
                  onSelect,
                }),
              )
          : null,
      )
    }

    /**
     * The create-a-book view: browse directories, name the book, create it.
     *
     * @param props - session id, the directory the panel is about, and callbacks.
     * @returns the view element.
     */
    function NewBook(props) {
      const { sessionId, suggestedDir, onCancel, onCreated } = props
      const [listing, setListing] = useState(null)
      const [status, setStatus] = useState({ kind: 'loading' })
      const [target, setTarget] = useState('')
      const [title, setTitle] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const go = useCallback(
        (path) => {
          setStatus({ kind: 'loading' })
          loadDirs(path)
            .then((data) => {
              setListing(data)
              setStatus({ kind: 'ready' })
            })
            .catch((failure) => setStatus({ kind: 'error', message: String(failure && failure.message) }))
        },
        [],
      )

      useEffect(() => {
        go(suggestedDir || '')
      }, [go, suggestedDir])

      const submit = useCallback(() => {
        if (!listing) return
        setBusy(true)
        setError('')
        createBook(listing.path, title, Number(target) || 0)
          .then((book) => {
            setBusy(false)
            onCreated(book)
          })
          .catch((failure) => {
            setBusy(false)
            setError(String(failure && failure.message))
          })
      }, [listing, title, target, onCreated])

      // The host's own chooser when it has one: the operator knows that dialog,
      // and it can reach drives this list cannot.
      const choose = useCallback(() => {
        setBusy(true)
        setError('')
        pickHostDirectory()
          .then((path) => {
            setBusy(false)
            if (path === null) return
            go(path)
          })
          .catch((failure) => {
            setBusy(false)
            setError(String((failure && failure.message) || failure))
          })
      }, [go])

      const head = h(
        'div',
        { style: S.head },
        h('span', { style: S.bookIcon }, '✎'),
        h('span', { style: S.bookTitle }, '新建小说'),
        h('span', { style: S.spacer }),
        h('button', { type: 'button', style: S.iconButton, onClick: onCancel }, '返回'),
      )

      if (status.kind === 'loading' && !listing) {
        return h('div', { style: S.root }, head, h('div', { style: S.note }, '正在读取目录…'))
      }
      if (status.kind === 'error' && !listing) {
        return h(
          'div',
          { style: S.root },
          head,
          h('div', { style: S.error }, status.message || '目录读取失败'),
        )
      }

      const rows = listing.entries.map((entry) =>
        h(
          'div',
          { key: entry.path, style: S.row, onClick: () => go(entry.path) },
          h('span', { style: S.glyph }, '▸'),
          h('span', { style: S.label }, entry.name),
        ),
      )

      return h(
        'div',
        { style: S.root },
        head,
        h('div', { style: S.dirPath }, listing.path),
          h(
            'div',
            { style: S.actions },
            listing.parent
              ? h('button', { type: 'button', style: S.iconButton, onClick: () => go(listing.parent) }, '↑ 上一级')
              : null,
            h(
              'button',
              { type: 'button', style: S.iconButton, disabled: busy, onClick: choose, title: '用系统的目录选择框选一个文件夹' },
              '选择目录…',
            ),
            listing.roots.map((root) =>
              h('button', { key: root, type: 'button', style: S.iconButton, onClick: () => go(root) }, root),
            ),
            h('span', { style: S.spacer }),
            h('span', { style: { ...S.aside, padding: 0 } }, `${listing.entries.length} 个子目录`),
          ),
        listing.truncated ? h('div', { style: { ...S.aside, padding: '0 8px' } }, '（目录太多，只列出一部分）') : null,
        listing.book
          ? h(
              'div',
              { style: S.note },
              `这个目录里已经有《${listing.book.title}》。`,
              h(
                'div',
                { style: { marginTop: '6px' } },
                h(
                  'button',
                  { type: 'button', style: S.primaryButton, onClick: () => onCreated({ root: listing.book.root, title: listing.book.title, existing: true }) },
                  '打开这本书',
                ),
              ),
            )
          : null,
        rows.length > 0 ? h('div', null, ...rows) : h('div', { style: { ...S.aside, padding: '4px 8px' } }, '没有子目录，可以就在这里建书。'),

        h('div', { style: S.spacerBlock }),
        h(
          'div',
          { style: S.field },
          h('span', { style: S.fieldLabel }, '书名'),
          h('input', {
            style: S.input,
            value: title,
            placeholder: '例如：雾港',
            onChange: (event) => setTitle(event.target.value),
          }),
        ),
        h(
          'div',
          { style: S.field },
          h('span', { style: S.fieldLabel }, '目标字数（可留空）'),
          h('input', {
            style: S.input,
            value: target,
            inputMode: 'numeric',
            placeholder: '例如：800000',
            onChange: (event) => setTarget(event.target.value),
          }),
        ),
        error ? h('div', { style: S.error }, error) : null,
        h(
          'div',
          { style: S.actions },
          h(
            'button',
            { type: 'button', style: S.primaryButton, disabled: busy, onClick: submit },
            busy ? '正在创建…' : `在 ${listing.name} 里建书`,
          ),
          h('span', { style: S.spacer }),
          h('span', { style: { ...S.aside, padding: 0 } }, sessionId ? '' : '无会话'),
        ),
        h('div', { style: S.footer }, '会在该目录下建立 .novel 文件夹，与 novel_project action="init" 完全等价。'),
      )
    }

    /**
     * The team page: who is on the team, and which model each one runs on.
     *
     * Only the four dispatched roles are editable. The commander is not a
     * dispatch — it is the session the writer is already talking to — so it is
     * shown as a stated fact rather than a picker that would lie.
     *
     * @param props - session, pinned root, and navigation callbacks.
     * @returns the page.
     */
    function Team(props) {
      const { sessionId, root, onBack } = props
      const [state, setState] = useState({ status: 'loading' })
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')

      useEffect(() => {
        const controller = new AbortController()
        loadTeam(sessionId, root, controller.signal)
          .then((data) => {
            if (!controller.signal.aborted) setState({ status: 'ready', data })
          })
          .catch((failure) => {
            if (failure && failure.name === 'AbortError') return
            if (!controller.signal.aborted) setState({ status: 'error', message: String((failure && failure.message) || failure) })
          })
        return () => controller.abort()
      }, [sessionId, root])

      const save = useCallback(
        (role, body) => {
          setBusy(role)
          setError('')
          saveRole(sessionId, root, { role, ...body })
            .then((data) => setState({ status: 'ready', data }))
            .catch((failure) => setError(String((failure && failure.message) || failure)))
            .finally(() => setBusy(''))
        },
        [sessionId, root],
      )

      const head = h(
        'div',
        { style: S.head },
        h('button', { type: 'button', style: S.iconButton, onClick: onBack }, '返回'),
        h('span', { style: S.bookTitle }, '智能体团队'),
        h('span', { style: S.spacer }),
        busy ? h('span', { style: S.aside }, '保存中…') : null,
      )

      if (state.status === 'loading') return h('div', { style: S.root }, head, h('div', { style: S.note }, '正在读取…'))
      if (state.status === 'error') {
        return h('div', { style: S.root }, head, h('div', { style: S.error }, state.message || '读取失败'))
      }

      const data = state.data
      const providers = Array.isArray(data.providers) ? data.providers : []
      const roles = Array.isArray(data.roles) ? data.roles : []

      /** Options for the provider picker: the inherit choice, then each route. */
      const providerOptions = (role) => {
        const chosen = role.override && role.override.provider ? role.override.provider : ''
        const options = [h('option', { key: '__inherit', value: '' }, '跟随全局')]
        for (const provider of providers) {
          options.push(h('option', { key: provider.id, value: provider.id }, provider.name || provider.id))
        }
        return h(
          'select',
          {
            style: S.select,
            value: chosen,
            disabled: busy === role.id,
            onChange: (event) => {
              const value = event.target.value
              // A provider change invalidates the model: ids are provider-local.
              save(role.id, { provider: value, model: '' })
            },
          },
          ...options,
        )
      }

      /** Options for the model picker, limited to the chosen provider. */
      const modelOptions = (role) => {
        const providerId = role.override && role.override.provider ? role.override.provider : ''
        const chosen = role.override && role.override.model ? role.override.model : ''
        const scoped = providerId ? providers.filter((entry) => entry.id === providerId) : providers
        const options = [h('option', { key: '__inherit', value: '' }, providerId ? '选择模型' : '跟随全局')]
        for (const provider of scoped) {
          for (const model of provider.models) {
            const label = providerId ? model.name || model.id : `${provider.name || provider.id} / ${model.name || model.id}`
            options.push(h('option', { key: `${provider.id}/${model.id}`, value: model.id }, label))
          }
        }
        return h(
          'select',
          {
            style: S.select,
            value: chosen,
            disabled: busy === role.id || scoped.length === 0,
            onChange: (event) => save(role.id, { model: event.target.value }),
          },
          ...options,
        )
      }

      /** Options for the reasoning effort, when the chosen model advertises any. */
      const effortOptions = (role) => {
        const providerId = role.override && role.override.provider ? role.override.provider : ''
        const modelId = role.override && role.override.model ? role.override.model : ''
        if (!providerId || !modelId) return null
        const provider = providers.find((entry) => entry.id === providerId)
        const model = provider && provider.models.find((entry) => entry.id === modelId)
        const efforts = model && Array.isArray(model.efforts) ? model.efforts : []
        if (efforts.length === 0) return null
        const chosen = role.override && role.override.reasoningEffort ? role.override.reasoningEffort : ''
        return h(
          'div',
          { style: S.fieldRow },
          h('span', { style: S.fieldName }, '思考'),
          h(
            'select',
            {
              style: S.select,
              value: chosen,
              disabled: busy === role.id,
              onChange: (event) => save(role.id, { reasoningEffort: event.target.value }),
            },
            h('option', { key: '__default', value: '' }, model.defaultEffort ? `默认（${model.defaultEffort}）` : '默认'),
            ...efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id)),
          ),
        )
      }

      return h(
        'div',
        { style: S.root },
        head,
        data.noBook
          ? h('div', { style: S.note }, '这本书还没有项目文件。先在面板里新建一本，再回来配模型。')
          : null,
        error ? h('div', { style: S.error }, error) : null,
        h(
          'div',
          { style: S.roleCard },
          h(
            'div',
            { style: S.roleHead },
            h('span', { style: S.roleName }, '指挥官'),
            h('span', { style: S.pill }, '会话模型'),
          ),
          h('div', { style: S.roleDuty }, '和你对话的那个模型：取上下文包、派活、把审核意见转述给你。它不在这里配，因为它在你的会话设置里。'),
        ),
        ...roles.map((role) =>
          h(
            'div',
            { key: role.id, style: S.roleCard },
            h(
              'div',
              { style: S.roleHead },
              h('span', { style: S.roleName }, role.label),
              h('span', { style: S.pill }, ROLE_SOURCE[role.source] || role.source),
              h('span', { style: S.spacer }),
              role.source === 'book'
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.iconButton,
                      disabled: busy === role.id,
                      title: '清掉本书的指定，回到全局默认',
                      onClick: () => save(role.id, { reset: true }),
                    },
                    '还原',
                  )
                : null,
            ),
            h('div', { style: S.roleDuty }, role.duty),
            h('div', { style: S.fieldRow }, h('span', { style: S.fieldName }, '接口'), providerOptions(role)),
            h('div', { style: S.fieldRow }, h('span', { style: S.fieldName }, '模型'), modelOptions(role)),
            effortOptions(role),
            h('div', { style: S.roleEffective }, role.effective),
          ),
        ),
        h(
          'div',
          { style: S.footer },
          data.catalogUnavailable
            ? '宿主没有暴露 llm 服务，模型清单读不到；仍可用 novel_roles 工具指定。'
            : `可选 ${providers.length} 个接口、${providers.reduce((total, entry) => total + entry.models.length, 0)} 个模型，来自你在 dsh 里已配置好的那些。`,
        ),
      )
    }

    /**
     * The page behind a row: a character's card, a world entry, a chapter.
     *
     * It is a *page*, not a preview: the whole sidebar is this thing until you
     * go back, the header names where you are, and the fields can be typed into.
     * The shape still comes from the host (`/entry` returns `fields`, `lists` and
     * `edit`), so this component never decides what a character is — it only
     * lays the page out and posts the fields back.
     *
     * @param props - session, book root, the row's kind and key, the way back,
     *   and a refresh hook for the tree behind the page.
     * @returns the page.
     */
    function Detail(props) {
      const { sessionId, root, target, onBack, onChanged } = props
      const [state, setState] = useState({ status: 'loading' })
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState({})
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [mode, setMode] = useState('preview')

      useEffect(() => {
        const controller = new AbortController()
        setState({ status: 'loading' })
        setEditing(false)
        setDraft({})
        setError('')
        setMode('preview')
        loadEntry(sessionId, root, target.kind, target.key, controller.signal)
          .then((data) => setState({ status: 'ready', data }))
          .catch((failure) => {
            if (failure && failure.name === 'AbortError') return
            setState({ status: 'error', message: String((failure && failure.message) || failure) })
          })
        return () => controller.abort()
      }, [sessionId, root, target.kind, target.key])

      const data = state.status === 'ready' ? state.data : null
      const inputs = data && data.edit && Array.isArray(data.edit.inputs) ? data.edit.inputs : []
      const prose = data && data.edit && data.edit.body ? data.edit.body : null
      const editable = inputs.length > 0 || prose !== null

      /** Start editing from the values the page was loaded with. */
      function beginEdit() {
        const seed = {}
        for (const input of inputs) seed[input.key] = input.value
        if (prose) seed[prose.key] = prose.value
        setDraft(seed)
        setError('')
        setMode('edit')
        setEditing(true)
      }

      /** Drop the edit and go back to what the book says. */
      function cancelEdit() {
        setEditing(false)
        setError('')
        setMode('preview')
      }

      /** Post the typed fields; the host re-renders the page from the store. */
      async function saveEdit() {
        const fields = {}
        for (const input of inputs) fields[input.key] = draft[input.key] === undefined ? input.value : String(draft[input.key])
        if (prose) fields[prose.key] = draft[prose.key] === undefined ? prose.value : String(draft[prose.key])
        setSaving(true)
        setError('')
        try {
          const params = [`session=${encodeURIComponent(sessionId || '')}`, `root=${encodeURIComponent(root || '')}`]
          const response = await fetch(`${API_ENTRY}?${params.join('&')}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...WRITE_HEADER },
            body: JSON.stringify({ kind: target.kind, key: target.key, fields }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok === false) {
            throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
          }
          setState({ status: 'ready', data: payload.data })
          setEditing(false)
          setMode('preview')
          if (onChanged) onChanged()
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setSaving(false)
        }
      }

      const head = h(
        'div',
        { style: S.head },
        h('button', { type: 'button', style: S.iconButton, onClick: onBack, title: '回到目录' }, '返回'),
        h('span', { style: S.bookTitle }, (data && data.title) || target.label || ''),
        h('span', { style: S.spacer }),
        data && editable
          ? editing
            ? h(
                'span',
                { style: { display: 'flex', gap: '4px' } },
                h('button', { type: 'button', style: S.iconButton, onClick: cancelEdit, disabled: saving }, '取消'),
                h('button', { type: 'button', style: S.primaryButton, onClick: saveEdit, disabled: saving }, saving ? '保存中…' : '保存'),
              )
            : h('button', { type: 'button', style: S.iconButton, onClick: beginEdit }, '编辑')
          : null,
      )

      if (state.status === 'loading') {
        return h('div', { style: S.root }, head, h('div', { style: S.note }, '正在读取…'))
      }
      if (state.status === 'error') {
        return h('div', { style: S.root }, head, h('div', { style: S.error }, state.message || '读取失败'))
      }

      const fields = Array.isArray(data.fields) ? data.fields : []
      const lists = Array.isArray(data.lists) ? data.lists : []
      const crumb = Array.isArray(data.breadcrumb) ? data.breadcrumb.filter((part) => part) : []

      const crumbLine =
        crumb.length > 0
          ? h(
              'div',
              { style: S.crumb },
              ...crumb.flatMap((part, index) => [
                index === 0 ? null : h('span', { key: `c${index}s`, style: { opacity: 0.6 } }, '›'),
                h('span', { key: `c${index}` }, part),
              ]).filter(Boolean),
            )
          : null

      const heading = h(
        'div',
        { style: { padding: '0 10px 6px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
          h('span', { style: { fontSize: '13px', fontWeight: '500' } }, data.title),
          data.chip ? h('span', { style: S.pill }, data.chip) : null,
        ),
        data.subtitle ? h('div', { style: { ...S.aside, padding: '2px 0 0', maxWidth: '100%' } }, data.subtitle) : null,
      )

      const notice = data.blocked ? h('div', { style: S.blocked }, data.blocked) : null

      // Chapter prose: the page's main body. Preview renders one paragraph per
      // block; editing swaps in a box, and the count under it is the same
      // whitespace-stripped count the store records.
      const bodyValue = prose === null ? '' : String(draft[prose.key] === undefined ? prose.value : draft[prose.key])
      const paragraphs = (text) =>
        text.trim() === ''
          ? [h('div', { key: 'pn', style: S.editHint }, '还没有正文。点“编辑”开始写，或者让聊天窗口派写手。')]
          : text
              .split(/\n\s*\n/)
              .filter((line) => line.trim() !== '')
              .map((line, index) => h('p', { key: `pp${index}`, style: S.proseLine }, line.trim()))

      const prosePreview =
        prose === null ? null : [h('div', { key: 'ph', style: S.entryListHead }, prose.label), ...paragraphs(prose.value)]

      const proseEditor =
        prose === null
          ? null
          : h(
              'div',
              { key: 'pe', style: S.editField },
              h('div', { style: S.editLabel }, prose.label),
              h('textarea', {
                style: { ...S.textarea, minHeight: '320px' },
                value: bodyValue,
                onChange: (event) => setDraft({ ...draft, [prose.key]: event.target.value }),
                spellCheck: false,
              }),
              h(
                'div',
                { style: { ...S.editHint, padding: '3px 0 0' } },
                `${bodyValue.replace(/\s/g, '').length} 字`,
              ),
            )

      const proseToggle =
        prose === null || !editing
          ? null
          : h(
              'div',
              { key: 'pt', style: S.editBar },
              h(
                'button',
                { type: 'button', style: S.iconButton, onClick: () => setMode(mode === 'edit' ? 'preview' : 'edit') },
                mode === 'edit' ? '预览正文' : '改正文',
              ),
            )

      const editForm = editing
        ? inputs.map((input, index) =>
            h(
              'div',
              { key: `e${index}`, style: S.editField },
              h('div', { style: S.editLabel }, input.label),
              Array.isArray(input.options) && input.options.length > 0
                ? h(
                    'select',
                    {
                      style: S.select,
                      value: draft[input.key] === undefined ? input.value : draft[input.key],
                      onChange: (event) => setDraft({ ...draft, [input.key]: event.target.value }),
                    },
                    ...input.options.map((option) =>
                      h('option', { key: `o${option.value}`, value: option.value }, option.label),
                    ),
                  )
                : input.multiline
                  ? h('textarea', {
                      style: S.textarea,
                      value: draft[input.key] === undefined ? input.value : draft[input.key],
                      onChange: (event) => setDraft({ ...draft, [input.key]: event.target.value }),
                      spellCheck: false,
                    })
                  : h('input', {
                      style: S.input,
                      type: 'text',
                      value: draft[input.key] === undefined ? input.value : draft[input.key],
                      onChange: (event) => setDraft({ ...draft, [input.key]: event.target.value }),
                    }),
            ),
          )
        : []

      return h(
        'div',
        { style: S.root },
        head,
        crumbLine,
        heading,
        notice,
        error ? h('div', { style: S.error }, error) : null,
        ...editForm,
        proseToggle,
        editing && prose !== null && mode === 'edit' ? proseEditor : prosePreview,
        ...(editing
          ? []
          : fields.map((field, index) =>
              h(
                'div',
                { key: `f${index}`, style: S.entryBlock },
                h('div', { style: S.entryLabel }, field.label),
                h('div', { style: S.entryValue }, field.value),
              ),
            )),
        ...lists.flatMap((list, index) => [
          h('div', { key: `lh${index}`, style: S.entryListHead }, list.label),
          ...list.items.map((item, itemIndex) =>
            h('div', { key: `li${index}.${itemIndex}`, style: S.entryItem }, `· ${item}`),
          ),
        ]),
        h('div', { style: S.spacerBlock }),
        h('div', { style: S.footer }, data.root || root || ''),
      )
    }

    /**
     * The settings page: a list of doors, one of which is the team.
     *
     * @param props - session, book root, and navigation callbacks.
     * @returns the page.
     */
    function Settings(props) {
      const { root, onBack, onOpenTeam, roleCount } = props
      const row = (glyph, label, detail, onClick) =>
        h(
          'div',
          { style: S.settingRow, onClick, role: 'button' },
          h('span', { style: S.glyph }, glyph),
          h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
            h('span', { style: { fontSize: '12px' } }, label),
            detail ? h('span', { style: { fontSize: '10.5px', opacity: 0.55 } }, detail) : null,
          ),
          h('span', { style: S.spacer }),
          h('span', { style: { opacity: 0.4 } }, '›'),
        )

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.head },
          h('button', { type: 'button', style: S.iconButton, onClick: onBack }, '返回'),
          h('span', { style: S.bookTitle }, '设置'),
        ),
        row('◍', '智能体团队', `${roleCount} 个智能体，各自可以指定模型`, onOpenTeam),
        h('div', { style: { height: '10px' } }),
        h('div', { style: { ...S.sectionHead, cursor: 'default' } }, '关于'),
        h(
          'div',
          { style: { padding: '0 8px', fontSize: '10.5px', opacity: 0.6, lineHeight: 1.6 } },
          h('div', null, '墨井 · 长篇小说约束内核'),
          h('div', null, '面板只做两件写操作：建书、给智能体选模型。正文与设定仍然只走 novel_* 工具和它们的闸门。'),
        ),
        h('div', { style: S.footer }, root || ''),
      )
    }

    /**
     * The panel body.
     *
     * `sessionId` is the session standard kit; `hooks.tabInfo` is this tab
     * type's own injected hook (see `SidebarRightTabInjected`), read on every
     * render so visibility and the tab's actions stay live.
     *
     * @param props - slot props: the session kit plus the injected hooks.
     */
    function InkwellBody(props) {
      const sessionId = props.sessionId
      const hooks = props.hooks
      const tabInfo = hooks !== undefined && typeof hooks.tabInfo === 'function' ? hooks.tabInfo() : undefined
      const visible = tabInfo && tabInfo.tab ? tabInfo.tab.visible : true
      const storeKey = `inkwell.root.${sessionId || 'shared'}`
      const [root, setRoot] = useState(() => {
        try {
          return window.sessionStorage.getItem(storeKey) || ''
        } catch {
          return ''
        }
      })
      const [state, setState] = useState({ status: 'loading' })
      const [tick, setTick] = useState(0)
      const [view, setView] = useState('tree')
      // Every drawer starts folded: the panel opens as a table of contents, not
      // as a wall of ninety-four chapter rows.
      const [collapsed, setCollapsed] = useState(() => new Set(['world', 'cast', 'plot', 'text']))
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)

      const refresh = useCallback(() => setTick((n) => n + 1), [])

      useEffect(() => {
        try {
          if (root) window.sessionStorage.setItem(storeKey, root)
          else window.sessionStorage.removeItem(storeKey)
        } catch {
          /* a browser with storage disabled still works, it just forgets */
        }
      }, [root, storeKey])

      useEffect(() => {
        if (!visible) return undefined
        const controller = new AbortController()
        setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }))
        loadPanel(sessionId, root, controller.signal)
          .then((data) => {
            if (!controller.signal.aborted) setState({ status: 'ready', data })
          })
          .catch((error) => {
            if (error && error.name === 'AbortError') return
            if (!controller.signal.aborted) setState({ status: 'error', message: String(error && error.message) })
          })
        return () => controller.abort()
      }, [sessionId, root, tick, visible])

      useEffect(() => {
        if (!visible) return undefined
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [visible, refresh])

      const toggle = useCallback((id) => {
        setCollapsed((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      const onCreated = useCallback(
        (book) => {
          setView('tree')
          setRoot(book.root)
          setTick((n) => n + 1)
        },
        [],
      )

      const header = h(
        'div',
        { style: S.head },
        h('span', { style: S.bookIcon }, '▤'),
        h('span', { style: S.bookTitle }, state.status === 'ready' && state.data.title ? state.data.title : LABEL),
        state.status === 'ready' && state.data.phase
          ? h('span', { style: S.pill }, PHASE_LABEL[state.data.phase] || state.data.phase)
          : null,
        h('span', { style: S.spacer }),
        view === 'tree'
          ? h('button', { type: 'button', style: S.iconButton, onClick: () => setView('new'), title: '在某个目录里新建一本书' }, '＋ 新建')
          : null,
        view === 'tree'
          ? h('button', { type: 'button', style: S.iconButton, onClick: refresh, title: '重新读取' }, '刷新')
          : null,
      )

      // Settings lives at the bottom of the tree, spelled out: a bare gear in the
      // header was too easy to miss. Same row the app itself uses for 设置.
      const settingsRow = h(
        'button',
        { type: 'button', style: S.settingsRow, onClick: () => setView('settings'), title: '设置：智能体团队与模型' },
        h('span', { style: S.settingsIcon }, '⚙'),
        h('span', { style: S.settingsLabel }, '设置'),
        h('span', { style: S.spacer }),
        h('span', { style: S.aside }, '智能体团队'),
      )

      // A row that stands for a thing opens its page; a plain row only highlights.
      // The browser never looks a character up itself — `/entry` answers.
      const onRowClick = useCallback((row) => {
        if (row && row.kind && row.key) {
          setDetail({ kind: row.kind, key: row.key, label: row.label })
          setView('detail')
          return
        }
        if (row && Array.isArray(row.children) && row.children.length > 0) {
          setCollapsed((previous) => {
            const next = new Set(previous)
            if (next.has(row.id)) next.delete(row.id)
            else next.add(row.id)
            return next
          })
          return
        }
        setSelected((current) => (current === row.id ? null : row.id))
      }, [])

      if (view === 'new') {
        const suggested = state.status === 'ready' && state.data.root ? state.data.root.replace(/[\\/]\.novel[\\/]?$/, '') : ''
        return h(NewBook, { sessionId, suggestedDir: suggested, onCancel: () => setView('tree'), onCreated })
      }

      if (view === 'detail' && detail !== null) {
        return h(Detail, {
          sessionId,
          root: root || '',
          target: detail,
          onBack: () => setView('tree'),
          // A save can change a count (a chapter's words) or a state chip, so the
          // tree behind the page is re-read rather than left stale.
          onChanged: refresh,
        })
      }

      if (view === 'settings') {
        return h(Settings, {
          root: state.status === 'ready' && state.data.root ? state.data.root : '',
          roleCount: 4,
          onBack: () => setView('tree'),
          onOpenTeam: () => setView('team'),
        })
      }

      if (view === 'team') {
        return h(Team, { sessionId, root: root || '', onBack: () => setView('settings') })
      }

      if (state.status === 'loading') {
        return h('div', { style: S.root }, header, h('div', { style: S.note }, '正在读取这一本书…'))
      }
      if (state.status === 'error') {
        return h(
          'div',
          { style: S.root },
          header,
          h('div', { style: S.error }, state.message || '读取失败'),
          h('div', { style: S.note }, '宿主端的面板接口没有响应。插件仍可用，novel_* 工具不受影响。'),
        )
      }

      const data = state.data
      if (!data.phase) {
        return h(
          'div',
          { style: S.root },
          header,
          h(
            'div',
            { style: S.note },
            '这个目录还没有书。',
            h(
              'div',
              { style: { marginTop: '8px' } },
              h('button', { type: 'button', style: S.primaryButton, onClick: () => setView('new') }, '选择目录新建'),
            ),
            h(
              'div',
              { style: { marginTop: '8px', opacity: 0.7 } },
              '也可以在对话里调用 novel_project（action="init"），面板会自己出现。',
            ),
          ),
          h('div', { style: S.footer }, data.root || ''),
          settingsRow,
        )
      }

      const sections = Array.isArray(data.sections) ? data.sections : []
      const progress = data.targetWords > 0 ? Math.min(1, data.words / data.targetWords) : 0

      return h(
        'div',
        { style: S.root },
        header,
        sections.map((section) =>
          h(Section, {
            key: section.id,
            section,
            collapsed,
            onToggle: toggle,
            selected,
            onSelect: setSelected,
          }),
        ),
        h('div', { style: S.spacerBlock }),
        h(
          'div',
          { style: { padding: '0 8px', display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { ...S.aside, padding: 0 } }, `${num(data.words)} 字`),
          h('span', { style: { ...S.aside, padding: 0 } }, data.targetWords > 0 ? `/ ${num(data.targetWords)}（${Math.round(progress * 100)}%）` : '未设目标'),
          h('span', { style: S.spacer }),
          data.next ? h('span', { style: S.aside }, `→ ${PHASE_LABEL[data.next] || data.next}`) : null,
        ),
        data.blockers.length > 0
          ? h(
              'div',
              { style: { padding: '6px 8px 0' } },
              h('div', { style: { ...S.fieldLabel, paddingBottom: '2px' } }, `进入下一阶段还缺 ${data.blockers.length} 项`),
              ...data.blockers.slice(0, 4).map((line, index) =>
                h('div', { key: `b${index}`, style: { ...S.aside, maxWidth: '100%', padding: '1px 0' } }, `· ${line}`),
              ),
            )
          : null,
        data.facts.length > 0
          ? h(
              'div',
              { style: { padding: '8px 8px 0' } },
              h('div', { style: { ...S.fieldLabel, paddingBottom: '2px' } }, `已确立事实 ${data.facts.length} 条`),
              ...data.facts
                .slice(-3)
                .reverse()
                .map((fact) =>
                  h(
                    'div',
                    { key: fact.id, style: { ...S.aside, maxWidth: '100%', padding: '1px 0' } },
                    `${fact.subject}·${fact.predicate}＝${fact.value}`,
                  ),
                ),
            )
          : null,
        selected
          ? h('div', { style: { ...S.footer, opacity: 0.6 } }, `已选中：${selected}`)
          : null,
        h('div', { style: S.footer }, data.root),
        settingsRow,
      )
    }

    /**
     * The session-header button that opens the panel.
     *
     * A tab type nobody can find is a hidden feature: the guide page lists it,
     * and this button opens it from the conversation the writer is already in.
     */
    function OpenPanelAction(props) {
      const ctx = props.ctx
      const open = useCallback(() => {
        try {
          ctx.sidebarRight.openTab(KIND)
        } catch (error) {
          console.error('inkwell: open panel failed', error)
        }
      }, [ctx])
      return h(
        'button',
        {
          type: 'button',
          style: S.iconButton,
          onClick: open,
          title: '打开小说工坊面板',
          'aria-label': '打开小说工坊面板',
        },
        LABEL,
      )
    }

    /** The tab type: static face only — kind, chip title, guide capsule. */
    function definition() {
      return {
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: () => LABEL,
        guide: [
          {
            id: 'open',
            order: 40,
            title: () => LABEL,
            description: () => '世界观 / 人物设计 / 剧情设计 / 正文，并可在任意目录新建小说',
          },
        ],
      }
    }

    /**
     * Client plugin body.
     * @param ctx - client root context, carrying the slot registry and the right Sidebar.
     */
    function apply(ctx) {
      hostContext = ctx

      ctx.effect(() => ctx.sidebarRightTabs.register(definition()), 'inkwell: tab type')

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, InkwellBody),
          ),
        'inkwell: panel body',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.session.header.actions', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.actions',
                id: 'inkwell-open',
                order: 350,
                label: () => LABEL,
              },
              (props) => OpenPanelAction({ ...props, ctx }),
            ),
          ),
        'inkwell: header action',
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

    return module.exports
  },
})
