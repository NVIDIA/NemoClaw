// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::time::Duration;

pub(super) fn client() -> Result<reqwest::Client, crate::Error> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| crate::Error::State("cannot initialize llama.cpp readiness transport"))
}
pub(super) async fn matches(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
    key: Option<&str>,
) -> bool {
    async fn get(
        client: &reqwest::Client,
        url: String,
        key: Option<&str>,
    ) -> Option<reqwest::Response> {
        let mut request = client.get(url);
        if let Some(key) = key {
            request = request.bearer_auth(key);
        }
        request
            .send()
            .await
            .ok()
            .filter(|r| r.status() == reqwest::StatusCode::OK)
    }
    if get(client, format!("{endpoint}/health"), key)
        .await
        .is_none()
    {
        return false;
    }
    let Some(mut response) = get(client, format!("{endpoint}/v1/models"), key).await else {
        return false;
    };
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 65536 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return false,
        }
    }
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| {
            v.get("data").and_then(|d| d.as_array()).map(|models| {
                models
                    .iter()
                    .any(|entry| entry["id"].as_str() == Some(model))
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn readiness_uses_health_and_inventory_without_inference_requests() {
        let posts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = posts.clone();
        let server = crate::http_fixture::Fixture::start_tcp(move |r| {
            Some(match r.path.as_str() {
                "/health" => (200, b"{}".to_vec()),
                "/v1/models" => (200, br#"{"data":[{"id":"muse-glimmer"}]}"#.to_vec()),
                _ => {
                    observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    (401, Vec::new())
                }
            })
        })
        .await;
        assert!(
            matches(
                &client().unwrap(),
                &server.endpoint,
                "muse-glimmer",
                Some("test-credential")
            )
            .await
        );
        assert_eq!(
            posts.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "startup readiness must not make inference requests"
        );
    }
    #[tokio::test]
    async fn readiness_requires_health_and_the_expected_model() {
        let server = crate::http_fixture::Fixture::start_tcp(|r| {
            let authorized = r.header("authorization") == Some("Bearer test-credential");
            Some(if !authorized {
                (401, Vec::new())
            } else if r.path == "/health" {
                (200, b"{}".to_vec())
            } else {
                (200, br#"{"data":[{"id":"muse-glimmer"}]}"#.to_vec())
            })
        })
        .await;
        let client = client().unwrap();
        assert!(!matches(&client, &server.endpoint, "muse-glimmer", None).await);
        assert!(
            !matches(
                &client,
                &server.endpoint,
                "wrong-model",
                Some("test-credential")
            )
            .await
        );
        assert!(
            matches(
                &client,
                &server.endpoint,
                "muse-glimmer",
                Some("test-credential")
            )
            .await
        );
    }
}
