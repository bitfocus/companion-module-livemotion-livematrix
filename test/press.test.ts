import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	FakeLivematrix,
	LOGIN_SUCCESS,
	USER_KEY,
	emptyUserState,
	startInstance,
	waitFor,
	type Message,
} from './support/fake-livematrix.js'

vi.mock('@companion-module/base', async () => import('./support/companion-base.js'))

const { LivematrixInstance } = await import('../src/index.js')

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

type Key = typeof USER_KEY
type Layers = { latched: boolean; momentary: boolean }

const byTarget = (key: Key) => ({ selection_mode: 'target', key_target: `${key.target_type}:${key.target_id}` })
const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Both layers of one half of a key, as the server would hold them after every
 * message the module sent: `latched` set by latched writes, `momentary` by
 * presses and their releases, and replaced wholesale by each heartbeat.
 */
function serverLayers(received: Message[], key: Key, field: 'talk' | 'listen'): Layers {
	const layers: Layers = { latched: false, momentary: false }
	const isKey = (ref: Message) => ref.target_type === key.target_type && ref.target_id === key.target_id
	for (const message of received) {
		if (message.type === 'set_key_state' && isKey(message.key) && message.field === field) {
			if (message.hold === 'latched') layers.latched = message.active
			else layers.momentary = message.active
		} else if (message.type === 'momentary_heartbeat') {
			layers.momentary = message.held.some((hold: Message) => isKey(hold.key) && hold[field])
		}
	}
	return layers
}

describe('releasing a press', () => {
	let fake: FakeLivematrix
	let instance: any

	beforeEach(async () => {
		fake = new FakeLivematrix('server', {
			loginSuccess: { ...LOGIN_SUCCESS, keys: [USER_KEY, FEED_KEY, GROUP_KEY] },
		})
		instance = await startInstance(LivematrixInstance, fake)
		await waitFor(() => instance.values.key_count === 3, 'the keys')
	})

	afterEach(async () => {
		await instance.destroy()
		await fake.close()
	})

	/** Press and release one half of a key the way the presets do, holding it for `holdMs`. */
	async function press(key: Key, field: 'talk' | 'listen', holdMs: number): Promise<void> {
		const options = { ...byTarget(key), press_behaviour: 'auto', double_tap_listen: true }
		await instance.runAction(`${field}_down`, options)
		await sleep(holdMs)
		await instance.runAction(`${field}_up`, options)
		// Past the double-tap window, so the release has settled and a second
		// press is a fresh tap rather than half of a double tap.
		await sleep(500)
	}

	async function layers(key: Key, field: 'talk' | 'listen'): Promise<Layers> {
		// Let anything the module sent reach the fake.
		await sleep(30)
		return serverLayers(fake.received, key, field)
	}

	it.each([
		['a listen key', FEED_KEY, 'listen', 80],
		['a group talk key', GROUP_KEY, 'talk', 80],
		['a talk key tapped quickly', USER_KEY, 'talk', 60],
		['a talk key tapped at an ordinary pace', USER_KEY, 'talk', 200],
	] as const)('latches and unlatches %s on the server', async (_name, key, field, holdMs) => {
		await press(key, field, holdMs)
		expect(await layers(key, field)).toEqual({ latched: true, momentary: false })

		await press(key, field, holdMs)
		expect(await layers(key, field)).toEqual({ latched: false, momentary: false })
		expect(await instance.runFeedback(`${field}_active`, byTarget(key))).toBe(false)
	})

	it('holds an unlatched key as a press and lets go of it on release', async () => {
		const options = { ...byTarget(USER_KEY), press_behaviour: 'auto', double_tap_listen: true }
		await instance.runAction('talk_down', options)
		await sleep(400)
		expect(await layers(USER_KEY, 'talk')).toEqual({ latched: false, momentary: true })

		await instance.runAction('talk_up', options)
		expect(await layers(USER_KEY, 'talk')).toEqual({ latched: false, momentary: false })
		expect(fake.sent('set_key_state').filter((message) => message.hold === 'latched')).toEqual([])
	})

	it('keeps group talk across snapshots from an app that leaves it out', async () => {
		// Older client apps relay every map but group talk.
		const { group_talk_active: _omitted, ...withoutGroups } = emptyUserState()
		const relay = () => fake.push({ type: 'state_update', state: withoutGroups, latched: withoutGroups })

		await press(GROUP_KEY, 'talk', 80)
		relay()
		await sleep(30)
		expect(await instance.runFeedback('talk_latched', byTarget(GROUP_KEY))).toBe(true)

		await press(GROUP_KEY, 'talk', 80)
		relay()
		expect(await layers(GROUP_KEY, 'talk')).toEqual({ latched: false, momentary: false })
		expect(await instance.runFeedback('talk_active', byTarget(GROUP_KEY))).toBe(false)
	})

	it('leaves a latched key latched after a long hold', async () => {
		await press(FEED_KEY, 'listen', 80)
		await press(FEED_KEY, 'listen', 400)
		expect(await layers(FEED_KEY, 'listen')).toEqual({ latched: true, momentary: false })
		expect(await instance.runFeedback('listen_active', byTarget(FEED_KEY))).toBe(true)
	})
})
