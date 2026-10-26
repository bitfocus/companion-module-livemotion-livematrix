import { Regex, type CompanionVariableValues, type SomeCompanionConfigField } from '@companion-module/base'

export type ConnectionMode = 'server' | 'client'

export type LivematrixConfig = {
	connection_mode: ConnectionMode
	host: string
	port: number
	username: string
	server_tls: boolean
	client_host: string
	client_port: number
}

export type LivematrixSecrets = {
	password?: string
}

export type LivematrixManifest = {
	config: LivematrixConfig
	secrets: LivematrixSecrets
	actions: Record<string, any>
	feedbacks: Record<string, any>
	variables: CompanionVariableValues
}

export const DEFAULT_SERVER_PORT = 55678
export const DEFAULT_CLIENT_PORT = 9100
/**
 * The client app's control API listens on IPv4 loopback only, so client mode
 * reaches an app on the machine Companion runs on and nowhere else.
 */
export const DEFAULT_CLIENT_HOST = '127.0.0.1'

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'dropdown',
			id: 'connection_mode',
			label: 'Connection mode',
			width: 6,
			default: 'server',
			choices: [
				{ id: 'server', label: 'Direct to server' },
				{ id: 'client', label: "Via a client's control API" },
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
			type: 'static-text',
			id: 'client_info',
			label: 'Client mode',
			width: 12,
			value:
				'The client app only accepts control API connections from the same machine, so run it on the computer Companion runs on.',
			isVisibleExpression: "$(options:connection_mode) == 'client'",
		},
		{
			type: 'textinput',
			id: 'client_host',
			label: 'Control API host',
			width: 6,
			default: DEFAULT_CLIENT_HOST,
			regex: Regex.HOSTNAME,
			isVisibleExpression: "$(options:connection_mode) == 'client'",
		},
		{
			type: 'number',
			id: 'client_port',
			label: 'Control API port',
			width: 6,
			default: DEFAULT_CLIENT_PORT,
			min: 1,
			max: 65535,
			isVisibleExpression: "$(options:connection_mode) == 'client'",
		},
	]
}

export function validateConfig(config: LivematrixConfig, secrets: LivematrixSecrets): string | undefined {
	if (config.connection_mode === 'server') {
		if (!config.host?.trim()) return 'Server host is required'
		if (!config.username?.trim()) return 'Username is required'
		if (!secrets.password?.trim()) return 'Password is required'
	} else if (!config.client_host?.trim()) {
		return 'Control API host is required'
	}
	return undefined
}

export function buildWebSocketUrl(config: LivematrixConfig): string {
	if (config.connection_mode === 'server') {
		const scheme = config.server_tls ? 'wss' : 'ws'
		const host = config.host?.trim() || 'localhost'
		const port = config.port ?? DEFAULT_SERVER_PORT
		return `${scheme}://${host}:${port}/ws`
	}

	// The client app's control API speaks plain WebSocket only.
	const host = config.client_host?.trim() || DEFAULT_CLIENT_HOST
	const port = config.client_port ?? DEFAULT_CLIENT_PORT
	return `ws://${host}:${port}`
}
