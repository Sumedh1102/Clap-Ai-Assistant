import { beforeEach, describe, expect, it } from 'vitest'
import { hud } from './store'

describe('hud transcript', () => {
  beforeEach(() => hud.set({ transcript: [], currentTurnId: null }))

  it('builds CLAP’s entry from streamed deltas', () => {
    hud.addUserTurn('t1', 'hello', 'text')
    hud.appendClap('t1', 'Hi ')
    hud.appendClap('t1', 'there.')
    expect(hud.get().transcript.map((e) => [e.role, e.text])).toEqual([
      ['user', 'hello'],
      ['clap', 'Hi there.'],
    ])
  })

  it('takes the final text when the turn ends, and keeps the streamed text otherwise', () => {
    hud.appendClap('t1', 'Refused part')
    hud.finishClap('t1', { text: 'The real answer.' })
    expect(hud.get().transcript.at(-1)?.text).toBe('The real answer.')

    hud.appendClap('t2', 'Cut off mid')
    hud.finishClap('t2', { interrupted: true })
    expect(hud.get().transcript.at(-1)).toMatchObject({ text: 'Cut off mid', interrupted: true })
  })

  it('records an error for a turn that said nothing', () => {
    hud.finishClap('t3', { error: 'That failed.' })
    expect(hud.get().transcript.at(-1)).toMatchObject({ role: 'clap', text: '', error: 'That failed.' })
    hud.finishClap('t4', {})
    expect(hud.get().transcript).toHaveLength(1)
  })
})
