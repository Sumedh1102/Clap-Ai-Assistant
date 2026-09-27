import { useEffect } from 'react'
import { hud } from '../state/store'
import type { ClapController } from './controller'

/**
 * Global keys. Ignored while typing in the composer (except Escape), so a
 * sentence containing "m" doesn't mute the microphone.
 */
export function useKeyboard(controller: ClapController): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (typing && event.key !== 'Escape') return

      const confirming = hud.get().confirmation !== null
      switch (event.key) {
        case ' ':
          if (event.repeat) return
          event.preventDefault()
          controller.pushToTalk()
          return
        case 'Escape':
          controller.cancel()
          return
        case 'y':
        case 'Y':
          if (confirming) controller.answerConfirmation(true, 'key')
          return
        case 'n':
        case 'N':
          if (confirming) controller.answerConfirmation(false, 'key')
          return
        case 'm':
        case 'M':
          controller.toggleMicrophone()
          return
        case 'd':
        case 'D':
          hud.togglePanel('diagnostics')
          return
        case 'h':
        case 'H':
          hud.togglePanel('history')
          return
        case 'v':
        case 'V':
          controller.cycleBrowserVoice()
          return
        case '/':
          event.preventDefault()
          window.dispatchEvent(new Event('clap:focus-composer'))
          return
      }
    }
    const unlock = () => controller.unlockAudio()
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', unlock)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', unlock)
    }
  }, [controller])
}
