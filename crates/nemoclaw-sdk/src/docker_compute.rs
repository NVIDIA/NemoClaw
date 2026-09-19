// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Compile disposable service compute into standard Docker provider resources.
use crate::{Error, backend::Row, compile::Target, config::ImagePullPolicy, managed::Spec};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(crate) const VERSION: &str = "4.6.0";
fn process(kind: &str) -> bool {
    matches!(
        kind,
        "inference_service" | "ollama_service" | "ollama_proxy"
    )
}
pub(crate) fn address(logical: &str) -> String {
    for kind in ["inference_service", "ollama_service", "ollama_proxy"] {
        if let Some(name) = logical.strip_prefix(&format!("nemoclaw_{kind}.")) {
            return format!("docker_container.{kind}_{name}");
        }
    }
    logical.into()
}
pub(crate) fn is_disposable(address: &str) -> bool {
    ["docker_container.", "docker_image.", "docker_network."]
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
        let process = spec
            .process
            .as_ref()
            .ok_or(Error::State("missing runtime process"))?;
        (
            spec.engine().to_owned(),
            spec.image().to_owned(),
            Some(format!("linux/{}", process.architecture)),
        )
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
    if target.kind == "ollama_proxy" {
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
    let mut ancillary: BTreeMap<String, Target> = BTreeMap::new();
    let mut platforms = BTreeMap::new();
    for target in result.iter_mut().filter(|target| process(&target.kind)) {
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
        let launch = spec.container()?;
        return Ok(
            json!({"name":spec.name,"labels":[{"label":crate::managed::OWNER_LABEL,"value":spec.owner}],"entrypoint":launch.entrypoint,"command":[],"env":launch.env,"network_mode":"host","mounts":[{"type":"volume","source":spec.volume(),"target":"/data"}],"capabilities":[{"drop":["ALL"]}],"security_opts":["no-new-privileges"],"restart":"no","memory":256,"memory_swap":256,"must_run":true,"wait":false,"remove_volumes":false,"destroy_grace_seconds":1}),
        );
    }
    let spec = spec(target)?;
    let process = spec
        .process
        .as_ref()
        .ok_or(Error::State("missing runtime process"))?;
    let launch = spec.container("/data")?;
    let mut attrs = json!({"name":spec.name,"labels":[{"label":crate::managed::OWNER_LABEL,"value":spec.owner}],"entrypoint":launch.entrypoint,"command":launch.cmd,"env":launch.env,"network_mode":spec.network(),"mounts":[{"type":"volume","source":spec.volume(),"target":process.mount_target}],"capabilities":[{"drop":["ALL"]}],"security_opts":["no-new-privileges"],"restart":"no","memory":process.memory_bytes/(1<<20),"memory_swap":process.memory_bytes/(1<<20),"shm_size":process.shared_memory_bytes/(1<<20),"ipc_mode":if process.host_ipc {"host"} else {"private"},"ulimit":[{"name":"memlock","soft":-1,"hard":-1},{"name":"stack","soft":67108864,"hard":67108864}],"ports":[{"internal":process.port,"external":process.port,"ip":process.bind_address,"protocol":"tcp"}],"log_driver":"json-file","log_opts":{"max-size":"32m","max-file":"3"},"must_run":true,"wait":false,"remove_volumes":false,"destroy_grace_seconds":60});
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
            "docker_network" | "docker_image" | "docker_image_data"
        )
    }) {
        let engine = &target.values["engine"];
        let alias = format!("engine_{}", digest(engine, ""));
        providers.insert(alias.clone(), engine.clone());
        let mut attrs = match target.kind.as_str() {
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
    for target in raw.iter().filter(|target| process(&target.kind)) {
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
        let image = image(target)?;
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
            graph["resource"]["nemoclaw_inference_storage"]["inference_qwen"]["lifecycle"]["prevent_destroy"],
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
