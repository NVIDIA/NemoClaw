// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use async_trait::async_trait;
use nemoclaw_backend::{Backend, Mutation};
use nemoclaw_openshell::{OpenShellLifecycle, openshell_lifecycle};
use std::time::Duration;

fn value<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).map(String::as_str).unwrap_or("")
}
impl OpenShell {
    /// Add a sandbox's declared service endpoints and their URLs to its
    /// observation, written as the reference row writes them. A sandbox being
    /// removed keeps the reference's: its endpoints go with it.
    async fn observe_services(
        &self,
        row: &mut Row,
        reference: &Row,
        removing: bool,
    ) -> Result<(), ObservationError> {
        let (services, urls) = if removing {
            (
                value(reference, services::FIELD).to_owned(),
                Some(value(reference, services::URLS))
                    .filter(|urls| !urls.is_empty())
                    .unwrap_or("{}")
                    .to_owned(),
            )
        } else {
            let mut endpoints = Vec::new();
            for name in services::names(value(reference, services::FIELD))? {
                if let Some(endpoint) = self
                    .gateway
                    .service(value(row, "workspace"), row, &name)
                    .await?
                {
                    endpoints.push(endpoint);
                }
            }
            (
                services::observed(&endpoints, value(reference, services::FIELD))?,
                services::urls(&endpoints),
            )
        };
        row.insert(services::FIELD.into(), services);
        row.insert(services::URLS.into(), urls);
        Ok(())
    }
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
                if kind == "sandbox" {
                    // Until readback, the binding records no URLs.
                    row.insert(services::URLS.into(), "{}".into());
                }
                row
            }
        };
        let readback = match self.observe(kind, workspace, name, false).await {
            Ok(Some(mut row)) if kind == "sandbox" => self
                .observe_services(&mut row, want, false)
                .await
                .map(|()| Some(row)),
            other => other,
        };
        match readback {
            Ok(Some(row)) => {
                // The mutation response establishes the physical binding even when
                // the desired row did not yet have an ID. Never adopt a substituted
                // object during readback or discard the established recovery state.
                if let Err(error) = verify_identity(&established, &row) {
                    return Ok(Mutation::partial(established, error));
                }
                if want
                    .iter()
                    .any(|(key, v)| key != "id" && key != services::URLS && row.get(key) != Some(v))
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
    /// Planning reaches no gateway; `reconcile` checks who owns an existing
    /// name before it changes anything.
    async fn plan(&self, _: &str, _: &Row, _: Option<&Row>) -> Result<(), nemoclaw_backend::Error> {
        Ok(())
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let prior = &nemoclaw_openshell::without_gateway(prior);
        let mut observed = self
            .observe(
                kind,
                value(prior, "workspace"),
                value(prior, "name"),
                removing,
            )
            .await?;
        if kind == "sandbox"
            && let Some(row) = &observed
            && prior.get("launch_json") != row.get("launch_json")
        {
            return Err(ObservationError::BindingMismatch);
        }
        if kind == "sandbox"
            && !removing
            && let Some(row) = &observed
        {
            verify_identity(prior, row)?;
            self.check_sandbox_phase(row)
                .await
                .map_err(nemoclaw_backend::Error::into_observation)?;
        }
        if kind == "sandbox"
            && let Some(row) = &mut observed
        {
            self.observe_services(row, prior, removing).await?;
        }
        Ok(observed)
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        let desired = &nemoclaw_openshell::without_gateway(desired);
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
                "launch_json",
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
        let prior = &nemoclaw_openshell::without_gateway(prior);
        if !matches!(
            openshell_lifecycle(kind),
            Some(OpenShellLifecycle::Reconstructible)
        ) && !(destroying
            && matches!(
                openshell_lifecycle(kind),
                Some(OpenShellLifecycle::Retained)
            ))
        {
            return Err(ObservationError::Query);
        }
        tokio::time::timeout(Duration::from_secs(300), self.delete_bound(kind, prior))
            .await
            .map_err(|_| ObservationError::Transport)?
    }
}
