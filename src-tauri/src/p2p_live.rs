// Live P2P bridge for the native Android player.
//
// On a Fire Stick the picture renders only through the native ExoPlayer activity, while the
// peer mesh lives in the WebView's hls.js. This module lets both be true at once: the WebView
// hands over every segment it obtains (from a peer or from the origin) and the native player
// reads the same segments back from 127.0.0.1. A segment the WebView has not delivered yet is
// fetched from the origin here, so playback never depends on the mesh providing anything.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;

/// How long a fetched playlist is reused. ExoPlayer re-reads the playlist every couple of
/// seconds and each re-read would otherwise be another origin request.
const PLAYLIST_TTL: Duration = Duration::from_millis(1200);
/// Segments kept for the native player: the live window plus its buffer, nothing else.
const CACHE_MAX_BYTES: usize = 128 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_UA: &str = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

struct Cache {
    bytes: HashMap<String, Arc<Vec<u8>>>,
    order: Vec<String>,
    total: usize,
}

impl Cache {
    fn new() -> Self {
        Self { bytes: HashMap::new(), order: Vec::new(), total: 0 }
    }

    fn get(&self, url: &str) -> Option<Arc<Vec<u8>>> {
        self.bytes.get(url).cloned()
    }

    fn put(&mut self, url: String, data: Arc<Vec<u8>>) {
        if data.is_empty() || data.len() > MAX_SEGMENT_BYTES {
            return;
        }
        if let Some(previous) = self.bytes.insert(url.clone(), data) {
            self.total = self.total.saturating_sub(previous.len());
            if let Some(index) = self.order.iter().position(|entry| entry == &url) {
                self.order.remove(index);
            }
        }
        if let Some(entry) = self.bytes.get(&url) {
            self.total += entry.len();
        }
        self.order.push(url);
        while self.total > CACHE_MAX_BYTES && self.order.len() > 1 {
            let oldest = self.order.remove(0);
            if let Some(entry) = self.bytes.remove(&oldest) {
                self.total = self.total.saturating_sub(entry.len());
            }
        }
    }

    fn clear(&mut self) {
        self.bytes.clear();
        self.order.clear();
        self.total = 0;
    }
}

#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2PLiveStats {
    pub peer_segments: u64,
    pub origin_segments: u64,
    pub cached_segments: u64,
    pub cached_bytes: u64,
}

#[derive(Default)]
struct Counters {
    peer_segments: u64,
    origin_segments: u64,
}

struct Shared {
    client: reqwest::Client,
    ua: String,
    referer: String,
    base: String,
    cache: Mutex<Cache>,
    counters: Mutex<Counters>,
    playlists: Mutex<HashMap<String, (Instant, String)>>,
    /// When the WebView last handed a segment over. While the tee is demonstrably alive the
    /// bridge waits for the WebView's copy instead of paying for the same segment at the origin
    /// a second time — which is the whole reason sharing exists.
    tee_seen: Mutex<Option<Instant>>,
    /// Origin side of this deployment, learned from the first playlist the player asks for.
    origin: Mutex<Option<String>>,
    /// The channel group every viewer of this stream shares, in the same shape the players use.
    swarm: Mutex<Option<String>>,
    /// Other installations on this local network that can hand over a segment.
    peers: Mutex<Vec<(String, u16)>>,
    port: u16,
}

/// How long one LAN peer may take before the origin is asked instead. Two peers in sequence
/// still leave the picture inside its buffer, and a peer that is asleep costs nothing else.
const PEER_TIMEOUT: Duration = Duration::from_millis(700);

fn origin_of(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    Some(format!("{}{}", &url[..scheme_end + 3], &rest[..host_end]))
}

fn swarm_of(url: &str) -> Option<String> {
    let base = origin_of(url)?;
    let without_query = url.split('?').next().unwrap_or(url);
    let path = without_query.strip_prefix(&base).unwrap_or("");
    let host = base.split("://").nth(1)?;
    Some(format!("aliran-cdn:{}{}", host.to_lowercase(), path.trim_end_matches('/')))
}

/// The addresses a peer on this network can actually reach us on.
fn lan_addresses() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            if interface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(address) = interface.addr.ip() {
                if address.is_private() || address.is_link_local() {
                    out.push(address.to_string());
                }
            }
        }
    }
    out
}

