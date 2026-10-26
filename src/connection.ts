import WebSocket, { type RawData } from 'ws'
import type { Message } from './protocol.js'

export interface ConnectionEvents {
	/** The socket is open; nothing has been said on it yet. */
	open(): void
	message(message: Message): void
	/** The socket is gone. A reconnect follows unless `stopReconnecting` was called. */
	close(reconnecting: boolean): void
	error(message: string): void
	warn(message: string): void
}

export interface ConnectionOptions {
	/**
	 * Send a `ping` this often while connected, and give the socket up once
	 * nothing at all has arrived for three of these. The server drops a socket it
	 * has not heard from for a while, and a panel that only talks while a key is
	 * held would otherwise be dropped whenever it sits idle. Zero disables it,
	 * for peers that neither expect nor answer a ping.
	 */
	keepaliveIntervalMs: number
	/** How long to wait before trying again after the socket goes away. */
	reconnectDelayMs: number
	/**
	 * Accept a TLS certificate that does not verify, such as the server's
	 * self-signed one, which is all it has for an IP address.
	 */
	allowUnverifiedCertificate?: boolean
}

/**
 * One WebSocket to LiveMatrix, kept up: reconnects after a drop, and keeps an
 * idle link alive. Knows nothing about what the messages mean.
 */
export class LiveMatrixConnection {
	private ws: WebSocket | null = null
	private reconnectTimer: NodeJS.Timeout | undefined
	private keepaliveTimer: NodeJS.Timeout | undefined
	private shouldReconnect = false
	private pingSeq = 0
	private lastReceivedAt = 0

	constructor(
		private readonly url: string,
		private readonly events: ConnectionEvents,
		private readonly options: ConnectionOptions,
	) {}

	get isOpen(): boolean {
		return this.ws?.readyState === WebSocket.OPEN
	}

	start(): void {
		this.shouldReconnect = true
		this.open()
	}

	/** Close for good: no reconnect, and resolve once the socket is gone. */
	async stop(): Promise<void> {
		this.stopReconnecting()
		const ws = this.ws
		this.ws = null
		this.stopKeepalive()
		if (!ws) return

		await new Promise<void>((resolve) => {
			ws.once('close', () => resolve())
			try {
				ws.close()
			} catch {
				resolve()
			}
			setTimeout(resolve, 500)
		})
	}

	/** Leave the socket as it is, but do not come back once it closes. */
	stopReconnecting(): void {
		this.shouldReconnect = false
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = undefined
		}
	}

	/** Drop this socket and let the usual reconnect bring up a new one. */
	recycle(): void {
		this.ws?.close()
	}

	send(message: Message): boolean {
		if (!this.isOpen) return false
		try {
			this.ws?.send(JSON.stringify(message))
			return true
		} catch (error) {
			this.events.error(`Failed to send websocket message: ${String(error)}`)
			return false
		}
	}

	private open(): void {
		const ws = new WebSocket(this.url, { rejectUnauthorized: !this.options.allowUnverifiedCertificate })
		this.ws = ws

		ws.on('open', () => {
			if (this.ws !== ws) return
			this.lastReceivedAt = Date.now()
			this.startKeepalive()
			this.events.open()
		})

		ws.on('message', (data: RawData) => {
			if (this.ws !== ws) return
			this.lastReceivedAt = Date.now()
			let message: Message
			try {
				message = JSON.parse(data.toString()) as Message
			} catch (error) {
				this.events.warn(`Ignoring invalid JSON message: ${String(error)}`)
				return
			}
			this.events.message(message)
		})

		ws.on('error', (error: Error) => {
			this.events.error(error instanceof Error ? error.message : String(error))
		})

		ws.on('close', () => {
			// A socket replaced or stopped on purpose has nothing more to report.
			if (this.ws !== ws) return
			this.ws = null
			this.stopKeepalive()
			this.events.close(this.shouldReconnect)
			if (this.shouldReconnect) this.scheduleReconnect()
		})
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined
			if (this.shouldReconnect) this.open()
		}, this.options.reconnectDelayMs)
	}

	private startKeepalive(): void {
		const interval = this.options.keepaliveIntervalMs
		if (interval <= 0) return
		this.stopKeepalive()
		this.keepaliveTimer = setInterval(() => {
			// The server answers every ping, so silence this long means a socket
			// that is open on our side only.
			if (Date.now() - this.lastReceivedAt > interval * 3) {
				this.events.warn('No reply from LiveMatrix, reconnecting')
				this.ws?.terminate()
				return
			}
			this.send({ type: 'ping', seq: ++this.pingSeq })
		}, interval)
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer)
			this.keepaliveTimer = undefined
		}
	}
}
