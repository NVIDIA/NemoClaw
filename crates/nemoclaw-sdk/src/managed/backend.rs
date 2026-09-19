// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{GATEWAY_KIND, Spec, Storage};
use crate::{
    Error, ObservationError,
    backend::{Backend, Mutation, Row},
    docker::Engine,
};
pub const GATEWAY_STORAGE_KIND: &str = "gateway_storage";
pub struct ManagedBackend {
    engine: Engine,
    process_kind: Option<&'static str>,
    storage_kind: Option<&'static str>,
}
impl ManagedBackend {
    pub fn new(engine: Engine) -> Self {
        Self {
            engine,
            process_kind: None,
            storage_kind: None,
        }
    }
    pub(crate) fn service(
        engine: Engine,
        process_kind: &'static str,
        storage_kind: &'static str,
    ) -> Self {
        Self {
            engine,
            process_kind: Some(process_kind),
            storage_kind: Some(storage_kind),
        }
    }
    pub fn supports(kind: &str) -> bool {
        matches!(kind, GATEWAY_KIND | GATEWAY_STORAGE_KIND)
    }
    async fn observe(
        &self,
        kind: &str,
        row: &Row,
        apply: bool,
        removing: bool,
    ) -> Result<Option<Row>, Error> {
        if !Self::supports(kind)
            && self.process_kind != Some(kind)
            && self.storage_kind != Some(kind)
        {
            return Err(ObservationError::BindingMismatch.into());
        }
        if self.engine.endpoint() != connection_endpoint(kind, row)? {
            return Err(ObservationError::BindingMismatch.into());
        }
        let encoded = row.get("spec").ok_or(ObservationError::Incomplete)?;
        let id = row.get("id").map(String::as_str).unwrap_or("");
        let mut result = Row::from([("spec".into(), encoded.clone())]);
        if let Some(policy) = row.get("image_pull_policy") {
            result.insert("image_pull_policy".into(), policy.clone());
        }
        let identity = if self.storage_kind == Some(kind) {
            let spec: Storage =
                serde_json::from_str(encoded).map_err(|_| ObservationError::Incomplete)?;
            spec.validate()?;
            let engine = &self.engine;
            if apply {
                Some(spec.ensure(engine, id).await?)
            } else {
                spec.observe(engine, id).await?
            }
        } else {
            let mut spec = specification(kind, encoded)?;
            let policy = crate::config::ImagePullPolicy::from_row(row)?;
            if let Some(process) = &mut spec.process {
                process.image_pull_policy = policy;
            } else {
                spec.gateway.image_pull_policy = policy;
            }
            let engine = &self.engine;
            if kind == GATEWAY_STORAGE_KIND {
                engine.gateway_storage(&spec, id, apply).await?
            } else {
                let observed = if apply {
                    Some(engine.ensure_runtime(&spec, id).await?)
                } else if removing {
                    engine.observe_removal(&spec, id).await?
                } else {
                    engine.observe_runtime(&spec, id).await?
                };
                observed.map(|observed| {
                    result.insert("running".into(), observed.running.to_string());
                    observed.id
                })
            }
        };
        Ok(identity.map(|id| {
            result.insert("id".into(), id);
            result
        }))
    }
}
fn specification(kind: &str, encoded: &str) -> Result<Spec, Error> {
    let spec: Spec = serde_json::from_str(encoded).map_err(|_| ObservationError::Incomplete)?;
    let expected = if kind == GATEWAY_STORAGE_KIND {
        GATEWAY_KIND
    } else {
        kind
    };
    if spec.kind != expected {
        return Err(ObservationError::BindingMismatch.into());
    }
    spec.validate()?;
    Ok(spec)
}
fn diagnostic(error: &Error) -> ObservationError {
    match error {
        Error::Observation(error) => *error,
        Error::State(message) | Error::Conflict(message) => ObservationError::Backend(message),
        Error::PartialRuntime => ObservationError::Backend(
            "managed container is absent but owned persistent resources remain",
        ),
        _ => ObservationError::Incomplete,
    }
}
#[async_trait::async_trait]
impl Backend for ManagedBackend {
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        self.observe(kind, prior, false, removing)
            .await
            .map_err(|error| diagnostic(&error))
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        match self.observe(kind, desired, true, false).await {
            Ok(Some(row)) => Mutation::complete(row),
            Ok(None) => Mutation::failed(ObservationError::Incomplete),
            Err(error) => Mutation::failed(diagnostic(&error)),
        }
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if self.engine.endpoint() != connection_endpoint(kind, prior)? {
            return Err(ObservationError::BindingMismatch);
        }
        if kind != GATEWAY_KIND && self.process_kind != Some(kind) {
            return Err(ObservationError::Backend(
                "persistent storage deletion is forbidden",
            ));
        }
        let spec = specification(kind, prior.get("spec").ok_or(ObservationError::Incomplete)?)
            .map_err(|error| diagnostic(&error))?;
        let id = prior
            .get("id")
            .filter(|id| !id.is_empty())
            .ok_or(ObservationError::Incomplete)?;
        let engine = &self.engine;
        if destroying {
            engine.remove_runtime(&spec, id).await
        } else {
            engine.replace_runtime(&spec, id).await
        }
        .map_err(|error| diagnostic(&error))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn shared_backend_preserves_storage_identity_and_diagnostics_without_recreation() {
        let response = Arc::new(Mutex::new((404, json!({}))));
        let state = response.clone();
        let fixture = Fixture::start(move |request| {
            assert_eq!(
                request.method, "GET",
                "observation or rejection mutated Docker"
            );
            let (code, body) = if request.path == "/info" {
                (
                    200,
                    json!({"ID":"engine","DockerRootDir":"/var/lib/docker"}),
                )
            } else {
                state.lock().unwrap().clone()
            };
            Some((code, serde_json::to_vec(&body).unwrap()))
        })
        .await;
        let storage = Storage {
            name: "nc-0123456789abcdef-inference-data".into(),
            owner: "302ff5e1-088d-42ce-959f-4ff4c3570c13".into(),
            generation: "b".repeat(32),
            engine: fixture.endpoint.clone(),
        };
        let mut row = Row::from([
            ("spec".into(), storage.json().unwrap()),
            ("id".into(), String::new()),
        ]);
        const STORAGE_KIND: &str = "test_storage";
        let backend = ManagedBackend::service(
            Engine::connect(&fixture.endpoint).unwrap(),
            "test_process",
            STORAGE_KIND,
        );
        assert_eq!(backend.read(STORAGE_KIND, &row, false).await.unwrap(), None);
        *response.lock().unwrap() = (
            200,
            json!({"Name":storage.name,"Driver":"local","CreatedAt":"created","Labels":{super::super::OWNER_LABEL:storage.owner,super::super::GENERATION_LABEL:storage.generation},"Options":{},"Scope":"local","Mountpoint":"/var/lib/docker/volumes/data/_data"}),
        );
        row = backend
            .read(STORAGE_KIND, &row, false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            row["id"],
            "engine/nc-0123456789abcdef-inference-data/created"
        );
        assert_eq!(
            backend
                .ensure(STORAGE_KIND, &row)
                .await
                .into_parts()
                .0
                .unwrap(),
            row
        );
        for code in [401, 403, 500, 404] {
            response.lock().unwrap().0 = code;
            assert!(backend.read(STORAGE_KIND, &row, false).await.is_err());
            assert!(backend.ensure(STORAGE_KIND, &row).await.error().is_some());
            assert!(backend.remove(STORAGE_KIND, &row, true).await.is_err());
        }
        response.lock().unwrap().0 = 200;
        response.lock().unwrap().1["Labels"][super::super::OWNER_LABEL] = json!("foreign");
        assert!(backend.read(STORAGE_KIND, &row, false).await.is_err());
        assert!(backend.ensure(STORAGE_KIND, &row).await.error().is_some());
    }
}

