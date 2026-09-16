/**
 * 自研镜像的音频播放：opus 包（scrcpy 4.0 唯一音频编码）经 WebCodecs
 * `AudioDecoder` 解码，用 AudioContext 按播放时钟排程，保持低延迟：
 * 提前 AHEAD 秒排队，落后即丢弃旧帧，超前太多直接丢包。
 * 配置包是 `OpusHead`（channels / sampleRate / preskip 都在其中）。
 */

const START_AHEAD_S = 0.08 // 首帧前预留的启动缓冲
const RESYNC_AHEAD_S = 0.4 // 调度超前超过该值则丢帧（网络追帧）
const STALL_RESYNC_S = 0.03 // 播放指针已过当前帧则重新对齐

function parseOpusHead(data) {
  if (data?.length < 19) return null
  return {
    channels: data[9],
    sampleRate: data[12] | (data[13] << 8) | (data[14] << 16) | (data[15] << 24),
    preskip: data[10] | (data[11] << 8),
  }
}

export function createOpusPlayer({ onStats, onError } = {}) {
  let context = null
  let decoder = null
  let playTime = 0 // 下一个 AudioBuffer 的起点（AudioContext 时钟，秒）
  let preskip = 0 // 尚需丢弃的开头样本（输出声道数）
  let framesDelta = 0 // 累计解码条数
  let playedCount = 0

  function stats() {
    if (!context) return
    onStats?.({
      played: playedCount,
      queue: decoder?.decodeQueueSize || 0,
      time: context.currentTime,
      state: context.state,
      decoded: framesDelta,
    })
  }

  /** 上下文被挂起（自动播放策略等）时尝试恢复。 */
  function wakeContext() {
    if (!context || context.state === 'running') return
    void context.resume().catch(() => {})
    console.warn('[mirror] AudioContext 处于', context.state, '，尝试 resume')
  }

  function ensureContext(sampleRate) {
    if (context) {
      wakeContext()
      return
    }
    context = new AudioContext({ sampleRate, latencyHint: 'interactive' })
    context.addEventListener('statechange', wakeContext)
    wakeContext()
    playTime = context.currentTime + START_AHEAD_S
  }

  function scheduleFrame(frame) {
    framesDelta += 1
    let body = frame
    if (preskip > 0) {
      if (preskip >= body.numberOfFrames) {
        preskip -= body.numberOfFrames
        body.close()
        return
      }
      body = trimStart(body, preskip)
      preskip = 0
    }
    if (!context || body.numberOfFrames <= 0) {
      body.close()
      return
    }
    playTime = Math.max(playTime, context.currentTime - STALL_RESYNC_S + 0.02)
    if (playTime > context.currentTime + RESYNC_AHEAD_S) {
      body.close()
      return
    }
    const buffer = context.createBuffer(
      body.numberOfChannels,
      body.numberOfFrames,
      body.sampleRate,
    )
    for (let channel = 0; channel < body.numberOfChannels; channel += 1) {
      const plane = new Float32Array(body.numberOfFrames)
      body.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
      buffer.copyToChannel(plane, channel)
    }
    body.close()

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      playedCount += 1
      source.disconnect()
      stats()
    }
    source.start(playTime)
    playTime += buffer.duration
  }

  function configure(packet) {
    const head = parseOpusHead(packet.data)
    if (!head) {
      onError?.('音频配置包解析失败（缺少 OpusHead）')
      return false
    }
    ensureContext(head.sampleRate)
    decoder?.close?.().catch?.(() => {})
    decoder = new window.AudioDecoder({
      output: scheduleFrame,
      error: (error) => onError?.(`音频解码失败：${error?.message || error}`),
    })
    decoder.configure({
      codec: 'opus',
      sampleRate: head.sampleRate,
      numberOfChannels: head.channels,
      description: packet.data,
    })
    preskip = head.preskip
    stats()
    return true
  }

  function push(packet) {
    // 配置包必须先于 decoder 存在就处理（首个包就是 OpusHead）。
    if (packet.type === 'configuration') {
      configure(packet)
      return
    }
    if (!decoder || decoder.state !== 'configured') return
    decoder.decode(
      new window.EncodedAudioChunk({
        type: 'key',
        // pts 来自 Tango 的 u64 BigInt，WebCodecs 时间戳用 number（微秒）。
        timestamp: packet.pts != null ? Number(packet.pts) : Math.round(performance.now() * 1000),
        data: packet.data,
      }),
    )
    // 积压过多直接重置解码器，由后续 config/data 恢复，避免持续卡顿拖尾。
    if (decoder.decodeQueueSize > 120) decoder.reset()
    stats()
  }

  function dispose() {
    try {
      decoder?.close()
    } catch {
      // 忽略关闭失败
    }
    decoder = null
    void context?.close?.()
    context = null
  }

  return { push, dispose }
}

/** 把 AudioData 的前 skip 条样本裁掉，返回新 AudioData。 */
function trimStart(frame, skip) {
  const keep = frame.numberOfFrames - skip
  const channels = frame.numberOfChannels
  const merged = new Float32Array(keep * channels)
  for (let channel = 0; channel < channels; channel += 1) {
    const plane = new Float32Array(frame.numberOfFrames)
    frame.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
    merged.set(plane.subarray(skip), channel * keep)
  }
  const dst = new window.AudioData({
    format: 'f32-planar',
    sampleRate: frame.sampleRate,
    numberOfFrames: keep,
    numberOfChannels: channels,
    timestamp: frame.timestamp + Math.round((skip / frame.sampleRate) * 1e6),
    data: merged,
  })
  frame.close()
  return dst
}
