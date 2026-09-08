import {
	ButtonGraphicsDecorationType,
	InstanceBase,
	InstanceStatus,
	Regex,
	combineRgb,
	type CompanionActionDefinitions,
	type CompanionFeedbackDefinitions,
	type CompanionOptionValues,
	type CompanionPresetDefinitions,
	type CompanionPresetSection,
	type CompanionVariableDefinitions,
	type CompanionVariableValues,
	type DropdownChoice,
	type JsonValue,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import WebSocket, { type RawData } from 'ws'

type ConnectionMode = 'server' | 'client'
type GlobalMode = 'talk' | 'mute'
type SetMode = 'toggle' | 'on' | 'off'
type KeySelectionMode = 'index' | 'target' | 'selected'
type PressBehaviour = 'auto' | 'momentary' | 'latch'
type LatchMode = 'off' | 'momentary' | 'latched'
type KeyField = 'talk' | 'listen'
type Hold = 'latched' | 'momentary'

interface MomentaryHold {
	key: { target_type: string; target_id: string }
	talk: boolean
	listen: boolean
}

type Message = Record<string, unknown>

interface KeyConfig {
	id: string
	target_type: string
	target_id: string
	display_name: string
	can_listen: boolean
	can_talk: boolean
	allow_listen_latching: boolean
	allow_talk_latching: boolean
	default_listen_active?: boolean
	default_talk_active?: boolean
}

interface UserInfo {
	id: string
	display_name: string
	is_virtual: boolean
	is_connected: boolean
}

interface UserState {
	talk_active: Record<string, boolean>
	listen_active: Record<string, boolean>
	listen_level: Record<string, number>
	global_mode: GlobalMode
	global_active: boolean
	party_line_talk_active: Record<string, boolean>
	party_line_listen_active: Record<string, boolean>
	party_line_listen_level: Record<string, number>
}

interface LoginSuccessMessage {
	type: 'login_success'
	user_id: string
	display_name: string
	device_id: string
	keys: KeyConfig[]
	available_users: UserInfo[]
	/// How often a held key has to be restated, and how long it survives without that.
	momentary_heartbeat_interval_ms?: number
	momentary_timeout_ms?: number
}

interface StateUpdateMessage {
	type: 'state_update'
	/// What audio is actually doing: latched or held.
	state: UserState
	/// The same snapshot with every held press removed.
	latched?: UserState
}

interface KeysChangedMessage {
	type: 'keys_changed'
	keys: KeyConfig[]
}

interface UserConnectedMessage {
	type: 'user_connected'
	user_id: string
	display_name: string
}

interface UserDisconnectedMessage {
	type: 'user_disconnected'
	user_id: string
}

interface LoginFailureMessage {
	type: 'login_failure'
	reason: string
}

interface ErrorMessage {
	type: 'error'
	message: string
}

type LiveMatrixConfig = {
	connection_mode: ConnectionMode
	host: string
	port: number
	username: string
	server_tls: boolean
	client_host: string
	client_port: number
	client_tls: boolean
}

type LiveMatrixSecrets = {
	password?: string
}

type LiveMatrixManifest = {
	config: LiveMatrixConfig
	secrets: LiveMatrixSecrets
	actions: Record<string, any>
	feedbacks: Record<string, any>
	variables: CompanionVariableValues
}

interface KeyControlState {
	latched: Map<string, boolean>
	pressing: Map<string, boolean>
	pressStart: Map<string, number>
}

const TAP_THRESHOLD_MS = 300
/**
 * How long after a tap a second one still counts as a double tap. Measured
 * between the two releases, so it is the gap the operator feels.
 */
const DOUBLE_TAP_WINDOW_MS = 400
/**
 * How long a tap's talk state is held back while we find out whether a second
 * tap is coming. Covers all but the slowest double tap, so one never latches
 * talk on at all. The cost is that a single tap latches this much later; the
 * press is held throughout, so the delay costs no audio, only the moment the
 * key stops being a press and starts being a latch.
 */
const DOUBLE_TAP_SETTLE_MS = 250
/**
 * How long a press waits before it opens the mic, on a key that takes the
 * double-tap gesture. A tap shorter than this never transmits at all, so a
 * double tap does not flash the key. The cost is this much delay before a
 * push-to-talk press opens: it is time before the operator has begun speaking,
 * not speech that gets clipped, but set it to 0 to open the mic on the press.
 */
const PRESS_SETTLE_MS = 120
/** How long a listen key must be held before it takes the selection. */
const LONG_PRESS_SELECT_MS = 500

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
const TEXT_KEY_NAME = 13
const TEXT_LEVEL = 9
const TEXT_ARROW = 12

/**
 * How much of a key is left showing when nobody is logged in on the other end.
 * A key to somebody who is not there still exists and can still be latched, so
 * it is faded rather than hidden.
 */
const OFFLINE_OPACITY = 35

/**
 * Convert a size written against the button into the percentage of its own box
 * that Companion wants. Left unrounded: whole numbers here are off by enough to
 * see between boxes of different heights.
 */
function fontsizeForBox(buttonPercent: number, boxHeight: number): number {
	return (buttonPercent * 100) / boxHeight
}
/// Fallback until `login_success` tells us what the server actually wants.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_SERVER_PORT = 55678
const DEFAULT_CLIENT_PORT = 9100
const MIN_LISTEN_LEVEL_DB = -100
/** The quietest level worth showing on a meter; -100 dB is silence and wastes the scale. */
const MIN_LISTEN_LEVEL_DB_DISPLAY = -40
const MAX_LISTEN_LEVEL_DB = 10
/** One detent of a rotary encoder. */
const LEVEL_STEP_DB = 1

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

const globalModeChoices = [
	{ id: 'talk', label: 'Talk' },
	{ id: 'mute', label: 'Mute' },
]

function createEmptyState(): UserState {
	return {
		talk_active: {},
		listen_active: {},
		listen_level: {},
		global_mode: 'mute',
		global_active: false,
		party_line_talk_active: {},
		party_line_listen_active: {},
		party_line_listen_level: {},
	}
}

function sanitizeName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'unnamed'
	)
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value))
}

function linearToDb(level: number): number {
	if (level <= 0) return MIN_LISTEN_LEVEL_DB
	return 20 * Math.log10(level)
}

function dbToLinear(levelDb: number): number {
	if (levelDb <= MIN_LISTEN_LEVEL_DB) return 0
	return 10 ** (levelDb / 20)
}

export class LiveMatrixInstance extends InstanceBase<LiveMatrixManifest> {
	config!: LiveMatrixConfig
	secrets!: LiveMatrixSecrets
	private ws: WebSocket | null = null
	private reconnectTimer: NodeJS.Timeout | undefined
	private shouldReconnect = false

	private userId = ''
	private displayName = ''
	private keys: KeyConfig[] = []
	private availableUsers: UserInfo[] = []
	private connectedUsers = new Set<string>()
	private state: UserState = createEmptyState()
	/** The latched layer of the last state update, when the server sends one. */
	private latchedState: UserState | undefined

	private talkControlState: KeyControlState = this.createControlState()
	private listenControlState: KeyControlState = this.createControlState()
	private selectedKeyToken: string | undefined
	/** When the last tap on a key ended, for spotting a double tap. */
	private lastTapAt = new Map<string, number>()
	/** Releases we are sitting on for DOUBLE_TAP_SETTLE_MS, keyed by target. */
	private settleTimers = new Map<string, NodeJS.Timeout>()
	/** Keys whose second tap has begun, so this press must not drive talk. */
	private secondTapInProgress = new Set<string>()
	/** Listen keys holding the selection for as long as they are held down. */
	private selectHoldTimers = new Map<string, NodeJS.Timeout>()
	/** What was selected before a listen key borrowed the selection. */
	private selectionBeforeHold = new Map<string, string | undefined>()
	/** Presses waiting out PRESS_SETTLE_MS before they open the mic. */
	private pressTimers = new Map<string, NodeJS.Timeout>()
	/** Keys whose press actually reached the server, so we know what to let go of. */
	private pressApplied = new Set<string>()
	/**
	 * Whether talk was latched before the first tap of a possible double tap,
	 * so a second tap can put it back rather than leaving it toggled.
	 */
	private talkLatchBeforeTap = new Map<string, boolean>()
	/** Presses we are holding, keyed by target token, restated on the heartbeat. */
	private heldKeys = new Map<string, MomentaryHold>()
	private heartbeatTimer: NodeJS.Timeout | undefined
	private heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS
	private globalLatched = false
	private globalPressing = false
	private globalPressStart: number | undefined

