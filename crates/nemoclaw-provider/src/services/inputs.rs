// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Setup-only delivery through an owned, bounded, offline initializer.
use crate::{Backend, Error, Mutation, ObservationError, Row};
use async_trait::async_trait;
use bollard::{
    models::{ContainerInspectResponse, ImageInspect},
    query_parameters::{
        AttachContainerOptions, CreateContainerOptions, DownloadFromContainerOptions,
        RemoveContainerOptions, StopContainerOptions,
    },
};
use futures_util::StreamExt;
use nemoclaw_container_inputs::{
    Completion, ENTRYPOINT, InputFile, MARKER, MAX_CREDENTIAL_BYTES, MAX_DESCRIPTOR_BYTES,
    MAX_REQUEST_BYTES, ROOT, Request, Role,
};
use nemoclaw_sdk::{
    managed::{GENERATION_LABEL, OWNER_LABEL},
    services::installers::container::inputs::InputsSpec,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    io::Read,
    time::Duration,
};
use tokio::io::AsyncWriteExt;
const INPUT_LABEL: &str = "nemoclaw.nvidia.com/input-spec";

pub(crate) fn definition() -> crate::Definition {
    super::schema_definition(nemoclaw_sdk::services::installers::container::inputs::INPUTS_KIND)
        .validate_spec(nemoclaw_sdk::services::validate_resource_spec)
        .computed("complete", crate::rerun_when_stopped)
        .computed("id", input_identity)
}

fn input_identity(name: &str, prior: &crate::State) -> Option<tf_provider::value::Value<String>> {
    use tf_provider::value::Value;
    if prior.get("complete") == Some(&Value::Value("false".into())) {
        Some(Value::Unknown)
    } else {
        crate::carry_prior(name, prior)
    }
}

