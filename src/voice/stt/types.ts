/**
 * Speech-to-text providers.
 *
 * Two shapes exist in practice, and the interface covers both:
 *   - streaming recognisers that hear the microphone themselves and report
 *     partial and final text (the browser's SpeechRecognition);
 *   - segment transcribers that are handed one captured utterance at a time by
 *     the voice-activity detector (cloud STT through the bridge).
 * The voice input (../input.ts) decides what the text means; providers only
 * turn sound into words.
 */

export type SpeechCapabilities = {
  id: string
  /** Audio leaves the machine. */
  cloud: boolean
  /** Runs on-device. */
  local: boolean
  /** Reports partial text while the user is still talking. */
  partials: boolean
  /** Needs VAD-captured segments via `acceptSegment`. */
  segmentBased: boolean
}

export type SpeechHandlers = {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  /** `fatal` means this provider has given up and a fallback should take over. */
  onError: (message: string, fatal: boolean) => void
}

export interface SpeechProvider {
  readonly id: string
  getCapabilities(): SpeechCapabilities
  start(handlers: SpeechHandlers): void
  stop(): void
  isActive(): boolean
  acceptSegment?(audio: Blob): void
}
