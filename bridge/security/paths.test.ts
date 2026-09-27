import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expandHome, isWithin, normalizeRoots, PathError, resolveWithinRoots } from './paths'

let base: string
let root: string
let outside: string

beforeAll(() => {
  base = normalizeRoots([mkdtempSync(join(tmpdir(), 'clap-paths-'))])[0]!
  root = join(base, 'root')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'docs', 'notes.txt'), 'notes')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link-out.txt'))
  symlinkSync(outside, join(root, 'dir-out'))
  symlinkSync(join(root, 'docs', 'notes.txt'), join(root, 'link-in.txt'))
  symlinkSync(join(outside, 'not-yet.txt'), join(root, 'dangling.txt'))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return 'ok'
  } catch (error) {
    expect(error).toBeInstanceOf(PathError)
    return (error as PathError).code
  }
}

describe('isWithin', () => {
  it('accepts the root and its descendants only', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true)
    expect(isWithin('/a/b', '/a')).toBe(false)
    expect(isWithin('/a/b', '/a/bc')).toBe(false)
    expect(isWithin('/a/b', '/a/b/../c')).toBe(false)
  })
})

describe('expandHome and normalizeRoots', () => {
  it('expands ~ and drops roots that do not exist', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/x')).toBe(join(homedir(), 'x'))
    expect(expandHome('/x/~/y')).toBe('/x/~/y')
    expect(normalizeRoots([root, `${root}/`, join(base, 'missing'), '  '])).toEqual([root])
  })
})

describe('resolveWithinRoots', () => {
  it('resolves existing files inside a root, relative or absolute', async () => {
    const notes = join(root, 'docs', 'notes.txt')
    await expect(resolveWithinRoots('docs/notes.txt', [root])).resolves.toBe(notes)
    await expect(resolveWithinRoots(notes, [root])).resolves.toBe(notes)
    await expect(resolveWithinRoots('link-in.txt', [root])).resolves.toBe(notes)
  })

  it('refuses traversal and symlinks that leave the root', async () => {
    expect(await code(resolveWithinRoots('../outside/secret.txt', [root]))).toBe('outside_roots')
    expect(await code(resolveWithinRoots(join(outside, 'secret.txt'), [root]))).toBe('outside_roots')
    expect(await code(resolveWithinRoots('link-out.txt', [root]))).toBe('outside_roots')
    expect(await code(resolveWithinRoots('dir-out/secret.txt', [root]))).toBe('outside_roots')
    expect(await code(resolveWithinRoots('/etc/passwd', [root]))).toBe('outside_roots')
  })

  it('refuses empty paths and NUL bytes', async () => {
    expect(await code(resolveWithinRoots('', [root]))).toBe('invalid_path')
    expect(await code(resolveWithinRoots('docs/notes.txt\0.png', [root]))).toBe('invalid_path')
  })

  it('reports missing files unless they are about to be created', async () => {
    expect(await code(resolveWithinRoots('docs/new.txt', [root]))).toBe('not_found')
    await expect(resolveWithinRoots('docs/new.txt', [root], false)).resolves.toBe(join(root, 'docs', 'new.txt'))
    expect(await code(resolveWithinRoots('nowhere/new.txt', [root], false))).toBe('not_found')
    expect(await code(resolveWithinRoots('dir-out/new.txt', [root], false))).toBe('outside_roots')
  })

  it('refuses a new path that is a dangling symlink out of the root', async () => {
    // Writing to root/dangling.txt would create outside/not-yet.txt.
    expect(await code(resolveWithinRoots('dangling.txt', [root], false))).toBe('invalid_path')
  })

  it('refuses everything when no root is configured', async () => {
    expect(await code(resolveWithinRoots(join(root, 'docs', 'notes.txt'), []))).toBe('outside_roots')
  })
})
