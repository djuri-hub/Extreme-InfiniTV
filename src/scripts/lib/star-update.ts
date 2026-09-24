// Is there a newer build on the operator's own page?
//
// The page is behind a sign-in (the viewer's app account), so the DOWNLOAD cannot be automatic,
// but the app can know an update exists and offer to open the page. The manifest is public and
// carries no content: {"version": "1.9.0-beta.17", "url": "http://.../"}.
import { log } from "@/scripts/lib/log.js"
import { openExternal } from "@/scripts/lib/external-link"
import { confirmDialog } from "@/scripts/lib/confirm-dialog"

const UPDATE_URL = "http://pivo.baraba.xyz:29312/update.json"
const CHECKED_KEY = "xt_star_update_checked"

async function currentVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    return await getVersion()
  } catch {
    return ""
  }
}

function core(version: string): number[] {
  return String(version).split("-")[0].split(".").map((part) => parseInt(part, 10) || 0)
}

/** Same core version: a later beta ordinal is still newer. */
export function isNewerVersion(remote: string, local: string): boolean {
  if (!remote) return false
  const a = core(remote)
  const b = core(local)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  const ra = /beta\.(\d+)/.exec(remote)
  const rb = /beta\.(\d+)/.exec(local)
  if (ra) return rb ? Number(ra[1]) > Number(rb[1]) : false
  return false
}

export async function checkForStarUpdate(force = false): Promise<{ remote: string; local: string } | null> {
  try {
    if (!force) {
      try {
        if (sessionStorage.getItem(CHECKED_KEY)) return null
        sessionStorage.setItem(CHECKED_KEY, "1")
      } catch {
        /* no storage: check every start */
      }
    }
    const res = await fetch(UPDATE_URL, { cache: "no-store" })
    if (!res.ok) return null
    const data = (await res.json()) as { version?: string; url?: string }
    const remote = String(data?.version || "")
    const local = await currentVersion()
    if (!isNewerVersion(remote, local)) {
      if (force) log.info("[xt:update] up to date", { remote, local })
      return { remote, local }
    }
    log.info("[xt:update] newer build available", { remote, local })
    const open = await confirmDialog({
      title: "Nova verzija je dostupna",
      message: `Na stranici za skidanje je verzija ${remote} (tvoja je ${local}). Otvoriti stranicu?`,
      confirmLabel: "Otvori stranicu"
    })
    if (open) void openExternal(String(data?.url || "http://pivo.baraba.xyz:29312/"))
    return { remote, local }
  } catch (err) {
    log.warn("[xt:update] check failed:", err)
    return null
  }
}
