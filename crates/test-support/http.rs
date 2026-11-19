// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// A minimal HTTP/1.1 test server, shared through private source modules by
// SDK, provider, runtime and E2E tests. It has no NemoClaw dependency, so
// reuse does not create a crate dependency cycle. Each includer uses a subset.
#![allow(
    dead_code,
    reason = "each test binary that includes this module uses a different subset of it"
)]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
pub struct Request {
    pub method: String,
    pub path: String,
    /// Header names are lowercase.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find_map(|(key, value)| (*key == name).then_some(value.as_str()))
    }
}
/// A status, extra response headers, and a body.
pub type Reply = (u16, Vec<(String, String)>, Vec<u8>);
/// Answers each connection with the handler's status and JSON body, or closes
/// it without a response when the handler returns `None`.
pub struct Fixture {
    pub endpoint: String,
    _directory: Option<tempfile::TempDir>,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    /// Serve a Docker-style engine API on a Unix socket; `/v1.NN` path
    /// prefixes are removed before the handler sees them.
    #[cfg(unix)]
    pub async fn start(
        handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut fixture = Self::start_at(&directory.path().join("engine.sock"), handler).await;
        fixture._directory = Some(directory);
        fixture
    }
    /// Serve like [`Self::start`] at `path`, which the caller owns and removes.
    #[cfg(unix)]
    pub async fn start_at(
        path: &std::path::Path,
        mut handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        Self::start_at_with_headers(path, move |request| {
            handler(request).map(|(status, body)| (status, Vec::new(), body))
        })
        .await
    }
    /// Serve like [`Self::start_at`], with response headers from the handler.
    #[cfg(unix)]
    pub async fn start_at_with_headers(
        path: &std::path::Path,
        mut handler: impl FnMut(Request) -> Option<Reply> + Send + 'static,
    ) -> Self {
        let listener = tokio::net::UnixListener::bind(path).unwrap();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                serve_with_headers(stream, &mut handler).await;
            }
        });
        Self {
            endpoint: format!("unix://{}", path.display()),
            _directory: None,
            task,
        }
    }
    /// Serve a Docker-style engine API where this platform's local engines
    /// listen: a Unix socket, or on Windows a named pipe.
    pub async fn engine(
        handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        #[cfg(unix)]
        {
            Self::start(handler).await
        }
        #[cfg(windows)]
        {
            Self::start_pipe(handler)
        }
    }
    /// Serve on a new named pipe; `endpoint` is `npipe:////./pipe/NAME`.
    #[cfg(windows)]
    fn start_pipe(
        mut handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        use tokio::net::windows::named_pipe::ServerOptions;
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let name = format!(
            "nemoclaw-fixture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let path = format!(r"\\.\pipe\{name}");
        let mut listening = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path)
            .unwrap();
        let task = tokio::spawn(async move {
            loop {
                listening.connect().await.unwrap();
                // A client finds the pipe only while an instance listens.
                let connected =
                    std::mem::replace(&mut listening, ServerOptions::new().create(&path).unwrap());
                serve(connected, &mut handler).await;
            }
        });
        Self {
            endpoint: format!("npipe:////./pipe/{name}"),
            _directory: None,
            task,
        }
    }
    /// Serve on an ephemeral loopback port; `endpoint` is `http://127.0.0.1:PORT`.
    pub async fn start_tcp(
        handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        Self::start_tcp_at("127.0.0.1:0", handler).await
    }
    /// Serve on a caller-owned address, including a live case's host port.
    pub async fn start_tcp_at(
        address: &str,
        mut handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind(address).await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                serve(stream, &mut handler).await;
            }
        });
        Self {
            endpoint,
            _directory: None,
            task,
        }
    }
}
/// A fixture executable from `nemoclaw-test-fixtures` or
/// `nemoclaw-fixture-provider`, such as the fake `ssh` relay.
///
/// Cargo's `CARGO_BIN_EXE_*` names only the executables of a test's own
/// package, so the test runner names their directory in
/// `NEMOCLAW_TEST_FIXTURES`: `cargo ci` sets it to `target/debug`, where
/// Cargo puts a build's executables.
#[must_use]
pub fn fixture_executable(name: &str) -> std::path::PathBuf {
    let directory = std::env::var_os("NEMOCLAW_TEST_FIXTURES").expect(
        "NEMOCLAW_TEST_FIXTURES must name the directory of the fixture executables, such as $PWD/target/debug after cargo build -p nemoclaw-test-fixtures -p nemoclaw-fixture-provider; cargo ci sets it",
    );
    let path =
        std::path::Path::new(&directory).join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    assert!(
        path.is_file(),
        "{} is missing; build it with cargo build -p nemoclaw-test-fixtures -p nemoclaw-fixture-provider",
        path.display()
    );
    path
}
async fn serve(
    stream: impl AsyncRead + AsyncWrite + Unpin,
    handler: &mut impl FnMut(Request) -> Option<(u16, Vec<u8>)>,
) {
    serve_with_headers(stream, &mut |request| {
        handler(request).map(|(status, body)| (status, Vec::new(), body))
    })
    .await;
}
async fn serve_with_headers(
    mut stream: impl AsyncRead + AsyncWrite + Unpin,
    handler: &mut impl FnMut(Request) -> Option<Reply>,
) {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        match stream.read_u8().await {
            Ok(byte) => bytes.push(byte),
            Err(_) => return,
        }
    }
    let header = String::from_utf8(bytes).unwrap();
    let mut lines = header.lines();
    let mut first = lines.next().unwrap().split_whitespace();
    let method = first.next().unwrap().into();
    let path = first.next().unwrap().to_owned();
    let path = if path.starts_with("/v1.") {
        format!("/{}", path.split('/').skip(2).collect::<Vec<_>>().join("/"))
    } else {
        path
    };
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect::<Vec<_>>();
    let size = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map(|(_, size)| size.parse::<usize>().unwrap())
        .unwrap_or(0);
    let mut body = vec![0; size];
    if stream.read_exact(&mut body).await.is_err() {
        return;
    }
    if let Some((status, extra, body)) = handler(Request {
        method,
        path,
        headers,
        body,
    }) {
        let extra: String = extra
            .iter()
            .map(|(name, value)| format!("{name}: {value}\r\n"))
            .collect();
        let header = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        if stream.write_all(header.as_bytes()).await.is_ok() {
            let _ = stream.write_all(&body).await;
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
