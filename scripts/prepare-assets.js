// Converts the four source renders of each design into three WebP textures,
// inlined as data URLs in src/assets.ts:
//
//   albedo  rgb = albedo x occlusion, a = coverage
//   normal  rgb = tangent-space normal (OpenGL, +Y up)
//   height  greyscale height, for the light's self-shadowing
//
// A design is any `<name>-albedo.png` in `art/`, with `<name>-normal.png`,
// `<name>-height.png` and `<name>-occlusion.png` beside it. The sources are
// flat RGB PNGs on a checkerboard of two neutral greys, which the render puts
// there in place of transparency. The silhouette is keyed from the albedo:
// parts of the height and occlusion maps are near-white or near-black and would
// key against themselves.
//
// Height is a separate greyscale file rather than an alpha channel. libwebp
// codes alpha losslessly, which costs more for one smooth gradient than the
// whole normal map costs lossy.
import { readdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const SIZE = 512
const CHROMA_THRESHOLD = 12 // channel spread that counts as not background
const VALUE_THRESHOLD = 228 // a pixel this dark is artwork, at any saturation
const BLEED = 12 // pixels pushed past the silhouette, to kill edge halos
const AO_STRENGTH = 1 // how much occlusion is baked into the albedo
const SPECK = 1e-4 // a mask blob smaller than this share of the frame is noise
const REAL = 0.1 // a blob at least this big is the design, wherever it sits
const DEFAULT_DESIGN = 'seal' // used when none is named
const ART = 'art' // where the source renders live

const raw = async (file) => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

/** The silhouette of the seal, keyed against the grey checkerboard. */
function keyMask({ data, width, height, channels }) {
  const mask = new Uint8Array(width * height)
  for (let p = 0; p < mask.length; p++) {
    const i = p * channels
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    mask[p] = chroma > CHROMA_THRESHOLD || Math.min(r, g, b) < VALUE_THRESHOLD ? 1 : 0
  }
  return mask
}

/**
 * Drop noise: render grain and the vignette along the frame's border key as
 * artwork, and would survive the downscale as marks beside the design. A blob
 * goes if it is smaller than SPECK of the frame, or if it touches the border,
 * which nothing real does. Both tests spare anything big enough to be a design.
 */
function despeckle(mask, width, height) {
  const seen = new Uint8Array(mask.length)
  const limit = SPECK * width * height
  const keep = REAL * width * height
  const stack = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const component = []
    let borders = false
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const p = stack.pop()
      component.push(p)
      const x = p % width
      const y = (p - x) / width
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) borders = true
      if (x > 0) push(p - 1)
      if (x < width - 1) push(p + 1)
      if (y > 0) push(p - width)
      if (y < height - 1) push(p + width)
    }
    const noise = component.length < limit || (borders && component.length < keep)
    if (noise) for (const p of component) mask[p] = 0
  }
  return mask

  function push(q) {
    if (mask[q] && !seen[q]) {
      seen[q] = 1
      stack.push(q)
    }
  }
}

/** Make a mask one pixel smaller, with a 4-pixel neighbourhood. */
function erode(mask, width, height) {
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (!mask[p]) continue
      const up = y > 0 ? mask[p - width] : 0
      const down = y < height - 1 ? mask[p + width] : 0
      const left = x > 0 ? mask[p - 1] : 0
      const right = x < width - 1 ? mask[p + 1] : 0
      out[p] = up && down && left && right ? 1 : 0
    }
  }
  return out
}

/**
 * Dilate a map into the background, so the downscale never averages seal pixels
 * with checkerboard, and the shadow march can step past the rim.
 */
function bleed({ data, width, height, channels }, mask, rounds) {
  const rgb = new Uint8ClampedArray(width * height * 3)
  for (let p = 0; p < width * height; p++) {
    const i = p * channels
    rgb[p * 3] = data[i]
    rgb[p * 3 + 1] = data[i + 1]
    rgb[p * 3 + 2] = data[i + 2]
  }
  let filled = Uint8Array.from(mask)
  const neighbours = [[-1, 0], [1, 0], [0, -1], [0, 1]]
  for (let round = 0; round < rounds; round++) {
    const next = Uint8Array.from(filled)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x
        if (filled[p]) continue
        let r = 0, g = 0, b = 0, n = 0
        for (const [dx, dy] of neighbours) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const q = ny * width + nx
          if (!filled[q]) continue
          r += rgb[q * 3]; g += rgb[q * 3 + 1]; b += rgb[q * 3 + 2]; n++
        }
        if (!n) continue
        rgb[p * 3] = r / n; rgb[p * 3 + 1] = g / n; rgb[p * 3 + 2] = b / n
        next[p] = 1
      }
    }
    filled = next
  }
  return Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length)
}

/** Bleed a map, then downscale it to SIZE. Returns interleaved RGB. */
async function shrink(image, core, width, height) {
  return sharp(bleed(image, core, BLEED), { raw: { width, height, channels: 3 } })
    .resize(SIZE, SIZE, { kernel: 'lanczos3' })
    .raw()
    .toBuffer()
}