static SHARED: OnceLock<Mutex<Option<Arc<Shared>>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<Arc<Shared>>> {
    SHARED.get_or_init(|| Mutex::new(None))
}

fn current() -> Option<Arc<Shared>> {
    slot().lock().ok().and_then(|guard| guard.clone())
}

/// RFC 3986 unreserved characters stay literal; everything else is escaped. A percent-encoded
/// absolute URL survives the query string and axum hands it back decoded.
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 16);
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '_' | '~') {
            out.push(ch);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", byte));
        }
    }
    out
}

fn proxy_url(base: &str, resource: &str) -> String {
    format!("{base}/s?u={}", encode_query(resource))
}

/// Turn a playlist reference into an absolute address. Providers mix absolute URLs, rooted
/// paths and bare names inside one playlist, so all three have to land somewhere usable.
fn absolute_url(manifest: &str, resource: &str) -> String {
    if resource.starts_with("http://") || resource.starts_with("https://") {
        return resource.to_string();
    }
    if let Some(rest) = resource.strip_prefix('/') {
        if let Some(scheme_end) = manifest.find("://") {
            let after_scheme = &manifest[scheme_end + 3..];
            let host_end = after_scheme.find('/').unwrap_or(after_scheme.len());
            return format!("{}{}/{}", &manifest[..scheme_end + 3], &after_scheme[..host_end], rest);
        }
    }
    match manifest.rfind('/') {
        Some(index) => format!("{}{}", &manifest[..=index], resource),
        None => resource.to_string(),
    }
}

fn rewrite_attributes(line: &str, manifest: &str, base: &str) -> Option<String> {
    let marker = "URI=\"";
    let start = line.find(marker)?;
    let value_start = start + marker.len();
    let value_end = value_start + line[value_start..].find('"')?;
    let absolute = absolute_url(manifest, &line[value_start..value_end]);
    Some(format!("{}{}{}", &line[..value_start], proxy_url(base, &absolute), &line[value_end..]))
}

fn rewrite_playlist(body: &str, manifest: &str, base: &str) -> String {
    let mut out = String::with_capacity(body.len() + 1024);
    for line in body.lines() {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.starts_with('#') {
            match rewrite_attributes(trimmed, manifest, base) {
                Some(rewritten) => out.push_str(&rewritten),
                None => out.push_str(trimmed),
            }
        } else if trimmed.trim().is_empty() {
            out.push_str(trimmed);
        } else {
            let absolute = absolute_url(manifest, trimmed.trim());
            out.push_str(&proxy_url(base, &absolute));
        }
        out.push('\n');
    }
    out
}

fn bytes_response(data: Arc<Vec<u8>>, content_type: &str) -> Response {
    let mut response = data.as_ref().clone().into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    response
}

/// Hand a segment to another installation on this network. Only bytes this device already holds
/// are served — a peer never causes an origin fetch, so a sleepy television cannot be turned
/// into extra load by asking it for the world.
async fn handle_peer_segment(
    State(shared): State<Arc<Shared>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let swarm = shared.swarm.lock().ok().and_then(|guard| guard.clone()).unwrap_or_default();
    let token = headers.get("x-peer-token").and_then(|value| value.to_str().ok()).unwrap_or("");
    if swarm.is_empty() || token != swarm {
        return (StatusCode::FORBIDDEN, "peer token required").into_response();
    }
    let Some(url) = params.get("u").filter(|value| !value.is_empty()) else {
        return (StatusCode::BAD_REQUEST, "missing u").into_response();
    };
    match shared.cache.lock().ok().and_then(|guard| guard.get(url)) {
        Some(hit) => bytes_response(hit, "video/mp2t"),
        None => (StatusCode::NOT_FOUND, "not cached").into_response(),
    }
}

async fn handle_peer_ping(State(shared): State<Arc<Shared>>) -> Response {
    let swarm = shared.swarm.lock().ok().and_then(|guard| guard.clone()).unwrap_or_default();
    axum::Json(serde_json::json!({ "ok": true, "swarm": swarm, "port": shared.port })).into_response()
}

