// D-pad on-screen keyboard for the Star sign-in rows.
//
// WHY THIS EXISTS. The Add-playlist screen was the only place in this app where text went
// through the PLATFORM keyboard, and on Fire OS that keyboard is a hostile input surface:
// it draws its own "type on your phone" QR over the screen, it can insert autofill/voice
// text, and its interaction with the D-pad put stray characters (%: Ūģi·os[0e,Jmx0r …) into
// the field while the viewer typed. None of that is under this app's control, so the only
// dependable fix is to stop using it here: this screen types with its OWN keyboard.
//
// It is deliberately self-contained. It does not register anything with the app's spatial
// navigation and it does not rely on native inputs — it keeps its own key index, moves it
// with the arrow keys, and swallows every key it handles so the page behind it never sees
// them. The focus it puts on a key is only for the visible highlight.

export type KeypadField = "code" | "user" | "pass"

export interface KeypadConfig {
  fields: { id: KeypadField; label: string; mask?: boolean }[]
  initial: Partial<Record<KeypadField, string>>
  onDone: (values: Record<KeypadField, string>) => void
}

export interface Keypad {
  destroy(): void
  open(field?: KeypadField): void
  close(): void
  isOpen(): boolean
  values(): Record<KeypadField, string>
  setValue(field: KeypadField, value: string): void
}

const ROWS: string[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "@"],
  ["z", "x", "c", "v", "b", "n", "m", ".", "-", "_"],
]

// The highlight is drawn from DOM :focus, not from a class this module toggles — the app's
// own spatial navigation also moves focus, and whichever of the two moves it, the viewer must
// SEE where the cursor is. (Reported: "I can't see which letter I'm on — I type from memory.")
const KEY_CLASS =
  "flex min-h-14 min-w-14 items-center justify-center rounded-xl border border-line bg-surface-2 px-2 text-xl font-semibold text-fg outline-none transition-colors " +
  "focus:bg-accent-soft focus:text-accent focus:ring-2 focus:ring-accent focus:border-accent"

