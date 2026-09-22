// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Compile disposable service compute into standard Docker provider resources.
use crate::config::ComputeDriver;
use crate::{Error, backend::Row, compile::Target, config::ImagePullPolicy, managed::Spec};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(crate) const VERSION: &str = "4.6.0";
fn process(target: &Target) -> bool {
    (target.kind == crate::managed::GATEWAY_KIND
        && spec(target).is_ok_and(|spec| spec.compute_driver == ComputeDriver::Docker))
        || matches!(
            target.kind.as_str(),
            "inference_service" | "ollama_service" | "ollama_proxy" | "managed_service"
        )
}
pub(crate) fn address(logical: &str) -> String {
    for kind in [
        "inference_storage",
        "ollama_service_storage",
        "managed_service_storage",
    ] {
        if let Some(name) = logical.strip_prefix(&format!("nemoclaw_{kind}."))
            && !name.ends_with("_auth")
        {
            return format!("docker_volume.{kind}_{name}");
        }
    }
    for kind in [
        "inference_service",
        "ollama_service",
        "ollama_proxy",
        "managed_service",
        "managed_gateway",
    ] {
        if let Some(name) = logical.strip_prefix(&format!("nemoclaw_{kind}.")) {
            return format!("docker_container.{kind}_{name}");
        }
    }
    logical.into()
}
pub(crate) fn is_disposable(address: &str) -> bool {
    [
        "docker_container.",
        "docker_image.",
        "docker_network.",
        "docker_volume.",
    ]
    .iter()
    .any(|prefix| address.starts_with(prefix))
}
fn digest(engine: &str, name: &str) -> String {
    Sha256::digest(format!("{engine}\0{name}").as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn spec(target: &Target) -> Result<Spec, Error> {
    serde_json::from_str(
        target
            .values
            .get("spec")
            .ok_or(Error::State("missing runtime spec"))?,
    )
    .map_err(|_| Error::State("invalid runtime spec"))
}
fn image(target: &Target) -> Result<Target, Error> {
    let (engine, name, platform) = if target.kind == "ollama_proxy" {
        let spec = crate::services::installers::ollama::proxy::row_spec(&target.values)?;
        (
            target
                .values
                .get("engine")
                .ok_or(Error::State("missing proxy engine"))?
                .clone(),
            spec.image,
            None,
        )
    } else {
        let spec = spec(target)?;
        let platform = spec
            .process
            .as_ref()
            .map(|process| format!("linux/{}", process.architecture));
        (spec.engine().to_owned(), spec.image().to_owned(), platform)
    };
    let policy =
        ImagePullPolicy::from_row(&target.values)?.unwrap_or(ImagePullPolicy::IfNotPresent);
    let (kind, prefix) = match policy {
        ImagePullPolicy::Always => {
            return Err(Error::State(
                "Docker-managed services do not support imagePullPolicy Always",
            ));
        }
        ImagePullPolicy::Never => ("docker_image_data", "data.docker_image"),
        ImagePullPolicy::IfNotPresent => ("docker_image", "docker_image"),
    };
    let mut values = Row::from([
        ("engine".into(), engine.clone()),
        ("name".into(), name.clone()),
    ]);
    if let Some(platform) = platform {
        values.insert("platform".into(), platform);
    }
    Ok(Target {
        kind: kind.into(),
        address: format!("{prefix}.image_{}", digest(&engine, &name)),
        values,
    })
}
fn network(target: &Target) -> Result<Option<Target>, Error> {
    if matches!(target.kind.as_str(), "ollama_proxy" | "managed_gateway") {
        return Ok(None);
    }
    let spec = spec(target)?;
    if !spec
        .process
        .as_ref()
        .is_some_and(|process| process.create_network)
    {
        return Ok(None);
    }
    let name = spec.network();
    Ok(Some(Target {
        kind: "docker_network".into(),
        address: format!("docker_network.network_{}", digest(spec.engine(), &name)),
        values: Row::from([
            ("engine".into(), spec.engine().into()),
            ("name".into(), name),
            ("cidr".into(), spec.network_cidr().into()),
            ("owner".into(), spec.owner.clone()),
        ]),
    }))
}
pub(crate) fn targets(raw: &[Target]) -> Result<Vec<Target>, Error> {
    let mut result = raw.to_vec();
    for target in &mut result {
        if address(&target.address).starts_with("docker_volume.") {
            let storage: crate::managed::Storage = serde_json::from_str(&target.values["spec"])
                .map_err(|_| Error::State("invalid cache specification"))?;
            let retained = target.kind != "managed_service_storage";
            target.address = address(&target.address);
            target.kind = "docker_volume".into();
            target.values = Row::from([
                ("engine".into(), storage.engine),
                ("name".into(), storage.name),
                ("owner".into(), storage.owner),
                ("retained".into(), retained.to_string()),
            ]);
        }
    }
    let mut ancillary: BTreeMap<String, Target> = BTreeMap::new();
    let mut platforms = BTreeMap::new();
    for target in result.iter_mut().filter(|target| process(target)) {
        let image = image(target)?;
        if let Some(platform) = image.values.get("platform") {
            let key = (image.values["engine"].clone(), image.values["name"].clone());
            if platforms
                .insert(key, platform.clone())
                .is_some_and(|prior| prior != *platform)
            {
                return Err(Error::State("conflicting image target platforms"));
            }
        }
        if !ancillary
            .get(&image.address)
            .is_some_and(|prior| prior.values.contains_key("platform"))
        {
            ancillary.insert(image.address.clone(), image);
        }
        if let Some(network) = network(target)? {
            if ancillary
                .get(&network.address)
                .is_some_and(|prior| prior != &network)
            {
                return Err(Error::State("conflicting service network configuration"));
            }
            ancillary.insert(network.address.clone(), network);
        }
        target.address = address(&target.address);
    }
    result.extend(ancillary.into_values());
    Ok(result)
}
fn literal(value: &mut Value) {
    match value {
        Value::String(text) => *text = text.replace("${", "$${").replace("%{", "%%{"),
        Value::Array(values) => values.iter_mut().for_each(literal),
        Value::Object(values) => values.values_mut().for_each(literal),
        _ => {}
    }
}
fn rewrite(value: &mut Value, old: &str, new: &str) {
    match value {
        Value::String(text) if text == old => *text = new.into(),
        Value::Array(values) => values.iter_mut().for_each(|value| rewrite(value, old, new)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| rewrite(value, old, new)),
        _ => {}
    }
}
fn container(target: &Target) -> Result<Value, Error> {
    if target.kind == "ollama_proxy" {
        let spec = crate::services::installers::ollama::proxy::row_spec(&target.values)?;
        let environment = format!(
            "NEMOCLAW_OLLAMA_PROXY={}",
            serde_json::to_string(&spec.settings)
                .map_err(|_| Error::State("invalid proxy settings"))?
        );
        return Ok(
            json!({"name":spec.name,"labels":[{"label":crate::managed::OWNER_LABEL,"value":spec.owner}],"entrypoint":["python3","/opt/nemoclaw/ollama_proxy.py"],"command":[],"env":[environment],"network_mode":"host","mounts":[{"type":"volume","source":spec.volume(),"target":"/data"}],"capabilities":[{"drop":["ALL"]}],"security_opts":["no-new-privileges"],"restart":"no","memory":256,"memory_swap":256,"must_run":true,"wait":false,"remove_volumes":false,"destroy_grace_seconds":1}),
        );
    }
    let spec = spec(target)?;
    if target.kind == crate::managed::GATEWAY_KIND {
        let launch = spec.container("/NEMOCLAW_GATEWAY_DATA")?;
        let endpoint = url::Url::parse(&spec.gateway.endpoint)
            .map_err(|_| Error::State("invalid gateway endpoint"))?;
        let port = endpoint
            .port()
            .ok_or(Error::State("missing gateway port"))?;
        return Ok(
            json!({"name":spec.name,"user":"0:0","labels":[{"label":crate::managed::OWNER_LABEL,"value":spec.owner}],"entrypoint":launch.entrypoint,"command":launch.cmd,"env":launch.env,"networks_advanced":[{"name":spec.network(),"ipv4_address":spec.gateway_address()?}],"ports":[{"internal":port,"external":port,"ip":endpoint.host_str().ok_or(Error::State("missing gateway host"))?,"protocol":"tcp"}],"mounts":[{"type":"volume","source":spec.volume(),"target":"/NEMOCLAW_GATEWAY_DATA"},{"type":"bind","source":spec.gateway.engine.strip_prefix("unix://").ok_or(Error::State("gateway requires Unix engine"))?,"target":"/var/run/docker.sock"}],"capabilities":[{"drop":["ALL"]}],"security_opts":["no-new-privileges"],"restart":"no","log_driver":"json-file","log_opts":{"max-size":"32m","max-file":"3"},"must_run":true,"wait":false,"remove_volumes":false,"destroy_grace_seconds":60}),
        );
    }
    let process = spec
        .process
        .as_ref()
        .ok_or(Error::State("missing runtime process"))?;
    let launch = spec.container("/data")?;
    let mut attrs = json!({"name":spec.name,"labels":[{"label":crate::managed::OWNER_LABEL,"value":spec.owner}],"entrypoint":launch.entrypoint,"command":launch.cmd,"env":launch.env,"network_mode":spec.network(),"mounts":[{"type":"volume","source":spec.volume(),"target":process.mount_target}],"capabilities":[{"drop":["ALL"]}],"security_opts":["no-new-privileges"],"restart":"no","memory":process.memory_bytes/(1<<20),"memory_swap":process.memory_bytes/(1<<20),"shm_size":process.shared_memory_bytes/(1<<20),"ipc_mode":if process.host_ipc {"host"} else {"private"},"ulimit":[{"name":"memlock","soft":-1,"hard":-1},{"name":"stack","soft":67108864,"hard":67108864}],"ports":[{"internal":process.port,"external":process.port,"ip":process.bind_address,"protocol":"tcp"}],"log_driver":"json-file","log_opts":{"max-size":"32m","max-file":"3"},"must_run":true,"wait":false,"remove_volumes":false,"destroy_grace_seconds":60});
    if target.kind == "inference_service"
        && crate::services::installers::vllm::configured_service(&spec)?
            .authentication
            .is_some()
    {
        attrs["mounts"].as_array_mut().unwrap().push(
            json!({"type":"volume","source":format!("{}-auth",spec.name),"target":"/credentials"}),
        );
    }
    if process.gpu {
        attrs["gpus"] = json!("all");
    }
    Ok(attrs)
}
pub(crate) fn configure(graph: &mut Value, raw: &[Target]) -> Result<(), Error> {
    let mut providers = BTreeMap::new();
    for target in targets(raw)?.iter().filter(|target| {
        matches!(
            target.kind.as_str(),
            "docker_network" | "docker_image" | "docker_image_data" | "docker_volume"
        )
    }) {
        let engine = &target.values["engine"];
        let alias = format!("engine_{}", digest(engine, ""));
        providers.insert(alias.clone(), engine.clone());
        let mut attrs = match target.kind.as_str() {
            "docker_volume" => {
                let mut value = json!({"name":target.values["name"],"driver":"local","labels":[{"label":crate::managed::OWNER_LABEL,"value":target.values["owner"]}]});
                if target
                    .values
                    .get("retained")
                    .is_none_or(|retained| retained == "true")
                {
                    value["lifecycle"] = json!({"prevent_destroy":true});
                }
                value
            }
            "docker_network" => {
                json!({"name":target.values["name"],"labels":[{"label":crate::managed::OWNER_LABEL,"value":target.values["owner"]}],"driver":"bridge","ipam_config":[{"subnet":target.values["cidr"],"gateway":crate::config::bridge_address(&target.values["cidr"])?}]})
            }
            "docker_image" => json!({"name":target.values["name"],"keep_locally":true}),
            _ => json!({"name":target.values["name"]}),
        };
        if target.kind == "docker_image"
            && let Some(platform) = target.values.get("platform")
        {
            attrs["platform"] = json!(platform);
        }
        literal(&mut attrs);
        attrs["provider"] = json!(format!("docker.{alias}"));
        let (section, address) = if let Some(address) = target.address.strip_prefix("data.") {
            ("data", address)
        } else {
            ("resource", target.address.as_str())
        };
        let (kind, name) = address
            .split_once('.')
            .ok_or(Error::State("invalid Docker resource address"))?;
        graph[section][kind][name] = attrs;
    }
    for target in raw
        .iter()
        .filter(|target| address(&target.address).starts_with("docker_volume."))
    {
        let (kind, name) = target.address.split_once('.').unwrap();
        graph["resource"][kind]
            .as_object_mut()
            .unwrap()
            .remove(name);
        if graph["resource"][kind].as_object().unwrap().is_empty() {
            graph["resource"].as_object_mut().unwrap().remove(kind);
        }
        rewrite(graph, &target.address, &address(&target.address));
    }
    for target in raw.iter().filter(|target| process(target)) {
        let (kind, name) = target
            .address
            .split_once('.')
            .ok_or(Error::State("invalid service address"))?;
        let old = graph["resource"][kind]
            .as_object_mut()
            .and_then(|resources| resources.remove(name))
            .ok_or(Error::State("missing service resource"))?;
        let mut attrs = container(target)?;
        literal(&mut attrs);
        if target.kind == crate::managed::GATEWAY_KIND {
            fn storage_path(value: &mut Value) {
                match value {
                    Value::String(text) => {
                        *text = text.replace(
                            "/NEMOCLAW_GATEWAY_DATA",
                            "${nemoclaw_gateway_storage.runtime.data_path}",
                        )
                    }
                    Value::Array(items) => items.iter_mut().for_each(storage_path),
                    Value::Object(items) => items.values_mut().for_each(storage_path),
                    _ => {}
                }
            }
            storage_path(&mut attrs);
        }
        if matches!(
            target.kind.as_str(),
            "inference_service" | "ollama_service" | "managed_service"
        ) {
            let cache_kind = if target.kind == "inference_service" {
                "inference_storage"
            } else if target.kind == "managed_service" {
                "managed_service_storage"
            } else {
                "ollama_service_storage"
            };
            let name = target.address.split_once('.').unwrap().1;
            attrs["mounts"][0]["source"] =
                json!(format!("${{docker_volume.{cache_kind}_{name}.name}}"));
        }
        let image = image(target)?;
        if target.kind == crate::managed::GATEWAY_KIND {
            graph["resource"]["nemoclaw_gateway_storage"]["runtime"]["depends_on"] =
                json!([image.address]);
        }
        let attribute = if image.kind == "docker_image_data" {
            "id"
        } else {
            "image_id"
        };
        attrs["image"] = json!(format!("${{{}.{attribute}}}", image.address));
        attrs["provider"] = json!(format!(
            "docker.engine_{}",
            digest(&image.values["engine"], "")
        ));
        let mut dependencies = old["depends_on"].as_array().cloned().unwrap_or_default();
        if let Some(network) = network(target)? {
            dependencies.push(json!(network.address));
        }
        attrs["depends_on"] = json!(dependencies);
        if let Some(preconditions) = old
            .get("lifecycle")
            .and_then(|lifecycle| lifecycle.get("precondition"))
        {
            attrs["lifecycle"] = json!({"precondition":preconditions});
        }
        let physical = address(&target.address);
        graph["resource"]["docker_container"][physical.split_once('.').unwrap().1] = attrs;
        rewrite(graph, &target.address, &physical);
        if graph["resource"][kind]
            .as_object()
            .is_some_and(|resources| resources.is_empty())
        {
            graph["resource"].as_object_mut().unwrap().remove(kind);
        }
    }
    if !providers.is_empty() {
        graph["terraform"]["required_providers"]["docker"] = json!({"source":"registry.opentofu.org/kreuzwerker/docker","version":format!("= {VERSION}")});
        graph["provider"]["docker"] = json!(
            providers
                .into_iter()
                .map(|(alias, host)| {
                    let mut value = json!({"alias":alias,"host":host});
                    literal(&mut value);
                    value
                })
                .collect::<Vec<_>>()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        compile::{Generations, runtime_graph},
        config::Document,
    };
    #[test]
    fn model_caches_use_native_volume_recovery_with_explicit_retention() {
        let document =
            Document::parse(include_bytes!("../tests/fixtures/config/spark.yaml").as_slice())
                .unwrap();
        let generations = crate::state::Record::new(document.clone())
            .unwrap()
            .generations;
        let graph = crate::compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
        let cache = &graph["resource"]["docker_volume"]["inference_storage_inference_qwen"];
        assert!(cache["name"].as_str().unwrap().ends_with("-data"));
        assert_eq!(cache["lifecycle"]["prevent_destroy"], true);
        assert!(graph["resource"]["nemoclaw_inference_storage"].is_null());
        let mounts =
            &graph["resource"]["docker_container"]["inference_service_inference_qwen"]["mounts"];
        assert_eq!(
            mounts[0]["source"],
            "${docker_volume.inference_storage_inference_qwen.name}"
        );
        assert!(is_disposable(
            "docker_volume.inference_storage_inference_qwen"
        ));
    }
    #[test]
    fn authenticated_service_separates_cache_and_credential_mounts() {
        let mut value: Value =
            serde_saphyr::from_str(include_str!("../tests/fixtures/config/spark.yaml")).unwrap();
        value["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        let generations = crate::state::Record::new(document.clone())
            .unwrap()
            .generations;
        let graph = crate::compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
        let mounts =
            graph["resource"]["docker_container"]["inference_service_inference_qwen"]["mounts"]
                .as_array()
                .unwrap();
        assert_eq!(mounts.len(), 2);
        assert_eq!(mounts[0]["target"], "/data");
        assert_eq!(mounts[1]["target"], "/credentials");
        assert_ne!(mounts[0]["source"], mounts[1]["source"]);
        let auth = &graph["resource"]["nemoclaw_inference_storage"]["inference_qwen_auth"];
        let spec: crate::managed::Storage =
            serde_json::from_str(auth["spec"].as_str().unwrap()).unwrap();
        assert!(spec.name.ends_with("-auth"));
        assert_eq!(auth["lifecycle"]["prevent_destroy"], true);
    }
    #[test]
    fn docker_gateway_uses_retained_storage_outputs_and_native_compute() {
        let document =
            Document::parse(include_bytes!("../tests/fixtures/config/spark.yaml").as_slice())
                .unwrap();
        let generations = crate::state::Record::new(document.clone())
            .unwrap()
            .generations;
        let graph = crate::compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
        let gateway = &graph["resource"]["docker_container"]["managed_gateway_runtime"];
        let storage: Spec = serde_json::from_str(
            graph["resource"]["nemoclaw_gateway_storage"]["runtime"]["spec"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let command = gateway["command"].as_array().unwrap();
        let gateway_port = command.windows(2).find(|pair| pair[0] == "--port").unwrap()[1]
            .as_str()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        assert!(gateway.get("network_mode").is_none());
        assert_eq!(
            gateway["networks_advanced"],
            json!([{"name":storage.network(),"ipv4_address":storage.gateway_address().unwrap()}])
        );
        assert_eq!(
            gateway["ports"],
            json!([{"internal":gateway_port,"external":gateway_port,"ip":"127.0.0.1","protocol":"tcp"}])
        );
        assert_eq!(gateway["user"], "0:0");
        assert_eq!(
            gateway["mounts"][0]["target"],
            "${nemoclaw_gateway_storage.runtime.data_path}"
        );
        assert_eq!(gateway["mounts"][1]["target"], "/var/run/docker.sock");
        assert_eq!(gateway["wait"], false);
        assert_eq!(gateway["restart"], "no");
        assert_eq!(
            gateway["depends_on"],
            json!(["nemoclaw_gateway_storage.runtime"])
        );
        assert!(graph["resource"]["nemoclaw_managed_gateway"].is_null());
        assert_eq!(storage.layout, 1);
        assert!(
            graph["resource"]["docker_network"].is_null(),
            "gateway bridge remains durable"
        );
        let mut changed = document.clone();
        *changed.spec.gateway.endpoint_mut() = "http://127.0.0.1:17682".into();
        let updated = crate::compile::compile_runtime(&changed, &generations, "0.1.0").unwrap();
        assert_eq!(
            updated["resource"]["nemoclaw_gateway_storage"],
            graph["resource"]["nemoclaw_gateway_storage"]
        );
    }
    #[test]
    fn podman_gateway_keeps_its_native_lifecycle_and_image_policy() {
        let source =
            Document::parse(include_bytes!("../tests/fixtures/config/spark.yaml").as_slice())
                .unwrap();
        let mut document =
            Document::parse(include_bytes!("../tests/fixtures/config/local.yaml").as_slice())
                .unwrap();
        document.spec.gateway = source.spec.gateway;
        document
            .spec
            .gateway
            .as_managed_mut()
            .unwrap()
            .image_pull_policy = Some(ImagePullPolicy::Always);
        document.spec.sandboxes[0].runtime.provider = ComputeDriver::Podman;
        let generations = crate::state::Record::new(document.clone())
            .unwrap()
            .generations;
        let graph = crate::compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
        assert!(graph["resource"]["docker_container"].is_null());
        assert_eq!(
            graph["data"]["nemoclaw_gateway_capabilities"]["current"]["depends_on"],
            json!(["nemoclaw_managed_gateway.runtime"])
        );
        assert_eq!(
            graph["resource"]["nemoclaw_managed_gateway"]["runtime"]["image_pull_policy"],
            "Always"
        );
        let storage: Spec = serde_json::from_str(
            graph["resource"]["nemoclaw_gateway_storage"]["runtime"]["spec"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(storage.layout, 0);
    }
    #[test]
    fn delegated_compute_uses_provider_identity_and_preserves_retained_storage() {
        let document =
            Document::parse(include_bytes!("../tests/fixtures/config/spark.yaml").as_slice())
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
        let (mut graph, mut raw) = runtime_graph(&document, &generations, "0.1.0").unwrap();
        for target in raw
            .iter_mut()
            .filter(|target| target.kind == "inference_service")
        {
            target
                .values
                .insert("image_pull_policy".into(), "Never".into());
        }
        // Capacity gating is removed by the compiler activation; it is not a
        // Docker-provider responsibility.
        graph.as_object_mut().unwrap().remove("data");
        for service in graph["resource"]["nemoclaw_inference_service"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            service.as_object_mut().unwrap().remove("lifecycle");
        }
        configure(&mut graph, &raw).unwrap();
        let container = &graph["resource"]["docker_container"]["inference_service_inference_qwen"];
        assert_eq!(container["gpus"], "all");
        assert_eq!(container["must_run"], true);
        assert!(
            container["image"]
                .as_str()
                .unwrap()
                .starts_with("${data.docker_image.")
        );
        assert_eq!(
            container["labels"],
            json!([{ "label":crate::managed::OWNER_LABEL,"value":document.metadata.uid }])
        );
        assert!(container.get("lifecycle").is_none());
        assert_eq!(
            graph["resource"]["docker_volume"]["inference_storage_inference_qwen"]["lifecycle"]["prevent_destroy"],
            true
        );
        let compiled = targets(&raw).unwrap();
        assert!(compiled.iter().any(|target| target.address
            == "docker_container.inference_service_inference_qwen"
            && target.kind == "inference_service"));
        assert!(
            compiled
                .iter()
                .any(|target| target.kind == "docker_image_data")
        );
        assert!(is_disposable(
            "docker_container.inference_service_inference_qwen"
        ));
        assert!(!is_disposable("nemoclaw_inference_storage.inference_qwen"));
    }
    #[test]
    fn omitted_image_policy_uses_provider_acquisition_and_never_only_reads_local_images() {
        let document =
            Document::parse(include_bytes!("../tests/fixtures/config/spark.yaml").as_slice())
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
        let (_, raw) = runtime_graph(&document, &generations, "0.1.0").unwrap();
        let mut service = raw
            .into_iter()
            .find(|target| target.kind == "inference_service")
            .unwrap();
        service.values.remove("image_pull_policy");
        assert_eq!(image(&service).unwrap().kind, "docker_image");
        service
            .values
            .insert("image_pull_policy".into(), "Never".into());
        assert_eq!(image(&service).unwrap().kind, "docker_image_data");
    }
    #[test]
    fn generic_managed_service_compiles_to_disposable_docker_resources() {
        let document =
            Document::parse(include_bytes!("../tests/fixtures/config/spark.yaml").as_slice())
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
        let (_, raw) = runtime_graph(&document, &generations, "0.1.0").unwrap();
        let source = raw
            .iter()
            .find(|target| target.kind == "inference_service")
            .unwrap();
        let mut spec = spec(source).unwrap();
        spec.kind = "managed_service".into();
        spec.name = format!("{}-voice-server", document.workspace());
        let process = spec.process.as_mut().unwrap();
        process.image = format!("sha256:{}", "a".repeat(64));
        process.configuration = "{}".into();
        process.entrypoint = vec!["/usr/local/bin/service-runtime".into()];
        process.command = vec!["serve".into()];
        process.mount_target = "/var/lib/service".into();
        process.gpu = false;
        process.host_ipc = false;
        process.shared_memory_bytes = 0;

        let storage = crate::managed::Storage {
            name: format!("{}-data", spec.name),
            owner: spec.owner.clone(),
            generation: spec.generation.clone(),
            engine: spec.engine().into(),
        };
        let service = Target {
            kind: "managed_service".into(),
            address: "nemoclaw_managed_service.voice-server".into(),
            values: Row::from([
                ("spec".into(), spec.json().unwrap()),
                ("image_pull_policy".into(), "Never".into()),
            ]),
        };
        let storage = Target {
            kind: "managed_service_storage".into(),
            address: "nemoclaw_managed_service_storage.voice-server".into(),
            values: Row::from([("spec".into(), storage.json().unwrap())]),
        };
        let raw = vec![storage, service];
        let compiled = targets(&raw).unwrap();
        assert!(compiled.iter().any(|target| {
            target.address == "docker_container.managed_service_voice-server"
                && target.kind == "managed_service"
        }));
        assert!(compiled.iter().any(|target| {
            target.address == "docker_volume.managed_service_storage_voice-server"
                && target.kind == "docker_volume"
        }));
        assert!(compiled.iter().any(|target| {
            target.address.starts_with("data.docker_image.")
                && target.values["name"].starts_with("sha256:")
        }));

        let mut graph = json!({
            "terraform":{"required_providers":{}},
            "provider":{},
            "resource":{
                "nemoclaw_managed_service":{
                    "voice-server":{"spec":raw[1].values["spec"],"depends_on":["nemoclaw_managed_service_storage.voice-server"]}
                },
                "nemoclaw_managed_service_storage":{
                    "voice-server":{"spec":raw[0].values["spec"]}
                }
            }
        });
        configure(&mut graph, &raw).unwrap();
        let container = &graph["resource"]["docker_container"]["managed_service_voice-server"];
        assert!(container["image"].as_str().unwrap().ends_with(".id}"));
        assert_eq!(container["ipc_mode"], "private");
        assert_eq!(container["env"], json!([]));
        assert!(container.get("gpus").is_none());
        assert_eq!(
            container["mounts"][0]["source"],
            "${docker_volume.managed_service_storage_voice-server.name}"
        );
        assert!(
            graph["resource"]["docker_volume"]["managed_service_storage_voice-server"]
                .get("lifecycle")
                .is_none()
        );
    }
    #[test]
    fn shared_image_rejects_incompatible_target_architectures() {
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
        let (_, mut raw) = runtime_graph(&document, &generations, "0.1.0").unwrap();
        let service = raw
            .iter_mut()
            .find(|target| target.kind == "inference_service")
            .unwrap();
        let mut spec = spec(service).unwrap();
        spec.process.as_mut().unwrap().architecture = "amd64".into();
        service
            .values
            .insert("spec".into(), serde_json::to_string(&spec).unwrap());
        assert!(matches!(
            targets(&raw),
            Err(Error::State("conflicting image target platforms"))
        ));
    }
    #[test]
    fn remote_network_and_pulled_images_are_shared_by_engine_and_digest() {
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
        let (mut graph, mut raw) = runtime_graph(&document, &generations, "0.1.0").unwrap();
        raw.retain(|target| target.kind != crate::managed::GATEWAY_KIND);
        for target in raw
            .iter_mut()
            .filter(|target| target.kind == "inference_service")
        {
            target
                .values
                .insert("image_pull_policy".into(), "IfNotPresent".into());
            let mut spec = spec(target).unwrap();
            let process = spec.process.as_mut().unwrap();
            process.engine = "ssh://gpu-box".into();
            process.create_network = true;
            target
                .values
                .insert("spec".into(), serde_json::to_string(&spec).unwrap());
        }
        let compiled = targets(&raw).unwrap();
        assert_eq!(
            compiled
                .iter()
                .filter(|target| target.kind == "docker_network")
                .count(),
            1
        );
        assert_eq!(
            compiled
                .iter()
                .filter(|target| target.kind == "docker_image")
                .count(),
            1
        );
        configure(&mut graph, &raw).unwrap();
        let image = graph["resource"]["docker_image"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap();
        assert_eq!(image["keep_locally"], true);
        assert_eq!(image["platform"], "linux/arm64");
        let network = graph["resource"]["docker_network"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap();
        assert!(network.get("lifecycle").is_none());
        assert_eq!(
            network["labels"],
            json!([{ "label":crate::managed::OWNER_LABEL,"value":document.metadata.uid }])
        );
        for container in graph["resource"]["docker_container"]
            .as_object()
            .unwrap()
            .values()
        {
            assert!(container["image"].as_str().unwrap().ends_with(".image_id}"));
            assert!(
                container["depends_on"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|value| value.as_str().unwrap().starts_with("docker_network."))
            );
        }
    }
}

#[cfg(all(test, unix))]
#[path = "docker_compute_live_tests.rs"]
mod live_tests;
