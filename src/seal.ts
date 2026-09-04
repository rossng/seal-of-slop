import { DEFAULT_DESIGN, DESIGNS, type DesignName } from './assets.js'
import {
  BREAK,
  sweepFrom,
  PEEL_MS,
  RESEAL_MS,
  SWEEP,
  type Pose,
  poseAt,
  reducedMotion,
} from './peel.js'

export interface SealOptions {
  /** The artwork: `seal` for pressed wax, `sticker` for printed vinyl. An
   * unknown name falls back to the default. */
  design?: DesignName | (string & {}) | null
  /** Size in CSS pixels, or `'fill'` to take the size from the parent box. */
  size?: number | 'fill'
}

export interface Seal {
  /** The canvas. If the browser has no WebGL, this is an `<img>` instead. */
  readonly element: HTMLElement
  /** True while the seal is off the page. */
  readonly peeled: boolean
  /** Apply new options and draw the seal again. */
  update(options: SealOptions): void
  /**
   * Lift the seal off the page. `broke` is called part of the way through, when
   * the wax breaks; the promise resolves at the end. `origin` is the position
   * of the click, from `[0, 0]` top left to `[1, 1]` bottom right.
   */
  peel(broke?: () => void, origin?: [number, number]): Promise<void>
  /** Put the seal back. Safe to call while it is still leaving. */
  reseal(): Promise<void>
  /** Remove the listeners and release the GPU resources. */
  destroy(): void
}

/**
 * How the surface of a design reflects light. The shader holds both models and
 * picks one per draw; the geometry, the shadow march and the peel are shared.
 */
interface Material {
  print: boolean
  ambient: number
  shininess: number
  /** Strength of the light when the pointer is out of range. */
  idle: number
  relief: number
  shadow: number
  specular: [number, number, number]
}

const WAX: Material = {
  print: false,
  ambient: 0.78,
  shininess: 30,
  idle: 0.6,
  relief: 0.06,
  shadow: 0.6,
  specular: [0.55, 0.526, 0.486],
}

/** Wax is the default. A new design is lit as wax until it is listed here. */
const MATERIALS: Partial<Record<DesignName, Material>> = {
  sticker: {
    ...WAX,
    print: true,
    // Print has no headroom: the ink is already near the top of the range.
    ambient: 0.9,
    shininess: 55,
    idle: 0.5,
    // A sticker is flat, so skip the height march.
    relief: 0.02,
    shadow: 0,
    specular: [0.5, 0.5, 0.52],
  },
}

const materialOf = (design: DesignName) => MATERIALS[design] ?? WAX

/** A direction, as the shaders want it. Zero length would divide by zero. */
function unit(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1
  return [x / length, y / length, z / length]
}

/** Size in CSS pixels when the caller names none. */
const DEFAULT_SIZE = 128
/** How far from the seal, in CSS pixels, the pointer still moves the light. */
const FALLOFF = 400
/** How high the light rides above the page, in seal widths. */
const LIGHT_HEIGHT = 1.1
/** Drawing a badge at more than this costs more than it shows. */
const MAX_PIXEL_RATIO = 2

/** One stage of an animation that is in progress. */
interface Run {
  from: number
  to: number
  start: number
  duration: number
  ease(t: number): number
  broke?: (() => void) | undefined
  settle(): void
}

/** Where the light rests when the pointer is out of range. */
const IDLE_LIGHT: [number, number] = [0.22, 0.06]
/** Backstop on how far the light may travel, in seal widths. */
const MAX_LIGHT_RADIUS = 2.6
/** The time constant of the exponential smoothing, in seconds. */
const TAU = 0.055

/** Divisions across the seal. Square, so the crease is clean in any direction. */
const GRID = 40
/**
 * How much larger the canvas gets while the seal peels, in seal widths. The
 * seal lifts towards the reader, and perspective takes it outside its own box.
 */
const SPAN = 1.4
/**
 * Camera distance in seal widths. Near enough for depth, far enough that a lift
 * does not magnify the seal and undo the compression that shows the curl.
 */
const CAMERA = 5.5