/// Extract connection selection before constructing the resource backend.
pub fn connection_endpoint(kind: &str, row: &Row) -> Result<String, ObservationError> {
    let encoded = row.get("spec").ok_or(ObservationError::Incomplete)?;
    if let Ok(spec) = serde_json::from_str::<Spec>(encoded) {
        if spec.kind
            != if kind == GATEWAY_STORAGE_KIND {
                GATEWAY_KIND
            } else {
                kind
            }
        {
            return Err(ObservationError::BindingMismatch);
        }
        spec.validate().map_err(|error| diagnostic(&error))?;
        Ok(spec.engine().to_owned())
    } else {
        let spec: Storage =
            serde_json::from_str(encoded).map_err(|_| ObservationError::Incomplete)?;
        spec.validate().map_err(|error| diagnostic(&error))?;
        Ok(spec.engine)
    }
}

/// Select the resource's execution target before observing or mutating it.
pub fn runtime_engine(
    connections: &crate::docker::Connections,
    kind: &str,
    row: &Row,
) -> Result<Engine, Error> {
    let engine = connections.resolve(&connection_endpoint(kind, row)?)?;
    let service = row
        .get("spec")
        .and_then(|encoded| serde_json::from_str::<Spec>(encoded).ok())
        .is_some_and(|spec| spec.process.is_some());
    if service && engine.endpoint().starts_with("ssh://") && !engine.host_observer_explicit {
        return Ok(engine.with_host_observer(std::sync::Arc::new(crate::hardware::SshHost)));
    }
    Ok(engine)
}
