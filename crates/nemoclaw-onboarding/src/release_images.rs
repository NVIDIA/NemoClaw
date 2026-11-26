// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Release suggestions are read-only hints. Runtime metadata and image pulls
//! remain the deployment provider's responsibility, including registry auth.
use nemoclaw_authoring::Capabilities;
use nemoclaw_sdk::{CancellationToken, Error};
use std::time::Duration;

const MAX_PINS_BYTES: usize = 1024 * 1024;

/// Where each release's assets are downloaded from.
pub(super) const RELEASES: &str = "https://github.com/NVIDIA/NemoClaw/releases/download";

/// The tag of a release build, `X.Y.Z` or `X.Y.Z-rc.N`. Other builds, such as
/// CI's numbered `X.Y.Z-RUN` and development `X.Y.Z-dev.SOURCE`, have no
/// release whose images to suggest.
fn release_tag(version: Option<&str>) -> Option<String> {
    let version = version?;
    let (core, candidate) = version
        .split_once("-rc.")
        .map_or((version, None), |(core, candidate)| (core, Some(candidate)));
    let number = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    let release = core.split('.').count() == 3 && core.split('.').all(number);
    (release && candidate.is_none_or(number)).then(|| format!("v{version}"))
}

/// `capabilities` with the image suggestions of this build's release from
/// `releases`, and what to tell the user when a release build can't read them.
pub(super) async fn load(
    capabilities: Capabilities,
    version: Option<&str>,
    releases: &str,
    cancel: &CancellationToken,
) -> Result<(Capabilities, Option<String>), Box<dyn std::error::Error>> {
    let Some(tag) = release_tag(version) else {
        return Ok((capabilities, None));
    };
    let url = format!("{releases}/{tag}/version-pins.json");
    let fetched = tokio::select! {
        _ = cancel.cancelled() => return Err(Error::Cancelled.into()),
        result = fetch(&url) => result,
    };
    match fetched.and_then(|bytes| capabilities.clone().with_release_pins(&bytes, &tag)) {
        Ok(enriched) => Ok((enriched, None)),
        Err(_) => {
            let build_guide =
                nemoclaw_sdk::documentation_url(nemoclaw_authoring::BUILD_AGENT_IMAGES);
            let warning = format!(
                "Release image suggestions are unavailable for {tag}. Choose a local image or enter a digest. Build guide: {build_guide}"
            );
            Ok((capabilities, Some(warning)))
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
    use crate::http::Fixture;

    #[test]
    fn only_a_release_build_looks_up_its_exact_tag() {
        for version in [
            None,
            Some("0.1.0-dev.abc"),
            Some("0.1.0-412"),
            Some("0.1.0-rc.5.412"),
            Some("0.1.0/../../latest"),
            Some("v0.1.0"),
        ] {
            assert_eq!(release_tag(version), None, "{version:?}");
        }
        assert_eq!(release_tag(Some("0.1.0-rc.5")), Some("v0.1.0-rc.5".into()));
        assert_eq!(release_tag(Some("0.1.0")), Some("v0.1.0".into()));
        assert_eq!(release_tag(Some("1.2.3")), Some("v1.2.3".into()));
    }

    #[tokio::test]
    async fn a_numbered_ci_build_looks_nothing_up_and_warns_about_nothing() {
        let (requests, received) = std::sync::mpsc::channel();
        let server = Fixture::start_tcp(move |request| {
            requests.send(request).unwrap();
            Some((404, Vec::new()))
        })
        .await;
        for version in ["0.1.0-412", "0.1.0-rc.5.412"] {
            let (_, warning) = load(
                Capabilities::available(),
                Some(version),
                &server.endpoint,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(warning, None, "{version}");
            assert!(
                received.try_recv().is_err(),
                "{version} looked up release pins"
            );
        }
    }

    #[tokio::test]
    async fn the_release_download_handles_success_missing_assets_and_oversized_responses() {
        for (status, body, valid) in [
            (200, "{}".to_owned(), true),
            (404, "missing".to_owned(), false),
            (200, " ".repeat(MAX_PINS_BYTES + 1), false),
        ] {
            let (requests, received) = std::sync::mpsc::channel();
            let server = Fixture::start_tcp(move |request| {
                requests.send(request).unwrap();
                Some((status, body.as_bytes().to_vec()))
            })
            .await;
            assert_eq!(
                fetch(&format!("{}/version-pins.json", server.endpoint))
                    .await
                    .is_ok(),
                valid
            );
            let request = received.try_recv().unwrap();
            assert!(request.header("authorization").is_none());
        }
    }
}
