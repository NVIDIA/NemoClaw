// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile_runtime, runtime_targets},
    config::Document,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const CPU_LABEL: &str = "nemoclaw.nvidia.com/cpu-limit-millis";
const MEMORY_LABEL: &str = "nemoclaw.nvidia.com/memory-limit-gib";

fn label<'a>(container: &'a Value, name: &str) -> Option<&'a str> {
    container["labels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|label| label["label"] == name)
        .map(|label| label["value"].as_str().unwrap())
}

fn dependencies(resource: &Value) -> BTreeSet<&str> {
    resource["depends_on"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect()
}

#[test]
fn runtime_compilation_does_not_require_openshell_resource_generations() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let generations = ["managed_gateway", "inference_service"]
        .map(|kind| (kind.into(), "b".repeat(32)))
        .into();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert!(graph["resource"]["docker_container"].is_object());
    assert!(graph["resource"].get("openshell_sandbox").is_none());
    assert!(graph["data"].get("fabric_agent_readiness").is_none());
}

#[test]
fn docker_model_limits_reach_opentofu_and_native_container_configuration() {
    let gib = 1_i64 << 30;
    for input in [
        include_str!("fixtures/config/spark.yaml"),
        include_str!("fixtures/config/managed-ollama.yaml"),
    ] {
        let baseline = Document::parse(input.as_bytes()).unwrap();
        let generations = ["managed_gateway", "inference_service", "ollama_service"]
            .map(|kind| (kind.into(), "b".repeat(32)))
            .into();
        // Kubernetes and `docker --cpus` use a 100 ms CFS period. The kernel
        // rejects quotas below 1 ms, so limits below 10 millicores use 1 ms as
        // kubelet does.
        for (cpu, quota, memory_gib) in [
            (1250, 125_000, 64),
            (2000, 200_000, 128),
            (10, 1000, 48),
            (1, 1000, 32),
        ] {
            let mut value = serde_json::to_value(&baseline).unwrap();
            for service in value["spec"]["services"]
                .as_object_mut()
                .unwrap()
                .values_mut()
            {
                service["container"] = json!({"cpuLimitMillis":cpu, "memoryLimitGiB":memory_gib});
            }
            let document = Document::parse(value.to_string().as_bytes()).unwrap();
            let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
            for target in runtime_targets(&document, &generations)
                .unwrap()
                .iter()
                .filter(|target| {
                    matches!(target.kind.as_str(), "inference_service" | "ollama_service")
                })
            {
                let (_, name) = target.address.split_once('.').unwrap();
                let container = &graph["resource"]["docker_container"][name];
                assert_eq!(container["cpu_period"], 100_000, "{}", target.kind);
                assert_eq!(container["cpu_quota"], quota);
                assert!(container.get("cpus").is_none());
                // The pinned provider updates memory in place and omits CFS quota
                // from updates, so both limits force replacement through labels.
                assert_eq!(label(container, CPU_LABEL), Some(cpu.to_string().as_str()));
                assert_eq!(
                    label(container, MEMORY_LABEL),
                    Some(memory_gib.to_string().as_str())
                );
                assert_eq!(container["memory"], memory_gib * 1024);
                assert_eq!(container["memory_swap"], memory_gib * 1024);
                let spec: nemoclaw_sdk::managed::Spec =
                    serde_json::from_str(&target.values["spec"]).unwrap();
                let host = spec.container("/data").unwrap().host_config.unwrap();
                assert_eq!(host.cpu_period, Some(100_000));
                assert_eq!(host.cpu_quota, Some(quota));
                assert!(host.nano_cpus.is_none());
                assert_eq!(host.memory, Some(memory_gib * gib));
                assert_eq!(host.memory_swap, host.memory);
            }
        }
    }
}

