// Peer-to-peer delivery for HLS live TV.
//
// This app already plays HLS through hls.js in a WebView (WebView2 on Windows, the system
// WebView on Android), which is exactly the surface a WebRTC peer mesh needs — so the layer
// that has been running in this operator's web player goes in unchanged here. Viewers of the
// same channel exchange segments with each other; anything the swarm cannot provide is fetched
// over plain HTTP, so playback never depends on a peer being there.
//
// THE SWARM IS THE WHOLE FEATURE, and it has to be derived from something every viewer of a
// channel shares. Two things do NOT work, both measured on this deployment:
//   * the manifest's RESPONSE address — the provider 302s every request to a per-session token,
//     so every viewer would derive a different identity and sit alone in its own swarm;
//   * the panel's channel id — two viewers of one channel ended up in `star-cdn-260` and
//     `star-cdn-star-cdn-260`, correct code with a mismatched name and zero sharing.
// The channel's own URL is what every viewer really shares, normalised (host lowercased, query
// and fragment dropped, trailing slash trimmed) so a cosmetic difference in how an operator
// saved the address cannot split the audience.

const P2P_TRACKERS = ["wss://tracker.openwebtorrent.com", "wss://tracker.webtorrent.dev"]

/** Where the relay credentials come from (the same origin the segments do). */
const TURN_ENDPOINT = "https://hardrockradio.net:8443/turn-credentials"

/** The viewer's switch. Persisted, so turning sharing off survives a restart. */
const P2P_OFF_KEY = "xt_p2p_off"

/**
 * Live geometry, measured on this deployment's channels (10 s segments, five-segment live
 * offset). The library's own defaults (a 3 s HTTP window, and — for streams with segment
 * durations up to 10 s — a P2P window FORCED to that same 3 s) never reach the fragments
 * hls.js asks for, which sit a whole live offset ahead of the playhead: nothing is ever
 * shareable and every segment comes from the origin. 60 s covers them.
 */
const HTTP_WINDOW_MS = 60000

/**
 * How long a P2P download may receive nothing before falling back to HTTP. The library's
 * default is 2 s and this operator's earlier tuning used 8 s; 8 s of silence is 8 s of frozen
 * picture when a peer goes away, 2 s abandons peers that are merely slow. Measured: 2.5 s.
 */
const NOT_RECEIVING_TIMEOUT_MS = 2500

interface TurnResponse {
  ttl?: number
  iceServers?: RTCIceServer[]
}

let iceCache: { servers: RTCIceServer[]; expiresAt: number } | null = null
let iceInflight: Promise<RTCIceServer[] | null> | null = null

/** Is sharing switched on for this viewer? */
export function p2pEnabled(): boolean {
  try {
    return localStorage.getItem(P2P_OFF_KEY) !== "1"
  } catch {
    return true
  }
}

export function setP2pEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(P2P_OFF_KEY)
    else localStorage.setItem(P2P_OFF_KEY, "1")
  } catch {
    /* a private mode without storage simply keeps the default (on) */
  }
}

/** The swarm every viewer of this channel shares. Mirrors the web player byte for byte. */
export function swarmIdFor(url: string): string {
  try {
    const u = new URL(url)
    return "aliran-cdn:" + u.host.toLowerCase() + u.pathname.replace(/\/+$/, "")
  } catch {
    return "aliran-cdn:" + url
  }
}

/**
 * Which channels may use the mesh, and why it is a list rather than "everything".
 *
 * A peer mesh identifies a segment by its ADDRESS, so two viewers can only share when their
 * players ask for the identical address. This operator's channels are served by their own
 * CDN origin, which rewrites every segment to a stable `/seg/<channel>/<sequence>.ts` — that is
 * what makes sharing possible at all. A provider's own addresses carry a per-session token:
 * the same second of video has a different address for every viewer, so a mesh over those is
 * not a mesh, it is two viewers each fetching everything (measured on this deployment early
 * on, before the origin existed). Channels that need per-request headers (a provider's hotlink
 * check, an Authorization header) are excluded for the same reason — the peer path cannot
 * carry them.
 *
 * Add a host here when its segments are stable and header-free.
 */
const P2P_HOSTS = ["hardrockradio.net"]

export function p2pEligible(url: string): boolean {
  if (!p2pEnabled()) return false
  try {
    const u = new URL(url)
    if (u.protocol !== "http:" && u.protocol !== "https:") return false
    const host = u.hostname.toLowerCase()
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return false
    return P2P_HOSTS.some((h) => host === h || host.endsWith("." + h))
  } catch {
    return false
  }
}

/**
 * Relay credentials, fetched once and reused until they are nearly spent. Public STUN alone
 * cannot cross a mobile carrier's CGNAT (measured: a phone on 4G shared nothing while the same
 * phone on wifi shared immediately), so a relay is offered as a fallback candidate. The
 * credentials are minted by the origin per viewer and die within the hour.
 */
