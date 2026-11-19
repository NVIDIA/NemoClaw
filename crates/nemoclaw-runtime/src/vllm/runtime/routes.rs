// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Bearer-mode route filter. Native vLLM authentication guards only `/v1`
//! paths, and recipe `VLLM_*` variables can register management routes under
//! `/v1`. The supervisor therefore serves the published port itself and
//! forwards only the inference requests NemoClaw routes to, plus the public
//! health probe, to vLLM on loopback; vLLM still checks the key.

#[cfg(test)]
mod tests;

#[cfg(test)]
use crate::CancellationToken;
use crate::Error;
#[cfg(test)]
use crate::execution::supervisor::{self, Monitors, with_filter as supervise};
use http_body_util::{Either, Full};
use hyper::{
    HeaderMap, Method, Request, Response, StatusCode, Uri,
    body::{Bytes, Incoming},
    header::{self, HeaderName, HeaderValue},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    convert::Infallible,
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinSet,
};

/// A client must send a complete request head within this time.
pub(super) const HEADER_TIMEOUT: Duration = Duration::from_secs(30);

/// Client connections the filter serves at once, far more than the sequences
/// vLLM runs concurrently; later clients wait in the listen backlog.
const CONNECTIONS: usize = 256;

/// Descriptors kept for the supervisor itself, which must keep sampling
/// memory, reporting status and probing readiness however many clients
/// connect. Running out stops vLLM.
const RESERVED_DESCRIPTORS: u64 = 128;

/// Raise the supervisor's open-file limit to its maximum, as vLLM raises its
/// own, and return how many connections the filter can serve. Call it after
/// vLLM starts, so vLLM inherits the container's limit unchanged.
pub(super) fn connections() -> usize {
    use rustix::process::{Resource, Rlimit, getrlimit, setrlimit};
    let limit = getrlimit(Resource::Nofile);
    let _ = setrlimit(
        Resource::Nofile,
        Rlimit {
            current: limit.maximum,
            ..limit
        },
    );
    capacity(getrlimit(Resource::Nofile).current.unwrap_or(u64::MAX))
}

/// The connections that fit beside the reserve, up to the cap. Each holds two
/// descriptors: the client's socket and the one to vLLM.
fn capacity(descriptors: u64) -> usize {
    let fit = descriptors.saturating_sub(RESERVED_DESCRIPTORS) / 2;
    usize::try_from(fit)
        .unwrap_or(usize::MAX)
        .clamp(1, CONNECTIONS)
}

/// Model listing and the request endpoints of the Chat Completions,
/// Completions, Responses, and Anthropic Messages APIs, each of which requires
/// the key, and the public readiness probe.
const ROUTES: [(Method, &str); 7] = [
    (Method::GET, "/health"),
    (Method::GET, "/v1/models"),
    (Method::POST, "/v1/chat/completions"),
    (Method::POST, "/v1/completions"),
    (Method::POST, "/v1/responses"),
    (Method::POST, "/v1/messages"),
    (Method::POST, "/v1/messages/count_tokens"),
];

/// Whether vLLM may receive a request. The path is compared exactly as
/// received, without percent-decoding or dot-segment removal, so any other
/// spelling of an allowed path is rejected rather than interpreted. Only
/// origin-form targets match, and protocol upgrades never reach vLLM.
fn allowed(method: &Method, uri: &Uri, headers: &HeaderMap) -> bool {
    uri.scheme().is_none()
        && uri.authority().is_none()
        && !headers.contains_key(header::UPGRADE)
        && ROUTES
            .iter()
            .any(|(route, path)| route == method && *path == uri.path())
}

/// Remove the headers that describe one connection rather than the message.
fn remove_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect();
    for name in named.iter().chain(&[
        header::CONNECTION,
        HeaderName::from_static("keep-alive"),
        header::TE,
        header::TRAILER,
        header::TRANSFER_ENCODING,
        header::UPGRADE,
    ]) {
        headers.remove(name);
    }
    let proxy: Vec<HeaderName> = headers
        .keys()
        .filter(|name| name.as_str().starts_with("proxy-"))
        .cloned()
        .collect();
    for name in proxy {
        headers.remove(name);
    }
}

