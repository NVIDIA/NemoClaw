// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// A minimal HTTP/1.1 test server, shared through private source modules by
// SDK, provider, runtime and E2E tests. It has no NemoClaw dependency, so
// reuse does not create a crate dependency cycle. Each includer uses a subset.
#![allow(dead_code)]
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
        mut handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("engine.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                serve(stream, &mut handler).await;
            }
        });
        Self {
            endpoint: format!("unix://{}", path.display()),
            _directory: Some(directory),
            task,
        }
    }
    /// Serve a Docker-style engine API at an endpoint NemoClaw reaches on this
    /// platform: a Unix socket, or elsewhere `ssh://127.0.0.1:PORT`, which
    /// the `nemoclaw-fixture-ssh` relay forwards to a loopback port.
    pub async fn engine(
        handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        #[cfg(unix)]
        {
            Self::start(handler).await
        }
        #[cfg(not(unix))]
        {
            relay_as_ssh();
            let mut fixture = Self::start_tcp(handler).await;
            fixture.endpoint = fixture.endpoint.replacen("http://", "ssh://", 1);
            fixture
        }
    }
    /// Serve on an ephemeral loopback port; `endpoint` is `http://127.0.0.1:PORT`.
    pub async fn start_tcp(
        mut handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
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
/// Install the relay as `ssh` beside this test executable, once. Windows
/// resolves a bare program name in the launching executable's directory
/// before `PATH`, so the engine client reaches the relay without changing the
/// environment. The relay is built beside the test executables' `deps`.
#[cfg(not(unix))]
fn relay_as_ssh() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let executable = std::env::current_exe().unwrap();
        let deps = executable.parent().unwrap();
        let relay = deps.parent().unwrap().join(format!(
            "nemoclaw-fixture-ssh{}",
            std::env::consts::EXE_SUFFIX
        ));
        assert!(
            relay.is_file(),
            "{} is missing; build it with cargo build -p nemoclaw-test-fixtures",
            relay.display()
        );
        // Other test executables install it too; replace it atomically.
        let staged = deps.join(format!("ssh-{}.tmp", std::process::id()));
        std::fs::copy(&relay, &staged).unwrap();
        let installed = deps.join(format!("ssh{}", std::env::consts::EXE_SUFFIX));
        if std::fs::rename(&staged, &installed).is_err() {
            // A running relay keeps the file open; the installed copy serves.
            let _ = std::fs::remove_file(&staged);
            assert!(installed.is_file());
        }
    });
}
async fn serve(
    mut stream: impl AsyncRead + AsyncWrite + Unpin,
    handler: &mut impl FnMut(Request) -> Option<(u16, Vec<u8>)>,
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
    if let Some((status, body)) = handler(Request {
        method,
        path,
        headers,
        body,
    }) {
        let header = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
