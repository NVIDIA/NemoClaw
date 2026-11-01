// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Test fixture only. A TCP accept/read is not an HTTP navigation result.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct Observation {
    pub kind: &'static str,
    pub bytes: usize,
    pub request_line_prefix_hex: String,
}
#[derive(Debug)]
pub struct Receipt {
    pub observations: Vec<Observation>,
    pub elapsed_ms: u128,
}

fn observe(kind: &'static str, bytes: &[u8]) -> Observation {
    // Never retain headers: stop at the first line boundary and at64 bytes.
    let line = bytes
        .split(|byte| *byte == b'\n' || *byte == b'\r')
        .next()
        .unwrap_or_default();
    Observation {
        kind,
        bytes: bytes.len(),
        request_line_prefix_hex: line
            .iter()
            .take(64)
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    }
}

pub fn serve_root(listener: TcpListener, total: Duration) -> Result<Receipt, (String, Receipt)> {
    let start = Instant::now();
    let deadline = start + total;
    let mut receipt = Receipt {
        observations: Vec::new(),
        elapsed_ms: 0,
    };
    let result = (|| -> Result<(), String> {
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        while Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => return Err(error.to_string()),
            };
            if receipt.observations.len() >= 16 {
                return Err("HTTP connection bound exceeded".into());
            }
            stream
                .set_nonblocking(false)
                .map_err(|error| error.to_string())?;
            let socket_deadline = deadline.min(Instant::now() + Duration::from_secs(5));
            let mut request = Vec::new();
            loop {
                let remaining = socket_deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    receipt
                        .observations
                        .push(observe("read-deadline", &request));
                    if request.is_empty() {
                        break;
                    }
                    return Err("Partial HTTP request exceeded its existing socket bound".into());
                }
                stream
                    .set_read_timeout(Some(remaining))
                    .map_err(|error| error.to_string())?;
                let mut chunk = [0; 256];
                match stream.read(&mut chunk) {
                    Ok(0) => {
                        receipt.observations.push(observe("eof", &request));
                        if request.is_empty() {
                            break;
                        }
                        return Err("Partial HTTP request closed before headers completed".into());
                    }
                    Ok(length) => request.extend_from_slice(&chunk[..length]),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        continue;
                    }
                    Err(error) => {
                        receipt.observations.push(observe("read-error", &request));
                        return Err(error.to_string());
                    }
                }
                if request.len() > 4096 {
                    receipt.observations.push(observe("oversized", &request));
                    return Err("HTTP header bound exceeded".into());
                }
                if let Some(end) = request.windows(2).position(|bytes| bytes == b"\r\n") {
                    if &request[..end] != b"GET / HTTP/1.1" {
                        receipt
                            .observations
                            .push(observe("unexpected-request-line", &request));
                        return Err("Expected exact GET / HTTP/1.1 request line".into());
                    }
                }
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    // The full bounded headers are consumed so closing this fixture
                    // does not reset a response merely because unread headers remain.
                    receipt
                        .observations
                        .push(observe("root-get-received", &request));
                    let body = b"NemoClaw browser owner proof";
                    let headers = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n",
                        body.len()
                    );
                    let remaining = socket_deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err("HTTP response exceeded the existing socket bound".into());
                    }
                    stream
                        .set_write_timeout(Some(remaining))
                        .map_err(|error| error.to_string())?;
                    let mut response = headers.into_bytes();
                    response.extend_from_slice(body);
                    stream
                        .write_all(&response)
                        .map_err(|error| error.to_string())?;
                    receipt.observations.last_mut().unwrap().kind = "root-get-served";
                    return Ok(());
                }
            }
        }
        Err("The actual browser did not request the owned root within20s".into())
    })();
    receipt.elapsed_ms = start.elapsed().as_millis();
    match result {
        Ok(()) => Ok(receipt),
        Err(error) => Err((error, receipt)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Shutdown, TcpStream};
    #[test]
    fn empty_connection_then_fragmented_http_requires_real_complete_root_request() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || serve_root(listener, Duration::from_secs(2)));
        let empty = TcpStream::connect(address).unwrap();
        empty.shutdown(Shutdown::Both).unwrap();
        drop(empty);
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        for fragment in [
            b"GE".as_slice(),
            b"T / HTTP/1.1\r",
            b"\nHost: local-owned-fixture\r\n",
            b"\r\n",
        ] {
            client.write_all(fragment).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.ends_with("NemoClaw browser owner proof"));
        let receipt = server.join().unwrap().unwrap();
        assert!(receipt.elapsed_ms < 2000);
        assert_eq!(receipt.observations.len(), 2);
        assert_eq!(receipt.observations[0].bytes, 0);
        assert_eq!(receipt.observations[1].kind, "root-get-served");
        assert_eq!(
            receipt.observations[1].request_line_prefix_hex,
            "474554202f20485454502f312e31"
        );
    }
    #[test]
    fn non_root_request_cannot_satisfy_browser_navigation_and_retains_only_bounded_line() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || serve_root(listener, Duration::from_secs(2)));
        let mut client = TcpStream::connect(address).unwrap();
        client
            .write_all(b"GET /other HTTP/1.1\r\nAuthorization: never-retain-header\r\n\r\n")
            .unwrap();
        let (error, receipt) = server.join().unwrap().unwrap_err();
        assert!(error.contains("exact GET /"));
        assert_eq!(receipt.observations[0].kind, "unexpected-request-line");
        assert_eq!(
            receipt.observations[0].request_line_prefix_hex,
            "474554202f6f7468657220485454502f312e31"
        );
        assert!(receipt.observations[0].request_line_prefix_hex.len() <= 128);
    }
}
