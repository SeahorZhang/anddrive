import { describe, expect, it } from 'vitest'
import { MdnsBrowser, buildQuery, encodeName, parseMessage } from '../../electron/mdns.js'

const SERVICE = '_adb-tls-connect._tcp.local'
const INSTANCE = 'adb-ABC123._adb-tls-connect._tcp.local'
const HOST = 'Android.local'

/** @param {string} name */
function record(name, type, rdata, { klass = 1, ttl = 120 } = {}) {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(klass, 2)
  header.writeUInt32BE(ttl, 4)
  header.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([encodeName(name), header, rdata])
}

/** @param {Buffer[]} records @param {Buffer[]} additionals */
function message(records, additionals = []) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(records.length, 6)
  header.writeUInt16BE(additionals.length, 10)
  return Buffer.concat([header, ...records, ...additionals])
}

function srv(port, target) {
  const fixed = Buffer.alloc(6)
  fixed.writeUInt16BE(0, 0)
  fixed.writeUInt16BE(0, 2)
  fixed.writeUInt16BE(port, 4)
  return Buffer.concat([fixed, encodeName(target)])
}

function txt(entries) {
  return Buffer.concat(
    entries.map((entry) => {
      const data = Buffer.from(entry, 'utf8')
      return Buffer.concat([Buffer.from([data.length]), data])
    }),
  )
}

/** A complete mDNS response for one device, as Android's responder emits it. */
function deviceResponse() {
  return message(
    [record(SERVICE, 12, encodeName(INSTANCE))],
    [
      record(INSTANCE, 33, srv(37_099, HOST)),
      record(INSTANCE, 16, txt(['name=Pixel 8', 'serial=ABC123'])),
      record(HOST, 1, Buffer.from([192, 168, 1, 5])),
    ],
  )
}

describe('mdns wire format', () => {
  it('encodes dotted names as length-prefixed labels', () => {
    expect([...encodeName('a.bc')]).toEqual([1, 0x61, 2, 0x62, 0x63, 0])
  })

  it('builds a PTR query with a zero id and one question', () => {
    const query = buildQuery(SERVICE)
    expect(query.readUInt16BE(0)).toBe(0)
    expect(query.readUInt16BE(4)).toBe(1)
    const parsed = parseMessage(query)
    expect(parsed.questions).toEqual([{ name: SERVICE, type: 12, class: 1 }])
  })

  it('parses PTR, SRV, TXT and A records', () => {
    const parsed = parseMessage(deviceResponse())
    expect(parsed.answers).toHaveLength(1)
    expect(parsed.answers[0].data).toBe(INSTANCE)

    const srvRecord = parsed.additionals.find((r) => r.type === 33)
    expect(srvRecord.data.port).toBe(37_099)
    expect(srvRecord.data.target).toBe(HOST)

    const txtRecord = parsed.additionals.find((r) => r.type === 16)
    expect(txtRecord.data).toEqual({ name: 'Pixel 8', serial: 'ABC123' })

    const aRecord = parsed.additionals.find((r) => r.type === 1)
    expect(aRecord.data).toBe('192.168.1.5')
  })

  it('follows compression pointers', () => {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(1, 6)
    const question = Buffer.concat([encodeName(SERVICE), Buffer.from([0, 12, 0, 1])])
    const rdata = encodeName(INSTANCE)
    const answerHeader = Buffer.alloc(10)
    answerHeader.writeUInt16BE(12, 0)
    answerHeader.writeUInt16BE(1, 2)
    answerHeader.writeUInt32BE(120, 4)
    answerHeader.writeUInt16BE(rdata.length, 8)
    // Answer name is a pointer (0xc0 0x0c) back to the question name at offset 12.
    const answer = Buffer.concat([Buffer.from([0xc0, 12]), answerHeader, rdata])

    const parsed = parseMessage(Buffer.concat([header, question, answer]))
    expect(parsed.answers[0].name).toBe(SERVICE)
    expect(parsed.answers[0].data).toBe(INSTANCE)
  })
})

describe('MdnsBrowser', () => {
  it('surfaces a fully resolved service', () => {
    const found = []
    const browser = new MdnsBrowser('adb-tls-connect', (service) => found.push(service))
    browser.handleMessage(deviceResponse())
    expect(found).toEqual([
      {
        name: INSTANCE,
        type: 'adb-tls-connect',
        host: HOST,
        port: 37_099,
        addresses: ['192.168.1.5'],
        txt: { name: 'Pixel 8', serial: 'ABC123' },
      },
    ])
  })

  it('waits for the address record before emitting', () => {
    const found = []
    const browser = new MdnsBrowser('adb-tls-connect', (service) => found.push(service))
    const withoutAddress = message([
      record(SERVICE, 12, encodeName(INSTANCE)),
      record(INSTANCE, 33, srv(37_099, HOST)),
    ])
    browser.handleMessage(withoutAddress)
    expect(found).toHaveLength(0)

    browser.handleMessage(message([record(HOST, 1, Buffer.from([192, 168, 1, 5]))]))
    expect(found).toHaveLength(1)
    expect(found[0].addresses).toEqual(['192.168.1.5'])
  })

  it('ignores unrelated service types', () => {
    const found = []
    const browser = new MdnsBrowser('adb-tls-pairing', (service) => found.push(service))
    browser.handleMessage(deviceResponse())
    expect(found).toHaveLength(0)
  })
})
