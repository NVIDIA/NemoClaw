// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Kubernetes preparation, authentication and gateway observation resources.
//!
//! Each row carries the cluster target and identity as attributes. Operations
//! connect with the kubeconfig and context they name and keep their receipt in the directory
//! the SDK passes through `NEMOCLAW_KUBERNETES_STATE`.

use crate::{
    Error, ObservationError,
    backend::{Backend, Mutation, Row},
};
use async_trait::async_trait;
use nemoclaw_sdk::kubernetes::{
    AUTH_KIND, ClusterTarget, GATEWAY_KIND, STATE_ENV, STORAGE_KIND, Spec, connect,
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
        matches!(kind, STORAGE_KIND | AUTH_KIND | GATEWAY_KIND)
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
    Spec::from_row(kind, row).map_err(|error| match error {
        Error::Observation(error) => error,
        _ => ObservationError::Query,
    })
}

/// The provider row for an observation, or `None` when nothing exists.
fn row(spec: &Spec, response: Response) -> Result<Option<Row>, ObservationError> {
    let Some(id) = response.id else {
        return Ok(None);
    };
    let running = response.running.ok_or(ObservationError::Incomplete)?;
    let mut result = spec.row().map_err(|_| ObservationError::Query)?;
    result.insert("id".into(), id);
    result.insert("running".into(), running.to_string());
    if spec.kind == AUTH_KIND {
        let release_present = response
            .release_present
            .ok_or(ObservationError::Incomplete)?;
        result.insert("release_present".into(), release_present.to_string());
        result.insert(
            "gateway_values".into(),
            response
                .gateway_values
                .ok_or(ObservationError::Incomplete)?,
        );
    }
    Ok(Some(result))
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
        state,
        openshift_wait: nemoclaw_sdk::kubernetes::operations::OPENSHIFT_WAIT,
    })
}

fn failed_mutation(
    error: ObservationError,
    observed: Result<Option<Row>, ObservationError>,
) -> Mutation {
    match observed {
        Ok(Some(row)) => Mutation::partial(row, error),
        Ok(None) | Err(_) => Mutation::failed(error),
    }
}