#[test]
fn omitted_docker_model_limits_keep_independent_legacy_defaults() {
    for input in [
        include_str!("fixtures/config/spark.yaml"),
        include_str!("fixtures/config/managed-ollama.yaml"),
    ] {
        let baseline = Document::parse(input.as_bytes()).unwrap();
        let generations = ["managed_gateway", "inference_service", "ollama_service"]
            .map(|kind| (kind.into(), "b".repeat(32)))
            .into();
        let mut omitted = None;
        for (limits, cpu, memory_gib) in [
            (None, None, 104),
            (Some(json!({"sharedMemoryGiB":4})), None, 104),
            (Some(json!({"cpuLimitMillis":250})), Some(250), 104),
            (Some(json!({"memoryLimitGiB":48})), None, 48),
            (Some(json!({"memoryLimitGiB":104})), None, 104),
        ] {
            let mut value = serde_json::to_value(&baseline).unwrap();
            for service in value["spec"]["services"]
                .as_object_mut()
                .unwrap()
                .values_mut()
            {
                let object = service.as_object_mut().unwrap();
                object.remove("container");
                if let Some(limits) = &limits {
                    object.insert("container".into(), limits.clone());
                }
            }
            let document = Document::parse(value.to_string().as_bytes()).unwrap();
            let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
            let targets = runtime_targets(&document, &generations).unwrap();
            let services: Vec<_> = targets
                .iter()
                .filter(|target| {
                    matches!(target.kind.as_str(), "inference_service" | "ollama_service")
                })
                .collect();
            assert_eq!(services.len(), 1);
            let target = services[0];
            let (_, name) = target.address.split_once('.').unwrap();
            let container = &graph["resource"]["docker_container"][name];
            assert_eq!(container["memory"], memory_gib * 1024);
            assert_eq!(container["memory_swap"], container["memory"]);
            // Only a limit other than the 104 GiB default adds the replacement
            // label, so containers created before memory limits stay unchanged.
            if memory_gib == 104 {
                assert_eq!(label(container, MEMORY_LABEL), None);
                match &limits {
                    None => omitted = Some(graph.clone()),
                    Some(limits) if limits.get("memoryLimitGiB").is_some() => {
                        assert_eq!(Some(&graph), omitted.as_ref());
                    }
                    Some(_) => {}
                }
            } else {
                assert_eq!(
                    label(container, MEMORY_LABEL),
                    Some(memory_gib.to_string().as_str())
                );
            }
            let spec: nemoclaw_sdk::managed::Spec =
                serde_json::from_str(&target.values["spec"]).unwrap();
            let process = spec.process.as_ref().unwrap();
            assert_eq!(process.cpu_limit_millis, cpu);
            let host = spec.container("/data").unwrap().host_config.unwrap();
            assert_eq!(host.memory, Some(memory_gib * (1_i64 << 30)));
            assert_eq!(host.memory_swap, host.memory);
            if cpu.is_none() {
                assert!(container.get("cpu_period").is_none());
                assert!(container.get("cpu_quota").is_none());
                assert!(container.get("cpus").is_none());
                assert!(host.cpu_period.is_none());
                assert!(host.cpu_quota.is_none());
                assert!(host.nano_cpus.is_none());
                assert_eq!(label(container, CPU_LABEL), None);
                assert!(
                    serde_json::to_value(process)
                        .unwrap()
                        .get("cpu_limit_millis")
                        .is_none()
                );
            }
        }
    }
}

#[test]
fn docker_model_update_policy_does_not_change_runtime_resources() {
    for input in [
        include_str!("fixtures/config/spark.yaml"),
        include_str!("fixtures/config/managed-ollama.yaml"),
    ] {
        let document = Document::parse(input.as_bytes()).unwrap();
        let generations = ["managed_gateway", "inference_service", "ollama_service"]
            .map(|kind| (kind.into(), "b".repeat(32)))
            .into();
        let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
        let targets = runtime_targets(&document, &generations).unwrap();
        let mut updated = serde_json::to_value(document).unwrap();
        for service in updated["spec"]["services"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            service["updatePolicy"] = json!("Recreate");
        }
        let updated = Document::parse(updated.to_string().as_bytes()).unwrap();
        assert_eq!(
            compile_runtime(&updated, &generations, "0.1.0").unwrap(),
            graph
        );
        assert_eq!(runtime_targets(&updated, &generations).unwrap(), targets);
    }
}

