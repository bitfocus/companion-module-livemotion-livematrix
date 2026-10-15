import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeLiveMatrix, startInstance, waitFor, type FakeOptions, type Mode } from './support/fake-livematrix.js'

vi.mock('@companion-module/base', () => import('./support/companion-base.js'))

const { LiveMatrixInstance } = await import('../src/index.js')

describe('connection', () => {
	let fake: FakeLiveMatrix
	let instance: any

	async function start(
		mode: Mode,
		options: FakeOptions = {},
		timing: { keepaliveIntervalMs?: number; reconnectDelayMs?: number } = {},
	) {
		fake = new FakeLiveMatrix(mode, options)
		instance = await startInstance(LiveMatrixInstance, fake, timing)
	}

	afterEach(async () => {
		await instance?.destroy()
		await fake?.close()
		instance = undefined
	})

	it('pings an idle server so it is not dropped', async () => {
		await start('server', {}, { keepaliveIntervalMs: 20 })
		await waitFor(() => fake.sent('ping').length >= 3, 'three pings')
		const seqs = fake.sent('ping').map((ping) => ping.seq)
		expect(seqs.slice(0, 3)).toEqual([1, 2, 3])
		expect(fake.connections).toBe(1)
		expect(instance.status.status).toBe('ok')
	})

	it('never pings the client control API', async () => {
		await start('client', {}, { keepaliveIntervalMs: 20 })
		await waitFor(() => fake.isGreeted, 'the greeting')
		await new Promise((resolve) => setTimeout(resolve, 100))
		expect(fake.sent('ping')).toEqual([])
	})

	it('gives up on a socket whose pings go unanswered, and reconnects', async () => {
		await start('server', { ignorePings: true }, { keepaliveIntervalMs: 20 })
		await waitFor(() => fake.connections >= 2, 'a reconnect')
		await waitFor(() => fake.sent('login').length >= 2, 'a second login')
		expect(new Set(fake.sent('login').map((login) => login.device_id))).toEqual(new Set(['companion-conn-1']))
	})

	it('reconnects after the server drops the socket', async () => {
		await start('server')
		await waitFor(() => instance.status?.status === 'ok', 'login')
		fake.drop()
		await waitFor(() => fake.connections >= 2 && instance.status?.status === 'ok', 'a second login')
	})

	it('stops on a fatal login failure', async () => {
		await start('server', {
			refuseLogin: { type: 'login_failure', reason: 'Invalid username or password', fatal: true },
		})
		await waitFor(() => instance.status?.status === 'authentication_failure', 'the failure')
		expect(instance.status.message).toBe('Invalid username or password')
		await new Promise((resolve) => setTimeout(resolve, 100))
		expect(fake.connections).toBe(1)
	})

	it('keeps retrying a login refused for a reason that clears up', async () => {
		await start('server', {
			refuseLogin: { type: 'login_failure', reason: 'All licences are in use', fatal: false, code: 'license_full' },
		})
		await waitFor(() => fake.connections >= 3, 'repeated attempts')
		expect(instance.status).toEqual({
			status: 'connection_failure',
			message: 'All licences are in use (license_full)',
		})
		expect(instance.statuses.map((status: any) => status.status)).not.toContain('authentication_failure')
	})

	it('stays down after the server ends the session on purpose', async () => {
		await start('server')
		await waitFor(() => instance.status?.status === 'ok', 'login')
		fake.push({ type: 'session_ended', reason: 'trial_session_limit', message: 'The trial session has ended' })
		fake.drop()
		await waitFor(() => instance.status?.message === 'The trial session has ended', 'the session end')
		await new Promise((resolve) => setTimeout(resolve, 100))
		expect(fake.connections).toBe(1)
		expect(instance.status).toEqual({ status: 'disconnected', message: 'The trial session has ended' })
	})
})
