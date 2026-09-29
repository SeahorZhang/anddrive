import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', on: () => {} },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}))
import { createReadStream, createWriteStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import {
  cp,
  mkdir,
  mkdtemp as mkdtempP,
  readdir,
  rename,
  rm as rmP,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const { createDeviceDavServer, isMacMetadataName, resolveDestination } = await import(
  '../../electron/webdav.js'
)

/**
 * 用本机临时目录当"设备"：协议层只认 adapter 接口，所以这些断言测的是真的
 * HTTP 往返，不需要真插手机。
 */
function localAdapter(rootDir, { readOnly = false, displayName } = {}) {
  const fs = (devicePath) => join(rootDir, devicePath.replace(/^\/+/, ''))
  const entryFor = async (devicePath) => {
    try {
      const info = await stat(fs(devicePath))
      return {
        path: devicePath,
        name: devicePath.slice(devicePath.lastIndexOf('/') + 1) || '/',
        dir: info.isDirectory(),
        size: info.size,
        mtimeMs: Math.floor(info.mtimeMs / 1000) * 1000,
      }
    } catch {
      return null
    }
  }
  return {
    root: '/',
    displayName,
    readOnly,
    stat: entryFor,
    async list(devicePath) {
      const names = await readdir(fs(devicePath)).catch(() => [])
      const entries = []
      for (const name of names) entries.push(await entryFor(`${devicePath === '/' ? '' : devicePath}/${name}`))
      return entries.filter(Boolean)
    },
    open: async (devicePath) => ({ stream: createReadStream(fs(devicePath)), close: () => {} }),
    write: (devicePath, stream) => pipeline(stream, createWriteStream(fs(devicePath))),
    mkdir: (devicePath) => mkdir(fs(devicePath)),
    remove: (devicePath) => rmP(fs(devicePath), { recursive: true, force: true }),
    async move(from, to) {
      await rmP(fs(to), { force: true, recursive: true })
      await rename(fs(from), fs(to))
    },
    copy: (from, to) => cp(fs(from), fs(to), { recursive: true }),
  }
}

describe('webdav 写语义', () => {
  let server
  let base
  let rootDir
  const token = 'tok'

  beforeAll(async () => {
    rootDir = await mkdtempP(join(tmpdir(), 'anddrive-dav-test-'))
    server = await createDeviceDavServer((given) =>
      given === token ? localAdapter(rootDir, { displayName: '测试卷' }) : null,
    )
    base = `http://127.0.0.1:${server.port}/${token}`
  })

  afterAll(async () => {
    await server.close()
    await rmP(rootDir, { recursive: true, force: true })
  })

  const request = (path, init = {}) => fetch(`${base}${path}`, init)

  /** 原样发路径（不做 URL 归一），用来测服务端的越界判定。 */
  const rawRequest = (port, path, method) =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end('x')
    })

  it('PUT 落盘，GET 读回同样的字节', async () => {
    const body = Buffer.from([0, 1, 2, 250, 255, 10, 13])
    const put = await request('/notes.bin', { method: 'PUT', body })
    expect(put.status).toBe(201)
    const got = await request('/notes.bin')
    expect(Buffer.from(await got.arrayBuffer()).equals(body)).toBe(true)
  })

  it('MKCOL 建目录，PROPFIND Depth 1 能列出来', async () => {
    expect((await request('/album', { method: 'MKCOL' })).status).toBe(201)
    const xml = await (await request('/', { method: 'PROPFIND', headers: { depth: '1' } })).text()
    expect(xml).toContain('<D:displayname>测试卷</D:displayname>')
    expect(xml).toContain('album')
  })

  it('MOVE 改名、COPY 复制', async () => {
    await writeFile(join(rootDir, 'a.txt'), 'hello')
    const moved = await request('/a.txt', {
      method: 'MOVE',
      headers: { destination: `${base}/b.txt` },
    })
    expect(moved.status).toBe(201)
    const readdir1 = await readdir(rootDir)
    expect(readdir1).toContain('b.txt')
    expect(readdir1).not.toContain('a.txt')

    const copied = await request('/b.txt', {
      method: 'COPY',
      headers: { destination: `${base}/c.txt` },
    })
    expect(copied.status).toBe(201)
    expect((await readdir(rootDir)).filter((name) => name.endsWith('.txt')).sort()).toEqual(['b.txt', 'c.txt'])
  })

  it('DELETE 删得掉文件，但删不掉挂载根', async () => {
    expect((await request('/c.txt', { method: 'DELETE' })).status).toBe(204)
    expect(await readdir(rootDir)).not.toContain('c.txt')

    const rootDelete = await request('/', { method: 'DELETE' })
    expect(rootDelete.status).toBe(403)
    expect(await readdir(rootDir)).toContain('b.txt')
  })

  it('想逃出挂载根的写入既落不了地、也建不出文件', async () => {
    // 断言"结果"而不是状态码：WHATWG URL 连 `%2e%2e` 都当点点段归一，所以请求可能根本
    // 到不了路径判定（变成 404）。归一与 resolveDevicePath 两层任一生效都算安全。
    for (const path of ['/tok/../escape.txt', '/tok/%2e%2e/escape.txt']) {
      const status = await rawRequest(server.port, path, 'PUT')
      expect([200, 201, 204]).not.toContain(status)
    }
    expect(await readdir(rootDir)).not.toContain('escape.txt')
    expect(await readdir(rootDir)).toContain('b.txt')
  })

  it('访达自造的 .DS_Store / ._xxx 吞掉，不落到设备上', async () => {
    expect((await request('/.DS_Store', { method: 'PUT', body: 'junk' })).status).toBe(201)
    expect((await request('/._b.txt', { method: 'PUT', body: 'junk' })).status).toBe(201)
    expect(await readdir(rootDir)).not.toContain('.DS_Store')
    expect(await readdir(rootDir)).not.toContain('._b.txt')
  })

  it('只读卷拒绝一切写，但读照常', async () => {
    const readOnlyDir = await mkdtempP(join(tmpdir(), 'anddrive-dav-ro-'))
    const roServer = await createDeviceDavServer((given) =>
      given === 'ro' ? { ...localAdapter(readOnlyDir), readOnly: true } : null,
    )
    try {
      const roBase = `http://127.0.0.1:${roServer.port}/ro`
      expect((await fetch(`${roBase}/x.txt`, { method: 'PUT', body: 'x' })).status).toBe(403)
      expect((await fetch(`${roBase}/x`, { method: 'MKCOL' })).status).toBe(403)
      const prop = await fetch(`${roBase}/`, { method: 'PROPFIND', headers: { depth: '0' } })
      expect(prop.status).toBe(207)
      // 只读卷报 Class 1 + locknull：报 Class 2 却不支持锁会让客户端按可写去用。
      expect(prop.headers.get('dav')).toBe('1')
      expect(await prop.text()).toContain('<D:locknull/>')
      expect(await readdir(readOnlyDir)).toEqual([])
    } finally {
      await roServer.close()
      await rmP(readOnlyDir, { recursive: true, force: true })
    }
  })

  it('LOCK / UNLOCK 走得通（Class 2 是可写挂载的先决条件）', async () => {
    const locked = await request('/b.txt', { method: 'LOCK', body: '<x/>' })
    expect(locked.status).toBe(200)
    const xml = await locked.text()
    expect(xml).toContain('<D:activelock>')
    expect(xml).toContain('<D:locktoken><D:href>urn:uuid:')
    expect(locked.headers.get('dav')).toBe('2')

    const token = xml.match(/<D:href>(urn:uuid:[^<]+)<\/D:href>/)[1]
    const unlocked = await request(`/b.txt?Lock-Token=${encodeURIComponent(token)}`, { method: 'UNLOCK' })
    expect(unlocked.status).toBe(204)
    // token 丢了也必须幂等成功，否则访达会卡在删除流程里。
    expect((await request('/b.txt?Lock-Token=urn:uuid:nope', { method: 'UNLOCK' })).status).toBe(204)
  })

  it('Range 读回 206 与正确的切片', async () => {
    await writeFile(join(rootDir, 'r.bin'), Buffer.alloc(1000, 7))
    const res = await request('/r.bin', { headers: { range: 'bytes=10-19' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect((await res.arrayBuffer()).byteLength).toBe(10)
  })
})

describe('macOS 元数据不该去问设备', () => {
  it('._xxx / .DS_Store 的读直接 404，一次设备往返都不发', async () => {
    const asked = []
    const adapter = {
      root: '/sdcard',
      displayName: '探针',
      readOnly: false,
      stat: async (p) => {
        asked.push(p)
        return null
      },
      list: async () => [],
      open: async () => null,
      write: async () => {},
      mkdir: async () => {},
      remove: async () => {},
      move: async () => {},
      copy: async () => {},
    }
    const server = await createDeviceDavServer(() => adapter)
    for (const name of ['._IMG_1.jpg', '.DS_Store', '.Spotlight-V100', 'real.jpg']) {
      const res = await fetch(`http://127.0.0.1:${server.port}/t/${encodeURIComponent(name)}`, {
        method: 'PROPFIND',
        headers: { depth: '0' },
      })
      expect(res.status).toBe(404)
    }
    await server.close()
    // 只有真文件该被问过设备：短路由写在这里的话，690 项的相机夹一次打开要多跑几百次 sync.stat。
    expect(asked).toEqual(['/sdcard/real.jpg'])
  })
})

describe('设备侧读到一半就失败', () => {
  it('打断响应，而不是把进程带崩', async () => {
    const { Readable } = await import('node:stream')
    const failing = {
      root: '/sdcard',
      displayName: '坏盘',
      readOnly: true,
      stat: async (p) => ({ path: p, name: 'broken.bin', dir: false, size: 4096, mtimeMs: 1 }),
      list: async () => [],
      open: () => {
        const stream = new Readable({ read() {} })
        stream.push(Buffer.alloc(1024, 7))
        // 真实场景是本地缓存条目刚被 LRU 淘汰、或 adb 链路正当中断掉
        setTimeout(() => stream.destroy(new Error('读到一半断了')), 5)
        return { stream, close: () => {} }
      },
    }
    const server = await createDeviceDavServer(() => failing)
    const seen = await new Promise((resolve) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: server.port, path: '/x/broken.bin', method: 'GET' },
        (res) => {
          let bytes = 0
          res.on('data', (chunk) => {
            bytes += chunk.length
          })
          res.on('end', () => resolve({ bytes, ended: true }))
          res.on('aborted', () => resolve({ bytes, ended: false }))
        },
      )
      req.on('error', () => resolve({ bytes: 0, ended: false, errored: true }))
      req.end()
    })
    await server.close()
    // 这条断言真正的价值是"没有未监听的 error 事件把测试进程带崩"：
    // 把 sendFile 里那句 file.stream.on('error', …) 删掉，这里会变成未捕获异常。
    expect(seen.bytes).toBeLessThan(4096)
    expect(seen.ended).toBe(false)
  })
})

