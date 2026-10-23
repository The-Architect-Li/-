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
 * The header button and the guide capsule are the two ways a writer finds it.
 *
 * DATA. The body cannot read `.novel/` — there is no browser filesystem — so it
 * fetches `/api/inkwell/snapshot?session=<id>` from this plugin's host half
 * (`src/panel/serve.ts`). The route resolves the book from the *session's* cwd,
 * so the panel in workspace A never reports workspace B's manuscript.
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

    /** The host route this panel reads (`src/panel/serve.ts`, `PANEL_PREFIX`). */
    const API = '/api/inkwell/snapshot'

    /** Chip and guide copy. */
    const LABEL = '小说工坊'

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

    /** Severity glyphs, matching the tool reports. */
    const MARK = { error: '✗', warn: '!', info: '·' }

    /**
     * Format a number with thousands separators.
     * @param n - the number, possibly `NaN` before the first load.
     * @returns the formatted string.
     */
    function num(n) {
      return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0'
    }

    /**
     * Read the panel payload for one session.
     * @param sessionId - the calling session, which decides the book.
     * @param signal - aborts the request when the tab hides or unmounts.
     * @returns the payload, or throws with the host's message.
     */
    async function loadPanel(sessionId, signal) {
      const url = sessionId ? `${API}?session=${encodeURIComponent(sessionId)}` : API
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${response.status}`)
      }
      return payload.data
    }

    /** Shared inline styles: one object per role, spread at use sites. */
    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 14px 18px',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'inherit',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      },
      title: {
        fontWeight: 600,
        fontSize: '13px',
        flex: '1 1 auto',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      iconButton: {
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        font: 'inherit',
        fontSize: '11px',
        padding: '2px 8px',
        cursor: 'pointer',
        lineHeight: 1.6,
      },
      badge: {
        border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
        borderRadius: '999px',
        padding: '1px 8px',
        fontSize: '11px',
        whiteSpace: 'nowrap',
      },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      sectionHead: {
        fontSize: '11px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        opacity: 0.55,
        display: 'flex',
        alignItems: 'baseline',
        gap: '6px',
      },
      bar: {
        height: '4px',
        borderRadius: '999px',
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        overflow: 'hidden',
      },
      barFill: {
        height: '100%',
        borderRadius: '999px',
        background: 'currentColor',
        opacity: 0.55,
      },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '6px',
        padding: '3px 0',
        borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      },
      rowName: {
        flex: '1 1 auto',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      dim: { opacity: 0.55, whiteSpace: 'nowrap' },
      dot: { fontSize: '11px', width: '10px', textAlign: 'center', opacity: 0.8 },
      note: {
        border: '1px dashed color-mix(in srgb, currentColor 22%, transparent)',
        borderRadius: '8px',
        padding: '10px 12px',
        opacity: 0.75,
      },
      blocker: {
        display: 'flex',
        gap: '6px',
        alignItems: 'baseline',
      },
      footer: {
        marginTop: 'auto',
        paddingTop: '8px',
        fontSize: '10.5px',
        opacity: 0.45,
        wordBreak: 'break-all',
      },
      error: {
        border: '1px solid color-mix(in srgb, #d9534f 45%, transparent)',
        color: '#d9534f',
        borderRadius: '8px',
        padding: '8px 10px',
        whiteSpace: 'pre-wrap',
      },
    }

    /**
     * One section heading, with an optional trailing count.
     * @param props - children and the trailing text.
     * @returns the heading element.
     */
    function SectionHead({ children, tail }) {
      return h('div', { style: S.sectionHead }, h('span', null, children), tail ? h('span', { style: S.dim }, tail) : null)
    }

    /**
     * The word-count progress line.
     * @param props - written and target counts.
     * @returns the progress block.
     */
    function Progress({ words, target }) {
      const ratio = target > 0 ? Math.min(1, words / target) : 0
      return h(
        'div',
        { style: S.section },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
          h('span', { style: { fontWeight: 500 } }, `${num(words)} 字`),
          h('span', { style: S.dim }, target > 0 ? `/ ${num(target)}（${Math.round(ratio * 100)}%）` : '未设目标'),
        ),
        h('div', { style: S.bar }, h('div', { style: { ...S.barFill, width: `${Math.round(ratio * 100)}%` } })),
      )
    }

    /**
     * One chapter row: number, title, state, counts.
     * @param props - the row's data.
     * @returns the row element.
     */
    function ChapterRow({ chapter }) {
      const state = chapter.written
        ? chapter.errors > 0
          ? { glyph: MARK.error, hint: `${chapter.errors} 处必改` }
          : { glyph: '✓', hint: '已写' }
        : chapter.approved
          ? { glyph: '▸', hint: '可写' }
          : chapter.drafts > 0
            ? { glyph: MARK.info, hint: `${chapter.drafts} 稿待定` }
            : { glyph: '·', hint: chapter.title ? '待批准' : '待规划' }
      const tail = []
      if (chapter.written) tail.push(`${num(chapter.words)} 字`)
      if (!chapter.written && chapter.drafts > 0) tail.push(`${chapter.drafts} 稿`)
      return h(
        'div',
        { style: S.row, title: `${state.hint}${chapter.title ? ` · ${chapter.title}` : ''}` },
        h('span', { style: S.dot }, state.glyph),
        h('span', { style: S.rowName }, `第${chapter.number}章${chapter.title ? ` ${chapter.title}` : ''}`),
        tail.length > 0 ? h('span', { style: S.dim }, tail.join(' · ')) : null,
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
      const [state, setState] = useState({ status: 'loading' })
      const [tick, setTick] = useState(0)
      const abortRef = useRef(undefined)

      const refresh = useCallback(() => setTick((n) => n + 1), [])

      useEffect(() => {
        if (!visible) return undefined
        const controller = new AbortController()
        abortRef.current = controller
        setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }))
        loadPanel(sessionId, controller.signal)
          .then((data) => {
            if (!controller.signal.aborted) setState({ status: 'ready', data })
          })
          .catch((error) => {
            if (error && error.name === 'AbortError') return
            if (!controller.signal.aborted) setState({ status: 'error', message: String(error && error.message) })
          })
        return () => controller.abort()
      }, [sessionId, tick, visible])

      useEffect(() => {
        if (!visible) return undefined
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [visible, refresh])

      const header = h(
        'div',
        { style: S.header },
        h('span', { style: S.title }, LABEL),
        state.status === 'ready' && state.data.phase
          ? h('span', { style: S.badge }, PHASE_LABEL[state.data.phase] || state.data.phase)
          : null,
        h('button', { type: 'button', style: S.iconButton, onClick: refresh, title: '重新读取' }, '刷新'),
      )

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
          h('div', { style: S.note }, '这个工作区还没有书。'),
          h(
            'div',
            { style: S.dim },
            '在对话里调用 novel_project（action="init"）建立项目，面板会自己出现。',
          ),
          h('div', { style: S.footer }, data.root || ''),
        )
      }

      const findingsSummary = data.chapters.reduce(
        (acc, chapter) => ({ errors: acc.errors + chapter.errors, warnings: acc.warnings + chapter.warnings }),
        { errors: 0, warnings: 0 },
      )

      return h(
        'div',
        { style: S.root },
        header,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
          h('span', { style: { fontWeight: 600, fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `《${data.title}》`),
          data.next ? h('span', { style: S.dim }, `→ ${PHASE_LABEL[data.next] || data.next}`) : null,
        ),

        h(Progress, { words: data.words, target: data.targetWords }),

        data.blockers.length > 0
          ? h(
              'div',
              { style: S.section },
              h(SectionHead, { tail: `${data.blockers.length} 项` }, '进入下一阶段还缺'),
              ...data.blockers.slice(0, 6).map((line, index) =>
                h('div', { key: `b${index}`, style: S.blocker }, h('span', { style: S.dot }, MARK.info), h('span', null, line)),
              ),
            )
          : null,

        h(
          'div',
          { style: S.section },
          h(
            SectionHead,
            { tail: `已写 ${data.written} · 章纲 ${data.approved}/${data.planned}` },
            '章',
          ),
          data.chapters.length === 0
            ? h('div', { style: S.dim }, '还没有章纲。')
            : h('div', null, ...data.chapters.slice(0, 40).map((chapter) => h(ChapterRow, { key: chapter.number, chapter }))),
        ),

        findingsSummary.errors + findingsSummary.warnings > 0
          ? h(
              'div',
              { style: S.section },
              h(SectionHead, null, '草稿自带体检'),
              h(
                'div',
                { style: { display: 'flex', gap: '10px' } },
                h('span', null, `${MARK.error} ${findingsSummary.errors} 必改`),
                h('span', null, `${MARK.warn} ${findingsSummary.warnings} 建议`),
              ),
            )
          : null,

        h(
          'div',
          { style: S.section },
          h(SectionHead, { tail: data.retired > 0 ? `${data.facts.length} 条在册 · ${data.retired} 条作废` : `${data.facts.length} 条` }, '已确立事实'),
          data.facts.length === 0
            ? h('div', { style: S.dim }, '账本还是空的。')
            : h(
                'div',
                null,
                ...data.facts
                  .slice(-4)
                  .reverse()
                  .map((fact) =>
                    h(
                      'div',
                      { key: fact.id, style: S.row, title: `第${fact.chapter}章 · ${fact.id}` },
                      h('span', { style: S.rowName }, `${fact.subject}·${fact.predicate}＝${fact.value}`),
                    ),
                  ),
              ),
        ),

        h(
          'div',
          { style: { display: 'flex', gap: '10px' } },
          h('span', { style: S.dim }, `人物 ${data.characterCount}`),
          h('span', { style: S.dim }, `世界观 ${data.worldCount}`),
          h('span', { style: S.dim }, `分卷 ${data.volumeCount}`),
        ),

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
            description: () => '这一本书的阶段、章纲、草稿体检与已确立事实',
          },
        ],
      }
    }

    /**
     * Client plugin body.
     * @param ctx - client root context, carrying the slot registry and the right Sidebar.
     */
    function apply(ctx) {
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
