// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! OpenTofu configuration, execution, saved plans, and credential environments.

use super::{Deployment, plan::Plan};
use crate::{
    CancellationToken, Error, Secrets,
    bundle::Bundle,
    config::{ComputeDriver, Document},
    state::{Store, atomic_write, save_json},
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

impl Deployment {
    pub(super) async fn initialize(
        &self,
        bundle: &Bundle,
        store: &Store,
        graph: &Value,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        self.prepare(bundle, store, graph)?;
        // Init installs exactly this bundle's providers. OpenTofu keeps a
        // provider version that it installed or locked before, even when this
        // bundle's copy has other bytes, such as after signing. Bundle::open
        // checked every provider against the manifest, and the bundle is the
        // only installation source, so the lock file adds no check.
        for removed in [
            fs::remove_dir_all(store.directory.join(".terraform/providers")),
            fs::remove_file(store.directory.join(".terraform.lock.hcl")),
        ] {
            match removed {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(Error::State("cannot remove the installed providers"));
                }
                _ => {}
            }
        }
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
    pub(super) fn prepare(
        &self,
        bundle: &Bundle,
        store: &Store,
        graph: &Value,
    ) -> Result<(), Error> {
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
    pub(super) async fn tofu(
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
                    Some(&self.force_stop),
                    Some(self.progress.clone()),
                )
                .await
            } else {
                crate::process::run(&store.directory, &bundle.tofu(), args, &env, cancel).await
            }
        })
        .await
    }
    pub(super) async fn saved_plan(
        &self,
        bundle: &Bundle,
        store: &Store,
        document: &Document,
        name: &str,
        cancel: &CancellationToken,
    ) -> Result<Plan, Error> {
        let out = format!("-out={name}");
        let mut arguments = vec![
            "plan".to_owned(),
            "-input=false".into(),
            "-no-color".into(),
            out,
        ];
        let mut replaced = false;
        loop {
            let args: Vec<&str> = arguments.iter().map(String::as_str).collect();
            if let Err(error) = self.tofu(bundle, store, document, &args, cancel).await {
                return Err(match error {
                    Error::Execution { .. } => self
                        .stopped_gateway(bundle, store, document, cancel)
                        .await
                        .unwrap_or(error),
                    error => error,
                });
            }
            let bytes = self
                .tofu(bundle, store, document, &["show", "-json", name], cancel)
                .await?;
            let plan: Plan = serde_json::from_slice(&bytes)
                .map_err(|_| Error::State("invalid OpenTofu plan"))?;
            let sandboxes = super::plan::sandboxes_for_new_agents(&plan);
            // Plan once more at most: the replaced sandboxes are created anew.
            if replaced || sandboxes.is_empty() {
                return Ok(plan);
            }
            arguments.extend(
                sandboxes
                    .iter()
                    .map(|sandbox| format!("-replace={sandbox}")),
            );
            replaced = true;
        }
    }
    /// Why a plan failed, when the managed Docker or Podman gateway's
    /// container is stopped.
    ///
    /// OpenTofu refreshes the gateway's objects through the gateway, and it
    /// can't defer that refresh until apply starts the container
    /// (https://github.com/opentofu/opentofu/issues/4697), so such a plan fails
    /// with a transport error. Called only after a plan fails, a refresh of
    /// the gateway container alone tells a stopped container apart from other
    /// failures; any other observation keeps the original error.
    async fn stopped_gateway(
        &self,
        bundle: &Bundle,
        store: &Store,
        document: &Document,
        cancel: &CancellationToken,
    ) -> Option<Error> {
        let gateway = document.spec.gateway.as_managed()?;
        // The Docker provider refreshes a stopped container as must_run=false,
        // and NemoClaw's Podman gateway as running="false".
        let (address, attribute, stopped, client) = match gateway.runtime.provider {
            ComputeDriver::Docker => (
                "docker_container.managed_gateway_runtime",
                "must_run",
                Value::Bool(false),
                "docker --host",
            ),
            ComputeDriver::Podman => (
                "openshell_podman_gateway.runtime",
                "running",
                Value::from("false"),
                "podman --url",
            ),
            ComputeDriver::Kubernetes | ComputeDriver::OpenShift => return None,
        };
        let environment = self
            .provider_environment(document, &store.directory, false)
            .ok()?;
        let target = format!("-target={address}");
        let refreshed = crate::process::run(
            &store.directory,
            &bundle.tofu(),
            &[
                "plan",
                "-refresh-only",
                "-input=false",
                "-no-color",
                "-out=gateway.plan",
                &target,
            ],
            &environment,
            cancel,
        )
        .await;
        let shown = match refreshed {
            Ok(_) => crate::process::run(
                &store.directory,
                &bundle.tofu(),
                &["show", "-json", "gateway.plan"],
                &crate::state::schema_environment(&store.directory),
                cancel,
            )
            .await
            .ok(),
            Err(_) => None,
        };
        let _ = fs::remove_file(store.directory.join("gateway.plan"));
        let plan: Value = serde_json::from_slice(&shown?).ok()?;
        let values = &plan["prior_state"]["values"]["root_module"]["resources"]
            .as_array()?
            .iter()
            .find(|resource| resource["address"] == address)?["values"];
        if values[attribute] != stopped {
            return None;
        }
        let name = values["name"].as_str()?;
        Some(Error::GatewayStopped {
            name: name.into(),
            start: format!("{client} {} start {name}", gateway.engine),
        })
    }
    pub(super) fn provider_environment(
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
        // Providers keep backends' own messages about failed operations here,
        // in the deployment's private state, and diagnostics name the file.
        let diagnostics = std::path::absolute(&self.state_directory)
            .map_err(|_| Error::State("cannot resolve the deployment's state directory"))?
            .join("diagnostics");
        environment.insert(
            nemoclaw_backend::DIAGNOSTICS_ENV.into(),
            diagnostics.to_string_lossy().into_owned(),
        );
        if let Some(target) = document.spec.gateway.as_kubernetes() {
            let state = std::path::absolute(&self.state_directory)
                .map_err(|_| Error::State("cannot resolve Kubernetes state directory"))?
                .join("kubernetes");
            environment.insert(
                crate::kubernetes::STATE_ENV.into(),
                state.to_string_lossy().into_owned(),
            );
            match &target.kubeconfig {
                Some(reference) => {
                    let kubeconfig = crate::kubernetes::kubeconfig_path(
                        environment
                            .get(&reference.env)
                            .ok_or(Error::State("explicit Kubernetes credential is missing"))?,
                    )?
                    .to_string_lossy()
                    .into_owned();
                    environment.insert(reference.env.clone(), kubeconfig.clone());
                    environment.insert(
                        crate::kubernetes::gateway::KUBECONFIG_ENV.into(),
                        kubeconfig,
                    );
                }
                // Providers use the pod's service account, as kube-rs and
                // client-go do when no kubeconfig is configured. They read only
                // these variables from the caller.
                None => {
                    for name in crate::kubernetes::POD_VARIABLES {
                        let value = (self.pod_environment)(name)
                            .filter(|value| !value.is_empty())
                            .ok_or(Error::State(
                                "the pod's in-cluster Kubernetes configuration is missing: \
                                 KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT must be set; \
                                 outside a pod, name gateway.kubernetes.kubeconfig and context",
                            ))?;
                        environment.insert(name.into(), value);
                    }
                }
            }
        }
        Ok(environment)
    }
}

