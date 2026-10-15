import {
	ButtonGraphicsDecorationType,
	combineRgb,
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionPresetSection,
} from '@companion-module/base'
import type { LiveMatrixManifest } from './config.js'
import { LEVEL_STEP_DB, MAX_LISTEN_LEVEL_DB, MIN_LISTEN_LEVEL_DB_DISPLAY } from './levels.js'
import { KEY_LOCAL_VARIABLE, expr, keyLocalVariable, overrideValue, presetKeyOptions } from './options.js'
import { keyTargetToken, type KeyConfig, type KeyField } from './protocol.js'

const TALK_ACCENT = combineRgb(255, 40, 40)
const TALK_SHADOW = combineRgb(24, 0, 0)
const LISTEN_ACCENT = combineRgb(0, 220, 90)
const LISTEN_SHADOW = combineRgb(0, 20, 8)
/**
 * Border colours are the accents softened. At rest the border only says what
 * the key is for; the saturated accent is reserved for the fill, which says
 * the key is live.
 */
const TALK_BORDER = combineRgb(198, 104, 104)
const LISTEN_BORDER = combineRgb(96, 176, 128)
const BORDER_WIDTH = 2

const KEY_LABEL_BOX_HEIGHT = 62

/**
 * Text sizes, as a percentage of the button.
 *
 * Companion sizes text against the element holding it rather than against the
 * button, so the same number draws larger text in a taller box. Writing sizes
 * against the button and converting keeps text of one kind at one size
 * wherever it sits, whatever shape of box it lands in.
 */
const TEXT_KEY_LABEL = 30
const TEXT_KEY_NAME = 18
const TEXT_LEVEL = 14
const TEXT_ARROW = 18

/**
 * How much of a key is left showing when nobody is logged in on the other end.
 * A key to somebody who is not there still exists and can still be latched, so
 * it is faded rather than hidden.
 */
const OFFLINE_OPACITY = 35

/** Colour along a level meter: cool below unity, warm above it. */
const LEVEL_STOPS = [
	{ value: MIN_LISTEN_LEVEL_DB_DISPLAY, color: combineRgb(70, 130, 180), gradient: true },
	{ value: 0, color: combineRgb(200, 225, 255), gradient: true },
	{ value: MAX_LISTEN_LEVEL_DB, color: combineRgb(255, 190, 60), gradient: false },
]

/**
 * Convert a size written against the button into the percentage of its own box
 * that Companion wants. Left unrounded: whole numbers here are off by enough to
 * see between boxes of different heights.
 */
function fontsizeForBox(buttonPercent: number, boxHeight: number): number {
	return (buttonPercent * 100) / boxHeight
}

export function getPresetDefinitions(keys: KeyConfig[]): {
	structure: CompanionPresetSection<LiveMatrixManifest>[]
	presets: CompanionPresetDefinitions<LiveMatrixManifest>
} {
	return new PresetBuilder(keys).build()
}

/** Every preset the module offers, drawn for the keys this login has. */
class PresetBuilder {
	constructor(private readonly keys: KeyConfig[]) {}

	build(): {
		structure: CompanionPresetSection<LiveMatrixManifest>[]
		presets: CompanionPresetDefinitions<LiveMatrixManifest>
	} {
		const presets: CompanionPresetDefinitions<LiveMatrixManifest> = {
			mic_button: {
				type: 'simple',
				name: 'Microphone mute',
				style: {
					text: 'MIC\n$(livematrix:mic_device)',
					size: 14,
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 0),
					alignment: 'center:center' as const,
				},
				feedbacks: [
					{
						feedbackId: 'mic_muted',
						options: {},
						style: {
							bgcolor: combineRgb(255, 0, 0),
							color: combineRgb(255, 255, 255),
						},
					},
				],
				steps: [
					{
						down: [{ actionId: 'mic_toggle', options: {} }],
						up: [],
					},
				],
			},
		}
		presets['selected_volume'] = this.createSelectedVolumePreset()
		presets['selected_volume_up'] = this.createSelectedVolumeStepPreset('up')
		presets['selected_volume_down'] = this.createSelectedVolumeStepPreset('down')

