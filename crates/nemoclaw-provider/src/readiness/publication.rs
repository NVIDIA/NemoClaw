// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Verify the published NIM path after the private native runtime is ready.
use super::*;
use bollard::models::ContainerInspectResponse;

pub(super) fn validate(config: &ReadinessState) -> Result<(), Error> {
    let Value::Value(contract) = &config.contract else {
        return Ok(());
    };
    let nim = matches!(
        nemoclaw_runtime::RuntimeSpec::decode(contract),
        Ok(nemoclaw_runtime::RuntimeSpec::Nim(_))
    );
    let fields = [
        &config.publication_container_id,
        &config.publication_endpoint,
    ];
    if !nim {
        return if fields.iter().all(|v| matches!(v, Value::Null)) {
            Ok(())
        } else {
            Err(Error::State(
                "publication inputs are for native NIM readiness only",
            ))
        };
    }
    if fields
        .iter()
        .any(|v| matches!(v, Value::Null) || matches!(v, Value::Value(s) if s.is_empty()))
    {
        return Err(Error::State(
            "NIM readiness requires the publication container identity and endpoint",
        ));
    }
    if let Value::Value(endpoint) = &config.publication_endpoint {
        base_url(endpoint, "publication_endpoint")?;
    }
    Ok(())
}

fn binding(
    native: &ContainerInspectResponse,
    proxy: &ContainerInspectResponse,
    name: &str,
    native_id: &str,
    proxy_id: &str,
    endpoint: &str,
    port: u16,
) -> Result<(), Error> {
    let url =
        url::Url::parse(endpoint).map_err(|_| Error::State("invalid NIM publication endpoint"))?;
    let owner = |container: &ContainerInspectResponse| {
        container
            .config
            .as_ref()?
            .labels
            .as_ref()?
            .get(crate::managed::OWNER_LABEL)
            .filter(|v| !v.is_empty())
            .cloned()
    };
    let expected_proxy_name = format!("{name}-proxy");
    let published = proxy
        .host_config
        .as_ref()
        .and_then(|h| h.port_bindings.as_ref())
        .and_then(|ports| ports.get(&format!("{port}/tcp")))
        .and_then(|v| v.as_ref());
    let matches_port = published.is_some_and(|ports| {
        ports.len() == 1
            && ports[0].host_ip.as_deref() == url.host_str()
            && ports[0].host_port.as_ref().is_some_and(|p| {
                Some(p.as_str())
                    == url
                        .port_or_known_default()
                        .map(|p| p.to_string())
                        .as_deref()
            })
    });
    if native.id.as_deref() != Some(native_id)
        || proxy.id.as_deref() != Some(proxy_id)
        || native.name.as_deref().map(|v| v.trim_start_matches('/')) != Some(name)
        || proxy.name.as_deref().map(|v| v.trim_start_matches('/'))
            != Some(expected_proxy_name.as_str())
        || owner(native).is_none()
        || owner(native) != owner(proxy)
        || proxy.state.as_ref().and_then(|s| s.running) != Some(true)
        || url.scheme() != "http"
        || url.path() != "/v1"
        || !matches_port
    {
        return Err(crate::ObservationError::BindingMismatch.into());
    }
    Ok(())
}

async fn probe(client: &reqwest::Client, endpoint: &str, model: &str, key: Option<&str>) -> bool {
    let url = format!("{}/models", endpoint.trim_end_matches('/'));
    // Refuse a supposedly authenticated profile that exposes model listing without its key.
    if key.is_some()
        && !client
            .get(&url)
            .send()
            .await
            .ok()
            .is_some_and(|r| r.status() == reqwest::StatusCode::UNAUTHORIZED)
    {
        return false;
    }
    let mut request = client.get(url);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let Some(mut response) = request
        .send()
        .await
        .ok()
        .filter(|r| r.status() == reqwest::StatusCode::OK)
    else {
        return false;
    };
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 65536 => body.extend_from_slice(&chunk),
            Ok(None) => break,
            _ => return false,
        }
    }
    serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v["data"]
                .as_array()
                .map(|models| models.iter().any(|m| m["id"].as_str() == Some(model)))
        })
        .unwrap_or(false)
}