#[test]
fn multiple_services_share_image_acquisition_without_custom_capacity_gates() {
    let document =
        Document::parse(include_bytes!("../../../examples/spark/two-models.yaml").as_slice())
            .unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "b".repeat(32)))
    .into();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert!(
        graph["data"].get("vllm_capacity").is_none()
            && graph["data"].get("ollama_capacity").is_none()
    );
    assert!(
        graph["data"].get("fabric_agent_readiness").is_none(),
        "the runtime graph cannot observe sandboxes owned by the deployment graph"
    );
    let readiness = &graph["data"]["openshell_gateway"]["current"];
    assert_eq!(readiness["wait_timeout_seconds"], 90);
    assert_eq!(readiness["required_compute_drivers"], json!(["docker"]));
    assert_eq!(
        readiness["depends_on"],
        json!([
            "docker_container.managed_gateway_runtime",
            "data.openshell_docker_gateway_readiness.current"
        ])
    );
    assert_eq!(
        readiness["lifecycle"]["postcondition"][0]["condition"],
        "${self.compatible}"
    );
    let containers = graph["resource"]["docker_container"].as_object().unwrap();
    let fast = &containers["inference_service_inference_fast"];
    let smart = &containers["inference_service_inference_smart"];
    let image = fast["image"].as_str().unwrap();
    assert_eq!(
        smart["image"], image,
        "services using the same image share acquisition"
    );
    let image_name = image
        .strip_prefix("${docker_image.")
        .unwrap()
        .strip_suffix(".image_id}")
        .unwrap();
    assert!(graph["resource"]["docker_image"].get(image_name).is_some());
    for attrs in [fast, smart] {
        assert!(attrs.get("lifecycle").is_none());
        assert_eq!(attrs["gpus"], "all");
        assert!(attrs["memory"].as_i64().unwrap() > 0);
        assert_eq!(attrs["memory"], attrs["memory_swap"]);
    }
}
#[test]
fn managed_graph_separates_retained_storage_from_replaceable_processes() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .into_iter()
    .map(|k| (k.into(), "b".repeat(32)))
    .collect();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    let targets = runtime_targets(&document, &generations).unwrap();
    for (kind, name) in [
        ("openshell_gateway_storage", "runtime"),
        ("docker_volume", "inference_storage_inference_qwen"),
    ] {
        assert_eq!(
            graph["resource"][kind][name]["lifecycle"]["prevent_destroy"],
            true
        );
    }
    assert_eq!(
        graph["resource"]["docker_container"]["managed_gateway_runtime"]["depends_on"],
        json!([
            "openshell_gateway_storage.runtime",
            "data.host_image.runtime_image_acquired_inference_service_inference_qwen"
        ])
    );
    let gateway = &graph["resource"]["docker_container"]["managed_gateway_runtime"];
    let gateway_spec = nemoclaw_sdk::managed::Spec::from_gateway_row(
        nemoclaw_sdk::managed::GATEWAY_STORAGE_KIND,
        &graph["resource"]["openshell_gateway_storage"]["runtime"]
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
            .collect(),
    )
    .unwrap();
    let launch = &graph["data"]["openshell_docker_gateway_runtime"]["managed_gateway_runtime"];
    assert_eq!(
        launch["data_path"],
        "${openshell_gateway_storage.runtime.data_path}"
    );
    let gateway_port = launch["endpoint"]
        .as_str()
        .unwrap()
        .rsplit_once(':')
        .unwrap()
        .1
        .parse::<u16>()
        .unwrap();
    assert!(gateway.get("network_mode").is_none());
    assert_eq!(
        gateway["networks_advanced"],
        json!([{
            "name": gateway_spec.network(),
            "ipv4_address": gateway_spec.gateway_address().unwrap()
        }])
    );
    assert_eq!(
        gateway["ports"],
        json!([{
            "internal": gateway_port,
            "external": gateway_port,
            "ip": "127.0.0.1",
            "protocol": "tcp"
        }])
    );
    assert_eq!(
        dependencies(&graph["resource"]["docker_container"]["inference_service_inference_qwen"]),
        BTreeSet::from([
            "docker_container.managed_gateway_runtime",
            "docker_volume.inference_storage_inference_qwen",
            "data.host_image.runtime_image_acquired_inference_service_inference_qwen"
        ])
    );
    for target in targets
        .into_iter()
        .filter(|target| target.address.starts_with("nemoclaw_"))
    {
        let attrs = &graph["resource"][format!("nemoclaw_{}", target.kind)]
            [target.address.split_once('.').unwrap().1];
        for (name, value) in &target.values {
            assert_eq!(attrs[name], json!(value), "{}.{name}", target.address);
        }
        assert!(
            attrs.get("running").is_none(),
            "running is observed, not declared readiness"
        );
    }
    assert_eq!(gateway_spec.layout, 1);
    assert!(
        graph["resource"]["openshell_gateway_storage"]["runtime"]
            .get("endpoint")
            .is_none(),
        "Docker gateway storage does not depend on the listen port"
    );
}