fn setup_environment_is_safe(environment: Option<&[String]>) -> bool {
    // Docker supplies PATH even for scratch images; the helper uses an absolute entrypoint.
    environment.is_none_or(|values| {
        values.is_empty()
            || values.len() == 1
                && values[0] == "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    })
}

pub(crate) fn validate_image(
    image: &bollard::models::ImageInspect,
    spec: &nemoclaw_sdk::managed::Spec,
) -> Result<(), Error> {
    use nemoclaw_container_inputs::{CONTRACT_LABEL, CONTRACT_VERSION, ENTRYPOINT};
    let config = image.config.as_ref().ok_or(ObservationError::Incomplete)?;
    let process = spec.process.as_ref().ok_or(ObservationError::Incomplete)?;
    if image.id.as_ref().is_none_or(String::is_empty)
        || image.os.as_deref() != Some("linux")
        || image.architecture.as_deref() != Some(process.architecture.as_str())
        || config
            .labels
            .as_ref()
            .and_then(|labels| labels.get(CONTRACT_LABEL))
            .map(String::as_str)
            != Some(CONTRACT_VERSION)
        || config
            .entrypoint
            .as_ref()
            .is_none_or(|parts| parts != &[ENTRYPOINT.to_owned()])
        || !setup_environment_is_safe(config.env.as_deref())
        || config.volumes.as_ref().is_some_and(|v| !v.is_empty())
    {
        return Err(Error::Conflict(
            "input setup image is incompatible; preload the pinned NemoClaw setup image for this platform",
        ));
    }
    Ok(())
}

pub struct InputsBackend {
    engine: crate::docker::Engine,
    secrets: std::sync::Arc<dyn nemoclaw_sdk::Secrets>,
}
impl InputsBackend {
    pub fn new(engine: crate::docker::Engine) -> Self {
        Self {
            engine,
            secrets: std::sync::Arc::new(nemoclaw_sdk::EnvironmentSecrets),
        }
    }
    #[cfg(all(test, unix))]
    fn with_secrets(mut self, secrets: std::sync::Arc<dyn nemoclaw_sdk::Secrets>) -> Self {
        self.secrets = secrets;
        self
    }
    fn spec(&self, row: &Row) -> Result<InputsSpec, Error> {
        let spec: InputsSpec = serde_json::from_str(
            row.get("spec")
                .ok_or(Error::State("missing application inputs"))?,
        )
        .map_err(|_| Error::State("invalid application inputs"))?;
        spec.validate()?;
        spec.descriptor(
            row.get("sandbox_id")
                .ok_or(Error::State("missing application binding"))?,
        )?;
        if self.engine.endpoint() != spec.process.engine() {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(spec)
    }
    fn payload(&self, spec: &InputsSpec, row: &Row) -> Result<Vec<u8>, Error> {
        let (uid, gid) = owner(spec);
        let root = &spec.process.process.as_ref().unwrap().mount_target;
        let mut files = Vec::new();
        for secret in spec.secrets.values() {
            files.push(InputFile {
                path: secret.target_path[root.len() + 1..].into(),
                role: Role::Credential,
                content: self.secrets.resolve(&secret.credential.env)?,
            });
        }
        if let Some((path, descriptor)) = spec.descriptor(&row["sandbox_id"])? {
            files.push(InputFile {
                path: path[root.len() + 1..].into(),
                role: Role::Descriptor,
                content: serde_json::to_string(&descriptor)
                    .map_err(|_| Error::State("invalid application descriptor"))?,
            });
        }
        let request = Request {
            uid,
            gid,
            completion: completion(spec, row),
            files,
        };
        request
            .validate()
            .map_err(|_| ObservationError::Authentication)?;
        let bytes = serde_json::to_vec(&request)
            .map_err(|_| Error::State("cannot encode application inputs"))?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(ObservationError::Authentication.into());
        }
        Ok(bytes)
    }
    async fn image(&self, spec: &InputsSpec) -> Result<ImageInspect, Error> {
        let image = self
            .engine
            .image(&spec.setup.image)
            .await?
            .ok_or(Error::Conflict(
                "input setup image is absent; preload the pinned image in the selected engine",
            ))?;
        validate_image(&image, &spec.process)?;
        Ok(image)
    }
    async fn volume(&self, spec: &InputsSpec) -> Result<(), Error> {
        let volume = self
            .engine
            .volume(&spec.process.volume())
            .await?
            .ok_or(Error::State("owned application input volume is absent"))?;
        if volume.name != spec.process.volume()
            || volume.driver != "local"
            || !volume.options.is_empty()
            || volume.labels.get(OWNER_LABEL) != Some(&spec.process.owner)
            || volume.labels.get(GENERATION_LABEL) != Some(&spec.process.generation)
        {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(())
    }
    async fn container(
        &self,
        spec: &InputsSpec,
        row: &Row,
        removing: bool,
    ) -> Result<Option<ContainerInspectResponse>, Error> {
        let Some(container) = self.engine.container(&spec.helper_name()).await? else {
            return Ok(None);
        };
        identity(spec, row, &container)?;
        if !removing {
            self.volume(spec).await?;
            if container.image.as_deref() != self.image(spec).await?.id.as_deref() {
                return Err(ObservationError::BindingMismatch.into());
            }
        }
        Ok(Some(container))
    }
    async fn application_stopped(&self, spec: &InputsSpec) -> Result<(), Error> {
        if let Some(application) = self.engine.container(&spec.process.name).await? {
            let labels = application
                .config
                .as_ref()
                .and_then(|c| c.labels.as_ref())
                .ok_or(ObservationError::Incomplete)?;
            if labels.get(OWNER_LABEL) != Some(&spec.process.owner)
                || labels.get(GENERATION_LABEL) != Some(&spec.process.generation)
            {
                return Err(ObservationError::BindingMismatch.into());
            }
            if application.state.as_ref().and_then(|s| s.running) != Some(false) {
                return Err(Error::Conflict(
                    "incomplete application inputs cannot be rewritten while the application is running; stop it explicitly and retry",
                ));
            }
        }
        Ok(())
    }
    async fn download(
        &self,
        id: &str,
        path: &str,
        limit: usize,
        metadata: bool,
    ) -> Result<Option<Vec<u8>>, Error> {
        let work = async {
            let mut stream = self.engine.api.download_from_container(
                id,
                Some(DownloadFromContainerOptions { path: path.into() }),
            );
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(chunk) => {
                        if metadata {
                            let take = chunk.len().min(512usize.saturating_sub(bytes.len()));
                            bytes.extend_from_slice(&chunk[..take]);
                            if bytes.len() == 512 {
                                return Ok(Some(bytes));
                            }
                        } else {
                            if chunk.len() > (limit + 8192).saturating_sub(bytes.len()) {
                                return Err(ObservationError::Incomplete.into());
                            }
                            bytes.extend_from_slice(&chunk);
                        }
                    }
                    Err(e) if nemoclaw_docker::is_missing(&e) && bytes.is_empty() => {
                        return Ok(None);
                    }
                    Err(e) => return Err(crate::docker::remote(&e)),
                }
            }
            Ok(Some(bytes))
        };
        tokio::time::timeout(Duration::from_secs(20), work)
            .await
            .map_err(|_| ObservationError::Transport)?
    }
    async fn file(
        &self,
        id: &str,
        path: &str,
        spec: &InputsSpec,
        limit: usize,
        directory: bool,
    ) -> Result<Option<Vec<u8>>, Error> {
        let Some(bytes) = self.download(id, path, limit, directory).await? else {
            return Ok(None);
        };
        let mut archive = tar::Archive::new(bytes.as_slice());
        let mut entries = archive
            .entries()
            .map_err(|_| ObservationError::Incomplete)?;
        let mut entry = entries
            .next()
            .ok_or(ObservationError::Incomplete)?
            .map_err(|_| ObservationError::Incomplete)?;
        let header = entry.header();
        let (uid, gid) = owner(spec);
        if header.uid().ok() != Some(uid as u64)
            || header.gid().ok() != Some(gid as u64)
            || header.mode().ok() != Some(if directory { 0o700 } else { 0o600 })
            || if directory {
                !header.entry_type().is_dir() || header.size().ok() != Some(0)
            } else {
                !header.entry_type().is_file()
                    || header
                        .size()
                        .ok()
                        .is_none_or(|size| size == 0 || size > limit as u64)
            }
            || entry
                .pax_extensions()
                .map_err(|_| ObservationError::Incomplete)?
                .is_some()
        {
            return Err(Error::State(
                "unsafe protected input metadata; resources retained",
            ));
        }
        if directory {
            return Ok(Some(vec![]));
        }
        let mut value = Vec::new();
        entry
            .read_to_end(&mut value)
            .map_err(|_| ObservationError::Incomplete)?;
        if value.is_empty() || value.len() > limit || entries.next().is_some() {
            return Err(ObservationError::Incomplete.into());
        }
        Ok(Some(value))
    }
    async fn complete(
        &self,
        container: &ContainerInspectResponse,
        spec: &InputsSpec,
        row: &Row,
    ) -> Result<bool, Error> {
        let state = container
            .state
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if state.running != Some(false)
            || state.status.as_ref().map(ToString::to_string).as_deref() != Some("exited")
            || state.exit_code != Some(0)
        {
            return Ok(false);
        }
        let id = container
            .id
            .as_deref()
            .ok_or(ObservationError::Incomplete)?;
        let Some(marker) = self
            .file(id, &format!("{ROOT}/{MARKER}"), spec, 4096, false)
            .await?
        else {
            return Ok(false);
        };
        if marker != serde_json::to_vec(&completion(spec, row)).expect("nonsecret completion") {
            return Err(ObservationError::BindingMismatch.into());
        }
        let mut directories = BTreeSet::from([ROOT.to_owned()]);
        for path in spec
            .secrets
            .values()
            .map(|s| s.target_path.as_str())
            .chain(spec.connections.values().map(|c| c.target_path.as_str()))
        {
            let relative = &path[spec.process.process.as_ref().unwrap().mount_target.len() + 1..];
            let mut prefix = ROOT.to_owned();
            for part in relative.split('/').take(relative.split('/').count() - 1) {
                prefix.push('/');
                prefix.push_str(part);
                directories.insert(prefix.clone());
            }
        }
        for path in directories {
            if self.file(id, &path, spec, 0, true).await?.is_none() {
                return Ok(false);
            }
        }
        for secret in spec.secrets.values() {
            let path = format!("{ROOT}/{}", relative(spec, &secret.target_path));
            let Some(value) = self
                .file(id, &path, spec, MAX_CREDENTIAL_BYTES, false)
                .await?
            else {
                return Ok(false);
            };
            if !std::str::from_utf8(&value).is_ok_and(nemoclaw_container_inputs::credential) {
                return Err(ObservationError::Authentication.into());
            }
        }
        if let Some((path, descriptor)) = spec.descriptor(&row["sandbox_id"])? {
            let Some(value) = self
                .file(
                    id,
                    &format!("{ROOT}/{}", relative(spec, &path)),
                    spec,
                    MAX_DESCRIPTOR_BYTES,
                    false,
                )
                .await?
            else {
                return Ok(false);
            };
            if value != serde_json::to_vec(&descriptor).expect("nonsecret descriptor") {
                return Err(ObservationError::BindingMismatch.into());
            }
        }
        Ok(true)
    }
    async fn create(&self, spec: &InputsSpec, row: &Row) -> Result<String, Error> {
        let (uid, gid) = owner(spec);
        let config=serde_json::from_value(json!({
            "Image":spec.setup.image,"User":"0:0","Env":[],"Entrypoint":[ENTRYPOINT],"Cmd":["install",uid.to_string(),gid.to_string()],
            "Labels":labels(spec,row)?,"AttachStdin":true,"AttachStdout":true,"AttachStderr":true,"OpenStdin":true,"StdinOnce":true,"Tty":false,"Healthcheck":{"Test":["NONE"]},
            "HostConfig":{"NetworkMode":"none","IpcMode":"private","PidMode":"","ReadonlyRootfs":true,"Privileged":false,
                "CapDrop":["ALL"],"CapAdd":["CHOWN","FOWNER","DAC_OVERRIDE"],"SecurityOpt":["no-new-privileges:true"],
                "RestartPolicy":{"Name":"no"},"LogConfig":{"Type":"none","Config":{}},"Memory":134217728,"PidsLimit":16,
                "Mounts":[{"Type":"volume","Source":spec.process.volume(),"Target":ROOT,"VolumeOptions":{"NoCopy":true}}]}
        })).map_err(|_|Error::State("invalid setup container configuration"))?;
        let created = self
            .engine
            .api
            .create_container(
                Some(CreateContainerOptions {
                    name: Some(spec.helper_name()),
                    ..Default::default()
                }),
                config,
            )
            .await
            .map_err(|e| crate::docker::remote(&e))?;
        if created.id.is_empty() {
            return Err(ObservationError::Incomplete.into());
        }
        Ok(created.id)
    }
    async fn execute(&self, id: &str, spec: &InputsSpec, payload: &[u8]) -> Result<(), Error> {
        let mut attached = self
            .engine
            .api
            .attach_container(
                id,
                Some(AttachContainerOptions {
                    stream: true,
                    stdin: true,
                    stdout: true,
                    stderr: true,
                    logs: false,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| crate::docker::remote(&e))?;
        self.engine
            .api
            .start_container(id, None)
            .await
            .map_err(|e| crate::docker::remote(&e))?;
        let mut ready = Vec::new();
        while ready.len() < 6 {
            let frame = attached
                .output
                .next()
                .await
                .ok_or(Error::State(
                    "setup helper closed before safe credential admission",
                ))?
                .map_err(|e| crate::docker::remote(&e))?;
            if !matches!(frame, bollard::container::LogOutput::StdOut { .. })
                || frame.as_ref().len() > 6 - ready.len()
            {
                return Err(Error::State(
                    "setup helper did not authorize credential admission",
                ));
            }
            ready.extend_from_slice(frame.as_ref());
        }
        if ready != b"ready\n" {
            return Err(Error::State(
                "setup helper did not authorize credential admission",
            ));
        }
        self.application_stopped(spec).await?;
        attached
            .input
            .write_all(payload)
            .await
            .map_err(|_| ObservationError::Transport)?;
        attached
            .input
            .shutdown()
            .await
            .map_err(|_| ObservationError::Transport)?;
        while let Some(frame) = attached.output.next().await {
            let frame = frame.map_err(|e| crate::docker::remote(&e))?;
            if !frame.as_ref().is_empty() {
                return Err(Error::State(
                    "setup helper failed; binding and protected volume retained",
                ));
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let container = self
                .engine
                .container(id)
                .await?
                .ok_or(ObservationError::Incomplete)?;
            let state = container.state.ok_or(ObservationError::Incomplete)?;
            if state.running == Some(false)
                && state.status.as_ref().map(ToString::to_string).as_deref() == Some("exited")
            {
                if state.exit_code == Some(0) {
                    return Ok(());
                }
                return Err(Error::State(
                    "setup helper failed; binding and protected volume retained",
                ));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ObservationError::Transport.into());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
fn relative<'a>(spec: &InputsSpec, path: &'a str) -> &'a str {
    &path[spec.process.process.as_ref().unwrap().mount_target.len() + 1..]
}
fn owner(spec: &InputsSpec) -> (u32, u32) {
    let (uid, gid) = spec
        .process
        .process
        .as_ref()
        .unwrap()
        .user
        .split_once(':')
        .unwrap();
    (uid.parse().unwrap(), gid.parse().unwrap())
}
fn completion(spec: &InputsSpec, row: &Row) -> Completion {
    Completion {
        revision: spec
            .process
            .process
            .as_ref()
            .unwrap()
            .input_revision
            .clone(),
        sandbox_id: row["sandbox_id"].clone(),
    }
}
fn labels(spec: &InputsSpec, row: &Row) -> Result<HashMap<String, String>, Error> {
    let bytes = serde_json::to_vec(&(spec, &row["sandbox_id"]))
        .map_err(|_| Error::State("invalid application input identity"))?;
    let hash: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok([
        (OWNER_LABEL.into(), spec.process.owner.clone()),
        (GENERATION_LABEL.into(), spec.process.generation.clone()),
        (INPUT_LABEL.into(), hash),
    ]
    .into())
}
fn identity(
    spec: &InputsSpec,
    row: &Row,
    container: &ContainerInspectResponse,
) -> Result<String, Error> {
    let config = container
        .config
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    let actual = config.labels.as_ref().ok_or(ObservationError::Incomplete)?;
    let host = serde_json::to_value(
        container
            .host_config
            .as_ref()
            .ok_or(ObservationError::Incomplete)?,
    )
    .map_err(|_| ObservationError::Incomplete)?;
    let (uid, gid) = owner(spec);
    if labels(spec, row)?
        .iter()
        .any(|(key, value)| actual.get(key) != Some(value))
        || container.name.as_deref().map(|s| s.trim_start_matches('/'))
            != Some(spec.helper_name().as_str())
        || config.image.as_deref() != Some(spec.setup.image.as_str())
        || config.user.as_deref() != Some("0:0")
        || !setup_environment_is_safe(config.env.as_deref())
        || config
            .entrypoint
            .as_ref()
            .is_none_or(|v| v != &[ENTRYPOINT.to_owned()])
        || config
            .cmd
            .as_ref()
            .is_none_or(|v| v != &["install".to_owned(), uid.to_string(), gid.to_string()])
        || config.tty != Some(false)
        || config.open_stdin != Some(true)
        || config.stdin_once != Some(true)
        || config
            .healthcheck
            .as_ref()
            .and_then(|h| h.test.as_ref())
            .is_none_or(|v| v != &["NONE".to_owned()])
        || host["NetworkMode"] != "none"
        || host["IpcMode"] != "private"
        || host["ReadonlyRootfs"] != true
        || host["Privileged"] != false
        || host["CapDrop"] != json!(["ALL"])
        || host["CapAdd"] != json!(["CHOWN", "FOWNER", "DAC_OVERRIDE"])
        || host["SecurityOpt"] != json!(["no-new-privileges:true"])
        || host["RestartPolicy"]["Name"] != "no"
        || host["LogConfig"]["Type"] != "none"
        || host["Memory"] != 134217728
        || host["PidsLimit"] != 16
    {
        return Err(ObservationError::BindingMismatch.into());
    }
    for field in [
        "Binds",
        "VolumesFrom",
        "Devices",
        "DeviceRequests",
        "Tmpfs",
        "PortBindings",
    ] {
        let value = &host[field];
        if !value.is_null()
            && !value.as_array().is_some_and(Vec::is_empty)
            && !value.as_object().is_some_and(serde_json::Map::is_empty)
        {
            return Err(ObservationError::BindingMismatch.into());
        }
    }
    if host["PidMode"].as_str().is_some_and(|s| !s.is_empty()) {
        return Err(ObservationError::BindingMismatch.into());
    }
    let mounts = container
        .mounts
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    if mounts.len() != 1
        || mounts[0].destination.as_deref() != Some(ROOT)
        || mounts[0].typ.as_deref() != Some("volume")
        || mounts[0].name.as_deref() != Some(spec.process.volume().as_str())
        || mounts[0].rw != Some(true)
    {
        return Err(ObservationError::BindingMismatch.into());
    }
    let id = container
        .id
        .as_ref()
        .filter(|s| !s.is_empty())
        .ok_or(ObservationError::Incomplete)?;
    let expected = row
        .get("id")
        .filter(|s| !s.is_empty())
        .or_else(|| row.get("prior_id").filter(|s| !s.is_empty()));
    if expected.is_some_and(|s| s != id) {
        return Err(ObservationError::BindingMismatch.into());
    }
    Ok(id.clone())
}
fn observed(mut row: Row, id: String, complete: bool) -> Row {
    row.remove("prior_id");
    row.insert("id".into(), id);
    row.insert("complete".into(), complete.to_string());
    row
}
fn diagnostic(error: Error) -> ObservationError {
    match error {
        Error::Observation(e) => e,
        Error::State(s) | Error::Conflict(s) => ObservationError::Backend(s),
        _ => {
            ObservationError::Backend("protected input setup failed; retain the binding and volume")
        }
    }
}

#[async_trait]
impl Backend for InputsBackend {
    async fn plan(&self, _: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        let spec = self.spec(desired)?;
        self.payload(&spec, desired)?;
        tokio::time::timeout(Duration::from_secs(20), self.image(&spec))
            .await
            .map_err(|_| ObservationError::Transport)??;
        if let Some(prior) = prior {
            let prior_spec = self.spec(prior)?;
            self.container(&prior_spec, prior, false).await?;
        }
        Ok(())
    }
    async fn read(
        &self,
        _: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let work = async {
            let spec = self.spec(prior)?;
            let Some(container) = self.container(&spec, prior, removing).await? else {
                return Ok(None);
            };
            let complete = if removing {
                false
            } else {
                self.complete(&container, &spec, prior).await?
            };
            Ok(Some(observed(
                prior.clone(),
                container.id.ok_or(ObservationError::Incomplete)?,
                complete,
            )))
        };
        tokio::time::timeout(Duration::from_secs(60), work)
            .await
            .map_err(|_| ObservationError::Transport)?
            .map_err(diagnostic)
    }
    async fn ensure(&self, _: &str, desired: &Row) -> Mutation {
        let mut bound = None;
        let work = async {
            let spec = self.spec(desired)?;
            let payload = self.payload(&spec, desired)?;
            self.image(&spec).await?;
            self.volume(&spec).await?;
            if let Some(container) = self.container(&spec, desired, false).await? {
                let id = container.id.clone().ok_or(ObservationError::Incomplete)?;
                bound = Some(observed(desired.clone(), id.clone(), false));
                if self.complete(&container, &spec, desired).await? {
                    return Ok(observed(desired.clone(), id, true));
                }
                if container.state.as_ref().and_then(|s| s.running) != Some(false) {
                    return Err(Error::Conflict(
                        "setup helper is still running; preserve its binding and confirm it stopped before retry",
                    ));
                }
                self.application_stopped(&spec).await?;
                self.engine
                    .api
                    .remove_container(
                        &id,
                        Some(RemoveContainerOptions {
                            force: false,
                            v: true,
                            ..Default::default()
                        }),
                    )
                    .await
                    .map_err(|e| crate::docker::remote(&e))?;
                if self.engine.container(&spec.helper_name()).await?.is_some() {
                    return Err(ObservationError::Incomplete.into());
                }
            }
            self.application_stopped(&spec).await?;
            let id = self.create(&spec, desired).await?;
            bound = Some(observed(desired.clone(), id.clone(), false));
            let fresh = observed(desired.clone(), id.clone(), false);
            let container = self
                .container(&spec, &fresh, false)
                .await?
                .ok_or(ObservationError::Incomplete)?;
            if container.state.as_ref().and_then(|s| s.running) != Some(false) {
                return Err(ObservationError::BindingMismatch.into());
            }
            self.execute(&id, &spec, &payload).await?;
            let container = self
                .container(&spec, &fresh, false)
                .await?
                .ok_or(ObservationError::Incomplete)?;
            if !self.complete(&container, &spec, &fresh).await? {
                return Err(Error::State(
                    "input publication could not be verified; binding and volume retained",
                ));
            }
            Ok::<_, Error>(observed(desired.clone(), id, true))
        };
        let result = tokio::time::timeout(Duration::from_secs(60), work)
            .await
            .map_err(|_| Error::Observation(ObservationError::Transport))
            .and_then(|r| r);
        match result {
            Ok(row) => Mutation::complete(row),
            Err(error) => match bound {
                Some(row) => Mutation::partial(row, diagnostic(error)),
                None => Mutation::failed(diagnostic(error)),
            },
        }
    }
    async fn remove(&self, _: &str, prior: &Row, _: bool) -> Result<(), ObservationError> {
        let work = async {
            let spec = self.spec(prior)?;
            let Some(container) = self.container(&spec, prior, true).await? else {
                return Ok(());
            };
            let id = container.id.ok_or(ObservationError::Incomplete)?;
            if container.state.as_ref().and_then(|s| s.running) != Some(false) {
                self.engine
                    .api
                    .stop_container(
                        &id,
                        Some(StopContainerOptions {
                            t: Some(5),
                            ..Default::default()
                        }),
                    )
                    .await
                    .map_err(|e| crate::docker::remote(&e))?;
            }
            self.engine
                .api
                .remove_container(
                    &id,
                    Some(RemoveContainerOptions {
                        force: false,
                        v: true,
                        ..Default::default()
                    }),
                )
                .await
                .map_err(|e| crate::docker::remote(&e))?;
            if self.engine.container(&spec.helper_name()).await?.is_some() {
                return Err(ObservationError::Incomplete.into());
            }
            // Named-volume deletion belongs to the existing Docker graph.
            Ok::<_, Error>(())
        };
        tokio::time::timeout(Duration::from_secs(30), work)
            .await
            .map_err(|_| ObservationError::Transport)?
            .map_err(diagnostic)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn invalid_delivery_never_mutates_or_reports_absence() {
        let fixture = crate::docker::fixture::Fixture::start(|_| {
            panic!("invalid input must not contact the engine")
        })
        .await;
        let backend =
            InputsBackend::new(crate::docker::Engine::connect(&fixture.endpoint).unwrap());
        let row = Row::new();
        assert!(backend.plan("container_inputs", &row, None).await.is_err());
        assert!(backend.read("container_inputs", &row, false).await.is_err());
        let mutation = backend.ensure("container_inputs", &row).await;
        assert!(mutation.state().is_none());
        assert!(mutation.error().is_some());
        assert!(
            backend
                .remove("container_inputs", &row, true)
                .await
                .is_err()
        );
    }
}

#[cfg(all(test, unix))]
#[path = "inputs_tests.rs"]
mod delivery_tests;