// prettier-ignore
const UNIFORMS = [
  'uLight', 'uSkyLight', 'uSpecular', 'uIntensity', 'uShininess', 'uAlpha', 'uSpan',
  'uCamera', 'uSweep', 'uFront', 'uRadius', 'uBow', 'uTip', 'uPress', 'uAmbient',
  'uRelief', 'uShadow', 'uPrint', 'uLightUv',
] as const

const VERTEX = `
attribute vec2 aGrid;

uniform float uSpan;
uniform float uCamera;
uniform vec2 uSweep;
uniform float uFront;
uniform float uRadius;
uniform float uBow;
uniform float uTip;
uniform float uPress;
uniform vec3 uLight;
uniform vec3 uSkyLight;

varying vec2 vUv;
varying vec3 vLight;
varying vec3 vSky;
varying vec3 vView;

const float PI = 3.14159265;

mat3 axisRotation(vec3 a, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  float t = 1.0 - c;
  return mat3(
    t * a.x * a.x + c,       t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y,
    t * a.x * a.y - s * a.z, t * a.y * a.y + c,       t * a.y * a.z + s * a.x,
    t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c
  );
}

void main() {
  vUv = aGrid;
  // Seal space: origin in the middle, y up, one unit wide.
  vec2 p = vec2(aGrid.x - 0.5, 0.5 - aGrid.y);
  vec2 across = vec2(-uSweep.y, uSweep.x);
  float s = dot(p, uSweep);
  float t = dot(p, across);

  // One curvature across the peel, so it is a cylinder with a closed formula.
  // Keep it off zero for the division; at that size it already looks flat.
  float k = uBow;
  if (abs(k) < 0.002) k = k < 0.0 ? -0.002 : 0.002;
  float bowAngle = k * t;
  float bowed = sin(bowAngle) / k;
  float bowRise = (1.0 - cos(bowAngle)) / k;

  // The curl. A cylinder of radius uRadius lies on the page along the crease at
  // uFront, and everything the crease has passed wraps around it. Over the top
  // it runs back the other way, face down, at twice the radius: that is what
  // makes it a peel rather than a bend. Distance is measured along the surface,
  // so the wrap spends arc length instead of stretching it.
  float d = s - uFront;
  float along = s;
  float lift = 0.0;
  float bend = 0.0;
  if (d > 0.0) {
    float over = PI * uRadius;
    if (d < over) {
      // On the cylinder, still turning.
      bend = d / uRadius;
      along = uFront + uRadius * sin(bend);
      lift = uRadius * (1.0 - cos(bend));
    } else {
      // Over the top and flat again.
      bend = PI;
      along = uFront - (d - over);
      lift = 2.0 * uRadius;
    }
  }

  vec3 local = vec3(uSweep * along + across * bowed, lift + bowRise);
  vec3 crease = vec3(across, 0.0);
  // The tip and the curl both turn about the crease, so they are one rotation.
  // The bow is the third, and the normal map follows all of the deformation.
  mat3 basis = axisRotation(crease, uTip - bend) * axisRotation(vec3(uSweep, 0.0), bowAngle);
  vec3 world = axisRotation(crease, uTip) * local + vec3(0.0, 0.0, uPress);

  // Light into tangent space: the surface moves, the sun does not. Doing it
  // here leaves the fragment shader unchanged from the flat case.
  // (\`vec * mat\` is the row-vector product, that is transpose(mat) * vec.)
  vLight = uLight * basis;
  vSky = uSkyLight * basis;
  vView = vec3(0.0, 0.0, 1.0) * basis;

  // Weak perspective, so a lift reads as nearer. Depth comes with it: once the
  // seal folds over itself, the near half must hide the far half.
  float w = 1.0 - world.z / uCamera;
  gl_Position = vec4(world.xy * (2.0 / uSpan), -world.z * 0.3 * w, w);
}`

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
varying vec3 vLight;
varying vec3 vSky;
varying vec3 vView;
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uHeight;
uniform vec3 uSpecular;
uniform float uIntensity;
uniform float uShininess;
uniform float uAmbient;
uniform float uRelief;
uniform float uShadow;
uniform float uAlpha;
uniform bool uPrint;
uniform vec2 uLightUv;

