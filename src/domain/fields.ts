/**
 * Tri-state field merging.
 *
 * A per-role route needs three outcomes per field, not two: "the book says
 * nothing", "the book says something", and "the book says nothing *on
 * purpose*". A merge that only knows "present" and "absent" cannot express the
 * third, so clearing one field of a route either does nothing or wipes the
 * fields beside it. Here the three states are explicit:
 *
 * - `undefined` — not mentioned; a lower layer may fill it in.
 * - a value — mentioned, and it wins.
 * - `null` — mentioned as "nothing"; lower layers stay silent.
 *
 * Pure data and pure functions, like the rest of `domain/`.
 */

/**
 * Three-state override for one field: a value, an explicit clear, or silence.
 *
 * @typeParam T - the field's value type.
 */
export type Patch<T> = T | null | undefined

/** An object whose fields may each be a value, an explicit clear, or silent. */
export type PatchOf<T extends object> = { [K in keyof T]?: Patch<T[K]> }

/**
 * Strip the explicit clears out of a patch object, leaving the values a caller
 * can actually use.
 *
 * @param patch - a partial override that may carry `null`s.
 * @returns only the fields that hold a real value.
 */
export function concrete<T extends object>(patch: PatchOf<T>): Partial<T> {
  const out: Partial<Record<keyof T, unknown>> = {}
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  // The loop above only ever copies fields that held a value.
  return out as Partial<T>
}

/**
 * Merge one field across layers ordered from weakest to strongest.
 *
 * The first layer that mentions the field decides, whether it mentions a value
 * or an explicit clear.
 *
 * @param layers - override layers, weakest first.
 * @param key - the field to read.
 * @returns the winning value, or `undefined` when every layer is silent.
 */
export function mergeField<K extends string, L extends object>(
  layers: readonly (L | undefined)[],
  key: K,
): unknown {
  for (const layer of layers) {
    // The layers are plain override records; reading one key needs no more.
    const value = (layer as Record<string, unknown> | undefined)?.[key]
    if (value === undefined) continue
    // The strongest mentioning layer decides, including an explicit clear.
    return value === null ? undefined : value
  }
  return undefined
}

/**
 * Whether any layer mentions a field at all (value or clear).
 *
 * @param layers - override layers, weakest first.
 * @param key - the field to read.
 * @returns true when at least one layer names the field.
 */
export function mentioned<K extends string, L extends object>(
  layers: readonly (L | undefined)[],
  key: K,
): boolean {
  return layers.some((layer) => (layer as Record<string, unknown> | undefined)?.[key] !== undefined)
}
