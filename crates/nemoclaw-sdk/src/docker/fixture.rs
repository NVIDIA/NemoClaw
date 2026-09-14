// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use tokio::io::{AsyncReadExt, AsyncWriteExt};
pub(crate) struct Request {
    pub method: String,
    pub path: String,
    pub body: Vec<u8>,
}
pub(crate) struct Fixture {
    pub endpoint: String,
    _directory: tempfile::TempDir,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    pub fn engine_for(&self, logical_endpoint: &str) -> super::Engine {
        let mut engine = super::Engine::connect(&self.endpoint).unwrap();
        engine.endpoint = logical_endpoint.into();
        engine
    }
    pub async fn start(
        mut handler: impl FnMut(Request) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("engine.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    match stream.read_u8().await {
                        Ok(byte) => bytes.push(byte),
                        Err(_) => break,
                    }
                }
                let header = String::from_utf8(bytes).unwrap();
                let mut first = header.lines().next().unwrap().split_whitespace();
                let method = first.next().unwrap().into();
                let path = first.next().unwrap().to_owned();
                let path = if path.starts_with("/v1.") {
                    format!("/{}", path.split('/').skip(2).collect::<Vec<_>>().join("/"))
                } else {
                    path
                };
                let size = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .map(|size| size.parse::<usize>().unwrap())
                    .unwrap_or(0);
                let mut body = vec![0; size];
                stream.read_exact(&mut body).await.unwrap();
                if let Some((status, body)) = handler(Request { method, path, body }) {
                    let header = format!(
                        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    stream.write_all(header.as_bytes()).await.unwrap();
                    stream.write_all(&body).await.unwrap();
                }
            }
        });
        Self {
            endpoint: format!("unix://{}", path.display()),
            _directory: directory,
            task,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