#[async_trait]
impl Backend for KubernetesBackend {
    async fn plan(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        let want = spec(kind, desired)?;
        if let Some(prior) = prior
            && spec(kind, prior)? != want
        {
            return Err(Error::Conflict(
                "managed Kubernetes target or identity changed; resources retained",
            ));
        }
        Ok(())
    }

    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let spec = spec(kind, prior)?;
        let operations = operations(&spec).await?;
        let response = if removing {
            operations.read_for_removal(&spec, bound_id(prior)).await?
        } else {
            operations.read(&spec, bound_id(prior)).await?
        };
        let row = row(&spec, response)?;
        // Storage is retained: once recorded, it never reads as absent.
        if row.is_none() && kind == STORAGE_KIND && bound_id(prior).is_some() {
            return Err(ObservationError::Incomplete);
        }
        Ok(row)
    }

    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        let spec = match spec(kind, desired) {
            Ok(spec) => spec,
            Err(error) => return Mutation::failed(error),
        };
        let operations = match operations(&spec).await {
            Ok(operations) => operations,
            Err(error) => return Mutation::failed(error),
        };
        match operations.ensure(&spec, bound_id(desired)).await {
            Ok(response) => match row(&spec, response) {
                Ok(Some(row)) => Mutation::complete(row),
                Ok(None) => Mutation::failed(ObservationError::Incomplete),
                Err(error) => Mutation::failed(error),
            },
            Err(error) => {
                // A verified receipt may contain objects from a partially
                // completed create. Keep their binding so destroy can clean
                // them up, without retrying the mutation or hiding its error.
                let observed = operations
                    .read_for_removal(&spec, bound_id(desired))
                    .await
                    .and_then(|response| row(&spec, response));
                failed_mutation(error, observed)
            }
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

/// Kubernetes platform resources and their planning rules.
pub(crate) fn definitions() -> [crate::Definition; 3] {
    use crate::{Protection, carry_prior, rerun_when_stopped};
    use nemoclaw_sdk::kubernetes::{ENVIRONMENT_FIELD, check_attribute};
    use nemoclaw_tofu::shape::Shape;
    let typed = |kind| {
        crate::services::schema_definition(kind)
            .optional(&[ENVIRONMENT_FIELD])
            .structured(
                "environment",
                ENVIRONMENT_FIELD,
                Shape::List(Box::new(Shape::String)),
            )
            .validate_attribute(check_attribute)
            .generated("owner", nemoclaw_backend::generate_owner)
            .generated("generation", nemoclaw_backend::generate_generation)
    };
    [
        typed(STORAGE_KIND)
            .computed("running", rerun_when_stopped)
            .protect(Protection::Always)
            .refuse_replacement()
            .keep_running_during_destroy(),
        typed(GATEWAY_KIND)
            .computed("running", rerun_when_stopped)
            .refuse_replacement(),
        typed(AUTH_KIND)
            .computed("running", rerun_when_stopped)
            .computed("release_present", carry_prior)
            .computed("gateway_values", prepared_gateway_values),
    ]
}

/// Gateway values exist only after identity preparation completes, which the
/// prior observation reports as running.
fn prepared_gateway_values(
    name: &str,
    prior: &crate::State,
) -> Option<tf_provider::value::Value<String>> {
    use tf_provider::value::Value;
    let prepared = matches!(prior.get("running"), Some(Value::Value(value)) if value == "true");
    Some(
        prior
            .get(name)
            .filter(|_| prepared)
            .cloned()
            .unwrap_or(Value::Unknown),
    )
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
                "runtime": {"provider": "kubernetes"},
                "endpoint": "https://127.0.0.1:17671",
                "kubernetes": {
                    "kubeconfig": {"env": "TEST_CLUSTER_CONFIG"}, "context": "selected", "namespace": "agents",
                    "authentication": {"profile": "development"}
                }
            }
        }))
        .unwrap();
        spec.row().unwrap()
    }

    fn fixture(kind: &str) -> Spec {
        Spec::from_row(kind, &spec_row(kind)).unwrap()
    }

    /// Recorded state for a bound `kind` resource.
    fn bound(kind: &str, observed: &[(&str, &str)]) -> crate::State {
        use tf_provider::value::Value;
        spec_row(kind)
            .into_iter()
            .map(|(name, value)| (name, Value::Value(value)))
            .chain(
                observed
                    .iter()
                    .map(|(name, value)| ((*name).into(), Value::Value((*value).into()))),
            )
            .collect()
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
        let source = fixture(GATEWAY_KIND);
        let missing = Response {
            id: Some("uid-1".into()),
            running: None,
            ..Response::default()
        };
        assert_eq!(row(&source, missing), Err(ObservationError::Incomplete));
        let absent = Response::default();
        assert_eq!(row(&source, absent), Ok(None));
    }

    #[test]
    fn authentication_requires_an_independent_release_observation() {
        let source = fixture(AUTH_KIND);
        let missing = Response {
            id: Some("issuer-uid".into()),
            running: Some(true),
            release_present: None,
            gateway_values: Some("{}".into()),
        };
        assert_eq!(row(&source, missing), Err(ObservationError::Incomplete));
        let missing_values = Response {
            id: Some("issuer-uid".into()),
            running: Some(true),
            release_present: Some(false),
            gateway_values: None,
        };
        assert_eq!(
            row(&source, missing_values),
            Err(ObservationError::Incomplete)
        );
        for present in [false, true] {
            let observed = row(
                &source,
                Response {
                    id: Some("issuer-uid".into()),
                    running: Some(true),
                    release_present: Some(present),
                    gateway_values: Some("{}".into()),
                },
            )
            .unwrap()
            .unwrap();
            assert_eq!(observed["release_present"], present.to_string());
        }
    }

    #[test]
    fn authentication_planning_preserves_only_refreshed_release_observation() {
        let definition = crate::resource_definition(AUTH_KIND).unwrap();
        for present in ["false", "true"] {
            let prior = bound(
                AUTH_KIND,
                &[
                    ("id", "issuer-uid"),
                    ("running", "true"),
                    ("release_present", present),
                ],
            );
            let mut proposed = prior.clone();
            proposed.insert("release_present".into(), tf_provider::value::Value::Unknown);
            let (planned, replacements) = crate::plan_update(&definition, &prior, proposed);
            assert_eq!(planned["release_present"], prior["release_present"]);
            assert!(replacements.is_empty());
        }
    }

    #[test]
    fn authentication_values_are_unknown_until_identity_preparation_is_complete() {
        use tf_provider::value::Value;
        let definition = crate::resource_definition(AUTH_KIND).unwrap();
        for running in ["true", "false"] {
            let prior = bound(
                AUTH_KIND,
                &[
                    ("id", "issuer-uid"),
                    ("running", running),
                    ("release_present", "false"),
                    ("gateway_values", "{}"),
                ],
            );
            let mut proposed = prior.clone();
            if running == "true" {
                proposed.insert("gateway_values".into(), Value::Unknown);
            }
            let (planned, replacements) = crate::plan_update(&definition, &prior, proposed);
            assert_eq!(
                planned["gateway_values"],
                if running == "true" {
                    prior["gateway_values"].clone()
                } else {
                    Value::Unknown
                },
            );
            assert!(replacements.is_empty());
        }
    }

    #[test]
    fn an_incomplete_apply_retains_a_verified_partial_binding_and_its_error() {
        let source = fixture(AUTH_KIND);
        let observed = row(
            &source,
            Response {
                id: Some("recorded-issuer-uid".into()),
                running: Some(false),
                release_present: Some(false),
                gateway_values: Some("{}".into()),
            },
        );
        let mutation = failed_mutation(ObservationError::Permission, observed);
        assert_eq!(mutation.error(), Some(ObservationError::Permission));
        let state = mutation
            .state()
            .expect("retain the verified identity for teardown");
        assert_eq!(state["id"], "recorded-issuer-uid");
        assert_eq!(state["running"], "false");
        assert_eq!(state["namespace"], "agents");
        assert_eq!(state["kubeconfig_env"], "TEST_CLUSTER_CONFIG");
    }

    #[test]
    fn failed_or_absent_readback_never_invents_a_partial_binding() {
        for observed in [
            Ok(None),
            Err(ObservationError::Authentication),
            Err(ObservationError::Transport),
            Err(ObservationError::BindingMismatch),
            Err(ObservationError::Incomplete),
        ] {
            let mutation = failed_mutation(ObservationError::Permission, observed);
            assert!(mutation.state().is_none());
            assert_eq!(mutation.error(), Some(ObservationError::Permission));
        }
    }

    #[tokio::test]
    async fn a_changed_specification_is_never_planned_as_an_update() {
        let prior = spec_row(GATEWAY_KIND);
        let mut desired = spec_row(GATEWAY_KIND);
        desired.insert("namespace".into(), "elsewhere".into());
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
    async fn a_row_for_another_resource_type_is_refused() {
        let storage = spec_row(STORAGE_KIND);
        assert_eq!(
            spec("managed_gateway", &storage).err(),
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
