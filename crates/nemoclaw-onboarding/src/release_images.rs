// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Release suggestions are read-only hints. Runtime metadata and image pulls
//! remain the deployment provider's responsibility, including registry auth.
use nemoclaw_authoring::Capabilities;
use nemoclaw_sdk::{CancellationToken, Error};
use std::time::Duration;

const MAX_PINS_BYTES: usize = 1024 * 1024;

fn release_tag(version: Option<&str>) -> Option<String> {
    let version = version?;
    let version = version.strip_prefix('v').unwrap_or(version);
    // A development bundle has no release image set. Never read a moving
    // latest release or guess that another version's images are compatible.
    if version.contains("dev")
        || !version.starts_with("0.1.")
        || !version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
    {
        return None;
    }
    Some(format!("v{version}"))
}

pub(super) async fn load(
    capabilities: Capabilities,
    version: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Capabilities, Box<dyn std::error::Error>> {
    let Some(tag) = release_tag(version) else {
        return Ok(capabilities);
    };
    let url =
        format!("https://github.com/NVIDIA/NemoClaw/releases/download/{tag}/version-pins.json");
    let fetched = tokio::select! {
        _ = cancel.cancelled() => return Err(Error::Cancelled.into()),
        result = fetch(&url) => result,
    };
    match fetched.and_then(|bytes| capabilities.clone().with_release_pins(&bytes, &tag)) {
        Ok(enriched) => Ok(enriched),
        Err(_) => {
            let build_guide =
                nemoclaw_sdk::documentation_url(nemoclaw_authoring::BUILD_AGENT_IMAGES);
            eprintln!(
                "Release image suggestions are unavailable for {tag}. Choose a local image or enter a digest. Build guide: {build_guide}"
            );
            Ok(capabilities)
        }
    }
}

async fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len().saturating_add(chunk.len()) > MAX_PINS_BYTES {
            return Err("Release pins exceed 1 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_release_build_looks_up_its_exact_tag() {
        for version in [
            None,
            Some("0.1.0-dev.abc"),
            Some("0.1.0/../../latest"),
            Some("1.0.0"),
        ] {
            assert_eq!(release_tag(version), None);
        }
        assert_eq!(release_tag(Some("0.1.0-rc.5")), Some("v0.1.0-rc.5".into()));
        assert_eq!(release_tag(Some("0.1.0")), Some("v0.1.0".into()));
    }

    #[tokio::test]
    async fn the_release_download_handles_success_missing_assets_and_oversized_responses() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, body, valid) in [
            ("200 OK", "{}".to_owned(), true),
            ("404 Not Found", "missing".to_owned(), false),
            ("200 OK", " ".repeat(MAX_PINS_BYTES + 1), false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                assert!(!request.to_ascii_lowercase().contains("authorization:"));
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
            assert_eq!(
                fetch(&format!("http://{address}/version-pins.json"))
                    .await
                    .is_ok(),
                valid
            );
            server.await.unwrap();
        }
    }
}
