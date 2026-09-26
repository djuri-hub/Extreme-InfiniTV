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
use axum::http::{header, StatusCode};
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
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
    });
    let router = Router::new()
        .route("/m", get(handle_manifest))
        .route("/s", get(handle_segment))
        .route("/put", post(handle_put))
        .route("/stats", get(handle_stats))
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
