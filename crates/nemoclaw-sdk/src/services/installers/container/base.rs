// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Container base shared by image-owned applications and managed inference.
//! Callers supply launch settings, preparation resources, and retention policy;
//! the Docker compiler owns provider-specific resource emission.
use crate::{
    Error,
    backend::Row,
    compile::{Generations, Target},
    config::{ComputeDriver, Document, ImagePullPolicy, ManagedGateway},
    managed::{Process, Spec, Storage},
    services::contract::InstallPlan,
};

/// Managed kinds supply their runtime contract and image/placement, then use
/// the same process and resource assembly as explicit containers.
pub(crate) fn managed_process(
    runtime: nemoclaw_runtime::RuntimeSpec,
    limits: Option<&super::ServiceContainer>,
    process: Process,
) -> Result<Process, Error> {
    let resources = super::ServiceContainer::resources(limits);
    Ok(Process {
        configuration: serde_json::to_string(&runtime)
            .map_err(|_| Error::State("cannot encode managed runtime configuration"))?,
        entrypoint: vec![crate::managed::RUNTIME_ENTRYPOINT.into()],
        mount_target: crate::managed::RUNTIME_DATA_PATH.into(),
        shared_memory_bytes: resources.shared_memory_bytes,
        host_ipc: resources.host_ipc,
        cpu_limit_millis: resources.cpu_limit_millis,
        memory_bytes: resources.memory_bytes,
        gpu: true,
        gpu_device: resources.gpu_device,
        ..process
    })
}

pub(crate) fn specification(
    document: &Document,
    generations: &Generations,
    kind: &str,
    name: String,
    gateway: ManagedGateway,
    process: Process,
) -> Result<Spec, Error> {
    let generation = generations
        .get(kind)
        .filter(|generation| !generation.is_empty())
        .ok_or(Error::State("missing Docker service generation"))?;
    let spec = Spec {
        layout: 0,
        compute_driver: ComputeDriver::Docker,
        kind: kind.into(),
        name,
        owner: document.metadata.uid.clone(),
        generation: generation.clone(),
        gateway,
        image: String::new(),
        process: Some(process),
    };
    spec.validate()?;
    Ok(spec)
}

pub(crate) fn storage(spec: &Spec, name: String) -> Storage {
    Storage {
        name,
        owner: spec.owner.clone(),
        generation: spec.generation.clone(),
        engine: spec.engine().into(),
    }
}

pub(crate) fn storage_target(
    spec: &Spec,
    kind: &str,
    address: String,
    name: String,
) -> Result<Target, Error> {
    Ok(Target {
        kind: kind.into(),
        address,
        values: storage(spec, name).row()?,
    })
}

pub(crate) fn install(
    spec: Spec,
    name: &str,
    storage_kind: &str,
    policy: Option<ImagePullPolicy>,
    mut values: Row,
    mut preparation: InstallPlan,
) -> Result<InstallPlan, Error> {
    values.insert("spec".into(), spec.json()?);
    if let Some(policy) = policy {
        values.insert("image_pull_policy".into(), policy.as_str().into());
    }
    let address = format!("{}.{name}", crate::compile::resource_type(&spec.kind));
    let storage_address = format!("{}.{name}", crate::compile::resource_type(storage_kind));
    let storage = storage_target(&spec, storage_kind, storage_address.clone(), spec.volume())?;
    preparation
        .dependencies
        .entry(address.clone())
        .or_default()
        .insert(0, storage_address);
    let mut targets = vec![
        storage,
        Target {
            kind: spec.kind,
            address,
            values,
        },
    ];
    targets.extend(preparation.targets);
    Ok(InstallPlan {
        targets,
        ..preparation
    })
}
