// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

mod apply;
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
            operation_environment: BTreeMap::new(),
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
        let root_changes = check_plan(
            &plan,
            &with_observations(&allowed, &compile::observations(&graph)),
            &bindings,
        )?;
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
