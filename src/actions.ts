import type { DeviceInfo } from './protocol.js'
import type { LivematrixInstance } from './index.js'
import { MAX_LISTEN_LEVEL_DB, MIN_LISTEN_LEVEL_DB } from './levels.js'
import {
	getAlsoSelectOption,
	getHoldSelectsOption,
	getKeySelectorOptions,
	getPressBehaviourOption,
	getSetModeOption,
	readPressBehaviour,
	readSetMode,
	type KeySelectorOptions,
	type PressBehaviour,
	type SetMode,
} from './options.js'

/** The move-mic choice that hands the mic on to whichever device comes after its holder. */
export const MIC_MOVE_NEXT = 'next'

/** A device as a person would pick it out: its name, and what it runs on. */
export function deviceLabel(device: DeviceInfo): string {
	const name = device.device_name || device.device_id
	return device.device_model && device.device_model !== device.device_name ? `${name} (${device.device_model})` : name
}

type NoOptions = Record<string, never>

type PressOptions = KeySelectorOptions & {
	press_behaviour: PressBehaviour
	hold_selects: boolean
	also_select: boolean
}

export type ActionsSchema = {
	select_key: { options: KeySelectorOptions }
	talk_down: { options: PressOptions }
	talk_up: { options: KeySelectorOptions & { press_behaviour: PressBehaviour } }
	talk_set: { options: KeySelectorOptions & { mode: SetMode } }
	listen_down: { options: PressOptions }
	listen_up: { options: KeySelectorOptions & { press_behaviour: PressBehaviour } }
	listen_set: { options: KeySelectorOptions & { mode: SetMode } }
	listen_level: { options: KeySelectorOptions & { level: number } }
	listen_level_delta: { options: KeySelectorOptions & { delta_db: number } }
	listen_level_hold: { options: KeySelectorOptions & { delta_db: number } }
	listen_level_hold_stop: { options: NoOptions }
	mic_mute: { options: NoOptions }
	mic_unmute: { options: NoOptions }
	mic_toggle: { options: NoOptions }
	mic_move: { options: { device: string } }
}

