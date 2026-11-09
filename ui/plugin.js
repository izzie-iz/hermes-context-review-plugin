/** Compact context-review reminder. Native desktop contribution; no core DOM writes. */
import { atom, Button, COMPOSER_AREAS, host, Tip, useValue } from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'context-review-reminder'
const STORAGE = 'chat-choices-v1'
const ACTIVE_PHASES = new Set(['reviewing', 'awaiting_answer', 'proposed', 'approved', 'paused', 'dismissed'])
const choices = atom({})
const REVIEW_PROMPT = "Please review this chat's context using context_review. Ask one specific question at a time only if needed, choosing follow-ups from my answers. Show the exact versioned carry-forward handoff before requesting separate approval to compact. This starts a review only; it does not approve compaction. Do not continue project work or save permanent memory as part of the review."

export function reminderView(usage, preference = {}) {
  const used = usage?.context_used
  const maximum = usage?.context_max
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(maximum) || maximum <= 0) {
    return { visible: false, reason: 'unknown_usage', used: 0, maximum: 0, warning: 0, level: 0 }
  }
  const warning = Math.min(250000, Math.floor(maximum * 0.60))
  const escalation = Math.min(300000, Math.floor(maximum * 0.75))
  const level = used >= escalation ? 2 : used >= warning ? 1 : 0
  const reason = preference.dismissed ? 'dismissed' : ACTIVE_PHASES.has(preference.phase) ? 'under_review' : used < (preference.snoozeUntil || 0) ? 'snoozed' : level ? 'suggested' : 'below_threshold'
  return { visible: reason === 'suggested', reason, used, maximum, warning, level, estimated: usage?.context_estimated === true }
}

export function snoozePreference(usage, preference = {}) {
  const view = reminderView(usage)
  return view.maximum ? { ...preference, snoozeUntil: view.used + 25000, lastUsed: view.used } : preference
}

export function reconcilePreference(usage, preference = {}) {
  const view = reminderView(usage)
  if (!view.maximum) return preference
  const countAdvanced = Number.isFinite(preference.compressionsAtReview) && Number.isFinite(usage?.compressions) && usage.compressions > preference.compressionsAtReview
  const contextShrank = Number.isFinite(preference.contextAtReview) && view.used < preference.contextAtReview * 0.75
  if ((ACTIVE_PHASES.has(preference.phase) || preference.phase === 'requested') && (countAdvanced || contextShrank)) {
    return { ...preference, phase: 'idle', snoozeUntil: 0, contextAtReview: undefined, compressionsAtReview: undefined }
  }
  if (view.used < view.warning && preference.snoozeUntil) {
    const { snoozeUntil, ...rest } = preference
    return rest
  }
  return preference
}

export function preferenceKey(connectionId, profile, storedId) {
  return JSON.stringify([connectionId || 'local', profile || 'default', storedId || ''])
}

export function surfaceMatches(target, ids) {
  if (!ids.focusedRuntimeId || !ids.focusedStoredId) return false
  if (target === 'main') return ids.focusedRuntimeId === ids.activeRuntimeId
  return target === `tile:${ids.focusedStoredId}`
}

export function readIdentity(bridge = host) {
  const state = bridge.state
  const owner = state.focusedSessionOwner?.get?.()
  const runtimeId = state.focusedSessionId?.get?.() || ''
  const storedId = state.focusedStoredSessionId?.get?.() || runtimeId
  const profile = owner?.profile || state.focusedSessionProfile?.get?.() || state.profile?.get?.() || 'default'
  const connectionId = owner?.connectionId || state.connectionId?.get?.() || 'local'
  return { runtimeId, storedId, profile, connectionId, key: preferenceKey(connectionId, profile, storedId) }
}

export async function beginReview(bridge, expected) {
  const same = () => {
    const now = readIdentity(bridge)
    return now.key === expected.key && now.runtimeId === expected.runtimeId
  }
  if (!expected.runtimeId || !same()) return { ok: false, reason: 'focus_changed' }
  if (bridge.state.busy?.get?.()) return { ok: false, reason: 'busy' }
  if (!bridge.composer?.getDraft || !bridge.composer?.submit) return { ok: false, reason: 'composer_unavailable' }
  const draft = await bridge.composer.getDraft(expected.runtimeId)
  if (!same()) return { ok: false, reason: 'focus_changed' }
  if (bridge.state.busy?.get?.()) return { ok: false, reason: 'busy' }
  if (draft === null) return { ok: false, reason: 'composer_unavailable' }
  if (String(draft).trim()) return { ok: false, reason: 'draft' }
  const claimed = bridge.composer.submit(expected.runtimeId, REVIEW_PROMPT)
  return claimed ? { ok: true } : { ok: false, reason: 'composer_unavailable' }
}

