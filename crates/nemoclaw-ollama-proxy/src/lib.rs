// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authenticated, model-pinned inference access to an externally owned Ollama daemon.
//!
//! The proxy forwards only model listing and chat completions for one pinned
//! model, checks the daemon's inventory before every request, and never sends
//! its own credential upstream.
#![cfg(target_os = "linux")]

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Frame, Incoming},
    header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, HOST, HeaderValue, TRANSFER_ENCODING},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    fmt, fs,
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Ipv6Addr, SocketAddr},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    time::timeout,
};

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Body = UnsyncBoxBody<Bytes, BoxError>;

const REQUEST_LIMIT: u64 = 4 << 20;
const INVENTORY_LIMIT: usize = 1 << 20;
const CONNECTIONS: usize = 32;
const CLIENT_TIMEOUT: Duration = Duration::from_secs(30);
const INVENTORY_TIMEOUT: Duration = Duration::from_secs(10);
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(600);

/// A startup or inventory failure; messages never contain credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error(pub &'static str);

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for Error {}

const INVALID: Error = Error("invalid external Ollama proxy specification");
const LISTENER: Error = Error("external Ollama listener is absent");
const INVENTORY: Error = Error("external model inventory is unavailable");

/// The specification the SDK passes in `NEMOCLAW_OLLAMA_PROXY`.
#[derive(Debug, Deserialize)]
pub struct Settings {
    pub endpoint: String,
    pub upstream: String,
    pub model: String,
    pub digest: String,
}

#[derive(Debug, Clone)]
struct Upstream {
    address: SocketAddr,
    authority: String,
}

fn lowercase_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn ip(host: Option<url::Host<&str>>) -> Option<IpAddr> {
    match host? {
        url::Host::Ipv4(address) => Some(IpAddr::V4(address)),
        url::Host::Ipv6(address) => Some(IpAddr::V6(address)),
        url::Host::Domain(_) => None,
    }
}

impl Settings {
    pub fn parse(text: &str) -> Result<Self, Error> {
        serde_json::from_str(text).map_err(|_| INVALID)
    }

    /// The daemon must be a loopback HTTP listener addressed by IP at `/v1`.
    fn upstream(&self) -> Result<Upstream, Error> {
        let url = url::Url::parse(&self.upstream).map_err(|_| INVALID)?;
        let host = ip(url.host()).ok_or(INVALID)?;
        let port = url.port().ok_or(INVALID)?;
        if url.scheme() != "http"
            || url.path() != "/v1"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || !host.is_loopback()
            || !lowercase_hex(&self.digest, 64)
            || self.model.is_empty()
        {
            return Err(INVALID);
        }
        let address = SocketAddr::new(host, port);
        Ok(Upstream {
            address,
            authority: address.to_string(),
        })
    }

    async fn bind(&self) -> Result<TcpListener, Error> {
        let url = url::Url::parse(&self.endpoint).map_err(|_| INVALID)?;
        let port = url.port_or_known_default().ok_or(INVALID)?;
        let bound = match url.host() {
            Some(url::Host::Domain(name)) => TcpListener::bind((name, port)).await,
            host => TcpListener::bind((ip(host).ok_or(INVALID)?, port)).await,
        };
        bound.map_err(|_| Error("cannot bind the proxy endpoint"))
    }
}

/// Load the volume's credential, creating it only before first initialization.
///
/// A missing key after initialization is an error, never a silent rotation.
pub fn load_key(root: &Path) -> Result<String, Error> {
    use rustix::fs::{Mode, OFlags};
    const KEY: Error = Error("managed inference credential is invalid");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root)
        .map_err(|_| KEY)?;
    let path = root.join("inference-key");
    let marker = root.join("initialized");
    match fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if fs::symlink_metadata(&marker).is_ok() {
                return Err(Error(
                    "managed inference credential is missing; regeneration forbidden",
                ));
            }
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|_| KEY)?;
            let key: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
            {
                Ok(mut file) => file
                    .write_all(key.as_bytes())
                    .and_then(|()| file.sync_all())
                    .map_err(|_| KEY)?,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
                Err(_) => return Err(KEY),
            }
        }
        Err(_) => return Err(KEY),
    }
    let file = fs::File::from(
        rustix::fs::open(
            &path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| KEY)?,
    );
    let metadata = file.metadata().map_err(|_| KEY)?;
    if !metadata.is_file()
        || metadata.mode() & 0o777 != 0o600
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.nlink() != 1
        || metadata.len() != 64
    {
        return Err(Error(
            "managed inference credential permissions are invalid",
        ));
    }
    let mut key = String::new();
    file.take(65).read_to_string(&mut key).map_err(|_| KEY)?;
    if !lowercase_hex(&key, 64) {
        return Err(KEY);
    }
    let marker = fs::File::from(
        rustix::fs::open(
            &marker,
            OFlags::WRONLY | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|_| KEY)?,
    );
    marker.sync_all().map_err(|_| KEY)?;
    fs::File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| KEY)?;
    Ok(key)
}

