// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Resolve immutable public Hugging Face snapshots without downloading weights.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Info {
    sha: String,
    siblings: Vec<Entry>,
}
#[derive(Deserialize)]
struct Entry {
    rfilename: String,
    #[serde(rename = "blobId")]
    blob: String,
    size: u64,
    lfs: Option<Lfs>,
}
#[derive(Deserialize)]
struct Lfs {
    sha256: String,
    size: u64,
}

fn identity(repository: &str, revision: &str) -> Result<(), Error> {
    Manifest {
        repository: repository.into(),
        revision: revision.into(),
        files: vec![File {
            name: "placeholder".into(),
            size: 1,
            sha256: "0".repeat(64),
        }],
    }
    .validate()
}
impl Client {
    async fn bounded(&self, url: reqwest::Url, limit: usize) -> Result<Vec<u8>, Error> {
        let mut response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| failure("model metadata transport failed"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(failure(
                "model metadata request rejected; absence is not confirmed",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| failure("partial model metadata response"))?
        {
            if bytes.len() + chunk.len() > limit {
                return Err(failure("model metadata exceeds limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    /// Read-only resolution. Mutable branches, incomplete inventories, unsafe paths,
    /// missing safetensors and incorrect Git/LFS identities all fail closed.
    pub async fn resolve(&self, repository: &str, revision: &str) -> Result<Manifest, Error> {
        identity(repository, revision)?;
        let work = async {
            let mut url =
                reqwest::Url::parse(&self.base_url).map_err(|_| failure("invalid model origin"))?;
            url.path_segments_mut()
                .map_err(|_| failure("invalid model origin"))?
                .extend(["api", "models"])
                .extend(repository.split('/'))
                .extend(["revision", revision]);
            url.set_query(Some("blobs=true"));
            let info: Info = serde_json::from_slice(&self.bounded(url, 4 << 20).await?)
                .map_err(|_| failure("incomplete model inventory"))?;
            if info.sha != revision || info.siblings.is_empty() || info.siblings.len() > 10000 {
                return Err(failure("model inventory differs from requested commit"));
            }
            // Validate every path, including entries not selected for this backend.
            let inventory = Manifest {
                repository: repository.into(),
                revision: revision.into(),
                files: info
                    .siblings
                    .iter()
                    .map(|f| File {
                        name: f.rfilename.clone(),
                        size: f.size.max(1),
                        sha256: "0".repeat(64),
                    })
                    .collect(),
            };
            inventory.validate()?;
            let mut manifest = Manifest {
                repository: repository.into(),
                revision: revision.into(),
                files: Vec::new(),
            };
            for entry in info.siblings {
                let name = &entry.rfilename;
                // Native safetensors and tokenizer/config data only; never execute repo code.
                let selected = !name.contains('/')
                    && (name.ends_with(".safetensors")
                        || name.ends_with(".json")
                        || name.ends_with(".txt")
                        || name.ends_with(".model")
                        || name.ends_with(".jinja")
                        || name.starts_with("LICENSE")
                        || name.starts_with("NOTICE"));
                if !selected {
                    continue;
                }
                if entry.size == 0 {
                    continue;
                }
                let digest = if let Some(lfs) = entry.lfs {
                    if lfs.size != entry.size {
                        return Err(failure("model LFS size conflicts with inventory"));
                    }
                    lfs.sha256
                } else {
                    if entry.size > 32 << 20 {
                        return Err(failure("non-LFS model file exceeds metadata limit"));
                    }
                    let mut url = reqwest::Url::parse(&self.base_url)
                        .map_err(|_| failure("invalid model origin"))?;
                    url.path_segments_mut()
                        .map_err(|_| failure("invalid model origin"))?
                        .extend(repository.split('/'))
                        .extend(["resolve", revision, name]);
                    let bytes = self.bounded(url, 32 << 20).await?;
                    let mut git = sha1::Sha1::new();
                    git.update(format!("blob {}\0", bytes.len()).as_bytes());
                    git.update(&bytes);
                    if bytes.len() as u64 != entry.size || hex(git.finalize()) != entry.blob {
                        return Err(failure("model metadata does not match its Git blob"));
                    }
                    hex(Sha256::digest(bytes))
                };
                manifest.files.push(File {
                    name: entry.rfilename,
                    size: entry.size,
                    sha256: digest,
                });
            }
            manifest.files.sort_by(|a, b| a.name.cmp(&b.name));
            manifest.validate()?;
            if !manifest.files.iter().any(|f| f.name == "config.json")
                || !manifest
                    .files
                    .iter()
                    .any(|f| f.name.ends_with(".safetensors"))
            {
                return Err(failure(
                    "backend requires config.json and safetensors weights",
                ));
            }
            Ok(manifest)
        };
        tokio::time::timeout(Duration::from_secs(120), work)
            .await
            .map_err(|_| failure("model resolution timed out"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn response(status: &str, bytes: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bytes}",
            bytes.len()
        )
    }
    fn info() -> serde_json::Value {
        let mut git = sha1::Sha1::new();
        git.update(b"blob 2\0{}");
        json!({"sha":"a".repeat(40),"siblings":[
            {"rfilename":"model.safetensors","blobId":"b".repeat(40),"size":3,"lfs":{"sha256":hex(Sha256::digest(b"abc")),"size":3}},
            {"rfilename":"config.json","blobId":hex(git.finalize()),"size":2}
        ]})
    }
    #[tokio::test]
    async fn selected_commit_resolves_without_weights_then_downloads_and_reuses_exact_snapshot() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let client = Client {
            base_url: format!("http://{}", listener.local_addr().unwrap()),
            http: reqwest::Client::new(),
            resume_attempts: 1,
        };
        let seen = requests.clone();
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    bytes.push(stream.read_u8().await.unwrap());
                }
                let request = String::from_utf8(bytes).unwrap();
                let body = if request.starts_with("GET /api/") {
                    info().to_string()
                } else if request.contains("/config.json ") {
                    "{}".into()
                } else {
                    assert!(request.contains("/model.safetensors "));
                    "abc".into()
                };
                seen.lock().unwrap().push(request);
                stream
                    .write_all(response("200 OK", &body).as_bytes())
                    .await
                    .unwrap();
            }
        });
        let manifest = client
            .resolve("another/model", &"a".repeat(40))
            .await
            .unwrap();
        assert_eq!(manifest.repository, "another/model");
        assert_eq!(
            requests.lock().unwrap().len(),
            2,
            "resolution downloaded weights"
        );
        let root = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        client
            .ensure(root.path(), &manifest, &cancel, &|_| {})
            .await
            .unwrap();
        let receipt = observe(root.path(), &manifest).unwrap();
        assert_eq!(
            client
                .ensure(root.path(), &manifest, &cancel, &|_| {})
                .await
                .unwrap(),
            receipt
        );
        server.await.unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests.iter().all(|r| r.contains(&"a".repeat(40))));
        assert!(requests[0].starts_with("GET /api/models/another/model/revision/"));
    }
    #[tokio::test]
    async fn invalid_or_partial_inventory_never_confirms_a_snapshot() {
        let original = info();
        let mut cases = Vec::new();
        let mut wrong = original.clone();
        wrong["sha"] = json!("b".repeat(40));
        cases.push(wrong);
        let mut wrong = original.clone();
        wrong["siblings"][0]["rfilename"] = json!("../outside");
        cases.push(wrong);
        let mut wrong = original.clone();
        wrong["siblings"][0]["lfs"]["size"] = json!(4);
        cases.push(wrong);
        let mut wrong = original.clone();
        let duplicate = wrong["siblings"][0].clone();
        wrong["siblings"].as_array_mut().unwrap().push(duplicate);
        cases.push(wrong);
        for wrong in cases {
            let (client, _, task) =
                super::super::tests::server(vec![response("200 OK", &wrong.to_string())]).await;
            assert!(
                client
                    .resolve("another/model", &"a".repeat(40))
                    .await
                    .is_err()
            );
            task.await.unwrap();
        }
        for status in ["401 Unauthorized", "404 Not Found", "503 Unavailable"] {
            let (client, _, task) =
                super::super::tests::server(vec![response(status, "secret")]).await;
            let error = client
                .resolve("another/model", &"a".repeat(40))
                .await
                .unwrap_err();
            assert!(!error.to_string().contains("secret"));
            task.await.unwrap();
        }
        let (client, _, task) = super::super::tests::server(vec![
            response("200 OK", &original.to_string()),
            response("200 OK", "xx"),
        ])
        .await;
        assert!(
            client
                .resolve("another/model", &"a".repeat(40))
                .await
                .is_err()
        );
        task.await.unwrap();
    }
}
