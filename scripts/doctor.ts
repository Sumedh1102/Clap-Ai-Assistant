/**
 * npm run doctor — check everything CLAP needs, change nothing.
 *
 * Exits 1 if anything would stop CLAP from working, so it can gate scripts.
 */

import { collectChecks, failed, formatChecks, loadEnv } from './lib/checks'

async function main(): Promise<void> {
  const loaded = loadEnv()
  const { checks } = await collectChecks('doctor')

  process.stdout.write(`\nCLAP doctor\n\n${formatChecks(checks)}\n\n`)
  process.stdout.write(`  Settings read from: ${loaded.length ? loaded.join(', ') : 'the environment only (no .env.local or .env)'}\n`)
  process.stdout.write(
    '  Browser: on-device wake detection needs Chrome or Edge with on-device speech\n' +
      '  recognition; elsewhere CLAP uses the browser cloud recogniser or push-to-talk (Space).\n\n',
  )

  if (failed(checks)) {
    process.stdout.write('Some checks failed. Fix the items marked ✗ and run npm run doctor again.\n\n')
    process.exitCode = 1
  } else {
    process.stdout.write('Ready. Run npm start.\n\n')
  }
}

void main()
