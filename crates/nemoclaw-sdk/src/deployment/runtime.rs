// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod teardown;
#[cfg(all(test, unix))]
mod tests;

pub(super) use super::plan::check_plan as check_runtime_plan;
use super::*;
use crate::managed::{GATEWAY_KIND, Spec};
const GATEWAY_STORAGE: &str = "nemoclaw_gateway_storage.runtime";
fn bound_spec(want: &Spec, binding: Option<&StateBinding>) -> Result<Spec, Error> {
    let Some(binding) = binding else {
        return Ok(want.clone());
    };
    let old: Spec = serde_json::from_str(&binding.spec)
        .map_err(|_| Error::Conflict("bound runtime specification is incomplete"))?;
    old.validate()?;
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
        return Err(Error::Conflict(
            "ordinary apply cannot remove a managed runtime",
        ));
    }
    for target in targets {
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
            let want: Spec = serde_json::from_str(&target.values["spec"])
                .map_err(|_| Error::State("invalid compiled runtime"))?;
            let old = bound_spec(&want, bindings.get(&target.address))?;
            expected
                .get_mut(&target.address)
                .unwrap()
                .insert("spec".into(), old.json()?);
        } else if bindings
            .get(&target.address)
            .is_some_and(|binding| binding.spec != target.values["spec"])
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
    ) -> Result<(Vec<Change>, bool), Error> {
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
            return Ok((Vec::new(), false));
        }
        let generated = Record::new(document.clone())?;
        for (kind, generation) in generated.generations {
            if record.generations.get(&kind).is_none_or(String::is_empty) {
                record.generations.insert(kind, generation);
            }
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
        let changes = check_runtime_plan(&plan, &checked.expected, &bindings)?;
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
            return Ok((changes, !checked.gateway_running));
        }
        record.document = document.clone();
        record.digest = document.digest();
        record.begin_runtime_apply();
        record.succeeded = false;
        record.destroyed = false;
        record.destroy_runtime = false;
        record.plan_digest = crate::bundle::hash_file(&stage.directory.join("apply.plan"))?;
        store.save(record)?;
        self.tofu(
            bundle,
            &stage,
            document,
            &["apply", "-input=false", "-no-color", "apply.plan"],
            cancel,
        )
        .await?;
        record.finish_runtime_apply();
        store.save(record)?;
        Ok((changes, false))
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
