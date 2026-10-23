/** Shared tool dependencies and formatting helpers. */
import type { Finding, InkwellConfig } from '../domain/types.ts'
import type { ProjectStore } from '../domain/store.ts'

/** What every tool registration receives. */
export interface ToolDeps {
  store: ProjectStore
  config: InkwellConfig
}

const MARK: Record<Finding['severity'], string> = {
  error: '✗',
  warn: '!',
  info: '·',
}

/**
 * Render findings as a compact list the model can act on.
 *
 * @param findings - scanner output.
 * @returns one line per finding, or an empty string.
 */
export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return ''
  return findings
    .map((finding) => `${MARK[finding.severity]} [${finding.code}] ${finding.message}${finding.evidence ? `\n    ${finding.evidence}` : ''}`)
    .join('\n')
}

/** Count findings by severity. */
export function tally(findings: Finding[]): { errors: number; warnings: number; infos: number } {
  return {
    errors: findings.filter((item) => item.severity === 'error').length,
    warnings: findings.filter((item) => item.severity === 'warn').length,
    infos: findings.filter((item) => item.severity === 'info').length,
  }
}
