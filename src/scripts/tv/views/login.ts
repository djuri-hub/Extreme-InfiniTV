// Add-playlist form: paste a link or fill Xtream/M3U fields by hand.
import type { TvView, TvViewContext } from "@/scripts/tv/router"
import { t, applyI18nDOM, LOCALE_EVENT } from "@/scripts/lib/i18n"
import { navigate } from "astro:transitions/client"
import { addEntry, getEntries, resolveServerScheme, resolveM3UScheme } from "@/scripts/lib/creds.js"
import { parsePlaylistLinks, type ParsedXtreamCandidate } from "@/scripts/lib/playlist-link"
import { toastSuccess, toastWarn } from "@/scripts/lib/toast"

type Method = "xtream" | "m3u"

interface XtreamTestResult {
  status: "active" | "expired" | "inactive" | "unavailable"
  reason?: string
  httpStatus?: number
}

interface M3UTestResult {
  status: "active" | "unavailable"
  reason?: string
  httpStatus?: number
}

interface Refs {
  form: HTMLFormElement
  methodXtream: HTMLButtonElement
  methodM3u: HTMLButtonElement
  pasteInput: HTMLInputElement
  mirrorHint: HTMLElement
  xtreamFields: HTMLElement
  serverUrlInput: HTMLInputElement
  usernameInput: HTMLInputElement
  passwordInput: HTMLInputElement
  togglePasswordBtn: HTMLButtonElement
  m3uFields: HTMLElement
  m3uUrlInput: HTMLInputElement
  epgUrlInput: HTMLInputElement
  nameInput: HTMLInputElement
  statusEl: HTMLElement
  cancelBtn: HTMLButtonElement
  connectBtn: HTMLButtonElement
  // Star sign-in (this operator's own service) — the TV counterpart of the "Star nalog"
  // card the phone page has carried since the operator build.
  starCode: HTMLInputElement
  starUser: HTMLInputElement
  starPass: HTMLInputElement
  starBtn: HTMLButtonElement
  starMsg: HTMLElement
}

const TV_INPUT_CLASS =
  "min-h-11 w-full rounded-2xl border border-line bg-surface-2 px-5 text-base text-fg placeholder:text-fg-3 outline-none tv-focus-inset"

const TV_LABEL_CLASS = "text-sm font-semibold uppercase tracking-wider text-fg-3"

const XTREAM_REASON_KEY: Record<string, string> = {
  unreachable: "login.status.unreachable",
  timeout: "login.status.timeout",
  cors: "login.status.corsBlocked",
  auth_rejected: "login.status.badCredentials",
  not_found: "login.status.notFound",
  rate_limited: "login.status.rateLimited",
  server_error: "login.status.httpError",
  http_error: "login.status.httpError",
  bad_response: "login.status.badResponseXtream",
  unknown: "login.status.serverUnreachable",
}

const M3U_REASON_KEY: Record<string, string> = {
  unreachable: "login.status.unreachable",
  timeout: "login.status.timeout",
  cors: "login.status.corsBlocked",
  not_found: "login.status.notFound",
  rate_limited: "login.status.rateLimited",
  server_error: "login.status.httpError",
  http_error: "login.status.httpError",
  bad_response: "login.status.badResponseM3U",
  unknown: "login.status.playlistFetchFailed",
}

function describeXtreamResult(result: XtreamTestResult): string {
  if (result.status === "active") return t("login.status.connected")
  if (result.status === "expired") return t("login.status.expired")
  if (result.status === "inactive") return t("login.status.inactive")
  const reasonKey = (result.reason && XTREAM_REASON_KEY[result.reason]) || "login.status.serverUnreachable"
  return t(reasonKey, result.httpStatus != null ? { status: String(result.httpStatus) } : undefined)
}

function describeM3UResult(result: M3UTestResult): string {
  const reasonKey = (result.reason && M3U_REASON_KEY[result.reason]) || "login.status.playlistFetchFailed"
  return t(reasonKey, result.httpStatus != null ? { status: String(result.httpStatus) } : undefined)
}

