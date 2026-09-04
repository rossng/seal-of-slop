/**
 * The popup that opens when the seal comes off the page. A `<dialog>` for the
 * focus trap, the Escape key and the top layer, inside a shadow root so that
 * the styles of the host page cannot reach it.
 */

const STYLE = `
  :host { all: initial }
  dialog {
    border: 0;
    padding: 0;
    width: min(34rem, calc(100vw - 2.5rem));
    color: #453729;
    background: radial-gradient(130% 100% at 50% 0%, #fdf7e9 0%, #f3e9d2 55%, #e7d9ba 100%);
    box-shadow: 0 1px 0 rgba(255, 250, 238, .6) inset, 0 30px 70px -18px rgba(28, 17, 6, .6);
    font: 1.05rem/1.75 "Iowan Old Style", Palatino, "Hoefler Text", Georgia, serif;
    opacity: 0;
    transform-origin: 50% -30%;
    transform: perspective(1600px) rotateX(-11deg) translateY(-10px);
    transition:
      opacity .38s ease,
      transform .52s cubic-bezier(.2, .85, .28, 1),
      overlay .4s allow-discrete,
      display .4s allow-discrete;
  }
  dialog[open] { opacity: 1; transform: none }
  @starting-style {
    dialog[open] { opacity: 0; transform: perspective(1600px) rotateX(-11deg) translateY(-10px) }
  }
  dialog::backdrop {
    background: rgba(28, 19, 10, .55);
    backdrop-filter: blur(3px);
    opacity: 0;
    transition: opacity .4s ease, overlay .4s allow-discrete, display .4s allow-discrete;
  }
  dialog[open]::backdrop { opacity: 1 }
  @starting-style { dialog[open]::backdrop { opacity: 0 } }

  /* On the dialog, not the sheet, so it does not move when long text scrolls. */
  dialog::after {
    content: ""; position: absolute; inset: 11px; pointer-events: none;
    border: 1px solid rgba(120, 92, 52, .28);
    box-shadow: 0 0 0 3px rgba(120, 92, 52, .09) inset;
  }

  article {
    padding: clamp(2rem, 5vw, 3rem) clamp(1.75rem, 6vw, 3.25rem);
    max-height: calc(100vh - 4rem);
    overflow: auto;
  }

  p { margin: 0 0 1.15em; text-align: justify; hyphens: auto }
  p:last-of-type { margin-bottom: 0 }
  p:first-of-type::first-letter {
    float: left; font-size: 3.4em; line-height: .78; padding: .04em .09em 0 0; opacity: .85;
  }

  button {
    position: absolute; top: 1rem; right: 1rem; z-index: 1;
    border: 0; background: none; cursor: pointer;
    font: 1.5rem/1 inherit; color: inherit; opacity: .4; padding: .25rem .4rem;
  }
  button:hover, button:focus-visible { opacity: .9 }
  button:focus-visible {
    outline: 2px solid rgba(120, 92, 52, .75); outline-offset: 1px; border-radius: 3px;
  }

  @media (prefers-reduced-motion: reduce) {
    dialog, dialog::backdrop { transition-duration: .01ms }
    dialog[open] { transform: none }
  }
`

/**
 * Show `text`, then call `closed` when the reader closes the popup. An empty
 * line starts a paragraph. The text is set as text, never as HTML.
 */
export function openPopup(text: string, closed: () => void) {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = STYLE

  const dialog = document.createElement('dialog')
  const sheet = document.createElement('article')
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', 'Close')
  close.addEventListener('click', () => dialog.close())

  for (const paragraph of text.split(/\n\s*\n/)) {
    const p = document.createElement('p')
    p.textContent = paragraph.trim().replace(/\s*\n\s*/g, ' ')
    if (p.textContent) sheet.append(p)
  }
  dialog.append(close, sheet)

  // The dialog itself is only the area around the sheet.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => {
    host.remove()
    closed()
  })

  root.append(style, dialog)
  document.body.append(host)
  dialog.showModal()
}
