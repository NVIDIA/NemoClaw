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
        .map_err(|_| crate::Error::State("cannot initialize NIM readiness transport"))
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
    if get(client, format!("{endpoint}/v1/health/ready"), key)
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
    async fn native_ready_and_authenticated_exact_inventory_are_both_required() {
        let ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let state = ready.clone();
        let server = crate::http_fixture::Fixture::start_tcp(move |r| {
            Some(if r.path == "/v1/health/ready" {
                (
                    if state.load(std::sync::atomic::Ordering::SeqCst) {
                        200
                    } else {
                        503
                    },
                    b"{}".to_vec(),
                )
            } else if r.path == "/v1/models" {
                if r.header("authorization") == Some("Bearer test-credential") {
                    (
                        200,
                        br#"{"data":[{"id":"meta/llama-3.1-8b-instruct"}]}"#.to_vec(),
                    )
                } else {
                    (401, Vec::new())
                }
            } else {
                (404, Vec::new())
            })
        })
        .await;
        let client = client().unwrap();
        assert!(
            !matches(
                &client,
                &server.endpoint,
                "meta/llama-3.1-8b-instruct",
                Some("test-credential")
            )
            .await
        );
        ready.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(
            !matches(
                &client,
                &server.endpoint,
                "meta/llama-3.1-8b-instruct",
                None
            )
            .await
        );
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
                "meta/llama-3.1-8b-instruct",
                Some("test-credential")
            )
            .await
        );
    }
}
