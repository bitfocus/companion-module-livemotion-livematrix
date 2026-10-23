/**
 * A stand-in for Companion's InstanceBase. It keeps whatever the module
 * registers, so a test can inspect definitions and variable values and run
 * actions and feedbacks by id the way Companion would.
 *
 * Use with `vi.mock('@companion-module/base', () => import('./support/companion-base.js'))`.
 */
export class InstanceBase {
	actions: Record<string, any> = {}
	feedbacks: Record<string, any> = {}
	variableDefinitions: Record<string, any> = {}
	presetStructure: any[] = []
	presets: Record<string, any> = {}
	values: Record<string, unknown> = {}
	checkedFeedbacks: string[] = []
	statuses: Array<{ status: string; message?: string | null }> = []

	constructor(_internal?: unknown) {}

	get id(): string {
		return 'conn-1'
	}

	setActionDefinitions(definitions: Record<string, any>): void {
		this.actions = definitions
	}
	setFeedbackDefinitions(definitions: Record<string, any>): void {
		this.feedbacks = definitions
	}
	setVariableDefinitions(definitions: Record<string, any>): void {
		this.variableDefinitions = definitions
	}
	setPresetDefinitions(structure: any[], presets: Record<string, any>): void {
		this.presetStructure = structure
		this.presets = presets
	}
	setVariableValues(values: Record<string, unknown>): void {
		Object.assign(this.values, values)
	}
	checkFeedbacks(...ids: string[]): void {
		this.checkedFeedbacks.push(...ids)
	}
	checkAllFeedbacks(): void {
		this.checkedFeedbacks.push('*')
	}
	updateStatus(status: string, message?: string | null): void {
		this.statuses.push({ status, message })
	}
	log(_level: string, _message: string): void {}

	get status(): { status: string; message?: string | null } | undefined {
		return this.statuses.at(-1)
	}

	async runAction(actionId: string, options: Record<string, unknown> = {}, controlId = 'test'): Promise<void> {
		const definition = this.actions[actionId]
		if (!definition) throw new Error(`No action ${actionId}`)
		await definition.callback({ id: `test-${actionId}`, actionId, controlId, options })
	}
	async runFeedback(feedbackId: string, options: Record<string, unknown> = {}): Promise<unknown> {
		const definition = this.feedbacks[feedbackId]
		if (!definition) throw new Error(`No feedback ${feedbackId}`)
		return definition.callback({ id: `test-${feedbackId}`, feedbackId, controlId: 'test', options })
	}
}

export const InstanceStatus = {
	Ok: 'ok',
	Connecting: 'connecting',
	Disconnected: 'disconnected',
	ConnectionFailure: 'connection_failure',
	BadConfig: 'bad_config',
	AuthenticationFailure: 'authentication_failure',
}

export const Regex = { HOSTNAME: '/^.*$/' }

export const combineRgb = (r: number, g: number, b: number): number =>
	((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)

export const ButtonGraphicsDecorationType = { FollowDefault: 'followDefault' }