		// One definition per kind of key rather than one per key: the key itself is a
		// local variable, and the template groups below stamp a value into it for each
		// key the login has. Skipped entirely when there are no keys, as Companion
		// warns about definitions no group refers to.
		if (this.keys.length > 0) {
			presets['key_by_target'] = this.createLayeredKeyPreset('Intercom key', 'target')
			presets['key_by_index'] = this.createLayeredKeyPreset('Intercom key (by index)', 'index')
			presets['talk_by_target'] = this.createSideKeyPreset('talk', 'Talk key', 'target')
			presets['talk_by_index'] = this.createSideKeyPreset('talk', 'Talk key (by index)', 'index')
			presets['listen_by_target'] = this.createSideKeyPreset('listen', 'Listen key', 'target')
			presets['listen_by_index'] = this.createSideKeyPreset('listen', 'Listen key (by index)', 'index')
		}

		const structure: CompanionPresetSection<LiveMatrixManifest>[] = [
			{
				id: 'keys',
				name: 'Intercom Keys',
				description: 'Talk and listen on one button. The `key` variable picks which key it drives.',
				definitions: this.keyPresetGroups('keys', 'key_by_target', 'key_by_index'),
			},
			{
				id: 'talk',
				name: 'Talk Keys',
				definitions: this.keyPresetGroups('talk', 'talk_by_target', 'talk_by_index'),
			},
			{
				id: 'listen',
				name: 'Listen Keys',
				definitions: this.keyPresetGroups('listen', 'listen_by_target', 'listen_by_index'),
			},
			{
				id: 'general',
				name: 'Microphone and Selection',
				definitions: ['mic_button', 'selected_volume', 'selected_volume_up', 'selected_volume_down'],
			},
		]

