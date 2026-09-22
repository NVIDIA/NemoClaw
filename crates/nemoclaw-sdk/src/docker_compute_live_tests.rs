// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Explicit CPU transport fixture: no GPU, model execution, or hardware-capacity claim.

use crate::{
    bundle::Bundle,
    compile::{self, Generations},
    config::Document,
    docker::Engine,
    managed::{Spec, Storage},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, process::Command};

const ENGINE: &str = "unix:///var/run/docker.sock";

fn docker(args: &[&str]) -> Vec<u8> {
    let result = Command::new("docker")
        .args(["--host", ENGINE])
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "docker {args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    result.stdout
}

struct Owned {
    name: String,
    volume: String,
    network: String,
    uid: String,
}

impl Drop for Owned {
    fn drop(&mut self) {
        for (kind, name) in [
            ("container", &self.name),
            ("volume", &self.volume),
            ("network", &self.network),
        ] {
            let Ok(output) = Command::new("docker")
                .args(["--host", ENGINE, kind, "inspect", name])
                .output()
            else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) else {
                continue;
            };
            let labels = if kind == "container" {
                &value[0]["Config"]["Labels"]
            } else {
                &value[0]["Labels"]
            };
            if labels["nemoclaw.nvidia.com/uid"] == self.uid
                || labels["nemoclaw.experiment"] == self.uid
            {
                let mut command = Command::new("docker");
                command.args(["--host", ENGINE, kind, "rm"]);
                if kind == "container" {
                    command.arg("--force");
                }
                let _ = command.arg(name).output();
            }
        }
    }
}

fn tofu(bundle: &Bundle, root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new(bundle.tofu())
        .args(args)
        .current_dir(root)
        .env("TF_CLI_CONFIG_FILE", root.join("providers.tfrc"))
        .env("TF_IN_AUTOMATION", "1")
        .env("CHECKPOINT_DISABLE", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "tofu {args:?}: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn write_graph(root: &Path, graph: &Value) {
    fs::write(
        root.join("main.tf.json"),
        serde_json::to_vec_pretty(graph).unwrap(),
    )
    .unwrap();
}

fn assert_noop(bundle: &Bundle, root: &Path) {
    tofu(bundle, root, &["plan", "-input=false", "-out=noop.plan"]);
    let plan: Value =
        serde_json::from_slice(&tofu(bundle, root, &["show", "-json", "noop.plan"])).unwrap();
    for change in plan["resource_changes"].as_array().unwrap() {
        assert_eq!(change["change"]["actions"], json!(["no-op"]));
    }
}

async fn wait_ready(engine: &Engine, observed: &crate::managed::RuntimeObservation) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let status = engine.runtime_status(observed).await.unwrap();
            if status.phase == "ready" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
}

