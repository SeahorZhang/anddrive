import dgram from 'node:dgram'

// ---------------------------------------------------------------------------
// Minimal mDNS (RFC 6762) / DNS-SD (RFC 6763) browser
//
// Only what AndDrive needs: send a PTR query for one service type over
// multicast, accumulate the PTR/SRV/TXT/A records the responder sends back and
// surface the first fully-resolved instance. No publishing, no IPv6, no cache.
// ---------------------------------------------------------------------------

const MDNS_ADDRESS = '224.0.0.251'
const MDNS_PORT = 5353
const QUERY_INTERVAL_MS = 1000
const NAME_POINTER = 0xc0
const MAX_POINTER_HOPS = 32

const TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  SRV: 33,
}

const CLASS_IN = 1

// ---------------------------------------------------------------------------
// DNS wire format
// ---------------------------------------------------------------------------

/**
 * Encode a dotted domain name as length-prefixed labels.
 * @param {string} name
 * @returns {Buffer}
 */
export function encodeName(name) {
  const chunks = []
  for (const label of String(name).split('.').filter(Boolean)) {
    const bytes = Buffer.from(label, 'utf8')
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`Invalid DNS label: ${label}`)
    chunks.push(Buffer.from([bytes.length]), bytes)
  }
  chunks.push(Buffer.from([0]))
  return Buffer.concat(chunks)
}

/**
 * Read a domain name, following compression pointers.
 * @param {Buffer} buffer
 * @param {number} start
 * @returns {{ name: string, offset: number }} offset is the position after the
 *   name in the linear stream (not the jump target).
 */
function readName(buffer, start) {
  const labels = []
  let offset = start
  let next = start
  let jumped = false
  let hops = 0
  while (offset < buffer.length) {
    const length = buffer[offset]
    if (length === 0) {
      offset += 1
      if (!jumped) next = offset
      break
    }
    if ((length & NAME_POINTER) === NAME_POINTER) {
      if (offset + 1 >= buffer.length) throw new Error('Truncated DNS name pointer')
      if (!jumped) next = offset + 2
      offset = ((length & 0x3f) << 8) | buffer[offset + 1]
      jumped = true
      if (++hops > MAX_POINTER_HOPS) throw new Error('DNS name pointer loop')
      continue
    }
    offset += 1
    if (offset + length > buffer.length) throw new Error('Truncated DNS name')
    labels.push(buffer.toString('utf8', offset, offset + length))
    offset += length
    if (!jumped) next = offset
  }
  return { name: labels.join('.'), offset: next }
}

/**
 * Build a standard mDNS query for one name/type.
 * @param {string} name
 * @param {number} type
 * @returns {Buffer}
 */
export function buildQuery(name, type = TYPE.PTR) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0) // transaction id must be 0 for multicast queries
  header.writeUInt16BE(0, 2) // flags: standard query
  header.writeUInt16BE(1, 4) // one question
  const question = Buffer.concat([
    encodeName(name),
    Buffer.from([type >> 8, type & 0xff, 0, CLASS_IN]),
  ])
  return Buffer.concat([header, question])
}

/**
 * @param {Buffer} buffer
 * @param {number} type
 * @param {number} start
 * @param {number} end
 */
function readRdata(buffer, type, start, end) {
  switch (type) {
    case TYPE.PTR:
      return readName(buffer, start).name
    case TYPE.SRV:
      return {
        priority: buffer.readUInt16BE(start),
        weight: buffer.readUInt16BE(start + 2),
        port: buffer.readUInt16BE(start + 4),
        target: readName(buffer, start + 6).name,
      }
    case TYPE.TXT: {
      /** @type {Record<string, string | boolean>} */
      const txt = {}
      let offset = start
      while (offset < end) {
        const length = buffer[offset]
        offset += 1
        if (length === 0) continue
        const entry = buffer.toString('utf8', offset, offset + length)
        offset += length
        const separator = entry.indexOf('=')
        txt[separator === -1 ? entry : entry.slice(0, separator)] =
          separator === -1 ? true : entry.slice(separator + 1)
      }
      return txt
    }
    case TYPE.A:
      return end - start === 4 ? Array.from(buffer.subarray(start, end)).join('.') : null
    default:
      return null
  }
}

/**
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} count
 */
function readRecords(buffer, start, count) {
  const records = []
  let offset = start
  for (let i = 0; i < count; i++) {
    if (offset + 10 > buffer.length) throw new Error('Truncated DNS record')
    const { name, offset: afterName } = readName(buffer, offset)
    offset = afterName
    const type = buffer.readUInt16BE(offset)
    const klass = buffer.readUInt16BE(offset + 2)
    const ttl = buffer.readUInt32BE(offset + 4)
    const rdlength = buffer.readUInt16BE(offset + 8)
    const rdataStart = offset + 10
    const rdataEnd = rdataStart + rdlength
    if (rdataEnd > buffer.length) throw new Error('Truncated DNS record data')
    records.push({
      name,
      type,
      class: klass & 0x7fff,
      ttl,
      data: readRdata(buffer, type, rdataStart, rdataEnd),
    })
    offset = rdataEnd
  }
  return { records, offset }
}

