// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! OpenTofu configuration, execution, saved plans, and credential environments.

use super::{Deployment, plan::Plan};
use crate::{
    CancellationToken, Error, Secrets,
    bundle::Bundle,
    config::Document,
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
