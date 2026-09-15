import { describe, expect, it, vi } from 'vitest'

const { toTouchMessage, toScrollMessage, toKeyMessage, toMetaState, applyControl } = await import(
  '../../electron/mirror/control.js'
)

describe('toTouchMessage', () => {
  it('maps a press with primary button and full pressure', () => {
    expect(toTouchMessage({ action: 'down', x: 10.4, y: 20.6, width: 1080, height: 1920 })).toEqual({
      action: 0,
      pointerId: 0n,
      pointerX: 10,
      pointerY: 21,
      videoWidth: 1080,
      videoHeight: 1920,
      pressure: 1,
      actionButton: 1,
      buttons: 1,
    })
  })

  it('releases the button on up', () => {
    const message = toTouchMessage({ action: 'up', x: 1, y: 2, width: 100, height: 200 })
    expect(message.action).toBe(1)
    expect(message.pressure).toBe(0)
    expect(message.buttons).toBe(0)
  })
})

describe('toScrollMessage', () => {
  it('clamps scroll deltas to [-1, 1]', () => {
    expect(toScrollMessage({ x: 1, y: 2, width: 10, height: 20, scrollX: -5, scrollY: 0.25 })).toEqual({
      pointerX: 1,
      pointerY: 2,
      videoWidth: 10,
      videoHeight: 20,
      scrollX: -1,
      scrollY: 0.25,
    })
  })
})

describe('toKeyMessage', () => {
  it('maps actions and meta state', () => {
    expect(toKeyMessage({ action: 'down', keyCode: 66 })).toEqual({
      action: 0,
      keyCode: 66,
      repeat: 0,
      metaState: 0,
    })
    expect(toKeyMessage({ action: 'up', keyCode: 4 })).toMatchObject({ action: 1 })
  })
})

describe('toMetaState', () => {
  it('combines modifier bits', () => {
    expect(toMetaState({ shiftKey: true, ctrlKey: true })).toBe(0x01 | 0x1000)
    expect(toMetaState({})).toBe(0)
  })
})

describe('applyControl', () => {
  function fakeController() {
    return {
      injectTouch: vi.fn().mockResolvedValue(undefined),
      injectScroll: vi.fn().mockResolvedValue(undefined),
      injectKeyCode: vi.fn().mockResolvedValue(undefined),
      injectText: vi.fn().mockResolvedValue(undefined),
      rotateDevice: vi.fn().mockResolvedValue(undefined),
      expandNotificationPanel: vi.fn().mockResolvedValue(undefined),
      setDisplayPower: vi.fn().mockResolvedValue(undefined),
    }
  }

  it('dispatches touch, text and rotate', async () => {
    const controller = fakeController()
    await applyControl(controller, { kind: 'touch', action: 'down', x: 1, y: 1, width: 10, height: 10 })
    await applyControl(controller, { kind: 'text', text: 'hi' })
    await applyControl(controller, { kind: 'action', action: 'rotate' })
    expect(controller.injectTouch).toHaveBeenCalledTimes(1)
    expect(controller.injectText).toHaveBeenCalledWith('hi')
    expect(controller.rotateDevice).toHaveBeenCalledTimes(1)
  })

  it('taps key actions with a down and an up', async () => {
    const controller = fakeController()
    await applyControl(controller, { kind: 'action', action: 'back' })
    expect(controller.injectKeyCode).toHaveBeenCalledTimes(2)
    expect(controller.injectKeyCode.mock.calls[0][0]).toMatchObject({ action: 0, keyCode: 4 })
    expect(controller.injectKeyCode.mock.calls[1][0]).toMatchObject({ action: 1, keyCode: 4 })
  })

  it('maps screen power to setDisplayPower', async () => {
    const controller = fakeController()
    await applyControl(controller, { kind: 'action', action: 'screenOff' })
    expect(controller.setDisplayPower).toHaveBeenCalledWith(false)
  })

  it('rejects unknown messages', async () => {
    await expect(applyControl(fakeController(), { kind: 'nope' })).rejects.toThrow('未知控制消息')
    await expect(applyControl(fakeController(), { kind: 'action', action: 'nope' })).rejects.toThrow(
      '未知控制动作',
    )
  })
})
