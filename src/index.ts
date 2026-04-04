import {
	InstanceBase,
	InstanceStatus,
	Regex,
	combineRgb,
	runEntrypoint,
	type CompanionActionDefinitions,
	type CompanionFeedbackDefinitions,
	type CompanionOptionValues,
	type CompanionPresetDefinitions,
	type CompanionVariableDefinition,
	type CompanionVariableValues,
	type DropdownChoice,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import WebSocket from 'ws'
import { upgradeScripts } from './upgrades'

type ConnectionMode = 'server' | 'client'
type GlobalMode = 'talk' | 'mute'
type SetMode = 'toggle' | 'on' | 'off'
type KeySelectionMode = 'index' | 'target'

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
}

interface StateUpdateMessage {
	type: 'state_update'
	state: Partial<UserState>
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

interface LiveMatrixConfig {
	connection_mode: ConnectionMode
	host: string
	port: number
	username: string
	password: string
	server_tls: boolean
	client_host: string
	client_port: number
	client_tls: boolean
}

interface KeyControlState {
	latched: Map<string, boolean>
	pressing: Map<string, boolean>
	pressStart: Map<string, number>
	keepAliveTimers: Map<string, NodeJS.Timeout>
}

const TAP_THRESHOLD_MS = 300
const KEEP_ALIVE_INTERVAL_MS = 30_000
const DEFAULT_SERVER_PORT = 55678
const DEFAULT_CLIENT_PORT = 9100
const MIN_LISTEN_LEVEL_DB = -100

const keySelectChoices = [
	{ id: 'target', label: 'By target' },
	{ id: 'index', label: 'By index' },
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
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '') || 'unnamed'
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

export class LiveMatrixInstance extends InstanceBase<LiveMatrixConfig> {
	config!: LiveMatrixConfig
	private ws: WebSocket | null = null
	private reconnectTimer: NodeJS.Timeout | undefined
	private shouldReconnect = false

	private userId = ''
	private displayName = ''
	private deviceId = ''
	private keys: KeyConfig[] = []
	private availableUsers: UserInfo[] = []
	private connectedUsers = new Set<string>()
	private state: UserState = createEmptyState()

	private talkControlState: KeyControlState = this.createControlState()
	private listenControlState: KeyControlState = this.createControlState()
	private globalLatched = false
	private globalPressing = false
	private globalPressStart: number | undefined

	async init(config: LiveMatrixConfig): Promise<void> {
		this.config = config
		this.setupDefinitions()
		await this.connect()
	}

	async destroy(): Promise<void> {
		this.shouldReconnect = false
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = undefined
		}
		this.clearAllKeepAliveTimers()
		await this.disconnect()
	}

