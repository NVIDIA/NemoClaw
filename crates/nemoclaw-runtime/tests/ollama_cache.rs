// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Opt-in qualification of the private cache layout against the pinned Ollama image.
//! No model is downloaded or loaded, and no GPU is exposed to the container.

use nemoclaw_runtime::{
    CancellationToken,
    ollama::{Models, registry},
    snapshot,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

fn docker(arguments: &[&str]) -> String {
    let result = Command::new("docker").args(arguments).output().unwrap();
    assert!(
        result.status.success(),
        "docker {arguments:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().into()
}

struct Container(String);
impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", "--volumes", &self.0])
            .output();
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tokio::test]
#[ignore = "requires NEMOCLAW_TEST_OLLAMA_CACHE=1, local Docker, and the already pulled pinned image"]
async fn pinned_ollama_reads_verified_cache_and_matches_declared_version() {
    assert_eq!(
        std::env::var("NEMOCLAW_TEST_OLLAMA_CACHE").as_deref(),
        Ok("1")
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dockerfile = fs::read_to_string(root.join("runtimes/ollama/Dockerfile")).unwrap();
    let image = dockerfile
        .lines()
        .find_map(|line| line.strip_prefix("FROM "))
        .unwrap();
    assert!(image.starts_with("ollama/ollama@sha256:"));
    // Never pull implicitly or operate on an existing container/cache.
    docker(&["image", "inspect", image]);
    let cache = tempfile::tempdir().unwrap();
    let name = "nemoclaw-cache-fixture:qualification";
    let config = br#"{"model_format":"gguf","model_family":"llama","model_families":["llama"],"model_type":"fixture","file_type":"F32"}"#;
    let model = b"GGUF";
    let native = serde_json::to_vec(&json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
        "config": {
            "mediaType": "application/vnd.docker.container.image.v1+json",
            "digest": format!("sha256:{}", sha256(config)), "size": config.len()
        },
        "layers": [{
            "mediaType": "application/vnd.ollama.image.model",
            "digest": format!("sha256:{}", sha256(model)), "size": model.len()
        }]
    }))
    .unwrap();
    let digest = sha256(&native);
    let manifest = registry::decode(name, &digest, &native).unwrap();
    for file in &manifest.files {
        let bytes = [&native[..], &config[..], &model[..]]
            .into_iter()
            .find(|bytes| sha256(bytes) == file.sha256)
            .unwrap();
        let path = cache.path().join(&file.name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Resume complete synthetic transfers through the real verifier and commit path.
        fs::write(
            path.with_file_name(format!(
                "{}.nemoclaw-partial",
                path.file_name().unwrap().to_str().unwrap()
            )),
            bytes,
        )
        .unwrap();
    }
    // A nonresolving origin ensures a missing fixture cannot download real data.
    let downloader = snapshot::Client::registry("https://registry.invalid").unwrap();
    let cancel = CancellationToken::new();
    let installed = downloader
        .ensure(cache.path(), &manifest, &cancel, &|_| {})
        .await
        .unwrap();
    let unchanged = downloader
        .ensure(cache.path(), &manifest, &cancel, &|_| {})
        .await
        .unwrap();
    assert_eq!(installed, unchanged);

    let mount = format!(
        "type=bind,src={},dst=/cache,readonly",
        cache.path().display()
    );
    let container = Container(docker(&[
        "create",
        "--pull=never",
        "--runtime=runc",
        "--label=org.nemoclaw.test=ollama-cache",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--env=NVIDIA_VISIBLE_DEVICES=void",
        "--env=OLLAMA_NO_CLOUD=1",
        "--env=OLLAMA_MODELS=/cache",
        "--publish=127.0.0.1::11434",
        "--mount",
        &mount,
        image,
        "serve",
    ]));
    docker(&["start", &container.0]);
    let port = docker(&["port", &container.0, "11434/tcp"]);
    let endpoint = format!("http://{port}");
    let models = Models::new(&format!("{endpoint}/v1")).unwrap();
    // Docker's loopback proxy resets connections until Ollama listens.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match models.ready(name).await {
            Err(nemoclaw_runtime::Error::Observation(
                nemoclaw_runtime::ObservationError::Transport,
            )) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            result => break result.unwrap(),
        }
    }
    let observed = models.read(name).await.unwrap().expect("installed model");
    assert_eq!(observed.digest, digest);
    assert_eq!(observed.size, (config.len() + model.len()) as u64);
    assert!(models.read("missing:fixture").await.unwrap().is_none());
    assert_eq!(
        snapshot::observe(cache.path(), &manifest).unwrap(),
        installed
    );

    let version = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
        .get(format!("{endpoint}/api/version"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let version: serde_json::Value = serde_json::from_slice(&version).unwrap();
    let versions: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("versions.json")).unwrap()).unwrap();
    assert_eq!(
        version["version"], versions["ollama"],
        "the runtime image must match the declared Ollama version"
    );
    println!(
        "Ollama {} reads the verified synthetic cache from {image}",
        version["version"]
    );
}
