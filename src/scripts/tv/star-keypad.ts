// D-pad on-screen keyboard for the Star sign-in rows.
//
// WHY THIS EXISTS. The Add-playlist screen was the only place in this app where text went
// through the PLATFORM keyboard, and on Fire OS that keyboard is a hostile input surface: it
// draws its own "type on your phone" QR over the screen, it can insert autofill/voice text,
// and its interaction with the D-pad put stray characters (%: Ūģi·os[0e,Jmx0r …) into the
// field while the viewer typed. None of that is under this app's control, so the only
// dependable fix is to stop using it here: this screen types with its OWN keyboard.
//
// CURSOR AND THE ACTION ROW. Two things had to be true before this was usable with a remote:
// the cursor must be VISIBLE (a focus ring on the focused key, whichever code moved the
// focus), and the ACTION row — Space / Delete / Clear / ABC / Done / Cancel — must be
// REACHABLE with the arrow keys. The first version clamped vertical movement inside the letter
// grid, so the row below it could not be reached at all and the field could not be confirmed.
// Rows are therefore modelled explicitly.

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

const GRID_ROWS: string[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "@"],
  ["z", "x", "c", "v", "b", "n", "m", ".", "-", "_"],
]

const KEY_CLASS =
  "flex min-h-14 min-w-14 items-center justify-center rounded-xl border border-line bg-surface-2 px-2 text-xl font-semibold text-fg outline-none transition-colors " +
  "focus:bg-accent-soft focus:text-accent focus:ring-2 focus:ring-accent focus:border-accent"

interface RowRef {
  el: HTMLDivElement
  keys: HTMLButtonElement[]
}

export function mountStarKeypad(root: HTMLElement, config: KeypadConfig): Keypad {
  const values: Record<KeypadField, string> = {
    code: config.initial.code || "",
    user: config.initial.user || "",
    pass: config.initial.pass || "",
  }
  let active: KeypadField = config.fields[0]?.id || "user"
  let upper = false
  let open = false
  const rows: RowRef[] = []
  let cursorRow = 0
  let cursorCol = 0

  const overlay = document.createElement("div")
  overlay.className =
    "fixed inset-0 z-50 hidden flex-col items-center justify-center gap-4 bg-black/90 p-6"
  overlay.setAttribute("role", "dialog")

  const title = document.createElement("div")
  title.className = "text-base font-semibold uppercase tracking-wider text-fg-3"

  const valueEl = document.createElement("div")
  valueEl.className =
    "min-h-12 w-full max-w-3xl truncate rounded-2xl border border-accent/40 bg-surface px-5 py-3 text-2xl font-semibold tracking-wide text-fg"

  const hint = document.createElement("div")
  hint.className = "text-sm text-fg-3"
  hint.textContent = "Strelice: kretanje · OK: upiši znak · Delete: briši · Done: potvrdi"

  const grid = document.createElement("div")
  grid.className = "flex flex-col items-center gap-2"

  function addRow(): RowRef {
    const el = document.createElement("div")
    el.className = "flex items-center justify-center gap-2"
    grid.appendChild(el)
    const ref: RowRef = { el, keys: [] }
    rows.push(ref)
    return ref
  }

  function addKey(row: RowRef, label: string, onActivate: () => void, extraClass = "") {
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
    row.el.appendChild(b)
    row.keys.push(b)
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

  for (const row of GRID_ROWS) {
    const ref = addRow()
    for (const ch of row) addKey(ref, ch, () => append(ch))
  }

  const actionRow = addRow()
  addKey(actionRow, "Space", () => append(" "), "min-w-32")
  addKey(actionRow, "Delete", backspace, "min-w-28")
  addKey(actionRow, "Clear", () => {
    values[active] = ""
    renderValue()
  }, "min-w-24")
  const caseBtn = addKey(actionRow, "ABC", () => {
    upper = !upper
    caseBtn.textContent = upper ? "abc" : "ABC"
  }, "min-w-20")
  addKey(actionRow, "Done", () => close(true), "min-w-24")
  addKey(actionRow, "Cancel", () => close(false), "min-w-28")

  overlay.append(title, hint, valueEl, grid)
  root.appendChild(overlay)

  function focusCursor() {
    const row = rows[cursorRow]
    if (!row || !row.keys.length) return
    cursorCol = Math.max(0, Math.min(cursorCol, row.keys.length - 1))
    const btn = row.keys[cursorCol]
    for (const r of rows) {
      for (const b of r.keys) {
        if (b === btn) b.classList.add("ring-2", "ring-accent", "bg-accent-soft", "text-accent")
        else b.classList.remove("ring-2", "ring-accent", "bg-accent-soft", "text-accent")
      }
    }
    btn.focus({ preventScroll: true })
  }

  function move(dx: number, dy: number) {
    if (dy !== 0) {
      cursorRow = Math.max(0, Math.min(rows.length - 1, cursorRow + dy))
    } else {
      const len = rows[cursorRow]?.keys.length || 1
      cursorCol = (cursorCol + dx + len) % len
    }
    focusCursor()
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
        rows[cursorRow]?.keys[cursorCol]?.click()
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
    cursorRow = 0
    cursorCol = 0
    renderValue()
    overlay.classList.remove("hidden")
    overlay.classList.add("flex")
    // Nothing behind the keyboard may take focus: with every other child inert, both this
    // module's cursor and the app's spatial navigation stay inside the key grid.
    for (const child of Array.from(root.children)) {
      if (child !== overlay) child.setAttribute("inert", "")
    }
    focusCursor()
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
