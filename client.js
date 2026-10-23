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
      const glyph = hasChildren ? (open ? '▾' : '▸') : '▫'
      const head = h(
        'div',
        {
          key: 'row',
          style,
          title: row.aside ? `${row.label} · ${row.aside}` : row.label,
          onClick: () => onSelect(isSelected ? null : row.id),
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
      const [collapsed, setCollapsed] = useState(() => new Set())
      const [selected, setSelected] = useState(null)

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

      if (view === 'new') {
        const suggested = state.status === 'ready' && state.data.root ? state.data.root.replace(/[\\/]\.novel[\\/]?$/, '') : ''
        return h(NewBook, { sessionId, suggestedDir: suggested, onCancel: () => setView('tree'), onCreated })
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