describe('isMacMetadataName', () => {
  it('认得访达自己造的元数据名，不误伤普通隐藏文件', () => {
    expect(isMacMetadataName('.DS_Store')).toBe(true)
    expect(isMacMetadataName('._photo.jpg')).toBe(true)
    expect(isMacMetadataName('.Spotlight-V100')).toBe(true)
    // 挂载点建好时实测各问一次这些哨兵文件，手机上不存在，不该再花一次往返去问
    expect(isMacMetadataName('.hidden')).toBe(true)
    expect(isMacMetadataName('.metadata_never_index')).toBe(true)
    expect(isMacMetadataName('.ql_disablethumbnails')).toBe(true)
    expect(isMacMetadataName('.nomedia')).toBe(false)
    expect(isMacMetadataName('photo.jpg')).toBe(false)
    expect(isMacMetadataName('')).toBe(false)
  })
})

describe('resolveDestination', () => {
  it('只接受同一挂载点内的目标', () => {
    expect(resolveDestination('http://127.0.0.1:9/tok/a%20b.txt', 'tok', '/sdcard')).toBe('/sdcard/a b.txt')
    expect(resolveDestination('/tok/x', 'tok', '/sdcard')).toBe('/sdcard/x')
    expect(resolveDestination('http://127.0.0.1:9/other/x', 'tok', '/sdcard')).toBeNull()
    expect(resolveDestination('http://127.0.0.1:9/tok/../x', 'tok', '/sdcard')).toBeNull()
    expect(resolveDestination(undefined, 'tok', '/sdcard')).toBeNull()
  })
})
