import { Object3D, Intersection as ThreeIntersection } from 'three'
import { Intersection } from './intersections/index.js'
import { NativeEvent, NativeWheelEvent, PointerEvent, WheelEvent, emitPointerEvent } from './event.js'
import { intersectPointerEventTargets } from './intersections/utils.js'
import { Intersector } from './intersections/intersector.js'

const buttonsDownTimeKey = Symbol('buttonsDownTime')
const buttonsClickTimeKey = Symbol('buttonsClickTime')

export type AllowedPointerEvents = 'none' | 'auto' | 'listener'

export type ButtonsTime = Map<number, number>

export type AllowedPointerEventsType =
  | 'all'
  | ((poinerId: number, pointerType: string, pointerState: unknown) => boolean)
  | { allow: string | Array<string> }
  | { deny: string | Array<string> }

declare module 'three' {
  interface Object3D {
    _listeners?: Record<string, Array<(event: unknown) => void> | undefined>
    /**
     * @default "listener"
     */
    pointerEvents?: AllowedPointerEvents
    /**
     * @default "all"
     */
    pointerEventsType?: AllowedPointerEventsType
    /**
     * @default 0
     * sorted by highest number first
     * (just like a higher renderOrder number will result in rendering over the previous - if depthTest is false)
     */
    pointerEventsOrder?: number
    [buttonsDownTimeKey]?: ButtonsTime
    [buttonsClickTimeKey]?: ButtonsTime
  }
}

export type PointerCapture = {
  object: Object3D
  intersection: Intersection
}

export type PointerOptions = {
  /**
   * @default 300
   */
  clickThesholdMs?: number
  /**
   * @default 500
   */
  dblClickThresholdMs?: number
  /**
   * @default 2
   */
  contextMenuButton?: number
  /**
   * filtering the intersectable objects
   * @default undefined
   */
  filter?: (
    object: Object3D,
    pointerEvents: AllowedPointerEvents,
    pointerEventsType: AllowedPointerEventsType,
    pointerEventsOrder: number,
  ) => boolean
}

const pointerMap = new Map<number, Pointer>()

declare module 'three' {
  interface Object3D {
    setPointerCapture(pointerId: number): void
    releasePointerCapture(pointerId: number): void
    hasPointerCapture(pointerId: number): boolean
  }
}

Object3D.prototype.setPointerCapture = function (this: Object3D, pointerId: number): void {
  getPointerById(pointerId)?.setCapture(this)
}

Object3D.prototype.releasePointerCapture = function (this: Object3D, pointerId: number): void {
  const pointer = getPointerById(pointerId)
  if (pointer == null || !pointer.hasCaptured(this)) {
    return
  }
  pointer.setCapture(undefined)
}

Object3D.prototype.hasPointerCapture = function (this: Object3D, pointerId: number): boolean {
  return getPointerById(pointerId)?.hasCaptured(this) ?? false
}

export function getPointerById(pointerId: number) {
  return pointerMap.get(pointerId)
}

export class Pointer {
  //state
  private prevIntersection: Intersection | undefined
  private intersection: Intersection | undefined
  private prevEnabled = true
  private enabled = true

  //derived state
  /**
   * ordered leaf -> root (bottom -> top)
   */
  private pointerEntered: Array<Object3D> = []
  private pointerEnteredHelper: Array<Object3D> = []
  private pointerCapture: PointerCapture | undefined
  private buttonsDownTime: ButtonsTime = new Map()
  private readonly buttonsDown = new Set<number>()

  //to handle interaction before first move
  private wasMoved = false
  private onFirstMove: Array<() => void> = []

  constructor(
    public readonly id: number,
    public readonly type: string,
    public readonly state: any,
    public readonly intersector: Intersector,
    private readonly onMoveCommited?: (pointer: Pointer) => void,
    private readonly parentSetPointerCapture?: () => void,
    private readonly parentReleasePointerCapture?: () => void,
    public readonly options: PointerOptions = {},
  ) {
    pointerMap.set(id, this)
  }

  getPointerCapture(): PointerCapture | undefined {
    return this.pointerCapture
  }

  hasCaptured(object: Object3D): boolean {
    return this.pointerCapture?.object === object
  }

  setCapture(object: Object3D | undefined): void {
    if (this.pointerCapture?.object === object) {
      return
    }

    if (this.pointerCapture != null) {
      this.parentReleasePointerCapture?.()
      this.pointerCapture = undefined
    }

    if (object != null && this.intersection != null) {
      this.pointerCapture = { object, intersection: this.intersection }
      this.parentSetPointerCapture?.()
    }
  }

