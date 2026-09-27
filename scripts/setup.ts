/**
 * npm run setup — first-run help.
 *
 * Creates .env.local from .env.example if there is no local configuration yet
 * (it holds no secrets until you add them), then runs the doctor's checks and
 * says what to do next. Never overwrites an existing file.
 */

import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectChecks, failed, formatChecks, loadEnv, ROOT } from './lib/checks'

async function main(): Promise<void> {
  process.stdout.write('\nCLAP setup\n\n')

  const local = resolve(ROOT, '.env.local')
  if (existsSync(local) || existsSync(resolve(ROOT, '.env'))) {
    process.stdout.write('  Keeping your existing configuration.\n\n')
  } else {
    copyFileSync(resolve(ROOT, '.env.example'), local)
    process.stdout.write('  Created .env.local from .env.example. Every setting is optional; the defaults work.\n\n')
  }

  loadEnv()
  const { checks } = await collectChecks('doctor')
  process.stdout.write(`${formatChecks(checks)}\n\n`)

  if (failed(checks)) {
    process.stdout.write('Fix the items marked ✗, then run npm run doctor to check again.\n\n')
    process.exitCode = 1
    return
  }
  process.stdout.write(
    'Next:\n' +
      '  npm start            start the bridge and the HUD, and open the browser\n' +
      '  Click "Activate voice" (or press Space), then say "hey clap" — or just type.\n' +
      '  For the custom CLAP voice, see docs/voice.md.\n\n',
  )
}

void main()