fn fixture(
    kind: &str,
    image: &str,
    uid: &str,
    subnet: u8,
    provider_version: &str,
) -> (Value, Spec, Storage, String) {
    let source = if kind == "ollama" {
        include_str!("../tests/fixtures/config/managed-ollama.yaml")
    } else {
        include_str!("../tests/fixtures/config/spark.yaml")
    };
    let mut document: Value = serde_saphyr::from_str(source).unwrap();
    document["metadata"]["uid"] = json!(uid);
    let service = document["spec"]["services"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    service["image"] = json!(image);
    service["imagePullPolicy"] = json!("Never");
    service["placement"] =
        json!({"engine":"ssh://fixture@gpu-host", "networkCidr":format!("172.28.{subnet}.0/24")});
    service["publication"] =
        json!({"endpoint":"http://10.0.0.8:18888/v1", "bindAddress":"10.0.0.8"});
    document["spec"]["gateway"] = json!({"management":"external","endpoint":"http://127.0.0.1:1"});
    let document = Document::parse(document.to_string().as_bytes()).unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
        "ollama_service",
    ]
    .into_iter()
    .map(|name| (name.into(), "a".repeat(32)))
    .collect();
    let mut graph = compile::compile_runtime(&document, &generations, provider_version).unwrap();
    let targets = compile::runtime_targets(&document, &generations).unwrap();
    let target = targets
        .iter()
        .find(|target| target.address.starts_with("docker_container."))
        .unwrap();
    let address = target.address.clone();
    let mut spec: Spec = serde_json::from_str(&target.values["spec"]).unwrap();
    let process = spec.process.as_mut().unwrap();
    assert!(process.gpu, "production installer must request a GPU");
    process.gpu = false;
    process.engine = ENGINE.into();
    process.memory_bytes = 256 << 20;
    process.shared_memory_bytes = 64 << 20;
    process.bind_address = "127.0.0.1".into();
    process.port = free_port();
    let port = process.port;
    let storage = Storage {
        name: spec.volume(),
        owner: spec.owner.clone(),
        generation: spec.generation.clone(),
        engine: ENGINE.into(),
    };
    for provider in graph["provider"]["docker"].as_array_mut().unwrap() {
        provider["host"] = json!(ENGINE);
    }
    // Adapt only host placement and GPU-sized limits for this CPU fixture.
    // Image, command, environment, mounts, network and dependency graph remain
    // declarations produced by the production installers and Docker compiler.
    let container = &mut graph["resource"]["docker_container"][address.split_once('.').unwrap().1];
    assert_eq!(container["gpus"], "all");
    container.as_object_mut().unwrap().remove("gpus");
    container["memory"] = json!(256);
    container["memory_swap"] = json!(256);
    container["shm_size"] = json!(64);
    container["destroy_grace_seconds"] = json!(1);
    container["ports"][0]["ip"] = json!("127.0.0.1");
    container["ports"][0]["external"] = json!(port);
    (graph, spec, storage, address)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn sentinel(name: &str, write: bool) {
    let script = if write {
        "open('/data/fixture-sentinel','w').write('retained fixture data')"
    } else {
        "assert open('/data/fixture-sentinel').read() == 'retained fixture data'"
    };
    docker(&["exec", name, "python3", "-c", script]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE and NEMOCLAW_TEST_RUNTIME_IMAGE_OLLAMA/_VLLM; owns isolated Docker resources"]
async fn cpu_runtime_provider_reconciles_compute_and_retains_data() {
    let bundle = Bundle::open(Path::new(
        &std::env::var("NEMOCLAW_TEST_BUNDLE").expect("explicit verified bundle"),
    ))
    .unwrap();
    for kind in ["ollama", "vllm"] {
        let image = std::env::var(format!(
            "NEMOCLAW_TEST_RUNTIME_IMAGE_{}",
            kind.to_uppercase()
        ))
        .expect("explicit digest-pinned CPU fixture image");
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let seed: String = Sha256::digest(root.to_string_lossy().as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let uid = format!(
            "{}-{}-{}-{}-{}",
            &seed[..8],
            &seed[8..12],
            &seed[12..16],
            &seed[16..20],
            &seed[20..32]
        );
        let subnet = 32 + (u8::from_str_radix(&seed[..2], 16).unwrap() % 180);
        let (mut graph, mut spec, storage, address) =
            fixture(kind, &image, &uid, subnet, &bundle.manifest.version);
        let _owned = Owned {
            name: spec.name.clone(),
            volume: spec.volume(),
            network: spec.network(),
            uid,
        };
        let mirror = serde_json::to_string(&bundle.directory.join("providers")).unwrap();
        fs::write(
            root.join("providers.tfrc"),
            format!("provider_installation {{ filesystem_mirror {{ path = {mirror} }} }}\n"),
        )
        .unwrap();
        write_graph(root, &graph);
        tofu(&bundle, root, &["init", "-input=false"]);
        tofu(&bundle, root, &["apply", "-auto-approve", "-input=false"]);
        let engine = Engine::connect(ENGINE).unwrap();
        let original_id =
            crate::state::bindings(root, &bundle.tofu(), &crate::CancellationToken::new())
                .await
                .unwrap()[&address]
                .id
                .clone();
        assert!(
            !original_id.contains('/'),
            "Docker provider uses raw container IDs"
        );
        let storage_id = engine
            .volume(&storage.name)
            .await
            .unwrap()
            .unwrap()
            .created_at;
        let observed = engine
            .observe_service(&spec, &original_id)
            .await
            .unwrap()
            .unwrap();
        assert!(observed.running);
        wait_ready(&engine, &observed).await;
        sentinel(&spec.name, true);
        assert_noop(&bundle, root);

        docker(&["stop", "--time", "1", &spec.name]);
        assert!(
            !engine
                .observe_service(&spec, &original_id)
                .await
                .unwrap()
                .unwrap()
                .running
        );
        tofu(&bundle, root, &["apply", "-auto-approve", "-input=false"]);
        let restarted_id =
            crate::state::bindings(root, &bundle.tofu(), &crate::CancellationToken::new())
                .await
                .unwrap()[&address]
                .id
                .clone();
        let observed = engine
            .observe_service(&spec, &restarted_id)
            .await
            .unwrap()
            .unwrap();
        assert!(observed.running);
        wait_ready(&engine, &observed).await;
        sentinel(&spec.name, false);
        assert_eq!(
            engine
                .volume(&storage.name)
                .await
                .unwrap()
                .unwrap()
                .created_at,
            storage_id
        );
        assert_noop(&bundle, root);

        // Publication changes use normal provider replacement, preserving data.
        let port = free_port();
        spec.process.as_mut().unwrap().port = port;
        graph["resource"]["docker_container"][address.split_once('.').unwrap().1]["ports"][0]["external"] =
            json!(port);
        write_graph(root, &graph);
        tofu(&bundle, root, &["apply", "-auto-approve", "-input=false"]);
        let changed_id =
            crate::state::bindings(root, &bundle.tofu(), &crate::CancellationToken::new())
                .await
                .unwrap()[&address]
                .id
                .clone();
        assert_ne!(changed_id, restarted_id);
        sentinel(&spec.name, false);
        assert_eq!(
            engine
                .volume(&storage.name)
                .await
                .unwrap()
                .unwrap()
                .created_at,
            storage_id
        );
        let network_before: Value =
            serde_json::from_slice(&docker(&["network", "inspect", &spec.network()])).unwrap();
        docker(&["rm", "--force", &spec.name]);
        docker(&["network", "rm", &spec.network()]);
        tofu(&bundle, root, &["apply", "-auto-approve", "-input=false"]);
        let recovered_id =
            crate::state::bindings(root, &bundle.tofu(), &crate::CancellationToken::new())
                .await
                .unwrap()[&address]
                .id
                .clone();
        assert_ne!(recovered_id, changed_id);
        let network_after: Value =
            serde_json::from_slice(&docker(&["network", "inspect", &spec.network()])).unwrap();
        assert_ne!(network_before[0]["Id"], network_after[0]["Id"]);
        sentinel(&spec.name, false);
        assert_eq!(
            engine
                .volume(&storage.name)
                .await
                .unwrap()
                .unwrap()
                .created_at,
            storage_id
        );
        assert_noop(&bundle, root);

        // Remove disposable resources while keeping durable storage declared.
        for kind in ["docker_container", "docker_network", "docker_image"] {
            graph["resource"].as_object_mut().unwrap().remove(kind);
        }
        graph.as_object_mut().unwrap().remove("data");
        write_graph(root, &graph);
        tofu(&bundle, root, &["apply", "-auto-approve", "-input=false"]);
        assert!(engine.container(&spec.name).await.unwrap().is_none());
        assert!(engine.network(&spec.network()).await.unwrap().is_none());
        assert_eq!(
            engine
                .volume(&storage.name)
                .await
                .unwrap()
                .unwrap()
                .created_at,
            storage_id
        );
        docker(&["image", "inspect", &image]);
    }
}