pub(super) fn command_environment(
    document: &Document,
    secrets: &dyn Secrets,
    directory: &Path,
) -> Result<BTreeMap<String, String>, Error> {
    credential_environment(document.credential_names(), secrets, directory)
}

pub(super) fn gateway_environment(
    document: &Document,
    secrets: &dyn Secrets,
    directory: &Path,
) -> Result<BTreeMap<String, String>, Error> {
    let gateway = &document.spec.gateway;
    let mut names = BTreeSet::new();
    if let Some(kubernetes) = gateway.as_kubernetes() {
        names.extend(kubernetes.kubeconfig.iter().map(|file| file.env.as_str()));
        names.extend(kubernetes.environment.iter().map(String::as_str));
        // An existing issuer's token authenticates every gateway request.
        names.extend(
            kubernetes
                .authentication
                .token
                .as_ref()
                .map(|token| token.env.as_str()),
        );
    }
    if let Some(credential) = gateway.credential() {
        names.insert(credential.env.as_str());
    }
    if let Some(tls) = gateway.tls() {
        names.insert(tls.ca.env.as_str());
        names.extend(tls.certificate.iter().map(|file| file.env.as_str()));
        names.extend(tls.key.iter().map(|file| file.env.as_str()));
    }
    // The gateway's runtime reads APF's CA into its configuration.
    if let Some(tls) = gateway.managed_apf().and_then(|apf| apf.tls.as_ref()) {
        names.insert(tls.ca.env.as_str());
    }
    credential_environment(names, secrets, directory)
}

pub(super) fn credential_environment<'a>(
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
            "KUBERNETES_SERVICE_",
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
