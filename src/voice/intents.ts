/**
 * Short spoken intents that never go to the model: confirmation answers and
 * "stop"-type overrides.
 *
 * Approval is deliberately hard to trigger by accident. The microphone is open
 * while CLAP speaks the confirmation prompt, so anything that could approve an
 * action from a fragment of CLAP's own voice is a safety bug. Rules:
 *
 *   - "yes" only counts when the WHOLE utterance is a yes-phrase ("yes",
 *     "yes please", "go ahead"). "Say yes to confirm" is not approval.
 *   - Any negative word anywhere wins ("yes — no, wait" is a no).
 *   - The prompt CLAP speaks contains none of the yes-phrases (see
 *     confirmationPrompt), so an echo of it cannot match.
 */

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const YES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'confirm', 'confirmed', 'approve', 'approved', 'affirmative',
  'ok', 'okay', 'do it', 'go ahead', 'go for it', 'proceed', 'please do', 'yes do it', 'yes go ahead',
  'yeah do it', 'yeah go ahead', 'sure go ahead', 'ok go ahead', 'okay go ahead', 'yes confirm', 'yes proceed',
])

const NO = /\b(no|nope|nah|don't|dont|do not|cancel|stop|deny|denied|abort|never ?mind|not now|wait|hold on|negative)\b/

/** Filler that may wrap a yes without changing it. */
const WRAPPERS = /^(?:(?:hey )?clap )?(.*?)(?: please| thanks| thank you| clap)*$/

export function parseConfirmation(text: string): 'yes' | 'no' | null {
  const said = normalize(text)
  if (!said) return null
  if (NO.test(said)) return 'no'
  const core = WRAPPERS.exec(said)?.[1]?.trim() ?? said
  return YES.has(core) ? 'yes' : null
}

const STOP = new Set([
  'stop', 'stop it', 'stop talking', 'stop please', 'please stop', 'quiet', 'be quiet', 'shush', 'shh',
  'shut up', 'enough', "that's enough", 'thats enough', 'ok stop', 'okay stop', 'clap stop', 'hey clap stop',
])
const CANCEL = new Set([
  'cancel', 'cancel that', 'never mind', 'nevermind', 'forget it', 'stand down', 'go to sleep', 'dismiss',
  "that's all", 'thats all', 'nothing', 'no thanks', 'no thank you',
])

/** A whole-utterance override: "stop" (be quiet, keep listening) or "cancel" (stand down). */
export function overrideIntent(text: string): 'stop' | 'cancel' | null {
  const said = normalize(text)
  if (STOP.has(said)) return 'stop'
  if (CANCEL.has(said)) return 'cancel'
  return null
}

/** Words that must cut through the echo filter even if CLAP just said them. */
export const OVERRIDE_WORDS = /\b(stop|wait|cancel|quiet|enough|clap|no)\b/i

/**
 * What CLAP says when it needs a yes or no.
 *
 * No suffix of this sentence may be a yes-phrase: the recogniser can catch
 * just the tail of CLAP's own voice, and "…shall I go ahead?" heard as "go
 * ahead" would approve itself. "Want me to?" has no such tail ("me to", "to").
 * Summaries of confirmable tools are written as actions ("Delete 3 files in
 * Downloads"), which reads naturally in front of it.
 */
export function confirmationPrompt(summary: string): string {
  const action = summary.replace(/[.!?\s]+$/, '')
  return `${action}. Want me to?`
}
