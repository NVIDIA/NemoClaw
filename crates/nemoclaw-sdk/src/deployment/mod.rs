// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

mod plan;
mod runtime;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    Preflight,
    Planning,
    Applying,
    Readiness,
    Exporting,
    Destroying,
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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent_response: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retained: Vec<String>,
}
impl OperationResult {
    fn planned(changes: Vec<Change>) -> Self {
        Self {
            outcome: Outcome::Planned,
            changes,
            deferred: Vec::new(),
            agent_response: String::new(),
            retained: Vec::new(),
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
        let bundle = Bundle::open(&self.bundle_directory)?;
        let state = std::path::absolute(&self.state_directory)
            .map_err(|_| Error::State("cannot resolve state directory"))?;
        Ok((bundle, Store::open(&state)?))
    }
    pub async fn plan(
        &self,
        document: &Document,
        cancel: &CancellationToken,
    ) -> Result<OperationResult, Error> {
        self.run(document, cancel, false).await
    }
    pub async fn apply(
        &self,
        document: &Document,
        cancel: &CancellationToken,
    ) -> Result<OperationResult, Error> {
        self.run(document, cancel, true).await
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
        self.require_no_ollama(&document)?;
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
        let allowed = allowed(&targets);
        if bindings
            .iter()
            .any(|(address, binding)| !allowed.contains_key(address) || !binding.spec.is_empty())
        {
            return Err(Error::Conflict(
                "undeclared resource binding in deployment state",
            ));
        }
        (self.progress)(Progress::Preflight);
        tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=self.preflight(&client,&document,&targets,&bindings)=>result?}
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
        (self.progress)(Progress::Planning);
        let plan = self
            .saved_plan(&bundle, &store, &document, "apply.plan", cancel)
            .await?;
        let mut changes = runtime_changes;
        changes.extend(check_plan(&plan, &allowed, &bindings)?);
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
        let mut sandbox = targets[3].values.clone();
        sandbox.insert(
            "id".into(),
            bindings
                .get(&targets[3].address)
                .ok_or(Error::State("sandbox has no established identity"))?
                .id
                .clone(),
        );
        (self.progress)(Progress::Readiness);
        client.ready(&sandbox, cancel).await?;
        tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=client.inference_ready(&sandbox)=>result?}
        if document.spec.inference_providers[0].service.is_some() {
            result.agent_response = tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=client.agent_response(&sandbox)=>result?};
        }
        record.succeeded = true;
        store.save(&record)?;
        result.outcome = Outcome::Succeeded;
        Ok(result)
    }
    fn require_no_ollama(&self, document: &Document) -> Result<(), Error> {
        if document.spec.inference_providers[0].ollama.is_some() {
            return Err(Error::Conflict(
                "managed runtime orchestration is not implemented in this Rust slice yet",
            ));
        }
        Ok(())
    }
    async fn preflight(
        &self,
        client: &OpenShell,
        document: &Document,
        targets: &[Target],
        bindings: &BTreeMap<String, StateBinding>,
    ) -> Result<(), Error> {
        client
            .verify_gateway(&document.spec.sandboxes[0].runtime.provider)
            .await?;
        for target in targets {
            let mut expected = target.values.clone();
            if let Some(binding) = bindings.get(&target.address) {
                expected.insert("id".into(), binding.id.clone());
            }
            match client.read(&target.kind, &expected, false).await? {
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
        let env = command_environment(document, self.secrets.as_ref(), &store.directory)?;
        crate::process::run(&store.directory, &bundle.tofu(), args, &env, cancel).await
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
    pub async fn export(&self, cancel: &CancellationToken) -> Result<Document, Error> {
        let (_, store) = self.open()?;
        let record = store.load()?.ok_or(Error::Conflict(
            "export requires established resource bindings",
        ))?;
        if record.pending || record.destroying || record.destroyed {
            return Err(Error::Conflict(
                "export requires established bindings; reconcile unfinished operations first",
            ));
        }
        self.require_no_ollama(&record.document)?;
        self.export_runtime(&store, &record, cancel).await?;
        (self.progress)(Progress::Exporting);
        let client = OpenShell::connect(&record.document.spec.gateway, self.secrets.clone())?;
        let bindings = store.bindings()?;
        let mut document = record.document;
        for target in compile::targets(&document, &record.generations)? {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let mut expected = target.values;
            expected.insert(
                "id".into(),
                bindings
                    .get(&target.address)
                    .ok_or(Error::Conflict("resource has no durable state identity"))?
                    .id
                    .clone(),
            );
            let observed =
                client
                    .read(&target.kind, &expected, false)
                    .await?
                    .ok_or(Error::Conflict(
                        "resource is confirmed absent; no configuration exported",
                    ))?;
            verify_identity(&expected, &observed)?;
            match target.kind.as_str() {
                "provider" => {
                    if observed["provider_type"] != expected["provider_type"] {
                        return Err(Error::Conflict("provider type drift requires inspection"));
                    }
                    if document.spec.inference_providers[0].service.is_some() {
                        if observed["endpoint"] != document.inference_endpoint()
                            || !observed["credential_env"].is_empty()
                        {
                            return Err(Error::Conflict("managed inference registration drifted"));
                        }
                    } else {
                        document.spec.inference_providers[0].endpoint =
                            observed["endpoint"].clone();
                    }
                    document.spec.inference_providers[0].credential =
                        (!observed["credential_env"].is_empty()).then(|| Credential {
                            env: observed["credential_env"].clone(),
                        });
                }
                "route" => {
                    if observed["provider_name"] != document.spec.inference_providers[0].name {
                        return Err(Error::Conflict(
                            "route references a provider outside this deployment",
                        ));
                    }
                    document.spec.sandboxes[0].agents[0].inference.routes[0]
                        .overrides
                        .model = observed["model"].clone();
                }
                "sandbox" => {
                    if ["image", "agent_name", "agent_runtime"]
                        .iter()
                        .any(|key| observed.get(*key) != expected.get(*key))
                    {
                        return Err(Error::Conflict(
                            "sandbox configuration drift requires inspection",
                        ));
                    }
                    client.configuration(&expected).await?;
                }
                _ => {}
            }
        }
        document.validate()?;
        Ok(document)
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