type Body = Either<Incoming, Full<Bytes>>;

fn reply(status: StatusCode, body: &'static str) -> Response<Body> {
    let mut response = Response::new(Either::Right(Full::new(Bytes::from_static(
        body.as_bytes(),
    ))));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

/// Forward an allowed request on a new loopback connection and stream both
/// bodies, so completion events reach the client as vLLM produces them.
async fn forward(
    backend: SocketAddr,
    client: SocketAddr,
    request: Request<Incoming>,
) -> Response<Body> {
    if !allowed(request.method(), request.uri(), request.headers()) {
        return reply(StatusCode::NOT_FOUND, r#"{"error":"Not found"}"#);
    }
    let (parts, body) = request.into_parts();
    let mut upstream = Request::new(body);
    *upstream.method_mut() = parts.method;
    *upstream.uri_mut() = parts.uri;
    *upstream.headers_mut() = parts.headers;
    remove_hop_by_hop(upstream.headers_mut());
    // vLLM's server trusts forwarding headers from loopback, where every
    // filtered request comes from. Name the connecting client so vLLM never
    // records an address or scheme that a client claims.
    let headers = upstream.headers_mut();
    headers.remove(HeaderName::from_static("x-forwarded-proto"));
    if let Ok(address) = HeaderValue::try_from(client.ip().to_string()) {
        headers.insert(HeaderName::from_static("x-forwarded-for"), address);
    }
    let response = async {
        let stream = TcpStream::connect(backend).await?;
        stream.set_nodelay(true)?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
        // The connection ends with the response body, which the client's
        // connection owns; a client that disconnects closes it too.
        tokio::spawn(connection);
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(sender.send_request(upstream).await?)
    }
    .await;
    let response = match response {
        Ok(response) => response,
        // hyper reports a client body that cannot be read, such as one with
        // invalid chunked framing, as a user error of the forwarded request.
        Err(error)
            if error
                .downcast_ref::<hyper::Error>()
                .is_some_and(hyper::Error::is_user) =>
        {
            return reply(StatusCode::BAD_REQUEST, r#"{"error":"Bad request"}"#);
        }
        Err(_) => return reply(StatusCode::BAD_GATEWAY, r#"{"error":"Bad gateway"}"#),
    };
    let (parts, body) = response.into_parts();
    let mut response = Response::new(Either::Left(body));
    *response.status_mut() = parts.status;
    *response.headers_mut() = parts.headers;
    remove_hop_by_hop(response.headers_mut());
    response
}

/// Bind the published port on every interface, as vLLM does without
/// authentication. The caller binds before starting vLLM, so a port conflict
/// fails startup.
pub(super) async fn bind(port: u16) -> Result<TcpListener, Error> {
    TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))
        .await
        .map_err(|_| Error::Conflict("cannot bind the inference port for the route filter"))
}

/// Serve HTTP/1.1 until dropped, which closes the listener and every accepted
/// connection. At most `connections` are served at once; later clients wait
/// in the listen backlog, where they hold none of the supervisor's
/// descriptors. Accept failures, such as descriptor exhaustion, are retried,
/// so this returns only by panicking.
pub(super) async fn serve(
    listener: TcpListener,
    backend: SocketAddr,
    header_timeout: Duration,
    connections: usize,
) -> Infallible {
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(header_timeout);
    let slots = Arc::new(Semaphore::new(connections));
    let mut connections = JoinSet::new();
    loop {
        while connections.try_join_next().is_some() {}
        let slot = slots
            .clone()
            .acquire_owned()
            .await
            .expect("the filter never closes its connection slots");
        let Ok((stream, client)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        // Send each streamed event at once rather than coalescing small writes.
        let _ = stream.set_nodelay(true);
        let connection = builder.serve_connection(
            TokioIo::new(stream),
            service_fn(move |request| async move {
                Ok::<_, Infallible>(forward(backend, client, request).await)
            }),
        );
        connections.spawn(async move {
            let _ = connection.await;
            drop(slot);
        });
    }
}
