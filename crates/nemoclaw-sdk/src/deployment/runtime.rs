// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod teardown;
#[cfg(all(test, unix))]
mod tests;

use super::*;
use crate::managed::{GATEWAY_KIND, GATEWAY_STORAGE_KIND, Spec};
const GATEWAY_STORAGE: &str = "nemoclaw_gateway_storage.runtime";
pub(super) fn check_runtime_plan(
    plan: &Plan,
    allowed: &BTreeMap<String, Row>,
    bindings: &BTreeMap<String, StateBinding>,
    replacements: &BTreeSet<String>,
) -> Result<Vec<Change>, Error> {
    let mut ordinary = Plan::default();
    let mut changes = Vec::new();
    let mut seen = BTreeSet::new();
    let mut observations = BTreeSet::new();
    for change in &plan.resource_changes {
        if plan::observation(change, &mut observations, allowed, true, false)? {
            continue;
        }
        if plan::disposable(&change.address) || change.deposed.is_some() {
            ordinary.resource_changes.push(plan::ResourceChange {
                mode: change.mode.clone(),
                address: change.address.clone(),
                deposed: change.deposed.clone(),
                change: plan::PlannedChange {
                    actions: change.change.actions.clone(),
                    before: change.change.before.clone(),
                    after: change.change.after.clone(),
                },
            });
            continue;
        }
        if !seen.insert(&change.address) {
            return Err(Error::Conflict("runtime plan duplicated a resource"));
        }
        let expected = allowed.get(&change.address).ok_or(Error::Conflict(
            "runtime plan contains an undeclared resource",
        ))?;
        if change.change.actions == ["delete", "create"] {
            if !replacements.contains(&change.address) {
                return Err(Error::Conflict(
                    "runtime replacement requires verified retained storage",
                ));
            }
            let binding = bindings
                .get(&change.address)
                .ok_or(Error::Conflict("runtime replacement is unbound"))?;
            if change.change.before["id"] != binding.id
                || change.change.before["spec"] != expected["spec"]
            {
                return Err(Error::Conflict(
                    "runtime replacement changed the established identity or specification",
                ));
            }
            changes.push(Change {
                resource: change.address.clone(),
                actions: change.change.actions.clone(),
            });
            ordinary.resource_changes.push(plan::ResourceChange {
                mode: change.mode.clone(),
                address: change.address.clone(),
                deposed: change.deposed.clone(),
                change: plan::PlannedChange {
                    actions: vec!["no-op".into()],
                    before: change.change.before.clone(),
                    after: change.change.after.clone(),
                },
            });
        } else {
            ordinary.resource_changes.push(plan::ResourceChange {
                mode: change.mode.clone(),
                address: change.address.clone(),
                deposed: change.deposed.clone(),
                change: plan::PlannedChange {
                    actions: change.change.actions.clone(),
                    before: change.change.before.clone(),
                    after: change.change.after.clone(),
                },
            });
        }
    }
    changes.extend(check_plan(&ordinary, allowed, bindings)?);
    Ok(changes)
}
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
    replacements: BTreeSet<String>,
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
            && plan::disposable(&target.address)
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
    generations: &crate::compile::Generations,
    targets: &[Target],
    bindings: &BTreeMap<String, StateBinding>,
    plan: &Plan,
) -> Result<RuntimeValidation, Error> {
    let mut result = RuntimeValidation {
        expected: runtime_bindings(targets, bindings)?,
        replacements: BTreeSet::new(),
        gateway_running: document.spec.gateway.as_managed().is_none(),
    };
    let retained: BTreeSet<_> = targets
        .iter()
        .filter(|target| {
            target.kind == GATEWAY_STORAGE_KIND
                || crate::services::resource_behavior(&target.kind).retained_storage
        })
        .filter(|target| {
            bindings.get(&target.address).is_some_and(|binding| {
                plan.resource_changes.iter().any(|change| {
                    change.address == target.address
                        && change.mode.as_deref() != Some("data")
                        && change.change.actions == ["no-op"]
                        && change.change.before["id"] == binding.id
                        && change.change.before["spec"] == binding.spec
                })
            })
        })
        .map(|target| target.address.clone())
        .collect();
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
    for target in targets.iter().filter(|target| {
        !plan::disposable(&target.address)
            && (target.kind == GATEWAY_KIND
                || crate::services::resource_behavior(&target.kind).runtime_process)
    }) {
        if target.kind == GATEWAY_KIND {
            result.gateway_running = plan.resource_changes.iter().any(|change| {
                change.address == target.address && change.change.before["running"] == "true"
            });
        }
        let storage = if target.kind == GATEWAY_KIND {
            Some(GATEWAY_STORAGE.to_owned())
        } else {
            crate::services::required_storage_address(document, generations, &target.address)?
        };
        if result.expected[&target.address]["spec"] != target.values["spec"]
            && storage.is_some_and(|address| retained.contains(&address))
        {
            result.replacements.insert(target.address.clone());
        }
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
        let bindings = self
            .state_bindings(bundle, &stage, document, &record.generations, true, cancel)
            .await?;
        let targets = compile::runtime_targets(document, &record.generations)?;
        runtime_bindings(&targets, &bindings)?;
        self.prepare(
            bundle,
            &stage,
            &compile::compile_runtime(document, &record.generations, &bundle.manifest.version)?,
        )?;
        self.tofu(
            bundle,
            &stage,
            document,
            &["init", "-upgrade", "-input=false", "-no-color"],
            cancel,
        )
        .await?;
        let plan = self
            .saved_plan(bundle, &stage, document, "apply.plan", cancel)
            .await?;
        let checked =
            runtime_observations(document, &record.generations, &targets, &bindings, &plan)?;
        let changes =
            check_runtime_plan(&plan, &checked.expected, &bindings, &checked.replacements)?;
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
