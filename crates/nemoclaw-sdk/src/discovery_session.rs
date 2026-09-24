// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Read provider observations through an isolated, disposable OpenTofu plan.
use crate::{CancellationToken, Error, bundle::Bundle};
use serde_json::{Value, json};
use std::path::Path;

pub struct DiscoverySession {
    bundle: Bundle,
    directory: tempfile::TempDir,
    initialized: bool,
}

impl DiscoverySession {
    pub fn new(bundle_directory: &Path) -> Result<Self, Error> {
        Self::with_bundle(Bundle::open(bundle_directory)?)
    }

    fn with_bundle(bundle: Bundle) -> Result<Self, Error> {
        Ok(Self {
            bundle,
            directory: tempfile::tempdir()
                .map_err(|_| Error::State("cannot create discovery directory"))?,
            initialized: false,
        })
    }

    /// Refresh engine facts through the provider. No deployment configuration is needed.
    pub async fn engine(
        &mut self,
        request: &crate::discovery::DiscoveryRequest,
        cancel: &CancellationToken,
    ) -> Result<crate::discovery::EngineObservation, Error> {
        let value = self
            .query(
                "engine_capabilities",
                json!({
                    "engine": literal(&request.engine), "compute_driver": request.compute_driver
                }),
                cancel,
            )
            .await?;
        serde_json::from_value(value).map_err(|_| Error::State("invalid engine observation"))
    }

    /// Refresh metadata from an existing image without pulling or running it.
    pub async fn fabric(
        &mut self,
        engine: &str,
        image: &str,
        cancel: &CancellationToken,
    ) -> Result<crate::discovery::FabricObservation, Error> {
        let value = self
            .query(
                "fabric_capabilities",
                json!({
                    "engine": literal(engine), "image": literal(image)
                }),
                cancel,
            )
            .await?;
        serde_json::from_value(value).map_err(|_| Error::State("invalid Fabric observation"))
    }

    async fn query(
        &mut self,
        kind: &str,
        inputs: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, Error> {
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.query_inner(kind, inputs, cancel),
        )
        .await
        .map_err(|_| Error::State("provider discovery timed out"))?
    }

    async fn query_inner(
        &mut self,
        kind: &str,
        inputs: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, Error> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let directory = self.directory.path();
        let source = format!("nemoclaw_{kind}");
        let graph = json!({
            "terraform": {
                "required_version": format!("= {}", crate::compile::OPENTOFU_VERSION),
                "required_providers": { "nemoclaw": {
                    "source": crate::compile::PROVIDER_ADDRESS,
                    "version": format!("= {}", self.bundle.manifest.version)
                }}
            },
            "provider": { "nemoclaw": {} },
            "data": { source.clone(): { "current": inputs } },
            "output": { "observation": { "value": format!("${{data.{source}.current.observation_json}}") } }
        });
        crate::state::save_json(&directory.join("main.tf.json"), &graph)?;
        let mirror = self
            .bundle
            .directory
            .join("providers")
            .to_string_lossy()
            .replace('\\', "/");
        let quoted = serde_json::to_string(&mirror).expect("string path");
        crate::state::atomic_write(
            &directory.join("providers.tfrc"),
            format!("provider_installation {{ filesystem_mirror {{ path = {quoted} }} }}\n")
                .as_bytes(),
        )?;
        let environment = crate::state::schema_environment(directory);
        if !self.initialized {
            crate::process::run(
                directory,
                &self.bundle.tofu(),
                &["init", "-backend=false", "-input=false", "-no-color"],
                &environment,
                cancel,
            )
            .await?;
            self.initialized = true;
        }
        crate::process::run(
            directory,
            &self.bundle.tofu(),
            &["plan", "-input=false", "-no-color", "-out=discovery.plan"],
            &environment,
            cancel,
        )
        .await?;
        let bytes = crate::process::run(
            directory,
            &self.bundle.tofu(),
            &["show", "-json", "discovery.plan"],
            &environment,
            cancel,
        )
        .await?;
        let plan: Value =
            serde_json::from_slice(&bytes).map_err(|_| Error::State("invalid discovery plan"))?;
        let observed = plan
            .pointer("/planned_values/outputs/observation/value")
            .and_then(Value::as_str)
            .ok_or(Error::State("discovery observation is unknown"))?;
        serde_json::from_str(observed).map_err(|_| Error::State("invalid discovery observation"))
    }
}

fn literal(value: &str) -> String {
    value.replace("${", "$${").replace("%{", "%%{")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt};

    fn fixture() -> (tempfile::TempDir, DiscoverySession) {
        let bundle = tempfile::tempdir().unwrap();
        fs::create_dir(bundle.path().join("libexec")).unwrap();
        let executable = bundle.path().join("libexec/tofu");
        fs::write(&executable, r#"#!/bin/sh
printf '%s\n' "$1" >> calls
case "$1" in
  init) exit 0 ;;
  plan) test -f main.tf.json; exit $? ;;
  show) printf '%s\n' '{"planned_values":{"outputs":{"observation":{"value":"{\"status\":\"unknown\",\"reason\":\"engine_unreachable\"}"}}}}' ;;
  *) exit 17 ;;
esac
"#).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let session = DiscoverySession::with_bundle(Bundle {
            directory: bundle.path().into(),
            manifest: crate::bundle::Manifest {
                version: "0.1.0".into(),
                rust: "test".into(),
                opentofu: crate::compile::OPENTOFU_VERSION.into(),
                files: BTreeMap::new(),
            },
        })
        .unwrap();
        (bundle, session)
    }

    #[tokio::test]
    async fn discovery_reuses_initialization_but_refreshes_evidence_without_apply_or_state() {
        let (_bundle, mut session) = fixture();
        let directory = session.directory.path().to_owned();
        for engine in ["unix:///first.sock", "unix:///second.sock"] {
            let observed = session
                .query(
                    "engine_capabilities",
                    json!({"engine": engine, "compute_driver":"docker"}),
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(observed["status"], "unknown");
            let graph: Value =
                serde_json::from_slice(&fs::read(directory.join("main.tf.json")).unwrap()).unwrap();
            assert_eq!(
                graph["data"]["nemoclaw_engine_capabilities"]["current"]["engine"],
                engine
            );
            assert!(graph.get("resource").is_none());
        }
        assert_eq!(
            fs::read_to_string(directory.join("calls")).unwrap(),
            "init\nplan\nshow\nplan\nshow\n"
        );
        assert!(!directory.join("terraform.tfstate").exists());
        drop(session);
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn cancelled_discovery_does_not_launch_opentofu() {
        let (_bundle, mut session) = fixture();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            session
                .query("engine_capabilities", json!({}), &cancel)
                .await,
            Err(Error::Cancelled)
        ));
        assert!(!session.directory.path().join("calls").exists());
    }
}
