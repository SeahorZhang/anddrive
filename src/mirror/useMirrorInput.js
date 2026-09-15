import { onBeforeUnmount, onMounted } from 'vue'
import { KEYBOARD_KEYS, KEY_META } from '../../shared/keys.js'

/**
 * 镜像窗口输入：把指针 / 滚轮 / 键盘事件翻成控制消息发给主进程。
 * 坐标按 canvas 的 `object-fit: contain` 反算出视频像素坐标。
 */
export function useMirrorInput({ target, sessionId, getVideoSize }) {
  let pointerActive = false
  let activePointerId = null

  function send(message) {
    const id = sessionId.value
    if (!id) return
    window.electronAPI?.mirror?.control?.({ id, ...message })
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  function videoCoords(event) {
    const el = target.value
    const size = getVideoSize()
    if (!el || !size?.width || !size?.height) return null
    const rect = el.getBoundingClientRect()
    const scale = Math.min(rect.width / size.width, rect.height / size.height)
    if (!scale) return null
    const offsetX = (rect.width - size.width * scale) / 2
    const offsetY = (rect.height - size.height * scale) / 2
    return {
      x: clamp((event.clientX - rect.left - offsetX) / scale, 0, size.width),
      y: clamp((event.clientY - rect.top - offsetY) / scale, 0, size.height),
      width: size.width,
      height: size.height,
    }
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !event.isPrimary) return
    const coords = videoCoords(event)
    if (!coords) return
    pointerActive = true
    activePointerId = event.pointerId
    target.value?.setPointerCapture?.(event.pointerId)
    send({ kind: 'touch', action: 'down', ...coords, pressure: 1 })
    event.preventDefault()
  }

  function onPointerMove(event) {
    if (!pointerActive || event.pointerId !== activePointerId) return
    const coords = videoCoords(event)
    if (!coords) return
    send({ kind: 'touch', action: 'move', ...coords, pressure: 1 })
  }

  function release(event, action) {
    if (!pointerActive || event.pointerId !== activePointerId) return
    pointerActive = false
    activePointerId = null
    const coords = videoCoords(event)
    if (coords) send({ kind: 'touch', action, ...coords, pressure: 0 })
    event.preventDefault()
  }

  function onPointerUp(event) {
    release(event, 'up')
  }

  function onPointerCancel(event) {
    release(event, 'cancel')
  }

  function onWheel(event) {
    const coords = videoCoords(event)
    if (!coords) return
    send({ kind: 'scroll', ...coords, scrollX: -event.deltaX / 100, scrollY: -event.deltaY / 100 })
    event.preventDefault()
  }

  function metaState(event) {
    let state = 0
    if (event.shiftKey) state |= KEY_META.shift
    if (event.altKey) state |= KEY_META.alt
    if (event.ctrlKey) state |= KEY_META.ctrl
    if (event.metaKey) state |= KEY_META.meta
    return state
  }

  function onKeyDown(event) {
    // Cmd 组合键交给系统与应用（Cmd+Q / Cmd+W 等）。
    if (event.metaKey) return
    const keyCode = KEYBOARD_KEYS[event.key]
    if (keyCode !== undefined) {
      send({ kind: 'key', action: 'down', keyCode, metaState: metaState(event) })
      event.preventDefault()
      return
    }
    // 可打印字符走文本注入；Ctrl / Alt 组合（复制粘贴等）暂不处理。
    if (event.ctrlKey || event.altKey) return
    if (event.key.length === 1) {
      send({ kind: 'text', text: event.key })
      event.preventDefault()
    }
  }

  function onKeyUp(event) {
    if (event.metaKey) return
    const keyCode = KEYBOARD_KEYS[event.key]
    if (keyCode === undefined) return
    send({ kind: 'key', action: 'up', keyCode, metaState: metaState(event) })
  }

  function attach() {
    const el = target.value
    if (!el) return
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerCancel)
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
  }

  function detach() {
    const el = target.value
    el?.removeEventListener('pointerdown', onPointerDown)
    el?.removeEventListener('pointermove', onPointerMove)
    el?.removeEventListener('pointerup', onPointerUp)
    el?.removeEventListener('pointercancel', onPointerCancel)
    el?.removeEventListener('wheel', onWheel)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
  }

  onMounted(attach)
  onBeforeUnmount(detach)

  return { send, runAction: (action) => send({ kind: 'action', action }) }
}
