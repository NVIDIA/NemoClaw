// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// A minimal HTTP/1.1 test server, shared through private source modules by
// SDK, provider, runtime and E2E tests. It has no NemoClaw dependency, so
// reuse does not create a crate dependency cycle. Each includer uses a subset.
#![allow(dead_code)]
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
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
/// Answers each request with the handler's status and JSON body, or closes the
/// connection without a response when the handler returns `None`. A
/// connection stays open for further requests until the client closes it or
/// sends `Connection: close`; the fixture also closes it after a 1xx, 204 or
/// 304 status and after answering `HEAD`. Requests that a client sends before
/// the previous answer arrives are answered in order. Request bodies must be
/// framed by `Content-Length`. The fixture never switches protocols: it
/// answers an `Upgrade` request, such as a Kubernetes exec, like any other
/// request. Dropping the fixture closes every connection.
pub struct Fixture {
    pub endpoint: String,
    _directory: Option<tempfile::TempDir>,
    task: tokio::task::JoinHandle<()>,
    connections: ConnectionTasks,
}
impl Fixture {
    /// Serve a Docker-style engine API on a Unix socket; `/v1.NN` path
    /// prefixes are removed before the handler sees them.
    #[cfg(unix)]
    pub async fn start(
        handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("engine.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let connections = Connections::new(handler);
        let tasks = connections.tasks.clone();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                connections.serve(stream);
            }
        });
        Self {
            endpoint: format!("unix://{}", path.display()),
            _directory: Some(directory),
            task,
            connections: tasks,
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
        handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let connections = Connections::new(handler);
        let tasks = connections.tasks.clone();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                // Nagle would hold a response until the client's delayed ACK,
                // which costs up to 200 ms per request on Windows. macOS can
                // refuse the option on a stream its peer already reset; that
                // stream then fails like any closed connection.
                let _ = stream.set_nodelay(true);
                connections.serve(stream);
            }
        });
        Self {
            endpoint,
            _directory: None,
            task,
            connections: tasks,
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
/// The tasks serving one fixture's connections. Dropping the fixture takes and
/// drops the set, which aborts every task.
type ConnectionTasks = Arc<Mutex<Option<tokio::task::JoinSet<()>>>>;
/// Serves each connection of one fixture on its own task, so that a client
/// holding a connection open does not block other clients. Requests still
/// reach the handler one at a time.
struct Connections<H> {
    handler: Arc<Mutex<H>>,
    tasks: ConnectionTasks,
}
impl<H: FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static> Connections<H> {
    fn new(handler: H) -> Self {
        Self {
            handler: Arc::new(Mutex::new(handler)),
            tasks: Arc::new(Mutex::new(Some(tokio::task::JoinSet::new()))),
        }
    }
    fn serve(&self, stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static) {
        // After the fixture is dropped, a stream accepted during the drop
        // closes here instead of being served.
        if let Some(tasks) = self.tasks.lock().unwrap().as_mut() {
            while tasks.try_join_next().is_some() {}
            tasks.spawn(serve(stream, self.handler.clone()));
        }
    }
}
/// Answer requests on one connection until the client closes it, a request or
/// response is the connection's last, or the handler returns `None`.
async fn serve(
    stream: impl AsyncRead + AsyncWrite + Unpin,
    handler: Arc<Mutex<impl FnMut(Request) -> Option<(u16, Vec<u8>)>>>,
) {
    // Read through a buffer, not a byte per socket read. One buffer serves the
    // whole connection: a read can return the start of the next request,
    // which a buffer dropped after this request would lose. Writes bypass the
    // buffer.
    let mut stream = BufReader::new(stream);
    loop {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            match stream.read_until(b'\n', &mut bytes).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
        let header = String::from_utf8(bytes).unwrap();
        let mut lines = header.lines();
        let mut first = lines.next().unwrap().split_whitespace();
        let method = first.next().unwrap().to_owned();
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
        // Only HTTP/1.1 keeps a connection open by default, and a request can
        // ask to close it. The fixture reads only Content-Length bodies, so a
        // request with a Transfer-Encoding is the last too: its body cannot be
        // told apart from the next request.
        let last = first.next() != Some("HTTP/1.1")
            || headers.iter().any(|(name, value)| {
                name == "transfer-encoding"
                    || (name == "connection"
                        && value
                            .split(',')
                            .any(|option| option.trim().eq_ignore_ascii_case("close")))
            });
        let size = headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .map(|(_, size)| size.parse::<usize>().unwrap())
            .unwrap_or(0);
        let mut body = vec![0; size];
        if stream.read_exact(&mut body).await.is_err() {
            return;
        }
        let head = method == "HEAD";
        let answer = (*handler.lock().unwrap())(Request {
            method,
            path,
            headers,
            body,
        });
        let Some((status, body)) = answer else {
            return;
        };
        // A client reads no body after a 1xx, 204 or 304 status or in answer
        // to HEAD, and still waits for a final status after a 1xx. Closing
        // the connection ends such a response, so its body cannot be read as
        // the next response and a missing final status cannot hang the client.
        let last = last || head || status < 200 || status == 204 || status == 304;
        // One write per response, so no part of it waits on an ACK.
        let mut response = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n",
            body.len(),
            if last { "Connection: close\r\n" } else { "" },
        )
        .into_bytes();
        response.extend_from_slice(&body);
        if stream.write_all(&response).await.is_err() || last {
            return;
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        // Abort the connection tasks here rather than when the runtime next
        // polls the accept loop. Another worker could otherwise serve a
        // request waiting on a kept connection in between. Only a task being
        // polled at this moment can still finish its response.
        self.connections.lock().unwrap().take();
    }
}
