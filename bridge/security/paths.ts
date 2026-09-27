/**
 * Filesystem containment for tools that touch files.
 *
 * A path is judged only after symlinks are resolved: `notes.txt` inside an
 * allowed root can be a link to ~/.ssh/id_ed25519, and checking the name the
 * model supplied would wave it through. For paths that do not exist yet (a
 * file about to be created) the parent directory is resolved instead.
 */

import { realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Messages are written for the user, so tools may repeat them verbatim. */
export class PathError extends Error {
  readonly userSafe = true
  readonly code: 'outside_roots' | 'invalid_path' | 'not_found'
  constructor(code: PathError['code'], message: string) {
    super(message)
    this.name = 'PathError'
    this.code = code
  }
}

/** Expand `~`, resolve, and realpath each root once. Missing roots are dropped. */
export function normalizeRoots(roots: string[]): string[] {
  const out: string[] = []
  for (const root of roots) {
    const expanded = expandHome(root.trim())
    if (!expanded) continue
    try {
      out.push(realpathSync(resolve(expanded)))
    } catch {
      /* a root that does not exist cannot contain anything */
    }
  }
  return [...new Set(out)]
}

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** True when `candidate` is `root` itself or somewhere beneath it. */
export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve `requested` against the roots and return its real path.
 *
 * @param mustExist false for paths about to be created; their parent must
 *   exist and be inside a root.
 */
export async function resolveWithinRoots(
  requested: string,
  roots: readonly string[],
  mustExist = true,
): Promise<string> {
  if (!requested || requested.includes('\0')) {
    throw new PathError('invalid_path', 'That is not a valid path.')
  }
  const expanded = expandHome(requested)
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(roots[0] ?? homedir(), expanded)

  let real: string
  try {
    real = await realpath(absolute)
  } catch {
    if (mustExist) throw new PathError('not_found', 'That file does not exist.')
    try {
      real = join(await realpath(dirname(absolute)), basename(absolute))
    } catch {
      throw new PathError('not_found', 'The folder for that file does not exist.')
    }
  }

  if (!roots.some((root) => isWithin(root, real))) {
    throw new PathError('outside_roots', 'That location is outside the folders CLAP is allowed to use.')
  }
  return real
}
