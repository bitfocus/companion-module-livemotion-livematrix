import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	FakeLiveMatrix,
	LOGIN_SUCCESS,
	USER_KEY,
	emptyUserState,
	startInstance,
	waitFor,
} from './support/fake-livematrix.js'

vi.mock('@companion-module/base', () => import('./support/companion-base.js'))

const { LiveMatrixInstance } = await import('../src/index.js')

const FEED_KEY = {
	...USER_KEY,
	id: 'k2',
	target_type: 'feed',
	target_id: 'line-program',
	display_name: 'Program',
	can_talk: false,
}
const GROUP_KEY = {
	...USER_KEY,
	id: 'k3',
	target_type: 'group',
	target_id: 'group-crew',
	display_name: 'Crew',
	can_listen: false,
	allow_listen_latching: false,
}
const LINE_KEY = {
	...USER_KEY,
	id: 'k4',
	target_type: 'party_line',
	target_id: 'line-main',
	display_name: 'Main',
}

const byTarget = (key: { target_type: string; target_id: string }) => ({
	selection_mode: 'target',
	key_target: `${key.target_type}:${key.target_id}`,
})

describe('keys of every kind', () => {
	let fake: FakeLiveMatrix
	let instance: any

	beforeEach(async () => {
		fake = new FakeLiveMatrix('server', {
			loginSuccess: { ...LOGIN_SUCCESS, keys: [USER_KEY, FEED_KEY, GROUP_KEY, LINE_KEY] },
		})
		instance = await startInstance(LiveMatrixInstance, fake)
		await waitFor(() => instance.values.key_count === 4, 'the keys')
	})

	afterEach(async () => {
		await instance.destroy()
		await fake.close()
	})

	/** Push a state where every map is as given, latched and effective alike. */
	async function pushState(state: Record<string, Record<string, unknown>>, latched = state): Promise<void> {
		const before = instance.checkedFeedbacks.filter((id: string) => id === '*').length
		fake.push({
			type: 'state_update',
			state: { ...emptyUserState(), ...state },
			latched: { ...emptyUserState(), ...latched },
		})
		await waitFor(() => instance.checkedFeedbacks.filter((id: string) => id === '*').length > before, 'the state')
	}

	it('reads a feed from the line maps', async () => {
		await pushState({
			party_line_listen_active: { 'line-program': true },
			party_line_listen_level: { 'line-program': 0.5 },
		})
		expect(await instance.runFeedback('listen_active', byTarget(FEED_KEY))).toBe(true)
		expect(await instance.runFeedback('listen_latched', byTarget(FEED_KEY))).toBe(true)
		expect(await instance.runFeedback('key_listen_level_db', byTarget(FEED_KEY))).toBeCloseTo(-6, 0)
		expect(instance.values.key_1_listen).toBe(true)
		expect(instance.values.key_1_listen_mode).toBe('latched')
	})

	it('switches a latched feed off with a toggle', async () => {
		await pushState({ party_line_listen_active: { 'line-program': true } })
		await instance.runAction('listen_set', { ...byTarget(FEED_KEY), mode: 'toggle' })
		await waitFor(() => fake.sent('set_key_state').length >= 1, 'the key state')
		expect(fake.sent('set_key_state').at(-1)).toEqual({
			type: 'set_key_state',
			key: { target_type: 'feed', target_id: 'line-program' },
			field: 'listen',
			hold: 'latched',
			active: false,
		})
	})

	it('reads group talk from its own map', async () => {
		await pushState({ group_talk_active: { 'group-crew': true } })
		expect(await instance.runFeedback('talk_active', byTarget(GROUP_KEY))).toBe(true)
		expect(await instance.runFeedback('talk_latched', byTarget(GROUP_KEY))).toBe(true)
		expect(instance.values.key_2_talk_mode).toBe('latched')

		await instance.runAction('talk_set', { ...byTarget(GROUP_KEY), mode: 'toggle' })
		await waitFor(() => fake.sent('set_key_state').length >= 1, 'the key state')
		expect(fake.sent('set_key_state').at(-1)).toMatchObject({
			key: { target_type: 'group', target_id: 'group-crew' },
			field: 'talk',
			active: false,
		})
	})

	it('tells held from latched on a group', async () => {
		await pushState({ group_talk_active: { 'group-crew': true } }, { group_talk_active: {} })
		expect(await instance.runFeedback('talk_momentary', byTarget(GROUP_KEY))).toBe(true)
		expect(await instance.runFeedback('talk_latched', byTarget(GROUP_KEY))).toBe(false)
	})

	it('keeps users and party lines apart from each other', async () => {
		await pushState({
			talk_active: { 'user-b': true },
			party_line_listen_active: { 'line-main': true },
		})
		expect(await instance.runFeedback('talk_active', byTarget(USER_KEY))).toBe(true)
		expect(await instance.runFeedback('listen_active', byTarget(USER_KEY))).toBe(false)
		expect(await instance.runFeedback('talk_active', byTarget(LINE_KEY))).toBe(false)
		expect(await instance.runFeedback('listen_active', byTarget(LINE_KEY))).toBe(true)
		expect(await instance.runFeedback('talk_active', byTarget(GROUP_KEY))).toBe(false)
	})
})
