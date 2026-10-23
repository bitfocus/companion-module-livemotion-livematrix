import { isLine, type ActivityUpdateMessage, type GroupInfo, type KeyConfig } from './protocol.js'

/** How long the listen stripe trails once audio stops, as in the app. */
export const AUDIO_TRAIL_MS = 60_000

/**
 * What everyone else is doing towards this user, as the app's key cards show
 * it: an amber stripe on the talk half while someone the key reaches is
 * listening to us, and on the listen half while their audio is arriving, then
 * dimmer for a minute after it stops.
 *
 * Audio is tracked by source, a user or a line, rather than by key, so a key
 * added mid-session still knows what it last heard.
 */
export class ActivityStore {
	private listeningToMe = new Set<string>()
	private audible = new Set<string>()
	/** Source -> when its audio stopped, for sources still trailing. */
	private stoppedAt = new Map<string, number>()
	/** Group id -> its members, as `login_success` lists them. */
	private groups = new Map<string, string[]>()

	setGroups(groups: GroupInfo[]): void {
		this.groups = new Map(groups.map((group) => [group.id, group.member_ids ?? []]))
	}

	apply(message: ActivityUpdateMessage, now: number): void {
		const audible = new Set([
			...(message.audible_users ?? []).map(userSource),
			...(message.audible_party_lines ?? []).map(lineSource),
		])
		for (const source of this.audible) {
			if (!audible.has(source)) this.stoppedAt.set(source, now)
		}
		for (const source of audible) this.stoppedAt.delete(source)
		this.audible = audible
		this.listeningToMe = new Set((message.listening_to_me ?? []).map((peer) => peer.user_id))
	}

	/** Forget everything: nobody can be heard over a connection that is gone. */
	clear(): void {
		this.listeningToMe.clear()
		this.audible.clear()
		this.stoppedAt.clear()
	}

	/** Someone this key reaches is listening to us: the talk half's stripe. */
	isListeningToMe(key: KeyConfig): boolean {
		return this.peersOf(key).some((userId) => this.listeningToMe.has(userId))
	}

	/** Audio from what this key points at is reaching us now: the listen half's stripe. */
	isAudioArriving(key: KeyConfig): boolean {
		return key.can_listen && this.sourcesOf(key).some((source) => this.audible.has(source))
	}

	/** Audio stopped within the last minute, and has not started again: the stripe's trail. */
	isAudioTrailing(key: KeyConfig, now: number): boolean {
		if (!key.can_listen || this.isAudioArriving(key)) return false
		return this.sourcesOf(key).some((source) => {
			const stopped = this.stoppedAt.get(source)
			return stopped !== undefined && now - stopped < AUDIO_TRAIL_MS
		})
	}

	/** When the next trail runs out, dropping any that already have; undefined when none is left. */
	nextTrailExpiry(now: number): number | undefined {
		let next: number | undefined
		for (const [source, stopped] of this.stoppedAt) {
			const expiry = stopped + AUDIO_TRAIL_MS
			if (expiry <= now) this.stoppedAt.delete(source)
			else if (next === undefined || expiry < next) next = expiry
		}
		return next
	}

	/**
	 * Who a key stands for on the other side: one person for a user key, the
	 * members for a group key. The server reports members, never the group.
	 */
	private peersOf(key: KeyConfig): string[] {
		if (key.target_type === 'user') return [key.target_id]
		if (key.target_type === 'group') return this.groups.get(key.target_id) ?? []
		return []
	}

	private sourcesOf(key: KeyConfig): string[] {
		if (isLine(key.target_type)) return [lineSource(key.target_id)]
		return this.peersOf(key).map(userSource)
	}
}

function userSource(userId: string): string {
	return `user:${userId}`
}

function lineSource(lineId: string): string {
	return `line:${lineId}`
}
