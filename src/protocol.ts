/**
 * The LiveMatrix wire protocol, as far as this module speaks it. The same
 * messages travel over the server's `/ws` endpoint and over a client app's
 * local control API; only the server asks for a login first.
 */

export type TargetType = 'user' | 'party_line' | 'feed' | 'group'
export type KeyField = 'talk' | 'listen'
export type Hold = 'latched' | 'momentary'

export type Message = Record<string, unknown>

export interface KeyRef {
	target_type: string
	target_id: string
}

export interface KeyConfig {
	id: string
	target_type: TargetType | string
	target_id: string
	display_name: string
	can_listen: boolean
	can_talk: boolean
	allow_listen_latching: boolean
	allow_talk_latching: boolean
	default_listen_active?: boolean
	default_talk_active?: boolean
}

export interface UserInfo {
	id: string
	display_name: string
	is_connected: boolean
}

/**
 * Per-key state, bucketed by what the key points at. Party lines and feeds are
 * both lines and share the `party_line_*` maps; groups only ever talk.
 */
export interface UserState {
	talk_active: Record<string, boolean>
	listen_active: Record<string, boolean>
	listen_level: Record<string, number>
	party_line_talk_active: Record<string, boolean>
	party_line_listen_active: Record<string, boolean>
	party_line_listen_level: Record<string, number>
	group_talk_active: Record<string, boolean>
}

export interface MomentaryHold {
	key: KeyRef
	talk: boolean
	listen: boolean
}

export interface LoginSuccessMessage {
	type: 'login_success'
	user_id: string
	display_name: string
	device_id: string
	keys: KeyConfig[]
	available_users: UserInfo[]
	/** How often a held key has to be restated, and how long it survives without that. */
	momentary_heartbeat_interval_ms?: number
	momentary_timeout_ms?: number
}

export interface LoginFailureMessage {
	type: 'login_failure'
	reason: string
	/** A genuine credential rejection. Anything else is worth retrying. */
	fatal?: boolean
	/** Machine-readable cause, such as `license_full`. */
	code?: string
}

/**
 * The server ended the session on purpose (a trial or licence limit). It must
 * not be retried automatically: a person has to decide to log in again.
 */
export interface SessionEndedMessage {
	type: 'session_ended'
	reason: string
	message: string
}

export interface StateUpdateMessage {
	type: 'state_update'
	/** What audio is actually doing: latched or held. */
	state: UserState
	/** The same snapshot with every held press removed. */
	latched?: UserState
}

export interface KeysChangedMessage {
	type: 'keys_changed'
	keys: KeyConfig[]
}

export interface UserConnectedMessage {
	type: 'user_connected'
	user_id: string
	display_name: string
}

export interface UserDisconnectedMessage {
	type: 'user_disconnected'
	user_id: string
}

export interface ErrorMessage {
	type: 'error'
	message: string
	/** Machine-readable reason, when the server gives one. */
	code?: string
}

/**
 * The user's one microphone, as the server sees it: which device holds it,
 * whether it is muted, and whether audio is actually going out. Companion
 * never holds the mic itself; it only mutes and unmutes whichever device does.
 */
export interface MicState {
	/** The device holding the mic, or null when nobody does. */
	device_id: string | null
	device_name: string | null
	holder_online: boolean
	muted: boolean
	/** Unmuted, or muted with a talk key held through the mute. */
	open: boolean
}

export interface MicStateMessage {
	type: 'mic_state'
	device_id?: string | null
	device_name?: string | null
	holder_online?: boolean
	muted?: boolean
	/** Absent from servers older than talk-through-mute; then it is `!muted`. */
	open?: boolean
	is_mine?: boolean
}

export function createEmptyState(): UserState {
	return {
		talk_active: {},
		listen_active: {},
		listen_level: {},
		party_line_talk_active: {},
		party_line_listen_active: {},
		party_line_listen_level: {},
		group_talk_active: {},
	}
}

/** Copy a snapshot off the wire, filling in any map an older peer leaves out. */
export function readUserState(raw: Partial<UserState> | undefined): UserState {
	return {
		talk_active: { ...raw?.talk_active },
		listen_active: { ...raw?.listen_active },
		listen_level: { ...raw?.listen_level },
		party_line_talk_active: { ...raw?.party_line_talk_active },
		party_line_listen_active: { ...raw?.party_line_listen_active },
		party_line_listen_level: { ...raw?.party_line_listen_level },
		group_talk_active: { ...raw?.group_talk_active },
	}
}

export function createEmptyMicState(): MicState {
	return {
		device_id: null,
		device_name: null,
		holder_online: false,
		muted: false,
		open: false,
	}
}

export function readMicState(message: MicStateMessage): MicState {
	const muted = message.muted ?? false
	return {
		device_id: message.device_id ?? null,
		device_name: message.device_name ?? null,
		holder_online: message.holder_online ?? false,
		muted,
		open: message.open ?? !muted,
	}
}

/** Party lines and feeds are both lines: one id names one line, whichever kind a key calls it. */
export function isLine(targetType: string): boolean {
	return targetType === 'party_line' || targetType === 'feed'
}

export function keyRef(key: KeyConfig): KeyRef {
	return { target_type: key.target_type, target_id: key.target_id }
}

/** How a key is named in option values and selection: unique across target types. */
export function keyTargetToken(key: KeyConfig): string {
	return `${key.target_type}:${key.target_id}`
}
