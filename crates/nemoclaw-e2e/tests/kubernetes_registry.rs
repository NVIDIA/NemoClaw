// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A run-owned, authenticated registry for the native kind agent test.
//! No host daemon configuration, user account, or external push is used.
use super::*;
use crate::registry_fixture::{HTPASSWD, PASSWORD, REGISTRY, USER, docker, private_file};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kube::api::PostParams;
use std::process::Stdio;

const SECRET: &str = "image-pull-fixture";
const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";

struct Registry {
    id: String,
    node: String,
    authority: String,
    url: String,
    directory: tempfile::TempDir,
    client: reqwest::Client,
}
impl Drop for Registry {
    fn drop(&mut self) {
        // Only the exact container created by this fixture is removed.
        let _ = std::process::Command::new("docker")
            .args(["rm", "--force", &self.id])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let seed = format!(
            "/etc/nemoclaw-registry-{}/push/{}/hosts.toml",
            self.authority.replace(':', "-"),
            self.authority
        );
        let _ = std::process::Command::new("docker")
            .args(["exec", &self.node, "rm", "-f", &seed])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let path = format!("/etc/containerd/certs.d/{}/hosts.toml", self.authority);
        let _ = std::process::Command::new("docker")
            .args(["exec", &self.node, "rm", "-f", &path])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
impl Registry {
    async fn start() -> Self {
        let node = required("NEMOCLAW_TEST_KIND_NODE");
        let context = required("NEMOCLAW_TEST_KUBE_CONTEXT");
        let cluster = context
            .strip_prefix("kind-nc-live-")
            .expect("the registry test needs the runner's owned kind cluster");
        assert!(!cluster.is_empty() && cluster.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(
            node,
            format!("{}-control-plane", context.strip_prefix("kind-").unwrap())
        );
        let inspected: Value =
            serde_json::from_slice(&docker("inspect kind node", &["inspect", &node], true).await)
                .unwrap();
        assert_eq!(
            inspected[0]["Config"]["Labels"]["io.x-k8s.kind.cluster"],
            context.strip_prefix("kind-").unwrap()
        );
        assert!(inspected[0]["NetworkSettings"]["Networks"]["kind"].is_object());
        let mut nonce = [0; 8];
        getrandom::fill(&mut nonce).unwrap();
        let name = format!(
            "nc-registry-{}",
            nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let directory = tempfile::tempdir().unwrap();
        let auth = directory.path().join("htpasswd");
        private_file(&auth, HTPASSWD.as_bytes());
        let mount = format!(
            "type=bind,source={},target=/auth/htpasswd,readonly",
            auth.display()
        );
        let id = String::from_utf8(
            docker(
                "create registry",
                &[
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
                    REGISTRY,
                ],
                true,
            )
            .await,
        )
        .unwrap()
        .trim()
        .to_owned();
        assert!(id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()));
        let mut registry = Self {
            id,
            node,
            authority: format!("{name}:5000"),
            url: String::new(),
            directory,
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
        };
        docker("start registry", &["start", &registry.id], false).await;
        let address = String::from_utf8(
            docker(
                "read registry port",
                &["port", &registry.id, "5000/tcp"],
                true,
            )
            .await,
        )
        .unwrap();
        let address: std::net::SocketAddr = address.trim().parse().unwrap();
        assert!(address.ip().is_loopback());
        registry.url = format!("http://{address}");
        let ready = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(response) = registry
                    .client
                    .get(format!("{}/v2/", registry.url))
                    .send()
                    .await
                    && response.status() == reqwest::StatusCode::UNAUTHORIZED
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
        .await;
        assert!(ready.is_ok(), "the owned registry requires authentication");
        assert_eq!(
            registry
                .client
                .get(format!("{}/v2/", registry.url))
                .basic_auth(USER, Some("wrong-fixture-password"))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            registry
                .client
                .get(format!("{}/v2/", registry.url))
                .basic_auth(USER, Some(PASSWORD))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::OK
        );
        registry
    }
    async fn image(&self) -> (String, PathBuf) {
        let reference = required("NEMOCLAW_TEST_AGENT_IMAGE");
        let source = fs::read(required("NEMOCLAW_TEST_AGENT_METADATA")).unwrap();
        nemoclaw_sdk::image_metadata::verify(&source, &reference).unwrap();
        let token = STANDARD.encode(format!("{USER}:{PASSWORD}"));
        // The CRI host file has no auth header: kubelet must use the pod's Secret.
        let hosts = format!(
            "server = \"http://{}\"\n[host.\"http://{}\"]\n",
            self.authority, self.authority
        );
        let public = self.directory.path().join("hosts.toml");
        private_file(
            &public,
            format!("{hosts}capabilities = [\"pull\", \"resolve\"]\n").as_bytes(),
        );
        let cri_dir = format!("/etc/containerd/certs.d/{}", self.authority);
        docker(
            "create CRI host directory",
            &["exec", &self.node, "mkdir", "-p", &cri_dir],
            false,
        )
        .await;
        docker(
            "copy CRI host configuration",
            &[
                "cp",
                public.to_str().unwrap(),
                &format!("{}:{cri_dir}/hosts.toml", self.node),
            ],
            false,
        )
        .await;
        // Only ctr's one-time seed command reads this separate private hosts directory.
        let push = self.directory.path().join("push.toml");
        private_file(
            &push,
            format!(
                "{hosts}capabilities = [\"pull\", \"resolve\", \"push\"]\n[host.\"http://{}\".header]\nauthorization = [\"Basic {token}\"]\n",
                self.authority
            )
            .as_bytes(),
        );
        // Kind mounts /tmp as tmpfs, which Docker cp cannot write into.
        // Keep seed authorization separate from the CRI hosts directory.
        let seed = format!(
            "/etc/nemoclaw-registry-{}/push",
            self.authority.replace(':', "-")
        );
        let seed_dir = format!("{seed}/{}", self.authority);
        docker(
            "create seed host directory",
            &["exec", &self.node, "mkdir", "-p", "-m", "700", &seed_dir],
            false,
        )
        .await;
        docker(
            "copy seed authorization",
            &[
                "cp",
                push.to_str().unwrap(),
                &format!("{}:{seed_dir}/hosts.toml", self.node),
            ],
            false,
        )
        .await;
        let tagged = format!("{}/agent:fixture", self.authority);
        docker(
            "tag fixture image",
            &[
                "exec", &self.node, "ctr", "-n", "k8s.io", "images", "tag", &reference, &tagged,
            ],
            false,
        )
        .await;
        docker(
            "seed registry",
            &[
                "exec",
                &self.node,
                "ctr",
                "-n",
                "k8s.io",
                "images",
                "push",
                "--hosts-dir",
                &seed,
                &tagged,
            ],
            false,
        )
        .await;
        docker(
            "remove seed authorization",
            &["exec", &self.node, "rm", &format!("{seed_dir}/hosts.toml")],
            false,
        )
        .await;
        docker(
            "remove seed image alias",
            &[
                "exec", &self.node, "ctr", "-n", "k8s.io", "images", "rm", &tagged,
            ],
            false,
        )
        .await;
        let (digest, metadata, index) = unique_index(&source, &reference, &self.authority);
        let response = self
            .client
            .put(format!("{}/v2/agent/manifests/{digest}", self.url))
            .basic_auth(USER, Some(PASSWORD))
            .header(reqwest::header::CONTENT_TYPE, OCI_INDEX)
            .body(index)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::CREATED);
        let image = format!("{}/agent@{digest}", self.authority);
        nemoclaw_sdk::image_metadata::verify(&metadata, &image).unwrap();
        let path = self.directory.path().join("agent.metadata.json");
        private_file(&path, &metadata);
        (image, path)
    }
    fn secret(&self) -> Secret {
        serde_json::from_value(json!({
            "apiVersion":"v1", "kind":"Secret", "metadata":{"name":SECRET},
            "type":"kubernetes.io/dockerconfigjson",
            "data": {".dockerconfigjson": STANDARD.encode(json!({"auths":{&self.authority:{"auth":STANDARD.encode(format!("{USER}:{PASSWORD}"))}}}).to_string())}
        })).unwrap()
    }
}

/// A new index digest forces a manifest request even though its layers are cached.
/// Each platform's manifest and configuration retain their exact bytes.
fn unique_index(source: &[u8], image: &str, nonce: &str) -> (String, Vec<u8>, String) {
    let mut metadata: Value = serde_json::from_slice(source).unwrap();
    let old = image.rsplit_once('@').unwrap().1;
    let mut index: Value = serde_json::from_str(metadata["blobs"][old].as_str().unwrap()).unwrap();
    // A manifest becomes the only platform of a new index; an index is replaced.
    if index.get("manifests").is_none() {
        let manifest = old.to_owned();
        let config: Value = serde_json::from_str(
            metadata["blobs"][index["config"]["digest"].as_str().unwrap()]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        index = json!({"schemaVersion":2,"mediaType":OCI_INDEX,"manifests":[{
            "mediaType":index["mediaType"],"digest":manifest,
            "size":metadata["blobs"][old].as_str().unwrap().len(),
            "platform":{"os":config["os"],"architecture":config["architecture"]}
        }]});
    } else {
        metadata["blobs"].as_object_mut().unwrap().remove(old);
    }
    index["mediaType"] = json!(OCI_INDEX);
    index["annotations"]["org.nvidia.nemoclaw.test.registry"] = json!(nonce);
    let raw = index.to_string();
    let digest = digest(raw.as_bytes());
    assert_ne!(old, digest);
    metadata["blobs"][&digest] = json!(raw);
    (digest, serde_json::to_vec(&metadata).unwrap(), raw)
}

fn digest(bytes: &[u8]) -> String {
    let hex: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("sha256:{hex}")
}

#[tokio::test]
#[ignore = "owns a private registry on the runner's disposable kind network; run cargo ci live-kind"]
async fn a_private_agent_image_uses_cluster_secrets_without_credentials_in_state() {
    let registry = Registry::start().await;
    let (image, metadata) = registry.image().await;
    let client = connect(&ClusterTarget {
        kubeconfig: required("NEMOCLAW_TEST_KUBECONFIG").into(),
        context: required("NEMOCLAW_TEST_KUBE_CONTEXT"),
    })
    .await
    .unwrap();
    let secret = registry.secret();
    let (created, observed_uid) = tokio::sync::oneshot::channel();
    let caller = client.clone();
    let state = deploy_image_and_export(
        "kubernetes",
        &image,
        metadata.to_str().unwrap(),
        &[SECRET],
        async move |namespace| {
            let namespaces: Api<Namespace> = Api::all(caller.clone());
            let until = tokio::time::Instant::now() + Duration::from_secs(60);
            while namespaces.get_opt(namespace).await.unwrap().is_none() {
                assert!(
                    tokio::time::Instant::now() < until,
                    "managed namespace was not created"
                );
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let secrets: Api<Secret> = Api::namespaced(caller, namespace);
            let secret = secrets
                .create(&PostParams::default(), &secret)
                .await
                .unwrap();
            created
                .send((namespace.to_owned(), secret.metadata.uid.unwrap()))
                .unwrap();
        },
    )
    .await;
    for value in [
        PASSWORD.to_owned(),
        STANDARD.encode(format!("{USER}:{PASSWORD}")),
    ] {
        assert!(
            !state
                .windows(value.len())
                .any(|window| window == value.as_bytes()),
            "registry values must stay out of OpenTofu state"
        );
    }
    let (namespace, uid) = observed_uid.await.unwrap();
    let retained = Api::<Secret>::namespaced(client, &namespace)
        .get(SECRET)
        .await
        .unwrap();
    assert_eq!(
        retained.metadata.uid.as_deref(),
        Some(uid.as_str()),
        "destroy retains the caller-managed registry Secret"
    );
}

#[test]
fn fixture_indices_force_a_new_pull_without_changing_image_contents() {
    let config = json!({"os":"linux","architecture":"arm64"}).to_string();
    let config_digest = digest(config.as_bytes());
    let manifest =
        json!({"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json",
        "config":{"digest":config_digest},"layers":[]})
        .to_string();
    let manifest_digest = digest(manifest.as_bytes());
    for indexed in [false, true] {
        let mut metadata = json!({"schema_version":2,
            "blobs":{&manifest_digest:manifest,&config_digest:config}});
        let root = if indexed {
            let index = json!({"schemaVersion":2,"mediaType":OCI_INDEX,"manifests":[{
                "mediaType":"application/vnd.oci.image.manifest.v1+json","digest":manifest_digest,
                "size":manifest.len(),"platform":{"os":"linux","architecture":"arm64"}}
            ]})
            .to_string();
            let digest = digest(index.as_bytes());
            metadata["blobs"][&digest] = json!(index);
            digest
        } else {
            manifest_digest.clone()
        };
        let source = serde_json::to_vec(&metadata).unwrap();
        let reference = format!("fixture/agent@{root}");
        let (one, changed, index) = unique_index(&source, &reference, "one");
        let (two, _, _) = unique_index(&source, &reference, "two");
        assert_ne!(one, root);
        assert_ne!(
            one, two,
            "each registry run must require an uncached digest"
        );
        let changed: Value = serde_json::from_slice(&changed).unwrap();
        assert_eq!(changed["blobs"][&one], index);
        assert_eq!(changed["schema_version"], 2);
        assert_eq!(changed["blobs"][&manifest_digest], manifest);
        assert_eq!(changed["blobs"][&config_digest], config);
        assert_eq!(changed["blobs"].as_object().unwrap().len(), 3);
    }
}