// Enough samples for a smooth shadow edge at badge sizes.
const int STEPS = 6;
/** The gilding is the only strong yellow in the artwork. */
const vec3 GOLD = vec3(1.15, 0.95, 0.55);
/** How much of the gilding's own colour survives into its highlight. */
const float METAL = 0.95;
/** Strength of the sky's highlight, against the sun's. */
const float SKY_STRENGTH = 0.5;
/** Schlick reflectance at normal incidence: wax barely reflects, gold does. */
const float WAX_F0 = 0.035;
const float METAL_F0 = 0.85;
/**
 * Grazing limits for wax, as 1 - n.z. Schlick's curve is nearly flat across the
 * angles this relief has, so the wax would glint everywhere or nowhere. These
 * bounds are cut to the measured angles: 60% of the wax lies between 5 and 10
 * degrees, which is its grain, and the flat field below stays at WAX_F0.
 */
const float GRAZE_FROM = 0.004;
const float GRAZE_TO = 0.09;
/** The narrow of the wax's two lobes, tight enough to pick out single grains. */
const float SPARKLE_TIGHTEN = 12.0;
/** Daylight from a window: cooler and softer than the sun. */
const vec3 SKY = vec3(0.55, 0.70, 0.92);
/**
 * The gilding takes a narrower lobe. The wax's must stay wide: the half-vector
 * never strays far from straight-on, so only flat faces satisfy a narrow lobe,
 * and those are the faces Fresnel removes.
 */
const float GOLD_TIGHTEN = 1.3;
/**
 * The gilding must read brighter than the wax even unlit, but its red channel is
 * already near the ceiling. Lifting only the dark channels buys the same
 * luminance and keeps the headroom for the highlight.
 */
const vec3 GOLD_LIFT = vec3(1.04, 1.22, 1.45);
/** The back of the seal: the same red, darker and unburnished, with no gilding. */
const vec3 BACK = vec3(0.58, 0.145, 0.115);

// The print model. A sticker is ink below a laminate, so nothing may key off
// hue (its colours are ink, not materials) and nothing may multiply the artwork
// up (print has no range above the ink the press applied).
/** The laminate is a dielectric: it reflects very little head-on. */
const float COAT_F0 = 0.045;
/** Its lobe is narrower than the wax's: a coat is smooth, wax has grain. */
const float COAT_TIGHTEN = 2.2;
/** Strength of the reflected sheet. The one term that moves. */
const float COAT_SHEEN = 0.34;
/** Radius of that reflection on the face, in seal widths. */
const float BAND = 0.44;
/** How much the print's relief bends the reflection crossing it. */
const float WARP = 0.4;
/** The back of the sticker: matt backing paper, no ink. */
const vec3 BACKING = vec3(0.82, 0.80, 0.76);

/**
 * March the height field towards the light and return how much of the ray is
 * buried. Distances are in UV units; heights stay 0-1 and uRelief scales them.
 */
float occlusion(vec2 uv, vec3 l, float h0) {
  float spread = length(l.xy);
  if (spread < 0.001) return 0.0;

  // UV space runs down, so the march inverts y.
  vec2 march = vec2(l.x, -l.y) / spread;
  float slope = l.z / spread;
  // Past this, nothing can be above the ray.
  float span = min(uRelief * (1.0 - h0) / max(slope, 0.001), uRelief * 4.0);

  float buried = 0.0;
  for (int i = 1; i <= STEPS; i++) {
    float t = span * float(i) / float(STEPS);
    float sampled = texture2D(uHeight, uv + march * t).r;
    buried = max(buried, sampled - (h0 + slope * t / uRelief));
  }
  return buried;
}

/** The window's own highlight: wide, weak, and the same under both materials. */
vec3 skyHighlight(vec3 n, vec3 v, float fresnel, float coverage) {
  vec3 halfway = normalize(normalize(vSky) + v);
  float spec = pow(max(dot(n, halfway), 0.0), uShininess * 0.5) * fresnel;
  return SKY * (spec * SKY_STRENGTH * uIntensity * coverage);
}

