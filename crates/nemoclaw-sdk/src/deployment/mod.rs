// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

mod export;
mod plan;
mod runtime;
mod timing;
use crate::{
    CancellationToken, Error,
    backend::Row,
    bundle::Bundle,
    compile::{self, Target},
    config::{Credential, Document},
    openshell::{EnvironmentSecrets, Secrets},
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Progress {
    Download(crate::DownloadProgress),
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
}
impl Deployment {
    pub fn new(state_directory: &Path, bundle_directory: &Path) -> Self {
        Self {
            state_directory: state_directory.into(),
            bundle_directory: bundle_directory.into(),
            secrets: Arc::new(EnvironmentSecrets),
            progress: Arc::new(|_| {}),
        }
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
            || record.document.spec.gateway.endpoint() != document.spec.gateway.endpoint()
            || std::mem::discriminant(&record.document.spec.gateway)
                != std::mem::discriminant(&document.spec.gateway)
        {
            return Err(Error::Conflict(
                "state is bound to a different deployment UID or gateway",
            ));
        }
        for kind in crate::services::generation_kinds(&document)? {
            if record.generations.get(kind).is_none_or(String::is_empty) {
                record.generations.insert(
                    kind.into(),
                    Record::new(document.clone())?.generations[kind].clone(),
                );
            }
        }
        record.validate_pending_intent(&document)?;
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
        let (graph, targets) =
            compile::deployment_graph(&document, &record.generations, &bundle.manifest.version)?;
        (self.progress)(Progress::Validating);
        self.initialize(&bundle, &store, &graph, cancel).await?;
        let bindings = store.bindings(&bundle.tofu(), cancel).await?;
        let allowed = allowed(&targets);
        if bindings.iter().any(|(address, binding)| {
            (!allowed.contains_key(address)
                && !plan::disposable(address)
                && !plan::reconstructible(address))
                || !binding.spec.is_empty()
        }) {
            return Err(Error::Conflict(
                "undeclared resource binding in deployment state",
            ));
        }
        (self.progress)(Progress::Planning);
        let plan = self
            .saved_plan(&bundle, &store, &document, "apply.plan", cancel)
            .await?;
        let root_changes = check_plan(&plan, &allowed, &bindings)?;
        let creations = root_changes
            .iter()
            .filter(|change| {
                !plan::disposable(&change.resource)
                    && change.actions.iter().any(|action| action == "create")
            })
            .map(|change| (change.resource.clone(), allowed[&change.resource].clone()))
            .collect();
        let mut changes = runtime_changes;
        changes.extend(root_changes);
        let mut result = OperationResult::planned(changes);
        if !apply {
            if fresh {
                store.save(&record)?;
            }
            return Ok(result);
        }
        record.document = document.clone();
        record.digest = document.digest();
        record.begin_apply(creations);
        record.succeeded = false;
        record.destroyed = false;
        record.destroy_runtime = false;
        record.plan_digest = crate::bundle::hash_file(&store.directory.join("apply.plan"))?;
        store.save(&record)?;
        (self.progress)(Progress::Applying);
        let applied = self
            .tofu(
                &bundle,
                &store,
                &document,
                &["apply", "-input=false", "-no-color", "apply.plan"],
                cancel,
            )
            .await;
        if let Err(error) = applied {
            // Only a complete UI stream proving exclusively data postcondition
            // failures can settle durable mutations. Never replace an unrelated
            // apply error with a health report retained from an earlier apply.
            if let Error::Execution {
                postcondition_failures: Some(addresses),
                ..
            } = &error
                && let Ok(observations) = self
                    .sandbox_observations(&bundle, &store, &document, &plan, cancel)
                    .await
                && !addresses.is_empty()
                && addresses.iter().all(|address| {
                    observations.iter().any(|(sandbox, observed)| {
                        *address == format!("data.nemoclaw_sandbox_readiness.{sandbox}")
                            && observed["ready"] == false
                    })
                })
            {
                record.finish_apply();
                store.save(&record)?;
                if let Some(health) = observations.iter().find_map(|(name, observed)| {
                    let health =
                        crate::RuntimeHealth::decode(observed["health_json"].as_str()?.as_bytes())
                            .ok()?;
                    let agent = document.sandbox(name).ok()?.agent.name.clone();
                    (!health.allows_apply_completion()).then(|| crate::SandboxHealth {
                        sandbox: name.clone(),
                        agents: vec![agent],
                        health,
                    })
                }) {
                    return Err(Error::Health {
                        health: Box::new(health),
                    });
                }
            }
            return Err(error);
        }
        record.finish_apply();
        store.save(&record)?;
        result.health = self
            .sandbox_observations(&bundle, &store, &document, &plan, cancel)
            .await?
            .into_iter()
            .map(|(name, observed)| {
                Ok(crate::SandboxHealth {
                    agents: vec![document.sandbox(&name)?.agent.name.clone()],
                    sandbox: name,
                    health: crate::RuntimeHealth::decode(
                        observed["health_json"]
                            .as_str()
                            .ok_or(Error::State("sandbox health observation is absent"))?
                            .as_bytes(),
                    )?,
                })
            })
            .collect::<Result<_, Error>>()?;
        record.succeeded = true;
        store.save(&record)?;
        result.outcome = Outcome::Succeeded;
        Ok(result)
    }
    async fn sandbox_observations(
        &self,
        bundle: &Bundle,
        store: &Store,
        document: &Document,
        plan: &Plan,
        cancel: &CancellationToken,
    ) -> Result<Vec<(String, Value)>, Error> {
        let bytes = self
            .tofu(bundle, store, document, &["show", "-json"], cancel)
            .await?;
        let state: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Error::State("invalid OpenTofu health observations"))?;
        if state["format_version"]
            .as_str()
            .is_none_or(|version| version.split('.').next() != Some("1"))
        {
            return Err(Error::State("unsupported OpenTofu state JSON version"));
        }
        let observations = crate::state::parse_resources(&state["values"])?;
        document
            .spec
            .sandboxes
            .iter()
            .map(|sandbox| {
                let address = format!("data.nemoclaw_sandbox_readiness.{}", sandbox.name);
                let observed = observations
                    .get(&address)
                    .ok_or(Error::State("sandbox readiness observation is absent"))?;
                let previous = plan
                    .resource_changes
                    .iter()
                    .find(|change| change.address == address)
                    .ok_or(Error::State("sandbox readiness was not scheduled"))?;
                let token = observed["read_trigger"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or(Error::State(
                        "sandbox readiness observation has no operation identity",
                    ))?;
                if previous.change.before["read_trigger"].as_str() == Some(token) {
                    return Err(Error::State(
                        "sandbox readiness observation predates this apply",
                    ));
                }
                Ok((sandbox.name.clone(), observed.clone()))
            })
            .collect()
    }
    async fn state_bindings(
        &self,
        bundle: &Bundle,
        store: &Store,
        document: &Document,
        generations: &compile::Generations,
        runtime: bool,
        cancel: &CancellationToken,
    ) -> Result<BTreeMap<String, StateBinding>, Error> {
        if !store
            .directory
            .join("terraform.tfstate")
            .try_exists()
            .map_err(|_| Error::State("cannot inspect OpenTofu state"))?
        {
            return Ok(BTreeMap::new());
        }
        // show needs the exact provider schemas. Reinitialize from the current
        // verified bundle, including after an SDK upgrade or state-directory move.
        let graph = if runtime {
            compile::compile_runtime(document, generations, &bundle.manifest.version)?
        } else {
            compile::compile(document, generations, &bundle.manifest.version)?
        };
        self.initialize(bundle, store, &graph, cancel).await?;
        store.bindings(&bundle.tofu(), cancel).await
    }
    async fn initialize(
        &self,
        bundle: &Bundle,
        store: &Store,
        graph: &Value,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        self.prepare(bundle, store, graph)?;
        self.timed(
            "tofu.init",
            crate::process::run(
                &store.directory,
                &bundle.tofu(),
                &["init", "-upgrade", "-input=false", "-no-color"],
                &crate::state::schema_environment(&store.directory),
                cancel,
            ),
        )
        .await?;
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
            let env = if matches!(args.first(), Some(&"init" | &"show")) {
                crate::state::schema_environment(&store.directory)
            } else {
                command_environment(document, self.secrets.as_ref(), &store.directory)?
            };
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
            &["plan", "-input=false", "-no-color", &format!("-out={name}")],
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
    credential_environment(document.credential_names(), secrets, directory)
}

fn gateway_environment(
    document: &Document,
    secrets: &dyn Secrets,
    directory: &Path,
) -> Result<BTreeMap<String, String>, Error> {
    let gateway = &document.spec.gateway;
    let mut names = BTreeSet::new();
    if let Some(credential) = gateway.credential() {
        names.insert(credential.env.as_str());
    }
    if let Some(tls) = gateway.tls() {
        names.extend([
            tls.ca.env.as_str(),
            tls.certificate.env.as_str(),
            tls.key.env.as_str(),
        ]);
    }
    credential_environment(names, secrets, directory)
}

fn credential_environment<'a>(
    names: impl IntoIterator<Item = &'a str>,
    secrets: &dyn Secrets,
    directory: &Path,
) -> Result<BTreeMap<String, String>, Error> {
    let mut env = crate::state::schema_environment(directory);
    for name in names {
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
