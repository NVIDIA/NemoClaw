// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

mod export;
mod ollama;
mod plan;
mod runtime;
mod timing;
use crate::{
    CancellationToken, Error,
    backend::{Backend, Row},
    bundle::Bundle,
    compile::{self, Target},
    config::{Credential, Document},
    openshell::{EnvironmentSecrets, OpenShell, Secrets, verify_identity},
    state::{Record, StateBinding, Store, atomic_write, save_json},
};
use plan::{Plan, check_destroy_plan, check_plan};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
pub use timing::StepOutcome;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    /// A resource operation observed in OpenTofu's machine-readable UI.
    Resource {
        resource: &'static str,
        action: &'static str,
        status: &'static str,
        elapsed: std::time::Duration,
    },
    /// A step that has started or is still waiting.
    Waiting {
        operation: &'static str,
        elapsed: std::time::Duration,
    },
    Validating,
    Planning,
    Applying,
    Readiness,
    Exporting,
    Destroying,
    /// A completed step with a fixed operation label and no diagnostic payload.
    Completed {
        operation: &'static str,
        elapsed: std::time::Duration,
        outcome: StepOutcome,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Planned,
    Succeeded,
    Destroyed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub resource: String,
    pub actions: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub outcome: Outcome,
    pub changes: Vec<Change>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deferred: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retained: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub health: Vec<crate::SandboxHealth>,
}
impl OperationResult {
    fn planned(changes: Vec<Change>) -> Self {
        Self {
            outcome: Outcome::Planned,
            changes,
            deferred: Vec::new(),
            retained: Vec::new(),
            health: Vec::new(),
        }
    }
}