/// Tell the origin where we can be reached, and keep the list of installations behind the same
/// public address. Fifteen seconds is short enough that a device which just opened a channel is
/// found, and long enough to cost nothing.
async fn register_loop(shared: Arc<Shared>) {
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let origin = shared.origin.lock().ok().and_then(|guard| guard.clone());
        let swarm = shared.swarm.lock().ok().and_then(|guard| guard.clone());
        let (Some(origin), Some(swarm)) = (origin, swarm) else { continue };
        let addresses = lan_addresses();
        if addresses.is_empty() {
            continue;
        }
        for address in addresses {
            let body = serde_json::json!({ "swarm": swarm, "lan": address, "port": shared.port });
            let request = shared
                .client
                .post(format!("{origin}/peer/register"))
                .timeout(Duration::from_secs(6))
                .json(&body);
            let Ok(response) = request.send().await else { continue };
            let Ok(payload) = response.json::<serde_json::Value>().await else { continue };
            let mut found = Vec::new();
            if let Some(list) = payload.get("peers").and_then(|value| value.as_array()) {
                for entry in list {
                    let lan = entry.get("lan").and_then(|value| value.as_str()).unwrap_or("");
                    let port = entry.get("port").and_then(|value| value.as_u64()).unwrap_or(0);
                    if !lan.is_empty() && port > 0 && port < 65536 {
                        found.push((lan.to_string(), port as u16));
                    }
                }
            }
            if !found.is_empty() {
                if let Ok(mut guard) = shared.peers.lock() {
                    *guard = found;
                }
            }
        }
    }
}

async fn fetch_upstream(shared: &Shared, url: &str) -> Result<(Vec<u8>, String), String> {
    let mut request = shared.client.get(url);
    if !shared.ua.is_empty() {
        request = request.header(reqwest::header::USER_AGENT, shared.ua.clone());
    }
    if !shared.referer.is_empty() {
        request = request.header(reqwest::header::REFERER, shared.referer.clone());
    }
    let response = request.send().await.map_err(|error| format!("upstream error: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("upstream status {status}"));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response.bytes().await.map_err(|error| format!("upstream read error: {error}"))?;
    Ok((bytes.to_vec(), content_type))
}

async fn handle_manifest(
    State(shared): State<Arc<Shared>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let manifest = match params.get("u") {
        Some(value) if !value.is_empty() => value.clone(),
        _ => return (StatusCode::BAD_REQUEST, "missing u").into_response(),
    };
    // The first playlist a player asks for carries everything the peer side needs to know:
    // which origin to register with, and which channel group this device belongs to.
    let mut first_sighting = false;
    if let Ok(mut guard) = shared.origin.lock() {
        if guard.is_none() {
            if let Some(origin) = origin_of(&manifest) {
                *guard = Some(origin);
                first_sighting = true;
            }
        }
    }
    if let Ok(mut guard) = shared.swarm.lock() {
        if guard.is_none() {
            *guard = swarm_of(&manifest);
        }
    }
    if first_sighting {
        tokio::spawn(register_loop(shared.clone()));
    }
    if let Ok(guard) = shared.playlists.lock() {
        if let Some((at, body)) = guard.get(&manifest) {
            if at.elapsed() < PLAYLIST_TTL {
                let mut response = body.clone().into_response();
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    header::HeaderValue::from_static("application/vnd.apple.mpegurl"),
                );
                return response;
            }
        }
    }
    match fetch_upstream(&shared, &manifest).await {
        Ok((bytes, _)) => {
            let body = rewrite_playlist(&String::from_utf8_lossy(&bytes), &manifest, &shared.base);
            if let Ok(mut guard) = shared.playlists.lock() {
                if guard.len() > 32 {
                    guard.clear();
                }
                guard.insert(manifest, (Instant::now(), body.clone()));
            }
            let mut response = body.into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/vnd.apple.mpegurl"),
            );
            response
        }
        Err(message) => (StatusCode::BAD_GATEWAY, message).into_response(),
    }
}