/** The face of the seal: wax, with the gilding told apart by hue. */
vec3 wax(vec3 albedo, float coverage, vec3 n, vec3 l, vec3 v, float lit) {
  vec3 halfway = normalize(l + v);

  float metal = smoothstep(0.32, 0.58, albedo.g / max(albedo.r, 0.001));

  // Half-Lambert. A plain dot(n, l) splits the seal into a lit and a dark half,
  // which reads as a lamp pointed at it.
  float diff = dot(n, l) * 0.5 + 0.5;
  diff *= diff;

  // Fresnel gates the highlight, it does not boost it. Ungated, the flat wax
  // mirrors the sun whenever it comes overhead and the whole seal washes pale
  // at any lobe width. Gated, the glints stay on the walls of the relief.
  float grazing = smoothstep(GRAZE_FROM, GRAZE_TO, 1.0 - clamp(dot(n, v), 0.0, 1.0));
  float f0 = mix(WAX_F0, METAL_F0, metal);
  float ndh = max(dot(n, halfway), 0.0);
  float grain = 0.3 * pow(ndh, uShininess) + pow(ndh, uShininess * SPARKLE_TIGHTEN);
  float lobe = mix(grain, pow(ndh, uShininess * GOLD_TIGHTEN), metal);
  float fresnel = f0 + (1.0 - f0) * grazing;
  float spec = lobe * fresnel;

  // The albedo already contains the occlusion, so light it directly. The
  // diffuse term peaks at 1.0 and no higher, which keeps the top of the range
  // for the highlight; overshoot pins the gilding at white.
  vec3 col = albedo * (uAmbient + (1.0 - uAmbient) * diff * lit)
    * mix(vec3(1.0), GOLD_LIFT, metal);
  col += mix(uSpecular, uSpecular * GOLD * METAL, metal) * (spec * lit * uIntensity * coverage);
  // The second light is wide and never sharp: a sheet of sky, not a point.
  col += skyHighlight(n, v, fresnel, coverage);
  return col;
}

/** The face of a sticker: flat ink below a glossy laminate. */
vec3 print(vec3 albedo, float coverage, vec3 n, vec3 l, vec3 v, float lit) {
  // Unsquared, unlike the wax's. A sticker is almost flat, so a steeper curve
  // only pumps the whole disc brighter and darker. The coat moves, not the ink.
  float diff = dot(n, l) * 0.5 + 0.5;
  vec3 col = albedo * (uAmbient + (1.0 - uAmbient) * diff * lit);

  // What moves across a glossy sticker is the image of the source in the
  // laminate, not a shading term, so it is placed in UV space from the light's
  // position rather than derived from an angle: a half-vector lobe on a flat
  // face is the same everywhere and can only pulse. The normal pushes the
  // lookup sideways, which is what makes the print show inside the sheen.
  vec2 seen = vUv + n.xy * WARP;
  float reach = 1.0 - smoothstep(0.0, BAND, length(seen - uLightUv));
  float sheet = reach * reach;

  // Schlick ungated: a few per cent across the flat face, rising to a bright
  // line at the cut edge where the vinyl turns away.
  float facing = 1.0 - clamp(dot(n, v), 0.0, 1.0);
  float fresnel = COAT_F0 + (1.0 - COAT_F0) * pow(facing, 5.0);
  float ndh = max(dot(n, normalize(l + v)), 0.0);
  float gloss = pow(ndh, uShininess * COAT_TIGHTEN);

  // Both coat terms are added white and weak; nothing multiplies the ink up.
  // Only the lobe is gated, so it lives on the rim. The reflected sheet is not:
  // a few per cent of a bright window is still the brightest thing on a
  // sticker, and gating it would clear it off the face it has to cross.
  col += uSpecular * ((sheet * COAT_SHEEN + gloss * fresnel) * lit * uIntensity * coverage);
  col += skyHighlight(n, v, fresnel, coverage);
  return col;
}

/** What the peel shows once it folds the seal over. */
vec3 underside(vec3 l) {
  if (uPrint) {
    // Backing paper: no ink, no impression, so the only thing to shade is the
    // curl, which is already in the normal from the vertex shader.
    return BACKING * (uAmbient + (1.0 - uAmbient) * (dot(vec3(0.0, 0.0, -1.0), l) * 0.5 + 0.5));
  }
  // Wax, almost flat, with the impression on the face showing faintly through.
  vec3 nb = normalize(vec3((texture2D(uNormal, vUv).xy * 2.0 - 1.0) * 0.22, -1.0));
  float back = dot(nb, l) * 0.5 + 0.5;
  float thickness = 0.78 + 0.34 * texture2D(uHeight, vUv).r;
  return BACK * thickness * (uAmbient + (1.0 - uAmbient) * back * back);
}

