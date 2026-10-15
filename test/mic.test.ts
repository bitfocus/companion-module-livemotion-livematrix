import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeLiveMatrix, INITIAL_MIC, startInstance, waitFor, type Message } from './support/fake-livematrix.js'

vi.mock('@companion-module/base', () => import('./support/companion-base.js'))

const { LiveMatrixInstance } = await import('../src/index.js')

type MicPush = {
	device_id?: string | null
	device_name?: string | null
	holder_online?: boolean
	muted?: boolean
	open?: boolean
}

const RED = (255 << 16) | 0

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
			instance = await startInstance(LiveMatrixInstance, fake)
			await waitFor(() => fake.isGreeted && instance.values.mic_device === 'Desk', 'the initial mic state')
		})

		afterEach(async () => {
			await instance.destroy()
			await fake.close()
		})

		it('connects the way this mode is meant to', () => {
			if (mode === 'server') {
				expect(fake.paths).toEqual(['/ws'])
				expect(fake.sent('login')).toEqual([
					{ type: 'login', username: 'alice', password: 'secret', device_id: 'companion-conn-1' },
				])
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
				expect.arrayContaining(['mic_muted', 'mic_open', 'mic_device', 'mic_holder_online', 'mic_error']),
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
			await pushMic({ device_id: 'phone-1', device_name: 'Phone', holder_online: false, muted: true, open: false })
			expect(instance.values).toMatchObject({ mic_muted: true, mic_device: 'Phone', mic_holder_online: false })
			expect(instance.checkedFeedbacks).toEqual(expect.arrayContaining(['mic_muted', 'mic_live']))
			expect(await instance.runFeedback('mic_muted')).toBe(true)
			expect(await instance.runFeedback('mic_live')).toBe(false)

			await pushMic({ device_id: 'phone-1', device_name: 'Phone', holder_online: true, muted: false })
			expect(instance.values).toMatchObject({ mic_muted: false, mic_device: 'Phone', mic_holder_online: true })
			expect(await instance.runFeedback('mic_muted')).toBe(false)
			expect(await instance.runFeedback('mic_live')).toBe(true)

			// No holder reads as muted, whatever the stored flag says.
			await pushMic({ device_id: null, device_name: null, holder_online: false, muted: false, open: false })
			expect(instance.values).toMatchObject({ mic_muted: true, mic_device: '', mic_holder_online: false })
			expect(await instance.runFeedback('mic_muted')).toBe(true)
			expect(await instance.runFeedback('mic_live')).toBe(false)
		})

		it('shows a talk key held through the mute as live but still muted', async () => {
			await pushMic({ muted: true, open: true })
			expect(instance.values).toMatchObject({ mic_muted: true, mic_open: true })
			expect(await instance.runFeedback('mic_muted')).toBe(true)
			expect(await instance.runFeedback('mic_live')).toBe(true)

			// Toggle follows the mute, not the open gate: a muted mic gets unmuted.
			await instance.runAction('mic_toggle')
			expect(await lastSent('set_mic_muted', 1)).toEqual({ type: 'set_mic_muted', muted: false })

			await pushMic({ muted: true, open: false })
			expect(instance.values).toMatchObject({ mic_muted: true, mic_open: false })
			expect(await instance.runFeedback('mic_live')).toBe(false)
		})

		it('reads a mic state without `open` as open exactly when unmuted', async () => {
			const { open: _open, ...legacy } = INITIAL_MIC
			const checks = () => instance.checkedFeedbacks.filter((id: string) => id === 'mic_muted').length
			const before = checks()
			fake.push({ ...legacy, muted: true })
			await waitFor(() => checks() > before, 'mic_state to arrive')
			expect(instance.values).toMatchObject({ mic_muted: true, mic_open: false })
		})

		/** What the server sends for an unmute nobody can take: the error, then the unchanged state. */
		async function refuseUnmute(): Promise<void> {
			fake.push({ type: 'error', message: 'No device can take the mic', code: 'no_mic_available' })
			await pushMic({ device_id: null, device_name: null, holder_online: false, muted: true, open: false })
		}

		it('keeps no_mic_available through the mic state the server sends behind it', async () => {
			await pushMic({ device_id: null, device_name: null, holder_online: false, muted: true, open: false })
			expect(instance.values.mic_error).toBe('')

			await refuseUnmute()
			expect(instance.values.mic_error).toBe('No device can take the mic')
		})

		it('clears no_mic_available once a device holds the mic', async () => {
			await refuseUnmute()
			await pushMic({ muted: false })
			expect(instance.values.mic_error).toBe('')
		})

		it('clears no_mic_available when the mic is tried again', async () => {
			await refuseUnmute()
			await instance.runAction('mic_unmute')
			expect(instance.values.mic_error).toBe('')
			await waitFor(() => fake.sent('set_mic_muted').length > 0, 'the unmute')
			expect(fake.sent('set_mic_muted').at(-1)).toMatchObject({ muted: false })
		})
	})
}