/// The same desired-state operations used by the CLI. The selected state
/// directory is locked for each operation; callers retain it across failures.
pub struct Deployment {
    state_directory: PathBuf,
    bundle_directory: PathBuf,
    secrets: Arc<dyn Secrets>,
    progress: Arc<dyn Fn(Progress) + Send + Sync>,
    engines: crate::docker::Connections,
}
impl Deployment {
    pub fn new(state_directory: &Path, bundle_directory: &Path) -> Self {
        Self {
            state_directory: state_directory.into(),
            bundle_directory: bundle_directory.into(),
            secrets: Arc::new(EnvironmentSecrets),
            progress: Arc::new(|_| {}),
            engines: crate::docker::Connections::default(),
        }
    }
    /// Supply in-process engine connections. Provider subprocesses independently
    /// connect to the same explicit endpoints carried by compiled resource specs.
    pub fn with_engines(mut self, engines: crate::docker::Connections) -> Self {
        self.engines = engines;
        self
    }
    pub fn with_secrets(mut self, secrets: Arc<dyn Secrets>) -> Self {
        self.secrets = secrets;
        self
    }
    pub fn with_progress(mut self, progress: Arc<dyn Fn(Progress) + Send + Sync>) -> Self {
        self.progress = progress;
        self
    }
    fn open(&self) -> Result<(Bundle, Store), Error> {
        let started = std::time::Instant::now();
        let bundle = self.report_timing(
            "bundle.verify",
            started,
            Bundle::open(&self.bundle_directory),
        )?;
        let state = std::path::absolute(&self.state_directory)
            .map_err(|_| Error::State("cannot resolve state directory"))?;
        Ok((bundle, Store::open(&state)?))
    }
    pub async fn plan(
        &self,
        document: &Document,
        cancel: &CancellationToken,
    ) -> Result<OperationResult, Error> {
        Box::pin(self.run(document, cancel, false)).await
    }
    pub async fn apply(
        &self,
        document: &Document,
        cancel: &CancellationToken,
    ) -> Result<OperationResult, Error> {
        Box::pin(self.run(document, cancel, true)).await
    }
    async fn run(
        &self,
        document: &Document,
        cancel: &CancellationToken,
        apply: bool,
    ) -> Result<OperationResult, Error> {
        let mut document = document.clone();
        document.defaults();
        document.validate()?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let (bundle, store) = self.open()?;
        let prior = store.load()?;
        let fresh = prior.is_none();
        let mut record = match prior {
            Some(record) => record,
            None => Record::new(document.clone())?,
        };
        if record.destroying {
            return Err(Error::Conflict(
                "unfinished destroy; rerun destroy before another operation",
            ));
        }
        if record.document.metadata.uid != document.metadata.uid
            || record.document.spec.gateway.endpoint != document.spec.gateway.endpoint
            || record.document.spec.gateway.management != document.spec.gateway.management
        {
            return Err(Error::Conflict(
                "state is bound to a different deployment UID or gateway",
            ));
        }
        if record.pending && record.digest != document.digest() {
            return Err(Error::Conflict(
                "unfinished apply has different intent; reapply its original configuration",
            ));
        }
        if (document.lifecycle_provider()?.ollama.is_some()
            || document.lifecycle_provider()?.ollama_proxy.is_some())
            && record
                .generations
                .get("ollama")
                .is_none_or(String::is_empty)
        {
            record.generations.insert(
                "ollama".into(),
                Record::new(document.clone())?.generations["ollama"].clone(),
            );
        }
        let (runtime_changes, deferred) = self
            .runtime_stage(&bundle, &store, &document, &mut record, apply, cancel)
            .await?;
        if deferred {
            let mut result = OperationResult::planned(runtime_changes);
            result
                .deferred
                .push("OpenShell registration and sandbox require the managed gateway".into());
            return Ok(result);
        }
        let client = OpenShell::connect(&document.spec.gateway, self.secrets.clone())?;
        let bindings = store.bindings()?;
        let targets = compile::targets(&document, &record.generations)?;
        let mut allowed = allowed(&targets);
        ollama::extend_allowed(&document, &record.generations, &mut allowed)?;
        if bindings
            .iter()
            .any(|(address, binding)| !allowed.contains_key(address) || !binding.spec.is_empty())
        {
            return Err(Error::Conflict(
                "undeclared resource binding in deployment state",
            ));
        }
        tokio::select! { ()=cancel.cancelled()=>return Err(Error::Cancelled), result=self.validate_ollama_environment(&document, &record.generations, &bindings)=>result? }
        (self.progress)(Progress::Validating);
        tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=self.validate_deployment_resources(&client,&document,&targets,&bindings)=>result?}
        self.prepare(
            &bundle,
            &store,
            &compile::compile(&document, &record.generations, &bundle.manifest.version)?,
        )?;
        self.tofu(
            &bundle,
            &store,
            &document,
            &["init", "-upgrade", "-input=false", "-no-color"],
            cancel,
        )
        .await?;
        let (recovery_changes, deferred) = self
            .recover_ollama(&bundle, &store, &document, &mut record, apply, cancel)
            .await?;
        let mut runtime_changes = runtime_changes;
        runtime_changes.extend(recovery_changes);
        if deferred {
            let mut result = OperationResult::planned(runtime_changes);
            result.deferred.push("Model inventory and the complete deployment plan require recovery of the stopped Ollama service".into());
            return Ok(result);
        }
        (self.progress)(Progress::Planning);
        let plan = self
            .saved_plan(&bundle, &store, &document, "apply.plan", cancel)
            .await?;
        let mut changes = runtime_changes;
        changes.extend(check_plan(&plan, &allowed, &bindings)?);
        if !fresh {
            for sandbox in &document.spec.sandboxes {
                if document.sandbox_harness(sandbox)?.kind != "pi" {
                    continue;
                }
                if let Ok(previous) = record.document.sandbox(&sandbox.name)
                    && document
                        .agent_inference(&sandbox.agent)?
                        .default_route()?
                        .overrides
                        != record
                            .document
                            .agent_inference(&previous.agent)?
                            .default_route()?
                            .overrides
                {
                    changes.push(Change {
                        resource: format!("fabric_runtime.{}", sandbox.name),
                        actions: vec!["update".into()],
                    });
                }
            }
        }
        let mut result = OperationResult::planned(changes);
        if !apply {
            if fresh {
                store.save(&record)?;
            }
            return Ok(result);
        }
        record.document = document.clone();
        record.digest = document.digest();
        record.pending = true;
        record.succeeded = false;
        record.destroyed = false;
        record.destroy_runtime = false;
        record.plan_digest = crate::bundle::hash_file(&store.directory.join("apply.plan"))?;
        store.save(&record)?;
        (self.progress)(Progress::Applying);
        for target in targets.iter().filter(|target| target.kind == "sandbox") {
            let definition = document.sandbox(&target.values["name"])?;
            if document.sandbox_harness(definition)?.kind == "pi"
                && let Some(binding) = bindings.get(&target.address)
            {
                let mut sandbox = target.values.clone();
                sandbox.insert("id".into(), binding.id.clone());
                sandbox.insert(
                    "pi_model_config".into(),
                    serde_json::to_string(
                        &document
                            .agent_inference(&definition.agent)?
                            .default_route()?
                            .overrides,
                    )
                    .map_err(|_| Error::State("cannot encode Pi model configuration"))?,
                );
                tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=client.configure_pi(&sandbox, true)=>result?}
            }
        }
        self.tofu(
            &bundle,
            &store,
            &document,
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
        store.save(&record)?;
        let bindings = store.bindings()?;
        for target in targets.iter().filter(|target| target.kind == "sandbox") {
            let definition = document.sandbox(&target.values["name"])?;
            let mut sandbox = target.values.clone();
            sandbox.insert(
                "id".into(),
                bindings
                    .get(&target.address)
                    .ok_or(Error::State("sandbox has no established identity"))?
                    .id
                    .clone(),
            );
            (self.progress)(Progress::Readiness);
            self.timed("sandbox.ready", async {
                if document.sandbox_harness(definition)?.kind == "pi" {
                    sandbox.insert("pi_model_config".into(), serde_json::to_string(&document.agent_inference(&definition.agent)?.default_route()?.overrides)
                        .map_err(|_| Error::State("cannot encode Pi model configuration"))?);
                    tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=client.configure_pi(&sandbox, false)=>result?}
                }
                client.ready(&sandbox, cancel).await?;
                Ok(())
            }).await?;
            {
                let agents = vec![definition.agent.name.clone()];
                let health = self.timed("fabric.health", async {
                    tokio::select! { () = cancel.cancelled() => Err(Error::Cancelled), result = client.health_for(&sandbox, None) => result }
                }).await?;
                let health = crate::SandboxHealth {
                    sandbox: definition.name.clone(),
                    agents,
                    health,
                };
                if !health.health.allows_apply_completion() {
                    return Err(Error::Health {
                        health: Box::new(health),
                    });
                }
                result.health.push(health);
            }
        }
        record.succeeded = true;
        store.save(&record)?;
        result.outcome = Outcome::Succeeded;
        Ok(result)
    }
    async fn validate_deployment_resources(
        &self,
        client: &OpenShell,
        document: &Document,
        targets: &[Target],
        bindings: &BTreeMap<String, StateBinding>,
    ) -> Result<(), Error> {
        for driver in document
            .spec
            .sandboxes
            .iter()
            .map(|sandbox| &sandbox.runtime.provider)
            .collect::<std::collections::BTreeSet<_>>()
        {
            client.verify_gateway(driver).await?;
        }
        for target in targets {
            let mut expected = target.values.clone();
            if let Some(binding) = bindings.get(&target.address) {
                expected.insert("id".into(), binding.id.clone());
                if target.kind == "sandbox" {
                    // A terminal sandbox cannot answer native configuration
                    // checks. Report its verified lifecycle failure first.
                    client.check_sandbox_phase(&expected).await?;
                }
            }
            let observed = if crate::ollama::proxy::supports(&target.kind) {
                let config = document
                    .lifecycle_provider()?
                    .ollama_proxy
                    .as_ref()
                    .ok_or(Error::State("missing proxy settings"))?;
                crate::ollama::OllamaBackend::new(self.engines.resolve(&config.engine)?)
                    .read(&target.kind, &expected, false)
                    .await?
            } else {
                client.read(&target.kind, &expected, false).await?
            };
            match observed {
                Some(observed) => verify_identity(&expected, &observed)?,
                None if bindings.contains_key(&target.address) => {
                    return Err(Error::Conflict(
                        "managed resource disappeared; automatic replacement is forbidden",
                    ));
                }
                None => {}
            }
        }
        Ok(())
    }
    fn prepare(&self, bundle: &Bundle, store: &Store, graph: &Value) -> Result<(), Error> {
        for entry in fs::read_dir(&store.directory)
            .map_err(|_| Error::State("cannot inspect state directory"))?
        {
            let entry = entry.map_err(|_| Error::State("cannot inspect state directory"))?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name != "main.tf.json"
                && [".tf", ".tf.json", ".tofu", ".tofu.json"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
            {
                return Err(Error::Conflict(
                    "unexpected OpenTofu configuration in state directory",
                ));
            }
        }
        save_json(&store.directory.join("main.tf.json"), graph)?;
        let mirror = bundle
            .directory
            .join("providers")
            .to_string_lossy()
            .replace('\\', "/");
        let quoted = serde_json::to_string(&mirror).expect("string path");
        atomic_write(
            &store.directory.join("providers.tfrc"),
            format!("provider_installation {{\n filesystem_mirror {{ path = {quoted} }}\n}}\n")
                .as_bytes(),
        )
    }
    async fn tofu(
        &self,
        bundle: &Bundle,
        store: &Store,
        document: &Document,
        args: &[&str],
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, Error> {
        let operation = match args.first().copied() {
            Some("init") => "tofu.init",
            Some("plan") => "tofu.plan",
            Some("show") => "tofu.show",
            Some("apply") => "tofu.apply",
            _ => "tofu.command",
        };
        self.timed(operation, async {
            let env = command_environment(document, self.secrets.as_ref(), &store.directory)?;
            if matches!(args.first(), Some(&"plan" | &"apply")) {
                let mut args = args.to_vec();
                args.insert(1, "-json");
                crate::process::run_with_progress(
                    &store.directory,
                    &bundle.tofu(),
                    &args,
                    &env,
                    cancel,
                    Some(self.progress.clone()),
                )
                .await
            } else {
                crate::process::run(&store.directory, &bundle.tofu(), args, &env, cancel).await
            }
        })
        .await
    }
    async fn saved_plan(
        &self,
        bundle: &Bundle,
        store: &Store,
        document: &Document,
        name: &str,
        cancel: &CancellationToken,
    ) -> Result<Plan, Error> {
        self.tofu(
            bundle,
            store,
            document,
            &[
                "plan",
                "-input=false",
                "-no-color",
                "-parallelism=1",
                &format!("-out={name}"),
            ],
            cancel,
        )
        .await?;
        let bytes = self
            .tofu(bundle, store, document, &["show", "-json", name], cancel)
            .await?;
        serde_json::from_slice(&bytes).map_err(|_| Error::State("invalid OpenTofu plan"))
    }
    pub async fn plan_destroy(&self, cancel: &CancellationToken) -> Result<OperationResult, Error> {
        self.teardown(cancel, true).await
    }
    pub async fn destroy(&self, cancel: &CancellationToken) -> Result<OperationResult, Error> {
        self.teardown(cancel, false).await
    }
    async fn teardown(
        &self,
        cancel: &CancellationToken,
        preview: bool,
    ) -> Result<OperationResult, Error> {
        self.teardown_stages(cancel, preview).await
    }
}
fn allowed(targets: &[Target]) -> BTreeMap<String, Row> {
    targets
        .iter()
        .map(|target| (target.address.clone(), target.values.clone()))
        .collect()
}

fn command_environment(
    document: &Document,
    secrets: &dyn Secrets,
    directory: &Path,
) -> Result<BTreeMap<String, String>, Error> {
    let mut env: BTreeMap<String, String> = [
        ("TF_IN_AUTOMATION", "1"),
        ("TF_INPUT", "0"),
        ("CHECKPOINT_DISABLE", "1"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    env.insert(
        "TF_CLI_CONFIG_FILE".into(),
        directory
            .join("providers.tfrc")
            .to_string_lossy()
            .into_owned(),
    );
    for name in document.credential_names() {
        if ["TF_", "TOFU_", "PLUGIN_", "NEMOCLAW_INTERNAL_"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
            || name == "CHECKPOINT_DISABLE"
        {
            return Err(Error::Conflict(
                "credential reference conflicts with a reserved runtime control variable",
            ));
        }
        env.insert(name.into(), secrets.resolve(name)?);
    }
    Ok(env)
}
