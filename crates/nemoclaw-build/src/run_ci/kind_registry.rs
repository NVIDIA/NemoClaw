// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A run-owned registry that requires a login, on the kind network, holding
//! the kind case's agent image. Its credentials are public fixture values,
//! valid only for the registry each run creates. The node may pull from it
//! over HTTP, through a CRI host configuration for this registry alone that
//! holds no credentials, so a pod pulls only with the case's pull Secret.

use super::*;
use serde_json::{Value, json};

// Docker Official Image registry:3, resolved 2026-10-17. Test dependency only.
const IMAGE: &str = "docker.io/library/registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8";
// Public fixture credentials, valid only in a run's own registry.
pub(super) const USER: &str = "nemoclaw-registry-fixture";
pub(super) const PASSWORD: &str = "fixture-password-for-nemoclaw-tests-only";
const HTPASSWD: &str =
    "nemoclaw-registry-fixture:$2y$05$DSYXtCwu5fi5A0HdC3HLje4ACbf.67QujUPxS10rCH.fHgk5Byc.O\n";
const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";

/// A started registry container, removed with the volume its image declares
/// when dropped, unless the run keeps its kind cluster.
pub(super) struct Registry {
    id: String,
    authority: String,
    url: String,
    client: reqwest::Client,
}

impl Drop for Registry {
    fn drop(&mut self) {
        if std::env::var_os("NEMOCLAW_KEEP_KIND_CLUSTER").is_some() {
            eprintln!("Kept registry container {}", self.id);
            return;
        }
        let _ = Command::new("docker")
            .args(["rm", "--force", "--volumes", &self.id])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Run a Docker command and return its trimmed standard output.
fn docker(args: &[&str]) -> Result<String> {
    let output = Command::new("docker")
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output()?;
    if !output.status.success() {
        return Err(format!("the registry fixture's docker {} failed", args[0]).into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

impl Registry {
    /// Start a registry on the kind network, with its port published on
    /// loopback for this runner, and wait until it requires a login.
    pub(super) async fn start(directory: &Path) -> Result<Self> {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).map_err(|_| "cannot name the registry")?;
        let name = format!("nc-registry-{}", nemoclaw_build::hex(&nonce));
        fs::create_dir_all(directory)?;
        let htpasswd = std::path::absolute(directory.join("htpasswd"))?;
        fs::write(&htpasswd, HTPASSWD)?;
        let mount = format!(
            "type=bind,source={},target=/auth/htpasswd,readonly",
            htpasswd.display()
        );
        let id = docker(&[
            "create",
            "--name",
            &name,
            "--network",
            "kind",
            "--publish",
            "127.0.0.1::5000",
            "--mount",
            &mount,
            "--env",
            "REGISTRY_AUTH=htpasswd",
            "--env",
            "REGISTRY_AUTH_HTPASSWD_REALM=fixture",
            "--env",
            "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
            IMAGE,
        ])?;
        let mut registry = Self {
            id,
            authority: format!("{name}:5000"),
            url: String::new(),
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(30))
                .build()?,
        };
        docker(&["start", &registry.id])?;
        let address = docker(&["port", &registry.id, "5000/tcp"])?;
        let address: std::net::SocketAddr = address
            .lines()
            .next()
            .ok_or("the registry publishes no port")?
            .parse()?;
        registry.url = format!("http://{address}");
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(response) = registry
                .client
                .get(format!("{}/v2/", registry.url))
                .send()
                .await
                && response.status() == reqwest::StatusCode::UNAUTHORIZED
            {
                return Ok(registry);
            }
            if Instant::now() >= deadline {
                return Err("the run's registry did not start requiring a login".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Push the node's agent `image`, by digest and described by the metadata
    /// bundle `metadata`, under a new index digest, so that a pod must fetch
    /// the index from this registry although the node has the image's layers.
    /// Writes the new reference's metadata bundle to `written` and returns the
    /// reference.
    pub(super) async fn push(
        &self,
        node: &str,
        image: &str,
        metadata: &Path,
        written: &Path,
    ) -> Result<String> {
        let hosts = written.with_file_name("hosts.toml");
        fs::write(
            &hosts,
            format!(
                "server = \"http://{0}\"\n[host.\"http://{0}\"]\ncapabilities = [\"pull\", \"resolve\"]\n",
                self.authority
            ),
        )?;
        let directory = format!("/etc/containerd/certs.d/{}", self.authority);
        docker(&["exec", node, "mkdir", "-p", &directory])?;
        docker(&[
            "cp",
            &hosts.to_string_lossy(),
            &format!("{node}:{directory}/hosts.toml"),
        ])?;
        let tagged = format!("{}/agent:fixture", self.authority);
        let ctr = |args: &[&str]| {
            docker(&[&["exec", node, "ctr", "-n", "k8s.io", "images"][..], args].concat())
        };
        ctr(&["tag", image, &tagged])?;
        ctr(&[
            "push",
            "--plain-http",
            "--user",
            &format!("{USER}:{PASSWORD}"),
            &tagged,
        ])?;
        ctr(&["rm", &tagged])?;
        let (digest, bundle, index) = unique_index(&fs::read(metadata)?, image, &self.authority)?;
        let response = self
            .client
            .put(format!("{}/v2/agent/manifests/{digest}", self.url))
            .basic_auth(USER, Some(PASSWORD))
            .header(reqwest::header::CONTENT_TYPE, OCI_INDEX)
            .body(index)
            .send()
            .await?;
        if response.status() != reqwest::StatusCode::CREATED {
            return Err(format!("the registry refused the index: {}", response.status()).into());
        }
        fs::write(written, bundle)?;
        Ok(format!("{}/agent@{digest}", self.authority))
    }
}

/// A new index for `image`, annotated with `nonce`, and the metadata bundle
/// `source` rewritten for it: a manifest becomes the only platform of a new
/// index, and an index is replaced. Each platform's manifest and
/// configuration keep their exact bytes. Returns the index's digest, the new
/// bundle, and the index.
fn unique_index(source: &[u8], image: &str, nonce: &str) -> Result<(String, Vec<u8>, String)> {
    let mut metadata: Value = serde_json::from_slice(source)?;
    let old = image.rsplit_once('@').ok_or("the image has no digest")?.1;
    let blob = |metadata: &Value, digest: &str| -> Result<Value> {
        let text = metadata["blobs"][digest]
            .as_str()
            .ok_or("the metadata bundle lacks a blob")?;
        Ok(serde_json::from_str(text)?)
    };
    let mut index = blob(&metadata, old)?;
    if index.get("manifests").is_none() {
        let config = blob(
            &metadata,
            index["config"]["digest"]
                .as_str()
                .ok_or("the manifest names no config")?,
        )?;
        index = json!({"schemaVersion": 2, "mediaType": OCI_INDEX, "manifests": [{
            "mediaType": index["mediaType"], "digest": old,
            "size": metadata["blobs"][old].as_str().map_or(0, str::len),
            "platform": {"os": config["os"], "architecture": config["architecture"]},
        }]});
    } else if let Some(blobs) = metadata["blobs"].as_object_mut() {
        blobs.remove(old);
    }
    index["mediaType"] = json!(OCI_INDEX);
    index["annotations"]["org.nvidia.nemoclaw.test.registry"] = json!(nonce);
    let raw = index.to_string();
    let digest = format!(
        "sha256:{}",
        nemoclaw_build::hex(&Sha256::digest(raw.as_bytes()))
    );
    metadata["blobs"][&digest] = json!(raw);
    Ok((digest, serde_json::to_vec(&metadata)?, raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(bytes: &[u8]) -> String {
        format!("sha256:{}", nemoclaw_build::hex(&Sha256::digest(bytes)))
    }

    #[test]
    fn each_run_pushes_a_new_index_without_changing_image_contents() {
        let config = json!({"os": "linux", "architecture": "arm64"}).to_string();
        let config_digest = digest(config.as_bytes());
        let manifest =
            json!({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"digest": config_digest}, "layers": []})
            .to_string();
        let manifest_digest = digest(manifest.as_bytes());
        for indexed in [false, true] {
            let mut metadata = json!({"schema_version": 2,
                "blobs": {&manifest_digest: manifest, &config_digest: config}});
            let root = if indexed {
                let index = json!({"schemaVersion": 2, "mediaType": OCI_INDEX, "manifests": [{
                    "mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": manifest_digest,
                    "size": manifest.len(), "platform": {"os": "linux", "architecture": "arm64"}}]})
                .to_string();
                let digest = digest(index.as_bytes());
                metadata["blobs"][&digest] = json!(index);
                digest
            } else {
                manifest_digest.clone()
            };
            let source = serde_json::to_vec(&metadata).unwrap();
            let reference = format!("fixture/agent@{root}");
            let (one, changed, index) = unique_index(&source, &reference, "one").unwrap();
            let (two, _, _) = unique_index(&source, &reference, "two").unwrap();
            assert_ne!(one, root);
            assert_ne!(one, two, "each run's registry needs an uncached digest");
            assert_eq!(one, digest(index.as_bytes()));
            let changed: Value = serde_json::from_slice(&changed).unwrap();
            assert_eq!(changed["blobs"][&one], index);
            assert_eq!(changed["schema_version"], 2);
            assert_eq!(changed["blobs"][&manifest_digest], manifest);
            assert_eq!(changed["blobs"][&config_digest], config);
            assert_eq!(changed["blobs"].as_object().unwrap().len(), 3);
        }
    }
}