async fn handle_segment(
    State(shared): State<Arc<Shared>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let url = match params.get("u") {
        Some(value) if !value.is_empty() => value.clone(),
        _ => return (StatusCode::BAD_REQUEST, "missing u").into_response(),
    };
    if let Some(hit) = shared.cache.lock().ok().and_then(|guard| guard.get(&url)) {
        return bytes_response(hit, "video/mp2t");
    }
    // Peers first. These are installations on the same network, so this is a LAN hop, not a
    // round trip to the provider — which is the whole point: the television's bytes come from
    // the laptop next to it instead of from the origin that pays for them.
    let peers = shared.peers.lock().map(|guard| guard.clone()).unwrap_or_default();
    let swarm = shared.swarm.lock().ok().and_then(|guard| guard.clone()).unwrap_or_default();
    for (lan, port) in peers {
        let peer_url = format!("http://{lan}:{port}/peer/seg?u={}", encode_query(&url));
        let request = shared
            .client
            .get(peer_url)
            .header("x-peer-token", swarm.clone())
            .timeout(PEER_TIMEOUT);
        let Ok(response) = request.send().await else { continue };
        if !response.status().is_success() {
            continue;
        }
        let Ok(bytes) = response.bytes().await else { continue };
        if bytes.is_empty() {
            continue;
        }
        let stored = Arc::new(bytes.to_vec());
        if let Ok(mut guard) = shared.cache.lock() {
            guard.put(url, stored.clone());
        }
        if let Ok(mut counters) = shared.counters.lock() {
            counters.peer_segments += 1;
        }
        return bytes_response(stored, "video/mp2t");
    }
    // The WebView is fetching this very segment right now — it is the client that runs the mesh.
    // Waiting for its copy is what turns "connected to a peer" into "did not fetch this from the
    // origin". The wait is bounded, and it is skipped entirely until the tee has proven it works,
    // so a first tune is never held up by a bridge nobody is feeding.
    let tee_active = shared
        .tee_seen
        .lock()
        .ok()
        .and_then(|seen| *seen)
        .map(|at| at.elapsed() < Duration::from_secs(120))
        .unwrap_or(false);
    if tee_active {
        let deadline = Instant::now() + Duration::from_millis(2000);
        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Some(hit) = shared.cache.lock().ok().and_then(|guard| guard.get(&url)) {
                return bytes_response(hit, "video/mp2t");
            }
        }
    }
    match fetch_upstream(&shared, &url).await {
        Ok((bytes, content_type)) => {
            let stored = Arc::new(bytes);
            if let Ok(mut guard) = shared.cache.lock() {
                guard.put(url, stored.clone());
            }
            if let Ok(mut counters) = shared.counters.lock() {
                counters.origin_segments += 1;
            }
            let content_type = if content_type.is_empty() { "video/mp2t" } else { &content_type };
            bytes_response(stored, content_type)
        }
        Err(message) => (StatusCode::BAD_GATEWAY, message).into_response(),
    }
}

