/**
 * The permission model, enforced in the bridge.
 *
 * `PermissionGate.decide` turns (tool, input, provenance) into allow, confirm
 * or deny. `ConfirmationBroker` owns the pending confirmations: each one has a
 * random id, belongs to exactly one session, is answered at most once, and
 * resolves to "no" on timeout, interrupt or disconnect. The HUD shows the
 * question and relays the answer; it cannot approve anything the bridge did
 * not ask about, for a session it does not own.
 */

import { randomUUID } from 'node:crypto'
import type { BridgeEventOf } from '../shared/protocol'
import type { RiskPolicy } from '../shared/risk'
import type { ToolMeta, ToolRegistry } from './tools/registry'

export type GateDecision =
  | { action: 'allow'; tool: ToolMeta; summary: string }
  | { action: 'confirm'; tool: ToolMeta; summary: string }
  | { action: 'deny'; tool: ToolMeta | null; summary: string; reason: string }

export class PermissionGate {
  private readonly registry: Pick<ToolRegistry, 'resolve'>
  private readonly policy: RiskPolicy

  constructor(registry: Pick<ToolRegistry, 'resolve'>, policy: RiskPolicy) {
    this.registry = registry
    this.policy = policy
  }

  decide(sdkName: string, input: unknown, provenance?: { name: string; source: string }): GateDecision {
    const tool = this.registry.resolve(sdkName, provenance)
    if (!tool) {
      return {
        action: 'deny',
        tool: null,
        summary: sdkName.slice(0, 120),
        reason: 'That tool is not available to CLAP.',
      }
    }
    const summary = tool.summarize(input)
    const policy = this.policy[tool.risk]
    if (policy === 'deny') {
      return { action: 'deny', tool, summary, reason: `${tool.label} is turned off by the permission policy.` }
    }
    if (tool.risk === 'high' || tool.requiresConfirmation || policy === 'confirm') {
      return { action: 'confirm', tool, summary }
    }
    return { action: 'allow', tool, summary }
  }
}

export type ConfirmationOutcome = { approved: boolean; reason: 'user' | 'timeout' | 'cancelled' }

type ConfirmationEvent = BridgeEventOf<'confirmation_request'> | BridgeEventOf<'confirmation_resolved'>

type Pending = {
  sessionId: string
  finish: (outcome: ConfirmationOutcome) => void
}

export type BrokerOptions = {
  timeoutMs: number
  newId?: () => string
  now?: () => number
}

export class ConfirmationBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly timeoutMs: number
  private readonly newId: () => string
  private readonly now: () => number

  constructor(options: BrokerOptions) {
    this.timeoutMs = options.timeoutMs
    this.newId = options.newId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  /** Ask the session's user; resolves when they answer or the request lapses. */
  request(args: {
    sessionId: string
    turnId: string
    tool: ToolMeta
    summary: string
    signal?: AbortSignal
    send: (event: ConfirmationEvent) => void
  }): Promise<ConfirmationOutcome> {
    const requestId = this.newId()
    const { signal } = args

    return new Promise<ConfirmationOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => finish({ approved: false, reason: 'cancelled' })

      const finish = (outcome: ConfirmationOutcome) => {
        if (!this.pending.delete(requestId)) return // already answered: single use
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        args.send({ type: 'confirmation_resolved', requestId, approved: outcome.approved, reason: outcome.reason })
        resolve(outcome)
      }

      this.pending.set(requestId, { sessionId: args.sessionId, finish })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish({ approved: false, reason: 'timeout' }), this.timeoutMs)

      args.send({
        type: 'confirmation_request',
        requestId,
        turnId: args.turnId,
        name: args.tool.name,
        label: args.tool.label,
        risk: args.tool.risk,
        summary: args.summary,
        expiresAt: this.now() + this.timeoutMs,
      })
    })
  }

  /** Apply a user's answer. Only the session that was asked can answer. */
  respond(sessionId: string, requestId: string, approved: boolean): 'accepted' | 'unknown' | 'wrong_session' {
    const pending = this.pending.get(requestId)
    if (!pending) return 'unknown'
    if (pending.sessionId !== sessionId) return 'wrong_session'
    pending.finish({ approved, reason: 'user' })
    return 'accepted'
  }

  /** Deny everything a session is waiting on (interrupt, disconnect, close). */
  cancelSession(sessionId: string): number {
    let cancelled = 0
    for (const pending of [...this.pending.values()]) {
      if (pending.sessionId !== sessionId) continue
      pending.finish({ approved: false, reason: 'cancelled' })
      cancelled++
    }
    return cancelled
  }

  pendingCount(sessionId?: string): number {
    if (!sessionId) return this.pending.size
    return [...this.pending.values()].filter((p) => p.sessionId === sessionId).length
  }
}
