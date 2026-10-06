// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Provider resources for a Kubernetes gateway: `kubernetes_storage` and
//! `kubernetes_gateway`.
//!
//! Each row carries the encoded specification. Operations connect with the
//! kubeconfig and context it names and keep their receipt in the directory
//! the SDK passes through `NEMOCLAW_KUBERNETES_STATE`.

use crate::{
    Error, ObservationError,
    backend::{Backend, Mutation, Row},
};
use async_trait::async_trait;
use nemoclaw_sdk::kubernetes::{
    ClusterTarget, GATEWAY_KIND, STATE_ENV, STORAGE_KIND, Spec, connect,
    operations::{Operations, Response},
    server,
};
use std::path::PathBuf;

#[derive(Default)]
pub struct KubernetesBackend;

impl KubernetesBackend {
    pub fn new() -> Self {
        Self
    }
    pub fn supports(kind: &str) -> bool {
        matches!(kind, STORAGE_KIND | GATEWAY_KIND)
    }
}

/// The recorded identity, ignoring the empty value OpenTofu plans for an
/// unknown computed attribute.
fn bound_id(row: &Row) -> Option<&str> {
    row.get("id")
        .map(String::as_str)
        .filter(|id| !id.is_empty())
}

fn spec(kind: &str, row: &Row) -> Result<Spec, ObservationError> {
    let spec = Spec::decode(row.get("spec").ok_or(ObservationError::Incomplete)?)
        .map_err(|_| ObservationError::Query)?;
    if spec.kind != kind {
        return Err(ObservationError::BindingMismatch);
    }
    Ok(spec)
}

/// The provider row for an observation, or `None` when nothing exists.
fn row(source: &Row, response: Response) -> Result<Option<Row>, ObservationError> {
    let Some(id) = response.id else {
        return Ok(None);
    };
    let spec = source
        .get("spec")
        .ok_or(ObservationError::Incomplete)?
        .clone();
    let running = response.running.ok_or(ObservationError::Incomplete)?;
    Ok(Some(Row::from([
        ("spec".into(), spec),
        ("id".into(), id),
        ("running".into(), running.to_string()),
    ])))
}

async fn operations(spec: &Spec) -> Result<Operations, ObservationError> {
    let target = spec
        .settings
        .kubernetes
        .as_ref()
        .ok_or(ObservationError::Query)?;
    let kubeconfig: PathBuf = std::env::var_os(&target.kubeconfig.env)
        .filter(|path| !path.is_empty())
        .ok_or(ObservationError::Authentication)?
        .into();
    let state: PathBuf = std::env::var_os(STATE_ENV)
        .ok_or(ObservationError::Incomplete)?
        .into();
    let cluster = ClusterTarget {
        kubeconfig: kubeconfig.clone(),
        context: target.context.clone(),
    };
    let server = server(&cluster)?;
    let client = connect(&cluster).await?;
    Ok(Operations {
        server,
        client,
        helm: "helm".into(),
        kubeconfig,
        state,
        openshift_wait: nemoclaw_sdk::kubernetes::operations::OPENSHIFT_WAIT,
    })
}

#[async_trait]
impl Backend for KubernetesBackend {
    async fn plan(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        if let Some(prior) = prior
            && prior.get("spec") != desired.get("spec")
        {
            return Err(Error::Conflict(
                "managed Kubernetes target or identity changed; resources retained",
            ));
        }
        spec(kind, desired)?;
        Ok(())
    }

    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        _removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let spec = spec(kind, prior)?;
        let response = operations(&spec)
            .await?
            .read(&spec, bound_id(prior))
            .await?;
        let row = row(prior, response)?;
        // Storage is retained: once recorded, it never reads as absent.
        if row.is_none() && kind == STORAGE_KIND && bound_id(prior).is_some() {
            return Err(ObservationError::Incomplete);
        }
        Ok(row)
    }

    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        let result = async {
            let spec = spec(kind, desired)?;
            let response = operations(&spec)
                .await?
                .ensure(&spec, bound_id(desired))
                .await?;
            row(desired, response)?.ok_or(ObservationError::Incomplete)
        }
        .await;
        match result {
            Ok(row) => Mutation::complete(row),
            Err(error) => Mutation::failed(error),
        }
    }

    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        // Storage is retained, and the gateway is removed only by destroy.
        if kind == STORAGE_KIND || !destroying {
            return Err(ObservationError::BindingMismatch);
        }
        let spec = spec(kind, prior)?;
        operations(&spec)
            .await?
            .remove(&spec, bound_id(prior))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec_row(kind: &str) -> Row {
        let spec: Spec = serde_json::from_value(json!({
            "layout": 1, "kind": kind, "name": "nc-0123456789abcdef-gateway",
            "owner": "11111111-1111-4111-8111-111111111111", "generation": "0123456789abcdef0123456789abcdef",
            "settings": {
                "endpoint": "https://127.0.0.1:17671",
                "kubernetes": {
                    "kubeconfig": {"env": "TEST_CLUSTER_CONFIG"}, "context": "selected", "namespace": "agents",
                    "authentication": {"profile": "development"}
                }
            }
        }))
        .unwrap();
        Row::from([("spec".into(), spec.encode().unwrap())])
    }

    #[test]
    fn an_empty_planned_identity_is_not_a_recorded_one() {
        assert_eq!(bound_id(&Row::new()), None);
        assert_eq!(bound_id(&Row::from([("id".into(), String::new())])), None);
        assert_eq!(
            bound_id(&Row::from([("id".into(), "uid-1".into())])),
            Some("uid-1")
        );
    }

    #[test]
    fn an_observation_without_running_is_incomplete() {
        let source = spec_row(GATEWAY_KIND);
        let missing = Response {
            id: Some("uid-1".into()),
            running: None,
        };
        assert_eq!(row(&source, missing), Err(ObservationError::Incomplete));
        let absent = Response::default();
        assert_eq!(row(&source, absent), Ok(None));
    }

    #[tokio::test]
    async fn a_changed_specification_is_never_planned_as_an_update() {
        let prior = spec_row(GATEWAY_KIND);
        let mut desired = spec_row(GATEWAY_KIND);
        let mut spec = Spec::decode(&desired["spec"]).unwrap();
        spec.settings.kubernetes.as_mut().unwrap().namespace = "elsewhere".into();
        desired.insert("spec".into(), spec.encode().unwrap());
        assert!(matches!(
            KubernetesBackend::new()
                .plan(GATEWAY_KIND, &desired, Some(&prior))
                .await,
            Err(Error::Conflict(_))
        ));
        KubernetesBackend::new()
            .plan(GATEWAY_KIND, &prior, Some(&prior))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_row_for_the_other_kind_is_refused() {
        let storage = spec_row(STORAGE_KIND);
        assert_eq!(
            spec(GATEWAY_KIND, &storage).err(),
            Some(ObservationError::BindingMismatch)
        );
    }

    #[tokio::test]
    async fn storage_is_never_removed_and_the_gateway_only_by_destroy() {
        let backend = KubernetesBackend::new();
        assert_eq!(
            backend
                .remove(STORAGE_KIND, &spec_row(STORAGE_KIND), true)
                .await,
            Err(ObservationError::BindingMismatch)
        );
        assert_eq!(
            backend
                .remove(GATEWAY_KIND, &spec_row(GATEWAY_KIND), false)
                .await,
            Err(ObservationError::BindingMismatch)
        );
    }
}
