// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

mod export;
mod ollama;
mod plan;
mod runtime;
use crate::{
    Binding, CancellationToken, Error,
    backend::{Backend, Row},
    bundle::Bundle,
    compile::{self, Target},
    config::{Credential, Document},
    openshell::{EnvironmentSecrets, OpenShell, Secrets, verify_identity},
    state::{Record, StateBinding, Store, atomic_write, save_json},
    voice::{
        AccessGrant, Bootstrap, CloseReason, ConnectionState, ServerConfig, SystemClock,
        TargetProbe, VoiceServer,
    },
};
use async_trait::async_trait;
use plan::{Plan, check_destroy_plan, check_plan};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use time::OffsetDateTime;

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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub integrations: Vec<IntegrationResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationResult {
    pub name: String,
    pub status: String,
    pub process_lifecycle: String,
    pub reason: String,
}
impl OperationResult {
    fn planned(changes: Vec<Change>) -> Self {
        Self {
            outcome: Outcome::Planned,
            changes,
            deferred: Vec::new(),
            agent_response: String::new(),
            retained: Vec::new(),
            integrations: Vec::new(),
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
    voiceclaw: Option<Bootstrap>,
}
impl Deployment {
    pub fn new(state_directory: &Path, bundle_directory: &Path) -> Self {
        Self {
            state_directory: state_directory.into(),
            bundle_directory: bundle_directory.into(),
            secrets: Arc::new(EnvironmentSecrets),
            progress: Arc::new(|_| {}),
            engines: crate::docker::Connections::default(),
            voiceclaw: None,
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
    pub fn with_voiceclaw(mut self, bootstrap: Bootstrap) -> Self {
        self.voiceclaw = Some(bootstrap);
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
        if document.spec.inference_providers[0].ollama.is_some()
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
        tokio::select! { ()=cancel.cancelled()=>return Err(Error::Cancelled), result=self.preflight_ollama(&document, &record.generations, &bindings)=>result? }
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
        let agent = &document.spec.sandboxes[0].agents[0];
        if !fresh
            && agent.harness == "pi"
            && agent.inference.routes[0].overrides
                != record.document.spec.sandboxes[0].agents[0].inference.routes[0].overrides
        {
            changes.push(Change {
                resource: format!("fabric_runtime.{}", agent.name),
                actions: vec!["update".into()],
            });
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
        if agent.harness == "pi"
            && let Some(binding) = bindings.get(&targets[3].address)
        {
            let mut sandbox = targets[3].values.clone();
            sandbox.insert("id".into(), binding.id.clone());
            sandbox.insert(
                "pi_model_config".into(),
                serde_json::to_string(&agent.inference.routes[0].overrides)
                    .map_err(|_| Error::State("cannot encode Pi model configuration"))?,
            );
            tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=client.configure_pi(&sandbox, true)=>result?}
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
        let agent = &document.spec.sandboxes[0].agents[0];
        if agent.harness == "pi" {
            sandbox.insert(
                "pi_model_config".into(),
                serde_json::to_string(&agent.inference.routes[0].overrides)
                    .map_err(|_| Error::State("cannot encode Pi model configuration"))?,
            );
            tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=client.configure_pi(&sandbox, false)=>result?}
        }
        client.ready(&sandbox, cancel).await?;
        tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=client.inference_ready(&sandbox)=>result?}
        if document.spec.inference_providers[0].service.is_some() {
            result.agent_response = tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=client.agent_response(&sandbox)=>result?};
        }
        record.succeeded = true;
        store.save(&record)?;
        if let Some(integration) = document.spec.integrations.first() {
            let bootstrap = self.voiceclaw.as_ref().ok_or(Error::Conflict(
                "VoiceClaw integration requires an operator-approved bootstrap path; agent retained",
            ))?;
            bootstrap.prepare(&store.directory, cancel).await?;

            let bindings = store.bindings()?;
            let mut current = targets[3].values.clone();
            let established = bindings
                .get(&targets[3].address)
                .ok_or(Error::State("sandbox has no established identity"))?;
            current.insert("id".into(), established.id.clone());
            if client.voice_ready(&current).await != crate::voice::ProbeResult::Ready {
                return Err(Error::Conflict(
                    "VoiceClaw target revalidation failed; agent retained",
                ));
            }
            let owner = format!("{}/{}", document.metadata.uid, integration.name);
            let generation = current
                .get("generation")
                .ok_or(Error::State("sandbox generation is unavailable"))?;
            let native_id = current
                .get("id")
                .ok_or(Error::State("sandbox identity is unavailable"))?;
            let authority = Binding::new(&owner, generation, native_id)?;
            let target_ref = voice_target_ref(&owner, generation, native_id);
            let grant =
                AccessGrant::issue(&target_ref, authority.clone(), OffsetDateTime::now_utc())
                    .map_err(|_| Error::State("cannot issue VoiceClaw access"))?;
            let probe = Arc::new(DeploymentVoiceProbe {
                client: client.clone(),
                sandbox: current,
                authority,
            });
            let server = VoiceServer::bind(
                "127.0.0.1:0".parse().expect("fixed loopback address"),
                &grant,
                probe,
                Arc::new(SystemClock),
                ServerConfig::default(),
            )
            .await
            .map_err(|_| Error::State("cannot start private VoiceClaw semantic server"))?;
            let ready = bootstrap
                .connect(&store.directory, server.endpoint(), &grant, cancel)
                .await?;
            if !matches!(
                server.connection_state(),
                ConnectionState::Connected | ConnectionState::Closed(_)
            ) {
                return Err(Error::Conflict(
                    "VoiceClaw reported ready without a semantic connection; agent retained",
                ));
            }
            drop(ready);
            drop(grant);
            let run_cancel = CancellationToken::new();
            let reason = tokio::select! {
                result = server.wait_for_run(&run_cancel) => result?,
                () = cancel.cancelled() => {
                    server.stop();
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        server.wait_for_run(&run_cancel),
                    ).await;
                    return Err(Error::Cancelled);
                }
            };
            result.integrations.push(IntegrationResult {
                name: integration.name.clone(),
                status: "disconnected".into(),
                process_lifecycle: "not-managed".into(),
                reason: close_reason(reason).into(),
            });
        }
        result.outcome = Outcome::Succeeded;
        Ok(result)
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

struct DeploymentVoiceProbe {
    client: OpenShell,
    sandbox: Row,
    authority: Binding,
}

#[async_trait]
impl TargetProbe for DeploymentVoiceProbe {
    async fn probe(&self, authority: &Binding) -> crate::voice::ProbeResult {
        if authority != &self.authority {
            return crate::voice::ProbeResult::Replaced;
        }
        self.client.voice_ready(&self.sandbox).await
    }

    async fn dispatch(&self, authority: &Binding) -> crate::voice::DispatchResult {
        if authority != &self.authority {
            return crate::voice::DispatchResult::TargetReplaced;
        }
        self.client.voice_response(&self.sandbox).await
    }
}

fn voice_target_ref(owner: &str, generation: &str, native_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    for value in [owner, generation, native_id] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    format!(
        "nvr0-{}",
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn close_reason(reason: CloseReason) -> &'static str {
    match reason {
        CloseReason::ClientDisconnected => "client_disconnected",
        CloseReason::CredentialExpired => "credential_expired",
        CloseReason::AgentUnavailable => "agent_unavailable",
        CloseReason::TargetReplaced => "target_replaced",
        CloseReason::ServerStopping => "server_stopping",
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
