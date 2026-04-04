import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { LiveMatrixConfig } from './index.js'

type LiveMatrixSecrets = {
	password?: string
}

export const upgradeScripts: CompanionStaticUpgradeScript<LiveMatrixConfig, LiveMatrixSecrets>[] = []
