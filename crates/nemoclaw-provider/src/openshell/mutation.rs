// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use async_trait::async_trait;
use nemoclaw_sdk::backend::{Backend, Mutation, OpenShellLifecycle, openshell_lifecycle};
use std::time::Duration;

fn value<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).map(String::as_str).unwrap_or("")
}
impl OpenShell {
    async fn reconcile(&self, kind: &str, want: &Row) -> Result<Mutation, ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        if kind != "workspace" {
            let parent = self
                .observe("workspace", "", workspace, false)
                .await?
                .ok_or(ObservationError::BindingMismatch)?;
            if value(&parent, "owner") != value(want, "owner") {
                return Err(ObservationError::BindingMismatch);
            }
        }
        let live = self.observe(kind, workspace, name, false).await?;
        if let Some(row) = &live {
            verify_identity(want, row)?;
        } else if !value(want, "id").is_empty() {
            return Err(ObservationError::BindingMismatch);
        }
        let established = match live {
            Some(row) => {
                if kind == "provider" {
                    self.gateway.update_provider(want, &row).await?;
                }
                row
            }
            None => {
                let id = self.gateway.create(kind, want).await?;
                let mut row = want.clone();
                row.insert("id".into(), id);
                row
            }
        };
        match self.observe(kind, workspace, name, false).await {
            Ok(Some(row)) => {
                // The mutation response establishes the physical binding even when
                // the desired row did not yet have an ID. Never adopt a substituted
                // object during readback or discard the established recovery state.
                if let Err(error) = verify_identity(&established, &row) {
                    return Ok(Mutation::partial(established, error));
                }
                if want
                    .iter()
                    .any(|(key, v)| key != "id" && row.get(key) != Some(v))
                {
                    return Ok(Mutation::partial(row, ObservationError::Incomplete));
                }
                Ok(Mutation::complete(row))
            }
            Ok(None) => Ok(Mutation::partial(established, ObservationError::Incomplete)),
            Err(error) => Ok(Mutation::partial(established, error)),
        }
    }
    async fn delete_bound(&self, kind: &str, want: &Row) -> Result<(), ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        if value(want, "id").is_empty() {
            return Err(ObservationError::BindingMismatch);
        }
        if kind == "sandbox" {
            return self.gateway.delete_bound_sandbox(want).await;
        }
        let Some(row) = self.observe(kind, workspace, name, true).await? else {
            return Ok(());
        };
        verify_identity(want, &row)?;
        // Upstream deletion is name-addressed without an ID/version condition.
        // Verify immediately before sending; never retry an ambiguous mutation.
        self.gateway.delete(kind, workspace, name).await?;
        loop {
            let Some(row) = self.observe(kind, workspace, name, true).await? else {
                return Ok(());
            };
            verify_identity(want, &row)?;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}
#[async_trait]
impl Backend for OpenShell {
    async fn plan(
        &self,
        kind: &str,
        desired: &Row,
        prior: Option<&Row>,
    ) -> Result<(), nemoclaw_sdk::Error> {
        if kind == "agent_configuration" {
            return self.plan_configuration(desired).await;
        }
        // Bound resources were refreshed by OpenTofu. New resources still need
        // an ownership check: their names may already exist in the gateway.
        if prior.is_none()
            && let Some(observed) = self
                .observe(
                    kind,
                    value(desired, "workspace"),
                    value(desired, "name"),
                    false,
                )
                .await?
        {
            verify_identity(desired, &observed)?;
        }
        Ok(())
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        if kind == "agent_configuration" {
            return self.read_configuration(prior, removing).await;
        }
        let observed = self
            .observe(
                kind,
                value(prior, "workspace"),
                value(prior, "name"),
                removing,
            )
            .await?;
        if kind == "sandbox"
            && !removing
            && let Some(row) = &observed
        {
            verify_identity(prior, row)?;
            self.check_sandbox_phase(row)
                .await
                .map_err(nemoclaw_sdk::Error::into_observation)?;
        }
        Ok(observed)
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        if kind == "agent_configuration" {
            return self.ensure_configuration(desired).await;
        }
        let fields: &[&str] = match kind {
            "workspace" => &["name", "owner", "generation"],
            "provider_profile" => &["name", "owner", "generation", "workspace"],
            "provider" => &["name", "owner", "generation", "workspace", "endpoint"],
            "sandbox" => &[
                "name",
                "owner",
                "generation",
                "workspace",
                "image",
                "agent_name",
            ],
            _ => return Mutation::failed(ObservationError::Query),
        };
        if fields
            .iter()
            .any(|field| value(desired, field).is_empty() || value(desired, field).contains('\0'))
        {
            return Mutation::failed(ObservationError::Incomplete);
        }
        if kind == "sandbox" && validate_row_policy(desired).is_err() {
            return Mutation::failed(ObservationError::Query);
        }
        self.reconcile(kind, desired)
            .await
            .unwrap_or_else(Mutation::failed)
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if kind == "agent_configuration" {
            return self.remove_configuration(prior, destroying).await;
        }
        if !matches!(
            openshell_lifecycle(kind),
            Some(OpenShellLifecycle::Reconstructible)
        ) && !(destroying && openshell_lifecycle(kind) == Some(OpenShellLifecycle::Stateful))
        {
            return Err(ObservationError::Query);
        }
        tokio::time::timeout(Duration::from_secs(300), self.delete_bound(kind, prior))
            .await
            .map_err(|_| ObservationError::Transport)?
    }
}
