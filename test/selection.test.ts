import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeLiveMatrix, LOGIN_SUCCESS, USER_KEY, startInstance, waitFor } from './support/fake-livematrix.js'

vi.mock('@companion-module/base', async () => import('./support/companion-base.js'))

const { LiveMatrixInstance } = await import('../src/index.js')
const { UpgradeScripts } = await import('../src/upgrades.js')

const LINE_KEY = {
	...USER_KEY,
	id: 'k2',
	target_type: 'party_line',
	target_id: 'line-main',
	display_name: 'Main',
}

type Key = typeof USER_KEY
const byTarget = (key: Key) => ({ selection_mode: 'target', key_target: `${key.target_type}:${key.target_id}` })
const SELECTED = { selection_mode: 'selected' }
const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Long enough that a press is plainly being held. */
const HOLD_MS = 350

describe('selecting a key by holding it', () => {
	let fake: FakeLiveMatrix
	let instance: any

	beforeEach(async () => {
		fake = new FakeLiveMatrix('server', { loginSuccess: { ...LOGIN_SUCCESS, keys: [USER_KEY, LINE_KEY] } })
		instance = await startInstance(LiveMatrixInstance, fake)
		await waitFor(() => instance.values.key_count === 2, 'the keys')
	})

	afterEach(async () => {
		await instance.destroy()
		await fake.close()
	})

	const selectedName = () => instance.runFeedback('key_name', SELECTED)
	const found = () => instance.runFeedback('key_found', SELECTED)

	function listenKey(key: Key, controlId: string) {
		const options = { ...byTarget(key), press_behaviour: 'auto', hold_selects: true, also_select: false }
		return {
			down: () => instance.runAction('listen_down', options, controlId),
			up: () => instance.runAction('listen_up', options, controlId),
		}
	}

	function talkKey(key: Key, controlId: string, holdSelects: boolean) {
		const options = { ...byTarget(key), press_behaviour: 'auto', hold_selects: holdSelects, also_select: false }
		return {
			down: () => instance.runAction('talk_down', options, controlId),
			up: () => instance.runAction('talk_up', { ...options, double_tap_listen: holdSelects }, controlId),
		}
	}

	it('starts with nothing selected', async () => {
		expect(await found()).toBe(false)
		expect(instance.values.selected_key_name).toBe('')
	})

	it('selects a held listen key only while it is held', async () => {
		const key = listenKey(LINE_KEY, 'listen-main')
		await key.down()
		await sleep(HOLD_MS)
		expect(await selectedName()).toBe('Main')
		expect(instance.values.selected_key_name).toBe('Main')

		await key.up()
		expect(await found()).toBe(false)
	})

	it('selects on the press itself, and lets go with a tap', async () => {
		const key = listenKey(LINE_KEY, 'listen-main')
		await key.down()
		expect(await selectedName()).toBe('Main')
		await key.up()
		expect(await found()).toBe(false)
	})

	it('selects a held combined key, but never a talk key', async () => {
		const talk = talkKey(LINE_KEY, 'talk-main', false)
		await talk.down()
		await sleep(HOLD_MS)
		expect(await found()).toBe(false)
		await talk.up()

		const combined = talkKey(USER_KEY, 'combined-bob', true)
		await combined.down()
		await sleep(HOLD_MS)
		expect(await selectedName()).toBe('Bob')
		await combined.up()
		expect(await found()).toBe(false)
	})

	it('follows the most recent of two held keys', async () => {
		const bob = listenKey(USER_KEY, 'listen-bob')
		const main = listenKey(LINE_KEY, 'listen-main')
		await bob.down()
		await sleep(HOLD_MS)
		await main.down()
		await sleep(HOLD_MS)
		expect(await selectedName()).toBe('Main')

		await main.up()
		expect(await selectedName()).toBe('Bob')
		await bob.up()
		expect(await found()).toBe(false)
	})

	it('goes back to a key chosen with Select key once the hold ends', async () => {
		await instance.runAction('select_key', byTarget(USER_KEY))
		const main = listenKey(LINE_KEY, 'listen-main')
		await main.down()
		await sleep(HOLD_MS)
		expect(await selectedName()).toBe('Main')
		await main.up()
		expect(await selectedName()).toBe('Bob')
	})

	it('leaves the level alone when the volume keys have nothing to act on', async () => {
		await instance.runAction('listen_level_hold', { ...SELECTED, delta_db: 1 }, 'volume-up')
		await instance.runAction('listen_level_delta', { ...SELECTED, delta_db: 1 })
		await sleep(500)
		await instance.runAction('listen_level_hold_stop', {}, 'volume-up')
		expect(fake.sent('set_key_level')).toEqual([])
	})
})

describe('upgrading buttons from before hold to select', () => {
	const value = (v: unknown) => ({ isExpression: false, value: v })
	const action = (controlId: string, actionId: string, options: Record<string, unknown>) => ({
		id: `${controlId}-${actionId}`,
		controlId,
		actionId,
		options,
	})

	it('makes combined keys select while held, and talk keys not at all', () => {
		const actions = [
			action('combined', 'talk_down', { also_select: value(true) }),
			action('combined', 'talk_up', { double_tap_listen: value(true) }),
			action('talk', 'talk_down', { also_select: value(true) }),
			action('talk', 'talk_up', { double_tap_listen: value(false) }),
			action('listen', 'listen_down', { also_select: value(false), long_press_selects: value(true) }),
			action('listen', 'listen_up', { long_press_selects: value(true) }),
		]
		const result = UpgradeScripts[0]({ currentConfig: {} as any }, {
			config: null,
			secrets: null,
			actions,
			feedbacks: [],
		} as any)

		const options = (controlId: string, actionId: string) =>
			result.updatedActions.find((a) => a.controlId === controlId && a.actionId === actionId)?.options
		expect(options('combined', 'talk_down')).toMatchObject({ also_select: value(false), hold_selects: value(true) })
		expect(options('talk', 'talk_down')).toMatchObject({ also_select: value(false), hold_selects: value(false) })
		expect(options('listen', 'listen_down')).toEqual({ also_select: value(false), hold_selects: value(true) })
		expect(options('listen', 'listen_up')).toEqual({})
	})
})
