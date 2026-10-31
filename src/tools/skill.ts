/** `novel_skill`: the book's own notes on how it wants to be written. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SKILL_MAX_CHARS, deleteSkill, listSkills, readSkill, writeSkill } from '../domain/skills.ts'
import type { ToolDeps } from './deps.ts'

/**
 * Register the skill-note tool.
 *
 * Notes are not canon and not outline: they are the author's craft rules for
 * this book ("开场三句之内必须有问题", "对话里不写「说道」"). Keeping them in the
 * book instead of a prompt means they survive the session, can be edited by hand,
 * and can be quoted by whoever is writing.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerSkillTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_skill',
    description:
      '这本书自己的写作手法笔记：开篇钩子怎么下、对话什么节奏、打斗怎么调度这类「怎么写」的规则。list 列出全部；read 读一篇；write 写一篇（覆盖前会自动留一版，能退回去）；delete 删一篇。笔记和人物、世界观分开存，因为它们不是世界里的东西，是写这个世界的手法。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'read', 'write', 'delete'],
        description: 'list 列表 / read 读 / write 写 / delete 删',
      },
      name: { type: 'string', description: '笔记名，例如「开篇钩子」。read/write/delete 需要' },
      text: { type: 'string', description: 'write 时的全文（Markdown）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skills: { type: 'array', items: { type: 'string' } },
          name: { type: 'string' },
          text: { type: 'string' },
          chars: { type: 'number' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec): Promise<Record<string, unknown>> {
      const store = deps.storeFor(exec)
      if (!(await store.exists())) throw new Error(`这里还不是一本书：${store.root}。`)

      if (args.action === 'list') {
        const notes = await listSkills(store.root)
        const lines =
          notes.length === 0
            ? ['这本书还没有写作笔记。用 novel_skill action="write" 写第一篇，比如「开篇钩子」。']
            : [
                `共 ${notes.length} 篇写作笔记：`,
                '',
                ...notes.map((note) => `- ${note.name}｜${note.title}｜${note.chars} 字`),
                '',
                '写正文前读一遍相关的几篇；它们说的是这本书的手法，不是通用建议。',
              ]
        return {
          skills: notes.map((note) => note.name),
          name: '',
          text: '',
          chars: notes.reduce((sum, note) => sum + note.chars, 0),
          report: lines.join('\n'),
        }
      }

      const name = (args.name ?? '').trim()
      if (name === '') throw new Error(`${args.action} 需要 name。先 novel_skill action="list" 看看有哪些。`)

      if (args.action === 'read') {
        const text = await readSkill(store.root, name)
        if (text === undefined) {
          const notes = await listSkills(store.root)
          const known = notes.length === 0 ? '这本书还没有任何笔记。' : `现有：${notes.map((note) => note.name).join('、')}。`
          throw new Error(`没有「${name}」这篇。${known}`)
        }
        return { skills: [], name, text, chars: text.length, report: text }
      }

      if (args.action === 'write') {
        const text = String(args.text ?? '')
        if (text.trim() === '') throw new Error('write 需要 text，而且不能是空的。')
        const saved = await writeSkill(store.root, name, text)
        return {
          skills: (await listSkills(store.root)).map((note) => note.name),
          name: saved.name,
          text: '',
          chars: saved.chars,
          report: [
            `写好了「${saved.name}」（${saved.chars} 字，上限 ${SKILL_MAX_CHARS}）。`,
            '上一版留在历史里：novel_backup action="history" target="skill:' + saved.name + '" 能看到，revert 能退回去。',
          ].join('\n'),
        }
      }

      const removed = await deleteSkill(store.root, name)
      if (!removed) throw new Error(`没有「${name}」这篇，删不了。`)
      return {
        skills: (await listSkills(store.root)).map((note) => note.name),
        name,
        text: '',
        chars: 0,
        report: `删掉了「${name}」。删之前那一版还在历史里，novel_backup action="history" 可以找回来。`,
      }
    },
  }))
}