void main() {
  // Premultiplied on upload, which stops fringes at mipmapped edges.
  vec4 base = texture2D(uAlbedo, vUv);
  if (base.a < 0.004) discard;

  // The sun is far away, so all fragments share one direction; the vertex
  // shader has already put it in the right frame.
  vec3 l = normalize(vLight);
  vec3 v = normalize(vView);

  if (!gl_FrontFacing) {
    vec3 hidden = underside(l);
    gl_FragColor = vec4(hidden * base.a * uAlpha, base.a * uAlpha);
    return;
  }

  vec3 n = normalize(texture2D(uNormal, vUv).xyz * 2.0 - 1.0);

  // Both surfaces cast the same shadows: the height field is the height field.
  float lit = 1.0;
  if (uShadow > 0.0) {
    float buried = occlusion(vUv, l, texture2D(uHeight, vUv).r);
    lit = 1.0 - clamp(buried * 6.0, 0.0, 1.0) * uShadow;
  }

  vec3 col;
  if (uPrint) col = print(base.rgb, base.a, n, l, v, lit);
  else col = wax(base.rgb, base.a, n, l, v, lit);

  // Premultiplied throughout, so the fade scales colour and coverage alike.
  gl_FragColor = vec4(col * uAlpha, base.a * uAlpha);
}`

/**
 * A unit grid of triangles, wound counter-clockwise so `gl_FrontFacing` can tell
 * the seal's face from its back once the peel folds it over.
 */
function grid() {
  const side = GRID + 1
  const positions = new Float32Array(side * side * 2)
  for (let j = 0, v = 0; j < side; j++) {
    for (let i = 0; i < side; i++, v += 2) {
      positions[v] = i / GRID
      positions[v + 1] = j / GRID
    }
  }
  const indices = new Uint16Array(GRID * GRID * 6)
  for (let j = 0, n = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++, n += 6) {
      const a = j * side + i
      const b = a + 1
      const c = a + side + 1
      const d = a + side
      indices[n] = a
      indices[n + 1] = d
      indices[n + 2] = c
      indices[n + 3] = a
      indices[n + 4] = c
      indices[n + 5] = b
    }
  }
  return { positions, indices, count: indices.length }
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  return shader
}

function upload(gl: WebGLRenderingContext, image: TexImageSource, premultiply: boolean) {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

const assets = new Map<DesignName, Promise<TexImageSource[]>>()

/** The three textures of one design, in bind order. */
function loadAssets(design: DesignName) {
  let loading = assets.get(design)
  if (!loading) {
    const { albedo, normal, height } = DESIGNS[design]
    loading = Promise.all([albedo, normal, height].map(decode))
    assets.set(design, loading)
  }
  return loading
}

/** A missing or unknown name would leave the seal blank, so fall back. */
function known(design?: string | null): DesignName {
  return design != null && design in DESIGNS ? (design as DesignName) : DEFAULT_DESIGN
}

function decode(src: string): Promise<TexImageSource> {
  const image = new Image()
  image.src = src
  const bitmap = () => createImageBitmap(image)
  return image.decode().then<TexImageSource, TexImageSource>(bitmap, () => image)
}

export function createSeal(options: SealOptions = {}): Seal {
  let design = known(options.design)
  let size = options.size ?? DEFAULT_SIZE
  let mat = materialOf(design)

  const canvas = document.createElement('canvas')
  applyBox(canvas, size)

  const context = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    // A folded seal must hide the part below the fold.
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: 'low-power',
  })

  if (!context) return staticFallback(options)
  // Rebound, so the hoisted functions below see a context that cannot be null.
  const gl = context

  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return staticFallback(options)
  gl.useProgram(program)

  const mesh = grid()
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
  const aGrid = gl.getAttribLocation(program, 'aGrid')
  gl.enableVertexAttribArray(aGrid)
  gl.vertexAttribPointer(aGrid, 2, gl.FLOAT, false, 0, 0)

  // One lookup each, up front: getUniformLocation is a round trip to the driver.
  const u = Object.fromEntries(
    UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
  ) as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>
  for (const [unit, name] of ['uAlbedo', 'uNormal', 'uHeight'].entries()) {
    gl.uniform1i(gl.getUniformLocation(program, name), unit)
  }

  /** The uniforms a design fixes, so a frame does not resend them. */
  function useMaterial() {
    gl.uniform3f(u.uSpecular, ...mat.specular)
    gl.uniform1f(u.uShininess, mat.shininess)
    gl.uniform1f(u.uAmbient, mat.ambient)
    gl.uniform1f(u.uRelief, mat.relief)
    gl.uniform1f(u.uShadow, mat.shadow)
    gl.uniform1i(u.uPrint, mat.print ? 1 : 0)
  }

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.enable(gl.DEPTH_TEST)
  gl.uniform1f(u.uCamera, CAMERA)
  useMaterial()

  let ready = false
  let textures: WebGLTexture[] = []
  // Counts design switches, so a slow load knows it was superseded.
  let loading = 0
  let visible = true
  let disposed = false
  let frame = 0
  let last = 0

  // Light position in UV space, and the strength it is moving towards.
  let light: [number, number] = [...IDLE_LIGHT]
  let target: [number, number] = [...IDLE_LIGHT]
  let strength = mat.idle
  let targetStrength = mat.idle

  let rect: DOMRect | undefined
  let pointer: [number, number] = [NaN, NaN]

  // 0 seated, 1 gone. The canvas only grows while there is something to draw
  // outside the seal's own box.
  let progress = 0
  let span = 1
  // Checked once: reduced motion gets a plain fade, with no bending at all.
  const flat = reducedMotion()
  let pose: Pose = poseAt(0, flat)
  // Set from where the seal was clicked, so the wax lifts under the pointer.
  let sweep: readonly [number, number] = SWEEP
  let run: Run | undefined

  const measure = () => {
    rect = undefined
  }

  /**
   * The seal's own box, which is not the canvas's while the canvas is grown for
   * a peel. The light is aimed at the seal, not at the room it flies through.
   */
  function box() {
    const bounds = canvas.getBoundingClientRect()
    if (span === 1) return bounds
    const inset = (1 - 1 / span) / 2
    return new DOMRect(
      bounds.left + bounds.width * inset,
      bounds.top + bounds.height * inset,
      bounds.width / span,
      bounds.height / span,
    )
  }

  function setSpan(wanted: number) {
    if (wanted === span) return
    span = wanted
    applyBox(canvas, size, span)
    // Now, not on the ResizeObserver, or the first frame of a peel is stretched.
    resize()
  }

  function aim(x: number, y: number) {
    pointer = [x, y]
    rect ??= box()
    if (!rect.width || !rect.height || Number.isNaN(x)) {
      target = [...IDLE_LIGHT]
      targetStrength = mat.idle
      return schedule()
    }
    // Distance to the nearest point on the box, so the light is at full
    // strength anywhere over the seal itself.
    const dx = Math.max(rect.left - x, 0, x - rect.right)
    const dy = Math.max(rect.top - y, 0, y - rect.bottom)
    const distance = Math.hypot(dx, dy)
    const reach = 1 - Math.min(distance / FALLOFF, 1)
    // Ease the falloff so the light dies away smoothly.
    const k = reach * reach * (3 - 2 * reach)

    let u = (x - rect.left) / rect.width
    let v = (y - rect.top) / rect.height
    // Cap the travel, so grazing angles stay sane.
    const ox = u - 0.5
    const oy = v - 0.5
    const radius = Math.hypot(ox, oy)
    if (radius > MAX_LIGHT_RADIUS) {
      u = 0.5 + (ox / radius) * MAX_LIGHT_RADIUS
      v = 0.5 + (oy / radius) * MAX_LIGHT_RADIUS
    }

    target = [IDLE_LIGHT[0] + (u - IDLE_LIGHT[0]) * k, IDLE_LIGHT[1] + (v - IDLE_LIGHT[1]) * k]
    targetStrength = mat.idle + (1 - mat.idle) * k
    schedule()
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO)
    const width = Math.round(canvas.clientWidth * dpr)
    const height = Math.round(canvas.clientHeight * dpr)
    if (!width || !height) return
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      gl.viewport(0, 0, width, height)
    }
    measure()
    schedule()
  }

  function draw() {
    // The light's resting place becomes the one direction the sun arrives from.
    // Half-vectors are the fragment shader's job: on a bent seal they differ
    // across the surface.
    const x = light[0] - 0.5
    const y = 0.5 - light[1]
    const z = LIGHT_HEIGHT

    gl.uniform3f(u.uLight, ...unit(x, y, z))
    // The window sits opposite the sun and higher, and swings less, so the two
    // highlights cross rather than moving as one.
    gl.uniform3f(u.uSkyLight, ...unit(-x * 0.6, -y * 0.6, z * 1.9))
    gl.uniform2f(u.uSweep, sweep[0], sweep[1])
    gl.uniform1f(u.uSpan, span)
    gl.uniform1f(u.uFront, pose.front)
    gl.uniform1f(u.uRadius, pose.radius)
    gl.uniform1f(u.uBow, pose.bow)
    gl.uniform1f(u.uTip, pose.tip)
    gl.uniform1f(u.uPress, pose.press)
    gl.uniform1f(u.uAlpha, pose.alpha)
    gl.uniform1f(u.uIntensity, strength)
    // The print model places its reflection from where the light is, so it
    // needs the light in the seal's own UV space.
    gl.uniform2f(u.uLightUv, light[0], light[1])
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0)
  }

  function tick(now: number) {
    frame = 0
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0
    last = now
    const ease = 1 - Math.exp(-dt / TAU)
    light[0] += (target[0] - light[0]) * ease
    light[1] += (target[1] - light[1]) * ease
    strength += (targetStrength - strength) * ease

    if (run) {
      run.start ||= now
      const t = Math.min((now - run.start) / run.duration, 1)
      progress = run.from + (run.to - run.from) * run.ease(t)
      pose = poseAt(progress, flat)
      // The wax breaks partway through, not at the end, so the popup can start
      // opening while the seal is still in the air.
      if (run.broke && progress >= BREAK) {
        const broke = run.broke
        run.broke = undefined
        broke()
      }
      if (t === 1) {
        const settle = run.settle
        run = undefined
        setSpan(progress > 0 ? SPAN : 1)
        settle()
      }
    }

    draw()
    const settled =
      !run &&
      Math.abs(target[0] - light[0]) < 1e-4 &&
      Math.abs(target[1] - light[1]) < 1e-4 &&
      Math.abs(targetStrength - strength) < 1e-4
    if (settled) {
      light = [...target]
      strength = targetStrength
      last = 0
    } else {
      frame = requestAnimationFrame(tick)
    }
  }

  function schedule() {
    // A seal that has left has nothing to draw, so the pointer costs it nothing.
    if (!ready || !visible || disposed || frame || (!run && pose.alpha <= 0)) return
    frame = requestAnimationFrame(tick)
  }

  /** Take over from wherever the seal is now and animate to `to`. */
  function travel(to: number, duration: number, ease: Run['ease'], broke?: () => void) {
    run?.settle()
    // Only the distance still to cover, so a reseal that interrupts a peel does
    // not take the full time to come back from halfway.
    const remaining = Math.abs(to - progress) || 1
    if (to > 0 && !flat) setSpan(SPAN)
    return new Promise<void>((settle) => {
      run = { from: progress, to, start: 0, duration: duration * remaining, ease, broke, settle }
      last = 0
      schedule()
    })
  }

  /**
   * Bind a design's textures. The ones already up stay on screen until the new
   * ones decode, and `loading` drops a load that a later one has overtaken.
   */
  function useDesign(design: DesignName) {
    const token = ++loading
    void loadAssets(design).then((images) => {
      if (disposed || token !== loading) return
      for (const texture of textures) gl.deleteTexture(texture)
      // Only the albedo carries coverage, so only it wants premultiplying.
      textures = images.map((image, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        return upload(gl, image, unit === 0)
      })
      ready = true
      resize()
      // Re-aim now there is a live rect, in case the pointer already moved.
      if (!Number.isNaN(pointer[0])) aim(pointer[0], pointer[1])
      light = [...target]
      strength = targetStrength
      draw()
    })
  }

  // One switch for every subscription, thrown by `destroy`.
  const subscription = new AbortController()
  const passive: AddEventListenerOptions = { passive: true, signal: subscription.signal }
  window.addEventListener('pointermove', (event) => aim(event.clientX, event.clientY), passive)
  // The pointer left the window, so the light goes back to where it rests.
  document.documentElement.addEventListener('pointerleave', () => aim(NaN, NaN), passive)
  window.addEventListener('scroll', measure, { ...passive, capture: true })
  window.addEventListener('resize', measure, passive)

  const observers = [
    new ResizeObserver(resize),
    new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1]!.isIntersecting
      if (visible) schedule()
      else if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
        last = 0
      }
    }),
  ]
  for (const observer of observers) observer.observe(canvas)

  useDesign(design)

  return {
    element: canvas,
    get peeled() {
      return progress > 0
    },
    update(next) {
      if (next.size !== undefined && next.size !== size) applyBox(canvas, (size = next.size), span)
      // Naming no design goes back to the default, as it does at the start.
      const wanted = 'design' in next ? known(next.design) : design
      if (wanted !== design) {
        mat = materialOf((design = wanted))
        useMaterial()
        useDesign(design)
      }
      if (!Number.isNaN(pointer[0])) aim(pointer[0], pointer[1])
      else targetStrength = mat.idle
      schedule()
    },
    peel(broke, origin) {
      if (progress === 1) return Promise.resolve()
      sweep = sweepFrom(origin)
      // Linear: the shape of the peel is in the pose, not the clock.
      return travel(1, PEEL_MS, (t) => t, broke)
    },
    reseal() {
      if (progress === 0) return Promise.resolve()
      // Falls quickly and settles slowly, the way a dropped thing does.
      return travel(0, RESEAL_MS, (t) => 1 - (1 - t) ** 3)
    },
    destroy() {
      disposed = true
      run?.settle()
      run = undefined
      if (frame) cancelAnimationFrame(frame)
      subscription.abort()
      for (const observer of observers) observer.disconnect()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
  }
}

/**
 * Size the canvas. `span` is how many seal widths to lay out: more than 1 while
 * the seal is off the page, hung on negative margins so it does not move.
 */
function applyBox(element: HTMLElement, size: number | 'fill', span = 1) {
  const extent = size === 'fill' ? `${span * 100}%` : `${size * span}px`
  const bleed = (span - 1) / 2
  const margin = size === 'fill' ? `${bleed * 100}%` : `${size * bleed}px`
  // Grown, the canvas covers much more than the seal, so it must stop taking
  // the clicks meant for whatever is underneath.
  const grown = span === 1 ? '' : `;margin:-${margin};pointer-events:none`
  element.style.cssText = `display:block;width:${extent};height:${extent}${grown}`
}

/** No WebGL: show the flat artwork rather than nothing. */
function staticFallback(initial: SealOptions): Seal {
  let design = known(initial.design)
  let size = initial.size ?? DEFAULT_SIZE
  const img = new Image()
  img.src = DESIGNS[design].albedo
  img.alt = ''
  applyBox(img, size)
  let peeled = false

  // Nothing here can bend, so the seal just goes away and comes back.
  const fade = (to: number, ms: number) =>
    new Promise<void>((settle) => {
      img.style.transition = `opacity ${ms}ms ease`
      img.style.opacity = `${to}`
      setTimeout(settle, ms)
    })

  return {
    element: img,
    get peeled() {
      return peeled
    },
    update(next) {
      if ('design' in next) design = known(next.design)
      size = next.size ?? size
      img.src = DESIGNS[design].albedo
      applyBox(img, size)
    },
    peel(broke) {
      peeled = true
      broke?.()
      return fade(0, 200)
    },
    reseal() {
      peeled = false
      return fade(1, 200)
    },
    destroy() {
      img.remove()
    },
  }
}
