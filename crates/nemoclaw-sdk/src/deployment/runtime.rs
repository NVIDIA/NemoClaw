// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod helm_recovery;
mod teardown;
#[cfg(all(test, unix))]
pub(super) mod tests;

pub(super) use super::plan::check_plan as check_runtime_plan;
use super::*;
use crate::managed::{GATEWAY_KIND, Spec};
const GATEWAY_STORAGE: &str = "nemoclaw_gateway_storage.runtime";
const KUBERNETES_STORAGE: &str = "nemoclaw_kubernetes_storage.runtime";
const KUBERNETES_AUTH: &str = "nemoclaw_kubernetes_auth.runtime";

pub(super) fn validate_bound_sandboxes(
    record: &Record,
    document: &Document,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    let error = match record.validate_bound_sandboxes(document, bindings) {
        Err(error @ Error::SandboxChangeRefused { .. }) => error,
        result => return result,
    };
    let Error::SandboxChangeRefused { sandbox, .. } = &error else {
        unreachable!()
    };
    let prior = record.document.sandbox(sandbox)?;
    // These bindings come from the main OpenShell state. Runtime resources
    // live in a separate store, so compare retained and proposed intent here;
    // runtime reconciliation still owns live binding and identity checks.
    let previous = compile::runtime_targets(&record.document, &record.generations)?;
    let targets = compile::runtime_targets(document, &record.generations)?;
    for route in &record.document.sandbox_inference(prior)?.routes {
        let provider = record.document.sandbox_route_provider(prior, route)?;
        let Some(name) = provider.service_ref.as_deref() else {
            continue;
        };
        let address = format!("nemoclaw_kubernetes_service.{name}");
        let (Some(previous), Some(target)) = (
            previous.iter().find(|target| target.address == address),
            targets.iter().find(|target| target.address == address),
        ) else {
            continue;
        };
        let bound = crate::kubernetes::services::Spec::decode(&previous.values["spec"])?;
        let want = crate::kubernetes::services::Spec::decode(&target.values["spec"])?;
        if bound.storage() == want.storage() && bound.port() != want.port() {
            return Err(crate::ObservationError::Backend(
                "changing the model serving port requires whole-deployment destroy and apply; destroy deletes sandbox files and conversation history but retains model and credential PVCs",
            ).into());
        }
    }
    Err(error)
}

