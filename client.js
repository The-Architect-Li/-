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
    const API_BOOKS = '/api/inkwell/books'
    const API_PIN = '/api/inkwell/pin'
    const API_SCAN = '/api/inkwell/scan'
    const API_IMPORT = '/api/inkwell/import'
    const API_IMPORT_BOOK = '/api/inkwell/import-book'
    const API_EXPORT = '/api/inkwell/export'
    const API_DELETE_BOOK = '/api/inkwell/delete-book'
    const API_VOLUMES = '/api/inkwell/volumes'

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
      const service = hostService('uiWorkspace')
      if (service === null || typeof service.pickDirectory !== 'function') {
        return Promise.resolve(null)
      }
      return Promise.resolve(service.pickDirectory()).then((path) => (typeof path === 'string' && path !== '' ? path : null))
    }

    /**
     * Read one client service off the host context, or `null`.
     *
     * Lazy on purpose: `inject` declares the packages this bundle cannot live
     * without, and none of the workspace plumbing is on that list. A host that
     * has it gets the full flow; a host that does not still gets a panel.
     *
     * @param name - the service name as the host registers it.
     * @returns the service, or `null` when the host has none or `apply` has not
     *   run yet.
     */
    function hostService(name) {
      const current = hostContext
      if (current === null) return null
      const service = typeof current.get === 'function' ? current.get(name) : current[name]
      return service === undefined || service === null ? null : service
    }

    /**
     * Whether the host can open its own folder chooser.
     *
     * Distinguishes "the operator cancelled" from "there is no chooser", which
     * `pickHostDirectory` alone cannot: one should do nothing, the other has to
     * fall back to the in-panel browser.
     *
     * @returns true when `uiWorkspace.pickDirectory` exists.
     */
    function hostCanPick() {
      const service = hostService('uiWorkspace')
      return service !== null && typeof service.pickDirectory === 'function'
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

    /** Row height in the tree, in pixels: the unit the virtual window counts in. */
    const ROW_H = 30

    /** How tall a windowed run may get before it scrolls inside the drawer. */
    const WINDOW_H = 320

    /** Rows kept mounted above and below the visible window, so scrolling does not flash. */
    const OVERSCAN = 4

    /** Above this many flat children, a run becomes a window instead of a list. */
    const VIRTUAL_AT = 40

    /**
     * List the books this machine has opened.
     * @param sessionId - the calling session, which decides which book is "here".
     * @param signal - aborts the request when the tab hides or unmounts.
     * @returns `{ books, current }`; each book carries title, phase, counts.
     */
    async function loadBooks(sessionId, signal) {
      const params = []
      if (sessionId) params.push(`session=${encodeURIComponent(sessionId)}`)
      const url = params.length > 0 ? `${API_BOOKS}?${params.join('&')}` : API_BOOKS
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
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
     * Bind one chat session to one book on the host.
     *
     * The pin is what makes "the conversation I just opened is about the book I
     * just made" true without waiting for a workspace setting: `storeFor` reads
     * the pin before it falls back to the session's cwd.
     *
     * @param sessionId - the session to bind.
     * @param root - the book's absolute directory.
     * @returns the pin the host wrote.
     */
    async function pinSessionTo(sessionId, root) {
      const response = await fetch(API_PIN, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...WRITE_HEADER },
        body: JSON.stringify({ session: sessionId, root }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Ask what is already in a folder, before anything is created.
     *
     * The dialog needs this number to offer "把已有稿件导进来" at all: a folder
     * with no prose must not show the option, and one with 86 chapters must say
     * so before the writer wonders why the panel looks empty.
     *
     * @param dir - absolute directory the writer picked.
     * @param sessionId - the calling session, so an existing book can be checked for conflicts.
     * @returns the scan summary; `chapters` is 0 for an empty folder.
     */
    async function scanFolder(dir, sessionId) {
      const query = new URLSearchParams({ dir })
      if (sessionId) query.set('session', sessionId)
      const response = await fetch(`${API_SCAN}?${query.toString()}`)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Import a folder's manuscript into a book.
     *
     * @param dir - absolute directory holding 正文/、人物/、大纲/.
     * @param root - the book to write into.
     * @param sessionId - the calling session.
     * @returns how many chapters landed, and how many were already there.
     */
    async function importManuscript(dir, root, sessionId) {
      const query = new URLSearchParams()
      if (sessionId) query.set('session', sessionId)
      if (root) query.set('root', root)
      const response = await fetch(`${API_IMPORT}?${query.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...WRITE_HEADER },
        body: JSON.stringify({ dir }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Turn a manuscript folder into a book in one call.
     *
     * The create flow and the import flow end in the same place, but a folder
     * that already holds a novel does not need to be asked for a title it is
     * about to echo — the route falls back to the folder's own name.
     *
     * @param dir - absolute path of the manuscript folder.
     * @param title - the book's name, or empty to use the folder's.
     * @param targetWords - the word target, or 0 for none.
     * @returns the created book plus what the import wrote.
     */
    async function importBook(dir, title, targetWords) {
      const response = await fetch(API_IMPORT_BOOK, {
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
     * Write one book out into a folder the writer chose.
     *
     * Same two formats the tool has, because it is the same writer: `txt` for a
     * submission and `markdown` for one file per volume. `root` names the book,
     * since the shelf can export a book that is not the one on screen.
     *
     * @param root - absolute project root of the book.
     * @param dir - absolute folder to write into.
     * @param format - `'txt'` or `'markdown'`.
     * @returns `{ dir, files, chapters, words }`.
     */
    async function exportBookTo(root, dir, format) {
      const response = await fetch(API_EXPORT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...WRITE_HEADER },
        body: JSON.stringify({ root, dir, format }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Delete one book directory. Not reversible, and it does not touch the
     * manuscript folder the book was made from.
     *
     * @param root - absolute project root of the book.
     * @returns `{ root, title }`.
     */
    async function deleteBookAt(root) {
      const response = await fetch(API_DELETE_BOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...WRITE_HEADER },
        body: JSON.stringify({ root }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Read which chapters sit in which volume.
     *
     * @param root - absolute project root of the book.
     * @returns `{ volumes, unassigned, report }`.
     */
    async function fetchVolumes(root) {
      const query = root ? `?root=${encodeURIComponent(root)}` : ''
      const response = await fetch(`${API_VOLUMES}${query}`)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Move chapters into a volume, or cut the whole book into fixed-size ones.
     *
     * @param root - absolute project root of the book.
     * @param body - `{ action: 'assign', chapters, volume }` or `{ action: 'split', perVolume }`.
     * @returns the refreshed `{ volumes, unassigned, report }`.
     */
    async function writeVolumes(root, body) {
      const response = await fetch(API_VOLUMES, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...WRITE_HEADER },
        body: JSON.stringify({ root, ...body }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * Say what a scan found, in one line, for the create dialog.
     *
     * Three cases, and the wording matters for all of them: still reading, could
     * not read (which must not block creating a book), and read — where an empty
     * folder is stated plainly so nobody waits for an import that will not come.
     *
     * @param scan - `{ status, data?, message? }` from the dialog's state.
     * @returns the sentence to show.
     */
    function describeScanLine(scan) {
      if (scan.status === 'loading') return '正在看这个文件夹里有什么…'
      if (scan.status === 'error') return `没看成这个文件夹（${scan.message}）——不影响建书。`
      const data = scan.data || {}
      const chapters = data.chapters || 0
      const cast = data.cast || 0
      const volumes = data.volumes || 0
      if (chapters === 0 && cast === 0 && volumes === 0) return '这个文件夹里没有现成稿件，从第一章开始写。'
      const parts = []
      if (chapters > 0) parts.push(`${chapters} 章正文（${formatWords(data.words || 0)}）`)
      if (cast > 0) parts.push(`${cast} 张角色卡`)
      if (volumes > 0) parts.push(`${volumes} 卷大纲`)
      return `这个文件夹里已经有 ${parts.join('、')}。`
    }

    /** `125000` → `12.5 万字`; small numbers stay in characters. */
    function formatWords(words) {
      return words >= 10000 ? `${(words / 10000).toFixed(1)} 万字` : `${words} 字`
    }

    /**
     * Say what an import did, joined with whatever the workspace step had to say.
     *
     * Skipped chapters are named rather than hidden: "导了 3 章，跳过 83 章" is the
     * one fact that explains why the panel did not change as much as expected.
     *
     * @param imported - the `/import` payload.
     * @param note - the host's own note from opening the workspace, if any.
     * @returns the notice text.
     */
    function importNote(imported, note) {
      if (!imported) return note
      const parts = []
      if (imported.written > 0) parts.push(`导进 ${imported.written} 章（${formatWords(imported.words)}）`)
      if (imported.cast > 0) parts.push(`${imported.cast} 张角色卡`)
      if (imported.volumes > 0) parts.push(`${imported.volumes} 卷大纲`)
      if (imported.skipped > 0) parts.push(`跳过 ${imported.skipped} 章（书里已有）`)
      const sentence = parts.length > 0 ? `已${parts.join('、')}。` : '这个文件夹里没有可导入的稿件。'
      return note ? `${sentence} ${note}` : sentence
    }

    /**
     * The sessionStorage key that remembers which book one panel tab shows.
     * @param sessionId - the session the tab belongs to.
     * @returns the storage key.
     */
    function panelRootKey(sessionId) {
      return `inkwell.root.${sessionId || 'shared'}`
    }

    /**
     * Seed the book a brand-new session's panel should open on.
     *
     * The panel reads this key on mount. Writing it before the host switches
     * views is what makes the new tab land on the new book instead of the shelf.
     *
     * @param sessionId - the session the host is about to show.
     * @param root - the book's absolute directory.
     */
    function seedPanelRoot(sessionId, root) {
      try {
        window.sessionStorage.setItem(panelRootKey(sessionId), root)
      } catch {
        /* storage disabled: the panel falls back to the shelf, which lists it */
      }
    }

    /** A failure reduced to something a panel line can show. */
    function reasonOf(failure) {
      if (failure === null || failure === undefined) return '没有返回原因'
      const message = failure.message || failure.code || String(failure)
      return String(message)
    }

    /** Note a swallowed step in the devtools console, keeping the step name. */
    function warnStep(step, failure) {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`[inkwell] ${step} failed`, failure)
      }
    }

    /**
     * Register a directory as a workspace and open a chat session in it.
     *
     * This is the part of 新建 that no HTTP route can do: a workspace and a
     * session are the host's own client-side state. `workspaces.create` is
     * idempotent, so a folder that is already a workspace is simply returned,
     * and `connectWorkspace` reuses a blank session there rather than piling up
     * empties.
     *
     * Every step is guarded on its own. The book already exists on disk by the
     * time we get here, so a host that refuses the workspace or the navigation
     * must not make the click look like a failure — each step that fails says
     * what still works ("open it from the shelf") instead of throwing.
     *
     * @param dir - the absolute directory the book lives in.
     * @param root - the book's absolute directory.
     * @returns the opened session and workspace, plus a note naming the first
     *   step the host refused, if any.
     */
    async function openBookWorkspace(dir, root) {
      const workspaces = hostService('workspaces')
      const ui = hostService('uiWorkspace')
      if (workspaces === null || typeof workspaces.create !== 'function') {
        return { sessionId: null, workspaceId: null, note: '宿主没有工作区服务：书已经建好，在书库里点它就能进来。' }
      }

      let workspace = null
      try {
        workspace = await workspaces.create({ path: dir })
      } catch (failure) {
        warnStep('workspaces.create', failure)
        return {
          sessionId: null,
          workspaceId: null,
          note: `书已经建好，但这个文件夹没能注册成工作区：${reasonOf(failure)}。在书库里点这本书就能开始写。`,
        }
      }

      const workspaceId = workspace === null ? null : workspace.workspaceId ?? workspace.id ?? null
      if (ui === null || typeof ui.connectWorkspace !== 'function' || workspaceId === null) {
        return {
          sessionId: null,
          workspaceId,
          note: '书已经建好，文件夹也注册成了工作区，但这个宿主没有切会话的接口：到侧边栏那个工作区里开个会话即可。',
        }
      }

      let sessionId = null
      try {
        sessionId = await ui.connectWorkspace(workspaceId)
      } catch (failure) {
        warnStep('connectWorkspace', failure)
        return {
          sessionId: null,
          workspaceId,
          note: `书和工作区都好了，但这个会话没能打开：${reasonOf(failure)}。侧边栏那个工作区里可以手动开会话。`,
        }
      }

      // Seed first: the panel in the new session mounts as soon as the host
      // switches views, and it should already know which book it is showing.
      seedPanelRoot(sessionId, root)
      // Pinning is a belt to that braces: the panel prefers the pin, and the
      // tools in that session will too.
      let note = ''
      try {
        await pinSessionTo(sessionId, root)
      } catch (failure) {
        warnStep('pinSessionTo', failure)
        note = `会话已经打开，但没能把它记到这本书上（${reasonOf(failure)}）：面板会按工作目录找书，通常照样能打开。`
      }
      // `openSession` takes a SessionId (or a subagent address), not a wrapper.
      if (typeof ui.openSession === 'function') ui.openSession(sessionId)
      return { sessionId, workspaceId, note }
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
        fontSize: '13px',
        lineHeight: 1.6,
        color: 'var(--iw-fg)',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '4px 6px 18px',
        scrollbarGutter: 'stable',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 8px 10px',
        position: 'sticky',
        top: 0,
        zIndex: 2,
        backgroundColor: 'var(--iw-bar)',
        backdropFilter: 'blur(10px)',
        borderBottom: '1px solid var(--iw-line)',
        marginBottom: '4px',
      },
      bookIcon: { fontSize: '14px', color: 'var(--iw-accent)', flex: '0 0 auto' },
      bookTitle: {
        fontWeight: 650,
        fontSize: '14px',
        letterSpacing: '0.01em',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      pill: {
        border: '1px solid transparent',
        backgroundColor: 'var(--iw-surface)',
        borderRadius: '999px',
        padding: '0 8px',
        fontSize: '11px',
        lineHeight: '18px',
        letterSpacing: '0.02em',
        color: 'var(--iw-fg-2)',
        whiteSpace: 'nowrap',
      },
      spacer: { flex: '1 1 auto' },
      iconButton: {
        border: '1px solid var(--iw-line-strong)',
        color: 'var(--iw-fg)',
        backgroundColor: 'var(--iw-surface)',
        borderRadius: '7px',
        font: 'inherit',
        fontSize: '12px',
        height: '27px',
        padding: '0 10px',
        lineHeight: '25px',
        whiteSpace: 'nowrap',
        boxSizing: 'border-box',
      },
      primaryButton: {
        border: '1px solid transparent',
        color: 'var(--iw-accent-fg)',
        backgroundColor: 'var(--iw-accent)',
        borderRadius: '7px',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: 550,
        height: '27px',
        padding: '0 12px',
        lineHeight: '25px',
        whiteSpace: 'nowrap',
        boxSizing: 'border-box',
      },
      settingsRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '11px',
        width: '100%',
        margin: '6px 0 0',
        padding: '12px 12px',
        border: 'none',
        borderTop: '1px solid var(--iw-line)',
        backgroundColor: 'transparent',
        color: 'var(--iw-fg)',
        font: 'inherit',
        textAlign: 'left',
        borderRadius: '0 0 8px 8px',
      },
      settingsIcon: {
        fontSize: '16px',
        lineHeight: '1',
        color: 'var(--iw-fg-2)',
        flex: '0 0 auto',
      },
      settingsLabel: {
        fontSize: '13.5px',
        fontWeight: '550',
        letterSpacing: '0.01em',
      },
      entryBlock: {
        padding: '11px 10px 0',
        margin: '10px 2px 0',
        borderTop: '1px solid var(--iw-line)',
      },
      entryLabel: {
        fontSize: '11px',
        color: 'var(--iw-fg-3)',
        letterSpacing: '0.09em',
        paddingBottom: '4px',
      },
      entryValue: {
        fontSize: '13.5px',
        lineHeight: '1.75',
        paddingBottom: '11px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--iw-fg)',
      },
      entryListHead: {
        fontSize: '11px',
        color: 'var(--iw-fg-3)',
        letterSpacing: '0.09em',
        padding: '12px 10px 4px',
        fontWeight: 550,
        margin: '10px 2px 0',
        borderTop: '1px solid var(--iw-line)',
      },
      entryItem: {
        fontSize: '13.5px',
        lineHeight: '1.7',
        padding: '1px 10px 3px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--iw-fg)',
      },
      crumb: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '11.5px',
        color: 'var(--iw-fg-3)',
        padding: '2px 10px 6px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      },
      editField: { padding: '8px 10px 0' },
      editLabel: {
        fontSize: '11px',
        color: 'var(--iw-fg-3)',
        letterSpacing: '0.06em',
        paddingBottom: '4px',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: '13px',
        height: '30px',
        padding: '0 9px',
        borderRadius: '7px',
        color: 'var(--iw-fg)',
        backgroundColor: 'var(--iw-field)',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '1.75',
        padding: '8px 10px',
        borderRadius: '7px',
        color: 'var(--iw-fg)',
        backgroundColor: 'var(--iw-field)',
        minHeight: '88px',
        resize: 'vertical',
      },
      prose: {
        padding: '4px 10px 0',
        fontFamily: 'var(--iw-serif)',
        fontSize: '14.5px',
        lineHeight: '1.95',
        color: 'var(--iw-fg)',
      },
      proseLine: {
        margin: '0 0 15px',
        textIndent: '2em',
        wordBreak: 'break-word',
      },
      blocked: {
        margin: '6px 10px 10px',
        padding: '9px 11px',
        borderRadius: '8px',
        fontSize: '12px',
        lineHeight: '1.65',
        whiteSpace: 'pre-wrap',
        border: '1px solid var(--iw-warn-line)',
        backgroundColor: 'var(--iw-warn-bg)',
        color: 'var(--iw-warn-fg)',
      },
      editHint: {
        padding: '4px 10px 10px',
        fontSize: '11.5px',
        color: 'var(--iw-fg-3)',
      },
      editBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '0 10px 8px',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '3px 8px',
        borderRadius: '7px',
        minHeight: '29px',
        boxSizing: 'border-box',
      },
      glyph: {
        width: '15px',
        textAlign: 'center',
        color: 'var(--iw-fg-2)',
        flex: '0 0 auto',
        fontSize: '11px',
        lineHeight: '1',
      },
      glyphLeaf: {
        width: '15px',
        textAlign: 'center',
        color: 'var(--iw-fg-3)',
        flex: '0 0 auto',
        fontSize: '12px',
        lineHeight: '1',
        opacity: 0.55,
      },
      label: {
        letterSpacing: '0.005em',
        flex: '1 1 auto',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '13px',
      },
      aside: {
        color: 'var(--iw-fg-3)',
        fontSize: '11.5px',
        whiteSpace: 'nowrap',
        maxWidth: '45%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      count: {
        fontSize: '11px',
        color: 'var(--iw-fg-3)',
        backgroundColor: 'var(--iw-surface)',
        border: '1px solid transparent',
        borderRadius: '999px',
        padding: '0 7px',
        lineHeight: '17px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      sectionHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        padding: '7px 8px',
        marginTop: '3px',
        borderRadius: '7px',
        fontWeight: 600,
        fontSize: '13.5px',
        letterSpacing: '0.01em',
      },
      sectionCount: {
        fontSize: '11px',
        color: 'var(--iw-fg-3)',
        backgroundColor: 'var(--iw-surface)',
        borderRadius: '999px',
        padding: '0 7px',
        lineHeight: '17px',
        fontVariantNumeric: 'tabular-nums',
      },
      note: {
        border: '1px dashed var(--iw-line-strong)',
        borderRadius: '9px',
        padding: '12px 14px',
        color: 'var(--iw-fg-2)',
        margin: '6px 8px',
        fontSize: '12.5px',
        lineHeight: '1.7',
      },
      error: {
        border: '1px solid var(--iw-danger-line)',
        backgroundColor: 'var(--iw-danger-bg)',
        color: 'var(--iw-danger-fg)',
        borderRadius: '9px',
        padding: '10px 12px',
        whiteSpace: 'pre-wrap',
        margin: '6px 8px',
        fontSize: '12.5px',
        lineHeight: '1.6',
      },
      checkRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        margin: '4px 10px 8px',
        fontSize: '12.5px',
        lineHeight: '1.55',
        cursor: 'pointer',
        userSelect: 'none',
      },
      footer: {
        marginTop: 'auto',
        padding: '12px 10px 0',
        fontSize: '11px',
        color: 'var(--iw-fg-3)',
        wordBreak: 'break-all',
      },
      dirPath: {
        fontFamily: 'var(--iw-mono)',
        fontSize: '11.5px',
        color: 'var(--iw-fg-2)',
        wordBreak: 'break-all',
        padding: '4px 8px',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 8px' },
      fieldLabel: {
        fontSize: '11px',
        color: 'var(--iw-fg-3)',
        letterSpacing: '0.06em',
        fontWeight: 550,
      },
      listWrap: { display: 'flex', flexDirection: 'column', padding: '4px 8px', gap: '8px' },
      bookRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '11px',
        width: '100%',
        boxSizing: 'border-box',
        padding: '11px 12px 6px',
        borderRadius: '0',
        border: 'none',
        backgroundColor: 'transparent',
        color: 'var(--iw-fg)',
        font: 'inherit',
        textAlign: 'left',
      },
      bookBody: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: '1 1 auto' },
      bookName: {
        fontSize: '14px',
        fontWeight: 650,
        letterSpacing: '0.01em',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      bookMeta: {
        fontSize: '12px',
        color: 'var(--iw-fg-2)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      bookPath: {
        fontFamily: 'var(--iw-mono)',
        fontSize: '11px',
        color: 'var(--iw-fg-3)',
        letterSpacing: '-0.01em',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        direction: 'rtl',
        textAlign: 'left',
      },
      bookCard: {
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid var(--iw-line)',
        borderRadius: '10px',
        backgroundColor: 'var(--iw-surface)',
        overflow: 'hidden',
      },
      bookActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 10px 8px', gap: '10px' },
      linkButton: {
        border: 'none',
        background: 'none',
        font: 'inherit',
        fontSize: '11.5px',
        padding: '3px 4px',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      actions: { display: 'flex', gap: '8px', padding: '10px 8px 6px', alignItems: 'center' },
      spacerBlock: { height: '8px' },
      select: {
        backgroundColor: 'var(--iw-field)',
        color: 'var(--iw-fg)',
        borderRadius: '7px',
        font: 'inherit',
        fontSize: '12.5px',
        height: '30px',
        padding: '0 6px',
        maxWidth: '100%',
        minWidth: 0,
      },
      roleCard: {
        border: '1px solid var(--iw-line)',
        backgroundColor: 'var(--iw-surface)',
        borderRadius: '10px',
        padding: '10px 12px',
        margin: '8px 8px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      roleHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      roleName: { fontWeight: 650, fontSize: '13px' },
      roleDuty: { fontSize: '11.5px', color: 'var(--iw-fg-2)', lineHeight: 1.6 },
      roleEffective: {
        fontFamily: 'var(--iw-mono)',
        fontSize: '11.5px',
        color: 'var(--iw-fg-3)',
        wordBreak: 'break-all',
      },
      fieldRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      fieldName: { width: '52px', flex: '0 0 auto', fontSize: '11px', color: 'var(--iw-fg-3)' },
      settingRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '11px 12px',
        borderRadius: '9px',
        cursor: 'pointer',
        margin: '2px 8px',
      },
    }

    /**
     * The panel's look, as one stylesheet: tokens, type scale, and states.
     *
     * Inline styles cannot express `:hover`, `:focus-visible`, `:active` or
     * `:disabled`, so the panel shipped with none of them; they live here now.
     * Colours are tokens mixed from `CanvasText`/`Canvas`, so the panel follows
     * the host's theme without a second palette, and the theme's own accent does
     * not leak into it: a writing surface wants one quiet accent, not the
     * shell's.
     */
    const CSS = `
:root {
  --iw-serif: 'Source Han Serif SC', 'Songti SC', 'Noto Serif CJK SC', 'SimSun', Georgia, serif;
  --iw-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  --iw-fg: CanvasText;
  --iw-fg-2: color-mix(in srgb, CanvasText 80%, transparent);
  --iw-fg-3: color-mix(in srgb, CanvasText 62%, transparent);
  --iw-line: color-mix(in srgb, CanvasText 13%, transparent);
  --iw-line-strong: color-mix(in srgb, CanvasText 24%, transparent);
  --iw-surface: color-mix(in srgb, CanvasText 5%, transparent);
  --iw-surface-hover: color-mix(in srgb, CanvasText 9%, transparent);
  --iw-surface-active: color-mix(in srgb, CanvasText 14%, transparent);
  --iw-bar: color-mix(in srgb, Canvas 86%, transparent);
  --iw-field: color-mix(in srgb, CanvasText 4%, Canvas);
  --iw-accent: #33628f;
  --iw-accent-fg: #ffffff;
  --iw-accent-soft: color-mix(in srgb, #33628f 12%, transparent);
  --iw-accent-line: color-mix(in srgb, #33628f 46%, transparent);
  --iw-warn-bg: color-mix(in srgb, #b7791f 10%, Canvas);
  --iw-warn-line: color-mix(in srgb, #b7791f 34%, transparent);
  --iw-warn-fg: color-mix(in srgb, #8a5a11 88%, CanvasText);
  --iw-danger-bg: color-mix(in srgb, #c0392b 9%, Canvas);
  --iw-danger-line: color-mix(in srgb, #c0392b 38%, transparent);
  --iw-danger-fg: color-mix(in srgb, #b3352a 88%, CanvasText);
}
@media (prefers-color-scheme: dark) {
  :root {
    --iw-accent: #8ab4e8;
    --iw-accent-fg: #0d1a26;
    --iw-accent-soft: color-mix(in srgb, #8ab4e8 16%, transparent);
    --iw-accent-line: color-mix(in srgb, #8ab4e8 50%, transparent);
    --iw-warn-bg: color-mix(in srgb, #d6a13a 14%, Canvas);
    --iw-warn-fg: color-mix(in srgb, #e8c07a 82%, CanvasText);
    --iw-danger-bg: color-mix(in srgb, #e05a4c 14%, Canvas);
    --iw-danger-fg: color-mix(in srgb, #f3a09a 84%, CanvasText);
  }
}

/* Rows --------------------------------------------------------------------- */
.iw-click, .iw-row, .iw-btn, .iw-settings, .iw-book, .iw-open, .iw-glyph, .iw-card, .iw-input, .iw-select {
  transition: background-color .13s ease, border-color .13s ease, color .13s ease, box-shadow .13s ease, opacity .13s ease, padding-left .13s ease;
}
.iw-row { cursor: pointer; user-select: none; border: 1px solid transparent; }
.iw-row:hover { background-color: var(--iw-surface-hover); }
.iw-row:active { background-color: var(--iw-surface-active); }
.iw-row:focus-visible { outline: none; border-color: var(--iw-accent-line); box-shadow: 0 0 0 2px var(--iw-accent-soft); }
.iw-row-sel, .iw-row-sel:hover {
  background-color: var(--iw-accent-soft);
  border-color: transparent;
  box-shadow: inset 2px 0 0 var(--iw-accent);
  color: var(--iw-fg);
}
.iw-row-sel:focus-visible { box-shadow: inset 2px 0 0 var(--iw-accent), 0 0 0 2px var(--iw-accent-soft); }

/* Shelf links -------------------------------------------------------------- */
.iw-link { cursor: pointer; color: var(--iw-fg-3); }
.iw-link:hover { color: var(--iw-fg); background-color: var(--iw-surface-hover); }
.iw-link:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--iw-accent-soft); color: var(--iw-fg); }
/* A delete that only turns red once you are already hovering it is a delete you
   can press by accident. This one is red at rest. */
.iw-link.iw-danger { color: color-mix(in srgb, var(--iw-danger-fg) 80%, var(--iw-fg-3)); }
.iw-link.iw-danger:hover { color: var(--iw-danger-fg); background-color: var(--iw-danger-bg); }
.iw-link.iw-danger:focus-visible { box-shadow: 0 0 0 2px var(--iw-danger-line); color: var(--iw-danger-fg); }

/* Drawer headings ---------------------------------------------------------- */
.iw-open { cursor: pointer; user-select: none; background-color: transparent; border: 1px solid transparent; }
.iw-open:hover { background-color: var(--iw-surface-hover); }
.iw-open:active { background-color: var(--iw-surface-active); }
.iw-open:focus-visible { outline: none; border-color: var(--iw-accent-line); box-shadow: 0 0 0 2px var(--iw-accent-soft); }

/* Glyph toggles ------------------------------------------------------------ */
.iw-glyph { cursor: pointer; border-radius: 5px; }
.iw-glyph:hover { background-color: var(--iw-surface-active); color: var(--iw-fg); }
.iw-glyph:focus-visible { outline: 2px solid var(--iw-accent-line); outline-offset: -2px; }

/* Buttons ------------------------------------------------------------------ */
.iw-btn { cursor: pointer; }
.iw-btn:hover:not(:disabled) { background-color: var(--iw-surface-hover); border-color: var(--iw-line-strong); }
.iw-btn:active:not(:disabled) { background-color: var(--iw-surface-active); }
.iw-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--iw-accent-soft); border-color: var(--iw-accent-line); }
.iw-btn:disabled { opacity: .5; cursor: default; }
.iw-primary:hover:not(:disabled) { background-color: color-mix(in srgb, var(--iw-accent) 86%, #000); border-color: transparent; }
.iw-primary:active:not(:disabled) { background-color: color-mix(in srgb, var(--iw-accent) 74%, #000); }
.iw-primary:focus-visible { box-shadow: 0 0 0 3px var(--iw-accent-soft); }

/* Settings door ------------------------------------------------------------ */
.iw-settings { cursor: pointer; }
.iw-settings:hover { background-color: var(--iw-surface-hover); }
.iw-settings:active { background-color: var(--iw-surface-active); }
.iw-settings:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--iw-accent-line); }

/* Shelf cards -------------------------------------------------------------- */
.iw-book { cursor: pointer; }
.iw-book:hover { background-color: var(--iw-surface-hover); border-color: var(--iw-line-strong); box-shadow: 0 2px 10px color-mix(in srgb, #000 7%, transparent); }
.iw-book:active { background-color: var(--iw-surface-active); box-shadow: none; }
.iw-book:focus-visible { outline: none; border-color: var(--iw-accent-line); box-shadow: 0 0 0 2px var(--iw-accent-soft); }

/* Fields ------------------------------------------------------------------- */
.iw-input { border: 1px solid var(--iw-line); transition: border-color .13s ease, box-shadow .13s ease; }
.iw-input:hover { border-color: var(--iw-line-strong); }
.iw-input:focus, .iw-input:focus-visible {
  outline: none;
  border-color: var(--iw-accent);
  box-shadow: 0 0 0 3px var(--iw-accent-soft);
}
.iw-select { border: 1px solid var(--iw-line); cursor: pointer; }
.iw-select:hover { border-color: var(--iw-line-strong); }
.iw-select:focus-visible { outline: none; border-color: var(--iw-accent); box-shadow: 0 0 0 3px var(--iw-accent-soft); }

/* Cards -------------------------------------------------------------------- */
.iw-card { border-color: var(--iw-line); }
.iw-card:hover { border-color: var(--iw-line-strong); }
.iw-card:focus-within { border-color: var(--iw-accent-line); }

/* Dialog ------------------------------------------------------------------- */
.iw-backdrop {
  position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
  background-color: color-mix(in srgb, #05070a 46%, transparent);
  backdrop-filter: blur(3px);
}
.iw-dialog {
  width: min(412px, calc(100vw - 32px));
  min-width: 0;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 12px; box-sizing: border-box;
  padding: 20px;
  border-radius: 14px;
  font: inherit; font-size: 13px; line-height: 1.6;
  color: CanvasText; background-color: Canvas;
  border: 1px solid var(--iw-line-strong);
  box-shadow: 0 24px 60px color-mix(in srgb, #000 34%, transparent), 0 2px 6px color-mix(in srgb, #000 12%, transparent);
}
.iw-dialogpath {
  font-family: var(--iw-mono);
  font-size: 11.5px; line-height: 1.5; word-break: break-all;
  color: var(--iw-fg-3);
}

/* Reading ------------------------------------------------------------------ */
.iw-reading { font-family: var(--iw-serif); }
.iw-reading p { margin: 0 0 13px; text-indent: 2em; }

@media (prefers-reduced-motion: reduce) {
  .iw-click, .iw-row, .iw-btn, .iw-settings, .iw-book, .iw-open, .iw-glyph, .iw-card, .iw-input, .iw-select { transition: none; }
}
`

    /**
     * Put the sheet in the document once.
     *
     * Called on mount rather than at module load: a slot may render the body
     * long after `apply`, and the panel must not touch `document` while the
     * host is still building its page. Absent `document` (tests) is a no-op.
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const head = document.head || document.body
      if (!head) return
      if (document.getElementById('dsh-inkwell-styles')) return
      const style = document.createElement('style')
      style.id = 'dsh-inkwell-styles'
      style.textContent = CSS
      head.appendChild(style)
    }

    /**
     * A scroll box that only mounts the rows you can see.
     *
     * A book of 300 chapters is 300 rows, and rendering all of them makes the
     * panel feel like a document you drag through instead of a tree you work in.
     * Rows are a fixed 30px here, so the arithmetic is exact: the inner div is
     * as tall as the whole list, and the window slides over it.
     *
     * @param props - the rows, their depth, and the tree's callbacks.
     * @returns the scroll box.
     */
    function VirtualRows(props) {
      const { rows, depth, collapsed, onToggle, selected, onRowClick } = props
      const [top, setTop] = useState(0)
      const total = rows.length
      const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN)
      const end = Math.min(total, first + Math.ceil(WINDOW_H / ROW_H) + OVERSCAN * 2)
      const mounted = []
      for (let index = first; index < end; index += 1) {
        mounted.push(
          h(
            'div',
            {
              key: rows[index].id,
              style: { position: 'absolute', top: 0, left: 0, right: 0, height: `${ROW_H}px`, transform: `translateY(${index * ROW_H}px)` },
            },
            h(Row, { row: rows[index], depth, collapsed, onToggle, selected, onRowClick }),
          ),
        )
      }
      return h(
        'div',
        {
          className: 'iw-window',
          style: { maxHeight: `${WINDOW_H}px`, overflowY: 'auto', position: 'relative' },
          onScroll: (event) => setTop(event.currentTarget.scrollTop),
        },
        h('div', { style: { height: `${total * ROW_H}px`, position: 'relative' } }, mounted),
      )
    }

    /**
     * One tree row, recursive through its children.
     *
     * @param props - the row, its depth, collapse state and selection.
     * @returns the row element, plus its children when expanded.
     */
    function Row(props) {
      const { row, depth, collapsed, onToggle, selected, onRowClick } = props
      const hasChildren = Array.isArray(row.children) && row.children.length > 0
      const open = hasChildren && !collapsed.has(row.id)
      const toneStyle = (row.tone && TONE_STYLE[row.tone]) || null
      const isSelected = selected === row.id
      const style = {
        ...S.row,
        paddingLeft: `${8 + depth * 14}px`,
      }
      const glyph = hasChildren ? (open ? '▾' : '▸') : row.kind ? '◦' : '▫'
      const head = h(
        'div',
        {
          key: 'row',
          style,
          className: isSelected ? 'iw-row iw-row-sel' : 'iw-row',
          role: 'button',
          tabIndex: 0,
          'aria-pressed': isSelected ? 'true' : 'false',
          title: row.aside ? `${row.label} · ${row.aside}` : row.label,
          onClick: () => onRowClick(row),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onRowClick(row)
          },
        },
        h(
          'span',
          {
            style: hasChildren ? S.glyph : S.glyphLeaf,
            className: hasChildren ? 'iw-glyph' : undefined,
            onClick: hasChildren ? (event) => { event.stopPropagation(); onToggle(row.id) } : undefined,
          },
          glyph,
        ),
        h('span', { style: { ...S.label, ...(toneStyle || {}) } }, row.label),
        row.aside ? h('span', { style: S.aside }, row.aside) : null,
        row.chip ? h('span', { style: { ...S.pill, ...(toneStyle || {}) } }, row.chip) : null,
        typeof row.count === 'number' ? h('span', { style: S.count }, num(row.count)) : null,
      )
      if (!hasChildren || !open) return [head]
      // A long flat run (a volume's chapters, the chapter cards) is windowed so
      // the drawer does not turn into a 300-row scroll. Rows that themselves
      // have children stay on the plain path: their height is not fixed.
      const flat = row.children.every((child) => !Array.isArray(child.children) || child.children.length === 0)
      if (flat && row.children.length > VIRTUAL_AT) {
        return [head, h(VirtualRows, { key: 'window', rows: row.children, depth: depth + 1, collapsed, onToggle, selected, onRowClick })]
      }
      const children = row.children.map((child) =>
        h(Row, {
          key: child.id,
          row: child,
          depth: depth + 1,
          collapsed,
          onToggle,
          selected,
          onRowClick,
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
      const { section, collapsed, onToggle, selected, onRowClick } = props
      const open = !collapsed.has(section.id)
      return h(
        'div',
        { key: section.id },
        h(
          'div',
          {
            style: S.sectionHead,
            className: 'iw-open',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => onToggle(section.id),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onToggle(section.id)
            },
          },
          h('span', { style: { ...S.glyph, color: 'var(--iw-accent)', fontSize: '12.5px' } }, SECTION_ICON[section.id] || '▫'),
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
                  onRowClick,
                }),
              )
          : null,
      )
    }

    /**
     * The shelf: every book this machine has opened, plus the way to make one.
     *
     * This is where the panel starts. A book is a directory, so the list is
     * "which directories this dsh has written in" rather than a global catalog —
     * the host answers `/books`, and this view never guesses at a path.
     *
     * @param props - session id, the root last opened here, and callbacks.
     * @returns the library element.
     */
    function Library(props) {
      const { sessionId, lastRoot, onOpen, onNew, onImport, onExport, onDelete, onSettings } = props
      const [state, setState] = useState({ status: 'loading' })
      const [tick, setTick] = useState(0)

      useEffect(() => {
        const controller = new AbortController()
        setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }))
        loadBooks(sessionId, controller.signal)
          .then((data) => {
            if (!controller.signal.aborted) setState({ status: 'ready', data })
          })
          .catch((failure) => {
            if (failure && failure.name === 'AbortError') return
            if (!controller.signal.aborted) setState({ status: 'error', message: String(failure && failure.message) })
          })
        return () => controller.abort()
      }, [sessionId, tick])

      const books = state.status === 'ready' && Array.isArray(state.data.books) ? state.data.books : []

      const row = (book) => {
        const here = lastRoot !== '' && book.root === lastRoot
        return h(
          'div',
          { key: book.root, style: S.bookCard },
          h(
            'button',
            {
              type: 'button',
              className: 'iw-book', style: S.bookRow,
              title: book.root,
              onClick: () => onOpen(book),
            },
            h('span', { style: S.bookIcon }, '▤'),
            h(
              'div',
              { style: S.bookBody },
              h('span', { style: S.bookName }, book.title || '未命名'),
              h(
                'span',
                { style: S.bookMeta },
                `${PHASE_LABEL[book.phase] || book.phase} · ${num(book.chapters)} 章 · ${num(book.words)} 字`,
              ),
              h('span', { style: S.bookPath }, book.root),
            ),
            here ? h('span', { style: S.pill }, '上次') : book.current ? h('span', { style: S.pill }, '当前') : null,
          ),
          // Two verbs that act on the book rather than open it, kept off the card
          // itself: a nested button inside a button is not a thing the DOM allows,
          // and the row's own click means "read this", not "do something to it".
          h(
            'div',
            { style: S.bookActions },
            h(
              'button',
              { type: 'button', className: 'iw-link', style: S.linkButton, onClick: () => onExport(book), title: '导出成 txt 或按卷的 markdown' },
              '导出',
            ),
            h('span', { style: { ...S.aside, padding: '0 2px' } }, '·'),
            h(
              'button',
              { type: 'button', className: 'iw-link iw-danger', style: S.linkButton, onClick: () => onDelete(book), title: '删除这本书的目录' },
              '删除',
            ),
          ),
        )
      }

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.head },
          h('span', { style: S.bookIcon }, '▤'),
          h('span', { style: S.bookTitle }, LABEL),
          h('span', { style: S.spacer }),
          h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: onNew, title: '在某个目录里新建一本书' }, '＋ 新建'),
          h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: onImport, title: '把一个已经有稿件的文件夹导进书库' }, '导入…'),
          h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: () => setTick((n) => n + 1), title: '重新扫描书库' }, '刷新'),
        ),
        state.status === 'loading' ? h('div', { style: S.note }, '正在找这台机器上的书…') : null,
        state.status === 'error'
          ? h(
              'div',
              { style: { padding: '6px 8px' } },
              h('div', { style: S.error }, state.message || '读取失败'),
              h('div', { style: S.note }, '宿主端的面板接口没有响应。插件仍可用，novel_* 工具不受影响。'),
            )
          : null,
        state.status === 'ready' && books.length === 0
          ? h(
              'div',
              { style: S.note },
              '这台机器上还没有书。',
              h(
                'div',
                { style: { marginTop: '8px' } },
                h('button', { type: 'button', className: 'iw-btn iw-primary', style: S.primaryButton, onClick: onNew }, '选择目录新建'),
              ),
              h(
                'div',
                { style: { marginTop: '8px', opacity: 0.7 } },
                '也可以在对话里调用 novel_project（action="init"），建好后会出现在这里。',
              ),
            )
          : null,
        books.length > 0
          ? h(
              'div',
              { style: S.listWrap },
              h('div', { style: { ...S.fieldLabel, padding: '2px 2px 0' } }, `已有的书 ${books.length} 本`),
              ...books.map(row),
            )
          : null,
        h('div', { style: S.spacerBlock }),
        h(
          'button',
          { type: 'button', className: 'iw-settings', style: S.settingsRow, onClick: onSettings, title: '设置：智能体团队与模型' },
          h('span', { style: S.settingsIcon }, '⚙'),
          h('span', { style: S.settingsLabel }, '设置'),
          h('span', { style: S.spacer }),
          h('span', { style: S.aside }, '智能体团队'),
        ),
      )
    }

    /**
     * The folder name, used as the default book title.
     * @param dir - an absolute directory.
     * @returns the last path segment, or an empty string.
     */
    function baseNameOf(dir) {
      const parts = String(dir || '').split(/[\\/]/).filter((part) => part !== '')
      return parts.length === 0 ? '' : parts[parts.length - 1]
    }

    /**
     * The create-a-book dialog: one folder, one title, one button.
     *
     * It opens after the host's chooser has already returned a directory, so the
     * folder is a fact the writer just picked rather than a path to type. 重选
     * re-opens the same chooser; 浏览仍 leaves for the in-panel browser, which is
     * the only way through on a host without a chooser.
     *
     * @param props - the chosen directory, busy/error state, and callbacks.
     * @returns the modal overlay.
     */
    function CreateDialog(props) {
      const { dir, busy, error, onCreate, onCancel, onBrowse, onRepick, sessionId } = props
      const [title, setTitle] = useState(() => baseNameOf(dir))
      const [target, setTarget] = useState('')
      const [scan, setScan] = useState({ status: 'loading' })
      const [importToo, setImportToo] = useState(true)

      // What is already in this folder decides whether the import offer is even
      // shown: offering it on an empty folder would be a promise about nothing.
      useEffect(() => {
        let alive = true
        setScan({ status: 'loading' })
        scanFolder(dir, sessionId)
          .then((data) => {
            if (alive) setScan({ status: 'ready', data })
          })
          .catch((failure) => {
            if (alive) setScan({ status: 'error', message: String((failure && failure.message) || failure) })
          })
        return () => {
          alive = false
        }
      }, [dir, sessionId])

      const found = scan.status === 'ready' ? scan.data : null
      const hasProse = found !== null && (found.chapters > 0 || found.cast > 0 || found.volumes > 0)
      const submit = () => {
        if (busy) return
        onCreate(dir, title, Number(target) || 0, hasProse && importToo)
      }

      return h(
        'div',
        {
          className: 'iw-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h(
          'div',
          { className: 'iw-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '新建小说' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: S.bookIcon }, '✎'),
            h('span', { style: { ...S.bookTitle, fontSize: '13px' } }, '新建小说'),
            h('span', { style: S.spacer }),
          ),
          h('div', { className: 'iw-dialogpath' }, dir),
          h('div', { style: S.note }, describeScanLine(scan)),
          hasProse
            ? h(
                'label',
                { style: S.checkRow },
                h('input', {
                  type: 'checkbox',
                  checked: importToo,
                  disabled: busy,
                  onChange: (event) => setImportToo(event.target.checked),
                }),
                h(
                  'span',
                  null,
                  `建好之后把这些稿件导进来（${found.chapters} 章正文${found.cast > 0 ? `、${found.cast} 张角色卡` : ''}${found.volumes > 0 ? `、${found.volumes} 卷大纲` : ''}）`,
                ),
              )
            : null,
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: onRepick, title: '重新选择文件夹' },
              '重选目录…',
            ),
            h(
              'button',
              { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: onBrowse, title: '在面板里逐层浏览目录' },
              '浏览…',
            ),
          ),
          h(
            'div',
            { style: S.field },
            h('span', { style: S.fieldLabel }, '书名'),
            h('input', {
              className: 'iw-input',
              style: S.input,
              value: title,
              placeholder: '例如：雾港',
              autoFocus: true,
              onChange: (event) => setTitle(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') submit()
                if (event.key === 'Escape') onCancel()
              },
            }),
          ),
          h(
            'div',
            { style: S.field },
            h('span', { style: S.fieldLabel }, '目标字数（可留空）'),
            h('input', {
              className: 'iw-input',
              style: S.input,
              value: target,
              inputMode: 'numeric',
              placeholder: '例如：800000',
              onChange: (event) => setTarget(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') submit()
                if (event.key === 'Escape') onCancel()
              },
            }),
          ),
          error ? h('div', { style: S.error }, error) : null,
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              { type: 'button', className: 'iw-btn iw-primary', style: S.primaryButton, disabled: busy, onClick: submit },
              busy ? '正在创建…' : '创建并开始写',
            ),
            h('span', { style: S.spacer }),
            h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: onCancel }, '取消'),
          ),
          h(
            'div',
            { style: S.footer },
            '会在这个文件夹里建 .novel，把它注册成工作区，并新开一个聊天会话——那里的会话看这本书，别的文件夹看别的。',
          ),
        ),
      )
    }

    /**
     * The import dialog: one folder in, one written book out.
     *
     * It differs from the create dialog in what it promises. Creating a book is
     * about to start something; importing one is about to move something, so the
     * dialog leads with what was found and disables itself when the answer is
     * "nothing", rather than offering a button that would fail.
     *
     * @param props - the chosen folder, busy/error state, and callbacks.
     * @returns the modal overlay.
     */
    function ImportDialog(props) {
      const { dir, busy, error, onImport, onCancel, onRepick, sessionId } = props
      const [title, setTitle] = useState(() => baseNameOf(dir))
      const [target, setTarget] = useState('')
      const [scan, setScan] = useState({ status: 'loading' })

      useEffect(() => {
        let alive = true
        setScan({ status: 'loading' })
        scanFolder(dir, sessionId)
          .then((data) => {
            if (alive) setScan({ status: 'ready', data })
          })
          .catch((failure) => {
            if (alive) setScan({ status: 'error', message: String((failure && failure.message) || failure) })
          })
        return () => {
          alive = false
        }
      }, [dir, sessionId])

      const found = scan.status === 'ready' ? scan.data : null
      const empty = found !== null && found.chapters === 0 && found.volumes === 0
      const submit = () => {
        if (busy || empty) return
        onImport(dir, title, Number(target) || 0)
      }

      return h(
        'div',
        {
          className: 'iw-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h(
          'div',
          { className: 'iw-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '导入稿件' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: S.bookIcon }, '⇩'),
            h('span', { style: { ...S.bookTitle, fontSize: '13px' } }, '导入稿件'),
            h('span', { style: S.spacer }),
          ),
          h('div', { className: 'iw-dialogpath' }, dir),
          h('div', { style: S.note }, describeScanLine(scan)),
          found !== null && found.cast > 0
            ? h(
                'div',
                { style: { fontSize: '12px', lineHeight: 1.5, color: 'var(--iw-fg-3)', padding: '0 10px' } },
                `人物：${found.cast} 张角色卡${found.plans > 0 ? `，章纲 ${found.plans} 条` : ''}`,
              )
            : null,
          empty
            ? h('div', { style: S.note }, '换一个装稿件的文件夹：正文可以是一章一个文件，也可以是一整个 txt，只要里面写着「第一章」。')
            : null,
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: onRepick, title: '重新选择文件夹' },
              '重选目录…',
            ),
          ),
          h(
            'div',
            { style: S.field },
            h('span', { style: S.fieldLabel }, '书名'),
            h('input', {
              className: 'iw-input',
              style: S.input,
              value: title,
              placeholder: '默认用文件夹名',
              autoFocus: true,
              onChange: (event) => setTitle(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') submit()
                if (event.key === 'Escape') onCancel()
              },
            }),
          ),
          h(
            'div',
            { style: S.field },
            h('span', { style: S.fieldLabel }, '目标字数（可留空）'),
            h('input', {
              className: 'iw-input',
              style: S.input,
              value: target,
              inputMode: 'numeric',
              placeholder: '例如：800000',
              onChange: (event) => setTarget(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') submit()
                if (event.key === 'Escape') onCancel()
              },
            }),
          ),
          error ? h('div', { style: S.error }, error) : null,
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              { type: 'button', className: 'iw-btn iw-primary', style: S.primaryButton, disabled: busy || empty, onClick: submit },
              busy ? '正在导入…' : '导入并开始写',
            ),
            h('span', { style: S.spacer }),
            h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: onCancel }, '取消'),
          ),
          h(
            'div',
            { style: S.footer },
            '会把稿件读成正文、章卡、人物与大纲这些记录，把这个文件夹注册成工作区，并新开一个聊天会话。',
          ),
        ),
      )
    }

    /**
     * The delete-a-book question, asked once and answered with a verb.
     *
     * Deleting throws away every chapter, card, record and revision in the book
     * directory, and there is no undo, so the dialog says that in the first line
     * rather than in fine print. It offers the escape route too: exporting first
     * is what most people actually want when they are about to lose a book, and
     * asking costs one extra line here.
     *
     * @param props - the book, and the three things that can happen next.
     * @returns the modal overlay.
     */
    function DeleteDialog(props) {
      const { book, busy, error, onExportFirst, onDeleteNow, onCancel } = props
      const [confirm, setConfirm] = useState(false)
      return h(
        'div',
        {
          className: 'iw-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h(
          'div',
          { className: 'iw-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '删除这本书' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: S.bookIcon }, '⚠'),
            h('span', { style: { ...S.bookTitle, fontSize: '13px' } }, '删除这本书'),
            h('span', { style: S.spacer }),
          ),
          h('div', { className: 'iw-dialogpath' }, book.root),
          h(
            'div',
            { style: S.note },
            '删除后不能恢复。',
            h(
              'div',
              { style: { marginTop: '6px' } },
              `${book.title || '这本书'} 的 ${num(book.chapters)} 章正文、角色卡、大纲与账本都会一起删掉，书库里也不再出现。`,
            ),
            h('div', { style: { marginTop: '6px' } }, '如果你写稿子的那个文件夹还在，删掉的只是它下面的 .novel 目录。'),
          ),
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              {
                type: 'button',
                className: 'iw-btn iw-primary',
                style: S.primaryButton,
                disabled: busy,
                onClick: onExportFirst,
                title: '先导出成文件，成功后再删',
              },
              '先导出，再删除',
            ),
          ),
          h(
            'label',
            { style: S.checkRow },
            h('input', { type: 'checkbox', checked: confirm, onChange: (event) => setConfirm(event.target.checked) }),
            h('span', null, '我确认不要这本书了，直接删除'),
          ),
          error ? h('div', { style: S.error }, error) : null,
          h(
            'div',
            { style: S.actions },
            h('span', { style: S.spacer }),
            h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: onCancel }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'iw-btn iw-danger',
                style: { ...S.iconButton, color: 'var(--iw-danger-fg)', borderColor: 'var(--iw-danger-line)' },
                disabled: busy || !confirm,
                onClick: onDeleteNow,
                title: confirm ? '直接删除，不导出' : '先勾选上面的确认框',
              },
              busy ? '正在删除…' : '直接删除',
            ),
          ),
        ),
      )
    }

    /**
     * The export dialog: where to write, in which shape.
     *
     * It is reached two ways — from the shelf, and from the delete dialog's "先
     * 导出" — and the only difference is the button's label and what happens
     * after a successful write, so `afterDelete` decides that rather than a
     * second copy of this dialog.
     *
     * @param props - the book, the chosen folder, the format, and callbacks.
     * @returns the modal overlay.
     */
    function ExportDialog(props) {
      const { book, dir, busy, error, afterDelete, onExport, onRepick, onCancel } = props
      const [format, setFormat] = useState('txt')
      const ready = dir !== '' && dir !== null && !busy
      const pick = (value) => (event) => setFormat(value)
      return h(
        'div',
        {
          className: 'iw-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h(
          'div',
          { className: 'iw-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '导出这本书' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: S.bookIcon }, '↗'),
            h('span', { style: { ...S.bookTitle, fontSize: '13px' } }, afterDelete ? '导出后再删除' : '导出这本书'),
            h('span', { style: S.spacer }),
          ),
          h('div', { className: 'iw-dialogpath' }, dir === '' || dir === null ? '还没有选文件夹' : dir),
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: onRepick, title: '选择一个导出文件夹' },
              '选择文件夹…',
            ),
            h('span', { style: S.spacer }),
            h('span', { style: { ...S.aside, padding: 0 } }, `${num(book.chapters)} 章 · ${num(book.words)} 字`),
          ),
          h(
            'label',
            { style: S.checkRow },
            h('input', { type: 'radio', name: 'iw-export-format', checked: format === 'txt', onChange: pick('txt') }),
            h('span', null, '整本一个 .txt —  投稿用，只有章名和段落'),
          ),
          h(
            'label',
            { style: S.checkRow },
            h('input', { type: 'radio', name: 'iw-export-format', checked: format === 'markdown', onChange: pick('markdown') }),
            h('span', null, '每卷一个 .md —  保留分卷，方便自己再看'),
          ),
          error ? h('div', { style: S.error }, error) : null,
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              {
                type: 'button',
                className: 'iw-btn iw-primary',
                style: S.primaryButton,
                disabled: !ready,
                onClick: () => onExport(dir, format),
              },
              busy ? (afterDelete ? '正在导出，随后删除…' : '正在导出…') : afterDelete ? '导出并删除' : '导出',
            ),
            h('span', { style: S.spacer }),
            h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: onCancel }, '取消'),
          ),
          h(
            'div',
            { style: S.footer },
            afterDelete
              ? '导出成功才会删除；导出失败就停在这里，书还在。'
              : '导出的文件进你刚选的文件夹，书本身不会变。同一个文件夹再导一次会覆盖同名文件。',
          ),
        ),
      )
    }

    /**
     * A windowed list of plain rows, for dialogs.
     *
     * The volume picker can face 300 chapters, and a dialog that renders them all
     * is a dialog you cannot scroll to the bottom of. Same arithmetic as
     * {@link VirtualRows}, minus the tree.
     *
     * @param props - the row count, a render function per index, and a height.
     * @returns the scroll box.
     */
    function WindowList(props) {
      const { count, height, render } = props
      const [top, setTop] = useState(0)
      const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN)
      const end = Math.min(count, first + Math.ceil(height / ROW_H) + OVERSCAN * 2)
      const mounted = []
      for (let index = first; index < end; index += 1) {
        mounted.push(
          h(
            'div',
            {
              key: String(index),
              style: { position: 'absolute', top: 0, left: 0, right: 0, height: `${ROW_H}px`, transform: `translateY(${index * ROW_H}px)` },
            },
            render(index),
          ),
        )
      }
      return h(
        'div',
        {
          className: 'iw-window',
          style: { maxHeight: `${height}px`, overflowY: 'auto', position: 'relative', margin: '2px 0 4px' },
          onScroll: (event) => setTop(event.currentTarget.scrollTop),
        },
        h('div', { style: { height: `${count * ROW_H}px`, position: 'relative' } }, mounted),
      )
    }

    /**
     * The volume dialog: which chapter is in which volume, and two ways to say it.
     *
     * 手动 is the writer's own judgement — tick chapters, name a volume. 自动 is
     * arithmetic: every N chapters starts a new volume. Both write through the
     * same route, and neither deletes a chapter or an outline: a chapter taken out
     * of a volume becomes 未分卷, it does not disappear.
     *
     * @param props - the book, the session, and what to do when it lands.
     * @returns the modal overlay.
     */
    function VolumesDialog(props) {
      const { book, sessionId, onDone, onCancel } = props
      const [mode, setMode] = useState('manual')
      const [status, setStatus] = useState({ kind: 'loading' })
      const [picked, setPicked] = useState(() => new Set())
      const [target, setTarget] = useState('')
      const [perVolume, setPerVolume] = useState('10')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        fetchVolumes(book.root)
          .then((data) => {
            if (alive) setStatus({ kind: 'ready', data })
          })
          .catch((failure) => {
            if (alive) setStatus({ kind: 'failed', message: String((failure && failure.message) || failure) })
          })
        return () => {
          alive = false
        }
      }, [book.root])

      const apply = (body) => {
        setBusy(true)
        setError('')
        writeVolumes(book.root, body)
          .then((data) => {
            setBusy(false)
            onDone(data)
          })
          .catch((failure) => {
            setBusy(false)
            setError(String((failure && failure.message) || failure))
          })
      }

      const data = status.kind === 'ready' ? status.data : null
      const volumeOf = new Map()
      if (data !== null) {
        for (const volume of data.volumes) {
          for (const number of volume.chapters) volumeOf.set(number, volume.number)
        }
        for (const number of data.unassigned) volumeOf.set(number, 0)
      }
      const chapters = data === null ? [] : [...volumeOf.keys()].sort((a, b) => a - b)
      const highest = data === null ? 0 : data.volumes.reduce((max, volume) => Math.max(max, volume.number), 0)
      const targets = []
      for (let number = 1; number <= highest; number += 1) targets.push(number)

      const toggle = (number) => () => {
        setPicked((previous) => {
          const next = new Set(previous)
          if (next.has(number)) next.delete(number)
          else next.add(number)
          return next
        })
      }

      return h(
        'div',
        {
          className: 'iw-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h(
          'div',
          { className: 'iw-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '正文分卷' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: S.bookIcon }, '⋮⋮'),
            h('span', { style: { ...S.bookTitle, fontSize: '13px' } }, '正文分卷'),
            h('span', { style: S.spacer }),
          ),
          h('div', { className: 'iw-dialogpath' }, book.title || book.root),
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              { type: 'button', className: 'iw-btn', style: { ...S.iconButton, ...(mode === 'manual' ? { borderColor: 'var(--iw-accent-line)', color: 'var(--iw-accent)' } : {}) }, disabled: busy, onClick: () => setMode('manual') },
              '手动分配',
            ),
            h(
              'button',
              { type: 'button', className: 'iw-btn', style: { ...S.iconButton, ...(mode === 'auto' ? { borderColor: 'var(--iw-accent-line)', color: 'var(--iw-accent)' } : {}) }, disabled: busy, onClick: () => setMode('auto') },
              '自动划分',
            ),
            h('span', { style: S.spacer }),
            h('span', { style: { ...S.aside, padding: 0 } }, `${num(chapters.length)} 章`),
          ),
          status.kind === 'loading' ? h('div', { style: S.aside }, '正在读分卷…') : null,
          status.kind === 'failed' ? h('div', { style: S.error }, status.message) : null,
          data !== null && chapters.length === 0 ? h('div', { style: S.note }, '这本书还没有章节。') : null,

          data !== null && chapters.length > 0 && mode === 'manual'
            ? h(WindowList, {
                count: chapters.length,
                height: 260,
                render: (index) => {
                  const number = chapters[index]
                  const volume = volumeOf.get(number) || 0
                  return h(
                    'label',
                    { style: { ...S.checkRow, minHeight: `${ROW_H - 2}px`, padding: '0 6px', margin: 0 } },
                    h('input', { type: 'checkbox', checked: picked.has(number), onChange: toggle(number) }),
                    h('span', { style: { ...S.label, flex: '0 0 auto' } }, `第${number}章`),
                    h('span', { style: S.spacer }),
                    h('span', { style: S.pill }, volume === 0 ? '未分卷' : `第${volume}卷`),
                  )
                },
              })
            : null,

          data !== null && chapters.length > 0 && mode === 'manual'
            ? h(
                'div',
                { style: S.actions },
                h('span', { style: { ...S.aside, padding: 0 } }, `勾了 ${picked.size} 章`),
                h('span', { style: S.spacer }),
                h(
                  'select',
                  {
                    style: S.select,
                    value: target,
                    disabled: busy,
                    onChange: (event) => setTarget(event.target.value),
                    'aria-label': '归到哪一卷',
                  },
                  h('option', { value: '' }, '归到…'),
                  h('option', { value: '0' }, '未分卷'),
                  ...targets.map((number) => h('option', { key: String(number), value: String(number) }, `第${number}卷`)),
                  h('option', { value: String(highest + 1) }, `新建第${highest + 1}卷`),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'iw-btn iw-primary',
                    style: S.primaryButton,
                    disabled: busy || picked.size === 0 || target === '',
                    onClick: () =>
                      apply({
                        action: 'assign',
                        chapters: [...picked].sort((a, b) => a - b),
                        volume: target === '0' ? null : Number(target),
                      }),
                  },
                  busy ? '正在移动…' : '应用',
                ),
              )
            : null,

          data !== null && chapters.length > 0 && mode === 'auto'
            ? h(
                'div',
                { style: S.actions },
                h('span', { style: { ...S.aside, padding: 0 } }, '每'),
                h('input', {
                  type: 'number',
                  min: 1,
                  style: { ...S.input, width: '72px', textAlign: 'center' },
                  value: perVolume,
                  disabled: busy,
                  onChange: (event) => setPerVolume(event.target.value),
                  'aria-label': '每卷几章',
                }),
                h('span', { style: { ...S.aside, padding: 0 } }, '章一卷'),
                h('span', { style: S.spacer }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'iw-btn iw-primary',
                    style: S.primaryButton,
                    disabled: busy || !(Number(perVolume) >= 1),
                    onClick: () => apply({ action: 'split', perVolume: Number(perVolume) }),
                  },
                  busy ? '正在划分…' : '按这个划分',
                ),
              )
            : null,

          error ? h('div', { style: S.error }, error) : null,
          h(
            'div',
            { style: S.actions },
            h('span', { style: S.spacer }),
            h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: onCancel }, '关闭'),
          ),
          h(
            'div',
            { style: S.footer },
            mode === 'manual'
              ? '勾选章节，再选归到哪一卷；选「未分卷」就是把它们从卷里拿出来。不会删掉任何一章。'
              : '按顺序每 N 章切一卷，多出来的零头算最后一卷。已经存在的卷不会被删，只会重新分配。',
          ),
        ),
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
      const [scan, setScan] = useState({ status: 'loading' })
      const [importToo, setImportToo] = useState(true)

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

      // Every folder the writer browses gets the same question asked of it, so
      // walking into the manuscript's folder is enough to see that it has one.
      useEffect(() => {
        if (!listing) return undefined
        let alive = true
        setScan({ status: 'loading' })
        scanFolder(listing.path, sessionId)
          .then((data) => {
            if (alive) setScan({ status: 'ready', data })
          })
          .catch((failure) => {
            if (alive) setScan({ status: 'error', message: String((failure && failure.message) || failure) })
          })
        return () => {
          alive = false
        }
      }, [listing, sessionId])

      const found = scan.status === 'ready' ? scan.data : null
      const hasProse = found !== null && (found.chapters > 0 || found.cast > 0 || found.volumes > 0)

      const submit = useCallback(() => {
        if (!listing) return
        setBusy(true)
        setError('')
        createBook(listing.path, title, Number(target) || 0)
          .then((book) => {
            setBusy(false)
            onCreated(book, { dir: listing.path, importToo: hasProse && importToo })
          })
          .catch((failure) => {
            setBusy(false)
            setError(String(failure && failure.message))
          })
      }, [listing, title, target, onCreated, hasProse, importToo])

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
        h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: onCancel }, '返回'),
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
          {
            key: entry.path,
            style: S.row,
            className: 'iw-row',
            role: 'button',
            tabIndex: 0,
            onClick: () => go(entry.path),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              go(entry.path)
            },
          },
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
              ? h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: () => go(listing.parent) }, '↑ 上一级')
              : null,
            h(
              'button',
              { type: 'button', className: 'iw-btn', style: S.iconButton, disabled: busy, onClick: choose, title: '用系统的目录选择框选一个文件夹' },
              '选择目录…',
            ),
            listing.roots.map((root) =>
              h('button', { key: root, type: 'button', className: 'iw-btn', style: S.iconButton, onClick: () => go(root) }, root),
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
                  { type: 'button', className: 'iw-btn iw-primary', style: S.primaryButton, onClick: () => onCreated({ root: listing.book.root, title: listing.book.title, existing: true }) },
                  '打开这本书',
                ),
              ),
            )
          : null,
        rows.length > 0 ? h('div', null, ...rows) : h('div', { style: { ...S.aside, padding: '4px 8px' } }, '没有子目录，可以就在这里建书。'),
        h('div', { style: S.note }, describeScanLine(scan)),
        hasProse
          ? h(
              'label',
              { style: S.checkRow },
              h('input', {
                type: 'checkbox',
                checked: importToo,
                disabled: busy,
                onChange: (event) => setImportToo(event.target.checked),
              }),
              h(
                'span',
                null,
                `建好之后把这些稿件导进来（${found.chapters} 章正文${found.cast > 0 ? `、${found.cast} 张角色卡` : ''}${found.volumes > 0 ? `、${found.volumes} 卷大纲` : ''}）`,
              ),
            )
          : null,

        h('div', { style: S.spacerBlock }),
        h(
          'div',
          { style: S.field },
          h('span', { style: S.fieldLabel }, '书名'),
          h('input', {
            className: 'iw-input', style: S.input,
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
            className: 'iw-input', style: S.input,
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
            { type: 'button', className: 'iw-btn iw-primary', style: S.primaryButton, disabled: busy, onClick: submit },
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
        h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: onBack }, '返回'),
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
            className: 'iw-select', style: S.select,
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
            className: 'iw-select', style: S.select,
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
              className: 'iw-select', style: S.select,
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
            { key: role.id, style: S.roleCard, className: 'iw-card' },
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
                      className: 'iw-btn', style: S.iconButton,
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
        // The version this page was showing. The host refuses the save if the
        // chapter moved on since — better a reload than silently losing words.
        const revision = data && data.edit ? data.edit.revision : undefined
        if (typeof revision === 'number') fields.revision = revision
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
        h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: onBack, title: '回到目录' }, '返回'),
        h('span', { style: S.bookTitle }, (data && data.title) || target.label || ''),
        h('span', { style: S.spacer }),
        data && editable
          ? editing
            ? h(
                'span',
                { style: { display: 'flex', gap: '4px' } },
                h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: cancelEdit, disabled: saving }, '取消'),
                h('button', { type: 'button', className: 'iw-btn iw-primary', style: S.primaryButton, onClick: saveEdit, disabled: saving }, saving ? '保存中…' : '保存'),
              )
            : h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: beginEdit }, '编辑')
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
          h('span', { style: { fontSize: '15.5px', fontWeight: '600', letterSpacing: '0.01em' } }, data.title),
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
                { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: () => setMode(mode === 'edit' ? 'preview' : 'edit') },
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
                      className: 'iw-select', style: S.select,
                      value: draft[input.key] === undefined ? input.value : draft[input.key],
                      onChange: (event) => setDraft({ ...draft, [input.key]: event.target.value }),
                    },
                    ...input.options.map((option) =>
                      h('option', { key: `o${option.value}`, value: option.value }, option.label),
                    ),
                  )
                : input.multiline
                  ? h('textarea', {
                      className: 'iw-input', style: S.textarea,
                      value: draft[input.key] === undefined ? input.value : draft[input.key],
                      onChange: (event) => setDraft({ ...draft, [input.key]: event.target.value }),
                      spellCheck: false,
                    })
                  : h('input', {
                      className: 'iw-input', style: S.input,
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
          { className: 'iw-row', style: S.settingRow, onClick, role: 'button' },
          h('span', { style: S.glyph }, glyph),
          h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
            h('span', { style: { fontSize: '13px' } }, label),
            detail ? h('span', { style: { fontSize: '11.5px', color: 'var(--iw-fg-3)' } }, detail) : null,
          ),
          h('span', { style: S.spacer }),
          h('span', { style: { color: 'var(--iw-fg-3)' } }, '›'),
        )

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.head },
          h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: onBack }, '返回'),
          h('span', { style: S.bookTitle }, '设置'),
        ),
        row('◍', '智能体团队', `${roleCount} 个智能体，各自可以指定模型`, onOpenTeam),
        h('div', { style: { height: '10px' } }),
        h('div', { style: { ...S.sectionHead, cursor: 'default' } }, '关于'),
        h(
          'div',
          { style: { padding: '0 8px', fontSize: '11.5px', color: 'var(--iw-fg-3)', lineHeight: 1.65 } },
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
      const storeKey = panelRootKey(sessionId)
      const [root, setRoot] = useState(() => {
        try {
          return window.sessionStorage.getItem(storeKey) || ''
        } catch {
          return ''
        }
      })
      const [state, setState] = useState({ status: 'loading' })
      const [tick, setTick] = useState(0)
      // The panel opens on the shelf, not on a book: "小说工坊" is the workbench,
      // and a book is something you pick inside it.
      const [view, setView] = useState('library')
      // Where 新建 came from, so 取消 goes back there rather than to a guess.
      const [returnTo, setReturnTo] = useState('library')
      // Every drawer starts folded: the panel opens as a table of contents, not
      // as a wall of ninety-four chapter rows.
      const [collapsed, setCollapsed] = useState(() => new Set(['world', 'cast', 'plot', 'text']))
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      // The create dialog: the folder the chooser returned, or null when closed.
      const [draft, setDraft] = useState(null)
      const [creating, setCreating] = useState(false)
      const [createError, setCreateError] = useState('')
      // The import dialog, same shape as the create one: a folder, or null.
      const [importDir, setImportDir] = useState(null)
      const [importing, setImporting] = useState(false)
      const [importError, setImportError] = useState('')
      // A caveat that belongs to the book, not to the dialog: the dialog closes
      // on success, so anything the writer still needs to know is said here.
      const [notice, setNotice] = useState('')
      // Export and delete both act on a book rather than open one. `exportFor`
      // keeps the book and the reason (`afterDelete`), because the same dialog
      // serves both doors.
      const [exportFor, setExportFor] = useState(null)
      const [volumesFor, setVolumesFor] = useState(null)
      const [exportDir, setExportDir] = useState('')
      const [exporting, setExporting] = useState(false)
      const [exportError, setExportError] = useState('')
      const [deleteFor, setDeleteFor] = useState(null)
      const [deleting, setDeleting] = useState(false)
      const [deleteError, setDeleteError] = useState('')

      // The interaction sheet goes in once, on first mount of any view: hover,
      // focus and pressed states cannot live in inline styles.
      useEffect(() => {
        ensureStyles()
      }, [])

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
        // The shelf reads `/books`; a book read is only worth making once one is
        // open, and the library has no book to read.
        if (view === 'library') return undefined
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
      }, [sessionId, root, tick, visible, view])

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
        (book, options) => {
          setView('tree')
          setRoot(book.root)
          setTick((n) => n + 1)
          // The browse-and-create path creates the book itself, so the import it
          // offered has to be carried out here rather than inside that view.
          if (options && options.importToo && options.dir) {
            importManuscript(options.dir, book.root, sessionId)
              .then((imported) => setNotice(importNote(imported, '')))
              .catch((failure) => setNotice(`建好了，但稿件没导进来：${String((failure && failure.message) || failure)}`))
          }
        },
        [sessionId],
      )

      const openBook = useCallback((book) => {
        setSelected(null)
        setDetail(null)
        setRoot(book.root)
        setView('tree')
        setTick((n) => n + 1)
      }, [])

      const openNewBook = useCallback((from) => {
        setReturnTo(from)
        setView('new')
      }, [])

      // 新建 asks the host for a folder first, then shows one small dialog. On a
      // host with no chooser it falls back to the browser page, which is the only
      // way to name a directory there.
      const beginCreate = useCallback(
        (from) => {
          setReturnTo(from)
          setCreateError('')
          if (!hostCanPick()) {
            setView('new')
            return
          }
          pickHostDirectory()
            .then((picked) => {
              if (picked === null) return
              setCreateError('')
              setDraft(picked)
            })
            .catch((failure) => setCreateError(String((failure && failure.message) || failure)))
        },
        [],
      )

      // 导入 is the same question asked the other way round: pick the folder the
      // manuscript already lives in, then read it in one call. On a host with no
      // chooser, the browser page's own "建好之后导进来" checkbox is the same
      // outcome by two steps, so that is where it goes.
      const beginImport = useCallback(
        (from) => {
          setReturnTo(from)
          setImportError('')
          if (!hostCanPick()) {
            setView('new')
            return
          }
          pickHostDirectory()
            .then((picked) => {
              if (picked === null) return
              setImportError('')
              setImportDir(picked)
            })
            .catch((failure) => setImportError(String((failure && failure.message) || failure)))
        },
        [],
      )

      // One call builds the book and fills it. The tab then moves to the book
      // that just appeared, and the folder becomes a workspace with its own chat
      // session — the same hand-off the create flow makes.
      const submitImport = useCallback(
        (dir, title, targetWords) => {
          setImporting(true)
          setImportError('')
          importBook(dir, title, targetWords)
            .then((imported) =>
              openBookWorkspace(dir, imported.root)
                .catch((failure) => ({ sessionId: null, workspaceId: null, note: String((failure && failure.message) || failure) }))
                .then((opened) => ({ imported, opened })),
            )
            .then(({ imported, opened }) => {
              setImporting(false)
              setImportDir(null)
              setNotice(importNote(imported, opened.note))
              onCreated({ root: imported.root, title: imported.title })
            })
            .catch((failure) => {
              setImporting(false)
              setImportError(String((failure && failure.message) || failure))
            })
        },
        [onCreated],
      )

      // Create the book, then hand the same folder to the host: a workspace, a
      // chat session in it, that session pinned to this book, and the panel
      // pre-seeded to open it. One click, one place to keep writing.
      const submitCreate = useCallback(
        (dir, title, targetWords, importToo) => {
          setCreating(true)
          setCreateError('')
          createBook(dir, title, targetWords)
            .then((book) =>
              openBookWorkspace(dir, book.root)
                .catch((failure) => ({ sessionId: null, workspaceId: null, note: String((failure && failure.message) || failure) }))
                .then((opened) => ({ book, opened })),
            )
            // The manuscript goes in before the panel switches, so the first
            // thing the new tab shows is the book's real shape rather than an
            // empty tree that fills in a second later.
            .then(({ book, opened }) =>
              importToo && !book.existing
                ? importManuscript(dir, book.root, sessionId).then((imported) => ({ book, opened, imported }))
                : { book, opened, imported: null },
            )
            .then(({ book, opened, imported }) => {
              setCreating(false)
              setDraft(null)
              setNotice(imported === null ? opened.note : importNote(imported, opened.note))
              onCreated(book)
            })
            .catch((failure) => {
              setCreating(false)
              setCreateError(String((failure && failure.message) || failure))
            })
        },
        [onCreated, sessionId],
      )

      // 导出 asks for a folder the same way 新建 does: the host's own chooser when
      // it has one. `afterDelete` only decides what happens once the write
      // succeeds, so the delete dialog reuses this dialog instead of a copy.
      const beginExport = useCallback((book, afterDelete) => {
        setExportFor({ book, afterDelete })
        setExportError('')
        setExportDir('')
        if (!hostCanPick()) return
        pickHostDirectory()
          .then((picked) => {
            if (picked !== null) setExportDir(picked)
          })
          .catch((failure) => setExportError(String((failure && failure.message) || failure)))
      }, [])

      // A deleted book that is also the open book would leave the panel pointing
      // at a directory that no longer exists, so the shelf is where it goes back
      // to — the same place a writer who just threw a book away expects to stand.
      const forgetDeleted = useCallback(
        (book, note) => {
          setNotice(note)
          setTick((n) => n + 1)
          if (root !== book.root) return
          setRoot('')
          setDetail(null)
          setSelected(null)
          setView('library')
        },
        [root],
      )

      const submitExport = useCallback(
        (dir, format) => {
          const target = exportFor
          if (target === null || dir === '') return
          setExporting(true)
          setExportError('')
          exportBookTo(target.book.root, dir, format)
            .then((written) => {
              if (!target.afterDelete) {
                setExporting(false)
                setExportFor(null)
                setNotice(`导出好了：${written.files.length} 个文件写到 ${written.dir}`)
                return undefined
              }
              return deleteBookAt(target.book.root).then((gone) => {
                setExporting(false)
                setExportFor(null)
                forgetDeleted(target.book, `已导出 ${written.files.length} 个文件到 ${written.dir}，然后删掉了《${gone.title}》。`)
              })
            })
            .catch((failure) => {
              setExporting(false)
              setExportError(String((failure && failure.message) || failure))
            })
        },
        [exportFor, forgetDeleted],
      )

      const beginDelete = useCallback((book) => {
        setDeleteError('')
        setDeleteFor(book)
      }, [])

      const submitDelete = useCallback(() => {
        const target = deleteFor
        if (target === null) return
        setDeleting(true)
        setDeleteError('')
        deleteBookAt(target.root)
          .then((gone) => {
            setDeleting(false)
            setDeleteFor(null)
            forgetDeleted(target, `已经删掉《${gone.title}》。`)
          })
          .catch((failure) => {
            setDeleting(false)
            setDeleteError(String((failure && failure.message) || failure))
          })
      }, [deleteFor, forgetDeleted])

      const header = h(
        'div',
        { style: S.head },
        view === 'tree'
          ? h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: () => setView('library'), title: '回到书库' }, '←')
          : null,
        h('span', { style: S.bookIcon }, '▤'),
        h('span', { style: S.bookTitle }, state.status === 'ready' && state.data.title ? state.data.title : LABEL),
        state.status === 'ready' && state.data.phase
          ? h('span', { style: S.pill }, PHASE_LABEL[state.data.phase] || state.data.phase)
          : null,
        h('span', { style: S.spacer }),
        view === 'tree'
          ? h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: () => beginCreate('tree'), title: '选一个文件夹，在里面新建一本书' }, '＋ 新建')
          : null,
        view === 'tree' && root !== ''
          ? h(
              'button',
              {
                type: 'button',
                className: 'iw-btn',
                style: S.iconButton,
                onClick: () =>
                  setVolumesFor({
                    root,
                    title: state.status === 'ready' && state.data.title ? state.data.title : '',
                  }),
                title: '把章节分到卷里，或者按 N 章一卷自动划分',
              },
              '分卷',
            )
          : null,
        view === 'tree'
          ? h('button', { type: 'button', className: 'iw-btn', style: S.iconButton, onClick: refresh, title: '重新读取' }, '刷新')
          : null,
      )

      // Settings lives at the bottom of the tree, spelled out: a bare gear in the
      // header was too easy to miss. Same row the app itself uses for 设置.
      const settingsRow = h(
        'button',
        { type: 'button', className: 'iw-settings', style: S.settingsRow, onClick: () => setView('settings'), title: '设置：智能体团队与模型' },
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

      // Every dialog in this panel is an overlay over whichever view is behind
      // it. `display: contents` keeps the wrapper out of the layout, and the
      // overlay itself is position: fixed. Keeping them in one list means a
      // fourth dialog is a row here rather than another nesting level.
      const withDialog = (element) => {
        const overlays = [
          importDir === null
            ? null
            : h(ImportDialog, {
                dir: importDir,
                sessionId,
                busy: importing,
                error: importError,
                onImport: submitImport,
                onCancel: () => {
                  setImportDir(null)
                  setImportError('')
                },
                onRepick: () => {
                  pickHostDirectory()
                    .then((picked) => {
                      if (picked !== null) setImportDir(picked)
                    })
                    .catch((failure) => setImportError(String((failure && failure.message) || failure)))
                },
              }),
          draft === null
            ? null
            : h(CreateDialog, {
                dir: draft,
                sessionId,
                busy: creating,
                error: createError,
                onCreate: submitCreate,
                onCancel: () => {
                  setDraft(null)
                  setCreateError('')
                },
                onBrowse: () => {
                  setDraft(null)
                  setCreateError('')
                  setView('new')
                },
                onRepick: () => {
                  pickHostDirectory()
                    .then((picked) => {
                      if (picked !== null) setDraft(picked)
                    })
                    .catch((failure) => setCreateError(String((failure && failure.message) || failure)))
                },
              }),
          exportFor === null
            ? null
            : h(ExportDialog, {
                book: exportFor.book,
                dir: exportDir,
                busy: exporting,
                error: exportError,
                afterDelete: exportFor.afterDelete,
                onExport: submitExport,
                onRepick: () => {
                  pickHostDirectory()
                    .then((picked) => {
                      if (picked !== null) setExportDir(picked)
                    })
                    .catch((failure) => setExportError(String((failure && failure.message) || failure)))
                },
                onCancel: () => {
                  setExportFor(null)
                  setExportError('')
                },
              }),
          volumesFor === null
            ? null
            : h(VolumesDialog, {
                book: volumesFor,
                sessionId,
                onDone: (data) => {
                  setVolumesFor(null)
                  setNotice(data.report || '分卷改好了。')
                  refresh()
                },
                onCancel: () => setVolumesFor(null),
              }),
          deleteFor === null
            ? null            : h(DeleteDialog, {
                book: deleteFor,
                busy: deleting,
                error: deleteError,
                onExportFirst: () => {
                  const book = deleteFor
                  setDeleteFor(null)
                  beginExport(book, true)
                },
                onDeleteNow: submitDelete,
                onCancel: () => {
                  setDeleteFor(null)
                  setDeleteError('')
                },
              }),
        ].filter((overlay) => overlay !== null)
        if (overlays.length === 0) return element
        return h('div', { style: { display: 'contents' } }, element, ...overlays)
      }

      if (view === 'library') {
        return withDialog(
          h(Library, {
            sessionId,
            lastRoot: root || '',
            onOpen: openBook,
            onNew: () => beginCreate('library'),
            onImport: () => beginImport('library'),
            onExport: (book) => beginExport(book, false),
            onDelete: beginDelete,
            onSettings: () => setView('settings'),
          }),
        )
      }

      if (view === 'new') {
        const suggested = state.status === 'ready' && state.data.root ? state.data.root.replace(/[\\/]\.novel[\\/]?$/, '') : ''
        return withDialog(
          h(NewBook, {
            sessionId,
            suggestedDir: suggested,
            onCancel: () => setView(returnTo),
            onCreated,
          }),
        )
      }

      if (view === 'detail' && detail !== null) {
        return withDialog(
          h(Detail, {
            sessionId,
            root: root || '',
            target: detail,
            onBack: () => setView('tree'),
            // A save can change a count (a chapter's words) or a state chip, so the
            // tree behind the page is re-read rather than left stale.
            onChanged: refresh,
          }),
        )
      }

      if (view === 'settings') {
        return withDialog(
          h(Settings, {
            root: state.status === 'ready' && state.data.root ? state.data.root : '',
            roleCount: 4,
            onBack: () => setView('library'),
            onOpenTeam: () => setView('team'),
          }),
        )
      }

      if (view === 'team') {
        return withDialog(h(Team, { sessionId, root: root || '', onBack: () => setView('settings') }))
      }

      if (state.status === 'loading') {
        return withDialog(
          h('div', { style: S.root }, header, h('div', { style: S.note }, '正在读取这一本书…')),
        )
      }
      if (state.status === 'error') {
        return withDialog(
          h(
            'div',
            { style: S.root },
            header,
            h('div', { style: S.error }, state.message || '读取失败'),
            h('div', { style: S.note }, '宿主端的面板接口没有响应。插件仍可用，novel_* 工具不受影响。'),
          ),
        )
      }

      const data = state.data
      if (!data.phase) {
        return withDialog(
          h(
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
                h('button', { type: 'button', className: 'iw-btn iw-primary', style: S.primaryButton, onClick: () => beginCreate('library') }, '选择目录新建'),
              ),
              h(
                'div',
                { style: { marginTop: '8px', opacity: 0.7 } },
                '也可以在对话里调用 novel_project（action="init"），面板会自己出现。',
              ),
            ),
            notice ? h('div', { style: S.note }, notice) : null,
            h('div', { style: S.footer }, data.root || ''),
            settingsRow,
          ),
        )
      }

      const sections = Array.isArray(data.sections) ? data.sections : []
      const progress = data.targetWords > 0 ? Math.min(1, data.words / data.targetWords) : 0

      return withDialog(
        h(
          'div',
          { style: S.root },
          header,
          notice ? h('div', { style: S.note }, notice) : null,
          sections.map((section) =>
            h(Section, {
              key: section.id,
              section,
              collapsed,
              onToggle: toggle,
              selected,
              onRowClick,
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
        ),
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
          className: 'iw-btn', style: S.iconButton,
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
      ensureStyles()

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
    // The row renderer is exported for `test/client.test.ts` only. It renders
    // without hooks, so a stub React can call it and click the result — which is
    // how the panel's one real wiring bug (a row that only highlighted instead
    // of opening its page) stays visible to CI instead of to a reader's eye.
    exports.tree = { Row, Section }
    // Same reason, for the two dialogs that can throw work away: the delete
    // question must not be answerable without the confirming checkbox, and the
    // export must not run before a folder has been chosen. Both are state the
    // stub React can render once and inspect.
    exports.dialogs = { DeleteDialog, ExportDialog, VolumesDialog }

    return module.exports
  },
})
