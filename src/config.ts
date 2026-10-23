/**
 * Configuration surface.
 *
 * Every deployment-varying choice is a validated field here rather than a
 * constant in the code, so a project can tighten its own gates from
 * `cordis.yml` without forking the plugin.
 */
import z from '@deepseek-ai/schemastery'
import type { InkwellConfig } from './domain/types.ts'

/** Default stock phrases. Overridable per project: this list is taste, not truth. */
export const DEFAULT_AI_TONE_WORDS: string[] = [
  '仿佛', '似乎', '犹如', '如同', '不禁', '忍不住', '不由自主', '下意识',
  '微微', '缓缓', '轻轻', '淡淡', '默默', '静静',
  '深吸一口气', '嘴角勾起', '嘴角上扬', '眼中闪过', '眼中闪过一丝', '心中一凛',
  '瞳孔骤缩', '难以置信', '不可置信', '若有所思', '意味深长', '缓缓开口',
  '空气仿佛凝固', '时间仿佛静止', '空气凝固', '气氛变得', '空气中弥漫',
  '莫名', '一丝', '一抹', '一缕', '某种意义', '在这一刻', '这一刻',
  '总而言之', '值得注意的是', '不仅仅是', '某种程度上',
]

/** Fully-defaulted configuration. The single source of runtime truth. */
export const DEFAULTS: InkwellConfig = {
  root: '.novel',
  premiseMinChars: 80,
  briefingBudgetChars: 6000,
  briefingTailChars: 800,
  briefingLookback: 5,
  chapterMinWords: 1800,
  chapterMaxWords: 4200,
  repeatShingleSize: 8,
  repeatWarnRatio: 0.06,
  repeatErrorRatio: 0.15,
  openingRepeatMin: 3,
  rhythmStdRatioWarn: 0.32,
  dialogueMinRatio: 0.12,
  aiToneWarnPer1000: 2,
  aiToneWords: DEFAULT_AI_TONE_WORDS,
  beatCoverageMin: 0.4,
  roles: {},
  perWorkspace: true,
}

/**
 * Fill defaults and clamp impossible combinations.
 *
 * @param input - raw configuration, typically from `cordis.yml`.
 * @returns a complete configuration that every domain function can assume.
 */
export function resolveConfig(input: Partial<InkwellConfig> = {}): InkwellConfig {
  const merged: InkwellConfig = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as (keyof InkwellConfig)[]) {
    const value = input[key]
    if (value !== undefined && value !== null) {
      // The key/value pairing is preserved from the defaults above.
      ;(merged as unknown as Record<string, unknown>)[key] = value
    }
  }

  merged.briefingBudgetChars = Math.max(800, merged.briefingBudgetChars)
  merged.briefingTailChars = Math.min(merged.briefingTailChars, merged.briefingBudgetChars)
  merged.chapterMinWords = Math.max(100, merged.chapterMinWords)
  merged.chapterMaxWords = Math.max(merged.chapterMinWords + 100, merged.chapterMaxWords)
  merged.repeatShingleSize = Math.max(3, merged.repeatShingleSize)
  merged.repeatErrorRatio = Math.max(merged.repeatWarnRatio, merged.repeatErrorRatio)
  merged.aiToneWords = merged.aiToneWords.filter((word) => word.trim() !== '')
  return merged
}

/**
 * One role's global default route.
 *
 * Every field is optional, so a config file can pin just the model and let the
 * rest inherit. `reasoningEffort` is a free-form string on purpose: which
 * values are legal is decided by the provider adapter, not by this plugin.
 */
const RouteSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number(),
    reasoningEffort: z.string(),
  })
  .default({})

/** Loader-facing schema. Mirrors {@link DEFAULTS}. */
export const Config = z.object({
  root: z.string().default(DEFAULTS.root),
  premiseMinChars: z.natural().default(DEFAULTS.premiseMinChars),
  briefingBudgetChars: z.natural().default(DEFAULTS.briefingBudgetChars),
  briefingTailChars: z.natural().default(DEFAULTS.briefingTailChars),
  briefingLookback: z.natural().default(DEFAULTS.briefingLookback),
  chapterMinWords: z.natural().default(DEFAULTS.chapterMinWords),
  chapterMaxWords: z.natural().default(DEFAULTS.chapterMaxWords),
  repeatShingleSize: z.natural().default(DEFAULTS.repeatShingleSize),
  repeatWarnRatio: z.number().default(DEFAULTS.repeatWarnRatio),
  repeatErrorRatio: z.number().default(DEFAULTS.repeatErrorRatio),
  openingRepeatMin: z.natural().default(DEFAULTS.openingRepeatMin),
  rhythmStdRatioWarn: z.number().default(DEFAULTS.rhythmStdRatioWarn),
  dialogueMinRatio: z.number().default(DEFAULTS.dialogueMinRatio),
  aiToneWarnPer1000: z.number().default(DEFAULTS.aiToneWarnPer1000),
  aiToneWords: z.array(z.string()).default(DEFAULTS.aiToneWords),
  beatCoverageMin: z.number().default(DEFAULTS.beatCoverageMin),
  roles: z
    .object({
      writer: RouteSchema,
      logic: RouteSchema,
      character: RouteSchema,
      chief: RouteSchema,
    })
    .default({}),
  perWorkspace: z.boolean().default(DEFAULTS.perWorkspace),
})