async function loadIceServers(): Promise<RTCIceServer[] | null> {
  const now = Date.now()
  if (iceCache && now < iceCache.expiresAt) return iceCache.servers
  if (iceInflight) return iceInflight
  iceInflight = (async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(TURN_ENDPOINT, { signal: controller.signal, cache: "no-store" })
      clearTimeout(timer)
      if (!res.ok) return null
      const body = (await res.json()) as TurnResponse
      const servers = Array.isArray(body.iceServers) ? body.iceServers : []
      if (!servers.length) return null
      const ttlMs = Math.max(60, (body.ttl ?? 600) - 120) * 1000
      iceCache = { servers, expiresAt: Date.now() + ttlMs }
      return servers
    } catch {
      return null // no relay reachable: STUN-only, exactly as before this existed
    } finally {
      iceInflight = null
    }
  })()
  return iceInflight
}

/**
 * Kick the relay lookup off early (app start), so the first tune builds its player with the
 * credentials already in hand rather than starting without them.
 */
export function warmUpIceServers(): void {
  if (p2pEnabled()) void loadIceServers()
}

/**
 * The `p2p` block for an hls.js config, or null when this url should stay plain HTTP.
 *
 * SYNCHRONOUS on purpose: the caller builds its player inside a plain function, and the relay
 * list is fetched once at startup (see the warm-up below) rather than in the tune path. If it
 * has not arrived yet the player is built STUN-only and the next tune carries the relay.
 */
export function p2pConfigFor(url: string): Record<string, unknown> | null {
  if (!p2pEligible(url)) return null
  const iceServers = iceCache && Date.now() < iceCache.expiresAt ? iceCache.servers : null
  return {
    p2p: {
      core: {
        announceTrackers: P2P_TRACKERS,
        swarmId: swarmIdFor(url),
        httpDownloadTimeWindow: HTTP_WINDOW_MS,
        p2pNotReceivingBytesTimeoutMs: NOT_RECEIVING_TIMEOUT_MS,
        ...(iceServers ? { rtcConfig: { iceServers } } : {}),
      },
    },
  }
}

// Ask for the relay credentials as soon as this module loads, so the first channel a viewer
// tunes already has them.
warmUpIceServers()

// ---------------------------------------------------------------------------- the readout
//
// What the viewer sees: how many peers are connected and how much of what they are watching
// came from them instead of from the server. The library keeps no per-segment verdict that can
// be read from outside — its request table is discarded the moment a segment is delivered, and
// its debug log only exists when the `debug` module is switched on before load; both were tried
// on the web player and both read zero while two viewers demonstrably shared. What cannot lie is
// the difference between two counts this module can see: what the PLAYER consumed (hls.js's own
// fragment-loaded event) and what the NETWORK carried (segment requests, hooked below).

let delivered = 0
const segmentsFromNetwork = new Set<string>()
let netHooked = false

function hookNetwork(): void {
  if (netHooked) return
  netHooked = true
  const isSegment = (u: unknown) => /\/seg\/[^/]+\/[^/]+\.ts(\?|$)/i.test(String((u as { url?: string })?.url ?? u ?? ""))
  const note = (u: unknown) => {
    const s = String((u as { url?: string })?.url ?? u ?? "")
    if (isSegment(s)) segmentsFromNetwork.add(s.split("?")[0])
  }
  try {
    const open = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: unknown[]) {
      note(url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (open as any).call(this, method, url, ...rest)
    }
    const fetchImpl = window.fetch
    if (fetchImpl) {
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        note(input)
        return fetchImpl.call(window, input, init)
      }
    }
  } catch {
    /* a browser that does not allow the hook simply reports origin-only numbers */
  }
}

let lastEngine: { p2pEngine?: { core?: { mainStreamLoader?: { p2pLoaders?: { currentLoader?: { connectedPeerCount?: number } } } } } } | null = null

/** Called by the player right after it is built, with the instance we want numbers from. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachP2pStats(hls: any): void {
  hookNetwork()
  delivered = 0
  segmentsFromNetwork.clear()
  lastEngine = hls
  try {
    hls.on("hlsFragLoaded", () => { delivered++ })
  } catch {
    /* an engine without the event simply shows peers and no share */
  }
}

function connectedPeers(): number {
  try {
    return lastEngine?.p2pEngine?.core?.mainStreamLoader?.p2pLoaders?.currentLoader?.connectedPeerCount ?? 0
  } catch {
    return 0
  }
}

/**
 * One line for the player's stats overlay: how much came from the mesh and who it came from.
 * `null` when the mesh is off for this viewer (the overlay then shows nothing extra).
 */
export function p2pStatsLine(): string | null {
  if (!p2pEnabled()) return null
  const peers = connectedPeers()
  if (!delivered) return peers > 0 ? `0 % / ${peers} peer${peers === 1 ? "" : "s"}` : "waiting for a peer"
  const fromPeers = Math.max(0, delivered - segmentsFromNetwork.size)
  const pct = Math.round((100 * fromPeers) / delivered)
  return `${pct} % / ${peers} peer${peers === 1 ? "" : "s"} (${fromPeers}/${delivered})`
}
