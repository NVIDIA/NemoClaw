// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

#[path = "managed_gateway_live/profile_revision.rs"]
mod profile_revision;

use bollard::{Docker, query_parameters::CreateContainerOptions};
use nemoclaw_provider::docker::Engine;
use nemoclaw_sdk::{
    compile::runtime_targets,
    config::{ComputeDriver, DEFAULT_GATEWAY_IMAGE, Document},
    managed::{GENERATION_LABEL, OWNER_LABEL, SANDBOX_RUNTIME_IMAGE, SUPERVISOR_IMAGE, Spec},
};
use openshell_sdk::{
    DeleteOptions, EdgeAuthInterceptor, ExecOptions, OpenShellClient, SandboxPhase, SandboxRef,
    SandboxSpec,
};
use std::{fs, path::PathBuf, time::Duration};
use tonic::transport::Channel;

fn gateway_spec(variable: &str) -> Spec {
    let path = PathBuf::from(std::env::var_os(variable).expect("explicit owned gateway document"));
    assert!(path.is_absolute());
    let document = Document::parse(fs::File::open(path).unwrap()).unwrap();
    assert!(document.spec.gateway.as_managed().is_some());
    assert!(document.spec.services.is_empty());
    assert_eq!(
        document.spec.gateway.runtime().provider,
        ComputeDriver::Docker
    );
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).unwrap();
    let generation = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let targets =
        runtime_targets(&document, &[("managed_gateway".into(), generation)].into()).unwrap();
    let storage = targets
        .iter()
        .find(|target| target.kind == "gateway_storage")
        .unwrap();
    let mut spec: Spec = serde_json::from_str(&storage.values["spec"]).unwrap();
    spec.layout = 2;
    spec.gateway.endpoint = document.spec.gateway.endpoint().into();
    spec
}

fn client(spec: &Spec) -> OpenShellClient {
    let channel = Channel::from_shared(spec.gateway.endpoint.clone())
        .unwrap()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .connect_lazy();
    OpenShellClient::from_parts(channel, EdgeAuthInterceptor::new(None, None).unwrap())
}

async fn ready(api: &Docker, spec: &Spec, client: &OpenShellClient) {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let gateway = api.inspect_container(&spec.name, None).await.unwrap();
            assert_eq!(
                gateway.state.unwrap().running,
                Some(true),
                "gateway {} exited; inspect its logs",
                spec.name
            );
            if client.health().await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .expect("gateway readiness timed out; resources retained");
}

async fn start(api: &Docker, engine: &Engine, spec: &Spec) -> OpenShellClient {
    // Never run a gateway with OpenShell's shared default namespace on this daemon.
    assert!(
        spec.gateway_config("/owned")
            .contains(&format!("sandbox_label = {:?}", spec.name))
    );
    let mut storage = spec.clone();
    storage.layout = 1;
    storage.gateway.endpoint = "http://127.0.0.1:8080".into();
    let binding = engine
        .gateway_storage(&storage, "", true)
        .await
        .unwrap()
        .unwrap();
    let volume = engine.volume(&spec.volume()).await.unwrap().unwrap();
    let created = api
        .create_container(
            Some(CreateContainerOptions {
                name: Some(spec.name.clone()),
                ..Default::default()
            }),
            spec.container(&volume.mountpoint).unwrap(),
        )
        .await
        .unwrap();
    api.start_container(&created.id, None).await.unwrap();
    let client = client(spec);
    ready(api, spec, &client).await;
    assert_eq!(
        engine
            .gateway_storage(&storage, &binding, false)
            .await
            .unwrap()
            .as_deref(),
        Some(binding.as_str())
    );
    client
}

async fn owned(client: &OpenShellClient, spec: &Spec, expected: &SandboxRef) {
    let observed = client.get_sandbox(&expected.name).await.unwrap();
    assert_eq!(observed.id, expected.id);
    assert_eq!(observed.labels[OWNER_LABEL], spec.owner);
    assert_eq!(observed.labels[GENERATION_LABEL], spec.generation);
    assert_eq!(observed.phase, SandboxPhase::Ready);
}

