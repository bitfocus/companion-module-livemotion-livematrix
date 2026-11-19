import type { CompanionVariableDefinitions, CompanionVariableValue } from '@companion-module/base'
import type { LivematrixInstance } from './index.js'
import { sanitizeName } from './levels.js'

export type VariablesSchema = {
	user_id: string
	display_name: string
	connected: boolean
	mic_muted: boolean
	mic_device: string
	mic_holder_online: boolean
	mic_open: boolean
	mic_error: string
	key_count: number
	selected_key_index: number
	selected_key_name: string
	selected_key_target_id: string
	selected_key_talk: boolean
	selected_key_listen: boolean
	selected_key_level: string
	/** One set per key the login has, by index, by target ID and by display name. */
	[perKey: `key_${number}_${string}` | `tid_${string}` | `target_${string}`]: CompanionVariableValue
}

export function UpdateVariableDefinitions(self: LivematrixInstance): void {
	const variables: CompanionVariableDefinitions<VariablesSchema> = {
		user_id: { name: 'Logged-in user ID' },
		display_name: { name: 'Logged-in display name' },
		connected: { name: 'Connected' },
		mic_muted: { name: 'Microphone muted (or held by no device)' },
		mic_device: { name: 'Device holding the microphone' },
		mic_holder_online: { name: 'Device holding the microphone is online' },
		mic_open: { name: 'Microphone sending audio (unmuted, or talking through the mute)' },
		mic_error: { name: 'Last microphone error' },
		key_count: { name: 'Key count' },
		selected_key_index: { name: 'Selected key index' },
		selected_key_name: { name: 'Selected key display name' },
		selected_key_target_id: { name: 'Selected key target ID' },
		selected_key_talk: { name: 'Selected key talk active' },
		selected_key_listen: { name: 'Selected key listen active' },
		selected_key_level: { name: 'Selected key listen level dB' },
	}

	const seenTargetNames = new Set<string>()
	for (const [index, key] of self.keys.entries()) {
		variables[`key_${index}_name`] = { name: `Key ${index} display name` }
		variables[`key_${index}_target_type`] = { name: `Key ${index} target type` }
		variables[`key_${index}_target_id`] = { name: `Key ${index} target ID` }
		variables[`key_${index}_talk`] = { name: `Key ${index} talk active` }
		variables[`key_${index}_listen`] = { name: `Key ${index} listen active` }
		variables[`key_${index}_level`] = { name: `Key ${index} listen level dB` }
		variables[`key_${index}_talk_mode`] = { name: `Key ${index} talk mode (off/momentary/latched)` }
		variables[`key_${index}_listen_mode`] = { name: `Key ${index} listen mode (off/momentary/latched)` }
		variables[`tid_${key.target_id}_name`] = { name: `${key.display_name} name` }
		variables[`tid_${key.target_id}_talk`] = { name: `${key.display_name} talk active` }
		variables[`tid_${key.target_id}_listen`] = { name: `${key.display_name} listen active` }
		variables[`tid_${key.target_id}_level`] = { name: `${key.display_name} listen level dB` }

		const sanitized = sanitizeName(key.display_name)
		if (!seenTargetNames.has(sanitized)) {
			seenTargetNames.add(sanitized)
			variables[`target_${sanitized}_talk`] = { name: `${key.display_name} talk active` }
			variables[`target_${sanitized}_listen`] = { name: `${key.display_name} listen active` }
			variables[`target_${sanitized}_level`] = { name: `${key.display_name} listen level dB` }
		}
	}

	self.setVariableDefinitions(variables)
}
