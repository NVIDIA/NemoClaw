// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Read provider observations through an isolated, disposable OpenTofu plan.
use crate::{CancellationToken, Error, bundle::Bundle};
use serde_json::{Value, json};
use std::path::Path;

/// Independent provider reads which OpenTofu may schedule concurrently.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiscoveryQuery {
    Engine(crate::discovery::DiscoveryRequest),
    Hardware { engine: String },
    Fabric { engine: String, image: String },
    Inference(crate::inference_discovery::EndpointRequest),
}

pub use crate::discovery::DiscoveryObservation;
impl DiscoveryQuery {
    fn data(&self) -> Result<(&'static str, Value), Error> {
        Ok(match self {
            Self::Engine(request) => (
                "engine_capabilities",
                json!({"engine":literal(&request.engine),"compute_driver":request.compute_driver}),
            ),
            Self::Hardware { engine } => ("target_hardware", json!({"engine":literal(engine)})),
            Self::Fabric { engine, image } => (
                "fabric_capabilities",
                json!({"engine":literal(engine),"image":literal(image)}),
            ),
            Self::Inference(request) => {
                request.validate()?;
                (
                    "inference_capabilities",
                    json!({"endpoint":literal(&request.endpoint),"api":request.api,"credential_env":request.credential_env}),
                )
            }
        })
    }
    fn decode(&self, value: Value) -> Result<DiscoveryObservation, Error> {
        match self {
            Self::Engine(_) => serde_json::from_value(value).map(DiscoveryObservation::Engine),
            Self::Hardware { .. } => {
                serde_json::from_value(value).map(DiscoveryObservation::Hardware)
            }
            Self::Fabric { .. } => serde_json::from_value(value).map(DiscoveryObservation::Fabric),
            Self::Inference(_) => {
                serde_json::from_value(value).map(DiscoveryObservation::Inference)
            }
        }
        .map_err(|_| Error::State("invalid discovery observation"))
    }
}

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
        self.read(DiscoveryQuery::Engine(request.clone()), cancel)
            .await
    }

    /// Refresh metadata from an existing image without pulling or running it.
    pub async fn fabric(
        &mut self,
        engine: &str,
        image: &str,
        cancel: &CancellationToken,
    ) -> Result<crate::discovery::FabricObservation, Error> {
        self.read(
            DiscoveryQuery::Fabric {
                engine: engine.into(),
                image: image.into(),
            },
            cancel,
        )
        .await
    }

    /// Read target hardware advertisements without executing a host collector.
    pub async fn hardware(
        &mut self,
        engine: &str,
        cancel: &CancellationToken,
    ) -> Result<crate::hardware_discovery::HardwareObservation, Error> {
        self.read(
            DiscoveryQuery::Hardware {
                engine: engine.into(),
            },
            cancel,
        )
        .await
    }

    /// Read advertised models from the control host; credentials remain references.
    pub async fn inference(
        &mut self,
        request: &crate::inference_discovery::EndpointRequest,
        cancel: &CancellationToken,
    ) -> Result<crate::inference_discovery::EndpointObservation, Error> {
        self.read(DiscoveryQuery::Inference(request.clone()), cancel)
            .await
    }

    async fn read<T: serde::de::DeserializeOwned>(
        &mut self,
        query: DiscoveryQuery,
        cancel: &CancellationToken,
    ) -> Result<T, Error> {
        let (kind, inputs) = query.data()?;
        serde_json::from_value(self.query(kind, inputs, cancel).await?)
            .map_err(|_| Error::State("invalid discovery observation"))
    }

    /// Reuse the strict gateway metadata source through its authenticated channel.
    /// A failure is returned to authoring as unverified evidence, never absence.
    pub async fn gateway(
        &mut self,
        gateway: &crate::config::Gateway,
        required: &[crate::config::ComputeDriver],
        cancel: &CancellationToken,
    ) -> Result<crate::openshell::GatewayObservation, Error> {
        let value = tokio::time::timeout(
            std::time::Duration::from_secs(35),
            self.query_configured(
                "gateway_capabilities",
                json!({"required_compute_drivers":required}),
                crate::compile::gateway_provider(gateway),
                cancel,
            ),
        )
        .await
        .map_err(|_| Error::State("gateway discovery timed out"))??;
        serde_json::from_value(value).map_err(|_| Error::State("invalid gateway observation"))
    }

    /// Deduplicate identical reads and execute independent observations in one plan.
    /// Results retain the caller's order, including repeated requests.
    pub async fn batch(
        &mut self,
        queries: &[DiscoveryQuery],
        cancel: &CancellationToken,
    ) -> Result<Vec<DiscoveryObservation>, Error> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if queries.is_empty() {
            return Ok(Vec::new());
        }
        if queries.len() > 128 {
            return Err(Error::State("too many discovery queries"));
        }
        let mut graph = self.graph(json!({}));
        let mut unique = std::collections::BTreeMap::new();
        let mut names = Vec::new();
        for query in queries {
            let (kind, inputs) = query.data()?;
            let key = format!("{kind}:{inputs}");
            let next = format!("query_{}", unique.len());
            let name = unique.entry(key).or_insert(next).clone();
            let source = format!("nemoclaw_{kind}");
            graph["data"][&source][&name] = inputs;
            graph["output"]["observation"]["value"][&name] =
                json!(format!("${{data.{source}.{name}.observation_json}}"));
            names.push(name);
        }
        let plan = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.execute_graph(&graph, cancel),
        )
        .await
        .map_err(|_| Error::State("provider discovery timed out"))??;
        queries
            .iter()
            .zip(names)
            .map(|(query, name)| {
                let encoded = plan["planned_values"]["outputs"]["observation"]["value"][&name]
                    .as_str()
                    .ok_or(Error::State("discovery observation is unknown"))?;
                query.decode(
                    serde_json::from_str(encoded)
                        .map_err(|_| Error::State("invalid discovery observation"))?,
                )
            })
            .collect()
    }

    fn graph(&self, provider: Value) -> Value {
        json!({"terraform": {"required_version": format!("= {}",crate::compile::OPENTOFU_VERSION), "required_providers":{"nemoclaw":{"source":crate::compile::PROVIDER_ADDRESS,"version":format!("= {}",self.bundle.manifest.version)}}},"provider":{"nemoclaw":provider}})
    }

    async fn query(
        &mut self,
        kind: &str,
        inputs: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, Error> {
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.query_configured(kind, inputs, json!({}), cancel),
        )
        .await
        .map_err(|_| Error::State("provider discovery timed out"))?
    }

    async fn query_configured(
        &mut self,
        kind: &str,
        inputs: Value,
        provider: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, Error> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let source = format!("nemoclaw_{kind}");
        let mut graph = self.graph(provider);
        graph["data"][&source]["current"] = inputs;
        graph["output"]["observation"]["value"] =
            json!(format!("${{data.{source}.current.observation_json}}"));
        let plan = self.execute_graph(&graph, cancel).await?;
        let observed = plan
            .pointer("/planned_values/outputs/observation/value")
            .and_then(Value::as_str)
            .ok_or(Error::State("discovery observation is unknown"))?;
        serde_json::from_str(observed).map_err(|_| Error::State("invalid discovery observation"))
    }
    async fn execute_graph(
        &mut self,
        graph: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value, Error> {
        let directory = self.directory.path();
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
        serde_json::from_slice(&bytes).map_err(|_| Error::State("invalid discovery plan"))
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
    async fn batch_deduplicates_reads_in_one_plan_and_preserves_input_order() {
        let (_bundle, mut session) = fixture();
        let result = json!({"status":"unknown", "reason":null, "source":"fixture", "reachable":null, "authentication":"unknown", "models":[], "api_verified":false});
        let plan = json!({"planned_values":{"outputs":{"observation":{"value":{"query_0":result.to_string()}}}}});
        let executable = session.bundle.tofu();
        fs::write(&executable, format!("#!/bin/sh\nprintf '%s\\n' \"$1\" >> calls\nif [ \"$1\" = show ]; then cat <<'RESULT'\n{plan}\nRESULT\nfi\n")).unwrap();
        let query = DiscoveryQuery::Inference(crate::inference_discovery::EndpointRequest {
            endpoint: "https://example.test/v1".into(),
            api: crate::config::InferenceApi::OpenaiCompletions,
            credential_env: None,
        });
        let results = session
            .batch(&[query.clone(), query], &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], results[1]);
        let graph: Value = serde_json::from_slice(
            &fs::read(session.directory.path().join("main.tf.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            graph["data"]["nemoclaw_inference_capabilities"]
                .as_object()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            fs::read_to_string(session.directory.path().join("calls")).unwrap(),
            "init\nplan\nshow\n"
        );
        assert!(graph.get("resource").is_none());
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
