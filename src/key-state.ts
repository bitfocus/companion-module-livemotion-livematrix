import {
	createEmptyState,
	isLine,
	readUserState,
	type KeyConfig,
	type KeyField,
	type StateUpdateMessage,
	type UserState,
} from './protocol.js'
import { linearToDb } from './levels.js'

/**
 * What the server last said each key is doing, plus whatever we have changed
 * locally since and not yet heard back about. Knows which bucket of the wire
 * snapshot a key lives in, so nothing else has to.
 */
export class KeyStateStore {
	private state: UserState = createEmptyState()
	/** The latched layer of the last state update, when the server sends one. */
	private latched: UserState | undefined
	/**
	 * Groups only talk, so the wire has nowhere for their listen state. Kept here
	 * so a stray listen write on a group key has somewhere harmless to land.
	 */
	private groupListen: Record<string, boolean> = {}
	private groupLevel: Record<string, number> = {}
	/** Whether the last snapshot carried group talk at all; see `apply`. */
	private groupTalkRelayed = true

	reset(): void {
		this.state = createEmptyState()
		this.latched = undefined
		this.groupTalkRelayed = true
		this.groupListen = {}
		this.groupLevel = {}
	}

	apply(message: StateUpdateMessage): void {
		const groupTalk = this.state.group_talk_active
		this.state = readUserState(message.state)
		// The effective state alone cannot say whether a key is on because it is
		// latched or because someone is leaning on it. The server tells us both.
		this.latched = message.latched ? readUserState(message.latched) : undefined

		// Client apps relayed group talk only from a later release; before that
		// their snapshot leaves it out. Absent is not off: keep what we last set,
		// or every press on a group key would read as switching it on again.
		this.groupTalkRelayed = message.state?.group_talk_active !== undefined
		if (!this.groupTalkRelayed) this.state.group_talk_active = groupTalk
	}

	talk(key: KeyConfig): boolean {
		return this.talkMap(this.state, key)[key.target_id] ?? false
	}

	listen(key: KeyConfig): boolean {
		return this.listenMap(this.state, key)[key.target_id] ?? false
	}

	active(key: KeyConfig, field: KeyField): boolean {
		return field === 'talk' ? this.talk(key) : this.listen(key)
	}

	/** Linear listen gain; unity when the server has not said otherwise. */
	level(key: KeyConfig): number {
		return this.levelMap(key)[key.target_id] ?? 1
	}

	levelDb(key: KeyConfig): number {
		return linearToDb(this.level(key))
	}

	setActive(key: KeyConfig, field: KeyField, active: boolean): void {
		const map = field === 'talk' ? this.talkMap(this.state, key) : this.listenMap(this.state, key)
		map[key.target_id] = active
	}

	setLevel(key: KeyConfig, level: number): void {
		this.levelMap(key)[key.target_id] = level
	}

	/**
	 * Whether the server holds this half latched on, as opposed to it merely
	 * being held down by somebody. Falls back to the effective state on servers
	 * that do not send the latched snapshot.
	 */
	isLatched(key: KeyConfig, field: KeyField): boolean {
		if (!this.latched) return this.active(key, field)
		if (key.target_type === 'group' && !this.groupTalkRelayed) return this.active(key, field)
		const map = field === 'talk' ? this.talkMap(this.latched, key) : this.listenMap(this.latched, key)
		return map[key.target_id] ?? false
	}

	private talkMap(snapshot: UserState, key: KeyConfig): Record<string, boolean> {
		if (isLine(key.target_type)) return snapshot.party_line_talk_active
		if (key.target_type === 'group') return snapshot.group_talk_active
		return snapshot.talk_active
	}

	private listenMap(snapshot: UserState, key: KeyConfig): Record<string, boolean> {
		if (isLine(key.target_type)) return snapshot.party_line_listen_active
		if (key.target_type === 'group') return this.groupListen
		return snapshot.listen_active
	}

	private levelMap(key: KeyConfig): Record<string, number> {
		if (isLine(key.target_type)) return this.state.party_line_listen_level
		if (key.target_type === 'group') return this.groupLevel
		return this.state.listen_level
	}
}
