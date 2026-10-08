// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Selected-cluster model workloads and retained storage. No operation adopts existing objects.
use crate::{
    Error, ObservationError,
    backend::{Backend, Mutation, Row},
};
use nemoclaw_sdk::kubernetes::{
    ClusterTarget, STATE_ENV, connect, server,
    services::{Operations, Response, SERVICE_KIND, STORAGE_KIND, Spec, StorageSpec},
};

#[derive(Default)]
pub struct ClusterServicesBackend;
impl ClusterServicesBackend {
    pub fn new() -> Self {
        Self
    }
    pub fn supports(kind: &str) -> bool {
        matches!(kind, SERVICE_KIND | STORAGE_KIND)
    }
}

/// Cluster model compute and retained storage use the same observation rules
/// while retaining separate replacement and teardown protections.
pub(crate) fn definitions() -> [crate::Definition; 2] {
    use crate::{Protection, rerun_when_stopped};
    let validate = nemoclaw_sdk::services::validate_resource_spec;
    [
        crate::services::schema_definition(STORAGE_KIND)
            .validate_spec(validate)
            .computed("running", rerun_when_stopped)
            .protect(Protection::Always)
            .refuse_replacement()
            .keep_running_during_destroy(),
        crate::services::schema_definition(SERVICE_KIND)
            .validate_spec(validate)
            .computed("running", rerun_when_stopped)
            .refuse_replacement(),
    ]
}
fn bound(row: &Row) -> Option<&str> {
    row.get("id")
        .map(String::as_str)
        .filter(|id| !id.is_empty())
}
fn specification(row: &Row) -> Result<Spec, ObservationError> {
    Spec::decode(row.get("spec").ok_or(ObservationError::Incomplete)?)
        .map_err(|_| ObservationError::Query)
}
fn storage(row: &Row) -> Result<StorageSpec, ObservationError> {
    StorageSpec::decode(row.get("spec").ok_or(ObservationError::Incomplete)?)
        .map_err(|_| ObservationError::Query)
}
fn runtime_image(spec: &Spec) -> Result<(), ObservationError> {
    nemoclaw_sdk::image_metadata::observe_runtime(
        &nemoclaw_sdk::EnvironmentSecrets,
        &spec.settings.image_metadata.env,
        &spec.image,
        &spec.architecture,
        &spec.runtime,
    )
}
fn row(source: &Row, observed: Response) -> Result<Option<Row>, ObservationError> {
    let Some(id) = observed.id else {
        return Ok(None);
    };
    Ok(Some(Row::from([
        (
            "spec".into(),
            source
                .get("spec")
                .ok_or(ObservationError::Incomplete)?
                .clone(),
        ),
        ("id".into(), id),
        (
            "running".into(),
            observed
                .running
                .ok_or(ObservationError::Incomplete)?
                .to_string(),
        ),
    ])))
}
async fn operations(spec: &StorageSpec) -> Result<Operations, ObservationError> {
    spec.validate().map_err(|_| ObservationError::Query)?;
    let settings = spec
        .gateway
        .settings
        .kubernetes
        .as_ref()
        .ok_or(ObservationError::Query)?;
    let target = ClusterTarget {
        kubeconfig: std::env::var_os(&settings.kubeconfig.env)
            .filter(|path| !path.is_empty())
            .ok_or(ObservationError::Authentication)?
            .into(),
        context: settings.context.clone(),
    };
    Ok(Operations {
        server: server(&target)?,
        client: connect(&target).await?,
        state: std::env::var_os(STATE_ENV)
            .ok_or(ObservationError::Incomplete)?
            .into(),
    })
}

