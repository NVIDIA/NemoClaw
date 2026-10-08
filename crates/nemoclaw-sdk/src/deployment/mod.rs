// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod context_warnings;
#[cfg(test)]
mod tests;

mod apply;
mod export;
mod plan;
mod reporting;
pub use reporting::{
    DiscoveryObservation, DiscoveryReport, DiscoveryScope, DiscoveryTarget, PlanObservation,
    ReportedObservation, ResourceInventoryEntry, ResourceSource,
};
mod runtime;
mod timing;
use crate::{
    CancellationToken, EnvironmentSecrets, Error, Secrets,
    backend::Row,
    bundle::Bundle,
    compile::{self, Target},
    config::{Credential, Document},
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
    /// An authored deployment condition that requires operator attention.
    Warning {
        message: String,
    },
    /// A mutating OpenTofu subprocess has launched. Emitted synchronously once
    /// per launch, before child output; this does not prove any change completed.
    MutationStarted,
    Download(crate::DownloadProgress),
    /// A resource operation observed in OpenTofu's machine-readable UI.
    Resource {
        resource: &'static str,
        /// Native graph identity when it is a bounded, safe resource address.
        /// Unlike the kind label, this distinguishes concurrent resources.
        address: Option<String>,
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
/// Gateway and workspace selectors from validated intent, not proof of access.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentConnection {
    pub gateway_endpoint: String,
    pub workspace: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub outcome: Outcome,
    pub changes: Vec<Change>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<DeploymentConnection>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deferred: Vec<String>,
    /// Known graph resources in a stage whose OpenTofu plan is not yet available.
    /// These are not planned actions and do not contribute to `changes`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deferred_resources: Vec<String>,
    /// Authored definition paths for opaque, scoped provider registrations.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub resource_sources: BTreeMap<String, ResourceSource>,
    /// Supplemental checks that do not make a resource plan incomplete.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unverified: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retained: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub health: Vec<crate::SandboxHealth>,
    #[serde(default, skip_serializing_if = "DiscoveryReport::is_empty")]
    pub discovery: DiscoveryReport,
}
impl OperationResult {
    fn planned(changes: Vec<Change>) -> Self {
        Self {
            outcome: Outcome::Planned,
            changes,
            connection: None,
            deferred: Vec::new(),
            deferred_resources: Vec::new(),
            resource_sources: BTreeMap::new(),
            unverified: Vec::new(),
            retained: Vec::new(),
            health: Vec::new(),
            discovery: DiscoveryReport::default(),
        }
    }
}

/// The same desired-state operations used by the CLI. The selected state
/// directory is locked for each operation; callers retain it across failures.
#[derive(Clone)]
pub struct Deployment {
    state_directory: PathBuf,
    bundle_directory: PathBuf,
    secrets: Arc<dyn Secrets>,
    progress: Arc<dyn Fn(Progress) + Send + Sync>,
    operation_environment: BTreeMap<String, String>,
}
impl Deployment {
    pub fn new(state_directory: &Path, bundle_directory: &Path) -> Self {
        Self {
            state_directory: state_directory.into(),
            bundle_directory: bundle_directory.into(),
            secrets: Arc::new(EnvironmentSecrets),
            progress: Arc::new(|_| {}),
            operation_environment: BTreeMap::new(),
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
    async fn connected(
        &self,
        document: &Document,
        generations: &compile::Generations,
        cancel: &CancellationToken,
    ) -> Result<(Self, Option<crate::kubernetes::Connection>), Error> {
        if document.spec.gateway.as_kubernetes().is_none() {
            return Ok((self.clone(), None));
        }
        let directory = std::path::absolute(&self.state_directory)
            .map_err(|_| Error::State("cannot resolve Kubernetes state directory"))?;
        let connection = crate::kubernetes::connection(
            document,
            generations,
            &directory,
            self.secrets.as_ref(),
            cancel,
        )
        .await?;
        let mut operation = self.clone();
        operation.operation_environment = connection.environment();
        Ok((operation, Some(connection)))
    }
    fn provider_environment(
        &self,
        document: &Document,
        directory: &Path,
        gateway_only: bool,
    ) -> Result<BTreeMap<String, String>, Error> {
        let mut environment = if gateway_only {
            gateway_environment(document, self.secrets.as_ref(), directory)?
        } else {
            command_environment(document, self.secrets.as_ref(), directory)?
        };
        if let Some(target) = document.spec.gateway.as_kubernetes() {
            let state = std::path::absolute(&self.state_directory)
                .map_err(|_| Error::State("cannot resolve Kubernetes state directory"))?
                .join("kubernetes");
            environment.insert(
                crate::kubernetes::STATE_ENV.into(),
                state.to_string_lossy().into_owned(),
            );
            environment.extend(self.operation_environment.clone());
            let kubeconfig = crate::kubernetes::kubeconfig_path(
                environment
                    .get(&target.kubeconfig.env)
                    .ok_or(Error::State("explicit Kubernetes credential is missing"))?,
            )?
            .to_string_lossy()
            .into_owned();
            environment.insert(target.kubeconfig.env.clone(), kubeconfig.clone());
            environment.insert(
                crate::kubernetes::gateway::KUBECONFIG_ENV.into(),
                kubeconfig,
            );
        }
        Ok(environment)
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
        for (name, service) in &document.spec.services {
            let unauthenticated = match service {
                crate::services::ServiceDefinition::Ollama(service) => service.kubernetes.is_some(),
                crate::services::ServiceDefinition::Vllm(service) => {
                    service.kubernetes.is_some() && service.authentication.is_none()
                }
                crate::services::ServiceDefinition::OllamaProxy(_) => false,
            };
            if unauthenticated {
                (self.progress)(Progress::Warning {
                    message: format!(
                        "Cluster service {name} has no bearer authentication; access depends on NetworkPolicy enforcement, which the Kubernetes API cannot verify. Verify that the network plugin enforces the supervisor-only policy."
                    ),
                });
            }
        }
        for sandbox in &document.spec.sandboxes {
            if document.sandbox_harness(sandbox)?.kind.as_str() != "nvidia.fabric.openclaw" {
                continue;
            }
            let inference = document.scoped_inference(sandbox)?;
            for route in &inference.inference.routes {
                let provider = document.route_provider(route, &inference)?;
                let crate::config::InferenceTarget::Service { name } =
                    provider.definition.target()?
                else {
                    continue;
                };
                let context = match document.spec.services.get(name) {
                    Some(crate::services::ServiceDefinition::Vllm(service)) => {
                        service.serving.context_tokens
                    }
                    Some(crate::services::ServiceDefinition::Ollama(service)) => {
                        service.serving.context_tokens
                    }
                    _ => continue,
                };
                // A measured initial OpenClaw prompt used 19,947 tokens; this is
                // an advisory budget, not a universal adapter requirement.
                if context < 20_000 {
                    (self.progress)(Progress::Warning {
                        message: format!(
                            "OpenClaw sandbox {} route {} uses managed service {name} with serving.contextTokens={context}; its initial prompt can need about 20,000 tokens before reply tokens. Consider 32768 or more, align settings.model_metadata.contextWindow, and size model/GPU memory for that context.",
                            sandbox.name, route.name
                        ),
                    });
                }
            }
        }
        let (bundle, store) = self.open()?;
        let prior = store.load()?;
        let fresh = prior.is_none();
        let mut record = match prior {
            Some(record) => record,
            None => Record::new(document.clone())?,
        };
        if record.destroying() {
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
        let bindings = if (record.pending() && !record.runtime_pending())
            || record.digest != document.digest()
        {
            self.state_bindings(
                &bundle,
                &store,
                &record.document,
                &record.generations,
                false,
                cancel,
            )
            .await?
        } else {
            BTreeMap::new()
        };
        record.reconcile_pending_creations(&bindings);
        record.validate_pending_intent(&document)?;
        record.validate_bound_sandboxes(&document, &bindings)?;
        let connection = Some(DeploymentConnection {
            gateway_endpoint: document.spec.gateway.endpoint().into(),
            workspace: document.workspace(),
        });
        let (runtime_changes, deferred, runtime_discovery, mut discovery) = self
            .runtime_stage(&bundle, &store, &document, &mut record, apply, cancel)
            .await?;
        if deferred {
            let mut result = OperationResult::planned(runtime_changes);
            result.describe_sources(&document)?;
            result.deferred_resources = compile::targets(&document, &record.generations)?
                .into_iter()
                .filter(|target| !target.address.starts_with("data."))
                .map(|target| target.address)
                .collect();
            result.deferred_resources.sort();
            result.connection = connection;
            result.deferred = runtime_discovery;
            discovery.credentials =
                crate::inference_discovery::observe_credentials(&document, self.secrets.as_ref())?;
            append_credential_deferrals(&mut result.deferred, &discovery.credentials);
            discovery.gateway_target(&document);
            result.unverified = discovery.unverified();
            result.unverified.sort();
            result.unverified.dedup();
            result.discovery = discovery;
            result
                .deferred
                .push("OpenShell registration and sandbox require the managed gateway".into());
            return Ok(result);
        }
        let (operation, _connection) = self
            .connected(&document, &record.generations, cancel)
            .await?;
        let (graph, targets) =
            compile::deployment_graph(&document, &record.generations, &bundle.manifest.version)?;
        (operation.progress)(Progress::Validating);
        operation
            .initialize(&bundle, &store, &graph, cancel)
            .await?;
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
        (operation.progress)(Progress::Planning);
        let plan = operation
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
        result.describe_sources(&document)?;
        result.connection = connection;
        if !apply {
            let retained = compile::compile_teardown(
                &document,
                &record.generations,
                &bundle.manifest.version,
                &bindings.keys().cloned().collect(),
                false,
            )?
            .retained;
            discovery.extend(plan.discovery_report(
                DiscoveryScope::Deployment,
                &bindings,
                &retained,
            )?);
            discovery.credentials =
                crate::inference_discovery::observe_credentials(&document, self.secrets.as_ref())?;
            result.deferred = if discovery.observations.is_empty() {
                let mut deferred = runtime_discovery;
                deferred.extend(plan.discovery_deferred(&discovery));
                deferred
            } else {
                discovery.deferred()
            };
            append_credential_deferrals(&mut result.deferred, &discovery.credentials);
            discovery.gateway_target(&document);
            result.unverified = discovery.unverified();
            result.unverified.sort();
            result.unverified.dedup();
            result.discovery = discovery;
            result.deferred.sort();
            result.deferred.dedup();
            if fresh {
                store.save(&record)?;
            }
            return Ok(result);
        }
        record.begin_apply(&document, creations);
        store.save(&record)?;
        (operation.progress)(Progress::Applying);
        let applied = operation
            .tofu(
                &bundle,
                &store,
                &document,
                &["apply", "-input=false", "-no-color", "apply.plan"],
                cancel,
            )
            .await;
        let mutations_settled = applied.is_ok();
        if mutations_settled {
            // Persist known mutation completion before an interruptible health read.
            record.finish_apply();
            store.save(&record)?;
        }
        let applied = match applied {
            Err(error) if apply::readiness_failures(&error).is_none() => return Err(error),
            applied => applied,
        };
        let observations = operation
            .sandbox_observations(&bundle, &store, &document, &plan, cancel)
            .await;
        let health = match apply::ApplyOutcome::classify(applied, observations) {
            apply::ApplyOutcome::Unsettled(error) => return Err(error),
            apply::ApplyOutcome::Settled(health) => health,
        };
        if !mutations_settled {
            record.finish_apply();
            store.save(&record)?;
        }
        result.health = health?;
        record.mark_succeeded();
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
    ) -> Result<apply::Readiness, Error> {
        let bytes = self
            .tofu(bundle, store, document, &["show", "-json"], cancel)
            .await?;
        apply::Readiness::decode(document, plan, &bytes)
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
        .map_err(Into::into)
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
                self.provider_environment(document, &store.directory, false)?
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
    if let Some(kubernetes) = gateway.as_kubernetes() {
        names.insert(kubernetes.kubeconfig.env.as_str());
        names.extend(kubernetes.environment.iter().map(String::as_str));
    }
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
        if [
            "TF_",
            "TOFU_",
            "PLUGIN_",
            "HELM_",
            "KUBE_",
            "NEMOCLAW_INTERNAL_",
            "NEMOCLAW_MANAGED_K8S_",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
            || name == "CHECKPOINT_DISABLE"
            || name == crate::kubernetes::STATE_ENV
        {
            return Err(Error::Conflict(
                "credential reference conflicts with a reserved runtime control variable",
            ));
        }
        env.insert(name.into(), secrets.resolve(name)?);
    }
    Ok(env)
}

fn append_credential_deferrals(
    deferred: &mut Vec<String>,
    credentials: &[crate::inference_discovery::CredentialObservation],
) {
    for credential in credentials {
        if credential.status != crate::discovery::ObservationStatus::Available {
            deferred.push(format!(
                "Credential reference {} is unavailable or unverified; resolve it before apply.",
                credential.reference
            ));
        }
    }
}