  getButtonsDown(): ReadonlySet<number> {
    return this.buttonsDown
  }

  getIntersection(): Intersection | undefined {
    return this.intersection
  }

  getEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean, nativeEvent: NativeEvent, commit: boolean = true): void {
    if (this.enabled === enabled) {
      return
    }
    if (!enabled && this.pointerCapture != null) {
      this.parentReleasePointerCapture?.()
      this.pointerCapture = undefined
    }
    this.enabled = enabled
    if (commit) {
      this.commit(nativeEvent)
    }
  }

  private computeIntersection(scene: Object3D, nativeEvent: NativeEvent) {
    if (this.pointerCapture != null) {
      return this.intersector.intersectPointerCapture(this.pointerCapture, nativeEvent)
    }
    this.intersector.startIntersection(nativeEvent)
    intersectPointerEventTargets(scene, [this])
    return this.intersector.finalizeIntersection()
  }

  setIntersection(intersection: Intersection | undefined): void {
    this.intersection = intersection
  }

  /**
   * allows to separately compute and afterwards commit a move
   * => do not forget to call commitMove after computeMove
   * can be used to compute the current intersection and disable or enable the pointer before commiting the move
   */
  computeMove(scene: Object3D, nativeEvent: NativeEvent) {
    this.intersection = this.computeIntersection(scene, nativeEvent)
  }

  commit(nativeEvent: NativeEvent) {
    const prevIntersection = this.prevEnabled ? this.prevIntersection : undefined
    const intersection = this.enabled ? this.intersection : undefined
    //pointer out
    if (prevIntersection != null && prevIntersection.object != intersection?.object) {
      emitPointerEvent(new PointerEvent('pointerout', true, nativeEvent, this, prevIntersection))
    }

    const pointerLeft = this.pointerEntered
    this.pointerEntered = []
    this.pointerEnteredHelper.length = 0
    computeEnterLeave(intersection?.object, this.pointerEntered, pointerLeft, this.pointerEnteredHelper)

    //pointerleave
    const length = pointerLeft.length
    for (let i = 0; i < length; i++) {
      const object = pointerLeft[i]
      emitPointerEvent(new PointerEvent('pointerleave', false, nativeEvent, this, prevIntersection!, object))
    }

    //pointer over
    if (intersection != null && prevIntersection?.object != intersection.object) {
      emitPointerEvent(new PointerEvent('pointerover', true, nativeEvent, this, intersection))
    }

    //pointer enter
    //inverse loop so that we emit enter from top -> bottom (root -> leaf)
    for (let i = this.pointerEnteredHelper.length - 1; i >= 0; i--) {
      const object = this.pointerEnteredHelper[i]
      emitPointerEvent(new PointerEvent('pointerenter', false, nativeEvent, this, intersection!, object))
    }

    //pointer move
    if (intersection != null) {
      emitPointerEvent(new PointerEvent('pointermove', true, nativeEvent, this, intersection))
    }

    this.prevIntersection = this.intersection
    this.prevEnabled = this.enabled

    if (!this.wasMoved) {
      this.wasMoved = true
      const length = this.onFirstMove.length
      for (let i = 0; i < length; i++) {
        this.onFirstMove[i]()
      }
      this.onFirstMove.length = 0
    }

    this.onMoveCommited?.(this)
  }

  /**
   * computes and commits a move
   */
  move(scene: Object3D, nativeEvent: NativeEvent): void {
    this.computeMove(scene, nativeEvent)
    this.commit(nativeEvent)
  }

  down(nativeEvent: NativeEvent & { button: number }): void {
    this.buttonsDown.add(nativeEvent.button)
    if (!this.enabled) {
      return
    }
    if (!this.wasMoved) {
      this.onFirstMove.push(this.down.bind(this, nativeEvent))
      return
    }
    if (this.intersection == null) {
      return
    }
    //pointer down
    emitPointerEvent(new PointerEvent('pointerdown', true, nativeEvent, this, this.intersection))

    //store button down times on object and on pointer
    const { object } = this.intersection
    object[buttonsDownTimeKey] ??= new Map()
    object[buttonsDownTimeKey].set(nativeEvent.button, nativeEvent.timeStamp)
    this.buttonsDownTime.set(nativeEvent.button, nativeEvent.timeStamp)
  }

  up(nativeEvent: NativeEvent & { button: number }): void {
    this.buttonsDown.delete(nativeEvent.button)
    if (!this.enabled) {
      return
    }
    if (!this.wasMoved) {
      this.onFirstMove.push(this.up.bind(this, nativeEvent))
      return
    }
    if (this.intersection == null) {
      return
    }

    const { contextMenuButton = 2, dblClickThresholdMs = 500, clickThesholdMs = 300 } = this.options

    this.pointerCapture = undefined
    const isClicked = getIsClicked(
      this.buttonsDownTime,
      this.intersection.object[buttonsDownTimeKey],
      nativeEvent.button,
      nativeEvent.timeStamp,
      clickThesholdMs,
    )

    //context menu
    if (isClicked && nativeEvent.button === contextMenuButton) {
      emitPointerEvent(new PointerEvent('contextmenu', true, nativeEvent, this, this.intersection))
    }

    //poinerup
    emitPointerEvent(new PointerEvent('pointerup', true, nativeEvent, this, this.intersection))

    if (!isClicked || nativeEvent.button === contextMenuButton) {
      return
    }

    //click
    emitPointerEvent(new PointerEvent('click', true, nativeEvent, this, this.intersection))

    //dblclick
    const { object } = this.intersection
    const buttonsClickTime = (object[buttonsClickTimeKey] ??= new Map())
    const buttonClickTime = buttonsClickTime.get(nativeEvent.button)

    if (buttonClickTime == null || nativeEvent.timeStamp - buttonClickTime > dblClickThresholdMs) {
      buttonsClickTime.set(nativeEvent.button, nativeEvent.timeStamp)
      return
    }

    emitPointerEvent(new PointerEvent('dblclick', true, nativeEvent, this, this.intersection))
    buttonsClickTime.delete(nativeEvent.button)
  }

  cancel(nativeEvent: NativeEvent): void {
    if (!this.enabled) {
      return
    }
    if (!this.wasMoved) {
      this.onFirstMove.push(this.cancel.bind(this, nativeEvent))
      return
    }
    if (this.intersection == null) {
      return
    }
    //pointer cancel
    emitPointerEvent(new PointerEvent('pointercancel', true, nativeEvent, this, this.intersection))
  }

  wheel(scene: Object3D, nativeEvent: NativeWheelEvent, useCurrentIntersection: boolean): void {
    if (!this.enabled) {
      return
    }
    let intersection = this.intersection
    if (!useCurrentIntersection) {
      intersection = this.computeIntersection(scene, nativeEvent)
    }
    if (!this.wasMoved && useCurrentIntersection) {
      this.onFirstMove.push(this.cancel.bind(this, nativeEvent))
      return
    }
    if (intersection == null) {
      return
    }
    //wheel
    emitPointerEvent(new WheelEvent(nativeEvent, this, intersection))
  }

  exit(nativeEvent: NativeEvent): void {
    if (!this.wasMoved) {
      this.onFirstMove.push(this.exit.bind(this, nativeEvent))
      return
    }

    //reset state
    if (this.pointerCapture != null) {
      this.parentReleasePointerCapture?.()
      this.pointerCapture = undefined
    }
    this.intersection = undefined
    this.commit(nativeEvent)
  }
}