#[async_trait::async_trait]
impl Backend for ClusterServicesBackend {
    async fn plan(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        let (storage, runtime) = match kind {
            STORAGE_KIND => (storage(desired)?, None),
            SERVICE_KIND => {
                let spec = specification(desired)?;
                (spec.storage(), Some(spec))
            }
            _ => return Err(ObservationError::Query.into()),
        };
        if let Some(prior) = prior {
            let old = if kind == STORAGE_KIND {
                self::storage(prior)?
            } else {
                specification(prior)?.storage()
            };
            if old != storage {
                return Err(Error::Conflict(
                    "model storage or cluster binding changed; resources retained",
                ));
            }
            if kind == SERVICE_KIND
                && specification(prior)?.port() != specification(desired)?.port()
            {
                return Err(Error::Conflict(
                    "changing the model serving port requires whole-deployment destroy and apply; destroy deletes sandbox files and conversation history but retains model and credential PVCs",
                ));
            }
        }
        if let Some(spec) = runtime {
            runtime_image(&spec)?;
            operations(&storage)
                .await?
                .preflight_workload(&spec)
                .await?;
        } else {
            operations(&storage)
                .await?
                .preflight(&storage, None)
                .await?;
        }
        Ok(())
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let observed = match kind {
            STORAGE_KIND => {
                let storage = storage(prior)?;
                operations(&storage)
                    .await?
                    .read_storage(&storage, bound(prior))
                    .await?
            }
            SERVICE_KIND => {
                let spec = specification(prior)?;
                let operations = operations(&spec.storage()).await?;
                if removing {
                    operations.read_for_removal(&spec, bound(prior)).await?
                } else {
                    operations.read(&spec, bound(prior)).await?
                }
            }
            _ => return Err(ObservationError::Query),
        };
        row(prior, observed)
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        let storage = match kind {
            STORAGE_KIND => storage(desired),
            SERVICE_KIND => specification(desired).map(|spec| spec.storage()),
            _ => Err(ObservationError::Query),
        };
        let storage = match storage {
            Ok(storage) => storage,
            Err(error) => return Mutation::failed(error),
        };
        let operations = match operations(&storage).await {
            Ok(operations) => operations,
            Err(error) => return Mutation::failed(error),
        };
        let result = async {
            let response = if kind == STORAGE_KIND {
                operations.ensure_storage(&storage, bound(desired)).await?
            } else {
                let spec = specification(desired)?;
                runtime_image(&spec)?;
                operations.ensure(&spec, bound(desired)).await?;
                operations.wait_ready(&spec).await?
            };
            row(desired, response)?.ok_or(ObservationError::Incomplete)
        }
        .await;
        match result {
            Ok(row) => Mutation::complete(row),
            Err(error) => {
                let observed = if kind == STORAGE_KIND {
                    operations.read_storage(&storage, None).await
                } else {
                    match specification(desired) {
                        Ok(spec) => operations.read_for_removal(&spec, None).await,
                        Err(error) => Err(error),
                    }
                };
                match observed.and_then(|response| row(desired, response)) {
                    Ok(Some(row)) => Mutation::partial(row, error),
                    _ => Mutation::failed(error),
                }
            }
        }
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if kind != SERVICE_KIND || !destroying {
            return Err(ObservationError::BindingMismatch);
        }
        let spec = specification(prior)?;
        operations(&spec.storage())
            .await?
            .remove(&spec, bound(prior))
            .await
    }
}

pub async fn resolve_credential(storage: &StorageSpec) -> Result<String, ObservationError> {
    operations(storage).await?.credential(storage).await
}
pub async fn endpoint_addresses(
    storage: &StorageSpec,
    endpoint: &str,
) -> Result<Vec<std::net::IpAddr>, ObservationError> {
    operations(storage)
        .await?
        .endpoint_addresses(storage, endpoint)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn plan_rejects_bound_port_changes_before_reading_metadata_or_cluster_credentials() {
        for source in [
            include_bytes!("../../../examples/kubernetes/local-vllm.yaml").as_slice(),
            include_bytes!("../../../examples/kubernetes/local-ollama.yaml").as_slice(),
        ] {
            let document = nemoclaw_sdk::config::Document::parse(source).unwrap();
            let generations = [
                "workspace",
                "provider",
                "sandbox",
                "kubernetes_storage",
                "kubernetes_gateway",
                "inference_service",
                "ollama_service",
            ]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
            let target = nemoclaw_sdk::compile::runtime_targets(&document, &generations)
                .unwrap()
                .into_iter()
                .find(|target| target.kind == SERVICE_KIND)
                .unwrap();
            let mut changed = specification(&target.values).unwrap();
            match &mut changed.runtime {
                nemoclaw_runtime::RuntimeSpec::Vllm(service) => service.serving.port += 1,
                nemoclaw_runtime::RuntimeSpec::Ollama(service) => service.serving.port += 1,
            }
            let desired = Row::from([("spec".into(), changed.encode().unwrap())]);
            let error = ClusterServicesBackend::new()
                .plan(SERVICE_KIND, &desired, Some(&target.values))
                .await
                .unwrap_err();
            assert!(matches!(error, Error::Conflict(_)), "{error}");
            let message = error.to_string();
            assert!(message.contains("serving port"));
            assert!(message.contains("sandbox files and conversation history"));
        }
    }
}
