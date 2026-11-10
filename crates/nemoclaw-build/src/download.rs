// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Download pinned build inputs and keep them by checksum.

use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, String>;

/// A remote file pinned by its exact bytes, as `versions.json` lists it.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
}

/// Where verified downloads are kept, each named by its SHA-256.
pub const DIRECTORY: &str = ".build/downloads";
/// The largest file a pin may name.
const SIZE_LIMIT: usize = 256 << 20;

/// The artifact's bytes from [`DIRECTORY`], or downloaded over HTTPS, checked
/// against its pinned SHA-256, and kept there.
pub async fn download(artifact: &Artifact) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| format!("cannot create the download client: {error}"))?;
    Downloads {
        directory: DIRECTORY.into(),
        client,
        require_https: true,
        retry: RETRY,
    }
    .get(artifact)
    .await
}

struct Downloads {
    directory: PathBuf,
    client: reqwest::Client,
    /// Refuse origins other than HTTPS; only tests' loopback fixtures don't.
    require_https: bool,
    retry: Retry,
}

/// When to repeat a request whose response says the server may answer later:
/// 429 Too Many Requests, or a server error. Other responses, transfer errors,
/// and checksum failures fail at once.
struct Retry {
    /// Requests in all, including the first.
    attempts: u32,
    /// The wait before the first retry when the response has no Retry-After;
    /// it doubles for each later retry.
    backoff: Duration,
    /// The longest wait. A larger Retry-After stops retries rather than
    /// sending another request before the server allows it.
    cap: Duration,
}

const RETRY: Retry = Retry {
    attempts: 4,
    backoff: Duration::from_secs(2),
    cap: Duration::from_secs(60),
};

impl Retry {
    /// The wait before request `attempt + 1`, or none if the server's
    /// requested wait exceeds the budget.
    fn wait(&self, attempt: u32, retry_after: Option<&str>) -> Option<Duration> {
        if let Some(wait) = retry_after.and_then(requested_wait) {
            return (wait <= self.cap).then_some(wait);
        }
        Some(
            self.backoff
                .saturating_mul(1 << (attempt - 1).min(16))
                .min(self.cap),
        )
    }
}

/// The wait a Retry-After value asks for: seconds, or an HTTP date.
fn requested_wait(value: &str) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let date =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc2822).ok()?;
    Some(Duration::try_from(date - time::OffsetDateTime::now_utc()).unwrap_or(Duration::ZERO))
}

impl Downloads {
    async fn get(&self, artifact: &Artifact) -> Result<Vec<u8>> {
        let directory = &self.directory;
        fs::create_dir_all(directory)
            .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
        let path = directory.join(&artifact.sha256);
        if path.is_file() {
            let bytes = fs::read(&path)
                .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
            if crate::hex(&Sha256::digest(&bytes)) == artifact.sha256 {
                return Ok(bytes);
            }
            return Err("cached build artifact failed its immutable checksum".into());
        }
        if self.require_https && !artifact.url.starts_with("https://") {
            return Err("artifact origin must use HTTPS".into());
        }
        let bytes = self.fetch(&artifact.url).await?;
        if crate::hex(&Sha256::digest(&bytes)) != artifact.sha256 {
            return Err("downloaded artifact failed its immutable checksum".into());
        }
        keep(directory, &path, &bytes)
            .map_err(|error| format!("cannot keep {}: {error}", artifact.url))?;
        Ok(bytes)
    }

    async fn fetch(&self, url: &str) -> Result<Vec<u8>> {
        let failed = |error: reqwest::Error| format!("cannot download {url}: {error}");
        let mut attempt = 1;
        let mut response = loop {
            let response = self.client.get(url).send().await.map_err(failed)?;
            let status = response.status();
            if (status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error())
                && attempt < self.retry.attempts
            {
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok());
                let Some(wait) = self.retry.wait(attempt, retry_after) else {
                    return Err(format!(
                        "{url} answered {status}; Retry-After exceeds the {} s retry wait budget",
                        self.retry.cap.as_secs()
                    ));
                };
                eprintln!(
                    "{url} answered {status}; retrying in {} s",
                    wait.as_secs_f32()
                );
                tokio::time::sleep(wait).await;
                attempt += 1;
                continue;
            }
            break response.error_for_status().map_err(failed)?;
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(failed)? {
            if bytes.len() + chunk.len() > SIZE_LIMIT {
                return Err("build artifact exceeds size limit".into());
            }
            bytes.extend(chunk);
        }
        Ok(bytes)
    }
}