/// The WebView's tee. Whatever hls.js obtained — from a peer or from the origin — lands here,
/// so the native player's next request for the same address is answered from memory.
async fn handle_put(
    State(shared): State<Arc<Shared>>,
    Query(params): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let url = match params.get("u") {
        Some(value) if !value.is_empty() => value.clone(),
        _ => return (StatusCode::BAD_REQUEST, "missing u").into_response(),
    };
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty body").into_response();
    }
    let mut inserted = false;
    if let Ok(mut guard) = shared.cache.lock() {
        let already = guard.get(&url).map(|entry| entry.len() == body.len()).unwrap_or(false);
        if !already {
            guard.put(url, Arc::new(body.to_vec()));
            inserted = true;
        }
    }
    if inserted {
        if let Ok(mut counters) = shared.counters.lock() {
            counters.peer_segments += 1;
        }
        if let Ok(mut seen) = shared.tee_seen.lock() {
            *seen = Some(Instant::now());
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn handle_stats(State(shared): State<Arc<Shared>>) -> Response {
    let (peer_segments, origin_segments) = shared
        .counters
        .lock()
        .map(|counters| (counters.peer_segments, counters.origin_segments))
        .unwrap_or((0, 0));
    let (cached_segments, cached_bytes) = shared
        .cache
        .lock()
        .map(|cache| (cache.bytes.len() as u64, cache.total as u64))
        .unwrap_or((0, 0));
    let stats = P2PLiveStats { peer_segments, origin_segments, cached_segments, cached_bytes };
    axum::Json(stats).into_response()
}

/// Start the bridge on the first use. The port is handed to the WebView, which is the only
/// thing that needs it: playback addresses are built from it.
#[tauri::command]
pub async fn p2p_live_open(user_agent: Option<String>, referer: Option<String>) -> Result<u16, String> {
    if let Some(shared) = current() {
        return shared
            .base
            .rsplit(':')
            .next()
            .and_then(|port| port.parse::<u16>().ok())
            .ok_or_else(|| "bridge port unavailable".to_string());
    }
    // Bound on every interface, not just loopback: the native player reaches it on 127.0.0.1,
    // and the installations next to it reach it on the local network. The peer routes require
    // the channel token, so opening the port does not open the cache to strangers.
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|error| format!("bind failed: {error}"))?;
    let port = listener.local_addr().map_err(|error| format!("addr failed: {error}"))?.port();
    let shared = Arc::new(Shared {
        client: reqwest::Client::builder()
            .timeout(UPSTREAM_TIMEOUT)
            .build()
            .map_err(|error| format!("client failed: {error}"))?,
        ua: user_agent.unwrap_or_else(|| DEFAULT_UA.to_string()),
        referer: referer.unwrap_or_default(),
        base: format!("http://127.0.0.1:{port}"),
        cache: Mutex::new(Cache::new()),
        counters: Mutex::new(Counters::default()),
        playlists: Mutex::new(HashMap::new()),
        tee_seen: Mutex::new(None),
        origin: Mutex::new(None),
        swarm: Mutex::new(None),
        peers: Mutex::new(Vec::new()),
        port,
    });
    let router = Router::new()
        .route("/m", get(handle_manifest))
        .route("/s", get(handle_segment))
        .route("/put", post(handle_put))
        .route("/stats", get(handle_stats))
        .route("/peer/seg", get(handle_peer_segment))
        .route("/peer/ping", get(handle_peer_ping))
        .layer(DefaultBodyLimit::max(MAX_SEGMENT_BYTES))
        .with_state(shared.clone());
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            log::warn!("[p2p-live] bridge server stopped: {error}");
        }
    });
    if let Ok(mut guard) = slot().lock() {
        *guard = Some(shared);
    }
    Ok(port)
}

#[tauri::command]
pub async fn p2p_live_stats() -> P2PLiveStats {
    snapshot()
}

fn snapshot() -> P2PLiveStats {
    let Some(shared) = current() else {
        return P2PLiveStats::default();
    };
    let (peer_segments, origin_segments) = shared
        .counters
        .lock()
        .map(|counters| (counters.peer_segments, counters.origin_segments))
        .unwrap_or((0, 0));
    let (cached_segments, cached_bytes) = shared
        .cache
        .lock()
        .map(|cache| (cache.bytes.len() as u64, cache.total as u64))
        .unwrap_or((0, 0));
    P2PLiveStats { peer_segments, origin_segments, cached_segments, cached_bytes }
}

/// A player that is already running (the phone, the desktop) does not need the bridge to draw
/// anything, but it does hold the newest segments — and the television next to it wants them.
/// This joins it to the peer side without starting a second player.
#[tauri::command]
pub async fn p2p_live_join(source_url: String) -> Result<(), String> {
    let shared = current().ok_or_else(|| "bridge not open".to_string())?;
    let origin = origin_of(&source_url).ok_or_else(|| "bad url".to_string())?;
    let swarm = swarm_of(&source_url).ok_or_else(|| "bad url".to_string())?;
    let mut start = false;
    if let Ok(mut guard) = shared.origin.lock() {
        if guard.is_none() {
            *guard = Some(origin);
            start = true;
        }
    }
    if let Ok(mut guard) = shared.swarm.lock() {
        if guard.is_none() {
            *guard = Some(swarm);
        }
    }
    if start {
        tokio::spawn(register_loop(shared.clone()));
    }
    Ok(())
}

/// Called when the player closes the channel: the mesh keeps its own cache, so the bridge's
/// copy only holds memory the device needs for something else.
#[tauri::command]
pub async fn p2p_live_close() -> Result<(), String> {
    let Some(shared) = current() else { return Ok(()) };
    if let Ok(mut guard) = shared.cache.lock() {
        guard.clear();
    }
    if let Ok(mut guard) = shared.playlists.lock() {
        guard.clear();
    }
    if let Ok(mut counters) = shared.counters.lock() {
        counters.peer_segments = 0;
        counters.origin_segments = 0;
    }
    Ok(())
}