#[test]
fn remote_service_is_independent_of_the_external_sandbox_gateway() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let mut value = serde_json::to_value(document).unwrap();
    value["spec"]["gateway"] = json!({"management":"external","endpoint":"http://127.0.0.1:17670"});
    value["spec"]["gateway"]["runtime"]["provider"] = json!("podman");
    value["spec"]["services"]["qwen"]["placement"] =
        json!({"engine":"ssh://operator@gpu-box","networkCidr":"172.30.119.0/24"});
    value["spec"]["services"]["qwen"]["publication"] =
        json!({"endpoint":"http://10.0.0.8:18888/v1","bindAddress":"10.0.0.8"});
    let bytes = serde_json::to_vec(&value).unwrap();
    let document = Document::parse(bytes.as_slice()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox", "inference_service"]
        .into_iter()
        .map(|k| (k.into(), "b".repeat(32)))
        .collect();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert!(graph["resource"].get("openshell_podman_gateway").is_none());
    let container = &graph["resource"]["docker_container"]["inference_service_inference_qwen"];
    let (network_name, _) = graph["resource"]["docker_network"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, attrs)| attrs["name"] == container["network_mode"])
        .expect("the service must join its declared network");
    let network_address = format!("docker_network.{network_name}");
    assert_eq!(
        dependencies(container),
        BTreeSet::from([
            "docker_volume.inference_storage_inference_qwen",
            network_address.as_str(),
            "data.host_image.runtime_image_acquired_inference_service_inference_qwen",
        ])
    );
    assert_eq!(
        document.inference_endpoint().unwrap(),
        "http://10.0.0.8:18888/v1"
    );
    let mut changed_gateway = document.clone();
    *changed_gateway.spec.gateway.endpoint_mut() = "http://127.0.0.1:17999".into();
    let original_targets = runtime_targets(&document, &generations).unwrap();
    let changed_targets = runtime_targets(&changed_gateway, &generations).unwrap();
    let by_address = |targets: Vec<nemoclaw_sdk::compile::Target>| {
        targets
            .into_iter()
            .map(|target| (target.address, target.values))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    assert_eq!(
        by_address(original_targets),
        by_address(changed_targets),
        "gateway connection leaked into remote model identity"
    );

    let targets = runtime_targets(&document, &generations).unwrap();
    let service = targets
        .iter()
        .find(|target| target.address == "docker_container.inference_service_inference_qwen")
        .unwrap();
    let spec: nemoclaw_sdk::managed::Spec = serde_json::from_str(&service.values["spec"]).unwrap();
    assert_eq!(spec.engine(), "ssh://operator@gpu-box");
    let launch = serde_json::to_value(spec.container("/data").unwrap()).unwrap();
    assert!(
        launch["Env"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| !entry.as_str().unwrap().contains("ssh://"))
    );
    assert_eq!(
        launch["HostConfig"]["PortBindings"]["18888/tcp"][0]["HostIp"],
        "10.0.0.8"
    );
    for field in ["placement", "publication"] {
        let mut invalid = value.clone();
        invalid["spec"]["services"]["qwen"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(Document::parse(serde_json::to_vec(&invalid).unwrap().as_slice()).is_err());
    }
    for cidr in ["172.30.119.8/24", "10.0.0.0/24"] {
        let mut invalid = value.clone();
        invalid["spec"]["services"]["qwen"]["placement"]["networkCidr"] = json!(cidr);
        assert!(Document::parse(serde_json::to_vec(&invalid).unwrap().as_slice()).is_err());
    }
    let mut invalid = value.clone();
    invalid["spec"]["services"]["qwen"]["publication"]["bindAddress"] = json!("0.0.0.0");
    assert!(Document::parse(serde_json::to_vec(&invalid).unwrap().as_slice()).is_err());
}

#[test]
fn docker_provider_owns_disposable_compute_and_image_acquisition() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "b".repeat(32)))
    .into();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert!(
        graph["resource"]
            .get("nemoclaw_inference_service")
            .is_none()
    );
    let container = &graph["resource"]["docker_container"]["inference_service_inference_qwen"];
    assert_eq!(container["gpus"], "all");
    assert!(
        container["image"]
            .as_str()
            .unwrap()
            .starts_with("${docker_image.")
    );
    assert!(
        graph["data"].get("vllm_capacity").is_none()
            && graph["data"].get("ollama_capacity").is_none()
    );
    assert!(container.get("lifecycle").is_none());
    let targets = runtime_targets(&document, &generations).unwrap();
    assert!(targets.iter().any(|target| target.address
        == "docker_container.inference_service_inference_qwen"
        && target.kind == "inference_service"));
    assert!(targets.iter().any(|target| target.kind == "docker_image"));
}

