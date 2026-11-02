/**
 * What to do next, in one line.
 *
 * A preset can tell the model what this tool is for. It cannot tell it what this
 * book is missing right now — that is state, and state changes every chapter. The
 * result is a chat that knows it is helping with a novel and still asks 「你想做
 * 什么」, because nothing told it that chapter eight has a card, no prose, and an
 * approved outline.
 *
 * So this module answers the question the author actually has, and answers it with
 * a command that is ready to run: the chapter number is filled in, the action name
 * is right, and there is one of them. Two suggestions is a question; one is an
 * answer.
 *
 * The order below is the order work actually happens in, not the order the tools
 * happen to be numbered: a book cannot be drafted before its premise, cannot be
 * reviewed before it is written, and cannot be summarised before it exists.
 */
import type { Snapshot } from './types.ts'
import type { PendingItem } from './pending.ts'

/** One thing to do. */
export interface NextStep {
  /** The command to run, ready as typed. */
  command: string
  /** Why this one, in one sentence. */
  why: string
  /** Anything worth knowing that is not urgent enough to be the answer. */
  notes: string[]
}

/**
 * The single next thing.
 *
 * @param snapshot - the book.
 * @param pending - the review queue, for the trailing note.
 * @returns one command, why, and what else is worth a glance.
 */
export function nextStep(snapshot: Snapshot, pending: readonly PendingItem[] = []): NextStep {
  const notes: string[] = []
  if (pending.length > 0) notes.push(`待审队列里还有 ${pending.length} 条提案：novel_pending action="list"`)

  const phase = snapshot.project.phase
  const premise = snapshot.project.premise.trim()

  if (premise === '') {
    // A book can already have five hundred chapters and no premise — that is
    // exactly what importing does. Saying 「还没有前提」 to somebody who has just
    // written 1.2 million characters reads like a misfiled complaint, so the
    // sentence acknowledges the prose and says what the line is *for*.
    const already = snapshot.chapters.length
    return {
      command: 'novel_project action="premise" premise="一句话说清这本书：谁、想要什么、被什么挡住"',
      why:
        already === 0
          ? '还没有前提。后面所有判断都要拿它当尺子，先写这一句。'
          : `书里已经有 ${already} 章正文，但缺这一句。它是每次派发时上下文包的开头——没有它，写手和审核只能靠正文自己猜这本书在讲什么。`,
      notes,
    }
  }

  if (phase === 'premise') {
    return {
      command: 'novel_project action="advance"',
      why: `前提已经写了 ${premise.length} 字，够进下一阶段了。`,
      notes,
    }
  }

  if (phase === 'canon') {
    const missing: string[] = []
    if (snapshot.characters.length === 0) missing.push('角色')
    if (snapshot.world.length === 0) missing.push('世界观')
    if (snapshot.places.length === 0) missing.push('地点')
    return {
      command:
        snapshot.characters.length === 0
          ? 'novel_canon action="upsert_character" name="主角名" role="protagonist" voice="他怎么说话"'
          : 'novel_canon action="upsert_world" name="地名或设定名" kind="地点" detail="它是什么样"',
      why:
        missing.length > 0
          ? `还缺${missing.join('、')}。没有这些，写出来的正文没人能核对。`
          : '设定够用了，可以搭大纲。',
      notes,
    }
  }

  if (phase === 'outline') {
    if (snapshot.volumes.length === 0) {
      return {
        command: 'novel_outline action="add_volume" number=1 title="第一卷的名字"',
        why: '还没有分卷。先有卷，章节才有地方挂。',
        notes,
      }
    }
    const unapproved = snapshot.volumes.filter((volume) => !volume.approved)
    if (unapproved.length > 0) {
      return {
        command: `novel_outline action="approve_volume" number=${unapproved[0]!.number}`,
        why: `第${unapproved[0]!.number}卷还没批准，没批准的分卷挡着章节。`,
        notes,
      }
    }
    return {
      command: 'novel_outline action="add_chapter" number=1 pov="视角人物" beats=["第一件","第二件","第三件"]',
      why:
        snapshot.plans.length === 0
          ? '分卷齐了，但一张章卡都没有。'
          : `已经有 ${snapshot.plans.length} 张章卡，接着往下搭。`,
      notes,
    }
  }

  // Drafting and beyond: the interesting states start here.
  const written = new Set(snapshot.chapters.map((chapter) => chapter.number))

  if (pending.length > 0) {
    return {
      command: 'novel_pending action="approve" all=true',
      why: `状态维护员提了 ${pending.length} 条该记的东西，还没写进书里。`,
      notes: ['想先看再收：novel_pending action="list"'],
    }
  }

  const approvedNoProse = snapshot.plans
    .filter((plan) => plan.approved && !written.has(plan.number))
    .sort((a, b) => a.number - b.number)
  if (approvedNoProse.length > 0) {
    const target = approvedNoProse[0]!
    return {
      command: `novel_dispatch action="round" number=${target.number}`,
      why: `第${target.number}章《${target.title}》有章纲、还没正文。一条命令写完并过三份审核。`,
      notes: [
        ...(approvedNoProse.length > 1 ? [`后面还有 ${approvedNoProse.length - 1} 章同样待写。`] : []),
        ...notes,
      ],
    }
  }

  const blocked = snapshot.plans
    .filter((plan) => !plan.approved && !written.has(plan.number))
    .sort((a, b) => a.number - b.number)
  if (blocked.length > 0) {
    const target = blocked[0]!
    return {
      command: `novel_outline action="approve_chapter" number=${target.number}`,
      why: `第${target.number}章有章卡但没批准，没批准就写不了正文。`,
      notes,
    }
  }

  if (written.size > 0 && snapshot.plans.length < written.size) {
    const missing = written.size - snapshot.plans.length
    return {
      command: 'novel_archive action="plan"',
      why: `有 ${missing} 章正文没有章卡。没有卡，前情提要和出场统计都是空的。`,
      notes: ['先看缺口：novel_archive action="plan"，再分批 novel_archive action="apply" from=1 limit=8', ...notes],
    }
  }

  const last = snapshot.chapters.reduce((max, chapter) => Math.max(max, chapter.number), 0)
  return {
    command: `novel_outline action="add_chapter" number=${last + 1} pov="视角人物" beats=["第一件","第二件"]`,
    why: `前面都齐了，最后一章是第${last}章。搭下一章的卡，然后 novel_dispatch action="round" number=${last + 1}。`,
    notes,
  }
}
