import {
	InstanceBase,
	InstanceStatus,
	type CompanionActionDefinitions,
	type CompanionFeedbackDefinitions,
	type CompanionOptionValues,
	type CompanionVariableDefinitions,
	type CompanionVariableValues,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import {
	buildWebSocketUrl,
	getConfigFields,
	validateConfig,
	type LivematrixConfig,
	type LivematrixManifest,
	type LivematrixSecrets,
} from './config.js'
import { ActivityStore } from './activity.js'
import { ACCENT_HIGH, INCOMING, LISTEN_ON, MIC_MUTED_FILL, NAME_OFFLINE, TALK_ON, TEXT, WARN } from './brand.js'
import { LivematrixConnection } from './connection.js'
import { KeyStateStore } from './key-state.js'
import {
	MAX_LISTEN_LEVEL_DB,
	MIN_LISTEN_LEVEL_DB,
	clampListenLevelLinear,
	dbToLinear,
	formatListenLevelDb,
	sanitizeName,
} from './levels.js'
import {
	getAlsoSelectOption,
	getHoldSelectsOption,
	getKeySelectorOptions,
	getPressBehaviourOption,
	getSetModeOption,
	readPressBehaviour,
	readSetMode,
	resolveKey,
	type PressBehaviour,
	type SetMode,
} from './options.js'
import { getPresetDefinitions } from './presets.js'
import {
	COMPANION_DEVICE_MODEL,
	createEmptyMicState,
	keyRef,
	keyTargetToken,
	readMicState,
	type ActivityUpdateMessage,
	type DeviceInfo,
	type DevicesUpdateMessage,
	type ErrorMessage,
	type Hold,
	type KeyConfig,
	type KeyField,
	type KeysChangedMessage,
	type LoginFailureMessage,
	type LoginSuccessMessage,
	type Message,
	type MicState,
	type MicStateMessage,
	type MomentaryHold,
	type SessionEndedMessage,
	type StateUpdateMessage,
	type UserConnectedMessage,
	type UserDisconnectedMessage,
	type UserInfo,
} from './protocol.js'

type LatchMode = 'off' | 'momentary' | 'latched'

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
/**
 * How long a key must be held before it takes the selection. Nothing: the
 * volume keys follow the press at once, and since the selection ends with the
 * press, a tap only flashes its name on them. Raise it to keep taps from
 * touching the selection at all, at the cost of the volume keys lagging a hold.
 */
const HOLD_SELECT_MS = 0
/**
 * A held volume key steps once on the press, waits this long so a tap stays a
 * single step, then keeps stepping every LEVEL_REPEAT_INTERVAL_MS until it is
 * let go.
 */
const LEVEL_REPEAT_DELAY_MS = 400
const LEVEL_REPEAT_INTERVAL_MS = 100

/**
 * What a key's name reads as when the button is not pointing at a key: the
 * index is out of range, or the target is one this login does not have. The
 * button still draws, so it has to say that it is aimed at nothing.
 */
const NO_KEY_NAME = 'N/A'

/** The move-mic choice that hands the mic on to whichever device comes after its holder. */
const MIC_MOVE_NEXT = 'next'

/** A device as a person would pick it out: its name, and what it runs on. */
function deviceLabel(device: DeviceInfo): string {
	const name = device.device_name || device.device_id
	return device.device_model && device.device_model !== device.device_name ? `${name} (${device.device_model})` : name
}

/** Fallback until `login_success` tells us what the server actually wants. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
/**
 * How often an idle server connection says something. The server drops a
 * socket it has not heard from in 150 seconds, so this leaves room for two
 * lost pings before that happens.
 */
const SERVER_KEEPALIVE_INTERVAL_MS = 45_000
const RECONNECT_DELAY_MS = 5000

function createControlState(): KeyControlState {
	return {
		latched: new Map(),
		pressing: new Map(),
		pressStart: new Map(),
	}
}

export class LivematrixInstance extends InstanceBase<LivematrixManifest> {
	config!: LivematrixConfig
	secrets!: LivematrixSecrets
	private connection: LivematrixConnection | undefined

	private userId = ''
	private displayName = ''
	private keys: KeyConfig[] = []
	private availableUsers: UserInfo[] = []
	private connectedUsers = new Set<string>()
	private keyState = new KeyStateStore()
	private activity = new ActivityStore()
	/** Puts out the listen stripe's trail when it runs out. */
	private activityTrailTimer: NodeJS.Timeout | undefined
	private mic: MicState = createEmptyMicState()
	/** This user's devices, as the server last listed them. Includes this panel. */
	private devices: DeviceInfo[] = []
	/** The last mic error the server reported, cleared by the next mic state. */
	private micError = ''
	/** Why the last login was refused, while we keep retrying it. */
	private retryReason: string | undefined

	private talkControlState: KeyControlState = createControlState()
	private listenControlState: KeyControlState = createControlState()
	/**
	 * A key chosen with 'Select key' or 'Also select this key'. It stays selected
	 * until another one is chosen, but a held key overrides it.
	 */
	private pinnedKeyToken: string | undefined
	/** When the last tap on a key ended, for spotting a double tap. */
	private lastTapAt = new Map<string, number>()
	/** Releases we are sitting on for DOUBLE_TAP_SETTLE_MS, keyed by target. */
	private settleTimers = new Map<string, NodeJS.Timeout>()
	/** Keys whose second tap has begun, so this press must not drive talk. */
	private secondTapInProgress = new Set<string>()
	/** Presses waiting out HOLD_SELECT_MS before they take the selection, by button. */
	private selectHoldTimers = new Map<string, NodeJS.Timeout>()
	/**
	 * Keys held down long enough to be selected, by the button holding them, in
	 * the order they were taken. The last one still held is the selection.
	 */
	private selectHolds = new Map<string, string>()
	/** Held volume keys stepping a level, keyed by the Companion button holding them. */
	private levelRepeats = new Map<string, NodeJS.Timeout>()
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
	/** Connection timing, overridable so tests need not wait out real delays. */
	protected keepaliveIntervalMs = SERVER_KEEPALIVE_INTERVAL_MS
	protected reconnectDelayMs = RECONNECT_DELAY_MS

	async init(config: LivematrixConfig, _isFirstInit: boolean, secrets: LivematrixSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets
		this.setupDefinitions()
		this.connect()
	}

	async destroy(): Promise<void> {
		this.clearHolds()
		this.stopAllLevelRepeats()
		clearTimeout(this.activityTrailTimer)
		await this.disconnect()
	}

	async configUpdated(config: LivematrixConfig, secrets: LivematrixSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets
		this.clearHolds()
		await this.disconnect()
		this.resetSession()
		this.setupDefinitions()
		this.connect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields()
	}

	private connect(): void {
		const validationError = validateConfig(this.config, this.secrets)
		if (validationError) {
			this.updateStatus(InstanceStatus.BadConfig, validationError)
			return
		}

		const serverMode = this.config.connection_mode === 'server'
		this.updateStatus(InstanceStatus.Connecting)
		this.connection = new LivematrixConnection(
			buildWebSocketUrl(this.config),
			{
				open: () => {
					this.updateStatus(InstanceStatus.Connecting)
					// The client app's control API is already logged in and sends its
					// snapshot unasked; only the server wants to know who we are.
					if (serverMode) this.sendLogin()
				},
				message: (message) => this.handleMessage(message),
				close: (reconnecting) => {
					this.clearHolds()
					this.clearActivity()
					this.pushVariableValues()
					if (!reconnecting) return
					if (this.retryReason) this.updateStatus(InstanceStatus.ConnectionFailure, this.retryReason)
					else this.updateStatus(InstanceStatus.Disconnected)
				},
				error: (message) => {
					this.log('error', `WebSocket error: ${message}`)
					this.updateStatus(InstanceStatus.ConnectionFailure, message)
				},
				warn: (message) => this.log('warn', message),
			},
			// The client app's control API neither times out an idle panel nor
			// answers a ping, so only the server connection is kept alive.
			{
				keepaliveIntervalMs: serverMode ? this.keepaliveIntervalMs : 0,
				reconnectDelayMs: this.reconnectDelayMs,
				allowUnverifiedCertificate: serverMode && this.config.server_tls && this.config.server_tls_self_signed,
			},
		)
		this.connection.start()
	}

	private async disconnect(): Promise<void> {
		const connection = this.connection
		this.connection = undefined
		await connection?.stop()
	}

	private sendLogin(): void {
		this.send({
			type: 'login',
			username: this.config.username,
			password: this.secrets.password,
			// The same device on every reconnect, so the server re-admits this
			// panel rather than counting a new device against the licence each time.
			// One per Companion connection, so two of them never take each other's place.
			device_id: `companion-${this.id}`,
		})
	}

	private handleMessage(message: Message): void {
		switch (message.type) {
			case 'login_success':
				this.handleLoginSuccess(message as unknown as LoginSuccessMessage)
				break
			case 'login_failure':
				this.handleLoginFailure(message as unknown as LoginFailureMessage)
				break
			case 'session_ended':
				this.handleSessionEnded(message as unknown as SessionEndedMessage)
				break
			case 'state_update':
				this.handleStateUpdate(message as unknown as StateUpdateMessage)
				break
			case 'keys_changed':
				this.applyKeys((message as unknown as KeysChangedMessage).keys ?? [])
				break
			case 'user_connected':
				this.handleUserPresence((message as unknown as UserConnectedMessage).user_id, true)
				break
			case 'user_disconnected':
				this.handleUserPresence((message as unknown as UserDisconnectedMessage).user_id, false)
				break
			case 'mic_state':
				this.handleMicState(message as unknown as MicStateMessage)
				break
			case 'devices_update':
				this.handleDevicesUpdate(message as unknown as DevicesUpdateMessage)
				break
			case 'activity_update':
				this.handleActivityUpdate(message as unknown as ActivityUpdateMessage)
				break
			case 'error':
				this.handleServerError(message as unknown as ErrorMessage)
				break
			default:
				// Including `pong`: any message at all is proof enough the link is up.
				break
		}
	}

	private handleLoginSuccess(message: LoginSuccessMessage): void {
		this.userId = message.user_id
		this.displayName = message.display_name
		this.availableUsers = message.available_users ?? []
		this.connectedUsers = new Set(this.availableUsers.filter((user) => user.is_connected).map((user) => user.id))
		this.activity.setGroups(message.groups ?? [])
		this.applyKeys(message.keys ?? [])
		// The server advertises its own lease so client and server cannot drift
		// apart on how often a held key has to be restated.
		this.heartbeatIntervalMs = message.momentary_heartbeat_interval_ms ?? DEFAULT_HEARTBEAT_INTERVAL_MS
		this.retryReason = undefined
		this.updateStatus(InstanceStatus.Ok)

		// On the client's control API this would rename the app's own device.
		if (this.config.connection_mode === 'server') {
			this.send({
				type: 'set_device_name',
				name: 'Companion',
				model: 'companion',
			})
		}
	}

	/**
	 * Only a fatal failure is a wrong password. Anything else, such as a full
	 * licence, clears up by itself, so the module keeps trying.
	 */
	private handleLoginFailure(message: LoginFailureMessage): void {
		const reason = message.code ? `${message.reason} (${message.code})` : message.reason
		if (message.fatal) {
			this.connection?.stopReconnecting()
			this.updateStatus(InstanceStatus.AuthenticationFailure, reason)
			return
		}
		this.log('warn', `Login refused, retrying: ${reason}`)
		this.retryReason = reason
		this.updateStatus(InstanceStatus.ConnectionFailure, reason)
		this.connection?.recycle()
	}

	/** Ended on purpose by the server; it stays ended until the config is saved again. */
	private handleSessionEnded(message: SessionEndedMessage): void {
		this.connection?.stopReconnecting()
		this.updateStatus(InstanceStatus.Disconnected, message.message || message.reason)
	}

	private handleStateUpdate(message: StateUpdateMessage): void {
		this.keyState.apply(message)
		this.syncLatchStateFromServer()
		this.pushVariableValues()
		this.checkAllFeedbacks()
	}

	private handleUserPresence(userId: string, connected: boolean): void {
		if (connected) this.connectedUsers.add(userId)
		else this.connectedUsers.delete(userId)
		this.availableUsers = this.availableUsers.map((user) =>
			user.id === userId ? { ...user, is_connected: connected } : user,
		)
		this.pushVariableValues()
		this.checkFeedbacks('user_connected', 'user_disconnected')
	}

	private handleMicState(message: MicStateMessage): void {
		this.mic = readMicState(message)
		// The server answers every mute request with the mic state, right behind
		// any error, so a state that still has no holder must not wipe the error
		// it explains. One with a holder means the mic is back.
		if (this.mic.device_id !== null) this.micError = ''
		this.pushVariableValues()
		this.checkFeedbacks('mic_muted', 'mic_live', 'mic_device_name')
	}

	private handleDevicesUpdate(message: DevicesUpdateMessage): void {
		this.devices = message.devices ?? []
		// The move action lists the devices by name, so its choices follow.
		this.setActionDefinitions(this.getActionDefinitions())
	}

	private handleActivityUpdate(message: ActivityUpdateMessage): void {
		this.activity.apply(message, Date.now())
		this.scheduleActivityTrail()
		this.checkActivityFeedbacks()
	}

	/** Wake when the next listen stripe's trail runs out, to put it out. */
	private scheduleActivityTrail(): void {
		clearTimeout(this.activityTrailTimer)
		this.activityTrailTimer = undefined
		const now = Date.now()
		const next = this.activity.nextTrailExpiry(now)
		if (next === undefined) return
		this.activityTrailTimer = setTimeout(() => {
			this.activityTrailTimer = undefined
			this.checkActivityFeedbacks()
			this.scheduleActivityTrail()
		}, next - now)
	}

	/** A lost connection puts every stripe out at once, trail and all, as the app does. */
	private clearActivity(): void {
		clearTimeout(this.activityTrailTimer)
		this.activityTrailTimer = undefined
		this.activity.clear()
		this.checkActivityFeedbacks()
	}

	private checkActivityFeedbacks(): void {
		this.checkFeedbacks('listening_to_me', 'audio_arriving', 'audio_recent')
	}

	private handleServerError(message: ErrorMessage): void {
		this.log('warn', message.message)
		if (message.code === 'no_mic_available') {
			this.micError = message.message
			this.pushVariableValues()
		}
	}

	private applyKeys(keys: KeyConfig[]): void {
		const previousKeys = new Set(this.keys.map(keyTargetToken))
		this.keys = keys

		for (const key of keys) {
			if (previousKeys.has(keyTargetToken(key))) continue
			if (key.default_talk_active) {
				this.keyState.setActive(key, 'talk', true)
				this.talkControlState.latched.set(key.target_id, true)
			}
			if (key.default_listen_active) {
				this.keyState.setActive(key, 'listen', true)
				this.listenControlState.latched.set(key.target_id, true)
			}
		}

		this.syncLatchStateFromServer()
		this.setupDefinitions()
	}

	private syncLatchStateFromServer(): void {
		for (const key of this.keys) {
			const targetId = key.target_id
			if (!this.talkControlState.pressing.get(targetId)) {
				this.talkControlState.latched.set(targetId, this.keyState.isLatched(key, 'talk'))
			}
			if (!this.listenControlState.pressing.get(targetId)) {
				this.listenControlState.latched.set(targetId, this.keyState.isLatched(key, 'listen'))
			}
		}
	}

	private setupDefinitions(): void {
		this.setActionDefinitions(this.getActionDefinitions())
		this.setFeedbackDefinitions(this.getFeedbackDefinitions())
		const { structure, presets } = getPresetDefinitions(this.keys)
		this.setPresetDefinitions(structure, presets)
		this.setVariableDefinitions(this.getVariableDefinitions())
		this.pushVariableValues()
	}

	private getActionDefinitions(): CompanionActionDefinitions {
		return {
			select_key: {
				name: 'Select key',
				description: 'Make this the key that "selected key" actions and feedbacks act on',
				options: getKeySelectorOptions(this.keys),
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (key) this.selectKey(key)
				},
			},
			talk_down: {
				name: 'Talk key down',
				options: [
					...getKeySelectorOptions(this.keys),
					getPressBehaviourOption(),
					getHoldSelectsOption(false),
					getAlsoSelectOption(),
				],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (!key) return
					this.applySelectOptions(action.controlId, key, action.options)
					this.onTalkDown(key, readPressBehaviour(action.options))
				},
			},
			talk_up: {
				name: 'Talk key up',
				options: [
					...getKeySelectorOptions(this.keys),
					getPressBehaviourOption(),
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
					this.endSelectHold(action.controlId)
					const key = this.resolveKey(action.options)
					if (!key) return
					this.onTalkUp(key, readPressBehaviour(action.options), action.options.double_tap_listen !== false)
				},
			},
			talk_set: {
				name: 'Talk set',
				options: [...getKeySelectorOptions(this.keys), getSetModeOption('mode')],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					const mode = readSetMode(action.options)
					if (key) this.onSetKeyMode(key, 'talk', mode)
				},
			},
			listen_down: {
				name: 'Listen key down',
				options: [
					...getKeySelectorOptions(this.keys),
					getPressBehaviourOption(),
					getHoldSelectsOption(true),
					getAlsoSelectOption(),
				],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (!key) return
					this.applySelectOptions(action.controlId, key, action.options)
					this.onListenDown(key, readPressBehaviour(action.options))
				},
			},
			listen_up: {
				name: 'Listen key up',
				options: [...getKeySelectorOptions(this.keys), getPressBehaviourOption()],
				callback: async (action) => {
					this.endSelectHold(action.controlId)
					const key = this.resolveKey(action.options)
					if (key) this.onListenUp(key, readPressBehaviour(action.options))
				},
			},
			listen_set: {
				name: 'Listen set',
				options: [...getKeySelectorOptions(this.keys), getSetModeOption('mode')],
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					const mode = readSetMode(action.options)
					if (key) this.onSetKeyMode(key, 'listen', mode)
				},
			},
			listen_level: {
				name: 'Set listen level',
				options: [
					...getKeySelectorOptions(this.keys),
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
					...getKeySelectorOptions(this.keys),
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
			listen_level_hold: {
				name: 'Change listen level while held',
				description:
					'Step the level once, then keep stepping for as long as the button is held. Put "Stop changing listen level" on the release.',
				options: [
					...getKeySelectorOptions(this.keys),
					{
						type: 'number' as const,
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
					const key = this.resolveKey(action.options)
					const deltaDb = Number(action.options.delta_db ?? 1)
					if (key) this.startLevelRepeat(action.controlId, key, deltaDb)
				},
			},
			listen_level_hold_stop: {
				name: 'Stop changing listen level',
				description: 'Ends a "Change listen level while held" started from this button',
				options: [],
				callback: async (action) => {
					this.stopLevelRepeat(action.controlId)
				},
			},
			mic_mute: {
				name: 'Mute microphone',
				description: 'Mute the mic on whichever device holds it',
				options: [],
				callback: async () => {
					this.onSetMicMuted(true)
				},
			},
			mic_unmute: {
				name: 'Unmute microphone',
				description:
					'Unmute the mic. If the device holding it is gone, the server hands it to the device that held it most recently.',
				options: [],
				callback: async () => {
					this.onSetMicMuted(false)
				},
			},
			mic_toggle: {
				name: 'Toggle microphone mute',
				description: 'Mute a live mic, or unmute a muted one',
				options: [],
				callback: async () => {
					this.onMicToggle()
				},
			},
			mic_move: {
				name: 'Move microphone to device',
				description:
					"Hand this user's mic to another of their devices, unmuted. This needs a direct server connection, because a client app's control API cannot move the mic.",
				options: [
					{
						type: 'dropdown' as const,
						id: 'device',
						label: 'Device',
						default: MIC_MOVE_NEXT,
						choices: [
							{ id: MIC_MOVE_NEXT, label: 'Next device' },
							...this.micDevices().map((device) => ({
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
					this.onMicMove(typeof device === 'string' ? device : MIC_MOVE_NEXT)
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
					bgcolor: TALK_ON,
					color: TEXT,
				},
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.keyState.talk(key) : false
				},
			},
			listen_active: {
				type: 'boolean',
				name: 'Listen active',
				defaultStyle: {
					bgcolor: LISTEN_ON,
					color: TEXT,
				},
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.keyState.listen(key) : false
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
				options: getKeySelectorOptions(this.keys),
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
					bgcolor: TALK_ON,
					color: TEXT,
				},
				options: getKeySelectorOptions(this.keys),
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
					bgcolor: LISTEN_ON,
					color: TEXT,
				},
				options: getKeySelectorOptions(this.keys),
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
					bgcolor: LISTEN_ON,
					color: TEXT,
				},
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.getLatchMode(key, 'listen') === 'momentary' : false
				},
			},
			key_selected: {
				type: 'boolean',
				name: 'Key is selected',
				defaultStyle: {
					color: ACCENT_HIGH,
				},
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					if (!key) return false
					return keyTargetToken(key) === this.selectedKeyToken()
				},
			},
			key_listen_level_db: {
				type: 'value',
				name: 'Listen level (dB)',
				description: 'The listen level as a number, for driving a gauge or text',
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					if (!key) return MIN_LISTEN_LEVEL_DB
					return Number(this.keyState.levelDb(key).toFixed(1))
				},
			},
			key_found: {
				type: 'value',
				name: 'Key found',
				description:
					'Whether the key selector points at a key this login has. For "Selected key", whether any key is selected right now.',
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => this.resolveKey(feedback.options) !== undefined,
			},
			key_name: {
				type: 'value',
				name: 'Key display name',
				description: 'The name of the key, for use as button text',
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? key.display_name : NO_KEY_NAME
				},
			},
			user_connected: {
				type: 'boolean',
				name: 'User connected',
				defaultStyle: {
					color: TEXT,
				},
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.isKeyUserConnected(key) : false
				},
			},
			user_disconnected: {
				type: 'boolean',
				name: 'User disconnected',
				defaultStyle: {
					color: NAME_OFFLINE,
				},
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? !this.isKeyUserConnected(key) : false
				},
			},
			listening_to_me: {
				type: 'boolean',
				name: 'Listening to you',
				description: 'Someone this key reaches is listening to you. A group key counts its members.',
				defaultStyle: {
					color: INCOMING,
				},
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.activity.isListeningToMe(key) : false
				},
			},
			audio_arriving: {
				type: 'boolean',
				name: 'Audio arriving',
				description: 'Audio from what this key points at is reaching you right now, whether or not you listen',
				defaultStyle: {
					color: INCOMING,
				},
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.activity.isAudioArriving(key) : false
				},
			},
			audio_recent: {
				type: 'boolean',
				name: 'Audio arrived recently',
				description: 'Audio from what this key points at stopped within the last minute',
				defaultStyle: {
					color: INCOMING,
				},
				options: getKeySelectorOptions(this.keys),
				callback: async (feedback) => {
					const key = this.resolveKey(feedback.options)
					return key ? this.activity.isAudioTrailing(key, Date.now()) : false
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
				callback: async () => !this.isMicUnmuted(),
			},
			mic_device_name: {
				type: 'value',
				name: 'Device holding the microphone',
				description: 'Its name, or nothing while no device holds the mic',
				options: [],
				callback: async () => this.mic.device_name ?? this.mic.device_id ?? '',
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
				callback: async () => this.isMicOpen(),
			},
		}
	}

	private getVariableDefinitions(): CompanionVariableDefinitions {
		const variables: CompanionVariableDefinitions = {
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
			connected: this.isConnected(),
			mic_muted: !this.isMicUnmuted(),
			mic_open: this.isMicOpen(),
			mic_device: this.mic.device_name ?? this.mic.device_id ?? '',
			mic_holder_online: this.mic.holder_online,
			mic_error: this.micError,
			key_count: this.keys.length,
		}

		const selectedKey = this.getSelectedKey()
		values.selected_key_index = selectedKey ? this.keys.indexOf(selectedKey) : -1
		values.selected_key_name = selectedKey?.display_name ?? ''
		values.selected_key_target_id = selectedKey?.target_id ?? ''
		values.selected_key_talk = selectedKey ? this.keyState.talk(selectedKey) : false
		values.selected_key_listen = selectedKey ? this.keyState.listen(selectedKey) : false
		values.selected_key_level = selectedKey ? formatListenLevelDb(this.keyState.levelDb(selectedKey)) : ''

		const seenTargetNames = new Set<string>()
		for (const [index, key] of this.keys.entries()) {
			const talk = this.keyState.talk(key)
			const listen = this.keyState.listen(key)
			const level = formatListenLevelDb(this.keyState.levelDb(key))
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

	private resolveKey(options: CompanionOptionValues): KeyConfig | undefined {
		return resolveKey(this.keys, options, () => this.getSelectedKey())
	}

	/**
	 * The key that volume actions and 'selected key' feedbacks operate on: the
	 * key held down most recently, else the pinned one, else none. A key that
	 * is no longer in the login's list is skipped.
	 */
	private getSelectedKey(): KeyConfig | undefined {
		const find = (token: string | undefined) =>
			token === undefined ? undefined : this.keys.find((key) => keyTargetToken(key) === token)
		for (const token of [...this.selectHolds.values()].reverse()) {
			const key = find(token)
			if (key) return key
		}
		return find(this.pinnedKeyToken)
	}

	private selectedKeyToken(): string | undefined {
		const key = this.getSelectedKey()
		return key ? keyTargetToken(key) : undefined
	}

	/** Run a change to the selection, and redraw only if it moved. */
	private changeSelection(change: () => void): void {
		const before = this.selectedKeyToken()
		change()
		if (this.selectedKeyToken() !== before) this.onSelectionChanged()
	}

	private selectKey(key: KeyConfig): void {
		this.changeSelection(() => {
			this.pinnedKeyToken = keyTargetToken(key)
		})
	}

	/** What a key press does to the selection, as its options ask. */
	private applySelectOptions(controlId: string, key: KeyConfig, options: CompanionOptionValues): void {
		if (options.also_select === true) this.selectKey(key)
		if (options.hold_selects === true) this.startSelectHold(controlId, key)
	}

	/**
	 * Select the key once it has been held past a tap, for as long as it stays
	 * held. Keyed by the button, so two buttons on one key, or two keys held at
	 * once, each let go of only their own hold.
	 */
	private startSelectHold(controlId: string, key: KeyConfig): void {
		this.endSelectHold(controlId)
		const take = () => this.changeSelection(() => this.selectHolds.set(controlId, keyTargetToken(key)))
		if (HOLD_SELECT_MS <= 0) {
			take()
			return
		}
		this.selectHoldTimers.set(
			controlId,
			setTimeout(() => {
				this.selectHoldTimers.delete(controlId)
				take()
			}, HOLD_SELECT_MS),
		)
	}

	/** Let go of whatever selection this button was holding, if any. */
	private endSelectHold(controlId: string): void {
		const timer = this.selectHoldTimers.get(controlId)
		if (timer) {
			clearTimeout(timer)
			this.selectHoldTimers.delete(controlId)
		}
		this.changeSelection(() => this.selectHolds.delete(controlId))
	}

	/**
	 * Any feedback can be pointed at the selected key, not just `key_selected`:
	 * the volume keys read the name and level through it. All of them follow.
	 */
	private onSelectionChanged(): void {
		this.checkAllFeedbacks()
		this.pushVariableValues()
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
		this.pressApplied.delete(key.target_id)
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

		this.settleRelease(key, 'talk', latchedBefore, this.talkControlState.latched.get(key.target_id) ?? false)

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

	private onListenDown(key: KeyConfig, behaviour: PressBehaviour = 'auto'): void {
		if (!key.can_listen) return

		if (this.latchesOnPress(key, 'listen', behaviour)) {
			this.onSetKeyMode(key, 'listen', 'toggle')
			return
		}

		this.listenControlState.pressStart.set(key.target_id, Date.now())
		this.listenControlState.pressing.set(key.target_id, true)
		this.setListenActive(key, this.getEffectiveState(this.listenControlState, key.target_id))
	}

	private onListenUp(key: KeyConfig, behaviour: PressBehaviour = 'auto'): void {
		if (!key.can_listen) return

		if (this.latchesOnPress(key, 'listen', behaviour)) return

		const wasShortPress = this.wasShortPress(this.listenControlState, key.target_id)
		const latchedBefore = this.listenControlState.latched.get(key.target_id) ?? false

		this.listenControlState.pressing.set(key.target_id, false)
		const latchedAfter =
			this.latchesOnRelease(key, 'listen', behaviour) && wasShortPress ? !latchedBefore : latchedBefore
		this.listenControlState.latched.set(key.target_id, latchedAfter)

		this.settleRelease(key, 'listen', latchedBefore, latchedAfter)
	}

	/**
	 * Tell the server what a release left behind, each layer only about its own
	 * change. The latched layer moves if the press flipped it; the press, if one
	 * went out, is let go of as a press. Neither stands in for the other: a
	 * momentary release leaves a latch on, and a latched `false` leaves a press
	 * held for the heartbeat to go on renewing.
	 */
	private settleRelease(key: KeyConfig, field: KeyField, latchedBefore: boolean, latchedAfter: boolean): void {
		const held = this.heldKeys.get(keyTargetToken(key))?.[field] ?? false

		// Latch before letting go, so a press that turns into a latch never
		// drops out for a moment in between.
		if (latchedAfter !== latchedBefore) this.sendKeyState(key, field, 'latched', latchedAfter)
		if (held) this.sendKeyState(key, field, 'momentary', false)

		this.keyState.setActive(key, field, latchedAfter)
		this.pushVariableValues()
		this.checkFeedbacks(`${field}_active`, `${field}_latched`, `${field}_momentary`)
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
		const active = kind === 'talk' ? this.keyState.talk(key) : this.keyState.listen(key)
		if (!active) return 'off'
		return this.keyState.isLatched(key, kind) ? 'latched' : 'momentary'
	}

	private onSetKeyMode(key: KeyConfig, kind: 'talk' | 'listen', mode: SetMode): void {
		if (kind === 'talk' && !key.can_talk) return
		if (kind === 'listen' && !key.can_listen) return

		const controlState = kind === 'talk' ? this.talkControlState : this.listenControlState
		controlState.pressing.set(key.target_id, false)

		// A set action can land while the key is still held down. The press has
		// to be let go of on its own layer, or the heartbeat keeps renewing it
		// underneath whatever the latch is told to do.
		if (kind === 'talk' && this.pressApplied.delete(key.target_id)) {
			this.sendKeyState(key, 'talk', 'momentary', false)
		}

		switch (mode) {
			case 'toggle': {
				const current = kind === 'talk' ? this.keyState.talk(key) : this.keyState.listen(key)
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
		const linearLevel = clampListenLevelLinear(dbToLinear(levelDb))
		this.keyState.setLevel(key, linearLevel)
		this.send({ type: 'set_key_level', key: keyRef(key), level: linearLevel })
		this.pushVariableValues()
		this.checkFeedbacks('key_listen_level_db')
	}

	private onListenLevelAdjustDb(key: KeyConfig, deltaDb: number): void {
		if (!key.can_listen) return
		const nextLevelDb = this.keyState.levelDb(key) + deltaDb
		this.onListenLevelSetDb(key, nextLevelDb)
	}

	/**
	 * Step now, then repeat until the button lets go. Steps count from the level
	 * we last asked for rather than the last one the server echoed, so an echo
	 * still in flight cannot hold the ramp back. Stops by itself at either end.
	 */
	private startLevelRepeat(controlId: string, key: KeyConfig, deltaDb: number): void {
		this.stopLevelRepeat(controlId)
		let levelDb = this.keyState.levelDb(key)

		const step = (): boolean => {
			if (!key.can_listen) return false
			const before = this.keyState.level(key)
			this.onListenLevelSetDb(key, levelDb + deltaDb)
			levelDb = this.keyState.levelDb(key)
			return this.keyState.level(key) !== before
		}

		if (!step()) return
		const repeat = () => {
			if (!step()) {
				this.levelRepeats.delete(controlId)
				return
			}
			this.levelRepeats.set(controlId, setTimeout(repeat, LEVEL_REPEAT_INTERVAL_MS))
		}
		this.levelRepeats.set(controlId, setTimeout(repeat, LEVEL_REPEAT_DELAY_MS))
	}

	private stopLevelRepeat(controlId: string): void {
		const timer = this.levelRepeats.get(controlId)
		if (!timer) return
		clearTimeout(timer)
		this.levelRepeats.delete(controlId)
	}

	private stopAllLevelRepeats(): void {
		for (const timer of this.levelRepeats.values()) clearTimeout(timer)
		this.levelRepeats.clear()
	}

	private onSetMicMuted(muted: boolean): void {
		// A fresh attempt: the server says again if it still cannot.
		if (this.micError) {
			this.micError = ''
			this.pushVariableValues()
		}
		this.send({ type: 'set_mic_muted', muted })
	}

	/**
	 * Resolved here from the last mic state rather than sent as a toggle: the
	 * server may replay a message, and a replayed toggle would undo itself.
	 */
	private onMicToggle(): void {
		this.onSetMicMuted(this.isMicUnmuted())
	}

	/**
	 * The devices the mic can go to: this user's, less any Companion panel,
	 * which has no microphone. In a stable order, so "next" walks them in turn.
	 */
	private micDevices(): DeviceInfo[] {
		return this.devices
			.filter((device) => device.device_model !== COMPANION_DEVICE_MODEL)
			.sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b)) || a.device_id.localeCompare(b.device_id))
	}

	private onMicMove(target: string): void {
		if (this.config.connection_mode !== 'server') {
			this.log('warn', 'Moving the mic needs a direct server connection, because the client control API cannot move it')
			return
		}

		let deviceId = target
		if (target === MIC_MOVE_NEXT) {
			const devices = this.micDevices()
			if (devices.length === 0) return
			const current = devices.findIndex((device) => device.device_id === this.mic.device_id)
			deviceId = devices[(current + 1) % devices.length].device_id
		}
		this.send({ type: 'claim_mic', device_id: deviceId })
	}

	/**
	 * Whether some device holds the mic and it is not muted. What mute and toggle
	 * act on: a held talk key opens a muted mic without unmuting it.
	 */
	private isMicUnmuted(): boolean {
		return this.mic.device_id !== null && !this.mic.muted
	}

	/** Whether some device holds the mic and is sending audio through it. */
	private isMicOpen(): boolean {
		return this.mic.device_id !== null && this.mic.open
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
		const current = this.keyState.talk(key)
		if (current === active && !options.forceSend) return

		this.keyState.setActive(key, 'talk', active)
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
		const current = this.keyState.listen(key)
		if (current === active && !options.forceSend) return

		this.keyState.setActive(key, 'listen', active)
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
			key: keyRef(key),
			field,
			hold,
			active,
		})
	}

	/**
	 * Track what we are holding so the heartbeat can restate it. The server
	 * drops presses it stops hearing about, which is what stops a panel that
	 * crashes mid-press from leaving a mic open.
	 */
	private recordHold(key: KeyConfig, field: KeyField, active: boolean): void {
		const token = keyTargetToken(key)
		const current = this.heldKeys.get(token)
		const talk = field === 'talk' ? active : (current?.talk ?? false)
		const listen = field === 'listen' ? active : (current?.listen ?? false)

		if (talk || listen) {
			this.heldKeys.set(token, { key: keyRef(key), talk, listen })
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

	/**
	 * Only users log in and out. Party lines and groups are always there, so they
	 * always read as connected rather than fading away.
	 */
	private isKeyUserConnected(key: KeyConfig): boolean {
		if (key.target_type !== 'user') return true
		return this.connectedUsers.has(key.target_id)
	}

	private send(message: Message): boolean {
		return this.connection?.send(message) ?? false
	}

	private isConnected(): boolean {
		return this.connection?.isOpen ?? false
	}

	private resetSession(): void {
		this.userId = ''
		this.displayName = ''
		this.keys = []
		this.availableUsers = []
		this.connectedUsers.clear()
		this.keyState.reset()
		clearTimeout(this.activityTrailTimer)
		this.activityTrailTimer = undefined
		this.activity = new ActivityStore()
		this.retryReason = undefined
		this.lastTapAt.clear()
		this.talkLatchBeforeTap.clear()
		for (const timer of this.settleTimers.values()) clearTimeout(timer)
		this.settleTimers.clear()
		for (const timer of this.pressTimers.values()) clearTimeout(timer)
		this.pressTimers.clear()
		this.stopAllLevelRepeats()
		for (const timer of this.selectHoldTimers.values()) clearTimeout(timer)
		this.selectHoldTimers.clear()
		this.selectHolds.clear()
		this.secondTapInProgress.clear()
		this.pressApplied.clear()
		this.talkControlState = createControlState()
		this.listenControlState = createControlState()
		this.mic = createEmptyMicState()
		this.devices = []
		this.micError = ''
	}
}

export default LivematrixInstance
export type { LivematrixConfig, LivematrixSecrets }
export { UpgradeScripts } from './upgrades.js'
