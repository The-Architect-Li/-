/**
 * The categories a book keeps its world in.
 *
 * There is no fixed list on purpose. A 修仙 book files its entries under 宗门,
 * 功法 and 境界; a 都市 book under 公司 and 街区; a mystery under 案件 and 势力.
 * Any list written in code would fit one genre and misfile every other, so the
 * categories are whatever the author typed — which means they also drift:
 * 宗门 and 门派 grow side by side, a typo creates a category with one member,
 * and 规则 slowly absorbs things that are really 境界.
 *
 * This module is the way back: one operation that moves every entry of one
 * category to another. Renaming and merging are the same write, which is why
 * they are one function.
 */
import type { ProjectStore } from './store.ts'
import type { WorldEntry } from './types.ts'

/** What a world entry falls under when its author never said. */
export const UNFILED_KIND = '未分类'

/**
 * The category one entry belongs to.
 *
 * @param entry - a world entry.
 * @returns its category, or {@link UNFILED_KIND} when blank.
 */
export function kindOf(entry: WorldEntry): string {
  const kind = entry.kind.trim()
  return kind === '' ? UNFILED_KIND : kind
}

/**
 * Move every entry of one category to another.
 *
 * Written as a single canon write rather than one update per entry: the whole
 * point is that the drawer stops showing two categories where the author meant
 * one, and twelve separate writes would leave twelve history entries describing
 * a change that was one decision.
 *
 * Renaming to {@link UNFILED_KIND} clears the field instead of storing the word
 * — an entry with no category and an entry whose category is the string
 * 「未分类」 would otherwise read the same and sort differently.
 *
 * @param store - the book.
 * @param from - the category being emptied.
 * @param to - the category that receives its entries.
 * @returns how many entries moved, and where they went.
 */
export async function renameWorldKind(
  store: ProjectStore,
  from: string,
  to: string,
): Promise<{ moved: number; to: string }> {
  const target = to.trim()
  if (target === '') throw new Error('新类别名不能为空。')
  const entries = await store.world()
  const next: WorldEntry[] = []
  let moved = 0
  for (const entry of entries) {
    if (kindOf(entry) !== from) {
      next.push(entry)
      continue
    }
    moved += 1
    next.push({
      ...entry,
      kind: target === UNFILED_KIND ? '' : target,
      updatedAt: new Date().toISOString(),
    })
  }
  if (moved === 0) return { moved: 0, to: target }
  await store.writeCanonRaw('world', JSON.stringify(next, null, 2))
  return { moved, to: target }
}
