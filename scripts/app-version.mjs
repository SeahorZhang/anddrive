import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))

/** Build channel: set `APP_CHANNEL=beta` for a side-by-side Beta build. */
export const appChannel = process.env.APP_CHANNEL === 'beta' ? 'beta' : 'stable'

function betaTag() {
  if (process.env.BETA_TAG) return process.env.BETA_TAG
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
  ].join('')
}

/** Full app version, e.g. `0.0.4` (stable) or `0.0.4-beta.202609121430` (beta). */
export const appVersion = appChannel === 'beta' ? `${version}-beta.${betaTag()}` : version
