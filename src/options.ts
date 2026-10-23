import type {
	CompanionOptionValues,
	CompanionSimplePresetLocalVariable,
	DropdownChoice,
	JsonValue,
} from '@companion-module/base'
import { keyTargetToken, type KeyConfig } from './protocol.js'

export type SetMode = 'toggle' | 'on' | 'off'
export type KeySelectionMode = 'index' | 'target' | 'selected'
export type PressBehaviour = 'auto' | 'momentary' | 'latch'

/**
 * The local variable every key preset points at its key with. Held on the
 * button rather than repeated through each action and feedback, so one edit
 * moves the whole button to another key.
 */
export const KEY_LOCAL_VARIABLE = 'key'

const keySelectChoices = [
	{ id: 'target', label: 'Specific key' },
	{ id: 'index', label: 'By index' },
	{ id: 'selected', label: 'Selected key' },
]

const pressBehaviourChoices = [
	{ id: 'auto', label: 'Follow key config (latch if allowed)' },
	{ id: 'momentary', label: 'Momentary only' },
	{ id: 'latch', label: 'Latch only (toggle on press)' },
]

const setModeChoices = [
	{ id: 'toggle', label: 'Toggle' },
	{ id: 'on', label: 'On' },
	{ id: 'off', label: 'Off' },
]

/** Wrap a Companion expression so it is evaluated per button rather than taken literally. */
export function expr<T>(expression: string): T {
	return { isExpression: true as const, value: expression } as unknown as T
}

/**
 * Wrap a literal for a feedback style override. Companion drops overrides whose value
 * is not in expression-or-value form, which silently disables the whole feedback.
 */
export function overrideValue<T extends JsonValue>(value: T) {
	return { isExpression: false as const, value }
}

function firstTarget(keys: KeyConfig[]): string {
	return keys[0] ? keyTargetToken(keys[0]) : ''
}

export function getKeyChoices(keys: KeyConfig[]): DropdownChoice[] {
	return keys.map((key) => ({
		id: keyTargetToken(key),
		label: `${key.display_name} (${key.target_type})`,
	}))
}

export function getKeySelectorOptions(keys: KeyConfig[]) {
	return [
		{
			type: 'dropdown' as const,
			id: 'selection_mode',
			label: 'Select key by',
			default: 'target',
			choices: keySelectChoices,
			// The visibility expressions below read this field, and Companion
			// only allows that for fields which cannot themselves be expressions.
			disableAutoExpression: true,
		},
		{
			type: 'number' as const,
			id: 'key_index',
			label: 'Key index',
			default: 0,
			min: 0,
			max: Math.max(0, keys.length - 1),
			range: false,
			isVisibleExpression: "$(options:selection_mode) == 'index'",
			// A button points at its key through an expression, so the value can
			// name a key that is not there. Companion would drop the whole
			// action or feedback rather than run it; letting it through instead
			// means the module decides, and a key-less button says so.
			allowInvalidValues: true,
		},
		{
			type: 'dropdown' as const,
			id: 'key_target',
			label: 'Target',
			default: firstTarget(keys),
			choices: getKeyChoices(keys),
			isVisibleExpression: "$(options:selection_mode) == 'target'",
			// As above: a target that this login no longer has still reaches the
			// module, which resolves it to no key.
			allowInvalidValues: true,
		},
	]
}

export function getPressBehaviourOption() {
	return {
		type: 'dropdown' as const,
		id: 'press_behaviour',
		label: 'Press behaviour',
		default: 'auto',
		choices: pressBehaviourChoices,
	}
}

/**
 * Hold the key to make it the selected key while it is held, so the volume
 * controls act on it. Let go and the selection goes back to what it was.
 */
export function getHoldSelectsOption(defaultValue: boolean) {
	return {
		type: 'checkbox' as const,
		id: 'hold_selects',
		label: 'Holding selects this key',
		tooltip:
			'While the key is held down it is the selected key, so the volume controls act on it. Letting go hands the selection back.',
		default: defaultValue,
	}
}

/** Make the key the selected one on every press, and leave it selected afterwards. */
export function getAlsoSelectOption() {
	return {
		type: 'checkbox' as const,
		id: 'also_select',
		label: 'Pressing selects this key and keeps it selected',
		default: false,
	}
}

export function getSetModeOption(id: string) {
	return {
		type: 'dropdown' as const,
		id,
		label: 'Mode',
		default: 'toggle',
		choices: setModeChoices,
	}
}

export function readPressBehaviour(options: CompanionOptionValues): PressBehaviour {
	return (options.press_behaviour as PressBehaviour | undefined) ?? 'auto'
}

export function readSetMode(options: CompanionOptionValues): SetMode {
	return (options.mode as SetMode | undefined) ?? 'toggle'
}

/**
 * Find the key a set of key selector options points at. `selected` is passed in
 * because only the instance knows what is selected.
 */
export function resolveKey(
	keys: KeyConfig[],
	options: CompanionOptionValues,
	selected: () => KeyConfig | undefined,
): KeyConfig | undefined {
	const selectionMode = (options.selection_mode as KeySelectionMode | undefined) ?? 'target'
	if (selectionMode === 'selected') return selected()
	if (selectionMode === 'index') {
		const index = Number(options.key_index ?? 0)
		if (!Number.isInteger(index) || index < 0 || index >= keys.length) return undefined
		return keys[index]
	}

	const target = String(options.key_target ?? '')
	return keys.find((key) => keyTargetToken(key) === target)
}

/**
 * Option values for a key selector as a preset must supply them: every field the
 * selector declares needs a value, including the ones the visibility expressions
 * hide, or the options fail validation when the action runs.
 *
 * For 'index' and 'target' the live field reads the button's `key` local variable
 * rather than a value baked in here, so every action and feedback on the button
 * follows the one variable and the button is repointed by editing it alone.
 */
export function presetKeyOptions(keys: KeyConfig[], mode: KeySelectionMode): CompanionOptionValues {
	return {
		selection_mode: mode,
		key_index: mode === 'index' ? expr<number>(`$(local:${KEY_LOCAL_VARIABLE})`) : 0,
		key_target: mode === 'target' ? expr<string>(`$(local:${KEY_LOCAL_VARIABLE})`) : firstTarget(keys),
	}
}

/**
 * The button's own copy of which key it drives. Everything else on the button
 * reads it, so switching the button to another key is one edit, and dropping the
 * same preset onto several buttons only differs by this value.
 */
export function keyLocalVariable(keys: KeyConfig[], mode: 'index' | 'target'): CompanionSimplePresetLocalVariable {
	return {
		variableName: KEY_LOCAL_VARIABLE,
		variableType: 'simple' as const,
		headline: mode === 'index' ? 'Which key this button drives, by index' : 'Which key this button drives',
		startupValue: mode === 'index' ? 0 : firstTarget(keys),
	}
}
