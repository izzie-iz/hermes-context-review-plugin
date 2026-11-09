import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = new URL('../ui/plugin.js', import.meta.url)
async function load() {
  const subscriptions = []
  const host = { state: {}, onEvent: (name, fn) => { subscriptions.push([name, fn]); return () => {} }, composer: {}, notify: () => {} }
  const atom = value => ({ get: () => value, set: next => { value = next }, subscribe: () => () => {} })
  const sdk = { host, atom, useValue: value => value.get(), Button: 'button', Tip: 'span', COMPOSER_AREAS: { top: 'composer.top' } }
  const react = { useEffect: () => {}, useLayoutEffect: () => {}, useRef: value => ({ current: value }), useState: value => [typeof value === 'function' ? value() : value, () => {}] }
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  const context = vm.createContext({ console, Date, Number, Math, JSON, Map, Set, requestAnimationFrame: fn => fn(), cancelAnimationFrame: () => {}, getComputedStyle: () => ({}) })
  const module = new vm.SourceTextModule(await readFile(source, 'utf8'), { context })
  const stubs = { '@hermes/plugin-sdk': sdk, react, 'react/jsx-runtime': jsx }
  await module.link(async name => {
    assert.ok(name in stubs, `Unsupported dependency: ${name}`)
    const values = stubs[name]
    const stub = new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value) }, { context })
    await stub.evaluate()
    return stub
  })
  await module.evaluate()
  return { api: module.namespace, host, subscriptions }
}

const atom = value => ({ get: () => value })
function fakeHost() {
  const calls = []
  const state = {
    focusedSessionId: atom('runtime-A'), focusedStoredSessionId: atom('stored-A'),
    focusedSessionProfile: atom('default'), focusedSessionOwner: atom({ connectionId: 'local', profile: 'default' }),
    connectionId: atom('local'), busy: atom(false),
  }
  return { state, calls, composer: { getDraft: async () => '', submit: (sid, text) => { calls.push([sid, text]); return true } } }
}

test('uses active usage only and adapts to the model window', async () => {
  const { api } = await load()
  assert.equal(api.reminderView({ total: 900000, input: 900000 }, {}).visible, false)
  assert.equal(api.reminderView({ context_used: 249999, context_max: 500000 }, {}).visible, false)
  assert.equal(api.reminderView({ context_used: 250000, context_max: 500000 }, {}).visible, true)
  assert.equal(api.reminderView({ context_used: 300000, context_max: 500000 }, {}).level, 2)
  assert.equal(api.reminderView({ context_used: 120000, context_max: 200000 }, {}).visible, true)
  assert.equal(api.reminderView({ context_used: NaN, context_max: 500000 }, {}).visible, false)
  assert.equal(api.reminderView({ context_used: 300000 }, {}).visible, false)
})

test('Later snoozes by active-context growth, and active review suppresses the strip', async () => {
  const { api } = await load()
  const usage = { context_used: 280000, context_max: 500000 }
  const snoozed = api.snoozePreference(usage, {})
  assert.equal(snoozed.snoozeUntil, 305000)
  assert.equal(api.reminderView(usage, snoozed).visible, false)
  assert.equal(api.reminderView({ ...usage, context_used: 305000 }, snoozed).visible, true)
  assert.equal(api.reminderView(usage, { phase: 'reviewing' }).visible, false)
  assert.equal(api.reminderView(usage, { phase: 'proposed' }).visible, false)
  assert.equal(api.reminderView(usage, { dismissed: true }).visible, false)
})

test('preferences are connection/profile/chat scoped and multi-pane routing is exact', async () => {
  const { api } = await load()
  assert.notEqual(api.preferenceKey('local', 'default', 'A'), api.preferenceKey('local', 'research-qa', 'A'))
  assert.notEqual(api.preferenceKey('local', 'default', 'A'), api.preferenceKey('remote', 'default', 'A'))
  const ids = { focusedRuntimeId: 'run-A', focusedStoredId: 'A', activeRuntimeId: 'run-B' }
  assert.equal(api.surfaceMatches('tile:A', ids), true)
  assert.equal(api.surfaceMatches('tile:B', ids), false)
  assert.equal(api.surfaceMatches('main', ids), false)
  assert.equal(api.surfaceMatches('main', { ...ids, activeRuntimeId: 'run-A' }), true)
  assert.equal(api.surfaceMatches('', ids), false)
})

