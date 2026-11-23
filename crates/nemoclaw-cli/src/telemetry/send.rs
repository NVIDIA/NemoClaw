// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Sends one record: one HTTP POST with a 3-second limit. Every error is
//! ignored, so sending never changes a command's output or exit code.

use super::record::{Os, Record};
use reqwest::Url;
use serde_json::{Value, json};
use std::time::Duration;

/// The collector, the same one NemoClaw Classic uses.
pub const ENDPOINT: &str = "https://events.telemetry.data.nvidia.com/v1.1/events/json";
const TIMEOUT: Duration = Duration::from_secs(3);
const EVENT: &str = "nemoclaw_deployment_finished";
const SCHEMA_VERSION: &str = "5.0";
/// The collector's value for an identity key the record does not fill.
const PLACEHOLDER: &str = "undefined";

/// Sends `record` and returns within the time limit whatever happens.
pub async fn send(record: &Record) {
    let local = std::env::var("NEMOCLAW_TELEMETRY_ENDPOINT").ok();
    let Some(endpoint) = endpoint(local.as_deref()) else {
        return;
    };
    deliver(endpoint, envelope(record, &timestamp())).await;
}

async fn deliver(endpoint: Url, body: Value) {
    let _ = tokio::time::timeout(TIMEOUT, post(endpoint, body)).await;
}

/// The fixed collector, or a local receiver when `local` is
/// `http://127.0.0.1:<port>` or `http://[::1]:<port>`. Any other `local` is
/// ignored. A unit-test build posts only to a local receiver.
fn endpoint(local: Option<&str>) -> Option<Url> {
    let local = local
        .and_then(|value| Url::parse(value).ok())
        .filter(|url| {
            url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
                && url.port().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        });
    match local {
        Some(url) => Some(url),
        None if cfg!(test) => None,
        None => Url::parse(ENDPOINT).ok(),
    }
}

async fn post(endpoint: Url, body: Value) -> Result<(), reqwest::Error> {
    let mut client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT);
    // A proxy would take loopback traffic off the machine. The real collector
    // must stay behind the standard proxy settings: the exit-guard tests rely on it.
    if endpoint.scheme() == "http" {
        client = client.no_proxy();
    }
    client
        .build()?
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("X-Event-Protocol", "1.6")
        .body(body.to_string())
        .send()
        .await?;
    Ok(())
}

/// The collector's envelope around one record, with the same keys NemoClaw Classic sends.
fn envelope(record: &Record, now: &str) -> Value {
    json!({
        "browserType": PLACEHOLDER,
        "clientId": "2247027956751513",
        "clientType": "Native",
        "clientVariant": "Release",
        "clientVer": record.version,
        "cpuArchitecture": word(record.arch),
        "deviceGdprBehOptIn": "None",
        "deviceGdprFuncOptIn": "Temp",
        "deviceGdprTechOptIn": "None",
        // Anonymous schema: the collector refuses a device ID; `installId` carries it.
        "deviceId": PLACEHOLDER,
        "deviceMake": PLACEHOLDER,
        "deviceModel": PLACEHOLDER,
        "deviceOS": device_os(record.os),
        "deviceOSVersion": PLACEHOLDER,
        "deviceType": PLACEHOLDER,
        "eventProtocol": "1.6",
        "eventSchemaVer": SCHEMA_VERSION,
        "eventSysVer": format!("nemoclaw-telemetry/{SCHEMA_VERSION}"),
        "externalUserId": PLACEHOLDER,
        "gdprBehOptIn": "None",
        "gdprFuncOptIn": "None",
        "gdprTechOptIn": "None",
        "idpId": PLACEHOLDER,
        "integrationId": PLACEHOLDER,
        "productName": PLACEHOLDER,
        "productVersion": PLACEHOLDER,
        "sentTs": now,
        "sessionId": PLACEHOLDER,
        "userId": PLACEHOLDER,
        "events": [{ "ts": now, "name": EVENT, "parameters": record }],
    })
}

/// The collector's own case-sensitive list; it refuses any other word.
fn device_os(os: Os) -> &'static str {
    match os {
        Os::Linux => "Linux",
        Os::Macos => "MacOS",
        Os::Windows => "Windows",
        Os::Other => PLACEHOLDER,
    }
}