async fn exec(client: &OpenShellClient, sandbox: &SandboxRef, command: &[&str]) -> Vec<u8> {
    let command: Vec<String> = command.iter().map(|part| (*part).into()).collect();
    let result = client
        .exec(
            &sandbox.name,
            &command,
            ExecOptions {
                timeout: Some(Duration::from_secs(10)),
                no_login_shell: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(result.exit_code, 0, "sandbox execution failed");
    result.stdout
}

#[tokio::test]
#[ignore = "requires explicit fresh gateway documents and pinned local images; creates two gateways and sandboxes, retains gateway storage"]
async fn pinned_docker_gateways_reach_ready_without_interfering_with_other_sandboxes() {
    let specs = [
        gateway_spec("NEMOCLAW_TEST_GATEWAY_DOCUMENT"),
        gateway_spec("NEMOCLAW_TEST_SECOND_GATEWAY_DOCUMENT"),
    ];
    let image = std::env::var("NEMOCLAW_TEST_GATEWAY_SANDBOX_IMAGE")
        .expect("explicit local sandbox image digest");
    assert!(image.contains("@sha256:"));
    assert_ne!(specs[0].owner, specs[1].owner);
    assert_ne!(specs[0].name, specs[1].name);
    assert_ne!(specs[0].gateway.endpoint, specs[1].gateway.endpoint);
    assert_ne!(specs[0].network_cidr(), specs[1].network_cidr());
    assert_eq!(specs[0].engine(), specs[1].engine());
    let engine = Engine::connect(specs[0].engine()).unwrap();
    let api =
        Docker::connect_with_unix(specs[0].engine(), 120, bollard::API_DEFAULT_VERSION).unwrap();
    for spec in &specs {
        spec.validate_runtime().unwrap();
        assert_eq!(spec.compute_driver, ComputeDriver::Docker);
        assert!(spec.process.is_none());
        assert_eq!(spec.image(), DEFAULT_GATEWAY_IMAGE);
        assert!(engine.container(&spec.name).await.unwrap().is_none());
        assert!(
            engine
                .container(&format!("{}-initialize", spec.name))
                .await
                .unwrap()
                .is_none()
        );
        assert!(engine.volume(&spec.volume()).await.unwrap().is_none());
        assert!(engine.network(&spec.network()).await.unwrap().is_none());
        eprintln!(
            "owned test gateway: {} ({})",
            spec.name, spec.gateway.endpoint
        );
    }
    for image in [
        DEFAULT_GATEWAY_IMAGE,
        SANDBOX_RUNTIME_IMAGE,
        SUPERVISOR_IMAGE,
        &image,
    ] {
        assert!(
            engine.image(image).await.unwrap().is_some(),
            "required pinned image is absent: {image}"
        );
    }
    let mut running = Vec::new();
    for spec in &specs {
        let client = start(&api, &engine, spec).await;
        let sandbox = client
            .create_sandbox(SandboxSpec {
                name: Some("isolation-check".into()),
                image: Some(image.clone()),
                labels: [
                    (OWNER_LABEL.into(), spec.owner.clone()),
                    (GENERATION_LABEL.into(), spec.generation.clone()),
                ]
                .into(),
                command: vec!["/bin/sleep".into(), "600".into()],
                ..Default::default()
            })
            .await
            .unwrap();
        client
            .wait_ready(&sandbox.name, Duration::from_secs(90))
            .await
            .unwrap();
        owned(&client, spec, &sandbox).await;
        exec(
            &client,
            &sandbox,
            &[
                "/bin/sh",
                "-c",
                "printf retained > /tmp/nemoclaw-gateway-isolation",
            ],
        )
        .await;
        running.push((client, sandbox));
        // Starting gateway two used to remove gateway one's supervisor.
        for (index, (client, sandbox)) in running.iter().enumerate() {
            owned(client, &specs[index], sandbox).await;
            assert_eq!(
                exec(
                    client,
                    sandbox,
                    &["/bin/cat", "/tmp/nemoclaw-gateway-isolation"]
                )
                .await,
                b"retained"
            );
        }
    }
    // Gateway startup reconciliation must remain scoped on later starts too.
    let second = api.inspect_container(&specs[1].name, None).await.unwrap();
    let second_id = second.id.unwrap();
    api.stop_container(&second_id, None).await.unwrap();
    api.start_container(&second_id, None).await.unwrap();
    ready(&api, &specs[1], &running[1].0).await;
    owned(&running[0].0, &specs[0], &running[0].1).await;
    assert_eq!(
        exec(
            &running[0].0,
            &running[0].1,
            &["/bin/cat", "/tmp/nemoclaw-gateway-isolation"]
        )
        .await,
        b"retained"
    );
    for (spec, (client, sandbox)) in specs.iter().zip(running) {
        // Teardown accepts our identified sandbox even if its own gateway restart
        // left it in Error; never delete a same-name replacement.
        let observed = client.get_sandbox(&sandbox.name).await.unwrap();
        assert_eq!(observed.id, sandbox.id);
        assert_eq!(observed.labels[OWNER_LABEL], spec.owner);
        assert_eq!(observed.labels[GENERATION_LABEL], spec.generation);
        let deleted = client
            .delete_sandbox(&sandbox.name, DeleteOptions::default())
            .await
            .unwrap();
        assert_eq!(deleted.sandbox_id.as_deref(), Some(sandbox.id.as_str()));
        client
            .wait_deleted(&sandbox.name, Duration::from_secs(30), Some(&sandbox.id))
            .await
            .unwrap();
        let gateway = api.inspect_container(&spec.name, None).await.unwrap();
        let labels = gateway.config.unwrap().labels.unwrap();
        assert_eq!(labels[OWNER_LABEL], spec.owner);
        assert_eq!(labels[GENERATION_LABEL], spec.generation);
        let id = gateway.id.unwrap();
        api.stop_container(&id, None).await.unwrap();
        api.remove_container(&id, None).await.unwrap();
        assert!(engine.volume(&spec.volume()).await.unwrap().is_some());
    }
}