function saveChoice(ctx, key, value) {
  const next = { ...choices.get(), [key]: value }
  choices.set(next)
  try { ctx.storage.set(STORAGE, next) }
  catch { host.notify({ kind: 'warning', message: 'The reminder choice is active, but could not be saved for the next app launch.' }) }
}

function writeReceipt(ctx, filename, data) {
  if (!ctx.files?.writeText) return
  void ctx.files.writeText(ctx.files.dataFolder, filename, JSON.stringify({ plugin: ID, at: new Date().toISOString(), ...data }, null, 2))
    .catch(() => {})
}

function ContextIcon() {
  return jsxs('svg', {
    viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true,
    children: [jsx('rect', { x: 4, y: 5, width: 12, height: 14, rx: 2 }), jsx('path', { d: 'M8 2h10a2 2 0 0 1 2 2v12M7 10h6M7 14h6' })],
  })
}

function ContextStrip({ ctx }) {
  const runtimeId = useValue(host.state.focusedSessionId)
  const storedId = useValue(host.state.focusedStoredSessionId) || runtimeId
  const profile = useValue(host.state.focusedSessionProfile)
  const connectionId = useValue(host.state.connectionId)
  const primaryId = useValue(host.state.activeSessionId)
  const usage = useValue(host.state.focusedUsage)
  const busy = useValue(host.state.busy)
  const allChoices = useValue(choices)
  const root = useRef(null)
  const [target, setTarget] = useState('')
  const [pending, setPending] = useState(false)
  const identity = readIdentity()
  const key = identity.key
  const preference = allChoices[key] || {}
  const view = reminderView(usage, preference)
  const sameSurface = surfaceMatches(target, { focusedRuntimeId: runtimeId, focusedStoredId: storedId, activeRuntimeId: primaryId })
  const visible = Boolean(runtimeId && sameSurface && view.visible)

  useLayoutEffect(() => {
    // Read only the stable surface address around OUR contribution; never alter core nodes.
    setTarget(root.current?.closest('[data-composer-target]')?.getAttribute('data-composer-target') || '')
  }, [runtimeId, storedId, primaryId, profile, connectionId])

  useEffect(() => {
    // A completed compaction re-arms the next context-growth cycle.
    const next = reconcilePreference(usage, preference)
    if (key && JSON.stringify(next) !== JSON.stringify(preference)) saveChoice(ctx, key, next)
  }, [key, usage?.context_used, usage?.context_max, usage?.compressions, preference])

  useEffect(() => {
    if (!root.current || !sameSurface) return undefined
    const frame = requestAnimationFrame(() => {
      const node = root.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      writeReceipt(ctx, `render-${String(storedId || 'draft').replace(/[^a-zA-Z0-9_-]/g, '').slice(-96)}.json`, {
        mounted: true, area: COMPOSER_AREAS.top, sessionId: storedId, profile,
        visible, reason: view.reason, busy: Boolean(busy), target,
        activeContext: view.used, contextWindow: view.maximum,
        width: rect.width, height: rect.height,
        background: style.backgroundColor, borderColor: style.borderLeftColor,
        label: visible ? 'Context review suggested' : null,
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [key, target, sameSurface, visible, busy])

  async function review() {
    setPending(true)
    try {
      const result = await beginReview(host, identity)
      if (result.ok) {
        // A claimed composer send is not proof that the review engine started.
        // The native context_review result event supplies the actual phase.
        const liveUsage = host.state.focusedUsage.get()
        saveChoice(ctx, key, { ...(choices.get()[key] || {}), ...identity, phase: 'requested', contextAtReview: liveUsage?.context_used, compressionsAtReview: liveUsage?.compressions })
      } else {
        const messages = {
          draft: 'Your unsent draft is safe. Send or clear it first, then choose Review now.',
          busy: 'Let the current reply finish before starting a context review.',
          focus_changed: 'The focused chat changed. Nothing was sent; choose Review now in the intended chat.',
          composer_unavailable: 'The intended message box is not ready. Nothing was sent.',
        }
        host.notify({ kind: 'info', message: messages[result.reason] || 'The review was not started.' })
      }
    } catch (error) {
      host.notify({ kind: 'error', message: `Could not start context review: ${error?.message || 'unknown error'}` })
    } finally { setPending(false) }
  }

  const help = view.maximum ? `${view.estimated ? 'Estimated' : 'Active'} context: ${view.used.toLocaleString()} / ${view.maximum.toLocaleString()} tokens. Review is optional. Compaction always needs separate approval.` : 'Context review'
  return jsxs('div', {
    ref: root, 'data-context-review-reminder': '', role: visible ? 'status' : undefined, 'aria-live': 'polite',
    style: {
      display: visible ? 'flex' : 'none', alignItems: 'center', gap: 9, width: '100%', minWidth: 0,
      padding: '8px 10px', marginBottom: 6, borderRadius: 8,
      background: 'var(--ui-bg-editor)', border: '1px solid color-mix(in srgb, var(--ui-accent) 25%, var(--ui-bg-editor))',
      borderLeft: '3px solid var(--ui-accent)', color: 'var(--ui-text-primary)',
    },
    children: [
      jsx('span', { style: { color: 'var(--ui-accent)', background: 'color-mix(in srgb, var(--ui-accent) 9%, var(--ui-bg-editor))', borderRadius: 7, width: 24, height: 24, display: 'grid', placeItems: 'center', flexShrink: 0 }, children: jsx(ContextIcon, {}) }),
      jsx('span', { title: help, style: { fontSize: 12, fontWeight: 550, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: 'Context review suggested' }),
      jsx(Tip, { label: busy ? 'Available when the current reply finishes' : 'Start a review, not compaction', children: jsx(Button, { type: 'button', size: 'xs', disabled: Boolean(busy || pending), onClick: review, style: { borderRadius: 6 }, children: 'Review now' }) }),
      jsx(Tip, { label: 'Remind me after this context grows another 25,000 tokens', children: jsx(Button, { type: 'button', variant: 'outline', size: 'xs', disabled: pending, onClick: () => { const current = readIdentity(); if (current.key === key && current.runtimeId === runtimeId) saveChoice(ctx, key, snoozePreference(host.state.focusedUsage.get(), choices.get()[key] || {})) }, style: { borderRadius: 6 }, children: 'Later' }) }),
    ],
  })
}

export default {
  id: ID,
  name: 'Context review reminder',
  description: 'A compact, native-themed reminder above the message input. Review and compaction remain separate approvals.',
  register(ctx) {
    const restored = ctx.storage.get(STORAGE, {})
    choices.set(restored && typeof restored === 'object' && !Array.isArray(restored) ? restored : {})
    ctx.register({ id: 'composer-strip', area: COMPOSER_AREAS.top, order: -50, render: () => jsx(ContextStrip, { ctx }) })
    ctx.onEvent('tool.complete', event => {
      const data = event?.payload || {}
      const name = data.name || data.tool_name || data.tool
      if (name !== 'context_review') return
      const identity = readIdentity()
      // Follow a review after the user switches tiles, without crossing owner scopes.
      const known = Object.entries(choices.get()).filter(([, item]) =>
        [item.runtimeId, item.storedId].includes(event.session_id) && (!event.connection_id || event.connection_id === item.connectionId))
      let key = known.length === 1 ? known[0][0] : null
      if (!key && known.length === 0 && [identity.runtimeId, identity.storedId].includes(event.session_id) && (!event.connection_id || event.connection_id === identity.connectionId)) key = identity.key
      if (!key) return
      let result = data.result ?? data.output
      try { if (typeof result === 'string') result = JSON.parse(result) } catch { return }
      if (!result || typeof result !== 'object' || result.error) return
      const phase = result.phase || (data.args?.action === 'propose' && result.version ? 'proposed' : null)
      if (!['idle', 'reviewing', 'awaiting_answer', 'proposed', 'approved', 'paused', 'dismissed', 'applied'].includes(phase)) return
      const previous = choices.get()[key] || {}
      saveChoice(ctx, key, { ...previous, phase: phase === 'applied' ? 'idle' : phase, ...(phase === 'applied' ? { snoozeUntil: 0 } : {}) })
    })
    writeReceipt(ctx, 'registration.json', {
      registered: true, area: COMPOSER_AREAS.top,
      sdk: { focusedUsage: Boolean(host.state.focusedUsage), composerSubmit: typeof host.composer?.submit === 'function' },
    })
  },
}
