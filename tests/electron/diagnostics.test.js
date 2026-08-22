import { describe, expect, it } from 'vitest'
import { parseFirewallEnabled, parseMdnsCheckOk } from '../../electron/diagnostics.js'

describe('parseFirewallEnabled', () => {
  it('detects enabled and disabled states', () => {
    expect(parseFirewallEnabled('Firewall is disabled. (State = 0)')).toBe(false)
    expect(parseFirewallEnabled('Firewall is enabled. (State = 1)')).toBe(true)
  })

  it('returns null for unrecognizable output', () => {
    expect(parseFirewallEnabled('')).toBeNull()
    expect(parseFirewallEnabled('garbage')).toBeNull()
  })
})

describe('parseMdnsCheckOk', () => {
  it('recognizes a working mdns daemon', () => {
    expect(parseMdnsCheckOk('mdns daemon version [adb discovery 0.0.0]')).toBe(true)
  })

  it('rejects unsupported output', () => {
    expect(parseMdnsCheckOk('ERROR: mdns daemon not supported')).toBe(false)
    expect(parseMdnsCheckOk('')).toBe(false)
  })
})