fn decode_address(hex: &str) -> Result<IpAddr, Error> {
    let mut bytes = Vec::with_capacity(16);
    if !hex.len().is_multiple_of(8) {
        return Err(LISTENER);
    }
    for start in (0..hex.len()).step_by(8) {
        let word = hex.get(start..start + 8).ok_or(LISTENER)?;
        // /proc prints each in-memory word as a host-endian integer.
        let value = u32::from_str_radix(word, 16).map_err(|_| LISTENER)?;
        bytes.extend(value.to_ne_bytes());
    }
    match <[u8; 4]>::try_from(bytes.as_slice()) {
        Ok(v4) => Ok(IpAddr::from(v4)),
        Err(_) => {
            let v6 = Ipv6Addr::from(<[u8; 16]>::try_from(bytes.as_slice()).map_err(|_| LISTENER)?);
            Ok(v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4))
        }
    }
}

/// Require that every listener on the daemon's port is bound to loopback.
pub fn loopback_listener(proc_net: &Path, port: u16) -> Result<(), Error> {
    let mut found = false;
    for name in ["tcp", "tcp6"] {
        let text = match fs::read_to_string(proc_net.join(name)) {
            Ok(text) => text,
            // A host without IPv6 has no IPv6 listeners.
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => return Err(LISTENER),
        };
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (Some(local), Some(state)) = (fields.get(1), fields.get(3)) else {
                return Err(LISTENER);
            };
            let (address, number) = local.split_once(':').ok_or(LISTENER)?;
            let number = u32::from_str_radix(number, 16).map_err(|_| LISTENER)?;
            if *state != "0A" || number != u32::from(port) {
                continue;
            }
            if !decode_address(address)?.is_loopback() {
                return Err(Error("external Ollama must listen only on loopback"));
            }
            found = true;
        }
    }
    found.then_some(()).ok_or(LISTENER)
}

async fn connect<B>(
    upstream: &Upstream,
) -> Result<hyper::client::conn::http1::SendRequest<B>, BoxError>
where
    B: hyper::body::Body + Send + 'static,
    B::Data: Send,
    B::Error: Into<BoxError>,
{
    let stream = TcpStream::connect(upstream.address).await?;
    let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(connection);
    Ok(sender)
}

