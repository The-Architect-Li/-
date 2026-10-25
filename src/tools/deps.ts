/** Shared plumbing for the `novel_*` tools: findings formatting and deps. */
import { resolveSessionRoot, sessionIdOf } from '../domain/scope.ts'
import { pinnedRoot, sessionsFile } from '../domain/session-books.ts'
import { ProjectStore } from '../domain/store.ts'
import type { Finding, InkwellConfig } from '../domain/types.ts'

/** Severity glyphs, matching the marks used in tool reports. */
export const MARK: Record<Finding['severity'], string> = {
  error: '✗',
  warn: '!',
  info: '·',
}

/**
 * Render findings as a bulleted report.
 *
 * @param findings - already ordered by severity.
 * @returns one line per finding, with evidence indented underneath.
 */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return '（没有发现）'
  return findings
    .map((finding) => {
      const head = `${MARK[finding.severity]} [${finding.code}] ${finding.message}`
      return finding.evidence ? `${head}\n    ${finding.evidence}` : head
    })
    .join('\n')
}

/**
 * Count findings by severity.
 *
 * @param findings - the findings to tally.
 * @returns per-severity counts.
 */
export function tally(findings: readonly Finding[]): { errors: number; warnings: number; infos: number } {
  const counts = { errors: 0, warnings: 0, infos: 0 }
  for (const finding of findings) {
    if (finding.severity === 'error') counts.errors += 1
    else if (finding.severity === 'warn') counts.warnings += 1
    else counts.infos += 1
  }
  return counts
}

/**
 * How a tool call reaches the book it is meant to edit.
 *
 * One dsh process serves several workspaces, so "the project" is not a
 * property of the process — it is a property of the session that is calling.
 * Every tool goes through {@link ToolDeps.storeFor} with the call's execution
 * context rather than closing over a single store built at apply time.
 */
export interface ToolDeps {
  /** Resolved plugin configuration. */
  config: InkwellConfig
  /**
   * Resolve the store for one call.
   *
   * @param exec - the tool execution context; the session id picks a pinned
   *   book and `agent.session.header.cwd` picks the workspace one.
   * @returns a store rooted at that session's project directory.
   */
  storeFor(exec: unknown): ProjectStore
}

/**
 * Build the deps for one plugin instance.
 *
 * Resolution order, strongest first:
 *
 * 1. the book this session pinned with `novel_project action="open"`;
 * 2. the session's own workspace (`perWorkspace`, a relative root);
 * 3. the process-wide store.
 *
 * The pin is checked before the workspace because it is the more specific
 * statement of intent: a writer who said "I am working on 雾港" outranks the
 * directory they happen to sit in.
 *
 * @param config - resolved plugin configuration.
 * @param baseStore - the store built at apply time from the process cwd.
 * @returns deps whose `storeFor` honours per-session pins and workspaces.
 */
export function createDeps(config: InkwellConfig, baseStore: ProjectStore): ToolDeps {
  return {
    config,
    storeFor: (exec) => {
      const sessionId = sessionIdOf(exec)
      if (sessionId !== undefined) {
        const pinned = pinnedRoot(sessionsFile(), sessionId)
        if (pinned !== undefined) return new ProjectStore(pinned)
      }
      return resolveSessionRoot(exec, config, baseStore)
    },
  }
}
