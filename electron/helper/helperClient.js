import http from 'node:http'

/**
 * @param {string} url
 * @param {{ retries?: number, timeout?: number, parse?: 'json' | 'buffer' }} [options]
 */
export function httpRequest(url, { retries = 0, timeout = 10000, parse = 'json' } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const req = http.get(url, (res) => {
        if (parse === 'buffer') {
          if (res.statusCode !== 200) {
            res.resume()
            resolve(null)
            return
          }
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
          } catch (e) {
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

/** @param {string} url @param {number} [retries] */
export const httpGetJSON = (url, retries = 1) => httpRequest(url, { retries })

/** @param {string} url */
export const httpGetBuffer = (url) => httpRequest(url, { parse: 'buffer', timeout: 5000 })
