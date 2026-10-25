/**
 * Keep every test's plugin state inside a scratch directory.
 *
 * The plugin writes the shelf (`<DSH_HOME>/inkwell/books.json`) and session pins
 * (`sessions.json`) on ordinary reads and writes. Tests build books in `%TEMP%`
 * and then exercise those routes, so without this the suite appends a few dozen
 * `inkwell-XXXX` rows to the shelf of whoever ran it — pushing their real books
 * off the forty-row shelf. That happened once; this file is why it cannot again.
 *
 * Set before any test module loads, since `dshHome()` reads the environment at
 * call time but a `beforeAll` in one file would still race the others.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'inkwell-home-'))
