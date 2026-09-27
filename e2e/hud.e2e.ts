import { expect, test as base, type Locator, type Page } from '@playwright/test'

/** Every URL each page asked for, from its first navigation on. */
const requested = new WeakMap<Page, string[]>()

/** Every test also fails on an uncaught error or console.error in the page. */
const test = base.extend<{ hud: Page }>({
  hud: async ({ page }, provide) => {
    const errors: string[] = []
    const urls: string[] = []
    requested.set(page, urls)
    page.on('request', (request) => urls.push(request.url()))
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.goto('/')
    await expect(page.locator('.connection')).toContainText('Online')
    await provide(page)
    expect(errors).toEqual([])
  },
})

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message CLAP' })
const caption = (page: Page) => page.locator('.caption')
const stateLabel = (page: Page) => page.locator('.state-label')

async function ask(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await composer(page).press('Enter')
  // Leave the field so single-key shortcuts (Y, N, Esc) reach the HUD.
  await composer(page).blur()
}

const box = async (locator: Locator) => {
  const b = await locator.boundingBox()
  if (!b) throw new Error('not visible')
  return b
}
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('connects to the bridge and answers a typed question', async ({ hud }) => {
  // The 3D core loads after the HUD, replacing the CSS placeholder.
  await expect(hud.locator('canvas')).toBeVisible()
  await expect(hud.locator('.core-fallback')).toHaveCount(0)
  // (The same URL check the no-WebGL test relies on, seen matching here.)
  expect((requested.get(hud) ?? []).some((url) => url.includes('/hud/scene/Scene'))).toBe(true)
  await expect(stateLabel(hud)).toHaveText('ONLINE')
  await expect(hud.locator('.connection')).toContainText('scripted-agent')
  await ask(hud, 'what time is it')
  await expect(caption(hud)).toHaveText('Heard: what time is it. That makes 1 this session.')
  await expect(stateLabel(hud)).toHaveText('ONLINE')

  await hud.keyboard.press('h')
  const history = hud.getByRole('complementary', { name: 'Conversation history' })
  await expect(history).toContainText('what time is it')
  await expect(history).toContainText('That makes 1 this session.')
})

test('asks before a high-risk action and runs it only when approved', async ({ hud }) => {
  await ask(hud, 'delete the old logs')
  const card = hud.getByRole('alertdialog')
  await expect(card).toContainText('Delete 3 files in Downloads')
  await expect(card).toContainText('high risk')
  await expect(stateLabel(hud)).toHaveText('CONFIRM?')

  await hud.keyboard.press('y')
  await expect(card).toBeHidden()
  await expect(caption(hud)).toHaveText('Deleted them.')

  await ask(hud, 'delete them again')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: /Decline/ }).click()
  await expect(card).toBeHidden()
  await expect(caption(hud)).toHaveText('Left them alone.')
})

test('the confirmation choices do not look alike', async ({ hud }) => {
  await ask(hud, 'delete the old logs')
  const card = hud.getByRole('alertdialog')
  const style = (name: RegExp) =>
    card.getByRole('button', { name }).evaluate((el) => {
      const s = getComputedStyle(el)
      return `${s.color} ${s.backgroundColor} ${s.fontWeight}`
    })
  expect(await style(/Approve/)).not.toBe(await style(/Decline/))
  // Only the risk badge is red, not every word on the card.
  const labelColor = await card.locator('.confirm-label').evaluate((el) => getComputedStyle(el).color)
  const badgeColor = await card.locator('.risk').evaluate((el) => getComputedStyle(el).color)
  expect(labelColor).not.toBe(badgeColor)
  await hud.keyboard.press('n')
})

test('Esc interrupts a streaming answer, and the next question still works', async ({ hud }) => {
  await ask(hud, 'tell me a long story')
  await expect(caption(hud)).toContainText('Sentence 2 of the story.')
  await hud.keyboard.press('Escape')
  await expect(caption(hud)).toContainText('interrupted')
  await expect(stateLabel(hud)).toHaveText('ONLINE')
  const cut = await caption(hud).innerText()
  await hud.waitForTimeout(800)
  // Nothing more arrives from the interrupted turn.
  expect(await caption(hud).innerText()).toBe(cut)

  await ask(hud, 'are you there')
  await expect(caption(hud)).toHaveText('Heard: are you there. That makes 2 this session.')
})

test('a reload resumes the same conversation', async ({ hud }) => {
  await ask(hud, 'first')
  await expect(caption(hud)).toContainText('That makes 1 this session.')
  await hud.reload()
  await expect(hud.locator('.connection')).toContainText('Online')
  await ask(hud, 'second')
  await expect(caption(hud)).toHaveText('Heard: second. That makes 2 this session.')
})

test('the key hints never cover the message box', async ({ hud }) => {
  for (const width of [1280, 1024, 820]) {
    await hud.setViewportSize({ width, height: 760 })
    const hints = hud.locator('.key-hints')
    if (!(await hints.isVisible())) continue
    expect(overlaps(await box(hints), await box(composer(hud))), `overlap at ${width}px`).toBe(false)
  }
})

test('shows the CSS core when WebGL is unavailable @no-webgl', async ({ hud }) => {
  await expect(hud.locator('.core-fallback')).toBeVisible()
  await expect(hud.locator('canvas')).toHaveCount(0)
  // three.js is never downloaded when it could not run.
  expect((requested.get(hud) ?? []).filter((url) => url.includes('/hud/scene/Scene'))).toEqual([])
  await ask(hud, 'still there')
  await expect(caption(hud)).toContainText('Heard: still there.')
})

test('turns the microphone off when speech recognition fails and nothing else can transcribe @voice', async ({ page }) => {
  // A browser recogniser that exists but cannot capture audio. (Stubbed: the
  // real on-device check crashes Playwright's headless_shell renderer.)
  await page.addInitScript(() => {
    class BrokenRecognition {
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      start() {
        setTimeout(() => {
          this.onerror?.({ error: 'audio-capture' })
          this.onend?.()
        }, 50)
      }
      stop() {}
      abort() {}
      static available = async () => 'unavailable'
    }
    Object.assign(window, { SpeechRecognition: BrokenRecognition, webkitSpeechRecognition: BrokenRecognition })
  })
  await page.goto('/')
  await expect(page.locator('.connection')).toContainText('Online')
  await page.getByRole('button', { name: 'Activate voice' }).click()

  await expect(page.getByRole('status')).toHaveText(
    'Speech recognition stopped (audio-capture), so the microphone is off. Type to CLAP instead.',
  )
  // Not "Press Space to talk": nothing could transcribe it.
  await expect(page.locator('.state-sub')).toHaveText('Voice off — type, or activate voice')
  await expect(page.getByRole('button', { name: 'Activate voice' })).toBeVisible()

  await ask(page, 'still there')
  await expect(caption(page)).toContainText('Heard: still there.')
})
