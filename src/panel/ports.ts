/**
 * Narrow, structural views of the host services the panel talks to.
 *
 * The panel takes no build-time dependency on `@deepseek-ai/dsh-llm`: a dsh
 * older than the service simply has no `llm` in its context, and the panel then
 * shows the book without a model picker. Describing the two methods actually
 * used keeps that degradation honest and keeps the tests free of host types.
 */

/** A provider route as the host reports it. */
export interface HostProvider {
  id: string
  name: string
}

/** A model as one provider advertises it. */
export interface HostModel {
  id: string
  name: string
}

/** One reasoning effort, as an adapter reports it. */
export interface HostEffort {
  id: string
  name: string
}

/** The reasoning metadata a model may carry. */
export interface HostReasoning {
  efforts: readonly HostEffort[]
  defaultEffort?: unknown
}

/** What `resolveModelInfo` answers, cut down to the reasoning block. */
export interface HostModelInfo {
  reasoning?: HostReasoning | undefined
}

/**
 * The slice of the host's `llm` runtime the panel uses.
 *
 * `LlmRuntime` satisfies this structurally; so does a two-method fake.
 */
export interface LlmCatalogSource {
  /** Every provider route with a registered adapter. */
  listProviders(): readonly HostProvider[]
  /** The models one provider advertises; may reject for a dead endpoint. */
  listModels(provider: string): Promise<readonly HostModel[]>
  /** Exact-model metadata, including whether the route accepts efforts. */
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<HostModelInfo>
}
