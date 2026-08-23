/** Pure helpers for the device-side ListMain output contract. */

export const HELPER_ENTRY_CLASS = 'com.andrive.helper.ListMain'

/**
 * Parse ListMain stdout into renderer-shaped apps.
 * @param {string} text raw JSON line: {"apps":[{"packageName","label","iconPng"?}]}
 */
export function normalizeListOutput(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text).trim())
  } catch {
    throw new Error('Invalid helper output')
  }
  if (!parsed || !Array.isArray(parsed.apps)) throw new Error('Invalid helper output')
  return parsed.apps.map((/** @type {any} */ app) => ({
    packageName: typeof app?.packageName === 'string' ? app.packageName : '',
    label: typeof app?.label === 'string' && app.label ? app.label : '',
    iconUrl:
      typeof app?.iconPng === 'string' && app.iconPng
        ? `data:image/png;base64,${app.iconPng}`
        : null,
  }))
}
