// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Common container, storage and credential lifecycle for managed inference.
use super::{
    container::{ServiceContainer, base},
    vllm::{SERVICE_KIND, STORAGE_KIND},
};
use crate::{
    Error,
    backend::Row,
    compile::Generations,
    config::{Document, ImagePullPolicy},
    managed::{Process, Spec},
    services::{
        contract::{InstallPlan, RemovePlan},
        placement::{PublishedPlacement, ResolvedPlacement},
    },
};
use std::collections::BTreeMap;

pub(super) fn address(kind: &str, name: &str) -> String {
    format!("{}.inference_{name}", crate::compile::resource_type(kind))
}

pub(super) struct Runtime<'a> {
    pub contract: nemoclaw_runtime::RuntimeSpec,
    pub container: Option<&'a ServiceContainer>,
    pub image: &'a str,
    pub placement: Option<PublishedPlacement<'a>>,
    pub architecture: String,
    pub labels: BTreeMap<String, String>,
    pub port: u16,
}

pub(super) fn specification(
    document: &Document,
    name: &str,
    generations: &Generations,
    runtime: Runtime<'_>,
) -> Result<Spec, Error> {
    let placed = ResolvedPlacement::resolve(
        runtime.placement,
        &document.spec.gateway,
        i64::from(runtime.port),
    )?;
    let process = base::managed_process(
        runtime.contract,
        runtime.container,
        Process {
            engine: placed.engine.clone(),
            image: runtime.image.into(),
            network_cidr: placed.network_cidr,
            create_network: placed.explicit,
            architecture: runtime.architecture,
            image_labels: runtime.labels,
            bind_address: placed.bind_address,
            port: runtime.port,
            ..Process::default()
        },
    )?;
    base::specification(
        document,
        generations,
        SERVICE_KIND,
        format!("{}-inference-{name}", document.workspace()),
        if placed.explicit {
            Default::default()
        } else {
            document.spec.gateway.managed()?.runtime_settings()
        },
        process,
    )
}

pub(super) fn install(
    spec: Spec,
    name: &str,
    authenticated: bool,
    inherits_gateway: bool,
    policy: Option<ImagePullPolicy>,
    values: Row,
) -> Result<InstallPlan, Error> {
    let mut preparation = InstallPlan::default();
    if authenticated {
        let credentials = address(STORAGE_KIND, &format!("{name}_auth"));
        preparation.targets.push(base::storage_target(
            &spec,
            STORAGE_KIND,
            credentials.clone(),
            format!("{}-auth", spec.name),
        )?);
        preparation
            .dependencies
            .insert(address(SERVICE_KIND, name), vec![credentials]);
    }
    if inherits_gateway {
        preparation
            .dependencies
            .entry(address(SERVICE_KIND, name))
            .or_default()
            .push("openshell_podman_gateway.runtime".into());
    }
    base::install(
        spec,
        &format!("inference_{name}"),
        STORAGE_KIND,
        policy,
        values,
        preparation,
    )
}

pub(super) fn remove(name: &str, authenticated: bool) -> RemovePlan {
    let mut plan = RemovePlan {
        retained: vec![crate::docker_compute::address(&address(STORAGE_KIND, name))],
        required_storage: Vec::new(),
    };
    if authenticated {
        let storage = address(STORAGE_KIND, &format!("{name}_auth"));
        plan.retained.insert(0, storage.clone());
        plan.required_storage
            .push((address(SERVICE_KIND, name), storage));
    }
    plan
}

pub(super) fn credential_source(spec: &Spec, endpoint: String) -> Result<Option<String>, Error> {
    Ok(Some(crate::services::authentication::source_json(
        &crate::services::authentication::Source::ManagedService {
            storage: base::storage(spec, format!("{}-auth", spec.name)),
            container: spec.name.clone(),
            endpoint,
        },
    )?))
}