/// Write `bytes` to `path` whole, or not at all.
fn keep(directory: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Instant,
    };

    /// A loopback HTTP server that answers each request with the next of
    /// `responses`, repeating the last, and counts the requests.
    struct Server {
        url: String,
        requests: Arc<AtomicUsize>,
    }

    /// A status, headers, and body.
    type Response<'a> = (u16, &'a [(&'a str, &'a str)], &'a [u8]);

    fn serve(responses: &[Response]) -> Server {
        let responses: Vec<Vec<u8>> = responses
            .iter()
            .map(|(status, headers, body)| {
                let mut response = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (name, value) in *headers {
                    response.push_str(&format!("{name}: {value}\r\n"));
                }
                response.push_str("\r\n");
                [response.as_bytes(), body].concat()
            })
            .collect();
        serve_raw(responses)
    }

    /// Literal responses also let a fixture close before its promised body ends.
    fn serve_raw(responses: Vec<Vec<u8>>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/artifact", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).is_ok_and(|read| read > 2) {
                    line.clear();
                }
                let index = counted.fetch_add(1, Ordering::SeqCst);
                let _ = stream.write_all(&responses[index.min(responses.len() - 1)]);
            }
        });
        Server { url, requests }
    }

    fn downloads(directory: &Path) -> Downloads {
        Downloads {
            directory: directory.to_owned(),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            require_https: false,
            retry: Retry {
                attempts: 4,
                backoff: Duration::from_millis(10),
                cap: Duration::from_millis(1100),
            },
        }
    }

    fn pin(server: &Server, body: &[u8]) -> Artifact {
        Artifact {
            url: server.url.clone(),
            sha256: crate::hex(&Sha256::digest(body)),
        }
    }

    #[tokio::test]
    async fn a_throttled_or_failing_server_is_retried_until_it_serves_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let server = serve(&[
            (429, &[("Retry-After", "0")], b"slow down"),
            (503, &[], b"unavailable"),
            (200, &[], b"pinned bytes"),
        ]);
        let artifact = pin(&server, b"pinned bytes");
        let bytes = downloads(directory.path()).get(&artifact).await.unwrap();
        assert_eq!(bytes, b"pinned bytes");
        assert_eq!(server.requests.load(Ordering::SeqCst), 3);
        assert_eq!(
            fs::read(directory.path().join(&artifact.sha256)).unwrap(),
            b"pinned bytes",
            "the verified download is kept by its checksum"
        );
    }

    #[tokio::test]
    async fn a_server_that_keeps_throttling_fails_after_a_bounded_number_of_requests() {
        let directory = tempfile::tempdir().unwrap();
        let server = serve(&[(429, &[("Retry-After", "0")], b"slow down")]);
        let error = downloads(directory.path())
            .get(&pin(&server, b"pinned bytes"))
            .await
            .unwrap_err();
        assert!(error.contains("429"), "{error}");
        assert_eq!(server.requests.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn client_errors_and_checksum_failures_are_not_retried() {
        for (status, body, expected) in [
            (404, &b"missing"[..], "404"),
            (403, b"forbidden", "403"),
            (200, b"other bytes", "checksum"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let server = serve(&[(status, &[], body), (200, &[], b"pinned bytes")]);
            let error = downloads(directory.path())
                .get(&pin(&server, b"pinned bytes"))
                .await
                .unwrap_err();
            assert!(error.contains(expected), "{status}: {error}");
            assert_eq!(server.requests.load(Ordering::SeqCst), 1, "{status}");
            assert!(
                !directory
                    .path()
                    .join(crate::hex(&Sha256::digest(b"pinned bytes")))
                    .exists()
            );
        }
    }

    #[tokio::test]
    async fn a_retry_after_beyond_the_wait_budget_stops_without_retrying() {
        let directory = tempfile::tempdir().unwrap();
        let server = serve(&[
            (429, &[("Retry-After", "3600")], b"slow down"),
            (200, &[], b"pinned bytes"),
        ]);
        let error = downloads(directory.path())
            .get(&pin(&server, b"pinned bytes"))
            .await
            .unwrap_err();
        assert!(error.contains("Retry-After"), "{error}");
        assert_eq!(server.requests.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn an_interrupted_transfer_is_not_retried_or_cached() {
        let directory = tempfile::tempdir().unwrap();
        let server = serve_raw(vec![
            b"HTTP/1.1 200 Fixture\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial"
                .to_vec(),
            b"HTTP/1.1 200 Fixture\r\nContent-Length: 12\r\nConnection: close\r\n\r\npinned bytes"
                .to_vec(),
        ]);
        let error = downloads(directory.path())
            .get(&pin(&server, b"pinned bytes"))
            .await
            .unwrap_err();
        assert!(error.contains("cannot download"), "{error}");
        assert_eq!(server.requests.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn retry_after_may_name_a_number_of_seconds_or_an_http_date() {
        assert_eq!(requested_wait("7"), Some(Duration::from_secs(7)));
        assert_eq!(
            requested_wait("Wed, 21 Oct 2015 07:28:00 GMT"),
            Some(Duration::ZERO),
            "a date in the past asks for no wait"
        );
        assert_eq!(requested_wait("soon"), None);
    }

    #[tokio::test]
    async fn retry_after_sets_the_wait() {
        let directory = tempfile::tempdir().unwrap();
        let server = serve(&[
            (503, &[("Retry-After", "1")], b"unavailable"),
            (200, &[], b"pinned bytes"),
        ]);
        let start = Instant::now();
        downloads(directory.path())
            .get(&pin(&server, b"pinned bytes"))
            .await
            .unwrap();
        assert!(
            start.elapsed() >= Duration::from_secs(1),
            "waited {:?}",
            start.elapsed()
        );
    }
}
