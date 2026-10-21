// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A metadata bundle read from a registry instead of a local archive.

use nemoclaw_build::images::registry_metadata;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", nemoclaw_build::hex(&Sha256::digest(bytes)))
}

/// A registry for `agent` that challenges anonymous requests for a bearer token,
/// serving `blobs` by digest. Returns its address and the requests it saw.
fn registry(blobs: BTreeMap<String, String>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let realm = format!("http://{address}/token");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let path = line
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_owned();
            let mut authorized = false;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header.trim().is_empty() {
                    break;
                }
                authorized |= header
                    .to_ascii_lowercase()
                    .starts_with("authorization: bearer granted");
            }
            log.lock().unwrap().push(path.clone());
            let (status, extra, body) = if path.starts_with("/token?") {
                (
                    "200 OK",
                    String::new(),
                    json!({"token": "granted"}).to_string(),
                )
            } else if !authorized {
                (
                    "401 Unauthorized",
                    format!(
                        "WWW-Authenticate: Bearer realm=\"{realm}\",service=\"test\",scope=\"repository:org/agent:pull\"\r\n"
                    ),
                    String::new(),
                )
            } else {
                let digest = path.rsplit('/').next().unwrap_or_default();
                match blobs.get(digest) {
                    Some(body) => ("200 OK", String::new(), body.clone()),
                    None => ("404 Not Found", String::new(), String::new()),
                }
            };
            write!(
                stream,
                "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    (address, seen)
}

/// An index of one platform per architecture, each with its own config, plus
/// an attestation that must not be fetched.
fn image(architectures: &[&str]) -> (String, BTreeMap<String, String>) {
    let mut blobs = BTreeMap::new();
    let mut manifests = Vec::new();
    for architecture in architectures {
        let config = json!({"os": "linux", "architecture": architecture,
            "config": {"Labels": {"io.nemoclaw.fabric.catalog": "{}"}}})
        .to_string();
        let manifest = json!({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": digest(config.as_bytes()), "size": config.len()},
            "layers": []})
        .to_string();
        manifests.push(
            json!({"mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": digest(manifest.as_bytes()), "size": manifest.len(),
            "platform": {"os": "linux", "architecture": architecture}}),
        );
        blobs.insert(digest(config.as_bytes()), config);
        blobs.insert(digest(manifest.as_bytes()), manifest);
    }
    manifests.push(
        json!({"mediaType": "application/vnd.oci.image.manifest.v1+json",
        "digest": format!("sha256:{}", "a".repeat(64)), "size": 2,
        "platform": {"os": "unknown", "architecture": "unknown"}}),
    );
    let index = json!({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": manifests})
    .to_string();
    let root = digest(index.as_bytes());
    blobs.insert(root.clone(), index);
    (root, blobs)
}

#[tokio::test]
async fn a_registry_bundle_holds_every_linux_platform_as_exact_bytes() {
    let (root, blobs) = image(&["arm64", "amd64"]);
    let (address, seen) = registry(blobs.clone());
    let bundle = registry_metadata(&format!("{address}/org/agent@{root}"), None)
        .await
        .unwrap();
    let bundle: Value = serde_json::from_slice(&bundle).unwrap();
    assert_eq!(bundle["schema_version"], 2);
    let held = bundle["blobs"].as_object().unwrap();
    assert_eq!(held.len(), 5, "the index, two manifests and two configs");
    for (digest, raw) in held {
        assert_eq!(raw.as_str().unwrap(), blobs[digest], "exact bytes");
    }
    let seen = seen.lock().unwrap();
    assert!(
        seen.iter().any(|path| path.starts_with("/token?")),
        "{seen:?}"
    );
    assert!(
        !seen.iter().any(|path| path.contains(&"a".repeat(64))),
        "attestations are skipped"
    );
}

#[tokio::test]
async fn a_registry_bundle_refuses_changed_bytes_and_missing_platforms() {
    let (root, mut blobs) = image(&["arm64", "amd64"]);
    let config = blobs
        .keys()
        .find(|digest| {
            blobs[*digest].contains("amd64") && !blobs[*digest].contains("schemaVersion")
        })
        .unwrap()
        .clone();
    blobs.insert(config, "PRIVATE_SENTINEL".into());
    let (address, _) = registry(blobs);
    let error = registry_metadata(&format!("{address}/org/agent@{root}"), None)
        .await
        .unwrap_err();
    assert!(error.contains("does not match its digest"), "{error}");
    assert!(!error.contains("PRIVATE_SENTINEL"), "{error}");

    let (root, mut blobs) = image(&["arm64", "amd64"]);
    let manifest = blobs
        .keys()
        .find(|digest| {
            blobs[*digest].contains("schemaVersion")
                && blobs[*digest].contains("config")
                && !blobs[*digest].contains("manifests")
        })
        .unwrap()
        .clone();
    blobs.remove(&manifest);
    let (address, _) = registry(blobs);
    assert!(
        registry_metadata(&format!("{address}/org/agent@{root}"), None)
            .await
            .is_err()
    );
    assert!(
        registry_metadata(&format!("{address}/org/agent:latest"), None)
            .await
            .is_err()
    );
}