/**
 * @returns an array that contains the object and all its ancestors ordered leaf -> root (bottom -> top)
 */
function computeEnterLeave(
  currentObject: Object3D | null | undefined,
  targetAllAncestors: Array<Object3D>,
  targeDiffRemovedAncestors: Array<Object3D>,
  targetDiffAddedAncestors: Array<Object3D>,
): void {
  if (currentObject == null) {
    return
  }
  const index = targeDiffRemovedAncestors.indexOf(currentObject)
  if (index != -1) {
    targeDiffRemovedAncestors.splice(index, 1)
  } else {
    targetDiffAddedAncestors.push(currentObject)
  }
  targetAllAncestors.push(currentObject)
  computeEnterLeave(currentObject.parent, targetAllAncestors, targeDiffRemovedAncestors, targetDiffAddedAncestors)
}

function getIsClicked(
  pointerButtonsPressTime: ButtonsTime,
  objectButtonsDownTime: ButtonsTime | undefined,
  button: number,
  buttonUpTime: number,
  clickThesholdMs: number,
): boolean {
  if (objectButtonsDownTime == null) {
    return false
  }
  const objectButtonPressTime = objectButtonsDownTime.get(button)
  if (objectButtonPressTime == null) {
    return false
  }
  if (buttonUpTime - objectButtonPressTime > clickThesholdMs) {
    return false
  }
  if (objectButtonPressTime != pointerButtonsPressTime.get(button)) {
    //we have released the button somewhere else
    return false
  }
  return true
}
