import type { CompanionMigrationAction, CompanionStaticUpgradeScript } from '@companion-module/base'
import type { LiveMatrixConfig, LiveMatrixSecrets } from './config.js'

type Script = CompanionStaticUpgradeScript<LiveMatrixConfig, LiveMatrixSecrets>

function optionValue(action: CompanionMigrationAction, id: string): unknown {
	const option = action.options[id]
	return option && typeof option === 'object' && 'value' in option ? option.value : option
}

function setOption(action: CompanionMigrationAction, id: string, value: boolean): void {
	action.options[id] = { isExpression: false, value }
}

/**
 * Only a held key is selected now, and talking no longer selects.
 *
 * A talk press used to select its key and leave it selected. Now a combined
 * key, recognised by its release switching listen on a double tap, selects
 * while it is held, and a talk-only key never selects. A listen key's 'long
 * press selects' becomes 'holding selects', and the release no longer needs
 * telling: it always lets go of what its own button held.
 */
const selectOnlyWhileHeld: Script = (_context, props) => {
	const combinedKeyControls = new Set(
		props.actions
			.filter((action) => action.actionId === 'talk_up' && optionValue(action, 'double_tap_listen') !== false)
			.map((action) => action.controlId),
	)

	const updatedActions: CompanionMigrationAction[] = []
	for (const action of props.actions) {
		if (action.actionId === 'talk_down') {
			setOption(action, 'also_select', false)
			setOption(action, 'hold_selects', combinedKeyControls.has(action.controlId))
			updatedActions.push(action)
		} else if (action.actionId === 'listen_down') {
			setOption(action, 'hold_selects', optionValue(action, 'long_press_selects') === true)
			delete action.options.long_press_selects
			updatedActions.push(action)
		} else if (action.actionId === 'listen_up' && 'long_press_selects' in action.options) {
			delete action.options.long_press_selects
			updatedActions.push(action)
		}
	}

	return { updatedConfig: null, updatedActions, updatedFeedbacks: [] }
}

export const UpgradeScripts: Script[] = [selectOnlyWhileHeld]