function buildMarkup(): string {
  return `
    <div class="flex h-full items-center justify-center overflow-y-auto">
      <div class="mx-auto flex w-full max-w-2xl flex-col gap-5 py-4">
        <header class="flex flex-col gap-2">
          <h1 data-i18n="login.title.add" class="text-2xl font-semibold text-fg">Add a playlist</h1>
          <p data-i18n="tv.login.subtitle" class="text-sm text-fg-3">
            Paste a playlist link, or enter your provider's details below.
          </p>
        </header>

        <!-- Star sign-in: THIS deployment's own service. Pairing code + account; the origin
             answers with that account's playlist URL. Kept at the TOP, above the generic
             Xtream/M3U methods, because it is the normal path for this build — the phone page
             has had this card all along and the TV view was missing it, which left a
             television with no way to reach our panel at all. -->
        <section class="rounded-2xl border border-line bg-surface p-5">
          <h2 class="text-base font-semibold uppercase tracking-wider text-fg-3">Star nalog</h2>
          <p class="mt-1 text-sm leading-relaxed text-fg-3">
            Upiši paring kod svog servisa, pa korisničko ime i lozinku.
          </p>
          <div class="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <label class="flex flex-col gap-2">
              <span class="${TV_LABEL_CLASS}">Paring kod</span>
              <input data-role="star-code" data-focus-key="star:code" type="text"
                     autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX"
                     class="${TV_INPUT_CLASS}" />
            </label>
            <label class="flex flex-col gap-2">
              <span class="${TV_LABEL_CLASS}">Korisnik</span>
              <input data-role="star-user" data-focus-key="star:user" type="text"
                     autocomplete="off" spellcheck="false" class="${TV_INPUT_CLASS}" />
            </label>
            <label class="flex flex-col gap-2">
              <span class="${TV_LABEL_CLASS}">Lozinka</span>
              <input data-role="star-pass" data-focus-key="star:pass" type="password"
                     autocomplete="current-password" class="${TV_INPUT_CLASS}" />
            </label>
          </div>
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" data-role="star-signin" data-focus-key="star:signin"
                    class="btn-primary min-h-11 px-8 text-base tv-focus-inset">Prijavi se</button>
            <span data-role="star-msg" class="text-sm text-fg-3" role="status" aria-live="polite"></span>
          </div>
        </section>

        <div role="tablist" class="grid grid-cols-2 gap-2 rounded-2xl border border-line bg-surface p-1.5">
          <button type="button" data-role="method-xtream" role="tab" data-focus-key="method:xtream" data-tv-autofocus
                  class="flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl px-4 text-center outline-none transition-colors">
            <span data-i18n="login.tab.subscription" class="text-base font-medium">I have a subscription</span>
            <span data-i18n="login.tab.subscription.sub" class="text-xs font-medium uppercase tracking-wider opacity-70">Xtream Codes</span>
          </button>
          <button type="button" data-role="method-m3u" role="tab" data-focus-key="method:m3u"
                  class="flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl px-4 text-center outline-none transition-colors">
            <span data-i18n="login.tab.url" class="text-base font-medium">I have a playlist URL</span>
            <span data-i18n="login.tab.url.sub" class="text-xs font-medium uppercase tracking-wider opacity-70">M3U / M3U8</span>
          </button>
        </div>

        <form data-role="form" class="flex flex-col gap-4" autocomplete="off">
          <label class="flex flex-col gap-2">
            <span data-i18n="tv.login.field.pasteLink" class="${TV_LABEL_CLASS}">Paste a playlist link</span>
            <input data-role="paste" data-focus-key="paste" type="text"
                   autocapitalize="off" spellcheck="false" inputmode="url"
                   data-i18n-attr="placeholder:tv.login.field.pasteLink.placeholder"
                   placeholder="http://provider.com/get.php?username=...&password=..."
                   class="${TV_INPUT_CLASS}" />
            <p data-role="mirror-hint" class="hidden text-sm text-fg-3"></p>
          </label>

          <div data-role="xtream-fields" class="flex flex-col gap-4">
            <label class="flex flex-col gap-2">
              <span data-i18n="login.field.serverUrl" class="${TV_LABEL_CLASS}">Server URL</span>
              <input data-role="server-url" data-focus-key="field:serverUrl" type="text"
                     autocapitalize="off" spellcheck="false" inputmode="url"
                     placeholder="example.com:8080" class="${TV_INPUT_CLASS}" />
            </label>
            <label class="flex flex-col gap-2">
              <span data-i18n="login.field.username" class="${TV_LABEL_CLASS}">Username</span>
              <input data-role="username" data-focus-key="field:username" type="text"
                     autocapitalize="off" spellcheck="false" class="${TV_INPUT_CLASS}" />
            </label>
            <label class="flex flex-col gap-2">
              <span data-i18n="login.field.password" class="${TV_LABEL_CLASS}">Password</span>
              <div class="flex items-center gap-2">
                <input data-role="password" data-focus-key="field:password" type="password"
                       class="${TV_INPUT_CLASS} flex-1" />
                <button type="button" data-role="toggle-password" data-focus-key="toggle-password"
                        class="shrink-0 min-h-11 rounded-2xl border border-line px-5 text-base text-fg-2 outline-none transition-colors hover:bg-surface-2 tv-focus-inset">
                  <span data-role="toggle-password-label" data-i18n="tv.login.action.showPassword">Show</span>
                </button>
              </div>
            </label>
          </div>

          <div data-role="m3u-fields" class="hidden flex-col gap-4">
            <label class="flex flex-col gap-2">
              <span data-i18n="login.field.playlistUrl" class="${TV_LABEL_CLASS}">Playlist URL</span>
              <input data-role="m3u-url" data-focus-key="field:m3uUrl" type="text"
                     autocapitalize="off" spellcheck="false" inputmode="url"
                     placeholder="example.com/playlist.m3u8" class="${TV_INPUT_CLASS}" />
            </label>
            <label class="flex flex-col gap-2">
              <span data-i18n="login.epg.primaryLabel" class="${TV_LABEL_CLASS}">Primary EPG URL</span>
              <input data-role="epg-url" data-focus-key="field:epgUrl" type="text"
                     autocapitalize="off" spellcheck="false" inputmode="url"
                     data-i18n-attr="placeholder:login.epg.primaryPlaceholder"
                     placeholder="Leave empty to use the provider's default" class="${TV_INPUT_CLASS}" />
            </label>
          </div>

          <label class="flex flex-col gap-2">
            <span data-i18n="login.field.title" class="${TV_LABEL_CLASS}">Title</span>
            <input data-role="name" data-focus-key="field:name" type="text"
                   data-i18n-attr="placeholder:login.field.title.placeholder"
                   placeholder="e.g. Living room TV" class="${TV_INPUT_CLASS}" />
          </label>

          <p data-role="status" class="hidden rounded-2xl border px-4 py-2.5 text-sm leading-relaxed"
             role="status" aria-live="polite"></p>

          <div class="flex items-center justify-end gap-3 pt-2">
            <button type="button" data-role="cancel" data-focus-key="cancel"
                    class="btn min-h-11 px-7 text-base tv-focus-inset">
              <span data-i18n="common.cancel">Cancel</span>
            </button>
            <button type="submit" data-role="connect" data-focus-key="connect"
                    class="btn-primary min-h-11 px-8 text-base tv-focus-inset">
              <span data-role="connect-label" data-i18n="tv.login.action.connect">Connect</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  `
}

