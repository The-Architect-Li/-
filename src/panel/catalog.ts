/**
 * What the panel can offer in its model pickers.
 *
 * The panel does not keep its own list of models: a book may be written on a
 * provider someone configured in dsh's settings half an hour ago, and a stale
 * copy would offer models that do not exist or hide the one that does. So the
 * catalog is read from the host's `llm` service — the same registry the
 * conversation itself routes through — and cached briefly because a panel that
 * polls every fifteen seconds should not re-ask three providers each time.
 *
 * Nothing here validates a request: routing accepts unlisted model ids, and the
 * catalog is advisory on purpose. A picker that refused what the host would
 * happily run would be the wrong kind of strict.
 */
import type { LlmCatalogSource } from './ports.ts'

/** One reasoning effort a model accepts, as a picker shows it. */
export interface CatalogEffort {
  id: string
  name: string
}

/** One model, with the efforts its adapter advertises. */
export interface CatalogModel {
  id: string
  name: string
  efforts: CatalogEffort[]
  defaultEffort?: string
}

/** One provider route and the models it currently advertises. */
export interface CatalogProvider {
  id: string
  name: string
  models: CatalogModel[]
}

/** How long a built catalog is reused before asking the host again. */
const CACHE_TTL_MS = 60_000

/** Upper bound on models resolved per provider, so one huge gateway stays fast. */
const MAX_MODELS_PER_PROVIDER = 80

/** Upper bound on one model's metadata lookup. */
const INFO_TIMEOUT_MS = 2500

/**
 * Race a promise against a timer.
 *
 * Model metadata is normally served from an adapter's own table, but a dynamic
 * adapter may reach for its endpoint. A picker must draw even when one provider
 * is unreachable, so a slow lookup degrades to "no efforts listed" instead of
 * holding the whole response.
 *
 * @param work - the lookup.
 * @param ms - how long to wait.
 * @returns the lookup's value, or `undefined` on timeout or failure.
 */
async function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((done) => {
    timer = setTimeout(() => done(undefined), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work.catch(() => undefined), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Read the host's provider and model catalog.
 *
 * A provider whose models cannot be listed is still reported — with an empty
 * model list — because "this provider exists but would not answer" is worth
 * showing, and dropping it would make a configured provider look absent.
 *
 * @param source - the host's `llm` service, described structurally.
 * @returns providers in registration order, models in adapter order.
 */
export async function buildCatalog(source: LlmCatalogSource): Promise<CatalogProvider[]> {
  const providers: CatalogProvider[] = []
  let listed: readonly { id: string; name: string }[] = []
  try {
    listed = source.listProviders()
  } catch {
    listed = []
  }
  for (const provider of listed) {
    const models: CatalogModel[] = []
    let advertised: readonly { id: string; name: string }[] = []
    try {
      advertised = await source.listModels(provider.id)
    } catch {
      advertised = []
    }
    for (const model of advertised.slice(0, MAX_MODELS_PER_PROVIDER)) {
      const info = await settleWithin(
        source.resolveModelInfo(provider.id, model.id).catch(() => undefined),
        INFO_TIMEOUT_MS,
      )
      const entry: CatalogModel = { id: model.id, name: model.name || model.id, efforts: [] }
      const reasoning = info?.reasoning
      if (reasoning !== undefined) {
        for (const effort of reasoning.efforts) {
          const id = String(effort.id)
          entry.efforts.push({ id, name: effort.name || id })
        }
        if (reasoning.defaultEffort !== undefined) entry.defaultEffort = String(reasoning.defaultEffort)
      }
      models.push(entry)
    }
    providers.push({ id: provider.id, name: provider.name || provider.id, models })
  }
  return providers
}

/** A catalog cache: at most one build per {@link CACHE_TTL_MS}. */
export interface CatalogCache {
  /**
   * Read the catalog, reusing a recent answer when there is one.
   *
   * @param source - the host's `llm` service.
   * @returns the catalog, or `[]` when the host exposes no llm service.
   */
  get(source: LlmCatalogSource | undefined): Promise<CatalogProvider[]>
}

/**
 * Build a catalog cache.
 *
 * Concurrent readers share one in-flight build, so a panel that fires a burst
 * of requests does not fan out into a burst of provider queries.
 *
 * @param ttl - how long an answer stays fresh.
 * @returns the cache.
 */
export function createCatalogCache(ttl: number = CACHE_TTL_MS): CatalogCache {
  let at = 0
  let cached: CatalogProvider[] | undefined
  let inFlight: Promise<CatalogProvider[]> | undefined
  return {
    async get(source) {
      if (source === undefined) return []
      const now = Date.now()
      if (cached !== undefined && now - at < ttl) return cached
      if (inFlight !== undefined) return inFlight
      inFlight = buildCatalog(source)
        .then((value) => {
          cached = value
          at = Date.now()
          return value
        })
        .catch(() => cached ?? [])
        .finally(() => {
          inFlight = undefined
        })
      return inFlight
    },
  }
}

/**
 * Pick the models one role may be routed to, for a compact picker.
 *
 * @param catalog - the full catalog.
 * @param provider - a provider id, when one is chosen.
 * @returns that provider's models, or every model when no provider is named.
 */
export function modelsOf(catalog: readonly CatalogProvider[], provider: string | undefined): CatalogModel[] {
  if (provider === undefined) return catalog.flatMap((entry) => entry.models)
  const found = catalog.find((entry) => entry.id === provider)
  return found === undefined ? [] : found.models
}

/**
 * Read the reasoning efforts a chosen route accepts.
 *
 * @param catalog - the full catalog.
 * @param provider - the provider id.
 * @param model - the model id.
 * @returns the advertised efforts, empty when the route is unknown.
 */
export function effortsOf(
  catalog: readonly CatalogProvider[],
  provider: string | undefined,
  model: string | undefined,
): CatalogEffort[] {
  if (provider === undefined || model === undefined) return []
  const found = catalog.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === model)
  return found === undefined ? [] : found.efforts
}