export function mountStarKeypad(root: HTMLElement, config: KeypadConfig): Keypad {
  const values: Record<KeypadField, string> = {
    code: config.initial.code || "",
    user: config.initial.user || "",
    pass: config.initial.pass || "",
  }
  let active: KeypadField = config.fields[0]?.id || "user"
  let upper = false
  let keyIndex = 0
  let open = false

  const overlay = document.createElement("div")
  overlay.className =
    "fixed inset-0 z-50 hidden flex-col items-center justify-center gap-4 bg-black/90 p-6"
  overlay.setAttribute("role", "dialog")

  const title = document.createElement("div")
  title.className = "text-base font-semibold uppercase tracking-wider text-fg-3"

  const valueEl = document.createElement("div")
  valueEl.className =
    "min-h-12 w-full max-w-3xl truncate rounded-2xl border border-accent/40 bg-surface px-5 py-3 text-2xl font-semibold tracking-wide text-fg"

  const grid = document.createElement("div")
  grid.className = "flex flex-col items-center gap-2"

  const keyButtons: HTMLButtonElement[] = []
  const addKey = (parent: HTMLElement, label: string, onActivate: () => void, extraClass = "") => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = KEY_CLASS + (extraClass ? " " + extraClass : "")
    b.textContent = label
    // A focus key makes the app's own spatial navigation treat this as a first-class item
    // (and give it its own focus ring, which is what every other screen relies on).
    b.setAttribute("data-focus-key", "kp:" + label.toLowerCase().replace(/\s+/g, "-"))
    b.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      onActivate()
    })
    parent.appendChild(b)
    keyButtons.push(b)
    return b
  }

  const renderValue = () => {
    const field = config.fields.find((f) => f.id === active)
    title.textContent = field ? field.label : ""
    const value = values[active]
    valueEl.textContent = field?.mask ? "•".repeat(value.length) : value
  }

  const append = (ch: string) => {
    values[active] += upper ? ch.toUpperCase() : ch
    renderValue()
  }
  const backspace = () => {
    values[active] = values[active].slice(0, -1)
    renderValue()
  }

  for (const row of ROWS) {
    const rowEl = document.createElement("div")
    rowEl.className = "flex items-center justify-center gap-2"
    for (const ch of row) addKey(rowEl, ch, () => append(ch))
    grid.appendChild(rowEl)
  }

  const actions = document.createElement("div")
  actions.className = "flex items-center justify-center gap-2"
  addKey(actions, "Space", () => append(" "), "min-w-32")
  addKey(actions, "Delete", backspace, "min-w-28")
  addKey(actions, "Clear", () => {
    values[active] = ""
    renderValue()
  }, "min-w-24")
  const caseBtn = addKey(actions, "ABC", () => {
    upper = !upper
    caseBtn.textContent = upper ? "abc" : "ABC"
  }, "min-w-20")
  addKey(actions, "Done", () => close(true), "min-w-24")
  addKey(actions, "Cancel", () => close(false), "min-w-28")
  grid.appendChild(actions)

  overlay.append(title, valueEl, grid)
  root.appendChild(overlay)

  function highlight() {
    keyButtons.forEach((b, i) => {
      if (i === keyIndex) {
        b.classList.add("ring-2", "ring-accent", "bg-accent-soft", "text-accent")
      } else {
        b.classList.remove("ring-2", "ring-accent", "bg-accent-soft", "text-accent")
      }
    })
    keyButtons[keyIndex]?.focus({ preventScroll: true })
  }

  // Column sizes differ per row, so the same visual column is a different array index on
  // each row. Moving by the SHORTEST step that lands in the requested column keeps the
  // cursor's horizontal position stable enough for a remote.
  function move(dx: number, dy: number) {
    const cols = ROWS[0].length
    const total = ROWS.length * cols
    const actionRowStart = total
    if (keyIndex >= actionRowStart) {
      if (dy < 0) keyIndex = Math.max(0, Math.min(total - 1, (keyIndex - actionRowStart) * cols))
      else keyIndex = Math.min(keyButtons.length - 1, keyIndex + dx)
      return highlight()
    }
    const row = Math.floor(keyIndex / cols)
    const col = keyIndex % cols
    if (dy !== 0) {
      const nextRow = Math.max(0, Math.min(ROWS.length - 1, row + dy))
      keyIndex = nextRow * cols + col
      return highlight()
    }
    const size = ROWS[row].length
    const nextCol = (col + dx + size) % size
    keyIndex = row * cols + nextCol
    highlight()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return
    const handled = () => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    switch (event.key) {
      case "ArrowLeft": handled(); move(-1, 0); return
      case "ArrowRight": handled(); move(1, 0); return
      case "ArrowUp": handled(); move(0, -1); return
      case "ArrowDown": handled(); move(0, 1); return
      case "Enter":
      case " ":
        handled()
        keyButtons[keyIndex]?.click()
        return
      case "Backspace":
        handled()
        backspace()
        return
      case "Escape":
        handled()
        close(false)
        return
      default:
        break
    }
    // A physical keyboard (or a remote that types) still works: one printable character
    // appends itself instead of being sent to a hidden input.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      handled()
      append(event.key)
    }
  }

  // WINDOW capture, not document capture: the app's own spatial navigation listens on the
  // document in the capture phase, and a document listener registered later would run after
  // it — the arrow keys would move the page's focus before this one could swallow them.
  window.addEventListener("keydown", onKeyDown, true)

  function close(done: boolean) {
    open = false
    overlay.classList.add("hidden")
    overlay.classList.remove("flex")
    for (const child of Array.from(root.children)) child.removeAttribute("inert")
    if (done) config.onDone({ ...values })
    renderValue()
  }

  function openFor(field?: KeypadField) {
    if (field) active = field
    open = true
    keyIndex = 0
    renderValue()
    overlay.classList.remove("hidden")
    overlay.classList.add("flex")
    // Nothing behind the keyboard may take focus: with every other child inert, both this
    // module's cursor and the app's spatial navigation stay inside the key grid.
    for (const child of Array.from(root.children)) {
      if (child !== overlay) child.setAttribute("inert", "")
    }
    highlight()
  }

  renderValue()

  return {
    destroy() {
      window.removeEventListener("keydown", onKeyDown, true)
      overlay.remove()
    },
    open: openFor,
    close: () => close(false),
    isOpen: () => open,
    values: () => ({ ...values }),
    setValue(field: KeypadField, value: string) {
      values[field] = value
      renderValue()
    }
  }
}
