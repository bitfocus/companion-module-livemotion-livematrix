import {
	ButtonGraphicsDecorationType,
	combineRgb,
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionPresetSection,
} from '@companion-module/base'
import {
	ACCENT,
	ACCENT_HIGH,
	FILL,
	LINE,
	LINE_STRONG,
	LISTEN,
	LISTEN_ON,
	LISTEN_REST,
	MIC_MUTED_FILL,
	NAME,
	NAME_OFFLINE,
	SURFACE,
	TALK,
	TALK_ON,
	TALK_REST,
	TEXT_DISABLED,
	TEXT_FAINT,
	TEXT_MUTED,
	INCOMING,
	INCOMING_TRAIL,
	WARN,
} from './brand.js'
import type { LiveMatrixManifest } from './config.js'
import { LEVEL_STEP_DB, MAX_LISTEN_LEVEL_DB, MIN_LISTEN_LEVEL_DB_DISPLAY } from './levels.js'
import { MIC_ICON, MIC_OFF_ICON } from './icons.js'
import { KEY_LOCAL_VARIABLE, expr, keyLocalVariable, overrideValue, presetKeyOptions } from './options.js'
import { keyTargetToken, type KeyConfig, type KeyField } from './protocol.js'

/**
 * Line widths, as a percentage of the button. The latch ring is drawn heavier
 * than the app's so it stands clear of the resting frame under it.
 */
const REST_BORDER_WIDTH = 3
const RING_WIDTH = 5
/** The amber incoming stripe on a half's outer edge: wider than the ring it covers. */
const INCOMING_STRIPE_WIDTH = 8

/**
 * Text sizes, as a percentage of the button.
 *
 * Companion sizes text against the element holding it rather than against the
 * button, so the same number draws larger text in a taller box. Writing sizes
 * against the button and converting keeps text of one kind at one size
 * wherever it sits, whatever shape of box it lands in.
 */
const TEXT_KEY_LABEL = 28
const TEXT_KEY_NAME = 18
const TEXT_LEVEL = 14
/** The volume step keys carry one thing each, so they can afford it larger. */
const TEXT_STEP_NAME = 30
const TEXT_STEP_LEVEL = 32
const TEXT_STEP_UNIT = 14
const TEXT_STEP_ARROW = 30

/** Fully transparent, for a box drawn only for its border. */
const TRANSPARENT = combineRgb(0, 0, 0, 0)
/**
 * The band behind a key name: black at half strength, so the
 * name stands clear of a lit half while the colour still shows through.
 */
const LABEL_BACKDROP = combineRgb(0, 0, 0, 0.5)
/** The band's height: one line of a key name, which shrinks to stay inside it. */
const LABEL_BAND_HEIGHT = 34
/**
 * How wide the band grows per character of the name, and how much it adds for
 * the round ends, as a percentage of the button. Measured against the bold
 * name at its usual size; a name too long for the button stops at the maximum.
 */
const LABEL_BAND_PER_CHAR = 12
const LABEL_BAND_PADDING = 20
const LABEL_BAND_MAX_WIDTH = 92

/** What the volume keys say instead of a name while nothing is selected. */
const NO_SELECTION_TEXT = 'Hold a key'
/** Stands in for the level while nothing is selected. */
const NO_LEVEL_TEXT = '–'

/**
 * Pick between two colours on whether the button's `found` local variable says
 * a key is selected. The volume keys read everything through it, so with no
 * selection they go idle instead of showing a name or level for nothing.
 */
function whenFound(found: number, idle: number): number {
	return expr<number>(`$(local:found) ? ${found} : ${idle}`)
}

/** The same choice for text: an expression while a key is selected, a fixed text otherwise. */
function whenFoundExpression(found: string, idle: string): string {
	return expr<string>(`$(local:found) ? ${found} : '${idle}'`)
}

/**
 * Convert a size written against the button into the percentage of its own box
 * that Companion wants. Left unrounded: whole numbers here are off by enough to
 * see between boxes of different heights.
 */
function fontsizeForBox(buttonPercent: number, boxHeight: number): number {
	return (buttonPercent * 100) / boxHeight
}