		return { structure, presets }
	}

	/**
	 * The two ways of pointing one key preset at a key: by name, which survives the
	 * keys being reordered, and by index, which survives them being renamed. Each is
	 * a template over the preset's `key` local variable, so the list of keys costs one
	 * preset rather than one per key.
	 */
	private keyPresetGroups(
		idPrefix: string,
		targetPresetId: string,
		indexPresetId: string,
	): CompanionPresetGroup<LiveMatrixManifest>[] {
		if (this.keys.length === 0) return []

		return [
			{
				type: 'template',
				id: `${idPrefix}-target`,
				name: 'By key',
				presetId: targetPresetId,
				templateVariableName: KEY_LOCAL_VARIABLE,
				templateValues: this.keys.map((key) => ({
					name: key.display_name,
					value: keyTargetToken(key),
				})),
			},
			{
				type: 'template',
				id: `${idPrefix}-index`,
				name: 'By index',
				description: 'Follows whatever key is in that position, whichever key that turns out to be.',
				presetId: indexPresetId,
				templateVariableName: KEY_LOCAL_VARIABLE,
				templateValues: this.keys.map((key, index) => ({
					name: `${index}: ${key.display_name}`,
					value: index,
				})),
			},
		]
	}

	/**
	 * Half of the frame around a combined key, in that half's colour. Drawn as
	 * three segments rather than a box so the two halves meet without a seam up
	 * the middle of the key.
	 */
	private halfBorderElements(side: 'left' | 'right') {
		const left = side === 'left'
		const color = left ? LISTEN_BORDER : TALK_BORDER
		const x0 = left ? 0 : 50
		const x1 = left ? 50 : 100
		const edge = left ? 0 : 100
		const common = {
			borderWidth: BORDER_WIDTH,
			borderColor: color,
			borderPosition: 'inside' as const,
		}

		return [
			{
				id: `${side}-border-top`,
				type: 'line' as const,
				name: `${side} top`,
				fromX: x0,
				fromY: 0,
				toX: x1,
				toY: 0,
				...common,
			},
			{
				id: `${side}-border-side`,
				type: 'line' as const,
				name: `${side} edge`,
				fromX: edge,
				fromY: 0,
				toX: edge,
				toY: 100,
				...common,
			},
			{
				id: `${side}-border-bottom`,
				type: 'line' as const,
				name: `${side} bottom`,
				fromX: x0,
				fromY: 100,
				toX: x1,
				toY: 100,
				...common,
			},
		]
	}

	/** The listen level, drawn as a rail along the bottom of a key. */
	private levelBarElement() {
		return {
			id: 'level-bar',
			type: 'gauge' as const,
			name: 'Listen level',
			x: 8,
			y: 84,
			width: 84,
			height: 8,
			orientation: 'horizontal' as const,
			value: expr<number>('$(local:level)'),
			min: MIN_LISTEN_LEVEL_DB_DISPLAY,
			max: MAX_LISTEN_LEVEL_DB,
			fillEnabled: true,
			roundedEnds: true,
			trackStyle: 'dimmed' as const,
			// How much colour the unfilled rail keeps; low so the fill reads as a level.
			trackAmount: 18,
			multiColour: true,
			stops: LEVEL_STOPS,
		}
	}

	/**
	 * Selection is shown as a frame around the level rail rather than around the
	 * whole key: the selection only decides which key the volume controls act on,
	 * so it belongs next to the level rather than over the talk and listen state.
	 */
	private selectedBarBorderElement() {
		return {
			id: 'level-border',
			type: 'box' as const,
			name: 'Selected',
			x: 4,
			y: 80,
			width: 92,
			height: 16,
			// Transparent fill: opacity would fade the border away with it.
			color: combineRgb(0, 0, 0, 0),
			borderWidth: 2,
			borderColor: combineRgb(255, 255, 255),
			borderPosition: 'inside' as const,
			enabled: false,
		}
	}

	/**
	 * A key for one half of an intercom key. It carries its colour as a border at
	 * rest and fills with it when active, brightest at the edges and darkest
	 * through the middle so the name stays readable either way.
	 */
	private createSideKeyPreset(mode: KeyField, name: string, selection: 'index' | 'target') {
		const keyOptions = presetKeyOptions(this.keys, selection)
		const talk = mode === 'talk'
		const accent = talk ? TALK_ACCENT : LISTEN_ACCENT
		const shadow = talk ? TALK_SHADOW : LISTEN_SHADOW
		const showLevel = !talk
		const labelBoxHeight = showLevel ? KEY_LABEL_BOX_HEIGHT : 88

		return {
			type: 'layered' as const,
			name,
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				{
					id: 'fill',
					type: 'gauge' as const,
					name: `${talk ? 'Talk' : 'Listen'} fill`,
					x: 0,
					y: 0,
					width: 100,
					height: 100,
					orientation: 'horizontal' as const,
					value: 100,
					min: 0,
					max: 100,
					fillEnabled: true,
					multiColour: true,
					trackStyle: 'transparent' as const,
					trackAmount: 0,
					enabled: false,
					stops: [
						{ value: 0, color: accent, gradient: true },
						{ value: 50, color: shadow, gradient: true },
						{ value: 100, color: accent, gradient: true },
					],
				},
				{
					id: 'border',
					type: 'box' as const,
					name: 'Key colour',
					x: 0,
					y: 0,
					width: 100,
					height: 100,
					color: combineRgb(0, 0, 0, 0),
					borderWidth: BORDER_WIDTH,
					borderColor: talk ? TALK_BORDER : LISTEN_BORDER,
					borderPosition: 'inside' as const,
				},
				{
					id: 'label',
					type: 'text' as const,
					name: 'Key name',
					x: 6,
					y: showLevel ? 12 : 6,
					width: 88,
					height: labelBoxHeight,
					text: expr<string>('$(local:name)'),
					fontsize: fontsizeForBox(TEXT_KEY_LABEL, labelBoxHeight),
					fontsizeAllowShrink: true,
					weight: 'bold' as const,
					color: combineRgb(255, 255, 255),
					halign: 'center' as const,
					valign: 'center' as const,
				},
				...(showLevel ? [this.levelBarElement(), this.selectedBarBorderElement()] : []),
			],
			localVariables: [
				keyLocalVariable(this.keys, selection),
				{
					variableName: 'name',
					variableType: 'feedback' as const,
					feedbackId: 'key_name' as const,
					options: keyOptions,
				},
				...(showLevel
					? [
							{
								variableName: 'level',
								variableType: 'feedback' as const,
								feedbackId: 'key_listen_level_db' as const,
								options: keyOptions,
							},
						]
					: []),
			],
			feedbacks: [
				{
					feedbackId: (talk ? 'talk_active' : 'listen_active') as 'talk_active' | 'listen_active',
					options: keyOptions,
					styleOverrides: [{ elementId: 'fill', elementProperty: 'enabled', override: overrideValue(true) }],
				},
				...(showLevel
					? [
							{
								feedbackId: 'key_selected' as const,
								options: keyOptions,
								styleOverrides: [
									{
										elementId: 'level-border',
										elementProperty: 'enabled',
										override: overrideValue(true),
									},
								],
							},
						]
					: []),
				{
					feedbackId: 'user_disconnected' as const,
					options: keyOptions,
					styleOverrides: [
						{ elementId: 'label', elementProperty: 'opacity', override: overrideValue(OFFLINE_OPACITY) },
						{ elementId: 'border', elementProperty: 'opacity', override: overrideValue(OFFLINE_OPACITY) },
					],
				},
			],
			steps: [
				{
					down: [
						{
							actionId: (talk ? 'talk_down' : 'listen_down') as 'talk_down' | 'listen_down',
							options: talk
								? { ...keyOptions, press_behaviour: 'auto', also_select: true }
								: {
										...keyOptions,
										press_behaviour: 'auto',
										also_select: false,
										long_press_selects: true,
									},
						},
					],
					up: [
						{
							actionId: (talk ? 'talk_up' : 'listen_up') as 'talk_up' | 'listen_up',
							options: talk
								? { ...keyOptions, press_behaviour: 'auto', double_tap_listen: false }
								: { ...keyOptions, press_behaviour: 'auto', long_press_selects: true },
						},
					],
				},
			],
		}
	}

	/**
	 * An intercom key drawn as two gradient halves: listen fills the left half green,
	 * talk fills the right half red. Both fade to near-black towards the middle so the
	 * label stays readable, and read as a saturated edge at the outside.
	 * A bar along the bottom shows the listen level.
	 */
	private createLayeredKeyPreset(name: string, selection: 'index' | 'target') {
		const keyOptions = presetKeyOptions(this.keys, selection)

		return {
			type: 'layered' as const,
			name,
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				{
					id: 'listen-fill',
					type: 'gauge' as const,
					name: 'Listen fill',
					x: 0,
					y: 0,
					width: 50,
					height: 100,
					orientation: 'horizontal' as const,
					value: 100,
					min: 0,
					max: 100,
					fillEnabled: true,
					multiColour: true,
					trackStyle: 'transparent' as const,
					trackAmount: 0,
					enabled: false,
					stops: [
						{ value: 0, color: LISTEN_ACCENT, gradient: true },
						{ value: 100, color: LISTEN_SHADOW, gradient: true },
					],
				},
				{
					id: 'talk-fill',
					type: 'gauge' as const,
					name: 'Talk fill',
					x: 50,
					y: 0,
					width: 50,
					height: 100,
					orientation: 'horizontal' as const,
					value: 100,
					min: 0,
					max: 100,
					fillEnabled: true,
					multiColour: true,
					trackStyle: 'transparent' as const,
					trackAmount: 0,
					enabled: false,
					stops: [
						{ value: 0, color: TALK_SHADOW, gradient: true },
						{ value: 100, color: TALK_ACCENT, gradient: true },
					],
				},
				{
					id: 'listen-latched-bar',
					type: 'box' as const,
					name: 'Listen latched',
					x: 0,
					y: 0,
					width: 50,
					height: 7,
					color: LISTEN_ACCENT,
					enabled: false,
				},
				{
					id: 'talk-latched-bar',
					type: 'box' as const,
					name: 'Talk latched',
					x: 50,
					y: 0,
					width: 50,
					height: 7,
					color: TALK_ACCENT,
					enabled: false,
				},
				{
					id: 'label',
					type: 'text' as const,
					name: 'Key name',
					x: 4,
					y: 12,
					width: 92,
					height: KEY_LABEL_BOX_HEIGHT,
					text: expr<string>('$(local:name)'),
					fontsize: fontsizeForBox(TEXT_KEY_LABEL, KEY_LABEL_BOX_HEIGHT),
					fontsizeAllowShrink: true,
					weight: 'bold' as const,
					color: combineRgb(255, 255, 255),
					halign: 'center' as const,
					valign: 'center' as const,
				},
				...this.halfBorderElements('left'),
				...this.halfBorderElements('right'),
				this.levelBarElement(),
				this.selectedBarBorderElement(),
			],
			localVariables: [
				keyLocalVariable(this.keys, selection),
				{
					variableName: 'name',
					variableType: 'feedback' as const,
					feedbackId: 'key_name' as const,
					options: keyOptions,
				},
				{
					variableName: 'level',
					variableType: 'feedback' as const,
					feedbackId: 'key_listen_level_db' as const,
					options: keyOptions,
				},
			],
			feedbacks: [
				{
					feedbackId: 'listen_active' as const,
					options: keyOptions,
					styleOverrides: [{ elementId: 'listen-fill', elementProperty: 'enabled', override: overrideValue(true) }],
				},
				{
					feedbackId: 'talk_active' as const,
					options: keyOptions,
					styleOverrides: [{ elementId: 'talk-fill', elementProperty: 'enabled', override: overrideValue(true) }],
				},
				{
					feedbackId: 'listen_latched' as const,
					options: keyOptions,
					styleOverrides: [
						{ elementId: 'listen-latched-bar', elementProperty: 'enabled', override: overrideValue(true) },
					],
				},
				{
					feedbackId: 'talk_latched' as const,
					options: keyOptions,
					styleOverrides: [
						{ elementId: 'talk-latched-bar', elementProperty: 'enabled', override: overrideValue(true) },
					],
				},
				{
					feedbackId: 'key_selected' as const,
					options: keyOptions,
					styleOverrides: [{ elementId: 'level-border', elementProperty: 'enabled', override: overrideValue(true) }],
				},
				{
					feedbackId: 'user_disconnected' as const,
					options: keyOptions,
					styleOverrides: [
						{ elementId: 'label', elementProperty: 'opacity', override: overrideValue(OFFLINE_OPACITY) },
					],
				},
			],
			steps: [
				{
					down: [
						{ actionId: 'talk_down' as const, options: { ...keyOptions, press_behaviour: 'auto', also_select: true } },
					],
					up: [
						{
							actionId: 'talk_up' as const,
							options: { ...keyOptions, press_behaviour: 'auto', double_tap_listen: true },
						},
					],
					rotate_left: [
						{ actionId: 'listen_level_delta' as const, options: { ...keyOptions, delta_db: -LEVEL_STEP_DB } },
					],
					rotate_right: [
						{ actionId: 'listen_level_delta' as const, options: { ...keyOptions, delta_db: LEVEL_STEP_DB } },
					],
				},
			],
		}
	}

	/**
	 * A plain up or down key for the selected key's level, for surfaces with no
	 * encoder. Holding it repeats, so a long trim does not mean twenty presses.
	 */
	private createSelectedVolumeStepPreset(direction: 'up' | 'down') {
		const selectedOptions = presetKeyOptions(this.keys, 'selected')
		const up = direction === 'up'
		const stepDb = up ? LEVEL_STEP_DB : -LEVEL_STEP_DB

		return {
			type: 'layered' as const,
			name: `Selected key volume ${direction}`,
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				{
					id: 'name',
					type: 'text' as const,
					name: 'Selected key',
					x: 4,
					y: 4,
					width: 92,
					height: 22,
					text: expr<string>('$(local:name)'),
					fontsize: fontsizeForBox(TEXT_KEY_NAME, 22),
					fontsizeAllowShrink: true,
					weight: 'bold' as const,
					color: combineRgb(255, 255, 255),
					halign: 'center' as const,
					valign: 'center' as const,
				},
				{
					id: 'arrow',
					type: 'text' as const,
					name: 'Direction',
					x: 4,
					y: 28,
					width: 92,
					height: 22,
					text: up ? '\u25b2' : '\u25bc',
					fontsize: fontsizeForBox(TEXT_ARROW, 22),
					fontsizeAllowShrink: true,
					color: combineRgb(255, 255, 255),
					halign: 'center' as const,
					valign: 'center' as const,
				},
				{
					id: 'level-text',
					type: 'text' as const,
					name: 'Level',
					x: 4,
					y: 54,
					width: 92,
					height: 20,
					text: expr<string>('$(local:level) dB'),
					fontsize: fontsizeForBox(TEXT_LEVEL, 20),
					fontsizeAllowShrink: true,
					font: 'companion-mono' as const,
					color: combineRgb(200, 225, 255),
					halign: 'center' as const,
					valign: 'center' as const,
				},
				this.levelBarElement(),
			],
			localVariables: [
				{
					variableName: 'name',
					variableType: 'feedback' as const,
					feedbackId: 'key_name' as const,
					options: selectedOptions,
				},
				{
					variableName: 'level',
					variableType: 'feedback' as const,
					feedbackId: 'key_listen_level_db' as const,
					options: selectedOptions,
				},
			],
			feedbacks: [],
			steps: [
				{
					down: [{ actionId: 'listen_level_delta' as const, options: { ...selectedOptions, delta_db: stepDb } }],
					up: [],
					// Held past half a second, keep stepping every 150ms.
					500: {
						options: { runWhileHeld: true },
						actions: [{ actionId: 'listen_level_delta' as const, options: { ...selectedOptions, delta_db: stepDb } }],
					},
				},
			],
		}
	}

	/**
	 * A rotary control for whichever key is currently selected: turn to trim the level,
	 * press to return it to unity.
	 */
	private createSelectedVolumePreset() {
		const selectedOptions = presetKeyOptions(this.keys, 'selected')

		return {
			type: 'layered' as const,
			name: 'Selected key volume',
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				{
					id: 'level-ring',
					type: 'gauge' as const,
					name: 'Level ring',
					x: 6,
					y: 6,
					width: 88,
					height: 88,
					orientation: 'ring' as const,
					value: expr<number>('$(local:level)'),
					min: MIN_LISTEN_LEVEL_DB_DISPLAY,
					max: MAX_LISTEN_LEVEL_DB,
					// Degrees clockwise from the top; this sweeps 270 degrees with a gap at the bottom.
					startAngle: 225,
					endAngle: 135,
					ringWidth: 10,
					roundedEnds: true,
					fillEnabled: true,
					trackStyle: 'dimmed' as const,
					// How much colour the unfilled rail keeps; low so the fill reads as a level.
					trackAmount: 18,
					multiColour: true,
					stops: LEVEL_STOPS,
				},
				{
					id: 'name',
					type: 'text' as const,
					name: 'Selected key',
					// Kept inside the ring's hole so long names shrink rather than run under it.
					x: 26,
					y: 22,
					width: 48,
					height: 26,
					text: expr<string>('$(local:name)'),
					fontsize: fontsizeForBox(TEXT_KEY_NAME, 26),
					fontsizeAllowShrink: true,
					weight: 'bold' as const,
					color: combineRgb(255, 255, 255),
					halign: 'center' as const,
					valign: 'center' as const,
				},
				{
					id: 'level-text',
					type: 'text' as const,
					name: 'Level',
					x: 26,
					y: 48,
					width: 48,
					height: 24,
					text: expr<string>('$(local:level) dB'),
					fontsize: fontsizeForBox(TEXT_LEVEL, 24),
					fontsizeAllowShrink: true,
					font: 'companion-mono' as const,
					color: combineRgb(200, 225, 255),
					halign: 'center' as const,
					valign: 'center' as const,
				},
			],
			localVariables: [
				{
					variableName: 'name',
					variableType: 'feedback' as const,
					feedbackId: 'key_name' as const,
					options: selectedOptions,
				},
				{
					variableName: 'level',
					variableType: 'feedback' as const,
					feedbackId: 'key_listen_level_db' as const,
					options: selectedOptions,
				},
			],
			feedbacks: [],
			steps: [
				{
					down: [{ actionId: 'listen_level' as const, options: { ...selectedOptions, level: 0 } }],
					up: [],
					rotate_left: [
						{ actionId: 'listen_level_delta' as const, options: { ...selectedOptions, delta_db: -LEVEL_STEP_DB } },
					],
					rotate_right: [
						{ actionId: 'listen_level_delta' as const, options: { ...selectedOptions, delta_db: LEVEL_STEP_DB } },
					],
				},
			],
		}
	}
}
