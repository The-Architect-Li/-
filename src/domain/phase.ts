/**
 * The phase machine.
 *
 * A phase is only reachable when its requirements are met by data on disk, not
 * by the model asserting it is ready. Every requirement is a boolean computed
 * from the snapshot, so the refusal message can name exactly what is missing.
 */
import type { InkwellConfig, Phase, Snapshot } from './types.ts'
import { PHASES } from './types.ts'
import { countChars } from './text.ts'

/** One checkable precondition. */
export interface Requirement {
  /** What the writer must do, phrased as an instruction. */
  label: string
  ok: boolean
}

/** Where the machine goes after `current`, or `null` at the end. */
export function nextPhase(current: Phase): Phase | null {
  const index = PHASES.indexOf(current)
  if (index < 0 || index === PHASES.length - 1) return null
  return PHASES[index + 1] ?? null
}

/** Monotonic comparison; `true` when `phase` is at or past `at`. */
export function atLeast(phase: Phase, at: Phase): boolean {
  return PHASES.indexOf(phase) >= PHASES.indexOf(at)
}

/** Requirements that must hold before entering `target`. */
export function requirementsFor(
  target: Phase,
  snapshot: Snapshot,
  config: InkwellConfig,
): Requirement[] {
  switch (target) {
    case 'premise':
      return [{ label: '项目已初始化', ok: true }]
    case 'canon': {
      const length = countChars(snapshot.project.premise)
      return [
        {
          label: `一句话前提至少 ${config.premiseMinChars} 字（当前 ${length} 字）`,
          ok: length >= config.premiseMinChars,
        },
      ]
    }
    case 'outline': {
      const protagonists = snapshot.characters.filter((item) => item.role === 'protagonist')
      return [
        { label: '至少 1 个主角（role=protagonist）', ok: protagonists.length >= 1 },
        { label: '至少 2 个角色', ok: snapshot.characters.length >= 2 },
        { label: '至少 1 条世界观设定', ok: snapshot.world.length >= 1 },
        {
          label: '每个角色都写了说话方式（voice），避免千人一腔',
          ok: snapshot.characters.length > 0 && snapshot.characters.every((item) => item.voice.trim() !== ''),
        },
      ]
    }
    case 'drafting': {
      const approved = snapshot.volumes.filter((item) => item.approved)
      const canonNames = new Set(snapshot.characters.map((item) => item.name))
      const unknown = snapshot.plans.filter((plan) =>
        plan.characters.some((name) => !canonNames.has(name)),
      )
      return [
        { label: '至少 1 个已批准的分卷大纲', ok: approved.length >= 1 },
        { label: '至少 1 个章纲', ok: snapshot.plans.length >= 1 },
        {
          label: '每个章纲至少 2 个必写节拍（beats）',
          ok: snapshot.plans.length > 0 && snapshot.plans.every((plan) => plan.beats.length >= 2),
        },
        {
          label: unknown.length === 0
            ? '章纲里的人物都在角色卡中'
            : `以下章纲引用了不存在的角色：${unknown.map((plan) => `第${plan.number}章(${plan.characters.join('、')})`).join('，')}`,
          ok: unknown.length === 0,
        },
      ]
    }
    case 'review': {
      const written = new Set(snapshot.chapters.map((item) => item.number))
      const unwritten = snapshot.plans.filter((plan) => !written.has(plan.number))
      return [
        { label: '至少写完 1 章', ok: snapshot.chapters.length >= 1 },
        {
          label: unwritten.length === 0
            ? '所有章纲都已落笔'
            : `还有 ${unwritten.length} 章只有章纲：第 ${unwritten.map((plan) => plan.number).join('、')} 章`,
          ok: unwritten.length === 0,
        },
      ]
    }
    case 'done':
      return [{ label: '进入收尾', ok: snapshot.chapters.length >= 1 }]
  }
}

/** Blocking labels for a target phase. Empty means the gate is open. */
export function blockersFor(
  target: Phase,
  snapshot: Snapshot,
  config: InkwellConfig,
): string[] {
  return requirementsFor(target, snapshot, config)
    .filter((item) => !item.ok)
    .map((item) => item.label)
}

/** Whether the project may enter `target` right now. */
export function canEnter(
  target: Phase,
  snapshot: Snapshot,
  config: InkwellConfig,
): { ok: boolean; blockers: string[] } {
  const blockers = blockersFor(target, snapshot, config)
  return { ok: blockers.length === 0, blockers }
}

/**
 * Evaluate a forward move. Returns the phase to enter on success, or the
 * blockers that stop it. Side-effect free: the caller persists.
 */
export function evaluateAdvance(
  snapshot: Snapshot,
  config: InkwellConfig,
): { next: Phase | null; ok: boolean; blockers: string[]; done: boolean } {
  const next = nextPhase(snapshot.project.phase)
  if (!next) return { next: null, ok: false, blockers: [], done: true }
  const { ok, blockers } = canEnter(next, snapshot, config)
  return { next, ok, blockers, done: false }
}