/** The card behind everything on a button, as in the app. */
function cardElement() {
	return {
		id: 'card',
		type: 'box' as const,
		name: 'Card',
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		color: SURFACE,
	}
}

/**
 * The style overrides that show a key's user as gone, as the app does: the
 * name drops to half strength and to a lighter weight. The talk and listen
 * halves stay as they are, as a key to somebody who is not there can still be
 * latched.
 */
function offlineNameOverrides() {
	return [
		{ elementId: 'label', elementProperty: 'color', override: overrideValue(NAME_OFFLINE) },
		{ elementId: 'label', elementProperty: 'weight', override: overrideValue('normal') },
	]
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
			mic_button: this.createMicPreset(),
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
	 * The listen level, drawn as the app draws a meter: a thin rounded rail, the
	 * empty part in the hairline grey and the level in the accent blue. The empty
	 * part is a gauge of its own, as a gauge can only dim its fill colour for it.
	 */
	private levelBarElements(y: number, onlyWhenFound = false) {
		const common = {
			type: 'gauge' as const,
			x: 10,
			y,
			width: 80,
			height: 5,
			orientation: 'horizontal' as const,
			min: MIN_LISTEN_LEVEL_DB_DISPLAY,
			max: MAX_LISTEN_LEVEL_DB,
			fillEnabled: true,
			roundedEnds: true,
			trackStyle: 'transparent' as const,
			trackAmount: 0,
			multiColour: false,
			...(onlyWhenFound ? { enabled: expr<boolean>('$(local:found)') } : {}),
		}

		return [
			{
				...common,
				id: 'level-track',
				name: 'Level rail',
				value: MAX_LISTEN_LEVEL_DB,
				stops: [{ value: MIN_LISTEN_LEVEL_DB_DISPLAY, color: LINE, gradient: false }],
			},
			{
				...common,
				id: 'level-bar',
				name: 'Listen level',
				value: expr<number>('$(local:level)'),
				stops: [{ value: MIN_LISTEN_LEVEL_DB_DISPLAY, color: ACCENT, gradient: false }],
			},
		]
	}

	/**
	 * Selection is shown as an accent frame around the level rail rather than
	 * around the whole key: the selection only decides which key the volume
	 * controls act on, so it belongs next to the level rather than over the talk
	 * and listen state. Blue, as everything selected is in the app.
	 */
	private selectedBarBorderElement(y: number) {
		return {
			id: 'level-border',
			type: 'box' as const,
			name: 'Selected',
			x: 4,
			y: y - 5,
			width: 92,
			height: 15,
			// Transparent fill: opacity would fade the border away with it.
			color: TRANSPARENT,
			borderWidth: 3,
			borderColor: ACCENT,
			borderPosition: 'inside' as const,
			enabled: false,
		}
	}

	/**
	 * A key's name, in pure white so it reads over any fill, bold while its user
	 * is there, on a dark pill so it stays legible over a lit half. The pill is
	 * as wide as the name and centred on `centerY`; a name too long for one line
	 * shrinks to stay on it.
	 *
	 * The pill is a box with a half disc at each end, sized by expressions on the
	 * name's length. Companion 5.0 ignores a box's corner radius, and pieces that
	 * only meet, never overlap, keep the translucent black even all along.
	 */
	private labelElements(centerY: number) {
		const height = LABEL_BAND_HEIGHT
		const y = centerY - height / 2
		const width = `min(${LABEL_BAND_MAX_WIDTH}, max(${height}, strlen($(local:name)) * ${LABEL_BAND_PER_CHAR} + ${LABEL_BAND_PADDING}))`
		const end = (side: 'left' | 'right') => ({
			id: `label-backdrop-${side}`,
			type: 'circle' as const,
			name: `Name backdrop ${side} end`,
			x: expr<number>(side === 'left' ? `50 - (${width}) / 2` : `50 + (${width}) / 2 - ${height}`),
			y,
			width: height,
			height,
			color: LABEL_BACKDROP,
			// Degrees clockwise from the top: the left end sweeps over the left
			// side, the right end over the right.
			startAngle: side === 'left' ? 180 : 0,
			endAngle: side === 'left' ? 0 : 180,
			drawSlice: true,
		})

		return [
			end('left'),
			{
				id: 'label-backdrop',
				type: 'box' as const,
				name: 'Name backdrop',
				x: expr<number>(`50 - ((${width}) - ${height}) / 2`),
				y,
				width: expr<number>(`(${width}) - ${height}`),
				height,
				color: LABEL_BACKDROP,
			},
			end('right'),
			{
				id: 'label',
				type: 'text' as const,
				name: 'Key name',
				x: 8,
				y,
				width: 84,
				height,
				text: expr<string>('$(local:name)'),
				fontsize: fontsizeForBox(TEXT_KEY_LABEL, height),
				fontsizeAllowShrink: true,
				weight: 'bold' as const,
				color: NAME,
				halign: 'center' as const,
				valign: 'center' as const,
			},
		]
	}

	/**
	 * The frame a half wears at rest, in a light tint of its colour, so a talk or
	 * listen key can be told apart at a glance before it is on.
	 */
	private restBorderElement(mode: KeyField) {
		return {
			id: `${mode}-border`,
			type: 'box' as const,
			name: mode === 'talk' ? 'Talk colour' : 'Listen colour',
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			color: TRANSPARENT,
			borderWidth: REST_BORDER_WIDTH,
			borderColor: mode === 'talk' ? TALK_REST : LISTEN_REST,
			borderPosition: 'inside' as const,
		}
	}

	/**
	 * Half of the resting frame around a combined key, in that half's colour.
	 */
	private halfRestBorderElements(mode: KeyField) {
		return this.halfFrameElements(mode, 'border', REST_BORDER_WIDTH, mode === 'talk' ? TALK_REST : LISTEN_REST, true)
	}

	/**
	 * The latch ring around one half of a combined key. Like the resting frame it
	 * leaves out the side the halves share: a ring line down the middle would cut
	 * through the name and read as a divider rather than as a latch.
	 */
	private halfLatchRingElements(mode: KeyField) {
		return this.halfFrameElements(mode, 'ring', RING_WIDTH, mode === 'talk' ? TALK : LISTEN, false)
	}

	/** The element ids of a half's latch ring, for the feedback that switches it on. */
	private halfLatchRingIds(mode: KeyField): string[] {
		return this.halfLatchRingElements(mode).map((element) => element.id)
	}

	/**
	 * A frame around one half of a combined key: its top, outer edge and bottom.
	 * Drawn as three lines rather than a box so the two halves meet without a
	 * seam up the middle of the name. Each line is centred half its width in from
	 * the edge, as Companion clips whatever of a line falls off the button.
	 */
	private halfFrameElements(mode: KeyField, kind: string, width: number, color: number, enabled: boolean) {
		const left = mode === 'listen'
		const inset = width / 2
		const x0 = left ? inset : 50
		const x1 = left ? 50 : 100 - inset
		const edge = left ? inset : 100 - inset
		const segment = (id: string, fromX: number, fromY: number, toX: number, toY: number) => ({
			id: `${mode}-${kind}-${id}`,
			type: 'line' as const,
			name: `${left ? 'Listen' : 'Talk'} ${kind} ${id}`,
			enabled,
			fromX,
			fromY,
			toX,
			toY,
			borderWidth: width,
			borderColor: color,
			borderPosition: 'center' as const,
		})

		return [
			segment('top', x0, inset, x1, inset),
			segment('edge', edge, 0, edge, 100),
			segment('bottom', x0, 100 - inset, x1, 100 - inset),
		]
	}

	/**
	 * The amber stripe on a half's outer edge, as the app draws it: on the talk
	 * half while someone the key reaches is listening to us, on the listen half
	 * while their audio is arriving. Drawn after the ring, so on the outer edge
	 * "someone is reaching you" wins over "this stays on".
	 */
	private incomingStripeElement(mode: KeyField) {
		return {
			id: `${mode}-incoming`,
			type: 'box' as const,
			name: mode === 'talk' ? 'Listening to you' : 'Audio arriving',
			x: mode === 'talk' ? 100 - INCOMING_STRIPE_WIDTH : 0,
			y: 0,
			width: INCOMING_STRIPE_WIDTH,
			height: 100,
			color: INCOMING,
			enabled: false,
		}
	}

	/**
	 * The feedbacks that light a half's incoming stripe. The listen stripe
	 * trails for a minute after audio stops, muted towards grey so it never
	 * reads as audio now.
	 */
	private incomingStripeFeedbacks(mode: KeyField, keyOptions: ReturnType<typeof presetKeyOptions>) {
		const elementId = `${mode}-incoming`
		const lit = (color: number) => [
			{ elementId, elementProperty: 'enabled', override: overrideValue(true) },
			{ elementId, elementProperty: 'color', override: overrideValue(color) },
		]
		if (mode === 'talk') {
			return [{ feedbackId: 'listening_to_me' as const, options: keyOptions, styleOverrides: lit(INCOMING) }]
		}
		return [
			{ feedbackId: 'audio_recent' as const, options: keyOptions, styleOverrides: lit(INCOMING_TRAIL) },
			{ feedbackId: 'audio_arriving' as const, options: keyOptions, styleOverrides: lit(INCOMING) },
		]
	}

	/**
	 * The latch ring: the half's own colour, at full strength, around it. In the
	 * app this is the one place talk red and listen green are drawn as a border,
	 * so a coloured frame always means latched.
	 */
	private latchRingElement(mode: KeyField, x: number, y: number, width: number, height: number) {
		return {
			id: `${mode}-ring`,
			type: 'box' as const,
			name: mode === 'talk' ? 'Talk latched' : 'Listen latched',
			x,
			y,
			width,
			height,
			color: TRANSPARENT,
			borderWidth: RING_WIDTH,
			borderColor: mode === 'talk' ? TALK : LISTEN,
			borderPosition: 'inside' as const,
			enabled: false,
		}
	}

	/**
	 * A key for one half of an intercom key: the whole button is the half. It
	 * rests in the app's key grey inside a light frame of its colour, and fills
	 * with the colour when on.
	 */
	private createSideKeyPreset(mode: KeyField, name: string, selection: 'index' | 'target') {
		const keyOptions = presetKeyOptions(this.keys, selection)
		const talk = mode === 'talk'
		const showLevel = !talk
		const levelY = 84

		return {
			type: 'layered' as const,
			name,
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				{
					id: 'fill',
					type: 'box' as const,
					name: `${talk ? 'Talk' : 'Listen'} fill`,
					x: 0,
					y: 0,
					width: 100,
					height: 100,
					color: FILL,
				},
				this.restBorderElement(mode),
				this.latchRingElement(mode, 0, 0, 100, 100),
				this.incomingStripeElement(mode),
				...(showLevel ? [...this.levelBarElements(levelY), this.selectedBarBorderElement(levelY)] : []),
				// Last, so the name is drawn over everything else on the key.
				...this.labelElements(showLevel ? 42 : 50),
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
					styleOverrides: [
						{ elementId: 'fill', elementProperty: 'color', override: overrideValue(talk ? TALK_ON : LISTEN_ON) },
					],
				},
				{
					feedbackId: (talk ? 'talk_latched' : 'listen_latched') as 'talk_latched' | 'listen_latched',
					options: keyOptions,
					styleOverrides: [{ elementId: `${mode}-ring`, elementProperty: 'enabled', override: overrideValue(true) }],
				},
				...this.incomingStripeFeedbacks(mode, keyOptions),
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
					styleOverrides: offlineNameOverrides(),
				},
			],
			steps: [
				{
					down: [
						{
							actionId: (talk ? 'talk_down' : 'listen_down') as 'talk_down' | 'listen_down',
							// Holding a listen key points the volume keys at it; a talk key
							// never moves the selection.
							options: {
								...keyOptions,
								press_behaviour: 'auto',
								hold_selects: !talk,
								also_select: false,
							},
						},
					],
					up: [
						{
							actionId: (talk ? 'talk_up' : 'listen_up') as 'talk_up' | 'listen_up',
							options: talk
								? { ...keyOptions, press_behaviour: 'auto', double_tap_listen: false }
								: { ...keyOptions, press_behaviour: 'auto' },
						},
					],
				},
			],
		}
	}

	/**
	 * An intercom key split down the middle: listen on the left half, talk on the
	 * right, each the full height of the button. A half fills with its colour
	 * while on and gets a ring in it while latched, as in the app; at rest each
	 * wears a light frame of its colour, so the halves read at a glance. The name
	 * runs across both halves, drawn last so nothing covers it, with the listen
	 * level along the bottom.
	 */
	private createLayeredKeyPreset(name: string, selection: 'index' | 'target') {
		const keyOptions = presetKeyOptions(this.keys, selection)
		const levelY = 84
		const half = (mode: KeyField, x: number) => ({
			id: `${mode}-half`,
			type: 'box' as const,
			name: mode === 'talk' ? 'Talk half' : 'Listen half',
			x,
			y: 0,
			width: 50,
			height: 100,
			color: FILL,
		})

		return {
			type: 'layered' as const,
			name,
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				half('listen', 0),
				half('talk', 50),
				...this.halfRestBorderElements('listen'),
				...this.halfRestBorderElements('talk'),
				...this.halfLatchRingElements('listen'),
				...this.halfLatchRingElements('talk'),
				this.incomingStripeElement('listen'),
				this.incomingStripeElement('talk'),
				...this.levelBarElements(levelY),
				this.selectedBarBorderElement(levelY),
				// Last, so the name is drawn over everything else on the key.
				...this.labelElements(42),
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
					styleOverrides: [{ elementId: 'listen-half', elementProperty: 'color', override: overrideValue(LISTEN_ON) }],
				},
				{
					feedbackId: 'talk_active' as const,
					options: keyOptions,
					styleOverrides: [{ elementId: 'talk-half', elementProperty: 'color', override: overrideValue(TALK_ON) }],
				},
				{
					feedbackId: 'listen_latched' as const,
					options: keyOptions,
					styleOverrides: this.halfLatchRingIds('listen').map((elementId) => ({
						elementId,
						elementProperty: 'enabled',
						override: overrideValue(true),
					})),
				},
				{
					feedbackId: 'talk_latched' as const,
					options: keyOptions,
					styleOverrides: this.halfLatchRingIds('talk').map((elementId) => ({
						elementId,
						elementProperty: 'enabled',
						override: overrideValue(true),
					})),
				},
				...this.incomingStripeFeedbacks('listen', keyOptions),
				...this.incomingStripeFeedbacks('talk', keyOptions),
				{
					feedbackId: 'key_selected' as const,
					options: keyOptions,
					styleOverrides: [{ elementId: 'level-border', elementProperty: 'enabled', override: overrideValue(true) }],
				},
				{
					feedbackId: 'user_disconnected' as const,
					options: keyOptions,
					styleOverrides: offlineNameOverrides(),
				},
			],
			steps: [
				{
					down: [
						{
							actionId: 'talk_down' as const,
							// Held, the key is selected for the volume keys while it talks.
							options: { ...keyOptions, press_behaviour: 'auto', hold_selects: true, also_select: false },
						},
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
	 * encoder. The two are placed as a pair, so they split the label between
	 * them: the up key names the selected key, the down key shows its level.
	 * Each arrow sits on the edge it points at. With no key selected both go
	 * grey, and the up key says how to select one.
	 */
	private createSelectedVolumeStepPreset(direction: 'up' | 'down') {
		const selectedOptions = presetKeyOptions(this.keys, 'selected')
		const up = direction === 'up'
		const stepDb = up ? LEVEL_STEP_DB : -LEVEL_STEP_DB

		const arrow = (y: number, height: number) => ({
			id: 'arrow',
			type: 'text' as const,
			name: 'Direction',
			x: 4,
			y,
			width: 92,
			height,
			text: up ? '▲' : '▼',
			fontsize: fontsizeForBox(TEXT_STEP_ARROW, height),
			fontsizeAllowShrink: true,
			color: whenFound(TEXT_MUTED, TEXT_DISABLED),
			halign: 'center' as const,
			valign: 'center' as const,
		})

		const elements = up
			? [
					cardElement(),
					arrow(6, 26),
					{
						id: 'name',
						type: 'text' as const,
						name: 'Selected key',
						x: 4,
						y: 34,
						width: 92,
						height: 60,
						text: whenFoundExpression('$(local:name)', NO_SELECTION_TEXT),
						fontsize: fontsizeForBox(TEXT_STEP_NAME, 60),
						fontsizeAllowShrink: true,
						weight: 'bold' as const,
						color: whenFound(NAME, TEXT_DISABLED),
						halign: 'center' as const,
						valign: 'center' as const,
					},
				]
			: [
					cardElement(),
					{
						id: 'level-text',
						type: 'text' as const,
						name: 'Level',
						x: 4,
						y: 6,
						width: 92,
						height: 34,
						text: whenFoundExpression('$(local:level)', NO_LEVEL_TEXT),
						fontsize: fontsizeForBox(TEXT_STEP_LEVEL, 34),
						fontsizeAllowShrink: true,
						weight: 'bold' as const,
						color: whenFound(ACCENT_HIGH, TEXT_DISABLED),
						halign: 'center' as const,
						valign: 'center' as const,
					},
					{
						id: 'level-unit',
						type: 'text' as const,
						name: 'Unit',
						x: 4,
						y: 40,
						width: 92,
						height: 14,
						enabled: expr<boolean>('$(local:found)'),
						text: 'dB',
						fontsize: fontsizeForBox(TEXT_STEP_UNIT, 14),
						fontsizeAllowShrink: true,
						color: TEXT_FAINT,
						halign: 'center' as const,
						valign: 'center' as const,
					},
					arrow(56, 24),
					...this.levelBarElements(86, true),
				]

		return {
			type: 'layered' as const,
			name: `Selected key volume ${direction}`,
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements,
			localVariables: [
				this.foundLocalVariable(selectedOptions),
				up
					? {
							variableName: 'name',
							variableType: 'feedback' as const,
							feedbackId: 'key_name' as const,
							options: selectedOptions,
						}
					: {
							variableName: 'level',
							variableType: 'feedback' as const,
							feedbackId: 'key_listen_level_db' as const,
							options: selectedOptions,
						},
			],
			feedbacks: [],
			steps: [
				{
					// Steps on the press and keeps stepping until the release.
					down: [{ actionId: 'listen_level_hold' as const, options: { ...selectedOptions, delta_db: stepDb } }],
					up: [{ actionId: 'listen_level_hold_stop' as const, options: {} }],
				},
			],
		}
	}

	/**
	 * The user's one microphone, as the app's mic button: a grey mic inside a
	 * quiet frame while it is live; a struck-through mic in amber, on amber,
	 * while it is muted or no device holds it. Pressing toggles the mute.
	 * The holding device's name is on the button but switched off; turn its
	 * element on to show it.
	 */
	private createMicPreset() {
		const icon = (id: string, name: string, image: string, enabled: boolean) => ({
			id,
			type: 'image' as const,
			name,
			enabled,
			x: 22,
			y: 18,
			width: 56,
			height: 56,
			base64Image: image,
			halign: 'center' as const,
			valign: 'center' as const,
			fillMode: 'fit' as const,
		})

		return {
			type: 'layered' as const,
			name: 'Microphone mute',
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				cardElement(),
				{
					id: 'live-frame',
					type: 'box' as const,
					name: 'Live',
					x: 0,
					y: 0,
					width: 100,
					height: 100,
					color: TRANSPARENT,
					borderWidth: RING_WIDTH,
					borderColor: LINE_STRONG,
					borderPosition: 'inside' as const,
				},
				{
					id: 'muted-fill',
					type: 'box' as const,
					name: 'Muted',
					enabled: false,
					x: 0,
					y: 0,
					width: 100,
					height: 100,
					color: MIC_MUTED_FILL,
					borderWidth: RING_WIDTH,
					borderColor: WARN,
					borderPosition: 'inside' as const,
				},
				icon('mic-live', 'Live icon', MIC_ICON, true),
				icon('mic-muted', 'Muted icon', MIC_OFF_ICON, false),
				{
					id: 'device',
					type: 'text' as const,
					name: 'Device',
					enabled: false,
					x: 6,
					y: 78,
					width: 88,
					height: 16,
					text: expr<string>('$(local:device)'),
					fontsize: fontsizeForBox(TEXT_LEVEL, 16),
					fontsizeAllowShrink: true,
					color: TEXT_MUTED,
					halign: 'center' as const,
					valign: 'center' as const,
				},
			],
			localVariables: [
				{
					variableName: 'device',
					variableType: 'feedback' as const,
					feedbackId: 'mic_device_name' as const,
					options: {},
				},
			],
			feedbacks: [
				{
					feedbackId: 'mic_muted' as const,
					options: {},
					styleOverrides: [
						{ elementId: 'muted-fill', elementProperty: 'enabled', override: overrideValue(true) },
						{ elementId: 'mic-live', elementProperty: 'enabled', override: overrideValue(false) },
						{ elementId: 'mic-muted', elementProperty: 'enabled', override: overrideValue(true) },
					],
				},
			],
			steps: [
				{
					down: [{ actionId: 'mic_toggle' as const, options: {} }],
					up: [],
				},
			],
		}
	}

	/** Whether the selected-key options point at a key right now, as `$(local:found)`. */
	private foundLocalVariable(selectedOptions: ReturnType<typeof presetKeyOptions>) {
		return {
			variableName: 'found',
			variableType: 'feedback' as const,
			feedbackId: 'key_found' as const,
			options: selectedOptions,
		}
	}

	/**
	 * A rotary control for whichever key is currently selected: turn to trim the level,
	 * press to return it to unity.
	 */
	private createSelectedVolumePreset() {
		const selectedOptions = presetKeyOptions(this.keys, 'selected')
		const ring = {
			type: 'gauge' as const,
			x: 6,
			y: 6,
			width: 88,
			height: 88,
			orientation: 'ring' as const,
			min: MIN_LISTEN_LEVEL_DB_DISPLAY,
			max: MAX_LISTEN_LEVEL_DB,
			// Degrees clockwise from the top; this sweeps 270 degrees with a gap at the bottom.
			startAngle: 225,
			endAngle: 135,
			ringWidth: 8,
			roundedEnds: true,
			fillEnabled: true,
			trackStyle: 'transparent' as const,
			trackAmount: 0,
			multiColour: false,
		}

		return {
			type: 'layered' as const,
			name: 'Selected key volume',
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				cardElement(),
				{
					...ring,
					id: 'level-track',
					name: 'Level rail',
					value: MAX_LISTEN_LEVEL_DB,
					stops: [{ value: MIN_LISTEN_LEVEL_DB_DISPLAY, color: LINE, gradient: false }],
				},
				{
					...ring,
					id: 'level-ring',
					name: 'Level ring',
					value: expr<number>('$(local:level)'),
					stops: [{ value: MIN_LISTEN_LEVEL_DB_DISPLAY, color: ACCENT, gradient: false }],
					enabled: expr<boolean>('$(local:found)'),
				},
				{
					id: 'name',
					type: 'text' as const,
					name: 'Selected key',
					// Kept inside the ring's hole so long names shrink rather than run under it.
					x: 24,
					y: 24,
					width: 52,
					height: 26,
					text: whenFoundExpression('$(local:name)', NO_SELECTION_TEXT),
					fontsize: fontsizeForBox(TEXT_KEY_NAME, 26),
					fontsizeAllowShrink: true,
					weight: 'bold' as const,
					color: whenFound(NAME, TEXT_DISABLED),
					halign: 'center' as const,
					valign: 'center' as const,
				},
				{
					id: 'level-text',
					type: 'text' as const,
					name: 'Level',
					x: 24,
					y: 50,
					width: 52,
					height: 22,
					enabled: expr<boolean>('$(local:found)'),
					text: expr<string>("concat($(local:level), ' dB')"),
					fontsize: fontsizeForBox(TEXT_LEVEL, 22),
					fontsizeAllowShrink: true,
					weight: 'bold' as const,
					color: ACCENT_HIGH,
					halign: 'center' as const,
					valign: 'center' as const,
				},
			],
			localVariables: [
				this.foundLocalVariable(selectedOptions),
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