export function UpdateActions(self: LivematrixInstance): void {
	const keys = self.keys

	self.setActionDefinitions({
		select_key: {
			name: 'Select key',
			description: 'Make this the key that "selected key" actions and feedbacks act on',
			options: getKeySelectorOptions(keys),
			callback: async (action) => {
				const key = self.resolveKey(action.options)
				if (key) self.selectKey(key)
			},
		},
		talk_down: {
			name: 'Talk key down',
			options: [
				...getKeySelectorOptions(keys),
				getPressBehaviourOption(),
				getHoldSelectsOption(false),
				getAlsoSelectOption(),
			],
			callback: async (action) => {
				const key = self.resolveKey(action.options)
				if (!key) return
				self.applySelectOptions(action.controlId, key, action.options)
				self.onTalkDown(key, readPressBehaviour(action.options))
			},
		},
		talk_up: {
			name: 'Talk key up',
			options: [...getKeySelectorOptions(keys), getPressBehaviourOption()],
			callback: async (action) => {
				self.endSelectHold(action.controlId)
				const key = self.resolveKey(action.options)
				if (!key) return
				self.onTalkUp(key, readPressBehaviour(action.options))
			},
		},
		talk_set: {
			name: 'Talk set',
			options: [...getKeySelectorOptions(keys), getSetModeOption('mode')],
			callback: async (action) => {
				const key = self.resolveKey(action.options)
				const mode = readSetMode(action.options)
				if (key) self.onSetKeyMode(key, 'talk', mode)
			},
		},
		listen_down: {
			name: 'Listen key down',
			options: [
				...getKeySelectorOptions(keys),
				getPressBehaviourOption(),
				getHoldSelectsOption(true),
				getAlsoSelectOption(),
			],
			callback: async (action) => {
				const key = self.resolveKey(action.options)
				if (!key) return
				self.applySelectOptions(action.controlId, key, action.options)
				self.onListenDown(key, readPressBehaviour(action.options))
			},
		},
		listen_up: {
			name: 'Listen key up',
			options: [...getKeySelectorOptions(keys), getPressBehaviourOption()],
			callback: async (action) => {
				self.endSelectHold(action.controlId)
				const key = self.resolveKey(action.options)
				if (key) self.onListenUp(key, readPressBehaviour(action.options))
			},
		},
		listen_set: {
			name: 'Listen set',
			options: [...getKeySelectorOptions(keys), getSetModeOption('mode')],
			callback: async (action) => {
				const key = self.resolveKey(action.options)
				const mode = readSetMode(action.options)
				if (key) self.onSetKeyMode(key, 'listen', mode)
			},
		},
		listen_level: {
			name: 'Set listen level',
			options: [
				...getKeySelectorOptions(keys),
				{
					type: 'number',
					id: 'level',
					label: `Level dB (${MIN_LISTEN_LEVEL_DB} to +${MAX_LISTEN_LEVEL_DB})`,
					default: 0,
					min: MIN_LISTEN_LEVEL_DB,
					max: MAX_LISTEN_LEVEL_DB,
					step: 0.1,
					range: false,
				},
			],
			callback: async (action) => {
				const key = self.resolveKey(action.options)
				const levelDb = Number(action.options.level ?? 0)
				if (key) self.onListenLevelSetDb(key, levelDb)
			},
		},
		listen_level_delta: {
			name: 'Change listen level by dB',
			options: [
				...getKeySelectorOptions(keys),
				{
					type: 'number',
					id: 'delta_db',
					label: 'Delta dB',
					default: 1,
					min: -60,
					max: 60,
					step: 0.1,
					range: false,
				},
			],
			callback: async (action) => {
				const key = self.resolveKey(action.options)
				const deltaDb = Number(action.options.delta_db ?? 1)
				if (key) self.onListenLevelAdjustDb(key, deltaDb)
			},
		},
		listen_level_hold: {
			name: 'Change listen level while held',
			description:
				'Step the level once, then keep stepping for as long as the button is held. Put "Stop changing listen level" on the release.',
			options: [
				...getKeySelectorOptions(keys),
				{
					type: 'number',
					id: 'delta_db',
					label: 'Step dB',
					default: 1,
					min: -60,
					max: 60,
					step: 0.1,
					range: false,
				},
			],
			callback: async (action) => {
				const key = self.resolveKey(action.options)
				const deltaDb = Number(action.options.delta_db ?? 1)
				if (key) self.startLevelRepeat(action.controlId, key, deltaDb)
			},
		},
		listen_level_hold_stop: {
			name: 'Stop changing listen level',
			description: 'Ends a "Change listen level while held" started from this button',
			options: [],
			callback: async (action) => {
				self.stopLevelRepeat(action.controlId)
			},
		},
		mic_mute: {
			name: 'Mute microphone',
			description: 'Mute the mic on whichever device holds it',
			options: [],
			callback: async () => {
				self.onSetMicMuted(true)
			},
		},
		mic_unmute: {
			name: 'Unmute microphone',
			description:
				'Unmute the mic. If the device holding it is gone, the server hands it to the device that held it most recently.',
			options: [],
			callback: async () => {
				self.onSetMicMuted(false)
			},
		},
		mic_toggle: {
			name: 'Toggle microphone mute',
			description: 'Mute a live mic, or unmute a muted one',
			options: [],
			callback: async () => {
				self.onMicToggle()
			},
		},
		mic_move: {
			name: 'Move microphone to device',
			description:
				"Hand this user's mic to another of their devices, unmuted. This needs a direct server connection, because a client app's control API cannot move the mic.",
			options: [
				{
					type: 'dropdown',
					id: 'device',
					label: 'Device',
					default: MIC_MOVE_NEXT,
					choices: [
						{ id: MIC_MOVE_NEXT, label: 'Next device' },
						...self.micDevices().map((device) => ({
							id: device.device_id,
							label: deviceLabel(device),
						})),
					],
					// A device that is offline right now is still worth keeping
					// on the button: it moves the mic once the device is back.
					allowInvalidValues: true,
				},
			],
			callback: async (action) => {
				const device = action.options.device
				self.onMicMove(typeof device === 'string' ? device : MIC_MOVE_NEXT)
			},
		},
	})
}