	async init(config: LiveMatrixConfig, _isFirstInit: boolean, secrets: LiveMatrixSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets
		this.setupDefinitions()
		await this.connect()
	}

	async destroy(): Promise<void> {
		this.shouldReconnect = false
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = undefined
		}
		this.clearHolds()
		await this.disconnect()
	}

	async configUpdated(config: LiveMatrixConfig, secrets: LiveMatrixSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets
		this.shouldReconnect = false
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = undefined
		}
		this.clearHolds()
		await this.disconnect()
		this.resetSession()
		this.setupDefinitions()
		await this.connect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return [
			{
				type: 'dropdown',
				id: 'connection_mode',
				label: 'Connection mode',
				width: 6,
				default: 'server',
				choices: [
					{ id: 'server', label: 'Direct to server' },
					{ id: 'client', label: 'Via local client proxy' },
				],
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Server host',
				width: 6,
				default: 'localhost',
				regex: Regex.HOSTNAME,
				isVisibleExpression: "$(options:connection_mode) == 'server'",
			},
			{
				type: 'number',
				id: 'port',
				label: 'Server port',
				width: 4,
				default: DEFAULT_SERVER_PORT,
				min: 1,
				max: 65535,
				isVisibleExpression: "$(options:connection_mode) == 'server'",
			},
			{
				type: 'checkbox',
				id: 'server_tls',
				label: 'Use TLS',
				width: 2,
				default: false,
				isVisibleExpression: "$(options:connection_mode) == 'server'",
			},
			{
				type: 'textinput',
				id: 'username',
				label: 'Username',
				width: 6,
				default: '',
				isVisibleExpression: "$(options:connection_mode) == 'server'",
			},
			{
				type: 'secret-text',
				id: 'password',
				label: 'Password',
				width: 6,
				default: '',
				isVisibleExpression: "$(options:connection_mode) == 'server'",
			},
			{
				type: 'textinput',
				id: 'client_host',
				label: 'Client host',
				width: 6,
				default: 'localhost',
				regex: Regex.HOSTNAME,
				isVisibleExpression: "$(options:connection_mode) == 'client'",
			},
			{
				type: 'number',
				id: 'client_port',
				label: 'Client port',
				width: 4,
				default: DEFAULT_CLIENT_PORT,
				min: 1,
				max: 65535,
				isVisibleExpression: "$(options:connection_mode) == 'client'",
			},
			{
				type: 'checkbox',
				id: 'client_tls',
				label: 'Use TLS',
				width: 2,
				default: false,
				isVisibleExpression: "$(options:connection_mode) == 'client'",
			},
		]
	}

	private createControlState(): KeyControlState {
		return {
			latched: new Map(),
			pressing: new Map(),
			pressStart: new Map(),
		}
	}

	private async connect(): Promise<void> {
		const validationError = this.validateConfig()
		if (validationError) {
			this.updateStatus(InstanceStatus.BadConfig, validationError)
			return
		}

		this.updateStatus(InstanceStatus.Connecting)
		this.shouldReconnect = true
		const url = this.buildWebSocketUrl()
		const ws = new WebSocket(url)
		this.ws = ws

		ws.on('open', () => {
			this.updateStatus(InstanceStatus.Connecting)
			if (this.config.connection_mode === 'server') {
				this.send({
					type: 'login',
					username: this.config.username,
					password: this.secrets.password,
				})
			}
		})

		ws.on('message', (data: RawData) => {
			void this.handleMessage(data.toString())
		})

		ws.on('error', (error: Error) => {
			const message = error instanceof Error ? error.message : String(error)
			this.log('error', `WebSocket error: ${message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, message)
		})

		ws.on('close', () => {
			if (this.ws === ws) {
				this.ws = null
			}
			this.clearHolds()
			if (this.shouldReconnect) {
				this.updateStatus(InstanceStatus.Disconnected)
				this.scheduleReconnect()
			}
		})
	}

	private async disconnect(): Promise<void> {
		const ws = this.ws
		this.ws = null
		if (!ws) return

		await new Promise<void>((resolve) => {
			const finalize = () => resolve()
			ws.once('close', finalize)
			try {
				ws.close()
			} catch {
				resolve()
			}
			setTimeout(resolve, 500)
		})
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined
			void this.connect()
		}, 5000)
	}

	private validateConfig(): string | undefined {
		const host = this.config.host?.trim() ?? ''
		const username = this.config.username?.trim() ?? ''
		const password = this.secrets.password?.trim() ?? ''
		const clientHost = this.config.client_host?.trim() ?? ''
		if (this.config.connection_mode === 'server') {
			if (!host) return 'Server host is required'
			if (!username) return 'Username is required'
			if (!password) return 'Password is required'
		} else {
			if (!clientHost) return 'Client host is required'
		}

		return undefined
	}

	private buildWebSocketUrl(): string {
		if (this.config.connection_mode === 'server') {
			const scheme = this.config.server_tls ? 'wss' : 'ws'
			const host = this.config.host?.trim() ?? 'localhost'
			const port = this.config.port ?? DEFAULT_SERVER_PORT
			return `${scheme}://${host}:${port}/ws`
		}

		const scheme = this.config.client_tls ? 'wss' : 'ws'
		const clientHost = this.config.client_host?.trim() ?? 'localhost'
		const clientPort = this.config.client_port ?? DEFAULT_CLIENT_PORT
		return `${scheme}://${clientHost}:${clientPort}`
	}

	private async handleMessage(raw: string): Promise<void> {
		let message: Message
		try {
			message = JSON.parse(raw) as Message
		} catch (error) {
			this.log('warn', `Ignoring invalid JSON message: ${String(error)}`)
			return
		}

		switch (message.type) {
			case 'login_success':
				this.handleLoginSuccess(message as unknown as LoginSuccessMessage)
				break
			case 'login_failure':
				this.handleLoginFailure(message as unknown as LoginFailureMessage)
				break
			case 'state_update':
				this.handleStateUpdate(message as unknown as StateUpdateMessage)
				break
			case 'keys_changed':
				this.handleKeysChanged(message as unknown as KeysChangedMessage)
				break
			case 'user_connected':
				this.handleUserConnected(message as unknown as UserConnectedMessage)
				break
			case 'user_disconnected':
				this.handleUserDisconnected(message as unknown as UserDisconnectedMessage)
				break
			case 'remote_mute':
				break
			case 'error':
				this.handleServerError(message as unknown as ErrorMessage)
				break
			default:
				break
		}
	}

	private handleLoginSuccess(message: LoginSuccessMessage): void {
		this.userId = message.user_id
		this.displayName = message.display_name
		this.availableUsers = message.available_users ?? []
		this.connectedUsers = new Set(this.availableUsers.filter((user) => user.is_connected).map((user) => user.id))
		this.applyKeys(message.keys ?? [])
		// The server advertises its own lease so client and server cannot drift
		// apart on how often a held key has to be restated.
		this.heartbeatIntervalMs = message.momentary_heartbeat_interval_ms ?? DEFAULT_HEARTBEAT_INTERVAL_MS
		this.updateStatus(InstanceStatus.Ok)

		if (this.config.connection_mode === 'server') {
			this.send({
				type: 'set_device_name',
				name: 'Companion',
				model: 'companion',
			})
		}
	}

	private handleLoginFailure(message: LoginFailureMessage): void {
		this.shouldReconnect = false
		this.updateStatus(InstanceStatus.AuthenticationFailure, message.reason)
	}

	private handleStateUpdate(message: StateUpdateMessage): void {
		this.state = this.readUserState(message.state)
		// The effective state alone cannot say whether a key is on because it is
		// latched or because someone is leaning on it. The server tells us both.
		this.latchedState = message.latched ? this.readUserState(message.latched) : undefined

		this.syncLatchStateFromServer()
		this.pushVariableValues()
		this.checkAllFeedbacks()
	}

	private readUserState(raw: UserState | undefined): UserState {
		return {
			talk_active: { ...(raw?.talk_active ?? {}) },
			listen_active: { ...(raw?.listen_active ?? {}) },
			listen_level: { ...(raw?.listen_level ?? {}) },
			global_mode: raw?.global_mode ?? 'mute',
			global_active: raw?.global_active ?? false,
			party_line_talk_active: { ...(raw?.party_line_talk_active ?? {}) },
			party_line_listen_active: { ...(raw?.party_line_listen_active ?? {}) },
			party_line_listen_level: { ...(raw?.party_line_listen_level ?? {}) },
		}
	}

	private handleKeysChanged(message: KeysChangedMessage): void {
		this.applyKeys(message.keys ?? [])
	}

	private handleUserConnected(message: UserConnectedMessage): void {
		this.connectedUsers.add(message.user_id)
		this.availableUsers = this.availableUsers.map((user) =>
			user.id === message.user_id ? { ...user, is_connected: true } : user,
		)
		this.pushVariableValues()
		this.checkFeedbacks('user_connected', 'user_disconnected')
	}

	private handleUserDisconnected(message: UserDisconnectedMessage): void {
		this.connectedUsers.delete(message.user_id)
		this.availableUsers = this.availableUsers.map((user) =>
			user.id === message.user_id ? { ...user, is_connected: false } : user,
		)
		this.pushVariableValues()
		this.checkFeedbacks('user_connected', 'user_disconnected')
	}

	private handleServerError(message: ErrorMessage): void {
		this.log('warn', message.message)
	}

	private applyKeys(keys: KeyConfig[]): void {
		const previousKeys = new Map(this.keys.map((key) => [key.target_id, key]))
		this.keys = keys

		for (const key of keys) {
			const targetId = key.target_id
			const previousKey = previousKeys.get(targetId)
			if (!previousKey) {
				if (key.default_talk_active) {
					this.stateTalkMapForKey(key)[targetId] = true
					this.talkControlState.latched.set(targetId, true)
				}
				if (key.default_listen_active) {
					this.stateListenMapForKey(key)[targetId] = true
					this.listenControlState.latched.set(targetId, true)
				}
			}
			if (this.getListenLevel(key) === undefined) {
				this.setListenLevelLocal(key, key.target_type === 'party_line' ? 1 : 1)
			}
		}

		this.syncLatchStateFromServer()
		this.reconcileSelection()
		this.setupDefinitions()
	}

	private syncLatchStateFromServer(): void {
		for (const key of this.keys) {
			const targetId = key.target_id
			if (!this.talkControlState.pressing.get(targetId)) {
				this.talkControlState.latched.set(targetId, this.isLatched(key, 'talk'))
			}
			if (!this.listenControlState.pressing.get(targetId)) {
				this.listenControlState.latched.set(targetId, this.isLatched(key, 'listen'))
			}
		}

		if (!this.globalPressing) {
			this.globalLatched = this.state.global_active
		}
	}

	/**
	 * Whether the server holds this half latched on, as opposed to it merely
	 * being held down by somebody. Falls back to the effective state on servers
	 * that do not send the latched snapshot.
	 */
	private isLatched(key: KeyConfig, field: KeyField): boolean {
		const snapshot = this.latchedState
		if (!snapshot) {
			return field === 'talk' ? this.getTalkActive(key) : this.getListenActive(key)
		}
		const map =
			field === 'talk'
				? key.target_type === 'party_line'
					? snapshot.party_line_talk_active
					: snapshot.talk_active
				: key.target_type === 'party_line'
					? snapshot.party_line_listen_active
					: snapshot.listen_active
		return map[key.target_id] ?? false
	}

	private setupDefinitions(): void {
		this.setActionDefinitions(this.getActionDefinitions())
		this.setFeedbackDefinitions(this.getFeedbackDefinitions())
		const { structure, presets } = this.getPresetDefinitions()
		this.setPresetDefinitions(structure, presets)
		this.setVariableDefinitions(this.getVariableDefinitions())
		this.pushVariableValues()
	}

	private getActionDefinitions(): CompanionActionDefinitions {
		return {
			select_key: {
				name: 'Select key',
				description: 'Make this the key that "selected key" actions and feedbacks act on',
				options: this.getKeySelectorOptions(),
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (key) this.selectKey(key)
				},
			},
			talk_down: {
				name: 'Talk key down',
				options: [
					...this.getKeySelectorOptions(),
					this.getPressBehaviourOption(),
					{
						type: 'checkbox' as const,
						id: 'also_select',
						label: 'Also select this key',
						default: true,
					},
				],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (!key) return
					if (action.options.also_select !== false) this.selectKey(key)
					this.onTalkDown(key, this.readPressBehaviour(action.options))
				},
			},
			talk_up: {
				name: 'Talk key up',
				options: [
					...this.getKeySelectorOptions(),
					this.getPressBehaviourOption(),
					{
						type: 'checkbox' as const,
						id: 'double_tap_listen',
						label: 'Double tap switches listening',
						tooltip:
							'On a key that can both talk and listen, two quick taps toggle listen instead of leaving talk latched. Ignored on talk-only keys.',
						default: true,
					},
				],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (!key) return
					this.onTalkUp(
						key,
						this.readPressBehaviour(action.options),
						action.options.double_tap_listen !== false,
					)
				},
			},
			talk_set: {
				name: 'Talk set',
				options: [...this.getKeySelectorOptions(), this.getSetModeOption('mode')],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					const mode = (action.options.mode as SetMode | undefined) ?? 'toggle'
					if (key) this.onSetKeyMode(key, 'talk', mode)
				},
			},
			listen_down: {
				name: 'Listen key down',
				options: [
					...this.getKeySelectorOptions(),
					this.getPressBehaviourOption(),
					{
						type: 'checkbox' as const,
						id: 'also_select',
						label: 'Also select this key',
						default: true,
					},
					{
						type: 'checkbox' as const,
						id: 'long_press_selects',
						label: 'Long press selects this key',
						tooltip:
							'Holding the key makes it the selected key for as long as it is held, so the volume controls act on it, and hands the selection back on release. A held key does not latch either way.',
						default: false,
					},
				],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (!key) return
					if (action.options.also_select !== false) this.selectKey(key)
					this.onListenDown(
						key,
						this.readPressBehaviour(action.options),
						action.options.long_press_selects === true,
					)
				},
			},
			listen_up: {
				name: 'Listen key up',
				options: [
					...this.getKeySelectorOptions(),
					this.getPressBehaviourOption(),
					{
						type: 'checkbox' as const,
						id: 'long_press_selects',
						label: 'Long press selects this key',
						tooltip:
							'Holding the key makes it the selected key for as long as it is held, so the volume controls act on it, and hands the selection back on release. A held key does not latch either way.',
						default: false,
					},
				],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (key)
						this.onListenUp(
							key,
							this.readPressBehaviour(action.options),
							action.options.long_press_selects === true,
						)
				},
			},
			listen_set: {
				name: 'Listen set',
				options: [...this.getKeySelectorOptions(), this.getSetModeOption('mode')],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					const mode = (action.options.mode as SetMode | undefined) ?? 'toggle'
					if (key) this.onSetKeyMode(key, 'listen', mode)
				},
			},
			listen_level: {
				name: 'Set listen level',
				options: [
					...this.getKeySelectorOptions(),
					{
						type: 'number' as const,
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
					const key = this.resolveKey(action.options)
					const levelDb = Number(action.options.level ?? 0)
					if (key) this.onListenLevelSetDb(key, levelDb)
				},
			},
			listen_level_delta: {
				name: 'Change listen level by dB',
				options: [
					...this.getKeySelectorOptions(),
					{
						type: 'number' as const,
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
					const key = this.resolveKey(action.options)
					const deltaDb = Number(action.options.delta_db ?? 1)
					if (key) this.onListenLevelAdjustDb(key, deltaDb)
				},
			},
			global_mode: {
				name: 'Set global mode',
				options: [
					{
						type: 'dropdown' as const,
						id: 'mode',
						label: 'Mode',
						default: 'mute',
						choices: globalModeChoices,
					},
				],
				callback: async (action) => {
					const mode = (action.options.mode as GlobalMode | undefined) ?? 'mute'
					this.onGlobalModeSet(mode)
				},
			},
			global_down: {
				name: 'Global button down',
				options: [],
				callback: async () => {
					this.onGlobalDown()
				},
			},
			global_up: {
				name: 'Global button up',
				options: [],
				callback: async () => {
					this.onGlobalUp()
				},
			},
			global_set: {
				name: 'Global set',
				options: [this.getSetModeOption('mode')],
				callback: async (action) => {
					const mode = (action.options.mode as SetMode | undefined) ?? 'toggle'
					this.onGlobalSet(mode)
				},
			},
		}
	}

	private getFeedbackDefinitions(): CompanionFeedbackDefinitions {
		return {
			talk_active: {
				type: 'boolean',
				name: 'Talk active',
				defaultStyle: {
					bgcolor: combineRgb(255, 0, 0),
					color: combineRgb(255, 255, 255),
				},
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.getTalkActive(key) : false
				},
			},
			listen_active: {
				type: 'boolean',
				name: 'Listen active',
				defaultStyle: {
					bgcolor: combineRgb(0, 180, 0),
					color: combineRgb(255, 255, 255),
				},
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.getListenActive(key) : false
				},
			},
			talk_latched: {
				type: 'boolean',
				name: 'Talk latched',
				description: 'Talk is on and holding itself, rather than being held down',
				defaultStyle: {
					bgcolor: combineRgb(255, 0, 0),
					color: combineRgb(255, 255, 255),
				},
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.getLatchMode(key, 'talk') === 'latched' : false
				},
			},
			talk_momentary: {
				type: 'boolean',
				name: 'Talk held (momentary)',
				description: 'Talk is on only for as long as the key is held',
				defaultStyle: {
					bgcolor: combineRgb(160, 0, 0),
					color: combineRgb(255, 255, 255),
				},
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.getLatchMode(key, 'talk') === 'momentary' : false
				},
			},
			listen_latched: {
				type: 'boolean',
				name: 'Listen latched',
				description: 'Listen is on and holding itself, rather than being held down',
				defaultStyle: {
					bgcolor: combineRgb(0, 180, 0),
					color: combineRgb(255, 255, 255),
				},
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.getLatchMode(key, 'listen') === 'latched' : false
				},
			},
			listen_momentary: {
				type: 'boolean',
				name: 'Listen held (momentary)',
				description: 'Listen is on only for as long as the key is held',
				defaultStyle: {
					bgcolor: combineRgb(0, 120, 0),
					color: combineRgb(255, 255, 255),
				},
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.getLatchMode(key, 'listen') === 'momentary' : false
				},
			},
			key_selected: {
				type: 'boolean',
				name: 'Key is selected',
				defaultStyle: {
					color: combineRgb(255, 255, 255),
				},
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					if (!key) return false
					return this.keyTargetToken(key) === this.selectedKeyToken
				},
			},
			key_listen_level_db: {
				type: 'value',
				name: 'Listen level (dB)',
				description: 'The listen level as a number, for driving a gauge or text',
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					if (!key) return MIN_LISTEN_LEVEL_DB
					return Number(this.getListenLevelDb(key).toFixed(1))
				},
			},
			key_name: {
				type: 'value',
				name: 'Key display name',
				description: 'The name of the key, for use as button text',
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? key.display_name : ''
				},
			},
			user_connected: {
				type: 'boolean',
				name: 'User connected',
				defaultStyle: {
					color: combineRgb(255, 255, 255),
				},
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.isKeyUserConnected(key) : false
				},
			},
			user_disconnected: {
				type: 'boolean',
				name: 'User disconnected',
				defaultStyle: {
					color: combineRgb(128, 128, 128),
				},
				options: this.getKeySelectorOptions(),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? !this.isKeyUserConnected(key) : false
				},
			},
			global_active: {
				type: 'boolean',
				name: 'Global active',
				defaultStyle: {
					bgcolor: combineRgb(255, 255, 0),
					color: combineRgb(0, 0, 0),
				},
				options: [],
				callback: async () => this.state.global_active,
			},
		}
	}

	private getPresetDefinitions(): {
		structure: CompanionPresetSection<LiveMatrixManifest>[]
		presets: CompanionPresetDefinitions<LiveMatrixManifest>
	} {
		const presets: CompanionPresetDefinitions<LiveMatrixManifest> = {
			global_button: {
				type: 'simple',
				name: 'Global button',
				style: {
					text: 'GLOBAL\n$(livematrix:global_mode)',
					size: 14,
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 0),
					alignment: 'center:center' as const,
				},
				feedbacks: [
					{
						feedbackId: 'global_active',
						options: {},
						style: {
							bgcolor: combineRgb(255, 255, 0),
							color: combineRgb(0, 0, 0),
						},
					},
				],
				steps: [
					{
						down: [{ actionId: 'global_down', options: {} }],
						up: [{ actionId: 'global_up', options: {} }],
					},
				],
			},
		}
		presets['selected_volume'] = this.createSelectedVolumePreset()
		presets['selected_volume_up'] = this.createSelectedVolumeStepPreset('up')
		presets['selected_volume_down'] = this.createSelectedVolumeStepPreset('down')

		const globalPresets = [
			'global_button',
			'selected_volume',
			'selected_volume_up',
			'selected_volume_down',
		]
		const keyIndexPresets: string[] = []
		const keyTargetPresets: string[] = []
		const talkIndexPresets: string[] = []
		const listenIndexPresets: string[] = []
		const talkTargetPresets: string[] = []
		const listenTargetPresets: string[] = []

		for (const [index, key] of this.keys.entries()) {
			const targetToken = this.keyTargetToken(key)
			const safeName = sanitizeName(key.display_name)

			const keyIndexId = `key_index_${index}`
			presets[keyIndexId] = this.createLayeredKeyPreset(
				`Intercom key ${index}`,
				this.presetKeyOptions('index', { index, target: targetToken }),
			)
			keyIndexPresets.push(keyIndexId)

			const keyTargetId = `key_target_${safeName}_${index}`
			presets[keyTargetId] = this.createLayeredKeyPreset(
				`Intercom ${key.display_name}`,
				this.presetKeyOptions('target', { index, target: targetToken }),
			)
			keyTargetPresets.push(keyTargetId)

			const talkIndexId = `talk_index_${index}`
			presets[talkIndexId] = this.createSideKeyPreset(
				'talk',
				`Talk key ${index}`,
				this.presetKeyOptions('index', { index, target: targetToken }),
			)
			talkIndexPresets.push(talkIndexId)

			const listenIndexId = `listen_index_${index}`
			presets[listenIndexId] = this.createSideKeyPreset(
				'listen',
				`Listen key ${index}`,
				this.presetKeyOptions('index', { index, target: targetToken }),
			)
			listenIndexPresets.push(listenIndexId)

			const talkTargetId = `talk_target_${safeName}_${index}`
			presets[talkTargetId] = this.createSideKeyPreset(
				'talk',
				`Talk ${key.display_name}`,
				this.presetKeyOptions('target', { index, target: targetToken }),
			)
			talkTargetPresets.push(talkTargetId)

			const listenTargetId = `listen_target_${safeName}_${index}`
			presets[listenTargetId] = this.createSideKeyPreset(
				'listen',
				`Listen ${key.display_name}`,
				this.presetKeyOptions('target', { index, target: targetToken }),
			)
			listenTargetPresets.push(listenTargetId)
		}

		const structure: CompanionPresetSection<LiveMatrixManifest>[] = [
			{
				id: 'keys-index',
				name: 'Intercom Keys (by index)',
				definitions: keyIndexPresets,
			},
			{
				id: 'keys-target',
				name: 'Intercom Keys (by target)',
				definitions: keyTargetPresets,
			},
			{
				id: 'global',
				name: 'Global',
				definitions: globalPresets,
			},
			{
				id: 'talk-index',
				name: 'Talk Keys (by index)',
				definitions: talkIndexPresets,
			},
			{
				id: 'listen-index',
				name: 'Listen Keys (by index)',
				definitions: listenIndexPresets,
			},
			{
				id: 'talk-target',
				name: 'Talk Keys (by target)',
				definitions: talkTargetPresets,
			},
			{
				id: 'listen-target',
				name: 'Listen Keys (by target)',
				definitions: listenTargetPresets,
			},
		]

		return { structure, presets }
	}

	/** Wrap a Companion expression so it is evaluated per button rather than taken literally. */
	private expr<T>(expression: string) {
		return { isExpression: true as const, value: expression } as unknown as T
	}

	/**
	 * Wrap a literal for a feedback style override. Companion drops overrides whose value
	 * is not in expression-or-value form, which silently disables the whole feedback.
	 */
	private overrideValue<T extends JsonValue>(value: T) {
		return { isExpression: false as const, value }
	}

	/**
	 * An intercom key drawn as two gradient halves: listen fills the left half green,
	 * talk fills the right half red. Both fade to near-black towards the middle so the
	 * label stays readable, and read as a saturated edge at the outside.
	 * A bar along the bottom shows the listen level.
	 */
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
			{ id: `${side}-border-top`, type: 'line' as const, name: `${side} top`, fromX: x0, fromY: 0, toX: x1, toY: 0, ...common },
			{ id: `${side}-border-side`, type: 'line' as const, name: `${side} edge`, fromX: edge, fromY: 0, toX: edge, toY: 100, ...common },
			{ id: `${side}-border-bottom`, type: 'line' as const, name: `${side} bottom`, fromX: x0, fromY: 100, toX: x1, toY: 100, ...common },
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
			value: this.expr<number>('$(local:level)'),
			min: MIN_LISTEN_LEVEL_DB_DISPLAY,
			max: MAX_LISTEN_LEVEL_DB,
			fillEnabled: true,
			roundedEnds: true,
			trackStyle: 'dimmed' as const,
			// How much colour the unfilled rail keeps; low so the fill reads as a level.
			trackAmount: 18,
			multiColour: true,
			stops: [
				{ value: MIN_LISTEN_LEVEL_DB_DISPLAY, color: combineRgb(70, 130, 180), gradient: true },
				{ value: 0, color: combineRgb(200, 225, 255), gradient: true },
				{ value: MAX_LISTEN_LEVEL_DB, color: combineRgb(255, 190, 60), gradient: false },
			],
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
	private createSideKeyPreset(mode: KeyField, name: string, keyOptions: CompanionOptionValues) {
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
					text: this.expr<string>('$(local:name)'),
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
						{ elementId: 'fill', elementProperty: 'enabled', override: this.overrideValue(true) },
					],
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
										override: this.overrideValue(true),
									},
								],
							},
						]
					: []),
				{
					feedbackId: 'user_disconnected' as const,
					options: keyOptions,
					styleOverrides: [
						{ elementId: 'label', elementProperty: 'opacity', override: this.overrideValue(OFFLINE_OPACITY) },
						{ elementId: 'border', elementProperty: 'opacity', override: this.overrideValue(OFFLINE_OPACITY) },
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

	private createLayeredKeyPreset(name: string, keyOptions: CompanionOptionValues) {

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
						{ value: 0, color: combineRgb(0, 220, 90), gradient: true },
						{ value: 100, color: combineRgb(0, 20, 8), gradient: true },
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
						{ value: 0, color: combineRgb(24, 0, 0), gradient: true },
						{ value: 100, color: combineRgb(255, 40, 40), gradient: true },
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
					color: combineRgb(0, 220, 90),
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
					color: combineRgb(255, 40, 40),
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
					text: this.expr<string>('$(local:name)'),
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
					styleOverrides: [{ elementId: 'listen-fill', elementProperty: 'enabled', override: this.overrideValue(true) }],
				},
				{
					feedbackId: 'talk_active' as const,
					options: keyOptions,
					styleOverrides: [{ elementId: 'talk-fill', elementProperty: 'enabled', override: this.overrideValue(true) }],
				},
				{
					feedbackId: 'listen_latched' as const,
					options: keyOptions,
					styleOverrides: [{ elementId: 'listen-latched-bar', elementProperty: 'enabled', override: this.overrideValue(true) }],
				},
				{
					feedbackId: 'talk_latched' as const,
					options: keyOptions,
					styleOverrides: [{ elementId: 'talk-latched-bar', elementProperty: 'enabled', override: this.overrideValue(true) }],
				},
				{
					feedbackId: 'key_selected' as const,
					options: keyOptions,
					styleOverrides: [{ elementId: 'level-border', elementProperty: 'enabled', override: this.overrideValue(true) }],
				},
				{
					feedbackId: 'user_disconnected' as const,
					options: keyOptions,
					styleOverrides: [
						{ elementId: 'label', elementProperty: 'opacity', override: this.overrideValue(OFFLINE_OPACITY) },
					],
				},
			],
			steps: [
				{
					down: [{ actionId: 'talk_down' as const, options: { ...keyOptions, press_behaviour: 'auto', also_select: true } }],
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
	 * A rotary control for whichever key is currently selected: turn to trim the level,
	 * press to return it to unity.
	 */
	/**
	 * A plain up or down key for the selected key's level, for surfaces with no
	 * encoder. Holding it repeats, so a long trim does not mean twenty presses.
	 */
	private createSelectedVolumeStepPreset(direction: 'up' | 'down') {
		const selectedOptions = this.presetKeyOptions('selected')
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
					text: this.expr<string>('$(local:name)'),
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
					text: this.expr<string>('$(local:level) dB'),
					fontsize: fontsizeForBox(TEXT_LEVEL, 20),
					fontsizeAllowShrink: true,
					font: 'companion-mono' as const,
					color: combineRgb(200, 225, 255),
					halign: 'center' as const,
					valign: 'center' as const,
				},
				{
					id: 'level-bar',
					type: 'gauge' as const,
					name: 'Listen level',
					x: 8,
					y: 84,
					width: 84,
					height: 8,
					orientation: 'horizontal' as const,
					value: this.expr<number>('$(local:level)'),
					min: MIN_LISTEN_LEVEL_DB_DISPLAY,
					max: MAX_LISTEN_LEVEL_DB,
					fillEnabled: true,
					roundedEnds: true,
					trackStyle: 'dimmed' as const,
					trackAmount: 18,
					multiColour: true,
					stops: [
						{ value: MIN_LISTEN_LEVEL_DB_DISPLAY, color: combineRgb(70, 130, 180), gradient: true },
						{ value: 0, color: combineRgb(200, 225, 255), gradient: true },
						{ value: MAX_LISTEN_LEVEL_DB, color: combineRgb(255, 190, 60), gradient: false },
					],
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
					down: [
						{ actionId: 'listen_level_delta' as const, options: { ...selectedOptions, delta_db: stepDb } },
					],
					up: [],
					// Held past half a second, keep stepping every 150ms.
					500: {
						options: { runWhileHeld: true },
						actions: [
							{ actionId: 'listen_level_delta' as const, options: { ...selectedOptions, delta_db: stepDb } },
						],
					},
				},
			],
		}
	}

	private createSelectedVolumePreset() {
		const selectedOptions = this.presetKeyOptions('selected')

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
					value: this.expr<number>('$(local:level)'),
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
					stops: [
						{ value: MIN_LISTEN_LEVEL_DB_DISPLAY, color: combineRgb(70, 130, 180), gradient: true },
						{ value: 0, color: combineRgb(200, 225, 255), gradient: true },
						{ value: MAX_LISTEN_LEVEL_DB, color: combineRgb(255, 190, 60), gradient: false },
					],
				},
				{
					id: 'name',
					type: 'text' as const,
					name: 'Selected key',
					x: 12,
					y: 22,
					width: 76,
					height: 26,
					text: this.expr<string>('$(local:name)'),
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
					x: 12,
					y: 48,
					width: 76,
					height: 24,
					text: this.expr<string>('$(local:level) dB'),
					fontsize: fontsizeForBox(TEXT_LEVEL, 20),
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

	private getVariableDefinitions(): CompanionVariableDefinitions {
		const variables: CompanionVariableDefinitions = {
			user_id: { name: 'Logged-in user ID' },
			display_name: { name: 'Logged-in display name' },
			connected: { name: 'Connected' },
			global_mode: { name: 'Global mode' },
			global_active: { name: 'Global active' },
			key_count: { name: 'Key count' },
			selected_key_index: { name: 'Selected key index' },
			selected_key_name: { name: 'Selected key display name' },
			selected_key_target_id: { name: 'Selected key target ID' },
			selected_key_talk: { name: 'Selected key talk active' },
			selected_key_listen: { name: 'Selected key listen active' },
			selected_key_level: { name: 'Selected key listen level dB' },
		}

		const seenTargetNames = new Set<string>()
		for (const [index, key] of this.keys.entries()) {
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

		return variables
	}

	private pushVariableValues(): void {
		const values: CompanionVariableValues = {
			user_id: this.userId,
			display_name: this.displayName,
			connected: this.isSocketOpen(),
			global_mode: this.state.global_mode,
			global_active: this.state.global_active,
			key_count: this.keys.length,
		}

		const selectedKey = this.getSelectedKey()
		values.selected_key_index = selectedKey ? this.keys.indexOf(selectedKey) : -1
		values.selected_key_name = selectedKey?.display_name ?? ''
		values.selected_key_target_id = selectedKey?.target_id ?? ''
		values.selected_key_talk = selectedKey ? this.getTalkActive(selectedKey) : false
		values.selected_key_listen = selectedKey ? this.getListenActive(selectedKey) : false
		values.selected_key_level = selectedKey ? this.formatListenLevelDb(this.getListenLevelDb(selectedKey)) : ''

		const seenTargetNames = new Set<string>()
		for (const [index, key] of this.keys.entries()) {
			const talk = this.getTalkActive(key)
			const listen = this.getListenActive(key)
			const level = this.formatListenLevelDb(this.getListenLevelDb(key))
			const sanitized = sanitizeName(key.display_name)

			values[`key_${index}_name`] = key.display_name
			values[`key_${index}_target_type`] = key.target_type
			values[`key_${index}_target_id`] = key.target_id
			values[`key_${index}_talk`] = talk
			values[`key_${index}_listen`] = listen
			values[`key_${index}_level`] = level
			values[`key_${index}_talk_mode`] = this.getLatchMode(key, 'talk')
			values[`key_${index}_listen_mode`] = this.getLatchMode(key, 'listen')

			values[`tid_${key.target_id}_name`] = key.display_name
			values[`tid_${key.target_id}_talk`] = talk
			values[`tid_${key.target_id}_listen`] = listen
			values[`tid_${key.target_id}_level`] = level

			if (!seenTargetNames.has(sanitized)) {
				seenTargetNames.add(sanitized)
				values[`target_${sanitized}_talk`] = talk
				values[`target_${sanitized}_listen`] = listen
				values[`target_${sanitized}_level`] = level
			}
		}

		this.setVariableValues(values)
	}

	private getKeySelectorOptions() {
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
				max: Math.max(0, this.keys.length - 1),
				range: false,
				isVisibleExpression: "$(options:selection_mode) == 'index'",
			},
			{
				type: 'dropdown' as const,
				id: 'key_target',
				label: 'Target',
				default: this.keys[0] ? this.keyTargetToken(this.keys[0]) : '',
				choices: this.getKeyChoices(),
				isVisibleExpression: "$(options:selection_mode) == 'target'",
			},
		]
	}

	private getPressBehaviourOption() {
		return {
			type: 'dropdown' as const,
			id: 'press_behaviour',
			label: 'Press behaviour',
			default: 'auto',
			choices: pressBehaviourChoices,
		}
	}

	/**
	 * Option values for a key selector as a preset must supply them: every field the
	 * selector declares needs a value, including the ones the visibility expressions
	 * hide, or the options fail validation when the action runs.
	 */
	private presetKeyOptions(
		mode: KeySelectionMode,
		key?: { index?: number; target?: string },
	): CompanionOptionValues {
		return {
			selection_mode: mode,
			key_index: key?.index ?? 0,
			key_target: key?.target ?? (this.keys[0] ? this.keyTargetToken(this.keys[0]) : ''),
		}
	}

	private readPressBehaviour(options: CompanionOptionValues): PressBehaviour {
		return (options.press_behaviour as PressBehaviour | undefined) ?? 'auto'
	}

	private getSetModeOption(id: string) {
		return {
			type: 'dropdown' as const,
			id,
			label: 'Mode',
			default: 'toggle',
			choices: setModeChoices,
		}
	}

	private getKeyChoices(): DropdownChoice[] {
		return this.keys.map((key) => ({
			id: this.keyTargetToken(key),
			label: `${key.display_name} (${key.target_type})`,
		}))
	}

	private resolveKey(options: CompanionOptionValues): KeyConfig | undefined {
		const selectionMode = (options.selection_mode as KeySelectionMode | undefined) ?? 'target'
		if (selectionMode === 'selected') return this.getSelectedKey()
		if (selectionMode === 'index') {
			const index = Number(options.key_index ?? 0)
			if (!Number.isInteger(index) || index < 0 || index >= this.keys.length) return undefined
			return this.keys[index]
		}

		const target = String(options.key_target ?? '')
		return this.keys.find((key) => this.keyTargetToken(key) === target)
	}

	private keyTargetToken(key: KeyConfig): string {
		return `${key.target_type}:${key.target_id}`
	}

	/** The key that volume actions and 'selected key' feedbacks operate on. */
	private getSelectedKey(): KeyConfig | undefined {
		if (!this.selectedKeyToken) return undefined
		return this.keys.find((key) => this.keyTargetToken(key) === this.selectedKeyToken)
	}

	private selectKey(key: KeyConfig): void {
		const token = this.keyTargetToken(key)
		if (this.selectedKeyToken === token) return
		this.selectedKeyToken = token
		this.checkFeedbacks('key_selected')
		this.pushVariableValues()
	}

	/**
	 * Drop the selection if the selected key is gone, and select something sensible
	 * on first load so the volume knob is never pointing at nothing.
	 */
	private reconcileSelection(): void {
		if (this.selectedKeyToken && this.getSelectedKey()) return
		const fallback = this.keys.find((key) => key.can_listen) ?? this.keys[0]
		this.selectedKeyToken = fallback ? this.keyTargetToken(fallback) : undefined
	}

	private onTalkDown(key: KeyConfig, behaviour: PressBehaviour = 'auto'): void {
		if (!key.can_talk) return

		// Latch-only keys toggle on the press and never hold, so there is nothing
		// momentary to start.
		if (this.latchesOnPress(key, 'talk', behaviour)) {
			this.onSetKeyMode(key, 'talk', 'toggle')
			return
		}

		// A press landing on a held-back release is the second half of a double
		// tap. Drop the press the first tap was still holding rather than
		// latching it, and leave talk alone until we see how this one ends.
		if (this.cancelSettle(key)) {
			this.secondTapInProgress.add(key.target_id)
			this.releaseTalkPress(key)
			this.talkControlState.pressStart.set(key.target_id, Date.now())
			this.talkControlState.pressing.set(key.target_id, true)
			return
		}

		this.talkControlState.pressStart.set(key.target_id, Date.now())
		this.talkControlState.pressing.set(key.target_id, true)

		// On a key that double taps, hold the mic closed for a moment. A tap
		// quick enough to be half of a double tap is over before this fires, so
		// the gesture never opens the mic or lights the key at all.
		if (PRESS_SETTLE_MS > 0 && this.doubleTapArmedForKey(key)) {
			this.pressTimers.set(
				key.target_id,
				setTimeout(() => {
					this.pressTimers.delete(key.target_id)
					this.applyTalkPress(key)
				}, PRESS_SETTLE_MS),
			)
			return
		}

		this.applyTalkPress(key)
	}

	private applyTalkPress(key: KeyConfig): void {
		this.pressApplied.add(key.target_id)
		this.setTalkActive(key, this.getEffectiveState(this.talkControlState, key.target_id))
	}

	/** Cancel a press that has not opened the mic yet. */
	private cancelPendingPress(key: KeyConfig): boolean {
		const timer = this.pressTimers.get(key.target_id)
		if (!timer) return false
		clearTimeout(timer)
		this.pressTimers.delete(key.target_id)
		return true
	}

	/** Let go of a held press without touching the latched layer. */
	private releaseTalkPress(key: KeyConfig): void {
		this.cancelPendingPress(key)
		this.talkControlState.pressing.set(key.target_id, false)
		if (!this.pressApplied.delete(key.target_id)) return

		this.setTalkActive(key, this.getEffectiveState(this.talkControlState, key.target_id), {
			forceSend: true,
			momentary: false,
		})
		this.sendKeyState(key, 'talk', 'momentary', false)
	}

	private cancelSettle(key: KeyConfig): boolean {
		const timer = this.settleTimers.get(key.target_id)
		if (!timer) return false
		clearTimeout(timer)
		this.settleTimers.delete(key.target_id)
		return true
	}

	private onTalkUp(key: KeyConfig, behaviour: PressBehaviour = 'auto', doubleTapListen = true): void {
		if (!key.can_talk) return
		if (this.latchesOnPress(key, 'talk', behaviour)) return

		// The release that ends a double tap: the press was never applied, so
		// there is nothing to undo - just switch listening.
		if (this.secondTapInProgress.delete(key.target_id)) {
			this.talkControlState.pressing.set(key.target_id, false)
			this.lastTapAt.delete(key.target_id)
			this.talkLatchBeforeTap.delete(key.target_id)
			this.onSetKeyMode(key, 'listen', 'toggle')
			return
		}

		// A press let go before it opened the mic never transmitted; there is
		// nothing to hand over to the latched layer later.
		this.cancelPendingPress(key)

		const wasShortPress = this.wasShortPress(this.talkControlState, key.target_id)
		const latchedBefore = this.talkControlState.latched.get(key.target_id) ?? false

		// Hold a tap's talk state back briefly in case a second tap follows. The
		// press stays held meanwhile, so a plain tap that turns into a latch has
		// no gap in it, and one that turns into a double tap never latches.
		if (wasShortPress && this.doubleTapArmed(key, doubleTapListen)) {
			this.settleTimers.set(
				key.target_id,
				setTimeout(() => {
					this.settleTimers.delete(key.target_id)
					this.commitTalkRelease(key, behaviour, wasShortPress, latchedBefore, doubleTapListen)
				}, DOUBLE_TAP_SETTLE_MS),
			)
			return
		}

		this.commitTalkRelease(key, behaviour, wasShortPress, latchedBefore, doubleTapListen)
	}

	/**
	 * Apply what a release means once we know no second tap is coming.
	 */
	private commitTalkRelease(
		key: KeyConfig,
		behaviour: PressBehaviour,
		wasShortPress: boolean,
		latchedBefore: boolean,
		doubleTapListen: boolean,
	): void {
		const wasMomentary = this.pressApplied.delete(key.target_id)
		this.talkControlState.pressing.set(key.target_id, false)

		// A late second tap - one that arrived after the settle window, so the
		// first tap had already latched - still switches listening, and puts talk
		// back where that first tap found it.
		const secondTap = wasShortPress && this.takeDoubleTap(key, doubleTapListen)
		if (secondTap) {
			this.talkControlState.latched.set(key.target_id, this.talkLatchBeforeTap.get(key.target_id) ?? false)
			this.talkLatchBeforeTap.delete(key.target_id)
		} else if (this.latchesOnRelease(key, 'talk', behaviour) && wasShortPress) {
			this.talkControlState.latched.set(key.target_id, !latchedBefore)
		}

		if (wasShortPress && !secondTap && this.doubleTapArmed(key, doubleTapListen)) {
			this.lastTapAt.set(key.target_id, Date.now())
			this.talkLatchBeforeTap.set(key.target_id, latchedBefore)
		}

		const newEffective = this.getEffectiveState(this.talkControlState, key.target_id)
		if (wasMomentary && newEffective && (this.talkControlState.latched.get(key.target_id) ?? false)) {
			// Hand the press over to the latched layer before letting go of it,
			// so the key never drops out for a moment in between.
			this.setTalkActive(key, true, { forceSend: true, momentary: false })
			this.sendKeyState(key, 'talk', 'momentary', false)
		} else {
			this.setTalkActive(key, newEffective)
		}

		if (secondTap) {
			this.onSetKeyMode(key, 'listen', 'toggle')
		}
	}

	/** Whether this key takes the double-tap gesture at all. */
	private doubleTapArmed(key: KeyConfig, enabled: boolean): boolean {
		return enabled && this.doubleTapArmedForKey(key)
	}

	private doubleTapArmedForKey(key: KeyConfig): boolean {
		return key.can_talk && key.can_listen
	}

	/**
	 * Whether this release completes a double tap, consuming it if so.
	 *
	 * Only combined keys qualify: on a talk-only key there is nothing to switch,
	 * and swallowing the second tap's latch would just make the key feel broken.
	 */
	private takeDoubleTap(key: KeyConfig, enabled: boolean): boolean {
		if (!this.doubleTapArmed(key, enabled)) return false

		const previous = this.lastTapAt.get(key.target_id)
		if (previous === undefined || Date.now() - previous > DOUBLE_TAP_WINDOW_MS) return false

		this.lastTapAt.delete(key.target_id)
		return true
	}

	private onListenDown(key: KeyConfig, behaviour: PressBehaviour = 'auto', longPressSelects = false): void {
		if (!key.can_listen) return

		// Held rather than tapped, this key takes the selection for the duration
		// of the press, so the volume controls can be pointed at it without
		// giving up whatever was selected before.
		if (longPressSelects) {
			this.selectHoldTimers.set(
				key.target_id,
				setTimeout(() => {
					this.selectHoldTimers.delete(key.target_id)
					this.selectionBeforeHold.set(key.target_id, this.selectedKeyToken)
					this.selectKey(key)
				}, LONG_PRESS_SELECT_MS),
			)
		}

		if (this.latchesOnPress(key, 'listen', behaviour)) {
			this.onSetKeyMode(key, 'listen', 'toggle')
			return
		}

		this.listenControlState.pressStart.set(key.target_id, Date.now())
		this.listenControlState.pressing.set(key.target_id, true)
		this.setListenActive(key, this.getEffectiveState(this.listenControlState, key.target_id))
	}

	private onListenUp(key: KeyConfig, behaviour: PressBehaviour = 'auto', longPressSelects = false): void {
		if (!key.can_listen) return

		if (longPressSelects) this.endSelectHold(key)
		if (this.latchesOnPress(key, 'listen', behaviour)) return

		const wasShortPress = this.wasShortPress(this.listenControlState, key.target_id)
		const wasMomentary = this.listenControlState.pressing.get(key.target_id) ?? false

		this.listenControlState.pressing.set(key.target_id, false)
		if (this.latchesOnRelease(key, 'listen', behaviour) && wasShortPress) {
			this.listenControlState.latched.set(key.target_id, !(this.listenControlState.latched.get(key.target_id) ?? false))
		}

		const newEffective = this.getEffectiveState(this.listenControlState, key.target_id)
		if (wasMomentary && newEffective && (this.listenControlState.latched.get(key.target_id) ?? false)) {
			this.setListenActive(key, true, { forceSend: true, momentary: false })
			this.sendKeyState(key, 'listen', 'momentary', false)
		} else {
			this.setListenActive(key, newEffective)
		}
	}

	/**
	 * 'latch' presses toggle immediately and hold nothing; the other behaviours run
	 * the press as momentary and decide about latching on release.
	 */
	private latchesOnPress(key: KeyConfig, kind: 'talk' | 'listen', behaviour: PressBehaviour): boolean {
		return behaviour === 'latch' && this.keyAllowsLatching(key, kind)
	}

	private latchesOnRelease(key: KeyConfig, kind: 'talk' | 'listen', behaviour: PressBehaviour): boolean {
		if (behaviour === 'momentary') return false
		if (behaviour === 'latch') return false
		return this.keyAllowsLatching(key, kind)
	}

	private keyAllowsLatching(key: KeyConfig, kind: 'talk' | 'listen'): boolean {
		return kind === 'talk' ? key.allow_talk_latching : key.allow_listen_latching
	}

	/** Whether a key is off, held down momentarily, or latched on. */
	private getLatchMode(key: KeyConfig, kind: KeyField): LatchMode {
		const active = kind === 'talk' ? this.getTalkActive(key) : this.getListenActive(key)
		if (!active) return 'off'
		return this.isLatched(key, kind) ? 'latched' : 'momentary'
	}

	/** Give the selection back once a borrowing listen key is released. */
	private endSelectHold(key: KeyConfig): void {
		const timer = this.selectHoldTimers.get(key.target_id)
		if (timer) {
			clearTimeout(timer)
			this.selectHoldTimers.delete(key.target_id)
		}

		if (!this.selectionBeforeHold.has(key.target_id)) return
		const previous = this.selectionBeforeHold.get(key.target_id)
		this.selectionBeforeHold.delete(key.target_id)

		this.selectedKeyToken = previous
		this.reconcileSelection()
		this.checkFeedbacks('key_selected')
		this.pushVariableValues()
	}

	private onSetKeyMode(key: KeyConfig, kind: 'talk' | 'listen', mode: SetMode): void {
		if (kind === 'talk' && !key.can_talk) return
		if (kind === 'listen' && !key.can_listen) return

		const controlState = kind === 'talk' ? this.talkControlState : this.listenControlState
		controlState.pressing.set(key.target_id, false)

		switch (mode) {
			case 'toggle': {
				const current = kind === 'talk' ? this.getTalkActive(key) : this.getListenActive(key)
				controlState.latched.set(key.target_id, !current)
				break
			}
			case 'on':
				controlState.latched.set(key.target_id, true)
				break
			case 'off':
				controlState.latched.set(key.target_id, false)
				break
		}

		const active = mode === 'off' ? false : this.getEffectiveState(controlState, key.target_id)
		if (kind === 'talk') {
			this.setTalkActive(key, active, { forceSend: true, momentary: false })
		} else {
			this.setListenActive(key, active, { forceSend: true, momentary: false })
		}
	}

	private onListenLevelSetDb(key: KeyConfig, levelDb: number): void {
		if (!key.can_listen) return
		const linearLevel = this.clampListenLevelLinear(key, dbToLinear(levelDb))
		this.setListenLevelLocal(key, linearLevel)
		this.send({ type: 'set_key_level', key: this.keyRef(key), level: linearLevel })
		this.pushVariableValues()
	}

	private onListenLevelAdjustDb(key: KeyConfig, deltaDb: number): void {
		if (!key.can_listen) return
		const nextLevelDb = this.getListenLevelDb(key) + deltaDb
		this.onListenLevelSetDb(key, nextLevelDb)
	}

	private onGlobalModeSet(mode: GlobalMode): void {
		this.state.global_mode = mode
		this.send({ type: 'set_global_mode', mode })
		this.pushVariableValues()
	}

	private onGlobalDown(): void {
		this.globalPressStart = Date.now()
		this.globalPressing = true
		this.syncGlobalActive()
	}

	private onGlobalUp(): void {
		const wasShortPress = this.globalPressStart !== undefined && Date.now() - this.globalPressStart < TAP_THRESHOLD_MS
		this.globalPressing = false
		if (wasShortPress) {
			this.globalLatched = !this.globalLatched
		}
		this.syncGlobalActive()
	}

	private onGlobalSet(mode: SetMode): void {
		this.globalPressing = false
		switch (mode) {
			case 'toggle':
				this.globalLatched = !this.state.global_active
				break
			case 'on':
				this.globalLatched = true
				break
			case 'off':
				this.globalLatched = false
				break
		}
		this.syncGlobalActive()
	}

	private syncGlobalActive(): void {
		this.state.global_active = this.globalLatched || this.globalPressing
		this.send({ type: 'set_global_active', active: this.state.global_active })
		this.pushVariableValues()
		this.checkFeedbacks('global_active')
	}

	private wasShortPress(controlState: KeyControlState, targetId: string): boolean {
		const pressStart = controlState.pressStart.get(targetId)
		return pressStart !== undefined && Date.now() - pressStart < TAP_THRESHOLD_MS
	}

	private getEffectiveState(controlState: KeyControlState, targetId: string): boolean {
		return (controlState.latched.get(targetId) ?? false) || (controlState.pressing.get(targetId) ?? false)
	}

	private setTalkActive(
		key: KeyConfig,
		active: boolean,
		options: { forceSend?: boolean; momentary?: boolean } = {},
	): void {
		const current = this.getTalkActive(key)
		if (current === active && !options.forceSend) return

		this.stateTalkMapForKey(key)[key.target_id] = active
		const momentary =
			options.momentary ??
			(active &&
				(this.talkControlState.pressing.get(key.target_id) ?? false) &&
				!(this.talkControlState.latched.get(key.target_id) ?? false))

		this.sendKeyState(key, 'talk', momentary ? 'momentary' : 'latched', active)

		this.pushVariableValues()
		this.checkFeedbacks('talk_active', 'talk_latched', 'talk_momentary')
	}

	private setListenActive(
		key: KeyConfig,
		active: boolean,
		options: { forceSend?: boolean; momentary?: boolean } = {},
	): void {
		const current = this.getListenActive(key)
		if (current === active && !options.forceSend) return

		this.stateListenMapForKey(key)[key.target_id] = active
		const momentary =
			options.momentary ??
			(active &&
				(this.listenControlState.pressing.get(key.target_id) ?? false) &&
				!(this.listenControlState.latched.get(key.target_id) ?? false))

		this.sendKeyState(key, 'listen', momentary ? 'momentary' : 'latched', active)

		this.pushVariableValues()
		this.checkFeedbacks('listen_active', 'listen_latched', 'listen_momentary')
	}

	/**
	 * Every talk/listen change goes out as one `set_key_state`, whatever the key
	 * points at. `hold` picks the layer: `latched` is an explicit on/off the
	 * server persists, `momentary` is a press we then have to keep renewing.
	 */
	private sendKeyState(key: KeyConfig, field: KeyField, hold: Hold, active: boolean): void {
		if (hold === 'momentary') {
			this.recordHold(key, field, active)
		}
		this.send({
			type: 'set_key_state',
			key: this.keyRef(key),
			field,
			hold,
			active,
		})
	}

	private keyRef(key: KeyConfig): { target_type: string; target_id: string } {
		return { target_type: key.target_type, target_id: key.target_id }
	}

	/**
	 * Track what we are holding so the heartbeat can restate it. The server
	 * drops presses it stops hearing about, which is what stops a panel that
	 * crashes mid-press from leaving a mic open.
	 */
	private recordHold(key: KeyConfig, field: KeyField, active: boolean): void {
		const token = this.keyTargetToken(key)
		const current = this.heldKeys.get(token)
		const talk = field === 'talk' ? active : (current?.talk ?? false)
		const listen = field === 'listen' ? active : (current?.listen ?? false)

		if (talk || listen) {
			this.heldKeys.set(token, { key: this.keyRef(key), talk, listen })
		} else {
			this.heldKeys.delete(token)
		}
		this.syncHeartbeat()
	}

	/** Run the heartbeat exactly while something is held, and no longer. */
	private syncHeartbeat(): void {
		if (this.heldKeys.size === 0) {
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer)
				this.heartbeatTimer = undefined
			}
			return
		}
		this.heartbeatTimer ??= setInterval(() => {
			if (this.heldKeys.size === 0) return
			this.send({ type: 'momentary_heartbeat', held: [...this.heldKeys.values()] })
		}, this.heartbeatIntervalMs)
	}

	/**
	 * Forget every press. The server does the same for a client that goes away,
	 * so a reconnecting module must not claim to still be holding anything.
	 */
	private clearHolds(): void {
		this.heldKeys.clear()
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = undefined
		}
	}

	private getTalkActive(key: KeyConfig): boolean {
		return this.stateTalkMapForKey(key)[key.target_id] ?? false
	}

	private getListenActive(key: KeyConfig): boolean {
		return this.stateListenMapForKey(key)[key.target_id] ?? false
	}

	private getListenLevel(key: KeyConfig): number {
		return this.stateListenLevelMapForKey(key)[key.target_id] ?? 1
	}

	private getListenLevelDb(key: KeyConfig): number {
		return linearToDb(this.getListenLevel(key))
	}

	private setListenLevelLocal(key: KeyConfig, level: number): void {
		this.stateListenLevelMapForKey(key)[key.target_id] = level
	}

	private clampListenLevelLinear(_key: KeyConfig, level: number): number {
		return clamp(level, 0, dbToLinear(MAX_LISTEN_LEVEL_DB))
	}

	private formatListenLevelDb(levelDb: number): string {
		if (levelDb <= MIN_LISTEN_LEVEL_DB) return `${MIN_LISTEN_LEVEL_DB}`
		return levelDb.toFixed(1)
	}

	private stateTalkMapForKey(key: KeyConfig): Record<string, boolean> {
		return key.target_type === 'party_line' ? this.state.party_line_talk_active : this.state.talk_active
	}

	private stateListenMapForKey(key: KeyConfig): Record<string, boolean> {
		return key.target_type === 'party_line' ? this.state.party_line_listen_active : this.state.listen_active
	}

	private stateListenLevelMapForKey(key: KeyConfig): Record<string, number> {
		return key.target_type === 'party_line' ? this.state.party_line_listen_level : this.state.listen_level
	}

	private isKeyUserConnected(key: KeyConfig): boolean {
		if (key.target_type !== 'user') return false
		return this.connectedUsers.has(key.target_id)
	}

	private send(message: Message): boolean {
		if (!this.isSocketOpen()) return false
		try {
			this.ws?.send(JSON.stringify(message))
			return true
		} catch (error) {
			this.log('error', `Failed to send websocket message: ${String(error)}`)
			return false
		}
	}

	private isSocketOpen(): boolean {
		return this.ws?.readyState === WebSocket.OPEN
	}

	private resetSession(): void {
		this.userId = ''
		this.displayName = ''
		this.keys = []
		this.availableUsers = []
		this.connectedUsers.clear()
		this.state = createEmptyState()
		this.latchedState = undefined
		this.lastTapAt.clear()
		this.talkLatchBeforeTap.clear()
		for (const timer of this.settleTimers.values()) clearTimeout(timer)
		this.settleTimers.clear()
		for (const timer of this.pressTimers.values()) clearTimeout(timer)
		this.pressTimers.clear()
		for (const timer of this.selectHoldTimers.values()) clearTimeout(timer)
		this.selectHoldTimers.clear()
		this.selectionBeforeHold.clear()
		this.secondTapInProgress.clear()
		this.pressApplied.clear()
		this.talkControlState = this.createControlState()
		this.listenControlState = this.createControlState()
		this.globalLatched = false
		this.globalPressing = false
		this.globalPressStart = undefined
	}
}

export default LiveMatrixInstance
export type { LiveMatrixConfig }
export { UpgradeScripts } from './upgrades.js'