pub(super) async fn wait(
    config: &ReadinessState,
    connections: &crate::docker::Connections,
) -> Result<(), Error> {
    if matches!(config.publication_container_id, Value::Null)
        && matches!(config.publication_endpoint, Value::Null)
    {
        return Ok(());
    }
    let Value::Value(contract) = &config.contract else {
        return Err(Error::State("NIM contract is unknown"));
    };
    let nemoclaw_runtime::RuntimeSpec::Nim(service) =
        nemoclaw_runtime::RuntimeSpec::decode(contract)?
    else {
        return Ok(());
    };
    let (
        Value::Value(engine),
        Value::Value(name),
        Value::Value(id),
        Value::Value(proxy_id),
        Value::Value(endpoint),
    ) = (
        &config.engine,
        &config.name,
        &config.container_id,
        &config.publication_container_id,
        &config.publication_endpoint,
    )
    else {
        return Err(Error::State("NIM publication identity is not yet known"));
    };
    let engine = crate::managed::service_engine(connections, engine)?;
    let inspect = async {
        let native = engine
            .container(id)
            .await?
            .ok_or(crate::ObservationError::Incomplete)?;
        let proxy = engine
            .container(proxy_id)
            .await?
            .ok_or(crate::ObservationError::Incomplete)?;
        binding(
            &native,
            &proxy,
            name,
            id,
            proxy_id,
            endpoint,
            service.serving.port,
        )
    };
    tokio::time::timeout(Duration::from_secs(20), inspect)
        .await
        .map_err(|_| Error::State("NIM publication observation timed out"))??;
    let key = if service.authentication.is_some() {
        Some(services::authentication::read_service_key(&engine, id).await?)
    } else {
        None
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| Error::State("cannot build NIM publication probe"))?;
    let timeout = match config.wait_timeout_seconds {
        Value::Value(seconds) => seconds.min(30),
        _ => 30,
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    loop {
        if probe(&client, endpoint, service.served_model(), key.as_deref()).await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(Error::State(
                "NIM publication does not serve the authenticated declared model",
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::fixture as http_fixture;
    #[test]
    fn publication_binds_the_proxy_identity_owner_and_published_port() {
        let native = serde_json::from_value(serde_json::json!({"Id":"native", "Name":"/model", "Config":{"Labels":{"nemoclaw.nvidia.com/uid":"owner"}}})).unwrap();
        let proxy = serde_json::json!({"Id":"proxy", "Name":"/model-proxy", "Config":{"Labels":{"nemoclaw.nvidia.com/uid":"owner"}},
            "State":{"Running":true}, "HostConfig":{"PortBindings":{"18888/tcp":[{"HostIp":"10.0.0.8", "HostPort":"18888"}]}}});
        let check = |value| {
            binding(
                &native,
                &serde_json::from_value(value).unwrap(),
                "model",
                "native",
                "proxy",
                "http://10.0.0.8:18888/v1",
                18888,
            )
        };
        assert!(check(proxy.clone()).is_ok());
        let mut remapped = proxy.clone();
        remapped["HostConfig"]["PortBindings"]["18888/tcp"][0]["HostPort"] =
            serde_json::json!("19443");
        assert!(
            binding(
                &native,
                &serde_json::from_value(remapped).unwrap(),
                "model",
                "native",
                "proxy",
                "http://10.0.0.8:19443/v1",
                18888
            )
            .is_ok(),
            "readiness must check the proxy's published host port, independently of its native listener port"
        );
        for (path, replacement) in [
            ("/Id", serde_json::json!("another")),
            ("/Name", serde_json::json!("/another-proxy")),
            (
                "/Config/Labels/nemoclaw.nvidia.com~1uid",
                serde_json::json!("another-owner"),
            ),
            ("/State/Running", serde_json::json!(false)),
            (
                "/HostConfig/PortBindings/18888~1tcp/0/HostIp",
                serde_json::json!("0.0.0.0"),
            ),
            (
                "/HostConfig/PortBindings/18888~1tcp/0/HostPort",
                serde_json::json!("18889"),
            ),
        ] {
            let mut bad = proxy.clone();
            *bad.pointer_mut(path).unwrap() = replacement;
            assert!(
                check(bad).is_err(),
                "must refuse mismatched publication {path}"
            );
        }
    }
    #[tokio::test]
    async fn published_inventory_requires_the_key_and_the_exact_model() {
        let server = http_fixture::Fixture::start_tcp(|request| {
            Some(if request.path != "/v1/models" {
                (404, Vec::new())
            } else if request.header("authorization") != Some("Bearer fixture-key") {
                (401, Vec::new())
            } else {
                (200, br#"{"data":[{"id":"declared-model"}]}"#.to_vec())
            })
        })
        .await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let endpoint = format!("{}/v1", server.endpoint);
        assert!(!probe(&client, &endpoint, "declared-model", None).await);
        assert!(!probe(&client, &endpoint, "declared-model", Some("wrong-key")).await);
        assert!(!probe(&client, &endpoint, "another-model", Some("fixture-key")).await);
        assert!(probe(&client, &endpoint, "declared-model", Some("fixture-key")).await);
        let open = http_fixture::Fixture::start_tcp(|_| {
            Some((200, br#"{"data":[{"id":"declared-model"}]}"#.to_vec()))
        })
        .await;
        assert!(
            !probe(
                &client,
                &format!("{}/v1", open.endpoint),
                "declared-model",
                Some("fixture-key")
            )
            .await
        );
    }
}