	async configUpdated(config: LiveMatrixConfig): Promise<void> {
		this.config = config
		this.shouldReconnect = false
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = undefined
		}
		this.clearAllKeepAliveTimers()
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
				type: 'textinput',
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
			keepAliveTimers: new Map(),
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
					password: this.config.password,
				})
			}
		})

		ws.on('message', (data) => {
			void this.handleMessage(data.toString())
		})

		ws.on('error', (error) => {
			const message = error instanceof Error ? error.message : String(error)
			this.log('error', `WebSocket error: ${message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, message)
		})

		ws.on('close', () => {
			if (this.ws === ws) {
				this.ws = null
			}
			this.clearAllKeepAliveTimers()
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
		const password = this.config.password?.trim() ?? ''
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
		this.deviceId = message.device_id
		this.availableUsers = message.available_users ?? []
		this.connectedUsers = new Set(
			this.availableUsers.filter((user) => user.is_connected).map((user) => user.id)
		)
		this.applyKeys(message.keys ?? [])
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
		this.state = {
			...this.state,
			...message.state,
			talk_active: {
				...this.state.talk_active,
				...(message.state.talk_active ?? {}),
			},
			listen_active: {
				...this.state.listen_active,
				...(message.state.listen_active ?? {}),
			},
			listen_level: {
				...this.state.listen_level,
				...(message.state.listen_level ?? {}),
			},
			party_line_talk_active: {
				...this.state.party_line_talk_active,
				...(message.state.party_line_talk_active ?? {}),
			},
			party_line_listen_active: {
				...this.state.party_line_listen_active,
				...(message.state.party_line_listen_active ?? {}),
			},
			party_line_listen_level: {
				...this.state.party_line_listen_level,
				...(message.state.party_line_listen_level ?? {}),
			},
		}

		this.syncLatchStateFromServer()
		this.pushVariableValues()
		this.checkFeedbacks()
	}

	private handleKeysChanged(message: KeysChangedMessage): void {
		this.applyKeys(message.keys ?? [])
	}

	private handleUserConnected(message: UserConnectedMessage): void {
		this.connectedUsers.add(message.user_id)
		this.availableUsers = this.availableUsers.map((user) =>
			user.id === message.user_id ? { ...user, is_connected: true } : user
		)
		this.pushVariableValues()
		this.checkFeedbacks()
	}

	private handleUserDisconnected(message: UserDisconnectedMessage): void {
		this.connectedUsers.delete(message.user_id)
		this.availableUsers = this.availableUsers.map((user) =>
			user.id === message.user_id ? { ...user, is_connected: false } : user
		)
		this.pushVariableValues()
		this.checkFeedbacks()
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
		this.setupDefinitions()
	}

	private syncLatchStateFromServer(): void {
		for (const key of this.keys) {
			const targetId = key.target_id
			if (!this.talkControlState.pressing.get(targetId)) {
				this.talkControlState.latched.set(targetId, this.getTalkActive(key))
			}
			if (!this.listenControlState.pressing.get(targetId)) {
				this.listenControlState.latched.set(targetId, this.getListenActive(key))
			}
		}

		if (!this.globalPressing) {
			this.globalLatched = this.state.global_active
		}
	}

	private setupDefinitions(): void {
		this.setActionDefinitions(this.getActionDefinitions())
		this.setFeedbackDefinitions(this.getFeedbackDefinitions())
		this.setPresetDefinitions(this.getPresetDefinitions())
		this.setVariableDefinitions(this.getVariableDefinitions())
		this.pushVariableValues()
	}

	private getActionDefinitions(): CompanionActionDefinitions {
		return {
			talk_down: {
				name: 'Talk key down',
				options: this.getKeySelectorOptions(),
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (key) this.onTalkDown(key)
				},
			},
			talk_up: {
				name: 'Talk key up',
				options: this.getKeySelectorOptions(),
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (key) this.onTalkUp(key)
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
				options: this.getKeySelectorOptions(),
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (key) this.onListenDown(key)
				},
			},
			listen_up: {
				name: 'Listen key up',
				options: this.getKeySelectorOptions(),
				callback: async (action) => {
					const key = this.resolveKey(action.options)
					if (key) this.onListenUp(key)
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
						label: 'Level dB (-100 to +6, users max 0)',
						default: 0,
						min: MIN_LISTEN_LEVEL_DB,
						max: 6,
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

	private getPresetDefinitions(): CompanionPresetDefinitions {
		const presets: CompanionPresetDefinitions = {
			global_button: {
				type: 'button',
				category: 'Global',
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

		for (const [index, key] of this.keys.entries()) {
			const targetToken = this.keyTargetToken(key)
			const safeName = sanitizeName(key.display_name)

			presets[`talk_index_${index}`] = this.createKeyPreset(
				'Talk Keys (by index)',
				`Talk key ${index}`,
				`$(livematrix:key_${index}_name)\nTALK`,
				'talk',
				{ selection_mode: 'index', key_index: index }
			)
			presets[`listen_index_${index}`] = this.createKeyPreset(
				'Listen Keys (by index)',
				`Listen key ${index}`,
				`$(livematrix:key_${index}_name)\nLISTEN`,
				'listen',
				{ selection_mode: 'index', key_index: index }
			)
			presets[`talk_target_${safeName}_${index}`] = this.createKeyPreset(
				'Talk Keys (by target)',
				`Talk ${key.display_name}`,
				`${key.display_name}\nTALK`,
				'talk',
				{ selection_mode: 'target', key_target: targetToken }
			)
			presets[`listen_target_${safeName}_${index}`] = this.createKeyPreset(
				'Listen Keys (by target)',
				`Listen ${key.display_name}`,
				`${key.display_name}\nLISTEN`,
				'listen',
				{ selection_mode: 'target', key_target: targetToken }
			)
		}

		return presets
	}

	private createKeyPreset(
		category: string,
		name: string,
		text: string,
		mode: 'talk' | 'listen',
		options: CompanionOptionValues
	) {
		const feedbackId = mode === 'talk' ? 'talk_active' : 'listen_active'
		const downAction = mode === 'talk' ? 'talk_down' : 'listen_down'
		const upAction = mode === 'talk' ? 'talk_up' : 'listen_up'

		return {
			type: 'button' as const,
			category,
			name,
			style: {
				text,
				size: 14,
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				alignment: 'center:center' as const,
			},
			feedbacks: [{ feedbackId, options }],
			steps: [
				{
					down: [{ actionId: downAction, options }],
					up: [{ actionId: upAction, options }],
				},
			],
		}
	}

	private getVariableDefinitions(): CompanionVariableDefinition[] {
		const variables: CompanionVariableDefinition[] = [
			{ variableId: 'user_id', name: 'Logged-in user ID' },
			{ variableId: 'display_name', name: 'Logged-in display name' },
			{ variableId: 'connected', name: 'Connected' },
			{ variableId: 'global_mode', name: 'Global mode' },
			{ variableId: 'global_active', name: 'Global active' },
			{ variableId: 'key_count', name: 'Key count' },
		]

		const seenTargetNames = new Set<string>()
		for (const [index, key] of this.keys.entries()) {
			variables.push(
				{ variableId: `key_${index}_name`, name: `Key ${index} display name` },
				{ variableId: `key_${index}_target_type`, name: `Key ${index} target type` },
				{ variableId: `key_${index}_target_id`, name: `Key ${index} target ID` },
				{ variableId: `key_${index}_talk`, name: `Key ${index} talk active` },
				{ variableId: `key_${index}_listen`, name: `Key ${index} listen active` },
				{ variableId: `key_${index}_level`, name: `Key ${index} listen level dB` },
				{ variableId: `tid_${key.target_id}_name`, name: `${key.display_name} name` },
				{ variableId: `tid_${key.target_id}_talk`, name: `${key.display_name} talk active` },
				{ variableId: `tid_${key.target_id}_listen`, name: `${key.display_name} listen active` },
				{ variableId: `tid_${key.target_id}_level`, name: `${key.display_name} listen level dB` }
			)

			const sanitized = sanitizeName(key.display_name)
			if (!seenTargetNames.has(sanitized)) {
				seenTargetNames.add(sanitized)
				variables.push(
					{ variableId: `target_${sanitized}_talk`, name: `${key.display_name} talk active` },
					{ variableId: `target_${sanitized}_listen`, name: `${key.display_name} listen active` },
					{ variableId: `target_${sanitized}_level`, name: `${key.display_name} listen level dB` }
				)
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

	private onTalkDown(key: KeyConfig): void {
		if (!key.can_talk) return
		this.talkControlState.pressStart.set(key.target_id, Date.now())
		this.talkControlState.pressing.set(key.target_id, true)
		this.setTalkActive(key, this.getEffectiveState(this.talkControlState, key.target_id))
	}

	private onTalkUp(key: KeyConfig): void {
		if (!key.can_talk) return
		const wasShortPress = this.wasShortPress(this.talkControlState, key.target_id)
		const wasMomentary = this.talkControlState.pressing.get(key.target_id) ?? false

		this.talkControlState.pressing.set(key.target_id, false)
		if (key.allow_talk_latching && wasShortPress) {
			this.talkControlState.latched.set(
				key.target_id,
				!(this.talkControlState.latched.get(key.target_id) ?? false)
			)
		}

		const newEffective = this.getEffectiveState(this.talkControlState, key.target_id)
		if (wasMomentary && newEffective && (this.talkControlState.latched.get(key.target_id) ?? false)) {
			this.stopKeepAlive(this.talkControlState, key.target_id)
			this.setTalkActive(key, true, { forceSend: true, momentary: false })
		} else {
			this.setTalkActive(key, newEffective)
		}
	}

	private onListenDown(key: KeyConfig): void {
		if (!key.can_listen) return
		this.listenControlState.pressStart.set(key.target_id, Date.now())
		this.listenControlState.pressing.set(key.target_id, true)
		this.setListenActive(key, this.getEffectiveState(this.listenControlState, key.target_id))
	}

	private onListenUp(key: KeyConfig): void {
		if (!key.can_listen) return
		const wasShortPress = this.wasShortPress(this.listenControlState, key.target_id)
		const wasMomentary = this.listenControlState.pressing.get(key.target_id) ?? false

		this.listenControlState.pressing.set(key.target_id, false)
		if (key.allow_listen_latching && wasShortPress) {
			this.listenControlState.latched.set(
				key.target_id,
				!(this.listenControlState.latched.get(key.target_id) ?? false)
			)
		}

		const newEffective = this.getEffectiveState(this.listenControlState, key.target_id)
		if (wasMomentary && newEffective && (this.listenControlState.latched.get(key.target_id) ?? false)) {
			this.stopKeepAlive(this.listenControlState, key.target_id)
			this.setListenActive(key, true, { forceSend: true, momentary: false })
		} else {
			this.setListenActive(key, newEffective)
		}
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
		if (key.target_type === 'party_line') {
			this.send({
				type: 'set_party_line_listen_level',
				party_line_id: key.target_id,
				level: linearLevel,
			})
		} else {
			this.send({
				type: 'set_listen_level',
				target_user: key.target_id,
				level: linearLevel,
			})
		}
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
		const wasShortPress =
			this.globalPressStart !== undefined && Date.now() - this.globalPressStart < TAP_THRESHOLD_MS
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
		options: { forceSend?: boolean; momentary?: boolean } = {}
	): void {
		const current = this.getTalkActive(key)
		if (current === active && !options.forceSend) return

		this.stateTalkMapForKey(key)[key.target_id] = active
		const momentary =
			options.momentary ??
			(active &&
				(this.talkControlState.pressing.get(key.target_id) ?? false) &&
				!(this.talkControlState.latched.get(key.target_id) ?? false))

		if (key.target_type === 'party_line') {
			this.send({
				type: 'set_party_line_talk_state',
				party_line_id: key.target_id,
				active,
			})
		} else {
			this.send({
				type: 'set_talk_state',
				target_user: key.target_id,
				active,
				...(momentary ? { momentary: true } : {}),
			})
			if (momentary) {
				this.startKeepAlive(this.talkControlState, key.target_id, 'talk_keep_alive')
			} else {
				this.stopKeepAlive(this.talkControlState, key.target_id)
			}
		}

		this.pushVariableValues()
		this.checkFeedbacks('talk_active')
	}

	private setListenActive(
		key: KeyConfig,
		active: boolean,
		options: { forceSend?: boolean; momentary?: boolean } = {}
	): void {
		const current = this.getListenActive(key)
		if (current === active && !options.forceSend) return

		this.stateListenMapForKey(key)[key.target_id] = active
		const momentary =
			options.momentary ??
			(active &&
				(this.listenControlState.pressing.get(key.target_id) ?? false) &&
				!(this.listenControlState.latched.get(key.target_id) ?? false))

		if (key.target_type === 'party_line') {
			this.send({
				type: 'set_party_line_listen_state',
				party_line_id: key.target_id,
				active,
			})
		} else {
			this.send({
				type: 'set_listen_state',
				target_user: key.target_id,
				active,
				...(momentary ? { momentary: true } : {}),
			})
			if (momentary) {
				this.startKeepAlive(this.listenControlState, key.target_id, 'listen_keep_alive')
			} else {
				this.stopKeepAlive(this.listenControlState, key.target_id)
			}
		}

		this.pushVariableValues()
		this.checkFeedbacks('listen_active')
	}

	private startKeepAlive(controlState: KeyControlState, targetId: string, messageType: string): void {
		this.stopKeepAlive(controlState, targetId)
		controlState.keepAliveTimers.set(
			targetId,
			setInterval(() => {
				this.send({
					type: messageType,
					target_user: targetId,
				})
			}, KEEP_ALIVE_INTERVAL_MS)
		)
	}

	private stopKeepAlive(controlState: KeyControlState, targetId: string): void {
		const timer = controlState.keepAliveTimers.get(targetId)
		if (timer) {
			clearInterval(timer)
			controlState.keepAliveTimers.delete(targetId)
		}
	}

	private clearAllKeepAliveTimers(): void {
		for (const timer of this.talkControlState.keepAliveTimers.values()) {
			clearInterval(timer)
		}
		for (const timer of this.listenControlState.keepAliveTimers.values()) {
			clearInterval(timer)
		}
		this.talkControlState.keepAliveTimers.clear()
		this.listenControlState.keepAliveTimers.clear()
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

	private clampListenLevelLinear(key: KeyConfig, level: number): number {
		return clamp(level, 0, key.target_type === 'party_line' ? 2 : 1)
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
		this.deviceId = ''
		this.keys = []
		this.availableUsers = []
		this.connectedUsers.clear()
		this.state = createEmptyState()
		this.talkControlState = this.createControlState()
		this.listenControlState = this.createControlState()
		this.globalLatched = false
		this.globalPressing = false
		this.globalPressStart = undefined
	}
}

runEntrypoint(LiveMatrixInstance, upgradeScripts)

export type { LiveMatrixConfig }
