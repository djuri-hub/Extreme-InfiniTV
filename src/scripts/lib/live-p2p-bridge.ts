// Live P2P bridge: the native Android player draws the picture, the WebView keeps the mesh.
//
// On a Fire Stick the WebView decodes a channel's audio but never paints its video, so the
// embedded (hls.js) player — the only one that shares with peers — cannot be what the viewer
// watches. The native ExoPlayer activity paints correctly but knows nothing about peers. This
// module runs both: a hidden hls.js player keeps fetching the channel through the peer mesh,
// every segment it obtains is handed to the bridge server in Rust (see src-tauri/src/p2p_live.rs)
// and the native player reads the channel back from 127.0.0.1. A segment the mesh has not
// produced yet is fetched from the origin by the bridge, so the picture never waits on a peer.

import { invoke } from "@tauri-apps/api/core"
import Hls from "hls.js"
import { HlsJsP2PEngine } from "p2p-media-loader-hlsjs"
import { attachP2pStats, p2pConfigFor, p2pEnabled, swarmIdFor } from "@/scripts/lib/p2p"
import { log } from "@/scripts/lib/log.js"

export interface LiveBridgeStats {
  peerSegments: number
  originSegments: number
  cachedSegments: number
  cachedBytes: number
}

interface HiddenPlayer {
  video: HTMLVideoElement
  hls: Hls | null
  src: string
}

let base: string | null = null
let starting: Promise<boolean> | null = null
let hidden: HiddenPlayer | null = null
let teeInstalled = false

/** Live TV on Android with the native player present and sharing switched on. */
export function liveBridgeSupported(): boolean {
  if (typeof window === "undefined") return false
  if (!window.AndroidVideo?.launchLive) return false
  return p2pEnabled()
}

export function liveBridgeActive(): boolean {
  return base !== null
}

/**
 * Why the bridge is not running, in one word. Only useful for the server-side report below,
 * but the reason is exactly what cannot be read from the origin otherwise: a device we cannot
 * attach a debugger to either shares, or it does not.
 */
export function bridgeSkipReason(): string {
  if (typeof window === "undefined") return "no window"
  if (!window.AndroidVideo?.launchLive) return "no native player"
  if (!p2pEnabled()) return "sharing off"
  return "eligible"
}

const REPORT_URL = "https://hardrockradio.net:8443/player/report"

let appVersion = ""

/** The installed build, so a report from a device we cannot read says which build sent it. */
async function version(): Promise<string> {
  if (appVersion) return appVersion
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    appVersion = await getVersion()
  } catch {
    appVersion = "unknown"
  }
  return appVersion
}

/**
 * The origin logs every report body it receives, so this is the only way to see from the server
 * whether the bridge engaged on a device that cannot be debugged directly. Never carries the
 * account name: it is a diagnostic line, not a viewer beat.
 */
export function reportBridgeState(note: string): void {
  void version()
    .then((installed) => {
      try {
        return fetch(REPORT_URL, {
          method: "POST",
          // text/plain on purpose: a JSON content type makes this a preflighted request, and the
          // origin answers no preflight. Same trick the player's own report uses.
          headers: { "content-type": "text/plain" },
          body: JSON.stringify({ app: "android-tv", stats: `bridge[${installed}]: ${note}` }),
          keepalive: true,
        })
      } catch {
        return Promise.resolve()
      }
    })
    .then(() => undefined)
    .catch(() => {
      /* a diagnostic that cannot be sent must never affect playback */
    })
}

// Fires as soon as this module loads on a device with the native player, before any channel is
// tuned: the answer to "is the new build actually running on that box?" without touching it.
if (typeof window !== "undefined" && window.AndroidVideo?.launchLive) {
  reportBridgeState("module loaded")
}

/** The address the native player opens: our bridge, not the origin. */
export function liveBridgeUrl(src: string): string {
  if (!base) return src
  return `${base}/m?u=${encodeURIComponent(src)}`
}

async function openBridge(options: { userAgent?: string | null; referer?: string | null }): Promise<boolean> {
  try {
    const port = (await invoke("p2p_live_open", {
      userAgent: options.userAgent ?? null,
      referer: options.referer ?? null,
    })) as number
    if (!port) return false
    base = `http://127.0.0.1:${port}`
    installTee()
    log.info(`[xt:live-bridge] listening on ${base}`)
    reportBridgeState(`listening on ${port}`)
    return true
  } catch (err) {
    log.warn("[xt:live-bridge] open failed:", err)
    reportBridgeState(`open failed: ${String(err).slice(0, 120)}`)
    base = null
    return false
  }
}

/** Idempotent: repeated calls reuse the same server and the same hidden player. */
export function startLiveBridge(options: { userAgent?: string | null; referer?: string | null } = {}): Promise<boolean> {
  if (base) return Promise.resolve(true)
  if (!starting) {
    starting = openBridge(options).finally(() => {
      starting = null
    })
  }
  return starting
}

function looksLikeSegment(url: string): boolean {
  return /\/seg\//i.test(url) || /\.(ts|m4s|mp4|aac|key|cmfv|cmfa)(\?|#|$)/i.test(url)
}