/** Build the three textures of one design from its four source renders. */
async function buildDesign(design) {
  const [albedo, normal, heightMap, occlusion] = await Promise.all(
    ['albedo', 'normal', 'height', 'occlusion'].map((map) => raw(`${ART}/${design}-${map}.png`)),
  )
  const { width, height } = albedo
  for (const map of [normal, heightMap, occlusion]) {
    if (map.width !== width || map.height !== height) {
      throw new Error(`${design}: source maps differ in size`)
    }
  }

  const mask = despeckle(keyMask(albedo), width, height)
  const core = erode(erode(mask, width, height), width, height)

  // Occlusion is baked into the albedo rather than sampled separately: it only
  // multiplies the ambient term, and the artwork's ambient is its albedo.
  const shaded = { ...albedo, data: Buffer.from(albedo.data) }
  for (let p = 0; p < width * height; p++) {
    const ao = 1 - AO_STRENGTH * (1 - occlusion.data[p * occlusion.channels] / 255)
    for (let c = 0; c < 3; c++) {
      shaded.data[p * shaded.channels + c] = Math.round(albedo.data[p * albedo.channels + c] * ao)
    }
  }

  const [albedoSmall, normalSmall, heightSmall] = await Promise.all(
    [shaded, normal, heightMap].map((map) => shrink(map, core, width, height)),
  )

  // sharp expands a 1-channel raw input to 3 on the way out, so use its stride.
  const coverage = await sharp(Buffer.from(mask.map((v) => v * 255)), {
    raw: { width, height, channels: 1 },
  })
    .resize(SIZE, SIZE, { kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const rgba = Buffer.alloc(SIZE * SIZE * 4)
  for (let p = 0; p < SIZE * SIZE; p++) {
    rgba[p * 4] = albedoSmall[p * 3]
    rgba[p * 4 + 1] = albedoSmall[p * 3 + 1]
    rgba[p * 4 + 2] = albedoSmall[p * 3 + 2]
    rgba[p * 4 + 3] = coverage.data[p * coverage.info.channels]
  }

  const grey = Buffer.alloc(SIZE * SIZE)
  for (let p = 0; p < SIZE * SIZE; p++) grey[p] = heightSmall[p * 3]

  const [albedoOut, normalOut, heightOut] = await Promise.all([
    sharp(rgba, { raw: { width: SIZE, height: SIZE, channels: 4 } })
      .webp({ quality: 86, alphaQuality: 100, effort: 6 })
      .toBuffer(),
    // Normal maps band under lossy compression, and bands read as facets once
    // lit, so this keeps more quality than the height map's soft shadow needs.
    sharp(normalSmall, { raw: { width: SIZE, height: SIZE, channels: 3 } })
      .webp({ quality: 86, effort: 6, smartSubsample: false })
      .toBuffer(),
    sharp(grey, { raw: { width: SIZE, height: SIZE, channels: 1 } })
      .webp({ quality: 80, effort: 6 })
      .toBuffer(),
  ])

  return { albedo: albedoOut, normal: normalOut, height: heightOut }
}

const designs = (await readdir(ART))
  .map((file) => /^(.+)-albedo\.png$/.exec(file)?.[1])
  .filter(Boolean)
  .sort()
if (!designs.includes(DEFAULT_DESIGN)) {
  throw new Error(`no sources for the default design "${DEFAULT_DESIGN}"`)
}

const built = Object.fromEntries(
  await Promise.all(designs.map(async (design) => [design, await buildDesign(design)])),
)

const b64 = (b) => `data:image/webp;base64,${b.toString('base64')}`
// Bare keys where the name allows it, quoted where it does not.
const key = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name))
const DOC = {
  albedo: 'rgb = albedo x occlusion, a = coverage.',
  normal: 'rgb = tangent-space normal, OpenGL convention (+Y up).',
  height: 'The greyscale height, which the shader uses to shadow the relief.',
}
const maps = (m) =>
  Object.entries(DOC).map(([k, doc]) => `    /** ${doc} */\n    ${k}: '${b64(m[k])}',`)

await writeFile(
  'src/assets.ts',
  `// Generated by scripts/prepare-assets.js. Do not edit.

/** The three textures of one design, as data URLs. */
export interface DesignTextures {
${Object.keys(DOC).map((k) => `  ${k}: string`).join('\n')}
}

/** Every design in the package, by name. */
export const DESIGNS = {
${Object.entries(built).map(([d, m]) => `  ${key(d)}: {\n${maps(m).join('\n')}\n  },`).join('\n')}
} satisfies Record<string, DesignTextures>

/** The design to use if you name none. */
export const DEFAULT_DESIGN = ${JSON.stringify(DEFAULT_DESIGN)}

/** The name of a design in the package. */
export type DesignName = keyof typeof DESIGNS
`,
)

for (const [design, textures] of Object.entries(built)) {
  for (const [map, buffer] of Object.entries(textures)) {
    console.log(`${design.padEnd(8)} ${map.padEnd(7)} ${SIZE}px  ${(buffer.length / 1024).toFixed(1)} KB`)
  }
}
