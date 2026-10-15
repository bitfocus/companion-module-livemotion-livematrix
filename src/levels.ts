export const MIN_LISTEN_LEVEL_DB = -100
/** The quietest level worth showing on a meter; -100 dB is silence and wastes the scale. */
export const MIN_LISTEN_LEVEL_DB_DISPLAY = -40
export const MAX_LISTEN_LEVEL_DB = 10
/** One detent of a rotary encoder. */
export const LEVEL_STEP_DB = 1

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value))
}

export function linearToDb(level: number): number {
	if (level <= 0) return MIN_LISTEN_LEVEL_DB
	return 20 * Math.log10(level)
}

export function dbToLinear(levelDb: number): number {
	if (levelDb <= MIN_LISTEN_LEVEL_DB) return 0
	return 10 ** (levelDb / 20)
}

export function clampListenLevelLinear(level: number): number {
	return clamp(level, 0, dbToLinear(MAX_LISTEN_LEVEL_DB))
}

export function formatListenLevelDb(levelDb: number): string {
	if (levelDb <= MIN_LISTEN_LEVEL_DB) return `${MIN_LISTEN_LEVEL_DB}`
	return levelDb.toFixed(1)
}

export function sanitizeName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'unnamed'
	)
}
