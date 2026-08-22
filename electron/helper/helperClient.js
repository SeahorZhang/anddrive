import http from 'node:http'

// Helper HTTP 传输层：超时、重试、JSON/buffer 解析。不感知 helper 业务端点。

/**
 * @param {string} url
 * @param {{ retries?: number, timeout?: number, parse?: 'json'|'buffer' }} options
 * @returns {Promise<any>}
 */
export function request(url, { retries = 0, timeout = 10000, parse = 'json' } = {}) {
  return new Promise((resolve, reject) => {
    /**
     * @param {number} remaining
     */
    const attempt = (remaining) => {
      const req = http.get(url, (res) => {
        if (parse === 'buffer') {
          if (res.statusCode !== 200) {
            res.resume()
            resolve(null)
            return
          }
          /** @type {Buffer[]} */
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => resolve(Buffer.concat(chunks)))
          return
        }

        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (/** @type {any} */ e) {
            if (remaining > 0) {
              setTimeout(() => attempt(remaining - 1), 300)
            } else {
              reject(new Error('Failed to parse response: ' + e.message))
            }
          }
        })
      })

      req.on('error', (err) => {
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 300)
        } else {
          reject(err)
        }
      })

      req.setTimeout(timeout, () => {
        req.destroy()
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 300)
        } else {
          reject(new Error('Request timeout'))
        }
      })
    }
    attempt(retries)
  })
}

/**
 * GET 并解析 JSON，失败时自动重试。
 * @param {string} url
 * @param {number} [retries]
 */
export function getJson(url, retries = 1) {
  return request(url, { retries })
}

/** @param {string} url */
export function getBuffer(url) {
  return request(url, { parse: 'buffer', timeout: 5000 })
}
