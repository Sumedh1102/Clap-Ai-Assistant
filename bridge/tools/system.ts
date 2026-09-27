/**
 * SYSTEM tools that only read. Phase 6 adds the ones that act (launching
 * applications, volume, brightness, sleep), each with its own risk level.
 */

import { arch, cpus, freemem, loadavg, platform, release, totalmem, type as osType, uptime } from 'node:os'
import { z } from 'zod'
import { defineTool, ToolFailure } from './registry'

export const getTime = defineTool({
  name: 'get_time',
  label: 'Clock',
  description:
    'Current date, time and time zone on this computer. Pass an IANA time zone ' +
    '(for example "Asia/Tokyo") to get the time somewhere else. Use this rather than guessing the date or time.',
  category: 'system',
  risk: 'low',
  inputSchema: {
    timezone: z.string().min(1).max(64).optional().describe('IANA time zone, e.g. "Europe/London". Omit for local time.'),
  },
  summarize: ({ timezone }) => (timezone ? `Time in ${timezone}` : 'Checking the time'),
  timeoutMs: 2_000,
  async handler({ timezone }) {
    const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    let format: Intl.DateTimeFormat
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })
    } catch {
      throw new ToolFailure(`"${timezone}" is not a time zone I recognise.`)
    }
    const now = new Date()
    return { text: `${format.format(now)} (time zone ${zone}; ISO ${now.toISOString()})` }
  },
})

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return [days && `${days} days`, hours && `${hours} hours`, `${minutes} minutes`].filter(Boolean).join(', ')
}

export const systemInfo = defineTool({
  name: 'system_info',
  label: 'System status',
  description:
    'Operating system, uptime, memory use, CPU and load on this computer. Use for questions about how the machine is doing.',
  category: 'system',
  risk: 'low',
  inputSchema: {},
  summarize: () => 'Reading system status',
  timeoutMs: 2_000,
  async handler() {
    const cores = cpus()
    const total = totalmem()
    const free = freemem()
    const load = loadavg()
    const lines = [
      `Operating system: ${osType()} ${release()} (${platform()}, ${arch()})`,
      `Uptime: ${duration(uptime())}`,
      `Memory: ${gib(total - free)} used of ${gib(total)} (${Math.round(((total - free) / total) * 100)}%)`,
      `CPU: ${cores[0]?.model?.trim() ?? 'unknown'}, ${cores.length} logical cores`,
      // loadavg is always zero on Windows, where it is not implemented.
      platform() === 'win32' ? null : `Load average (1, 5, 15 min): ${load.map((n) => n.toFixed(2)).join(', ')}`,
      `Runtime: Node.js ${process.version}`,
    ]
    return { text: lines.filter(Boolean).join('\n') }
  },
})
