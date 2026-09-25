import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for Companion's InstanceBase. It keeps whatever the module
 * registers, so the test can inspect definitions and variable values and run
 * actions and feedbacks by id the way Companion would.
 */
vi.mock('@companion-module/base', () => {
	class InstanceBase {
		actions: Record<string, any> = {}
		feedbacks: Record<string, any> = {}
		variableDefinitions: Record<string, any> = {}
		presetStructure: any[] = []
		presets: Record<string, any> = {}
		values: Record<string, unknown> = {}
		checkedFeedbacks: string[] = []
		statuses: Array<{ status: string; message?: string | null }> = []

		constructor(_internal?: unknown) {}

		setActionDefinitions(definitions: Record<string, any>): void {
			this.actions = definitions
		}
		setFeedbackDefinitions(definitions: Record<string, any>): void {
			this.feedbacks = definitions
		}
		setVariableDefinitions(definitions: Record<string, any>): void {
			this.variableDefinitions = definitions
		}
		setPresetDefinitions(structure: any[], presets: Record<string, any>): void {
			this.presetStructure = structure
			this.presets = presets
		}
		setVariableValues(values: Record<string, unknown>): void {
			Object.assign(this.values, values)
		}
		checkFeedbacks(...ids: string[]): void {
			this.checkedFeedbacks.push(...ids)
		}
		checkAllFeedbacks(): void {
			this.checkedFeedbacks.push('*')
		}
		updateStatus(status: string, message?: string | null): void {
			this.statuses.push({ status, message })
		}
		log(_level: string, _message: string): void {}

		async runAction(actionId: string, options: Record<string, unknown> = {}): Promise<void> {
			const definition = this.actions[actionId]
			if (!definition) throw new Error(`No action ${actionId}`)
			await definition.callback({ id: `test-${actionId}`, actionId, controlId: 'test', options })
		}
		async runFeedback(feedbackId: string, options: Record<string, unknown> = {}): Promise<unknown> {
			const definition = this.feedbacks[feedbackId]
			if (!definition) throw new Error(`No feedback ${feedbackId}`)
			return definition.callback({ id: `test-${feedbackId}`, feedbackId, controlId: 'test', options })
		}
	}

	return {
		InstanceBase,
		InstanceStatus: {
			Ok: 'ok',
			Connecting: 'connecting',
			Disconnected: 'disconnected',
			ConnectionFailure: 'connection_failure',
			BadConfig: 'bad_config',
			AuthenticationFailure: 'authentication_failure',
		},
		Regex: { HOSTNAME: '/^.*$/' },
		combineRgb: (r: number, g: number, b: number) => ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff),
		ButtonGraphicsDecorationType: { FollowDefault: 'followDefault' },
	}
})

const { LiveMatrixInstance } = await import('../src/index.js')

type Message = Record<string, any>
type Mode = 'server' | 'client'
type MicPush = { device_id?: string | null; device_name?: string | null; holder_online?: boolean; muted?: boolean }

const RED = (255 << 16) | 0

const LOGIN_SUCCESS = {
	type: 'login_success',
	user_id: 'user-a',
	display_name: 'Alice',
	device_id: 'companion-1',
	keys: [
		{
			id: 'k1',
			target_type: 'user',
			target_id: 'user-b',
			display_name: 'Bob',
			can_listen: true,
			can_talk: true,
			allow_listen_latching: true,
			allow_talk_latching: true,
		},
	],
	available_users: [{ id: 'user-b', display_name: 'Bob', is_virtual: false, is_connected: true }],
}

const STATE_UPDATE = {
	type: 'state_update',
	state: {
		talk_active: {},
		listen_active: {},
		listen_level: {},
		party_line_talk_active: {},
		party_line_listen_active: {},
		party_line_listen_level: {},
	},
}

const INITIAL_MIC = {
	type: 'mic_state',
	device_id: 'desk-1',
	device_name: 'Desk',
	holder_online: true,
	muted: false,
	is_mine: false,
}

/**
 * Plays the livematrix server (`/ws`, answers a login) or the app's local
 * control API (`/`, greets straight away with no login). Both speak the same
 * protocol after that, so one fake covers both.
 */
class FakeLiveMatrix {
	readonly received: Message[] = []
	readonly paths: string[] = []
	private readonly wss: WebSocketServer
	private socket: ServerSocket | undefined
	private greeted = false

	constructor(readonly mode: Mode) {
		this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
		this.wss.on('connection', (socket, request) => {
			this.socket = socket
			this.paths.push(request.url ?? '')
			socket.on('message', (data) => {
				const message = JSON.parse(data.toString()) as Message
				this.received.push(message)
				if (message.type === 'login' && mode === 'server') this.greet()
			})
			if (mode === 'client') this.greet()
		})
	}