function collectRefs(root: HTMLElement): Refs {
  const query = <T extends HTMLElement>(role: string) => root.querySelector<T>(`[data-role="${role}"]`)!
  return {
    form: query("form"),
    methodXtream: query("method-xtream"),
    methodM3u: query("method-m3u"),
    pasteInput: query("paste"),
    mirrorHint: query("mirror-hint"),
    xtreamFields: query("xtream-fields"),
    serverUrlInput: query("server-url"),
    usernameInput: query("username"),
    passwordInput: query("password"),
    togglePasswordBtn: query("toggle-password"),
    m3uFields: query("m3u-fields"),
    m3uUrlInput: query("m3u-url"),
    epgUrlInput: query("epg-url"),
    nameInput: query("name"),
    statusEl: query("status"),
    cancelBtn: query("cancel"),
    connectBtn: query("connect"),
    starCode: query("star-code"),
    starUser: query("star-user"),
    starPass: query("star-pass"),
    starBtn: query("star-signin"),
    starMsg: query("star-msg"),
  }
}

const ACTIVE_METHOD_CLASS = "bg-accent-soft text-accent ring-1 ring-accent/30"
const IDLE_METHOD_CLASS = "text-fg-2 hover:bg-surface-2 hover:text-fg"

const STATUS_PALETTE: Record<string, string> = {
  busy: "border-line bg-surface text-fg-2",
  active: "border-ok/30 bg-ok/10 text-ok",
  expired: "border-warn/30 bg-warn/10 text-warn",
  inactive: "border-warn/30 bg-warn/10 text-warn",
  unavailable: "border-bad/30 bg-bad/10 text-bad",
}