/**
 * Parse a DNS message into its sections.
 * @param {Buffer} buffer
 */
export function parseMessage(buffer) {
  if (buffer.length < 12) throw new Error('DNS message too short')
  const counts = {
    questions: buffer.readUInt16BE(4),
    answers: buffer.readUInt16BE(6),
    authorities: buffer.readUInt16BE(8),
    additionals: buffer.readUInt16BE(10),
  }
  let offset = 12
  const questions = []
  for (let i = 0; i < counts.questions; i++) {
    const { name, offset: afterName } = readName(buffer, offset)
    if (afterName + 4 > buffer.length) throw new Error('Truncated DNS question')
    questions.push({
      name,
      type: buffer.readUInt16BE(afterName),
      class: buffer.readUInt16BE(afterName + 2) & 0x7fff,
    })
    offset = afterName + 4
  }
  const answers = readRecords(buffer, offset, counts.answers)
  const authorities = readRecords(buffer, answers.offset, counts.authorities)
  const additionals = readRecords(buffer, authorities.offset, counts.additionals)
  return {
    questions,
    answers: answers.records,
    authorities: authorities.records,
    additionals: additionals.records,
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MdnsService
 * @property {string} name
 * @property {string} type
 * @property {string} host
 * @property {number} port
 * @property {string[]} addresses
 * @property {Record<string, string | boolean>} txt
 */

/** One running browse session; call `stop()` to release the socket. */
export class MdnsBrowser {
  /**
   * @param {string} type service type without underscores, e.g. `adb-tls-connect`
   * @param {(service: MdnsService) => void} onService
   */
  constructor(type, onService) {
    this.type = type
    this.serviceType = `_${type}._tcp.local`
    this.onService = onService
    this.socket = null
    this.timer = null
    this.stopped = false
    /** @type {Map<string, { name: string, txt: Record<string, string | boolean>, port: number | null, target: string | null }>} */
    this.instances = new Map()
    /** @type {Map<string, Set<string>>} */
    this.hosts = new Map()
    this.emitted = new Set()
  }

  start() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', () => this.stop())
    socket.on('message', (message) => this.handleMessage(message))
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDRESS)
        socket.setMulticastTTL(255)
      } catch {
        // Membership failures are non-fatal: unicast responses still arrive.
      }
      this.query()
      this.timer = setInterval(() => this.query(), QUERY_INTERVAL_MS)
    })
    return this
  }

  query() {
    if (this.stopped || !this.socket) return
    const packet = buildQuery(this.serviceType)
    this.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDRESS, () => {})
  }

  /** @param {Buffer} message */
  handleMessage(message) {
    if (this.stopped) return
    let parsed
    try {
      parsed = parseMessage(message)
    } catch {
      return
    }
    let changed = false
    for (const record of [...parsed.answers, ...parsed.authorities, ...parsed.additionals]) {
      changed = this.addRecord(record) || changed
    }
    if (changed) this.resolve()
  }

  /** @param {{ name: string, type: number, data: any }} record */
  addRecord(record) {
    const name = record.name.toLowerCase()
    if (record.type === TYPE.PTR && name === this.serviceType) {
      if (!this.instances.has(String(record.data).toLowerCase())) {
        this.instances.set(String(record.data).toLowerCase(), {
          name: record.data,
          txt: {},
          port: null,
          target: null,
        })
        return true
      }
      return false
    }
    if (record.type === TYPE.SRV) {
      const instance = this.instances.get(name)
      if (!instance) return false
      instance.port = record.data.port
      instance.target = record.data.target
      return true
    }
    if (record.type === TYPE.TXT) {
      const instance = this.instances.get(name)
      if (!instance) return false
      instance.txt = { ...record.data, ...instance.txt }
      return true
    }
    if (record.type === TYPE.A) {
      let addresses = this.hosts.get(name)
      if (!addresses) {
        addresses = new Set()
        this.hosts.set(name, addresses)
      }
      if (addresses.has(record.data)) return false
      addresses.add(record.data)
      return true
    }
    return false
  }

  resolve() {
    for (const [key, instance] of this.instances) {
      if (this.emitted.has(key) || instance.port === null || !instance.target) continue
      const addresses = this.hosts.get(instance.target.toLowerCase())
      if (!addresses || addresses.size === 0) continue
      this.emitted.add(key)
      this.onService?.({
        name: instance.name,
        type: this.type,
        host: instance.target,
        port: instance.port,
        addresses: [...addresses],
        txt: instance.txt,
      })
    }
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const socket = this.socket
    this.socket = null
    if (!socket) return
    try {
      socket.dropMembership(MDNS_ADDRESS)
    } catch {
      // Not joined or already closed.
    }
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }
}

/**
 * Start browsing for a service type.
 * @param {string} type
 * @param {(service: MdnsService) => void} onService
 * @returns {MdnsBrowser}
 */
export function browse(type, onService) {
  return new MdnsBrowser(type, onService).start()
}