	async listening(): Promise<number> {
		if (!this.wss.address()) await new Promise((resolve) => this.wss.once('listening', resolve))
		return (this.wss.address() as AddressInfo).port
	}

	private greet(): void {
		this.push(LOGIN_SUCCESS)
		this.push(STATE_UPDATE)
		this.push(INITIAL_MIC)
		this.greeted = true
	}

	get isGreeted(): boolean {
		return this.greeted
	}

	push(message: Message): void {
		this.socket?.send(JSON.stringify(message))
	}

	sent(type: string): Message[] {
		return this.received.filter((message) => message.type === type)
	}

	async close(): Promise<void> {
		for (const client of this.wss.clients) client.terminate()
		await new Promise<void>((resolve) => this.wss.close(() => resolve()))
	}
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 2000
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

for (const mode of ['server', 'client'] as const) {
	describe(`mic mute over the ${mode} connection`, () => {
		let fake: FakeLiveMatrix
		let instance: any

		/** Wait until the fake has seen `count` messages of this type, and return the last. */
		async function lastSent(type: string, count: number): Promise<Message> {
			await waitFor(() => fake.sent(type).length >= count, `${count} × ${type}`)
			return fake.sent(type)[count - 1]
		}

		async function pushMic(mic: MicPush): Promise<void> {
			const micChecks = () => instance.checkedFeedbacks.filter((id: string) => id === 'mic_muted').length
			const before = micChecks()
			fake.push({ ...INITIAL_MIC, ...mic })
			await waitFor(() => micChecks() > before, 'mic_state to arrive')
		}

		beforeEach(async () => {
			fake = new FakeLiveMatrix(mode)
			const port = await fake.listening()
			instance = new LiveMatrixInstance({} as any)
			const config =
				mode === 'server'
					? {
							connection_mode: 'server',
							host: '127.0.0.1',
							port,
							username: 'alice',
							server_tls: false,
							client_host: '',
							client_port: 0,
							client_tls: false,
						}
					: {
							connection_mode: 'client',
							host: '',
							port: 0,
							username: '',
							server_tls: false,
							client_host: '127.0.0.1',
							client_port: port,
							client_tls: false,
						}
			await instance.init(config, true, mode === 'server' ? { password: 'secret' } : {})
			await waitFor(() => fake.isGreeted && instance.values.mic_device === 'Desk', 'the initial mic state')
		})

		afterEach(async () => {
			await instance.destroy()
			await fake.close()
		})

		it('connects the way this mode is meant to', () => {
			if (mode === 'server') {
				expect(fake.paths).toEqual(['/ws'])
				expect(fake.sent('login')).toEqual([{ type: 'login', username: 'alice', password: 'secret' }])
			} else {
				expect(fake.paths).toEqual(['/'])
				expect(fake.sent('login')).toEqual([])
			}
			expect(instance.statuses.at(-1).status).toBe('ok')
		})

		it('has nothing left of the audio mode', () => {
			const ids = [
				...Object.keys(instance.actions),
				...Object.keys(instance.feedbacks),
				...Object.keys(instance.variableDefinitions),
				...Object.keys(instance.presets),
				...instance.presetStructure.map((section: any) => section.id),
			]
			expect(ids.filter((id) => id.toLowerCase().includes('global'))).toEqual([])
			const presetText = JSON.stringify(instance.presets)
			expect(presetText).not.toContain('$(livematrix:global_mode)')
			expect(presetText.toLowerCase()).not.toContain('global')
		})

		it('defines the mic actions, feedbacks, variables and preset', () => {
			expect(Object.keys(instance.actions)).toEqual(expect.arrayContaining(['mic_mute', 'mic_unmute', 'mic_toggle']))
			expect(Object.keys(instance.feedbacks)).toEqual(expect.arrayContaining(['mic_muted', 'mic_live']))
			expect(Object.keys(instance.variableDefinitions)).toEqual(
				expect.arrayContaining(['mic_muted', 'mic_device', 'mic_holder_online', 'mic_error']),
			)
			expect(instance.feedbacks.mic_muted.defaultStyle.bgcolor).toBe(RED)

			const preset = instance.presets.mic_button
			expect(preset.style.text).toBe('MIC\n$(livematrix:mic_device)')
			expect(preset.steps[0].down).toEqual([{ actionId: 'mic_toggle', options: {} }])
			expect(preset.feedbacks).toEqual([
				expect.objectContaining({ feedbackId: 'mic_muted', style: expect.objectContaining({ bgcolor: RED }) }),
			])
			const sections = instance.presetStructure.filter((section: any) => section.definitions.includes('mic_button'))
			expect(sections).toHaveLength(1)
		})

		it('mutes and unmutes', async () => {
			await instance.runAction('mic_mute')
			expect(await lastSent('set_mic_muted', 1)).toEqual({ type: 'set_mic_muted', muted: true })
			await instance.runAction('mic_unmute')
			expect(await lastSent('set_mic_muted', 2)).toEqual({ type: 'set_mic_muted', muted: false })
		})

		it('resolves toggle from the last mic state', async () => {
			// Live on Desk: toggle mutes.
			await instance.runAction('mic_toggle')
			expect(await lastSent('set_mic_muted', 1)).toEqual({ type: 'set_mic_muted', muted: true })

			// Muted: toggle unmutes.
			await pushMic({ muted: true })
			await instance.runAction('mic_toggle')
			expect(await lastSent('set_mic_muted', 2)).toEqual({ type: 'set_mic_muted', muted: false })

			// Nobody holds the mic: toggle unmutes, even though the stored state says unmuted.
			await pushMic({ device_id: null, device_name: null, holder_online: false, muted: false })
			await instance.runAction('mic_toggle')
			expect(await lastSent('set_mic_muted', 3)).toEqual({ type: 'set_mic_muted', muted: false })

			// ... and even when it says muted.
			await pushMic({ device_id: null, device_name: null, holder_online: false, muted: true })
			await instance.runAction('mic_toggle')
			expect(await lastSent('set_mic_muted', 4)).toEqual({ type: 'set_mic_muted', muted: false })
		})

		it('never sends the removed messages or a toggle', async () => {
			for (const actionId of ['mic_mute', 'mic_unmute', 'mic_toggle', 'mic_toggle', 'mic_toggle']) {
				await instance.runAction(actionId)
			}
			await pushMic({ muted: true })
			await instance.runAction('mic_toggle')
			await lastSent('set_mic_muted', 6)

			const types = fake.received.map((message) => message.type)
			expect(types).not.toContain('set_global_mode')
			expect(types).not.toContain('set_global_active')
			expect(types.filter((type) => /toggle/i.test(String(type)))).toEqual([])
			for (const message of fake.sent('set_mic_muted')) {
				expect(Object.keys(message).sort()).toEqual(['muted', 'type'])
				expect(typeof message.muted).toBe('boolean')
			}
		})

		it('follows pushed mic states in variables and feedbacks', async () => {
			expect(instance.values).toMatchObject({ mic_muted: false, mic_device: 'Desk', mic_holder_online: true })
			expect(await instance.runFeedback('mic_muted')).toBe(false)
			expect(await instance.runFeedback('mic_live')).toBe(true)

			instance.checkedFeedbacks.length = 0
			await pushMic({ device_id: 'phone-1', device_name: 'Phone', holder_online: false, muted: true })
			expect(instance.values).toMatchObject({ mic_muted: true, mic_device: 'Phone', mic_holder_online: false })
			expect(instance.checkedFeedbacks).toEqual(expect.arrayContaining(['mic_muted', 'mic_live']))
			expect(await instance.runFeedback('mic_muted')).toBe(true)
			expect(await instance.runFeedback('mic_live')).toBe(false)

			await pushMic({ device_id: 'phone-1', device_name: 'Phone', holder_online: true, muted: false })
			expect(instance.values).toMatchObject({ mic_muted: false, mic_device: 'Phone', mic_holder_online: true })
			expect(await instance.runFeedback('mic_muted')).toBe(false)
			expect(await instance.runFeedback('mic_live')).toBe(true)

			// No holder reads as muted, whatever the stored flag says.
			await pushMic({ device_id: null, device_name: null, holder_online: false, muted: false })
			expect(instance.values).toMatchObject({ mic_muted: true, mic_device: '', mic_holder_online: false })
			expect(await instance.runFeedback('mic_muted')).toBe(true)
			expect(await instance.runFeedback('mic_live')).toBe(false)
		})

		it('shows no_mic_available until the next mic state', async () => {
			expect(instance.values.mic_error).toBe('')
			fake.push({ type: 'error', message: 'No device can take the mic', code: 'no_mic_available' })
			await waitFor(() => instance.values.mic_error === 'No device can take the mic', 'mic_error to be set')

			await pushMic({ muted: true })
			expect(instance.values.mic_error).toBe('')
		})
	})
}
