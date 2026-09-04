/**
 * The shape of the seal while it comes off the page.
 *
 * The free part of the seal wraps around a cylinder lying on the page along the
 * crease, which is the line where the wax is still attached. Distance is
 * measured along the surface, so the wax bends but does not stretch. No CSS
 * transform can do this: a rigid transform of a flat quad has no bend in the
 * middle.
 *
 * Every value here is a pure function of progress, from 0 (flat on the page) to
 * 1 (gone). Run the progress backwards to put the seal back.
 */

export interface Pose {
  /** Position of the crease along `SWEEP`, from the middle of the seal. */
  front: number
  /** Radius of the cylinder, in seal widths. Small is a tight roll. */
  radius: number
  /** Curvature across the peel. Negative lifts the sides of the seal. */
  bow: number
  /** Angle the whole seal tips about the crease. */
  tip: number
  /** Push towards the reader, in seal widths. Negative is into the page. */
  press: number
  /** Opacity. The seal fades out while it leaves. */
  alpha: number
}

/** Default direction of the curl, as if a thumb lifted the near corner. */
const LENGTH = Math.hypot(0.88, 0.47)
export const SWEEP: readonly [number, number] = [-0.88 / LENGTH, -0.47 / LENGTH]

/**
 * Direction of the curl for a seal clicked at `origin`, which runs from
 * `[0, 0]` at the top left corner of the seal to `[1, 1]` at the bottom right.
 * The crease starts on the side that was clicked, so the wax below the pointer
 * lifts first, the way a sticker comes off a surface.
 */
export function sweepFrom(origin?: [number, number]): readonly [number, number] {
  if (!origin) return SWEEP
  const x = origin[0] - 0.5
  // The y axis of the box points down. The y axis of the seal points up.
  const y = 0.5 - origin[1]
  const length = Math.hypot(x, y)
  // A click at the exact centre gives no direction to use.
  return length < 0.04 ? SWEEP : [x / length, y / length]
}

/**
 * Where the crease starts. The artwork is 0.46 wide from the middle, so this
 * clears it. Not the corner of the square at 0.71: the corners are transparent,
 * and the first fifth of the animation would cross them with nothing to show.
 */
const S_MAX = 0.48
/** Where the crease stops, past the far edge, so that all of the seal lifts. */
const S_END = -0.4

/** Progress at which the wax breaks and the fade starts. */
export const BREAK = 0.6
/** Part of the animation that presses the seal in before it lifts. */
const PRESS = 0.06

export const PEEL_MS = 1000
export const RESEAL_MS = 820

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const between = (x: number, a: number, b: number) => clamp01((x - a) / (b - a))
const smooth = (x: number) => x * x * (3 - 2 * x)
const mix = (a: number, b: number, t: number) => a + (b - a) * t

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const REST: Pose = { front: S_MAX, radius: 0.18, bow: 0, tip: 0, press: 0, alpha: 1 }

/** The shape at `progress`. Six numbers, so a fresh one per frame costs nothing. */
export function poseAt(progress: number, flat = false): Pose {
  const p = clamp01(progress)

  // Reduced motion: a plain fade, with none of the bending.
  if (flat) return { ...REST, alpha: 1 - p }

  // Eased out, not smoothed. A smoothstep barely moves during its first third,
  // and the seal would then appear to wait after the click. The seal is a disc,
  // so the crease also crosses very little of it while it is near the rim.
  const sweep = Math.pow(between(p, PRESS, 1), 0.6)

  return {
    front: mix(S_MAX, S_END, sweep),
    // Interpolate the curvature, not the radius: the radius spends almost all
    // of the animation near the tight end.
    radius: 1 / mix(5.6, 7.4, sweep),
    // Bending a strip in one direction curves it in the other across its width.
    bow: mix(0, -0.32, sweep),
    // Only a little. Tipping the seal turns the flat part away from the reader
    // and removes the foreshortening that makes the roll legible.
    tip: 0.12 * smooth(between(p, PRESS, 0.5)),
    // A short press into the page before the seal lifts.
    press: p < PRESS ? -0.022 * Math.sin(Math.PI * (p / PRESS)) : 0,
    alpha: 1 - smooth(between(p, BREAK, 1)),
  }
}