fn kubernetes_binding(
    target: &Target,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    let Some(binding) = bindings.get(&target.address) else {
        return Ok(());
    };
    if matches!(
        target.kind.as_str(),
        crate::kubernetes::services::SERVICE_KIND | crate::kubernetes::services::STORAGE_KIND
    ) {
        let model_storage = target.address.replace(
            "nemoclaw_kubernetes_service.",
            "nemoclaw_kubernetes_service_storage.",
        );
        if !bindings.contains_key(KUBERNETES_STORAGE)
            || (target.kind == crate::kubernetes::services::SERVICE_KIND
                && (!bindings.contains_key(&model_storage)
                    || !bindings.contains_key("nemoclaw_kubernetes_gateway.runtime")))
        {
            return Err(Error::Conflict(
                "cluster inference requires its independent storage and gateway bindings",
            ));
        }
    }
    let helm = crate::kubernetes::gateway::ADDRESS;
    let prerequisites: &[&str] = match target.kind.as_str() {
        crate::kubernetes::AUTH_KIND => &[KUBERNETES_STORAGE],
        "helm_release" => &[KUBERNETES_STORAGE, KUBERNETES_AUTH],
        crate::kubernetes::GATEWAY_KIND => &[KUBERNETES_STORAGE, KUBERNETES_AUTH, helm],
        _ => &[],
    };
    if prerequisites
        .iter()
        .any(|address| !bindings.contains_key(*address))
    {
        return Err(Error::Conflict(
            "Kubernetes runtime requires its independent prerequisite bindings; retain the original bundle and state for recovery",
        ));
    }
    if target.address == helm
        && (binding.id != target.values["name"]
            || binding.name != target.values["name"]
            || binding.namespace != target.values["namespace"]
            || binding.chart != target.values["chart"]
            || !binding.spec.is_empty()
            || !binding.deposed.is_empty())
    {
        return Err(Error::Conflict(
            "bound Helm release differs from retained intent",
        ));
    }
    Ok(())
}
fn bound_spec(kind: &str, want: &Spec, binding: Option<&StateBinding>) -> Result<Spec, Error> {
    let Some(binding) = binding else {
        return Ok(want.clone());
    };
    let mut bound = binding.typed_values();
    bound.insert("spec".into(), binding.spec.clone());
    let old = Spec::from_values(kind, &bound)
        .map_err(|_| Error::Conflict("bound runtime specification is incomplete"))?;
    if old.kind != want.kind
        || old.name != want.name
        || old.owner != want.owner
        || old.generation != want.generation
        || old.engine() != want.engine()
    {
        return Err(Error::Conflict(
            "bound runtime identity differs from retained intent",
        ));
    }
    Ok(old)
}
fn bound_cluster_spec(
    want: &crate::kubernetes::services::Spec,
    binding: Option<&StateBinding>,
) -> Result<crate::kubernetes::services::Spec, Error> {
    let Some(binding) = binding else {
        return Ok(want.clone());
    };
    let old = crate::kubernetes::services::Spec::decode(&binding.spec)?;
    if old.storage() != want.storage() {
        return Err(Error::Conflict(
            "cluster inference storage identity differs from retained intent",
        ));
    }
    Ok(old)
}
struct RuntimeValidation {
    expected: BTreeMap<String, Row>,
    gateway_running: bool,
}
// Binding validation is local. Live identity and running state come from the
// provider refresh in the saved plan, never from a separate SDK preflight.
fn runtime_bindings(
    targets: &[Target],
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<BTreeMap<String, Row>, Error> {
    let mut expected = allowed(targets);
    if bindings.keys().any(|key| {
        !expected.contains_key(key) && (!plan::disposable(key) || key.starts_with("docker_volume."))
    }) {
        return Err(Error::Conflict("apply cannot remove a managed runtime"));
    }
    for target in targets {
        kubernetes_binding(target, bindings)?;
        if target.kind == crate::kubernetes::services::SERVICE_KIND {
            let want = crate::kubernetes::services::Spec::decode(&target.values["spec"])?;
            expected.get_mut(&target.address).unwrap().insert(
                "spec".into(),
                bound_cluster_spec(&want, bindings.get(&target.address))?.encode()?,
            );
            continue;
        }
        if target.address == crate::kubernetes::gateway::ADDRESS {
            continue;
        }
        if target.kind == GATEWAY_KIND
            && bindings.contains_key(&target.address)
            && !bindings.contains_key(GATEWAY_STORAGE)
        {
            return Err(Error::Conflict(
                "gateway compute requires its retained storage binding",
            ));
        }
        if plan::disposable(&target.address) || target.address.starts_with("data.") {
            continue;
        }
        if target.kind == GATEWAY_KIND
            || crate::services::resource_behavior(&target.kind).runtime_process
        {
            let want = Spec::from_values(&target.kind, &target.values)
                .map_err(|_| Error::State("invalid compiled runtime"))?;
            let old = bound_spec(&target.kind, &want, bindings.get(&target.address))?;
            old.write_values(&target.kind, expected.get_mut(&target.address).unwrap())?;
        } else if bindings
            .get(&target.address)
            .is_some_and(|binding| binding.differs(&target.values))
        {
            return Err(Error::Conflict(
                "bound storage specification differs from retained intent",
            ));
        }
    }
    Ok(expected)
}
fn runtime_observations(
    document: &Document,
    targets: &[Target],
    bindings: &BTreeMap<String, StateBinding>,
    plan: &Plan,
) -> Result<RuntimeValidation, Error> {
    let mut result = RuntimeValidation {
        expected: runtime_bindings(targets, bindings)?,
        gateway_running: document.spec.gateway.as_managed().is_none(),
    };
    if let Some(gateway) = targets
        .iter()
        .find(|target| target.kind == crate::kubernetes::GATEWAY_KIND)
    {
        result.gateway_running = plan.resource_changes.iter().any(|change| {
            change.address == gateway.address
                && change.change.actions == ["no-op"]
                && change.change.before["running"] == "true"
        });
    }
    if let Some(gateway) = targets
        .iter()
        .find(|target| target.kind == GATEWAY_KIND && plan::disposable(&target.address))
    {
        result.gateway_running = plan.resource_changes.iter().any(|change| {
            change.address == gateway.address
                && change.change.actions == ["no-op"]
                && change.change.before["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty())
        });
    }
    if let Some(gateway) = targets
        .iter()
        .find(|target| target.kind == GATEWAY_KIND && !plan::disposable(&target.address))
    {
        result.gateway_running = plan.resource_changes.iter().any(|change| {
            change.address == gateway.address && change.change.before["running"] == "true"
        });
    }
    Ok(result)
}

impl Deployment {
    pub(super) async fn runtime_stage(
        &self,
        bundle: &Bundle,
        store: &Store,
        document: &Document,
        record: &mut Record,
        apply: bool,
        cancel: &CancellationToken,
    ) -> Result<(Vec<Change>, bool, Vec<String>, DiscoveryReport), Error> {
        crate::image_metadata::verify_cluster_runtime_images(document, self.secrets.as_ref())?;
        if !document.has_runtime() {
            let directory = store.directory.join("runtime");
            if directory.exists()
                && !self
                    .state_bindings(
                        bundle,
                        &Store::open(&directory)?,
                        &record.document,
                        &record.generations,
                        true,
                        cancel,
                    )
                    .await?
                    .is_empty()
            {
                return Err(Error::Conflict(
                    "a configuration without runtime requires a new state directory; retain the existing runtime configuration and state for recovery or destroy",
                ));
            }
            return Ok((Vec::new(), false, Vec::new(), DiscoveryReport::default()));
        }
        let stage = Store::open(&store.directory.join("runtime"))?;
        let (graph, targets) =
            compile::compiled_runtime(document, &record.generations, &bundle.manifest.version)?;
        self.initialize(bundle, &stage, &graph, cancel).await?;
        let bindings = stage.bindings(&bundle.tofu(), cancel).await?;
        runtime_bindings(&targets, &bindings)?;
        let plan = self
            .saved_plan(bundle, &stage, document, "apply.plan", cancel)
            .await?;
        let checked = runtime_observations(document, &targets, &bindings, &plan)?;
        let changes = check_runtime_plan(
            &plan,
            &with_observations(&checked.expected, &compile::observations(&graph)),
            &bindings,
        )?;
        if !apply {
            if !checked.gateway_running
                && !self
                    .state_bindings(bundle, store, document, &record.generations, false, cancel)
                    .await?
                    .is_empty()
            {
                return Err(Error::Conflict(
                    "the managed gateway is not running, so plan cannot inspect OpenShell resources; run apply with the same configuration and state directory to restore the gateway",
                ));
            }
            store.save(record)?;
            let retained = compile::compile_teardown(
                document,
                &record.generations,
                &bundle.manifest.version,
                &bindings.keys().cloned().collect(),
                true,
            )?
            .retained;
            let discovery = plan.discovery_report(DiscoveryScope::Runtime, &bindings, &retained)?;
            return Ok((
                changes,
                !checked.gateway_running,
                plan.discovery_deferred(&discovery),
                discovery,
            ));
        }
        // Apply-time observations still run for an unchanged runtime, but they
        // must not commit proposed OpenShell intent before its plan is accepted.
        if !changes.is_empty() {
            record.begin_runtime_apply(document);
            store.save(record)?;
        }
        self.tofu(
            bundle,
            &stage,
            document,
            &["apply", "-input=false", "-no-color", "apply.plan"],
            cancel,
        )
        .await?;
        if !changes.is_empty() {
            record.finish_runtime_apply();
            store.save(record)?;
        }
        Ok((changes, false, Vec::new(), DiscoveryReport::default()))
    }
    pub(super) async fn export_runtime(
        &self,
        bundle: &Bundle,
        store: &Store,
        record: &Record,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        if !record.document.has_runtime() {
            return Ok(());
        }
        let stage = Store::open(&store.directory.join("runtime"))?;
        self.export_observations(bundle, &stage, record, true, cancel)
            .await?;
        Ok(())
    }
}