#[test]
fn service_readiness_follows_provider_identity_and_is_fresh_on_unchanged_apply() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    let readiness = &graph["data"]["vllm_readiness"]["inference_service_inference_qwen"];
    assert_eq!(
        readiness["container_id"],
        "${docker_container.inference_service_inference_qwen.id}"
    );
    assert_eq!(readiness["read_trigger"], "${timestamp() != \"\"}");
    assert_eq!(
        readiness["contract"],
        "${data.vllm_runtime.inference_service_inference_qwen.spec}"
    );
    let container = &graph["resource"]["docker_container"]["inference_service_inference_qwen"];
    assert_eq!(readiness["name"], container["name"]);
    assert!(readiness["engine"].as_str().unwrap().starts_with("unix://"));
}

#[test]
fn gateway_readiness_observes_the_exact_docker_provider_container() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let generations = ["managed_gateway", "inference_service"]
        .map(|kind| (kind.into(), "b".repeat(32)))
        .into();
    let graph = compile_runtime(&document, &generations, "0.1.0").unwrap();
    let readiness = &graph["data"]["openshell_docker_gateway_readiness"]["current"];
    assert_eq!(
        readiness["container_id"],
        "${docker_container.managed_gateway_runtime.id}"
    );
    let capabilities = &graph["data"]["openshell_gateway"]["current"];
    assert!(
        capabilities.get("managed_spec").is_none() && capabilities.get("container_id").is_none()
    );
    let container = &graph["resource"]["docker_container"]["managed_gateway_runtime"];
    assert_eq!(readiness["name"], container["name"]);
    assert_eq!(readiness["wait_timeout_seconds"], 90);
    assert!(
        readiness["endpoint"]
            .as_str()
            .unwrap()
            .starts_with("http://127.0.0.1:")
    );
    assert_eq!(readiness["owner"], document.metadata.uid);
    let podman =
        Document::parse(include_bytes!("../../../examples/managed-podman.yaml").as_slice())
            .unwrap();
    let graph = compile_runtime(&podman, &generations, "0.1.0").unwrap();
    assert!(
        graph["data"]
            .get("openshell_docker_gateway_readiness")
            .is_none()
    );
}

#[test]
fn portable_container_memory_limits_cover_shared_memory_and_recipe_preparation_on_docker() {
    for source in [
        include_str!("../../../examples/spark/vllm.yaml"),
        include_str!("../../../examples/managed-ollama-gpu.yaml"),
        include_str!("../../../examples/spark/spark-inline.yaml"),
    ] {
        let mut input: Value = serde_saphyr::from_str(source).unwrap();
        input["spec"]["services"]["qwen"]["container"] =
            json!({"memoryLimitGiB": 7, "sharedMemoryGiB":8});
        assert!(
            Document::parse(input.to_string().as_bytes()).is_err(),
            "the explicit memory limit must cover private shared memory"
        );
        input["spec"]["services"]["qwen"]["container"]["memoryLimitGiB"] = json!(64);
        Document::parse(input.to_string().as_bytes()).unwrap();
        if input["spec"]["services"]["qwen"].get("recipe").is_some() {
            input["spec"]["services"]["qwen"]["container"]["memoryLimitGiB"] = json!(19);
            assert!(
                Document::parse(input.to_string().as_bytes()).is_err(),
                "the recipe's 20 GiB preparation requirement must fit the explicit container limit"
            );
            input["spec"]["services"]["qwen"]["container"]["memoryLimitGiB"] = json!(20);
            Document::parse(input.to_string().as_bytes()).unwrap();
        }
    }
}