/**
 * Hand a freshly fetched segment to the bridge. Binary body over local HTTP rather than an IPC
 * call: a ten-second segment is several megabytes and base64 would be both slower and larger.
 */
function tee(url: string, bytes: Uint8Array): void {
  if (!base || bytes.length === 0 || !looksLikeSegment(url)) return
  try {
    void fetch(`${base}/put?u=${encodeURIComponent(url)}`, { method: "POST", body: bytes }).catch(() => {})
  } catch {
    /* a segment the bridge does not receive is fetched from the origin instead */
  }
}

/**
 * Watch every binary response the WebView gets. hls.js reads segments through XMLHttpRequest;
 * the fallback paths use fetch. Both are wrapped, and anything that is not a segment is left
 * alone so the bridge never caches a poster or a manifest.
 */
function installTee(): void {
  if (teeInstalled) return
  teeInstalled = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prototype = XMLHttpRequest.prototype as any
    const originalOpen = prototype.open
    const originalSend = prototype.send
    prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(this as any).__xtLiveUrl = String(url)
      } catch {
        /* a request without a readable address is simply not teed */
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalOpen as any).call(this, method, url, ...rest)
    }
    prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const url = (this as any).__xtLiveUrl as string | undefined
        if (url && looksLikeSegment(url)) {
          this.addEventListener("load", () => {
            try {
              const body = this.response
              if (body instanceof ArrayBuffer && body.byteLength > 0) tee(url, new Uint8Array(body))
            } catch {
              /* an unreadable response simply is not shared */
            }
          })
        }
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalSend as any).apply(this, args)
    }
  } catch (err) {
    log.warn("[xt:live-bridge] XHR tee failed:", err)
  }
  try {
    const originalFetch = window.fetch
    if (originalFetch) {
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const result = originalFetch.call(window, input as RequestInfo, init)
        if (url && looksLikeSegment(url)) {
          void result
            .then(async (response) => {
              try {
                const copy = response.clone()
                const buffer = await copy.arrayBuffer()
                if (buffer.byteLength > 0) tee(url, new Uint8Array(buffer))
              } catch {
                /* ignore */
              }
            })
            .catch(() => {})
        }
        return result
      }
    }
  } catch (err) {
    log.warn("[xt:live-bridge] fetch tee failed:", err)
  }
}

function ensureHiddenPlayer(): HiddenPlayer | null {
  if (hidden && hidden.video.isConnected) return hidden
  try {
    const video = document.createElement("video")
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    video.setAttribute("muted", "")
    video.setAttribute("playsinline", "")
    // Rendered, just out of the way: a display:none media element is at the mercy of the
    // platform's throttling, and this one has to keep fetching while the native player is up.
    video.style.cssText =
      "position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:0"
    document.body.appendChild(video)
    hidden = { video, hls: null, src: "" }
    return hidden
  } catch (err) {
    log.warn("[xt:live-bridge] hidden player failed:", err)
    return null
  }
}

/**
 * Point the hidden player at a channel. Called on the first tune and again on every zap so the
 * mesh follows the viewer instead of sharing a channel nobody is watching.
 */
export function tuneLiveBridge(src: string): void {
  if (!base || !src) return
  const player = ensureHiddenPlayer()
  if (!player) return
  if (player.src === src && player.hls) return
  player.src = src
  try {
    player.hls?.destroy()
  } catch {
    /* a destroyed instance needs no second goodbye */
  }
  player.hls = null
  try {
    const p2p = p2pConfigFor(src)
    if (p2p) log.info(`[xt:live-bridge] mesh for ${swarmIdFor(src)}`)
    // Same options as the visible player: the mesh needs the long buffer, and hls.js's worker
    // bypasses the injected loaders that carry peer traffic.
    const HlsClass = (p2p ? HlsJsP2PEngine.injectMixin(Hls) : Hls) as typeof Hls
    const hls = new HlsClass({
      enableWorker: !p2p,
      subtitleDisplay: false,
      ...(p2p ? { maxBufferLength: 60, maxMaxBufferLength: 120 } : {}),
      ...(p2p ?? {}),
    })
    player.hls = hls
    attachP2pStats(hls, src)
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void player.video.play().catch(() => {})
    })
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) log.warn(`[xt:live-bridge] hidden player error: ${data.type}/${data.details}`)
    })
    hls.attachMedia(player.video)
    hls.loadSource(src)
    reportBridgeState(`tuned ${src.split("/").pop() ?? src}`)
  } catch (err) {
    log.warn("[xt:live-bridge] tune failed:", err)
  }
}

export async function liveBridgeStats(): Promise<LiveBridgeStats | null> {
  if (!base) return null
  try {
    const response = await fetch(`${base}/stats`, { cache: "no-store" })
    if (!response.ok) return null
    return (await response.json()) as LiveBridgeStats
  } catch {
    return null
  }
}

export function stopLiveBridge(): void {
  if (hidden) {
    try {
      hidden.hls?.destroy()
    } catch {
      /* ignore */
    }
    try {
      hidden.video.remove()
    } catch {
      /* ignore */
    }
    hidden = null
  }
  if (!base) return
  void invoke("p2p_live_close").catch(() => {})
  base = null
}
