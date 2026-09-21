// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
#[test]
fn image_pull_policy_does_not_change_container_configuration() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    for fixture in fixtures {
        let mut spec: Spec = serde_json::from_str(fixture["spec"].as_str().unwrap()).unwrap();
        let before = serde_json::to_value(spec.container("/owned").unwrap()).unwrap();
        for policy in [
            crate::config::ImagePullPolicy::Always,
            crate::config::ImagePullPolicy::Never,
        ] {
            spec.gateway.image_pull_policy = Some(policy);
            if let Some(service) = &mut spec.process {
                service.image_pull_policy = Some(policy);
            }
            assert_eq!(
                serde_json::to_value(spec.container("/owned").unwrap()).unwrap(),
                before
            );
        }
    }
}
#[test]
fn gateway_configuration_preserves_driver_network_images_and_signing_paths() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    let data_path = "/owned data/quoted\"directory";
    let config: toml::Value = toml::from_str(&spec.gateway_config(data_path)).unwrap();
    let openshell = &config["openshell"];
    assert_eq!(openshell["version"].as_integer(), Some(2));
    assert_eq!(
        openshell["gateway"]["compute_driver"].as_str(),
        Some("docker")
    );
    let driver = &openshell["drivers"]["docker"];
    assert_eq!(
        driver["network_name"].as_str(),
        Some(spec.network().as_str())
    );
    assert_eq!(
        driver["sandbox_runtime_image"].as_str(),
        Some(SANDBOX_RUNTIME_IMAGE)
    );
    assert_eq!(driver["supervisor_image"].as_str(), Some(SUPERVISOR_IMAGE));
    let jwt = &openshell["gateway"]["gateway_jwt"];
    for (field, suffix) in [
        ("signing_key_path", "signing.pem"),
        ("public_key_path", "public.pem"),
        ("kid_path", "kid"),
    ] {
        assert_eq!(
            jwt[field].as_str(),
            Some(format!("{data_path}/tls/jwt/{suffix}").as_str())
        );
    }
    assert_eq!(jwt["gateway_id"].as_str(), Some(spec.name.as_str()));
}
#[test]
fn invalid_placement_network_does_not_panic() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let mut value: serde_json::Value =
        serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap();
    value["process"]["engine"] = json!("ssh://host");
    value["process"]["network_cidr"] = json!("invalid");
    let spec: Spec = serde_json::from_value(value).unwrap();
    assert!(spec.bridge().is_err());
}
#[test]
fn runtime_configuration_handles_a_gateway_without_panicking() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    assert!(spec.process.is_none());
    assert!(matches!(
        spec.runtime_configuration(),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn runtime_configuration_rejects_invalid_specs_and_preserves_opaque_input() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap();
    let expected = spec.process.as_ref().unwrap().configuration.clone();
    assert_eq!(spec.runtime_configuration().unwrap(), expected);
    let process = spec.process.take().unwrap();
    assert!(spec.runtime_configuration().is_err());
    spec.process = Some(process);
    spec.generation.clear();
    assert!(spec.runtime_configuration().is_err());
}

#[test]
fn runtime_identity_survives_serialization_but_tracks_changed_configuration() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    for fixture in fixtures {
        let spec: Spec = serde_json::from_str(fixture["spec"].as_str().unwrap()).unwrap();
        let restored: Spec = serde_json::from_str(&spec.json().unwrap()).unwrap();
        assert_eq!(restored, spec);
        let labels = spec.labels().unwrap();
        assert_eq!(labels[OWNER_LABEL], spec.owner);
        assert_eq!(labels[GENERATION_LABEL], spec.generation);
        assert_eq!(restored.labels().unwrap(), labels);
        let mut changed = spec.clone();
        if let Some(process) = &mut changed.process {
            let last = if process.image.ends_with('0') {
                '1'
            } else {
                '0'
            };
            process.image.pop();
            process.image.push(last);
        } else {
            let current = url::Url::parse(&spec.gateway.endpoint)
                .unwrap()
                .port()
                .unwrap();
            let port = if current == 19001 { 19002 } else { 19001 };
            changed.gateway.endpoint = format!("http://127.0.0.1:{port}");
        }
        changed.validate().unwrap();
        assert_ne!(changed.labels().unwrap()[SPEC_LABEL], labels[SPEC_LABEL]);
        assert_eq!(
            changed.volume(),
            spec.volume(),
            "process changes must not select new storage"
        );
        assert_eq!(changed.network(), spec.network());
    }
}

