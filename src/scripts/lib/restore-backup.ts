// Shared "restore from backup" wiring: platform file picker (Android SAF ->
// Tauri dialog -> web <input type=file>), a section picker dialog, then import.

import { log } from "@/scripts/lib/log.js"
import { toastSuccess, toastError } from "@/scripts/lib/toast.js"
import { t } from "@/scripts/lib/i18n.js"
import { pickBackupSections } from "@/scripts/lib/backup-sections-dialog.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)
const isAndroid =
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent || "")

export interface BackupSummary {
  playlists: number
  prefsPlaylists: number
  sections: string[]
}

export interface RestoreBackupOptions {
  fileInput: HTMLInputElement | null
  logTag: string
  onRestored?: (summary: BackupSummary) => void | Promise<void>
  onBusyChange?: (busy: boolean) => void
  successDuration?: number
}

async function applyBackupText(text: string, options: RestoreBackupOptions) {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (parseError) {
    log.warn(`[${options.logTag}] backup JSON parse failed:`, parseError)
    toastError(t("settings.toast.backupParseFail"), { description: "Not valid JSON." })
    return
  }
  const { BACKUP_SECTIONS, importAll } = await import("@/scripts/lib/backup.js")
  const present = BACKUP_SECTIONS.filter(
    (name: string) => parsed && typeof parsed === "object" && name in (parsed as Record<string, unknown>)
  )
  const sections = await pickBackupSections(present)
  if (!sections) return
  try {
    const summary = (await importAll(parsed, { sections })) as BackupSummary
    toastSuccess(t("settings.toast.backupRestored"), {
      description: `${summary.playlists} playlist(s), ${summary.prefsPlaylists} preference set(s).`,
      duration: options.successDuration ?? 4000,
    })
    await options.onRestored?.(summary)
  } catch (error: unknown) {
    log.error(`[${options.logTag}] backup import failed:`, error)
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "See console."
    toastError(t("settings.toast.backupRestoreFail"), { description: message })
  }
}

/** Wire a "restore from backup" trigger to the platform-appropriate file picker
 * (Android SAF -> Tauri dialog -> web <input>), then parse + import the chosen
 * JSON and run the caller's follow-up. Native pickers fall back to the web
 * <input> when they fail; the busy flag guards against concurrent picks and is
 * cleared if a web pick is abandoned (window regains focus with no file). */
export function bindBackupRestore(trigger: HTMLElement | null, options: RestoreBackupOptions) {
  if (!trigger) return
  const { fileInput, logTag, onBusyChange } = options
  let busy = false
  const setBusy = (next: boolean) => {
    busy = next
    onBusyChange?.(next)
  }

  trigger.addEventListener("click", async () => {
    if (busy) return
    if (isTauri && isAndroid) {
      try {
        setBusy(true)
        const { pickJsonFile } = await import("@/scripts/lib/android-fs.js")
        const picked = await pickJsonFile()
        if (picked) await applyBackupText(picked.text, options)
        setBusy(false)
        return
      } catch (error) {
        log.warn(`[${logTag}] android-fs picker failed, falling back:`, error)
        setBusy(false)
      }
    } else if (isTauri) {
      try {
        setBusy(true)
        const { open } = await import("@tauri-apps/plugin-dialog")
        const picked = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "JSON", extensions: ["json"] }],
        })
        if (picked && typeof picked === "string") {
          const { readTextFile } = await import("@tauri-apps/plugin-fs")
          await applyBackupText(await readTextFile(picked), options)
        }
        setBusy(false)
        return
      } catch (error) {
        log.warn(`[${logTag}] tauri open failed, falling back:`, error)
        setBusy(false)
      }
    }
    setBusy(true)
    fileInput?.click()
  })

  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0]
    if (!file) {
      setBusy(false)
      return
    }
    try {
      await applyBackupText(await file.text(), options)
    } finally {
      fileInput.value = ""
      setBusy(false)
    }
  })

  if (!isTauri) {
    window.addEventListener("focus", () => {
      if (busy && fileInput && !fileInput.files?.length) {
        setTimeout(() => {
          if (busy && !fileInput.files?.length) setBusy(false)
        }, 200)
      }
    })
  }
}
