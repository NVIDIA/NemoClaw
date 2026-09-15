// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{
    ObservationError,
    docker::Engine,
    managed::{GATEWAY_KIND, GATEWAY_STORAGE_KIND, SERVICE_KIND, STORAGE_KIND, Spec, Storage},
};
use std::time::Duration;
const GATEWAY_STORAGE: &str = "nemoclaw_gateway_storage.runtime";
const MODEL_STORAGE: &str = "nemoclaw_inference_storage.runtime";
const GATEWAY: &str = "nemoclaw_managed_gateway.runtime";
pub(super) fn check_runtime_plan(
    plan: &Plan,
    allowed: &BTreeMap<String, Row>,
    bindings: &BTreeMap<String, StateBinding>,
    replacements: &BTreeSet<String>,
) -> Result<Vec<Change>, Error> {
    let mut ordinary = Plan::default();
    let mut changes = Vec::new();
    let mut seen = BTreeSet::new();
    for change in &plan.resource_changes {
        if !seen.insert(&change.address) {
            return Err(Error::Conflict("runtime plan duplicated a resource"));
        }
        let expected = allowed.get(&change.address).ok_or(Error::Conflict(
            "runtime plan contains an undeclared resource",
        ))?;
        if change.change.actions == ["delete", "create"] {
            if !matches!(
                change.address.as_str(),
                GATEWAY | "nemoclaw_inference_service.runtime"
            ) || !replacements.contains(&change.address)
            {
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
                address: change.address.clone(),
                change: plan::PlannedChange {
                    actions: vec!["no-op".into()],
                    before: change.change.before.clone(),
                },
            });
        } else {
            ordinary.resource_changes.push(plan::ResourceChange {
                address: change.address.clone(),
                change: plan::PlannedChange {
                    actions: change.change.actions.clone(),
                    before: change.change.before.clone(),
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
        || old.gateway.engine != want.gateway.engine
    {
        return Err(Error::Conflict(
            "bound runtime identity differs from retained intent",
        ));
    }
    Ok(old)
}
struct Preflight {
    expected: BTreeMap<String, Row>,
    replacements: BTreeSet<String>,
    gateway_running: bool,
}
async fn preflight(
    engine: &Engine,
    targets: &[Target],
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<Preflight, Error> {
    let mut result = Preflight {
        expected: allowed(targets),
        replacements: BTreeSet::new(),
        gateway_running: false,
    };
    if bindings
        .keys()
        .any(|key| !result.expected.contains_key(key))
    {
        return Err(Error::Conflict(
            "ordinary apply cannot remove a managed runtime",
        ));
    }
    let mut retained = BTreeSet::new();
    // Storage must be observed before authorizing any process replacement.
    for target in targets
        .iter()
        .filter(|target| matches!(target.kind.as_str(), STORAGE_KIND | GATEWAY_STORAGE_KIND))
    {
        let id = bindings
            .get(&target.address)
            .map(|b| b.id.as_str())
            .unwrap_or("");
        if let Some(binding) = bindings.get(&target.address)
            && binding.spec != target.values["spec"]
        {
            return Err(Error::Conflict(
                "bound storage specification differs from retained intent",
            ));
        }
        let observed = if target.kind == STORAGE_KIND {
            let spec: Storage = serde_json::from_str(&target.values["spec"])
                .map_err(|_| Error::State("invalid compiled storage"))?;
            spec.observe(engine, id).await?
        } else {
            let spec: Spec = serde_json::from_str(&target.values["spec"])
                .map_err(|_| Error::State("invalid compiled gateway storage"))?;
            match engine.gateway_storage(&spec, id, false).await {
                Err(Error::PartialRuntime) if id.is_empty() => None,
                other => other?,
            }
        };
        if observed.is_some() {
            retained.insert(target.address.clone());
        }
    }
    for target in targets
        .iter()
        .filter(|target| matches!(target.kind.as_str(), GATEWAY_KIND | SERVICE_KIND))
    {
        let want: Spec = serde_json::from_str(&target.values["spec"])
            .map_err(|_| Error::State("invalid compiled runtime"))?;
        let old = bound_spec(&want, bindings.get(&target.address))?;
        result
            .expected
            .get_mut(&target.address)
            .unwrap()
            .insert("spec".into(), old.json()?);
        let id = bindings
            .get(&target.address)
            .map(|b| b.id.as_str())
            .unwrap_or("");
        let observed = match engine.observe_runtime(&old, id).await {
            Err(Error::PartialRuntime) if id.is_empty() => None,
            other => other?,
        };
        if want.kind == GATEWAY_KIND {
            result.gateway_running = observed.as_ref().is_some_and(|o| o.running);
        }
        if want.service.is_some() {
            engine.check_capacity(&want, observed.as_ref()).await?;
        }
        if old != want
            && retained.contains(if want.kind == GATEWAY_KIND {
                GATEWAY_STORAGE
            } else {
                MODEL_STORAGE
            })
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
        if document.spec.gateway.management != "managed" {
            return Ok((Vec::new(), false));
        }
        for kind in [GATEWAY_KIND, SERVICE_KIND] {
            if record.generations.get(kind).is_none_or(String::is_empty) {
                let generated = Record::new(document.clone())?;
                record
                    .generations
                    .insert(kind.into(), generated.generations[kind].clone());
            }
        }
        let stage = Store::open(&store.directory.join("runtime"))?;
        let bindings = stage.bindings()?;
        let targets = compile::runtime_targets(document, &record.generations)?;
        let engine = self.engines.resolve(&document.spec.gateway.engine)?;
        let checked = tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=preflight(&engine,&targets,&bindings)=>result?};
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
        let changes =
            check_runtime_plan(&plan, &checked.expected, &bindings, &checked.replacements)?;
        if !apply {
            if !checked.gateway_running && !store.bindings()?.is_empty() {
                return Err(Error::Conflict(
                    "runtime restart is planned but OpenShell observations are unavailable; apply unchanged intent to reconcile the runtime stage",
                ));
            }
            store.save(record)?;
            return Ok((changes, !checked.gateway_running));
        }
        record.document = document.clone();
        record.digest = document.digest();
        record.pending = true;
        record.succeeded = false;
        record.destroyed = false;
        record.destroy_runtime = false;
        record.plan_digest = crate::bundle::hash_file(&stage.directory.join("apply.plan"))?;
        store.save(record)?;
        self.tofu(
            bundle,
            &stage,
            document,
            &[
                "apply",
                "-input=false",
                "-no-color",
                "-parallelism=1",
                "apply.plan",
            ],
            cancel,
        )
        .await?;
        record.pending = false;
        store.save(record)?;
        self.wait_runtime(document, &targets, &stage, cancel)
            .await?;
        Ok((changes, false))
    }
    async fn wait_runtime(
        &self,
        document: &Document,
        targets: &[Target],
        stage: &Store,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        (self.progress)(Progress::Readiness);
        let client = OpenShell::connect(&document.spec.gateway, self.secrets.clone())?;
        let gateway = async {
            loop {
                match tokio::time::timeout(
                    Duration::from_secs(2),
                    client.verify_gateway(&document.spec.sandboxes[0].runtime.provider),
                )
                .await
                {
                    Ok(Ok(())) => return Ok(()),
                    Ok(Err(Error::Observation(ObservationError::Transport))) | Err(_) => {}
                    Ok(Err(error)) => return Err(error),
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        };
        tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=tokio::time::timeout(Duration::from_secs(90),gateway)=>result.map_err(|_|Error::State("managed gateway readiness failed; identity and data retained"))??};
        let bindings = stage.bindings()?;
        let engine = self.engines.resolve(&document.spec.gateway.engine)?;
        let inference = async {
            for target in targets.iter().filter(|t| t.kind == SERVICE_KIND) {
                let spec: Spec = serde_json::from_str(&target.values["spec"])
                    .map_err(|_| Error::State("invalid runtime specification"))?;
                let binding = bindings.get(&target.address).ok_or(Error::State(
                    "inference runtime has no established identity",
                ))?;
                loop {
                    let observed = engine
                        .observe_runtime(&spec, &binding.id)
                        .await?
                        .ok_or(Error::State("inference runtime is unobservable"))?;
                    if !observed.running {
                        return Err(Error::State(
                            "inference runtime stopped; inspect logs and explicitly reapply; identity and model data retained",
                        ));
                    }
                    let status = engine.runtime_status(&observed).await?;
                    if status.phase == "ready" {
                        engine.verify_artifacts(&observed).await?;
                        break;
                    }
                    if status.phase == "stopped" {
                        return Err(Error::State(
                            "inference runtime protection stopped the service; explicit recovery required",
                        ));
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
            Ok(())
        };
        tokio::select! {()=cancel.cancelled()=>Err(Error::Cancelled),result=tokio::time::timeout(Duration::from_secs(9*3600),inference)=>result.map_err(|_|Error::State("runtime readiness timed out; container, watchdog and data remain owned"))?}
    }
    pub(super) async fn export_runtime(
        &self,
        store: &Store,
        record: &Record,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        if record.document.spec.gateway.management != "managed" {
            return Ok(());
        }
        let stage = Store::open(&store.directory.join("runtime"))?;
        let bindings = stage.bindings()?;
        let targets = compile::runtime_targets(&record.document, &record.generations)?;
        if bindings.len() != targets.len() {
            return Err(Error::Conflict(
                "export requires all managed runtime bindings",
            ));
        }
        let engine = self.engines.resolve(&record.document.spec.gateway.engine)?;
        let work = async {
            for target in targets {
                let binding = bindings.get(&target.address).ok_or(Error::Conflict(
                    "export requires established runtime identity",
                ))?;
                if binding.spec != target.values["spec"] {
                    return Err(Error::Conflict(
                        "runtime state differs from intent; no YAML exported",
                    ));
                }
                let mut row = target.values.clone();
                row.insert("id".into(), binding.id.clone());
                crate::managed::ManagedBackend::new(engine.clone())
                    .read(&target.kind, &row, false)
                    .await?
                    .ok_or(Error::Conflict(
                        "managed runtime is absent; no YAML exported",
                    ))?;
                if target.kind == SERVICE_KIND {
                    let spec: Spec = serde_json::from_str(&binding.spec)
                        .map_err(|_| Error::State("invalid runtime binding"))?;
                    let observed = engine
                        .observe_runtime(&spec, &binding.id)
                        .await?
                        .ok_or(Error::State("runtime unobservable"))?;
                    engine.verify_artifacts(&observed).await?;
                }
            }
            Ok(())
        };
        tokio::select! {()=cancel.cancelled()=>Err(Error::Cancelled),result=work=>result}
    }
}

// Teardown uses gateway authentication but never invokes inference. Keep the
// retained document and resource graph intact; narrow only subprocess secrets.
fn destroy_environment(document: &Document) -> Document {
    let mut environment = document.clone();
    for provider in &mut environment.spec.inference_providers {
        provider.credential = None;
    }
    environment
}

impl Deployment {
    pub(super) async fn teardown_stages(
        &self,
        cancel: &CancellationToken,
        preview: bool,
    ) -> Result<OperationResult, Error> {
        let (bundle, store) = self.open()?;
        let mut record = store.load()?.ok_or(Error::Conflict(
            "destroy requires existing deployment state",
        ))?;
        if record.pending {
            return Err(Error::Conflict(
                "unfinished apply may have unbound effects; reconcile its original configuration before destroy",
            ));
        }
        self.require_no_ollama(&record.document)?;
        let runtime = if record.document.spec.gateway.management == "managed" {
            Some(Store::open(&store.directory.join("runtime"))?)
        } else {
            None
        };
        let mut result = OperationResult::planned(Vec::new());
        if store
            .bindings()?
            .contains_key("nemoclaw_workspace.deployment")
        {
            result.retained.push("nemoclaw_workspace.deployment".into());
        }
        if let Some(stage) = &runtime {
            let bindings = stage.bindings()?;
            for address in [GATEWAY_STORAGE, MODEL_STORAGE] {
                if bindings.contains_key(address) {
                    result.retained.push(address.into());
                }
            }
        }
        if record.destroyed {
            if !preview {
                result.outcome = Outcome::Destroyed;
            }
            return Ok(result);
        }
        // Observe and validate both complete saved plans before the first delete.
        let mut stages = Vec::new();
        if !record.destroy_runtime {
            let (changes, planned) = self
                .plan_teardown_stage(&bundle, &store, &record, false, cancel)
                .await?;
            result.changes.extend(changes);
            stages.push((&store, false, planned));
        }
        if let Some(stage) = &runtime {
            let (changes, planned) = self
                .plan_teardown_stage(&bundle, stage, &record, true, cancel)
                .await?;
            result.changes.extend(changes);
            stages.push((stage, true, planned));
        }
        if preview {
            return Ok(result);
        }
        record.destroying = true;
        record.succeeded = false;
        store.save(&record)?;
        (self.progress)(Progress::Destroying);
        for (stage, is_runtime, planned) in stages {
            if planned {
                self.tofu(
                    &bundle,
                    stage,
                    &destroy_environment(&record.document),
                    &[
                        "apply",
                        "-input=false",
                        "-no-color",
                        "-parallelism=1",
                        "destroy.plan",
                    ],
                    cancel,
                )
                .await?;
            }
            if !is_runtime {
                record.destroy_runtime = true;
                store.save(&record)?;
            }
        }
        record.destroying = false;
        record.destroyed = true;
        record.plan_digest.clear();
        store.save(&record)?;
        result.outcome = Outcome::Destroyed;
        Ok(result)
    }
    async fn plan_teardown_stage(
        &self,
        bundle: &Bundle,
        store: &Store,
        record: &Record,
        runtime: bool,
        cancel: &CancellationToken,
    ) -> Result<(Vec<Change>, bool), Error> {
        let bindings = store.bindings()?;
        if bindings.is_empty() {
            if record.succeeded || record.destroying {
                return Err(Error::Conflict(
                    "established state is missing; destroy cannot infer unbound resources",
                ));
            }
            return Ok((Vec::new(), false));
        }
        let targets = if runtime {
            compile::runtime_targets(&record.document, &record.generations)?
        } else {
            compile::targets(&record.document, &record.generations)?
        };
        let mut expected = allowed(&targets);
        let retained: BTreeSet<String> = if runtime {
            [GATEWAY_STORAGE.into(), MODEL_STORAGE.into()].into()
        } else {
            ["nemoclaw_workspace.deployment".into()].into()
        };
        if !runtime && !bindings.contains_key("nemoclaw_workspace.deployment") {
            return Err(Error::Conflict(
                "destroy requires the retained workspace binding",
            ));
        }
        for target in &targets {
            if runtime && matches!(target.kind.as_str(), GATEWAY_KIND | SERVICE_KIND) {
                if bindings.contains_key(&target.address)
                    && (!bindings.contains_key(GATEWAY_STORAGE)
                        || (target.kind == SERVICE_KIND && !bindings.contains_key(MODEL_STORAGE)))
                {
                    return Err(Error::Conflict(
                        "destroy requires independent storage bindings before removing a managed process",
                    ));
                }
                let want: Spec = serde_json::from_str(&target.values["spec"])
                    .map_err(|_| Error::State("invalid runtime intent"))?;
                expected.get_mut(&target.address).unwrap().insert(
                    "spec".into(),
                    bound_spec(&want, bindings.get(&target.address))?.json()?,
                );
            }
        }
        for (address, binding) in &bindings {
            let want = expected.get(address).ok_or(Error::Conflict(
                "destroy encountered an undeclared resource binding",
            ))?;
            if runtime && want["spec"] != binding.spec {
                return Err(Error::Conflict(
                    "destroy storage configuration disagrees with retained intent",
                ));
            }
            if !runtime && !binding.spec.is_empty() {
                return Err(Error::Conflict(
                    "unexpected specification in OpenShell state",
                ));
            }
        }
        let mut graph = compile::compile(
            &record.document,
            &record.generations,
            &bundle.manifest.version,
        )?;
        graph["provider"]["nemoclaw"]["destroy"] = json!(true);
        graph["resource"] = json!({});
        for address in &retained {
            if bindings.contains_key(address) {
                let (kind, name) = address
                    .split_once('.')
                    .ok_or(Error::State("invalid resource address"))?;
                let mut attrs = serde_json::to_value(&expected[address])
                    .map_err(|_| Error::State("cannot encode retained resource"))?;
                attrs["lifecycle"] = json!({"prevent_destroy":true});
                graph["resource"][kind][name] = attrs;
            }
        }
        self.prepare(bundle, store, &graph)?;
        self.tofu(
            bundle,
            store,
            &destroy_environment(&record.document),
            &["init", "-upgrade", "-input=false", "-no-color"],
            cancel,
        )
        .await?;
        let plan = self
            .saved_plan(
                bundle,
                store,
                &destroy_environment(&record.document),
                "destroy.plan",
                cancel,
            )
            .await?;
        Ok((
            check_destroy_plan(&plan, &expected, &bindings, &retained)?,
            true,
        ))
    }
}