const view: TvView = {
  mount(root: HTMLElement, _ctx: TvViewContext) {
    root.innerHTML = buildMarkup()
    applyI18nDOM(root)
    const refs = collectRefs(root)

    // ---- Star sign-in (our own service) ------------------------------------------------
    // The same flow the phone page runs: POST {code, username, password, deviceId, label} to
    // the origin, which checks the pairing code with the panel, signs the account in and
    // answers with a per-account playlist URL. That URL is saved as an M3U entry (the player
    // path every other method uses) and the viewer lands on the live screen.
    const STAR_ORIGIN = "https://hardrockradio.net:8443"
    const starSay = (text: string) => {
      if (refs.starMsg) refs.starMsg.textContent = text
    }
    // A stable id for THIS installation, so the panel lists the television as a device of the
    // account (its device cap applies here exactly as it does to a phone).
    const starDeviceId = () => {
      try {
        let id = localStorage.getItem("xt_star_device")
        if (!id) {
          id = "app-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
          localStorage.setItem("xt_star_device", id)
        }
        return id
      } catch {
        return "app-unknown"
      }
    }
    const starDeviceLabel = () => {
      const ua = navigator.userAgent || ""
      const platform = /Android/i.test(ua)
        ? /TV|Braille|AFT|Box/i.test(ua)
          ? "Android TV"
          : "Android"
        : /Windows/i.test(ua)
          ? "Windows"
          : /Macintosh/i.test(ua)
            ? "macOS"
            : /Linux/i.test(ua)
              ? "Linux"
              : "Web"
      return "Star Xtream · " + platform
    }
    let starBusy = false
    async function starSignIn () {
      if (starBusy) return
      const code = (refs.starCode?.value || "").trim()
      const username = (refs.starUser?.value || "").trim()
      const password = refs.starPass?.value || ""
      if (!code || !username || !password) {
        starSay("Upiši kod, korisnika i lozinku.")
        return
      }
      starBusy = true
      refs.starBtn.disabled = true
      starSay("Provjeravam nalog…")
      try {
        const res = await fetch(STAR_ORIGIN + "/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code,
            username,
            password,
            deviceId: starDeviceId(),
            label: starDeviceLabel(),
          }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || !data.playlist) {
          const reason = (data && data.error) || "greska"
          starSay(
            reason === "bad-code"
              ? "Paring kod nije tačan."
              : reason === "expired"
                ? "Nalog je istekao."
                : reason === "disabled"
                  ? "Nalog je isključen."
                  : reason === "invalid credentials"
                    ? "Pogrešan korisnik ili lozinka."
                    : "Prijava nije prošla (" + reason + ")."
          )
          return
        }
        const saved = await addEntry({
          type: "m3u",
          title: username,
          emoji: "",
          accent: "",
          url: data.playlist,
          epgUrl: "",
          additionalEpgUrls: [],
        })
        try {
          localStorage.setItem("xt_star_user", username)
          // A sign-in is how a device the operator closed comes back.
          localStorage.removeItem("xt_blocked")
        } catch {}
        starSay("Prijava uspješna · " + (data.channels || 0) + " kanala.")
        toastSuccess("Prijava uspješna")
        if (saved && (saved as { _id?: string })._id) {
          try {
            const { warmupActive } = await import("@/scripts/lib/catalog.js")
            await warmupActive((saved as { _id: string })._id, { force: true })
          } catch {}
        }
        navigate("/tv/live")
      } catch {
        starSay("Server nije dostupan — provjeri internet.")
      } finally {
        starBusy = false
        if (refs.starBtn) refs.starBtn.disabled = false
      }
    }
    refs.starBtn?.addEventListener("click", (event) => {
      event.preventDefault()
      starSignIn()
    })
    refs.starPass?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        starSignIn()
      }
    })
    refs.starCode?.addEventListener("input", (event) => {
      const el = event.target as HTMLInputElement
      const clean = String(el.value).toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 12)
      el.value = clean.replace(/(.{4})(?=.)/g, "$1-")
    })
    try {
      const lastUser = localStorage.getItem("xt_star_user")
      if (lastUser && refs.starUser) refs.starUser.value = lastUser
    } catch {}

    let method: Method = "xtream"
    let passwordVisible = false
    let busy = false
    let destroyed = false
    let cancelAllowed = false
    let pendingMirrors: ParsedXtreamCandidate[] = []

    function paintMethodButtons(): void {
      refs.methodXtream.className =
        "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl px-4 text-center outline-none transition-colors tv-focus-inset " +
        (method === "xtream" ? ACTIVE_METHOD_CLASS : IDLE_METHOD_CLASS)
      refs.methodM3u.className =
        "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl px-4 text-center outline-none transition-colors tv-focus-inset " +
        (method === "m3u" ? ACTIVE_METHOD_CLASS : IDLE_METHOD_CLASS)
      refs.methodXtream.setAttribute("aria-selected", String(method === "xtream"))
      refs.methodM3u.setAttribute("aria-selected", String(method === "m3u"))
    }

    function setMethod(next: Method): void {
      if (method === next) return
      method = next
      refs.xtreamFields.classList.toggle("hidden", next !== "xtream")
      refs.xtreamFields.classList.toggle("flex", next === "xtream")
      refs.m3uFields.classList.toggle("hidden", next !== "m3u")
      refs.m3uFields.classList.toggle("flex", next === "m3u")
      paintMethodButtons()
      clearStatus()
    }

    function clearStatus(): void {
      refs.statusEl.classList.add("hidden")
      refs.statusEl.className = "hidden rounded-2xl border px-4 py-2.5 text-sm leading-relaxed"
      refs.statusEl.textContent = ""
    }

    function setStatus(kind: keyof typeof STATUS_PALETTE, message: string): void {
      refs.statusEl.classList.remove("hidden")
      refs.statusEl.className =
        "rounded-2xl border px-4 py-2.5 text-sm leading-relaxed " + (STATUS_PALETTE[kind] || STATUS_PALETTE.busy)
      refs.statusEl.textContent = message
    }

    function focusFirstField(): void {
      const target = method === "xtream" ? refs.serverUrlInput : refs.m3uUrlInput
      target?.focus()
    }

    function setBusy(next: boolean): void {
      busy = next
      for (const el of [
        refs.pasteInput,
        refs.serverUrlInput,
        refs.usernameInput,
        refs.passwordInput,
        refs.m3uUrlInput,
        refs.epgUrlInput,
        refs.nameInput,
        refs.methodXtream,
        refs.methodM3u,
        refs.connectBtn,
      ]) {
        el.disabled = next
      }
      refs.cancelBtn.disabled = next || !cancelAllowed
    }

    function updateMirrorHint(): void {
      if (pendingMirrors.length > 0) {
        refs.mirrorHint.textContent = t("tv.login.field.pasteLink.mirrorsDetected", {
          count: String(pendingMirrors.length),
        })
        refs.mirrorHint.classList.remove("hidden")
      } else {
        refs.mirrorHint.classList.add("hidden")
        refs.mirrorHint.textContent = ""
      }
    }

    function onPasteInput(): void {
      const parsed = parsePlaylistLinks(refs.pasteInput.value)
      pendingMirrors = []
      if (!parsed) {
        updateMirrorHint()
        return
      }
      if (parsed.type === "xtream") {
        setMethod("xtream")
        const [primary, ...mirrors] = parsed.entries
        refs.serverUrlInput.value = primary.serverUrl
        refs.usernameInput.value = primary.username
        refs.passwordInput.value = primary.password
        pendingMirrors = mirrors
      } else {
        setMethod("m3u")
        refs.m3uUrlInput.value = parsed.url
      }
      updateMirrorHint()
    }

    function togglePasswordVisibility(): void {
      passwordVisible = !passwordVisible
      refs.passwordInput.type = passwordVisible ? "text" : "password"
      const label = refs.togglePasswordBtn.querySelector<HTMLElement>('[data-role="toggle-password-label"]')
      if (!label) return
      const key = passwordVisible ? "tv.login.action.hidePassword" : "tv.login.action.showPassword"
      label.setAttribute("data-i18n", key)
      label.textContent = t(key)
    }

    async function connectXtream(): Promise<void> {
      const serverUrl = refs.serverUrlInput.value.trim()
      const username = refs.usernameInput.value.trim()
      const password = refs.passwordInput.value.trim()
      if (!serverUrl || !username || !password) {
        setStatus("unavailable", t("login.status.allRequired"))
        focusFirstField()
        return
      }
      setStatus("busy", t("login.status.testing"))
      const resolved = await resolveServerScheme({ serverUrl, username, password })
      if (destroyed) return
      if (resolved.serverUrl !== serverUrl) refs.serverUrlInput.value = resolved.serverUrl
      const result = resolved.test as XtreamTestResult
      if (result.status === "unavailable") {
        setStatus("unavailable", describeXtreamResult(result))
        focusFirstField()
        return
      }
      const entry = await addEntry({
        type: "xtream",
        title: refs.nameInput.value.trim(),
        serverUrl: resolved.serverUrl,
        username,
        password,
        mirrors: pendingMirrors,
      })
      if (destroyed) return
      if (result.status === "expired" || result.status === "inactive") {
        toastWarn(t("tv.login.toast.saved", { title: entry.title }), { description: describeXtreamResult(result) })
      } else {
        toastSuccess(t("tv.login.toast.saved", { title: entry.title }))
      }
      await navigate("/tv", { history: "replace" })
    }

    async function connectM3U(): Promise<void> {
      const rawUrl = refs.m3uUrlInput.value.trim()
      if (!rawUrl) {
        setStatus("unavailable", t("login.status.enterM3uUrl"))
        focusFirstField()
        return
      }
      setStatus("busy", t("login.status.fetching"))
      const resolved = await resolveM3UScheme(rawUrl)
      if (destroyed) return
      if (resolved.url !== rawUrl) refs.m3uUrlInput.value = resolved.url
      const result = resolved.test as M3UTestResult
      if (result.status !== "active") {
        setStatus("unavailable", describeM3UResult(result))
        focusFirstField()
        return
      }
      const entry = await addEntry({
        type: "m3u",
        title: refs.nameInput.value.trim(),
        url: resolved.url,
        epgUrl: refs.epgUrlInput.value.trim(),
      })
      if (destroyed) return
      toastSuccess(t("tv.login.toast.saved", { title: entry.title }))
      await navigate("/tv", { history: "replace" })
    }

    async function onConnect(event: Event): Promise<void> {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      try {
        if (method === "xtream") await connectXtream()
        else await connectM3U()
      } catch (error) {
        if (!destroyed) setStatus("unavailable", String((error as Error)?.message || error))
      } finally {
        if (!destroyed) setBusy(false)
      }
    }

    async function onCancelClick(): Promise<void> {
      if (busy) return
      const entries = await getEntries()
      if (entries.length) history.back()
    }

    async function initCancelAvailability(): Promise<void> {
      const entries = await getEntries()
      if (destroyed) return
      cancelAllowed = entries.length > 0
      refs.cancelBtn.disabled = !cancelAllowed
    }

    function onLocaleChanged(): void {
      applyI18nDOM(root)
      updateMirrorHint()
    }

    refs.methodXtream.addEventListener("click", () => setMethod("xtream"))
    refs.methodM3u.addEventListener("click", () => setMethod("m3u"))
    refs.pasteInput.addEventListener("input", onPasteInput)
    refs.togglePasswordBtn.addEventListener("click", togglePasswordVisibility)
    refs.cancelBtn.addEventListener("click", () => void onCancelClick())
    refs.form.addEventListener("submit", (event) => void onConnect(event))
    document.addEventListener(LOCALE_EVENT, onLocaleChanged)

    paintMethodButtons()
    void initCancelAvailability()

    return () => {
      destroyed = true
      document.removeEventListener(LOCALE_EVENT, onLocaleChanged)
      root.replaceChildren()
    }
  },
}

export default view
