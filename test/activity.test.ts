import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeLiveMatrix, LOGIN_SUCCESS, USER_KEY, startInstance, waitFor } from './support/fake-livematrix.js'

vi.mock('@companion-module/base', async () => import('./support/companion-base.js'))

const { LiveMatrixInstance } = await import('../src/index.js')
const { getPresetDefinitions } = await import('../src/presets.js')
const { AUDIO_TRAIL_MS } = await import('../src/activity.js')

const LINE_KEY = {
	...USER_KEY,
	id: 'k2',
	target_type: 'party_line',
	target_id: 'line-main',
	display_name: 'Main',
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

const byTarget = (key: { target_type: string; target_id: string }) => ({
	selection_mode: 'target',
	key_target: `${key.target_type}:${key.target_id}`,
})

const BOB = { user_id: 'user-b', display_name: 'Bob' }
const CAROL = { user_id: 'user-c', display_name: 'Carol' }

describe.each(['server', 'client'] as const)('incoming activity over the %s connection', (mode) => {
	let fake: FakeLiveMatrix
	let instance: any

	beforeEach(async () => {
		fake = new FakeLiveMatrix(mode, {
			loginSuccess: {
				...LOGIN_SUCCESS,
				keys: [USER_KEY, LINE_KEY, GROUP_KEY],
				groups: [{ id: 'group-crew', name: 'Crew', member_ids: ['user-c'] }],
			},
		})
		instance = await startInstance(LiveMatrixInstance, fake)
		await waitFor(() => instance.values.key_count === 3, 'the keys')
	})

	afterEach(async () => {
		vi.useRealTimers()
		await instance.destroy()
		await fake.close()
	})

	async function pushActivity(activity: Record<string, unknown>): Promise<void> {
		instance.checkedFeedbacks.length = 0
		fake.push({ type: 'activity_update', talking_to_me: [], listening_to_me: [], ...activity })
		await waitFor(() => instance.checkedFeedbacks.includes('audio_arriving'), 'the activity')
	}

	it('lights the talk half for whoever the key reaches that is listening', async () => {
		expect(await instance.runFeedback('listening_to_me', byTarget(USER_KEY))).toBe(false)

		await pushActivity({ listening_to_me: [BOB] })
		expect(await instance.runFeedback('listening_to_me', byTarget(USER_KEY))).toBe(true)
		expect(await instance.runFeedback('listening_to_me', byTarget(GROUP_KEY))).toBe(false)
		// Nobody listens to a party line on our behalf.
		expect(await instance.runFeedback('listening_to_me', byTarget(LINE_KEY))).toBe(false)

		// A group key stands for its members.
		await pushActivity({ listening_to_me: [CAROL] })
		expect(await instance.runFeedback('listening_to_me', byTarget(USER_KEY))).toBe(false)
		expect(await instance.runFeedback('listening_to_me', byTarget(GROUP_KEY))).toBe(true)
	})

	it('lights the listen half while audio arrives, then trails it for a minute', async () => {
		await pushActivity({ audible_users: ['user-b'], audible_party_lines: ['line-main'] })
		expect(await instance.runFeedback('audio_arriving', byTarget(USER_KEY))).toBe(true)
		expect(await instance.runFeedback('audio_arriving', byTarget(LINE_KEY))).toBe(true)
		expect(await instance.runFeedback('audio_recent', byTarget(USER_KEY))).toBe(false)

		// Advancing with real time too, so waiting on the socket still works.
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
		await pushActivity({ audible_party_lines: ['line-main'] })
		expect(await instance.runFeedback('audio_arriving', byTarget(USER_KEY))).toBe(false)
		expect(await instance.runFeedback('audio_recent', byTarget(USER_KEY))).toBe(true)
		expect(await instance.runFeedback('audio_recent', byTarget(LINE_KEY))).toBe(false)

		instance.checkedFeedbacks.length = 0
		vi.advanceTimersByTime(AUDIO_TRAIL_MS)
		expect(instance.checkedFeedbacks).toContain('audio_recent')
		expect(await instance.runFeedback('audio_recent', byTarget(USER_KEY))).toBe(false)
	})

	it('puts every stripe out when the connection drops', async () => {
		await pushActivity({ listening_to_me: [BOB], audible_users: ['user-b'] })
		instance.checkedFeedbacks.length = 0
		fake.drop()
		await waitFor(() => instance.checkedFeedbacks.includes('listening_to_me'), 'the drop')
		expect(await instance.runFeedback('listening_to_me', byTarget(USER_KEY))).toBe(false)
		expect(await instance.runFeedback('audio_arriving', byTarget(USER_KEY))).toBe(false)
		expect(await instance.runFeedback('audio_recent', byTarget(USER_KEY))).toBe(false)
	})

	it('draws the stripe on the outer edge of each half in the key presets', () => {
		const { presets } = getPresetDefinitions([USER_KEY])
		const ids = (preset: any) => preset.feedbacks.map((feedback: any) => feedback.feedbackId)
		expect(ids(presets['key_by_target'])).toEqual(
			expect.arrayContaining(['listening_to_me', 'audio_arriving', 'audio_recent']),
		)
		expect(ids(presets['talk_by_target'])).toContain('listening_to_me')
		expect(ids(presets['listen_by_target'])).toEqual(expect.arrayContaining(['audio_arriving', 'audio_recent']))

		const element = (preset: any, id: string) => preset.elements.find((e: any) => e.id === id)
		expect(element(presets['key_by_target'], 'listen-incoming')).toMatchObject({ x: 0, enabled: false })
		expect(element(presets['key_by_target'], 'talk-incoming').x).toBeGreaterThan(50)
	})
})
