// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Ollama registry metadata and native cache layout. The immutable manifest and
//! every blob use the common snapshot verification and retained-progress path.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryManifest {
    schema_version: u32,
    media_type: String,
    config: Layer,
    layers: Vec<Layer>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Layer {
    media_type: String,
    digest: String,
    size: u64,
}

pub(crate) fn identity(name: &str, digest: &str) -> Result<(String, String), Error> {
    if !regex::Regex::new(crate::config::constraints::OLLAMA_MODEL)
        .unwrap()
        .is_match(name)
        || !regex::Regex::new("^[a-f0-9]{64}$")
            .unwrap()
            .is_match(digest)
    {
        return Err(failure("invalid pinned Ollama model identity"));
    }
    let (model, tag) = name
        .split_once(':')
        .ok_or(failure("Ollama model tag is required"))?;
    Ok((format!("library/{model}"), tag.into()))
}
pub(crate) fn manifest_path(name: &str, digest: &str) -> Result<String, Error> {
    let (repository, tag) = identity(name, digest)?;
    Ok(format!("manifests/registry.ollama.ai/{repository}/{tag}"))
}

impl Client {
    pub async fn resolve_ollama(&self, name: &str, digest: &str) -> Result<Manifest, Error> {
        tokio::time::timeout(
            Duration::from_secs(120),
            self.resolve_registry(name, digest),
        )
        .await
        .map_err(|_| failure("registry resolution timed out"))?
    }
    async fn resolve_registry(&self, name: &str, digest: &str) -> Result<Manifest, Error> {
        let (repository, tag) = identity(name, digest)?;
        if !self.registry {
            return Err(failure("Ollama resolution requires a registry client"));
        }
        let mut url =
            reqwest::Url::parse(&self.base_url).map_err(|_| failure("invalid registry origin"))?;
        url.path_segments_mut()
            .map_err(|_| failure("invalid registry origin"))?
            .push("v2")
            .extend(repository.split('/'))
            .extend(["manifests", &tag]);
        let bytes = tokio::time::timeout(Duration::from_secs(120), self.bounded(url, 1 << 20))
            .await
            .map_err(|_| failure("registry resolution timed out"))??;
        let manifest = decode(name, digest, &bytes)?;
        // A Modelfile's runner parameters override environment defaults on later
        // requests. Reject them before treating the shared serving limits as valid.
        for file in parameter_files(&bytes)? {
            let url = self.registry_file_url(&manifest, &file)?;
            let parameters = self.bounded(url, 1 << 20).await?;
            if parameters.len() as u64 != file.size
                || hex(Sha256::digest(&parameters)) != file.sha256
            {
                return Err(failure("Ollama parameters differ from the pinned manifest"));
            }
            validate_parameters(&parameters)?;
        }
        Ok(manifest)
    }
    pub(super) fn registry_file_url(
        &self,
        manifest: &Manifest,
        file: &File,
    ) -> Result<reqwest::Url, Error> {
        manifest.validate()?;
        let mut url =
            reqwest::Url::parse(&self.base_url).map_err(|_| failure("invalid registry origin"))?;
        let mut path = url
            .path_segments_mut()
            .map_err(|_| failure("invalid registry origin"))?;
        path.push("v2").extend(manifest.repository.split('/'));
        if file.name == format!("blobs/sha256-{}", file.sha256) {
            path.extend(["blobs", &format!("sha256:{}", file.sha256)]);
        } else if let Some(tag) = file.name.strip_prefix(&format!(
            "manifests/registry.ollama.ai/{}/",
            manifest.repository
        )) {
            if tag.is_empty() || tag.contains('/') || file.sha256 != manifest.revision {
                return Err(failure("invalid pinned registry manifest path"));
            }
            path.extend(["manifests", tag]);
        } else {
            return Err(failure("invalid registry snapshot path"));
        }
        drop(path);
        Ok(url)
    }
}

pub(crate) fn parameter_files(bytes: &[u8]) -> Result<Vec<File>, Error> {
    let native: RegistryManifest = serde_json::from_slice(bytes)
        .map_err(|_| failure("incomplete Ollama registry manifest"))?;
    native
        .layers
        .into_iter()
        .filter(|l| l.media_type == "application/vnd.ollama.image.params")
        .map(|layer| {
            let digest = layer
                .digest
                .strip_prefix("sha256:")
                .ok_or(failure("invalid parameter layer digest"))?;
            if layer.size > 1 << 20 {
                return Err(failure("Ollama parameter layer exceeds metadata limit"));
            }
            Ok(File {
                name: format!("blobs/sha256-{digest}"),
                size: layer.size,
                sha256: digest.into(),
            })
        })
        .collect()
}

pub(crate) fn validate_parameters(bytes: &[u8]) -> Result<(), Error> {
    let parameters: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(bytes).map_err(|_| failure("incomplete Ollama model parameters"))?;
    // Sampling defaults may come from the model; resource settings belong to
    // the declared service. Unknown keys require adapter support explicitly.
    if parameters.keys().any(|key| {
        ![
            "num_keep",
            "seed",
            "num_predict",
            "top_k",
            "top_p",
            "min_p",
            "typical_p",
            "temperature",
            "repeat_last_n",
            "repeat_penalty",
            "presence_penalty",
            "frequency_penalty",
            "stop",
        ]
        .contains(&key.as_str())
    }) {
        return Err(Error::Conflict(
            "Ollama model parameters contain unsupported runner or resource overrides",
        ));
    }
    Ok(())
}

