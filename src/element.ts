import { createSeal, type Seal } from './seal.js'
import { openPopup } from './popup.js'

/**
 * `<seal-of-slop size="128" design="seal" text="…">`
 *
 * `size` is in CSS pixels, `design` is `seal` or `sticker`, and `text` is the
 * popup. With `text` the seal is a button that peels off the page and opens the
 * popup; without it the seal is decoration. Position it with CSS.
 */
export class SealOfSlopElement extends HTMLElement {
  static observedAttributes = ['size', 'design', 'text']

  #seal: Seal | undefined
  #open = false

  connectedCallback() {
    if (this.#seal) return
    this.#apply()
    this.#seal = createSeal({ size: 'fill', design: this.getAttribute('design') })
    this.append(this.#seal.element)
    this.addEventListener('click', this.#activate)
    this.addEventListener('keydown', this.#key)
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.#activate)
    this.removeEventListener('keydown', this.#key)
    this.#seal?.destroy()
    this.#seal = undefined
  }

  attributeChangedCallback() {
    if (!this.#seal) return
    this.#apply()
    this.#seal.update({ design: this.getAttribute('design') })
  }

  #text() {
    return this.getAttribute('text')?.trim() ?? ''
  }

  #activate = (event: MouseEvent) => {
    // A click from the keyboard has no position, so the curl starts by default.
    const box = this.getBoundingClientRect()
    if (!event.detail || !box.width || !box.height) return void this.#peel()
    this.#peel([(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height])
  }

  #key = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault() // the space key would scroll the page
    this.#peel()
  }

  /** Peel, and open the popup as the wax breaks, while the seal still moves. */
  #peel(origin?: [number, number]) {
    const seal = this.#seal
    const text = this.#text()
    if (!seal || !text || this.#open) return
    this.#open = true
    this.style.pointerEvents = 'none' // it should not be clickable in mid-air
    void seal.peel(() => {
      openPopup(text, () => {
        this.#open = false
        void seal.reseal().then(() => {
          this.style.pointerEvents = ''
        })
      })
    }, origin)
  }

  #apply() {
    const size = Number(this.getAttribute('size'))
    const extent = Number.isFinite(size) && size > 0 ? size : 128
    const interactive = this.#text() !== ''
    this.style.display = 'inline-block'
    this.style.width = `${extent}px`
    this.style.height = `${extent}px`
    this.style.cursor = interactive ? 'pointer' : ''
    this.setAttribute('role', interactive ? 'button' : 'img')
    this.setAttribute('aria-label', interactive ? 'About this page' : 'Seal of Slop')
    if (interactive && !this.hasAttribute('tabindex')) this.tabIndex = 0
  }
}

if (!customElements.get('seal-of-slop')) customElements.define('seal-of-slop', SealOfSlopElement)