fn word(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(json!(PLACEHOLDER))
}

/// The current UTC time to the millisecond, for example `2026-11-20T09:30:00.123Z`.
fn timestamp() -> String {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    time::OffsetDateTime::now_utc()
        .format(format)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::record::tests::sample;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn only_a_loopback_receiver_replaces_the_collector() {
        for good in [
            "http://127.0.0.1:9000",
            "http://[::1]:9000/v1.1/events/json",
        ] {
            assert!(endpoint(Some(good)).is_some(), "{good}");
        }
        for bad in [
            "https://127.0.0.1:9000",
            "http://localhost:9000",
            "http://10.0.0.1:9000",
            "http://127.0.0.1",
            "http://user@127.0.0.1:9000",
            "http://127.0.0.1:9000/?q=1",
            "http://127.0.0.1.example.com:9000",
            "not a url",
        ] {
            // A unit-test build falls back to nothing, not to the collector.
            assert_eq!(endpoint(Some(bad)), None, "{bad}");
        }
        assert_eq!(endpoint(None), None);
        assert_eq!(Url::parse(ENDPOINT).unwrap().as_str(), ENDPOINT);
    }

    #[test]
    fn envelope_carries_the_record_and_its_constants() {
        let record = sample();
        let envelope = envelope(&record, "2026-11-20T09:30:00.123Z");
        assert_eq!(envelope["clientId"], "2247027956751513");
        assert_eq!(envelope["eventSchemaVer"], "5.0");
        assert_eq!(envelope["eventSysVer"], "nemoclaw-telemetry/5.0");
        assert_eq!(envelope["clientVer"], "1.0.0-412");
        assert_eq!(envelope["deviceOS"], "Linux");
        assert_eq!(envelope["clientVariant"], "Release");
        assert_eq!(envelope["cpuArchitecture"], "arm64");
        assert_eq!(envelope["deviceId"], PLACEHOLDER);
        let event = &envelope["events"][0];
        assert_eq!(event["name"], EVENT);
        assert_eq!(event["parameters"], serde_json::to_value(&record).unwrap());
    }

    #[test]
    fn device_os_uses_the_collector_words() {
        assert_eq!(device_os(Os::Macos), "MacOS");
        assert_eq!(device_os(Os::Windows), "Windows");
        assert_eq!(device_os(Os::Other), PLACEHOLDER);
    }

    #[test]
    fn timestamps_are_utc_milliseconds() {
        let now = timestamp();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.ends_with('Z'));
    }

    async fn receiver() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1.1/events/json", listener.local_addr().unwrap());
        (listener, url)
    }

    #[tokio::test]
    async fn posts_one_record_to_a_local_receiver() {
        let (listener, url) = receiver().await;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 8192];
            while !String::from_utf8_lossy(&request).contains("\"events\"") {
                let read = stream.read(&mut buffer).await.unwrap();
                request.extend_from_slice(&buffer[..read]);
            }
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")
                .await;
            String::from_utf8_lossy(&request).into_owned()
        });
        let posted = post(endpoint(Some(&url)).unwrap(), envelope(&sample(), "now")).await;
        let request = server.await.unwrap();
        assert!(posted.is_ok());
        assert!(request.starts_with("POST /v1.1/events/json"), "{request}");
        assert!(
            request
                .to_ascii_lowercase()
                .contains("x-event-protocol: 1.6")
        );
        assert!(request.contains(r#""installId":"0f8fad5b-d9cb-469f-a165-70867728950e""#));
    }

    #[tokio::test]
    async fn a_silent_receiver_is_given_up_on_after_three_seconds() {
        let (listener, url) = receiver().await;
        let _held = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(stream);
        });
        let started = std::time::Instant::now();
        deliver(endpoint(Some(&url)).unwrap(), envelope(&sample(), "now")).await;
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_millis(2900), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(4), "{elapsed:?}");
    }

    #[tokio::test]
    async fn send_without_a_receiver_returns_quietly() {
        // A unit-test build with no local receiver posts nowhere.
        send(&sample()).await;
    }
}
