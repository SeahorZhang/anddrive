import { onBeforeUnmount, onMounted } from 'vue'
import { KEYBOARD_KEYS, KEY_META } from '../../shared/keys.js'
import { routeKeyDown } from './keyRouting.js'
import { sendControl } from './direct-session.js'

/**
 * 镜像窗口输入：把指针 / 滚轮 / 键盘事件翻成控制消息，直接写
 * 本进程内的 control socket（直连形态，不经过主进程）。
 *
 * @param {{ target: import('vue').Ref<HTMLElement | null>, getVideoSize: () => ({width:number,height:number}|null),
 *   /** 返回 true = 可打印字符由 Mac 键盘那条路（隐藏字段的 `input` → 桥）送，
 *    *  这里就**不许**再发 `kind:'text'` —— 两处都发就是每个字打两遍。
 *   captureText?: () => boolean }} options
 */
export function useMirrorInput({ target, getVideoSize, captureText }) {
  let pointerActive = false
  let activePointerId = null
  /** 已经发过 `down` 的 keyCode：`keyup` 只补发这些，避免出现无主的 up。 */
  const forwardedKeys = new Set()

  function send(message) {
    sendControl(message)
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  function videoCoords(event) {
    const size = getVideoSize()
    if (!size?.width || !size?.height) return null
    // 按实际显示矩形（canvas 节点）换算，天然兼容 letterbox/unscaled/stretched。
    const canvas = target.value?.querySelector?.('canvas')
    const rect = canvas?.getBoundingClientRect?.()
    if (!rect?.width || !rect?.height) return null
    const { width, height } = size
    return {
      x: clamp((event.clientX - rect.left) * (width / rect.width), 0, width),
      y: clamp((event.clientY - rect.top) * (height / rect.height), 0, height),
      width,
      height,
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
    if (event.shiftKey) state |= KEY_META.Shift
    if (event.altKey) state |= KEY_META.Alt
    if (event.ctrlKey) state |= KEY_META.Ctrl
    if (event.metaKey) state |= KEY_META.Meta
    return state
  }

  function onKeyDown(event) {
    const route = routeKeyDown(event, { captureText: captureText?.() === true })
    if (route === 'key') {
      const keyCode = KEYBOARD_KEYS[event.key]
      // 记下真的按下过的那几个，`keyup` 只补发它们 —— 输入法吞掉的键（合成态的空格 /
      // 回车）不发 down，也就不该冒出一个无主的 up。
      forwardedKeys.add(keyCode)
      send({ kind: 'key', action: 'down', keyCode, metaState: metaState(event) })
      event.preventDefault()
      return
    }
    if (route === 'text') {
      send({ kind: 'text', text: event.key })
      event.preventDefault()
    }
  }

  function onKeyUp(event) {
    const keyCode = KEYBOARD_KEYS[event.key]
    if (keyCode === undefined) return
    const forwarded = forwardedKeys.delete(keyCode)
    if (!forwarded || event.metaKey) return
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
}
