import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import type { AddressInfo } from 'node:net'

export type Message = Record<string, any>
export type Mode = 'server' | 'client'

export const USER_KEY = {
	id: 'k1',
	target_type: 'user',
	target_id: 'user-b',
	display_name: 'Bob',
	can_listen: true,
	can_talk: true,
	allow_listen_latching: true,
	allow_talk_latching: true,
	default_listen_active: false,
	default_talk_active: false,
	talk_priority: 0,
	listen_priority: 0,
}

/** Shaped like the server's own `login_success`, required fields and all. */
export const LOGIN_SUCCESS = {
	type: 'login_success',
	user_id: 'user-a',
	display_name: 'Alice',
	device_id: 'companion-conn-1',
	keys: [USER_KEY],
	available_users: [{ id: 'user-b', display_name: 'Bob', is_connected: true }],
	allow_talk_all: false,
	peer_reattached: false,
	momentary_heartbeat_interval_ms: 10_000,
	momentary_timeout_ms: 30_000,
	ctl_epoch: 1,
	control_channel: false,
}

export function emptyUserState() {
	return {
		talk_active: {},
		listen_active: {},
		listen_level: {},
		party_line_talk_active: {},
		party_line_listen_active: {},
		party_line_listen_level: {},
		group_talk_active: {},
		direct_talk_level: {},
		listen_priority_override: {},
		party_line_listen_priority_override: {},
		incoming_priority_override: {},
		listen_priority: {},
		party_line_listen_priority: {},
		incoming_priority: {},
	}
}

export const STATE_UPDATE = {
	type: 'state_update',
	state: emptyUserState(),
	latched: emptyUserState(),
}

export const INITIAL_MIC = {
	type: 'mic_state',
	device_id: 'desk-1',
	device_name: 'Desk',
	holder_online: true,
	muted: false,
	open: true,
	is_mine: false,
}

export interface FakeOptions {
	/** Answer a login with this instead of logging the panel in. */
	refuseLogin?: Message
	/** Leave pings unanswered, like a socket that is only half there. */
	ignorePings?: boolean
	loginSuccess?: Message
}

/**
 * Plays the livematrix server (`/ws`, answers a login and pings) or the app's
 * local control API (`/`, greets straight away with no login, ignores what it
 * does not know). Both speak the same protocol after that, so one fake covers
 * both.
 */
export class FakeLiveMatrix {
	readonly received: Message[] = []
	readonly paths: string[] = []
	connections = 0
	private readonly wss: WebSocketServer
	private socket: ServerSocket | undefined
	private greeted = false

	constructor(
		readonly mode: Mode,
		private readonly options: FakeOptions = {},
	) {
		this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
		this.wss.on('connection', (socket, request) => {
			this.connections += 1
			this.socket = socket
			this.paths.push(request.url ?? '')
			socket.on('message', (data) => {
				const message = JSON.parse(data.toString()) as Message
				this.received.push(message)
				if (mode !== 'server') return
				if (message.type === 'login') {
					if (this.options.refuseLogin) {
						this.push(this.options.refuseLogin)
						socket.close()
					} else {
						this.greet()
					}
				}
				if (message.type === 'ping' && !this.options.ignorePings) this.push({ type: 'pong', seq: message.seq })
			})
			if (mode === 'client') this.greet()
		})
	}

	async listening(): Promise<number> {
		if (!this.wss.address()) await new Promise((resolve) => this.wss.once('listening', resolve))
		return (this.wss.address() as AddressInfo).port
	}

	private greet(): void {
		this.push(this.options.loginSuccess ?? LOGIN_SUCCESS)
		this.push(STATE_UPDATE)
		this.push(INITIAL_MIC)
		// The control API always sends activity too; the module has to take it in its stride.
		this.push({ type: 'activity_update', talking_to_me: [], listening_to_me: [] })
		this.greeted = true
	}

	get isGreeted(): boolean {
		return this.greeted
	}

	push(message: Message): void {
		this.socket?.send(JSON.stringify(message))
	}

	/** Close the current socket from the server side. */
	drop(): void {
		this.socket?.close()
	}

	sent(type: string): Message[] {
		return this.received.filter((message) => message.type === type)
	}

	async close(): Promise<void> {
		for (const client of this.wss.clients) client.terminate()
		await new Promise<void>((resolve) => this.wss.close(() => resolve()))
	}
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

export function configFor(mode: Mode, port: number) {
	return mode === 'server'
		? {
				connection_mode: 'server',
				host: '127.0.0.1',
				port,
				username: 'alice',
				server_tls: false,
				client_host: '',
				client_port: 0,
			}
		: {
				connection_mode: 'client',
				host: '',
				port: 0,
				username: '',
				server_tls: false,
				client_host: '127.0.0.1',
				client_port: port,
			}
}

/**
 * Start an instance against the fake, with connection timing shortened so a
 * test can watch reconnects and keepalives happen.
 */
export async function startInstance(
	InstanceClass: new (internal: any) => any,
	fake: FakeLiveMatrix,
	timing: { keepaliveIntervalMs?: number; reconnectDelayMs?: number } = {},
): Promise<any> {
	const port = await fake.listening()
	const instance = new InstanceClass({})
	instance.keepaliveIntervalMs = timing.keepaliveIntervalMs ?? 60_000
	instance.reconnectDelayMs = timing.reconnectDelayMs ?? 20
	await instance.init(configFor(fake.mode, port), true, fake.mode === 'server' ? { password: 'secret' } : {})
	return instance
}