test('Review now sends review consent only to the pinned composer', async () => {
  const { api } = await load()
  const host = fakeHost()
  const expected = api.readIdentity(host)
  const result = await api.beginReview(host, expected)
  assert.equal(result.ok, true)
  assert.equal(host.calls.length, 1)
  assert.equal(host.calls[0][0], 'runtime-A')
  assert.match(host.calls[0][1], /one specific question/i)
  assert.match(host.calls[0][1], /does not approve compaction/i)
  assert.doesNotMatch(host.calls[0][1], /approve context cleanup [a-f0-9]+/)
})

test('Review now preserves drafts, waits while busy, and refuses changed focus', async () => {
  const { api } = await load()
  const busy = fakeHost(); busy.state.busy = atom(true)
  assert.equal((await api.beginReview(busy, api.readIdentity(busy))).reason, 'busy')
  const draft = fakeHost(); draft.composer.getDraft = async () => 'Unsent user work'
  assert.equal((await api.beginReview(draft, api.readIdentity(draft))).reason, 'draft')
  const switched = fakeHost(); const before = api.readIdentity(switched)
  switched.composer.getDraft = async () => { switched.state.focusedSessionId = atom('run-B'); return '' }
  assert.equal((await api.beginReview(switched, before)).reason, 'focus_changed')
  assert.equal(switched.calls.length, 0)
  const missing = fakeHost(); missing.composer.getDraft = async () => null
  assert.equal((await api.beginReview(missing, api.readIdentity(missing))).reason, 'composer_unavailable')
})

test('completed review re-arms after a real compaction, not ordinary token churn', async () => {
  const { api } = await load()
  const pref = { phase: 'reviewing', contextAtReview: 280000, compressionsAtReview: 1 }
  assert.equal(api.reconcilePreference({ context_used: 50000, context_max: 500000, compressions: 2 }, pref).phase, 'idle')
  assert.equal(api.reconcilePreference({ context_used: 290000, context_max: 500000, compressions: 1 }, pref).phase, 'reviewing')
})

test('a review result updates its own chat after focus moves elsewhere', async () => {
  const { api, host } = await load()
  host.state = fakeHost().state
  host.state.focusedSessionId = atom('other-runtime')
  host.state.focusedStoredSessionId = atom('other-stored')
  const key = api.preferenceKey('local', 'default', 'stored-A')
  const initial = { [key]: { phase: 'requested', runtimeId: 'runtime-A', storedId: 'stored-A', connectionId: 'local', profile: 'default' } }
  let saved = null, listener = null
  const ctx = { register: () => {}, storage: { get: () => initial, set: (_key, value) => { saved = value } }, onEvent: (_type, callback) => { listener = callback }, files: { dataFolder: 'data', writeText: async () => ({ ok: true }) } }
  api.default.register(ctx)
  listener({ session_id: 'runtime-A', payload: { name: 'context_review', result: '{"phase":"reviewing"}' } })
  assert.equal(saved?.[key]?.phase, 'reviewing')
  assert.equal(Object.keys(saved).length, 1)
})

test('registers the native composer slot and uses only native colors', async () => {
  const { api } = await load()
  const contributions = []
  const ctx = { register: item => contributions.push(item), storage: { get: (_k, fallback) => fallback, set: () => {} }, onEvent: () => () => {}, files: { dataFolder: 'data', writeText: async () => ({ ok: true }) } }
  api.default.register(ctx)
  assert.ok(contributions.some(item => item.area === 'composer.top'))
  const code = await readFile(source, 'utf8')
  assert.doesNotMatch(code, /#[\da-f]{3,8}\b|rgba?\(/i)
  assert.match(code, /var\(--ui-accent\)/)
  assert.match(code, /var\(--ui-bg-editor\)/)
  assert.doesNotMatch(code, /setInterval|window\.hermesDesktop|\.innerHTML\s*=/)
})
