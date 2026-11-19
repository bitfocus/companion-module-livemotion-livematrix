import { ACCENT_HIGH, INCOMING, LISTEN_ON, MIC_MUTED_FILL, NAME_OFFLINE, TALK_ON, TEXT, WARN } from './brand.js'
import type { LivematrixInstance } from './index.js'
import { MIN_LISTEN_LEVEL_DB } from './levels.js'
import { getKeySelectorOptions, type KeySelectorOptions } from './options.js'
import { keyTargetToken } from './protocol.js'

/**
 * What a key's name reads as when the button is not pointing at a key: the
 * index is out of range, or the target is one this login does not have. The
 * button still draws, so it has to say that it is aimed at nothing.
 */
const NO_KEY_NAME = 'N/A'

type NoOptions = Record<string, never>
type KeyBoolean = { type: 'boolean'; options: KeySelectorOptions }

export type FeedbacksSchema = {
	talk_active: KeyBoolean
	listen_active: KeyBoolean
	talk_latched: KeyBoolean
	talk_momentary: KeyBoolean
	listen_latched: KeyBoolean
	listen_momentary: KeyBoolean
	key_selected: KeyBoolean
	key_listen_level_db: { type: 'value'; options: KeySelectorOptions; result: number }
	key_found: { type: 'value'; options: KeySelectorOptions; result: boolean }
	key_name: { type: 'value'; options: KeySelectorOptions; result: string }
	user_connected: KeyBoolean
	user_disconnected: KeyBoolean
	listening_to_me: KeyBoolean
	audio_arriving: KeyBoolean
	audio_recent: KeyBoolean
	mic_muted: { type: 'boolean'; options: NoOptions }
	mic_device_name: { type: 'value'; options: NoOptions; result: string }
	mic_live: { type: 'boolean'; options: NoOptions }
}

export function UpdateFeedbacks(self: LivematrixInstance): void {
	const keys = self.keys

	self.setFeedbackDefinitions({
		talk_active: {
			type: 'boolean',
			name: 'Talk active',
			defaultStyle: {
				bgcolor: TALK_ON,
				color: TEXT,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.keyState.talk(key) : false
			},
		},
		listen_active: {
			type: 'boolean',
			name: 'Listen active',
			defaultStyle: {
				bgcolor: LISTEN_ON,
				color: TEXT,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.keyState.listen(key) : false
			},
		},
		talk_latched: {
			type: 'boolean',
			name: 'Talk latched',
			description: 'Talk is on and holding itself, rather than being held down',
			defaultStyle: {
				bgcolor: TALK_ON,
				color: TEXT,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.getLatchMode(key, 'talk') === 'latched' : false
			},
		},
		talk_momentary: {
			type: 'boolean',
			name: 'Talk held (momentary)',
			description: 'Talk is on only for as long as the key is held',
			defaultStyle: {
				bgcolor: TALK_ON,
				color: TEXT,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.getLatchMode(key, 'talk') === 'momentary' : false
			},
		},
		listen_latched: {
			type: 'boolean',
			name: 'Listen latched',
			description: 'Listen is on and holding itself, rather than being held down',
			defaultStyle: {
				bgcolor: LISTEN_ON,
				color: TEXT,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.getLatchMode(key, 'listen') === 'latched' : false
			},
		},
		listen_momentary: {
			type: 'boolean',
			name: 'Listen held (momentary)',
			description: 'Listen is on only for as long as the key is held',
			defaultStyle: {
				bgcolor: LISTEN_ON,
				color: TEXT,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.getLatchMode(key, 'listen') === 'momentary' : false
			},
		},
		key_selected: {
			type: 'boolean',
			name: 'Key is selected',
			defaultStyle: {
				color: ACCENT_HIGH,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				if (!key) return false
				return keyTargetToken(key) === self.selectedKeyToken()
			},
		},
		key_listen_level_db: {
			type: 'value',
			name: 'Listen level (dB)',
			description: 'The listen level as a number, for driving a gauge or text',
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				if (!key) return MIN_LISTEN_LEVEL_DB
				return Number(self.keyState.levelDb(key).toFixed(1))
			},
		},
		key_found: {
			type: 'value',
			name: 'Key found',
			description:
				'Whether the key selector points at a key this login has. For "Selected key", whether any key is selected right now.',
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => self.resolveKey(feedback.options) !== undefined,
		},
		key_name: {
			type: 'value',
			name: 'Key display name',
			description: 'The name of the key, for use as button text',
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? key.display_name : NO_KEY_NAME
			},
		},
		user_connected: {
			type: 'boolean',
			name: 'User connected',
			defaultStyle: {
				color: TEXT,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.isKeyUserConnected(key) : false
			},
		},
		user_disconnected: {
			type: 'boolean',
			name: 'User disconnected',
			defaultStyle: {
				color: NAME_OFFLINE,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? !self.isKeyUserConnected(key) : false
			},
		},
		listening_to_me: {
			type: 'boolean',
			name: 'Listening to you',
			description: 'Someone this key reaches is listening to you. A group key counts its members.',
			defaultStyle: {
				color: INCOMING,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.activity.isListeningToMe(key) : false
			},
		},
		audio_arriving: {
			type: 'boolean',
			name: 'Audio arriving',
			description: 'Audio from what this key points at is reaching you right now, whether or not you listen',
			defaultStyle: {
				color: INCOMING,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.activity.isAudioArriving(key) : false
			},
		},
		audio_recent: {
			type: 'boolean',
			name: 'Audio arrived recently',
			description: 'Audio from what this key points at stopped within the last minute',
			defaultStyle: {
				color: INCOMING,
			},
			options: getKeySelectorOptions(keys),
			callback: async (feedback) => {
				const key = self.resolveKey(feedback.options)
				return key ? self.activity.isAudioTrailing(key, Date.now()) : false
			},
		},
		mic_muted: {
			type: 'boolean',
			name: 'Microphone muted',
			description: 'On while the mic is muted, or while no device holds it',
			defaultStyle: {
				bgcolor: MIC_MUTED_FILL,
				color: WARN,
			},
			options: [],
			callback: async () => !self.isMicUnmuted(),
		},
		mic_device_name: {
			type: 'value',
			name: 'Device holding the microphone',
			description: 'Its name, or nothing while no device holds the mic',
			options: [],
			callback: async () => self.mic.device_name ?? self.mic.device_id ?? '',
		},
		mic_live: {
			type: 'boolean',
			name: 'Microphone live',
			description:
				'On while audio is going out, either because the mic is unmuted or because a talk key is held through the mute',
			defaultStyle: {
				bgcolor: LISTEN_ON,
				color: TEXT,
			},
			options: [],
			callback: async () => self.isMicOpen(),
		},
	})
}
