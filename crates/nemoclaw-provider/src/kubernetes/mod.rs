// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Provider-owned reconciliation for managed Kubernetes resources.

use crate::{
    Error, ObservationError,
    backend::{Backend, Mutation, Row},
};
use async_trait::async_trait;
use nemoclaw_sdk::kubernetes::{GATEWAY_KIND, Response, STATE_ENV, STORAGE_KIND, Spec, invoke};
use std::{collections::BTreeMap, path::PathBuf};

trait ResourceResponse {
    fn row(&self, spec: &Spec, source: &Row) -> Result<Option<Row>, ObservationError>;
    fn mutation(&self, spec: &Spec, source: &Row) -> Mutation;
}

impl ResourceResponse for Response {
    fn row(&self, spec: &Spec, source: &Row) -> Result<Option<Row>, ObservationError> {
        let Some(id) = &self.id else { return Ok(None) };
        if id.is_empty()
            || id.len() > 512
            || id
                .bytes()
                .any(|byte| !(byte.is_ascii_alphanumeric() || b"-_:/.".contains(&byte)))
        {
            return Err(ObservationError::Incomplete);
        }
        if let Some(prior) = source.get("id").filter(|id| !id.is_empty())
            && prior != id
        {
            return Err(ObservationError::BindingMismatch);
        }
        let mut row = Row::from([
            (
                "spec".into(),
                source
                    .get("spec")
                    .ok_or(ObservationError::Incomplete)?
                    .clone(),
            ),
            ("id".into(), id.clone()),
        ]);
        if matches!(spec.kind.as_str(), GATEWAY_KIND | STORAGE_KIND) {
            row.insert(
                "running".into(),
                self.running
                    .ok_or(ObservationError::Incomplete)?
                    .to_string(),
            );
        }
        Ok(Some(row))
    }

    fn mutation(&self, spec: &Spec, source: &Row) -> Mutation {
        match self.row(spec, source) {
            Err(error) => Mutation::failed(error),
            Ok(None) => Mutation::failed(self.error().unwrap_or(ObservationError::Incomplete)),
            Ok(Some(mut row)) => {
                // A provider error during create taints OpenTofu state, making
                // retry impossible for retained resources. Preserve the known
                // identity as an incomplete observation instead: the compiled
                // postcondition fails and blocks dependent resources, while a
                // subsequent apply can reconcile this same binding in place.
                if self.error().is_some() {
                    row.insert("running".into(), "false".into());
                }
                Mutation::complete(row)
            }
        }
    }
}

#[derive(Default)]
pub struct KubernetesBackend;

fn bound_id(row: &Row) -> Option<&String> {
    row.get("id").filter(|id| !id.is_empty())
}
impl KubernetesBackend {
    pub fn new() -> Self {
        Self
    }
    pub fn supports(kind: &str) -> bool {
        matches!(kind, STORAGE_KIND | GATEWAY_KIND)
    }
    async fn call(
        &self,
        action: &str,
        kind: &str,
        row: &Row,
    ) -> Result<(Spec, Response), ObservationError> {
        let spec = Spec::decode(row.get("spec").ok_or(ObservationError::Incomplete)?)
            .map_err(|_| ObservationError::Query)?;
        if spec.kind != kind {
            return Err(ObservationError::BindingMismatch);
        }
        let directory = std::env::var_os(STATE_ENV)
            .map(PathBuf::from)
            .ok_or(ObservationError::Incomplete)?;
        let response = invoke(
            action,
            &spec,
            &directory,
            bound_id(row),
            &BTreeMap::new(),
            &crate::CancellationToken::new(),
        )
        .await?;
        Ok((spec, response))
    }
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
        let mut row = desired.clone();
        if let Some(id) = prior.and_then(|prior| prior.get("id")) {
            row.insert("id".into(), id.clone());
        }
        let (_, response) = self.call("plan", kind, &row).await?;
        if let Some(error) = response.error() {
            return Err(error.into());
        }
        Ok(())
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        _removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let (spec, response) = self.call("read", kind, prior).await?;
        if let Some(error) = response.error() {
            return Err(error);
        }
        // Retained identity never becomes absent from an incomplete response.
        let row = response.row(&spec, prior)?;
        if row.is_none() && kind == STORAGE_KIND {
            return Err(ObservationError::Incomplete);
        }
        Ok(row)
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        match self.call("ensure", kind, desired).await {
            Err(error) => Mutation::failed(error),
            Ok((spec, response)) => response.mutation(&spec, desired),
        }
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if kind == STORAGE_KIND || !destroying {
            return Err(ObservationError::BindingMismatch);
        }
        let (_, response) = self.call("remove", kind, prior).await?;
        response.error().map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests;
