import { combineRgb } from '@companion-module/base'

/**
 * The livematrix client app's palette (`BrandColors` in the client), so a key on
 * a Companion surface looks like the same key in the app. The app is dark only
 * and flat: no gradients, no glow, colour only where something is on.
 */

function hex(value: string): number {
	const n = parseInt(value.replace('#', ''), 16)
	return combineRgb((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
}

/**
 * A colour laid at some opacity over another, worked out here rather than left
 * to the renderer: the app draws its states as translucent fills over the card,
 * and a solid colour comes out the same on every surface.
 */
export function blend(color: number, alpha: number, over: number): number {
	const mix = (shift: number) => Math.round(((color >> shift) & 0xff) * alpha + ((over >> shift) & 0xff) * (1 - alpha))
	return combineRgb(mix(16), mix(8), mix(0))
}

/** The card a key sits on. */
export const SURFACE = hex('#2C2C2C')
/** A talk or listen half at rest. */
export const FILL = hex('#2A2A2A')
/** Hairlines, and the empty part of a level rail. */
export const LINE = hex('#3A3A3A')
/** Borders next to a filled control, such as the mic at rest. */
export const LINE_STRONG = hex('#4A4A4A')

export const TEXT = hex('#E5E5E5')
export const TEXT_MUTED = hex('#A3A3A3')
export const TEXT_FAINT = hex('#999999')
export const TEXT_DISABLED = hex('#5A5A5A')

/** Ice blue: selected, and the listen level. */
export const ACCENT = hex('#3B9EFF')
/** Accent for text, such as a level readout. */
export const ACCENT_HIGH = hex('#8CC6FF')

export const TALK = hex('#E5484D')
export const LISTEN = hex('#3DD68C')
/** Amber: the mic is muted. */
export const WARN = hex('#FFB020')
/**
 * Amber too, for incoming intent: someone listening to us, or audio arriving.
 * Which half the stripe sits on says which one it means.
 */
export const INCOMING = hex('#FFB300')

/** A half that is on: its colour at 45% over the card. Held and latched fill the same. */
export const TALK_ON = blend(TALK, 0.45, SURFACE)
export const LISTEN_ON = blend(LISTEN, 0.45, SURFACE)

/**
 * A key name: pure white, brighter than the app's text, as a button is read
 * from further away than a screen. Half strength while nobody is there to hear it.
 */
export const NAME = hex('#FFFFFF')
export const NAME_OFFLINE = blend(NAME, 0.5, FILL)

/** A muted mic: amber at 20% over the card, inside an amber border. */
export const MIC_MUTED_FILL = blend(WARN, 0.2, SURFACE)

/**
 * A half at rest, framed in a light tint of its colour. The app needs no frame,
 * as a half's place on the key card says what it is; a button seen from across
 * a desk does. Lighter and thinner than the latch ring, so the ring still reads.
 */
export const TALK_REST = blend(TALK, 0.7, TEXT)
export const LISTEN_REST = blend(LISTEN, 0.7, TEXT)

/**
 * The listen stripe once audio stops: amber pulled a quarter of the way to
 * muted grey, at 40% over a half at rest, so "audio recently" never reads as
 * "audio now".
 */
export const INCOMING_TRAIL = blend(blend(INCOMING, 0.75, TEXT_MUTED), 0.4, FILL)