#[test]
fn runtime_launch_preserves_declared_bindings_limits_and_isolation() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    for fixture in fixtures {
        let spec: Spec = serde_json::from_str(fixture["spec"].as_str().unwrap()).unwrap();
        let launch = spec.container("/owned-data").unwrap();
        assert_eq!(launch.image.as_deref(), Some(spec.image()));
        assert_eq!(launch.labels.as_ref().unwrap()[OWNER_LABEL], spec.owner);
        assert_eq!(
            launch.labels.as_ref().unwrap()[GENERATION_LABEL],
            spec.generation
        );
        let host = launch.host_config.unwrap();
        assert!(!host.privileged.unwrap_or(false));
        assert!(host.cap_add.as_ref().is_none_or(Vec::is_empty));
        assert!(
            host.cap_drop
                .as_ref()
                .unwrap()
                .iter()
                .any(|cap| cap == "ALL")
        );
        assert!(
            host.security_opt
                .as_ref()
                .unwrap()
                .iter()
                .any(|opt| opt == "no-new-privileges")
        );
        assert!(
            host.restart_policy
                .as_ref()
                .and_then(|policy| policy.name)
                .is_none_or(|name| name.to_string() == "no")
        );
        let mounts = host.mounts.as_ref().unwrap();
        let storage = mounts
            .iter()
            .find(|mount| mount.source.as_deref() == Some(&spec.volume()))
            .unwrap();
        if let Some(process) = &spec.process {
            assert_eq!(launch.entrypoint.as_ref(), Some(&process.entrypoint));
            assert_eq!(launch.cmd.as_ref(), Some(&process.command));
            assert!(
                launch
                    .env
                    .as_ref()
                    .unwrap()
                    .contains(&format!("NEMOCLAW_RUNTIME_SPEC={}", process.configuration))
            );
            assert_eq!(
                storage.target.as_deref(),
                Some(process.mount_target.as_str())
            );
            assert_eq!(host.network_mode.as_deref(), Some(spec.network().as_str()));
            let requests_gpu = host.device_requests.as_ref().is_some_and(|requests| {
                requests.iter().any(|request| {
                    request.capabilities.as_ref().is_some_and(|groups| {
                        groups
                            .iter()
                            .any(|group| group.iter().any(|capability| capability == "gpu"))
                    })
                })
            });
            assert_eq!(requests_gpu, process.gpu);
            assert_eq!(host.ipc_mode.as_deref() == Some("host"), process.host_ipc);
            assert_eq!(host.memory, Some(process.memory_bytes as i64));
            assert_eq!(host.memory_swap, host.memory);
            assert_eq!(host.shm_size, Some(process.shared_memory_bytes as i64));
            let bindings = host.port_bindings.as_ref().unwrap()[&format!("{}/tcp", process.port)]
                .as_ref()
                .unwrap();
            assert!(bindings.iter().any(|binding| binding.host_ip.as_deref()
                == Some(process.bind_address.as_str())
                && binding.host_port.as_deref() == Some(process.port.to_string().as_str())));
        } else {
            assert_eq!(storage.target.as_deref(), Some("/owned-data"));
            assert_eq!(host.network_mode.as_deref(), Some("host"));
            let command = launch.cmd.as_ref().unwrap();
            let bind = command
                .windows(2)
                .find(|pair| pair[0] == "--bind-address")
                .unwrap()[1]
                .parse::<std::net::IpAddr>()
                .unwrap();
            assert!(
                bind.is_loopback(),
                "managed gateway must not expose its unauthenticated API"
            );
            let port = command.windows(2).find(|pair| pair[0] == "--port").unwrap()[1]
                .parse::<u16>()
                .unwrap();
            assert_eq!(
                Some(port),
                url::Url::parse(&spec.gateway.endpoint).unwrap().port()
            );
            assert!(mounts.iter().any(|mount| mount.source.as_deref()
                == spec.gateway.engine.strip_prefix("unix://")
                && mount.target.as_deref() == Some("/var/run/docker.sock")));
            assert!(
                launch
                    .env
                    .as_ref()
                    .unwrap()
                    .contains(&"OPENSHELL_DB_URL=sqlite:/owned-data/gateway.db".into())
            );
        }
    }
}

#[test]
fn managed_specs_reject_missing_ownership_or_unknown_runtime_layout() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let valid: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    for field in ["owner", "generation", "layout", "kind", "name"] {
        let mut spec = valid.clone();
        match field {
            "owner" => spec.owner.clear(),
            "generation" => spec.generation.clear(),
            "layout" => spec.layout = 3,
            "kind" => spec.kind = "arbitrary".into(),
            "name" => spec.name = "unrelated".into(),
            _ => unreachable!(),
        }
        assert!(
            spec.container("/var/lib/docker/volumes/fixture/_data")
                .is_err()
        );
    }
}

#[test]
fn podman_gateway_namespace_survives_info_id_changes_but_not_network_replacement() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    spec.compute_driver = "podman".into();
    let network = "a".repeat(64);
    let first = spec
        .binding_namespace(Some("random-first"), Some(&network))
        .unwrap();
    assert_eq!(
        first,
        spec.binding_namespace(Some("random-next"), Some(&network))
            .unwrap()
    );
    assert_ne!(
        first,
        spec.binding_namespace(Some("random-first"), Some(&"b".repeat(64)))
            .unwrap()
    );
    assert!(spec.binding_namespace(Some("random-first"), None).is_err());
}

#[test]
fn runtime_specs_reject_legacy_gateway_management_without_reinterpreting_it() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    for fixture in fixtures {
        let current: serde_json::Value =
            serde_json::from_str(fixture["spec"].as_str().unwrap()).unwrap();
        for management in ["managed", "external"] {
            let mut legacy = current.clone();
            legacy["gateway"]["management"] = json!(management);
            assert!(serde_json::from_value::<Spec>(legacy).is_err());
        }
    }
}
