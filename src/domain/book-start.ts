/**
 * The book's start date: one date, stored on the book, not on a chapter.
 *
 * Every anchor says "chapter N happened in Y-M". The start says nothing about any
 * chapter — it says where the rail begins, so 「2020年10月，然后每年一个点」 is a
 * setting rather than an inference from whichever chapter happened to be dated
 * first. Both the tool and the panel go through this function: a pinned start the
 * panel can set but the tool cannot (or the reverse) is two rules for one fact.
 */
import { ClockFormatError, parseWhen } from './clock.ts'
import type { ProjectStore } from './store.ts'

/**
 * Pin the book's start, or clear it.
 *
 * @param store - the project.
 * @param when - `2020`, `2020-10` or `2020-10-05`; an empty string clears the pin.
 * @returns the pinned value, or `undefined` when it was cleared.
 * @throws ClockFormatError when the date cannot be read — never stores a guess.
 */
export async function setBookStart(store: ProjectStore, when: string): Promise<string | undefined> {
  const trimmed = when.trim()
  if (trimmed !== '') {
    try {
      parseWhen(trimmed)
    } catch (error) {
      throw new Error((error as ClockFormatError).message)
    }
  }
  const project = await store.readProject()
  if (trimmed === '') {
    const { bookStart: _dropped, ...rest } = project
    await store.writeProject(rest)
    return undefined
  }
  await store.writeProject({ ...project, bookStart: trimmed })
  return trimmed
}
