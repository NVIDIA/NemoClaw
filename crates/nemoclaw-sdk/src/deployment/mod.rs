// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

mod context_advisory;
mod export;
mod opentofu;
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
    /// Authored definition paths for opaque, scoped provider registrations.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub resource_sources: BTreeMap<String, ResourceSource>,
    /// Supplemental checks that do not make a resource plan incomplete.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unverified: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retained: Vec<String>,
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
            resource_sources: BTreeMap::new(),
            unverified: Vec::new(),
            retained: Vec::new(),
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
    /// Shared by clones, so a deployment hashes an unchanged bundle once.
    bundle: Arc<crate::bundle::VerifiedBundle>,
}
impl Deployment {
    pub fn new(state_directory: &Path, bundle_directory: &Path) -> Self {
        Self {
            state_directory: state_directory.into(),
            bundle_directory: bundle_directory.into(),
            secrets: Arc::new(EnvironmentSecrets),
            progress: Arc::new(|_| {}),
            bundle: Arc::default(),
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
            self.bundle.open(&self.bundle_directory),
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
        for message in context_advisory::context_warnings(&document)? {
            (self.progress)(Progress::Warning { message });
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
        record.allocate_missing_generations(&document)?;
        let bindings = if record.pending() || record.digest != document.digest() {
            self.state_bindings(
                &bundle,
                &store,
                &record.document,
                &record.generations,
                cancel,
            )
            .await?
        } else {
            BTreeMap::new()
        };
        record.reconcile_pending_creations(&bindings);
        record.validate_pending_intent(&document)?;
        let connection = Some(DeploymentConnection {
            gateway_endpoint: document.spec.gateway.endpoint().into(),
            workspace: document.workspace(),
        });
        let compiled =
            compile::deployment_graph(&document, &record.generations, &bundle.manifest.version)?;
        (self.progress)(Progress::Validating);
        self.initialize(&bundle, &store, &compiled.graph, cancel)
            .await?;
        let bindings = store.bindings(&bundle.tofu(), cancel).await?;
        let expected = expected_bindings(&compiled, &bindings)?;
        (self.progress)(Progress::Planning);
        let plan = self
            .saved_plan(&bundle, &store, &document, "apply.plan", cancel)
            .await?;
        runtime::preserve_docker_models(&document, &plan)?;
        let changes = check_plan(
            &plan,
            &with_observations(&expected, &compile::observations(&compiled.graph)),
            &bindings,
        )?;
        // Only OpenShell and Fabric creations can lose their identity with a
        // lost reply; OpenTofu saves every other resource's ID.
        let objects = allowed(&compiled.objects);
        let creations = changes
            .iter()
            .filter(|change| {
                objects.contains_key(&change.resource)
                    && !plan::disposable(&change.resource)
                    && change.actions.iter().any(|action| action == "create")
            })
            .map(|change| (change.resource.clone(), objects[&change.resource].clone()))
            .collect();
        let mut result = OperationResult::planned(changes);
        result.describe_sources(&document)?;
        result.connection = connection;
        if !apply {
            let retained = compile::compile_teardown(
                &document,
                &record.generations,
                &bundle.manifest.version,
                &bindings.keys().cloned().collect(),
            )?
            .retained;
            let runtime: BTreeSet<String> = compiled
                .runtime
                .iter()
                .map(|target| target.address.clone())
                .collect();
            let mut discovery = plan.discovery_report(&runtime, &bindings, &retained)?;
            discovery.credentials =
                crate::inference_discovery::observe_credentials(&document, self.secrets.as_ref())?;
            result.deferred = if discovery.observations.is_empty() {
                plan.discovery_deferred(&discovery)
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
        let earlier = record.pending_creation_addresses();
        record.begin_apply(&document, creations);
        store.save(&record)?;
        (self.progress)(Progress::Applying);
        // OpenTofu reports each resource apply as it starts; a failure stops it
        // before the resources that depend on what failed.
        let started: Arc<std::sync::Mutex<(BTreeSet<String>, bool)>> = Arc::default();
        let observed = {
            let (progress, started) = (self.progress.clone(), started.clone());
            self.clone().with_progress(Arc::new(move |event: Progress| {
                if let Progress::Resource {
                    address,
                    action: "create" | "replace",
                    status: "started",
                    ..
                } = &event
                {
                    let mut started = started.lock().expect("started creations");
                    match address {
                        Some(address) => {
                            started.0.insert(address.clone());
                        }
                        // An unreported address could be any pending creation.
                        None => started.1 = true,
                    }
                }
                progress(event)
            }))
        };
        let applied = observed
            .tofu(
                &bundle,
                &store,
                &document,
                &["apply", "-input=false", "-no-color", "apply.plan"],
                cancel,
            )
            .await;
        let mutations_settled = applied.is_ok();
        if !mutations_settled {
            let (started, unreported) = &*started.lock().expect("started creations");
            if !unreported {
                record.forget_unstarted_creations(&earlier, started);
                store.save(&record)?;
            }
        }
        applied?;
        record.finish_apply();
        record.mark_succeeded();
        store.save(&record)?;
        result.outcome = Outcome::Succeeded;
        Ok(result)
    }
    async fn state_bindings(
        &self,
        bundle: &Bundle,
        store: &Store,
        document: &Document,
        generations: &compile::Generations,
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
        let graph = compile::compile(document, generations, &bundle.manifest.version)?;
        self.initialize(bundle, store, &graph, cancel).await?;
        store.bindings(&bundle.tofu(), cancel).await
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
        self.teardown_deployment(cancel, preview).await
    }
}
/// The rows a plan may establish. Managed processes keep their bound
/// specifications; every saved binding must belong to the deployment.
fn expected_bindings(
    compiled: &compile::Compiled,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<BTreeMap<String, Row>, Error> {
    let objects = allowed(&compiled.objects);
    if bindings
        .iter()
        .any(|(address, binding)| objects.contains_key(address) && !binding.spec.is_empty())
    {
        return Err(Error::Conflict(
            "undeclared resource binding in deployment state",
        ));
    }
    let runtime: BTreeMap<String, StateBinding> = bindings
        .iter()
        .filter(|(address, _)| !objects.contains_key(*address) && !plan::reconstructible(address))
        .map(|(address, binding)| (address.clone(), binding.clone()))
        .collect();
    let mut expected = runtime::runtime_bindings(&compiled.runtime, &runtime)?;
    expected.extend(objects);
    Ok(expected)
}

fn allowed(targets: &[Target]) -> BTreeMap<String, Row> {
    targets
        .iter()
        .map(|target| (target.address.clone(), target.values.clone()))
        .collect()
}

/// The addresses a plan may contain: the compiled targets and the observations the graph reads.
fn with_observations(
    expected: &BTreeMap<String, Row>,
    observations: &BTreeSet<String>,
) -> BTreeMap<String, Row> {
    let mut expected = expected.clone();
    for address in observations {
        expected.entry(address.clone()).or_default();
    }
    expected
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