fn reply(status: StatusCode, body: impl Into<Bytes>) -> Response<Body> {
    let mut response = Response::new(
        Full::new(body.into())
            .map_err(|never| match never {})
            .boxed_unsync(),
    );
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

/// Compare without exiting at the first differing byte.
fn same(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && std::hint::black_box(
            left.iter()
                .zip(right)
                .fold(0u8, |difference, (a, b)| difference | (a ^ b)),
        ) == 0
}

pub struct Proxy {
    model: String,
    digest: String,
    upstream: Upstream,
    authorization: Vec<u8>,
    proc_net: PathBuf,
}

impl Proxy {
    /// Validate the specification, load the credential, and check the daemon,
    /// then bind the endpoint. Nothing listens until every check passes.
    pub async fn start(
        settings: Settings,
        root: &Path,
        proc_net: &Path,
    ) -> Result<(Self, TcpListener), Error> {
        let upstream = settings.upstream()?;
        let key = load_key(root)?;
        let proxy = Self {
            authorization: format!("Bearer {key}").into_bytes(),
            model: settings.model.clone(),
            digest: settings.digest.clone(),
            upstream,
            proc_net: proc_net.to_owned(),
        };
        proxy.inventory().await?;
        let listener = settings.bind().await?;
        Ok((proxy, listener))
    }

    async fn inventory(&self) -> Result<(), Error> {
        loopback_listener(&self.proc_net, self.upstream.address.port())?;
        let body = timeout(INVENTORY_TIMEOUT, async {
            let mut sender = connect::<Empty<Bytes>>(&self.upstream).await?;
            let request = Request::get("/api/tags")
                .header(HOST, &self.upstream.authority)
                .body(Empty::new())?;
            let response = sender.send_request(request).await?;
            if response.status() != StatusCode::OK {
                return Err(INVENTORY.into());
            }
            let mut body = response.into_body();
            let mut bytes = Vec::new();
            while let Some(frame) = body.frame().await {
                if let Ok(data) = frame?.into_data() {
                    if bytes.len() + data.len() > INVENTORY_LIMIT {
                        return Err(INVENTORY.into());
                    }
                    bytes.extend_from_slice(&data);
                }
            }
            Ok::<_, BoxError>(bytes)
        })
        .await
        .map_err(|_| INVENTORY)?
        .map_err(|_| INVENTORY)?;
        let inventory: Value = serde_json::from_slice(&body).map_err(|_| INVENTORY)?;
        let models = inventory["models"].as_array().ok_or(INVENTORY)?;
        let mut names = std::collections::BTreeSet::new();
        for model in models {
            if !names.insert(model["name"].as_str().ok_or(INVENTORY)?) {
                return Err(Error("external model inventory is ambiguous"));
            }
        }
        let pinned = models
            .iter()
            .find(|model| model["name"] == self.model.as_str())
            .filter(|model| {
                model["digest"] == self.digest.as_str()
                    && model["size"].as_f64().is_some_and(|size| size > 0.0)
            });
        pinned
            .map(|_| ())
            .ok_or(Error("external model is absent or its digest changed"))
    }

    async fn dispatch(&self, request: Request<Incoming>) -> Result<Response<Body>, StatusCode> {
        let mut authorization = request.headers().get_all(AUTHORIZATION).iter();
        match (authorization.next(), authorization.next()) {
            (Some(value), None) if same(value.as_bytes(), &self.authorization) => {}
            _ => return Err(StatusCode::UNAUTHORIZED),
        }
        let target = request.uri().to_string();
        let post = match (request.method(), target.as_str()) {
            (&Method::GET, "/v1/models") => false,
            (&Method::POST, "/v1/chat/completions") => true,
            _ => return Err(StatusCode::NOT_FOUND),
        };
        if request.headers().contains_key(TRANSFER_ENCODING)
            || request.headers().get_all(CONTENT_LENGTH).iter().count() > 1
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        let mut body = Bytes::new();
        if post {
            let size = match request.headers().get(CONTENT_LENGTH) {
                None => 0,
                Some(value) => value
                    .to_str()
                    .ok()
                    .and_then(|text| text.parse::<u64>().ok())
                    .ok_or(StatusCode::BAD_REQUEST)?,
            };
            if !(1..=REQUEST_LIMIT).contains(&size) {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            body = timeout(CLIENT_TIMEOUT, request.into_body().collect())
                .await
                .map_err(|_| StatusCode::BAD_REQUEST)?
                .map_err(|_| StatusCode::BAD_REQUEST)?
                .to_bytes();
            if body.len() as u64 != size {
                return Err(StatusCode::BAD_REQUEST);
            }
            let payload: Value =
                serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)?;
            if !payload.is_object() || payload["model"] != self.model.as_str() {
                return Err(StatusCode::FORBIDDEN);
            }
        }
        self.inventory()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        if !post {
            let models = json!({
                "object": "list",
                "data": [{"id": self.model, "object": "model", "owned_by": "ollama"}],
            });
            return Ok(reply(StatusCode::OK, models.to_string()));
        }
        self.forward(body).await.ok_or(StatusCode::BAD_GATEWAY)
    }

    /// Rebuild the request with fresh headers; the proxy credential never reaches the daemon.
    async fn forward(&self, body: Bytes) -> Option<Response<Body>> {
        let response = timeout(UPSTREAM_TIMEOUT, async {
            let mut sender = connect::<Full<Bytes>>(&self.upstream).await?;
            let request = Request::post("/v1/chat/completions")
                .header(HOST, &self.upstream.authority)
                .header(CONTENT_TYPE, "application/json")
                .body(Full::new(body))?;
            Ok::<_, BoxError>(sender.send_request(request).await?)
        })
        .await
        .ok()?
        .ok()?;
        if response.status().is_redirection() {
            return None;
        }
        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .cloned()
            .unwrap_or(HeaderValue::from_static("application/json"));
        // Stream data as it arrives; an upstream failure aborts the response
        // instead of completing it, so clients see a truncated stream.
        let frames = futures_util::stream::unfold(Some(response.into_body()), |state| async move {
            let mut body = state?;
            loop {
                match timeout(UPSTREAM_TIMEOUT, body.frame()).await {
                    Ok(None) => return None,
                    Ok(Some(Ok(frame))) => {
                        if let Ok(data) = frame.into_data() {
                            return Some((Ok(Frame::data(data)), Some(body)));
                        }
                    }
                    Ok(Some(Err(error))) => return Some((Err(BoxError::from(error)), None)),
                    Err(_) => return Some((Err(BoxError::from("upstream timed out")), None)),
                }
            }
        });
        let mut response = Response::new(StreamBody::new(frames).boxed_unsync());
        *response.status_mut() = status;
        response.headers_mut().insert(CONTENT_TYPE, content_type);
        Some(response)
    }

    async fn handle(
        self: Arc<Self>,
        request: Request<Incoming>,
    ) -> Result<Response<Body>, Infallible> {
        Ok(self
            .dispatch(request)
            .await
            .unwrap_or_else(|status| reply(status, Bytes::new())))
    }

    /// Serve one request per connection, at most 32 at a time; excess connections close.
    pub async fn serve(self, listener: TcpListener) {
        let proxy = Arc::new(self);
        let slots = Arc::new(Semaphore::new(CONNECTIONS));
        let mut builder = http1::Builder::new();
        builder
            .timer(TokioTimer::new())
            .header_read_timeout(CLIENT_TIMEOUT)
            .keep_alive(false);
        let builder = Arc::new(builder);
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                // Out of descriptors or a transient error: retry without exiting.
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            let Ok(slot) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let proxy = proxy.clone();
            let builder = builder.clone();
            tokio::spawn(async move {
                let _slot = slot;
                let service = service_fn(move |request| proxy.clone().handle(request));
                let _ = builder
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    }
}

#[cfg(test)]
mod tests;