pub(crate) fn decode(name: &str, digest: &str, bytes: &[u8]) -> Result<Manifest, Error> {
    let (repository, _) = identity(name, digest)?;
    if bytes.len() > 1 << 20 || hex(Sha256::digest(bytes)) != digest {
        return Err(Error::Conflict(
            "Ollama tag differs from the pinned manifest digest",
        ));
    }
    let native: RegistryManifest = serde_json::from_slice(bytes)
        .map_err(|_| failure("incomplete Ollama registry manifest"))?;
    if native.schema_version != 2
        || native.media_type != "application/vnd.docker.distribution.manifest.v2+json"
        || native.config.media_type != "application/vnd.docker.container.image.v1+json"
        || native.layers.is_empty()
        || native.layers.len() > 100
        || native
            .layers
            .iter()
            .filter(|l| l.media_type == "application/vnd.ollama.image.model")
            .count()
            != 1
        || native.layers.iter().any(|l| {
            !["model", "template", "license", "params", "system"]
                .iter()
                .any(|kind| l.media_type == format!("application/vnd.ollama.image.{kind}"))
        })
    {
        return Err(failure("unsupported Ollama registry model format"));
    }
    let mut files = vec![File {
        name: manifest_path(name, digest)?,
        size: bytes.len() as u64,
        sha256: digest.into(),
    }];
    for layer in std::iter::once(native.config).chain(native.layers) {
        let sha256 = layer
            .digest
            .strip_prefix("sha256:")
            .ok_or(failure("registry layer has no SHA-256 identity"))?;
        files.push(File {
            name: format!("blobs/sha256-{sha256}"),
            sha256: sha256.into(),
            size: layer.size,
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    let manifest = Manifest {
        repository,
        revision: digest.into(),
        files,
    };
    manifest.validate()?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn native() -> Vec<u8> {
        serde_json::to_vec(&json!({"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json",
            "config":{"mediaType":"application/vnd.docker.container.image.v1+json","digest":format!("sha256:{}",hex(Sha256::digest(b"{}"))),"size":2},
            "layers":[{"mediaType":"application/vnd.ollama.image.model","digest":format!("sha256:{}",hex(Sha256::digest(b"GGUF"))),"size":4}]})).unwrap()
    }
    #[tokio::test]
    async fn registry_plan_reads_only_metadata_and_apply_verifies_and_reuses_native_files() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let bytes = native();
        let digest = hex(Sha256::digest(&bytes));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = Client {
            base_url: format!("http://{}", listener.local_addr().unwrap()),
            registry: true,
            http: reqwest::Client::new(),
            resume_attempts: 1,
        };
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(stream.read_u8().await.unwrap());
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with("GET /v2/library/test/"));
                let body = if request.contains("/manifests/tiny ") {
                    bytes.clone()
                } else if request.contains(&hex(Sha256::digest(b"GGUF"))) {
                    b"GGUF".to_vec()
                } else {
                    assert!(request.contains(&hex(Sha256::digest(b"{}"))));
                    b"{}".to_vec()
                };
                recorded.lock().unwrap().push(request);
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                stream.write_all(&body).await.unwrap();
            }
        });
        let manifest = client.resolve_ollama("test:tiny", &digest).await.unwrap();
        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "plan must not download blobs"
        );
        let root = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let first = client
            .ensure(root.path(), &manifest, &cancel, &|_| {})
            .await
            .unwrap();
        assert_eq!(
            client
                .ensure(root.path(), &manifest, &cancel, &|_| {})
                .await
                .unwrap(),
            first
        );
        assert!(
            root.path()
                .join("manifests/registry.ollama.ai/library/test/tiny")
                .is_file()
        );
        server.await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 4);
    }
    #[test]
    fn changed_digest_and_unsupported_layers_fail_before_download() {
        let bytes = native();
        assert!(decode("test:tiny", &"a".repeat(64), &bytes).is_err());
        let mut native: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        native["layers"][0]["mediaType"] = json!("application/vnd.ollama.image.adapter");
        let bytes = serde_json::to_vec(&native).unwrap();
        assert!(decode("test:tiny", &hex(Sha256::digest(&bytes)), &bytes).is_err());
    }

    #[test]
    fn native_model_parameters_cannot_override_shared_resource_limits() {
        validate_parameters(br#"{"temperature":0.6,"top_k":20,"stop":["<end>"]}"#).unwrap();
        for field in [
            "num_ctx",
            "num_gpu",
            "num_batch",
            "num_thread",
            "use_mlock",
            "unknown",
        ] {
            assert!(
                validate_parameters(&serde_json::to_vec(&json!({field:1})).unwrap()).is_err(),
                "{field}"
            );
        }
        assert!(validate_parameters(b"[]").is_err());
    }
}
