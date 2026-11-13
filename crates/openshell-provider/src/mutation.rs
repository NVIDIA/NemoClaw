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
/// Whether the observed sandbox's loaded policy is the one recorded. Before
/// the first observation of a loaded policy no hash is recorded. APF refuses
/// every policy update but its own, which comes with a new token, so until
/// then an APF-governed sandbox must still run its first revision. OpenShell
/// updates a policy NemoClaw authored after start, so there is nothing to
/// compare it with yet.
fn policy_unchanged(prior: &Row, row: &Row) -> bool {
    let observed = value(row, crate::POLICY_HASH);
    if observed.is_empty() {
        return true;
    }
    match value(prior, crate::POLICY_HASH) {
        "" => {
            value(row, crate::POLICY_AUTHORITY) != "apf"
                || matches!(value(row, crate::LOADED_VERSION), "" | "1")
        }
        recorded => recorded == observed,
    }
}

/// A sandbox observation whose loaded policy APF did not issue: no token, and
/// the hash recorded before the change, so the next observation still sees the
/// change and plans APF to issue its policy again.
fn unproven_policy(mut row: Row, recorded: &Row) -> Row {
    row.remove(crate::LOADED_VERSION);
    row.insert(crate::POLICY_PROVENANCE.into(), String::new());
    row.insert(
        crate::POLICY_HASH.into(),
        value(recorded, crate::POLICY_HASH).to_owned(),
    );
    row
}

impl OpenShell {
    /// Ask APF to issue its policy to a bound sandbox again, then wait until
    /// the sandbox has loaded a policy with a new token.
    async fn reissue(&self, want: &Row, live: &Row) -> Result<Mutation, ObservationError> {
        let workspace = value(want, "workspace");
        let name = value(want, "name");
        let failed = |error| {
            Ok(Mutation::partial(
                unproven_policy(live.clone(), want),
                error,
            ))
        };
        self.gateway.reissue_policy(want).await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            let observed = match self.observe("sandbox", workspace, name, false).await {
                Ok(Some(row)) => Some(row),
                Ok(None) => return failed(ObservationError::Incomplete),
                // The new revision is pending until the sandbox loads it.
                Err(ObservationError::Incomplete) => None,
                Err(error) => return failed(error),
            };
            if let Some(mut row) = observed {
                if let Err(error) = verify_identity(live, &row) {
                    return failed(error);
                }
                let token = value(&row, crate::POLICY_PROVENANCE);
                if !token.is_empty()
                    && token != value(live, crate::POLICY_PROVENANCE)
                    && !value(&row, crate::POLICY_HASH).is_empty()
                {
                    row.remove(crate::LOADED_VERSION);
                    self.observe_services(&mut row, want, false).await?;
                    return Ok(Mutation::complete(row));
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return failed(ObservationError::Incomplete);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
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
    /// Bring a live sandbox's declared endpoints to `want`, as `openshell
    /// service expose` and `openshell service delete` would: expose those
    /// missing or different, then delete those the prior binding declared and
    /// `want` doesn't, so an exposure the gateway rejects removes nothing.
    /// Endpoints under names neither declares are left alone.
    async fn update_services(
        &self,
        want: &Row,
        sandbox: &Row,
        prior: Option<&Row>,
    ) -> Result<(), ObservationError> {
        let workspace = value(want, "workspace");
        let wanted = services::exposures(value(want, services::FIELD))?;
        for exposure in &wanted {
            let served = self
                .gateway
                .service(workspace, sandbox, &exposure.name)
                .await?
                .is_some_and(|endpoint| exposure.served_by(&endpoint));
            if !served {
                self.gateway
                    .expose_service(workspace, sandbox, exposure)
                    .await?;
            }
        }
        if let Some(prior) = prior {
            for name in services::names(value(prior, services::FIELD))? {
                if !wanted.iter().any(|exposure| exposure.name == name) {
                    self.gateway
                        .delete_service(workspace, sandbox, &name)
                        .await?;
                }
            }
        }
        Ok(())
    }
    async fn reconcile(
        &self,
        kind: &str,
        want: &Row,
        prior: Option<&Row>,
    ) -> Result<Mutation, ObservationError> {
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
                if kind == "sandbox" {
                    self.update_services(want, &row, prior).await?;
                }
                if kind == "sandbox"
                    && value(want, crate::POLICY_AUTHORITY) == "apf"
                    && value(want, crate::POLICY_PROVENANCE).is_empty()
                    && !value(want, "id").is_empty()
                {
                    return self.reissue(want, &row).await;
                }
                row
            }
            None => {
                let id = self.gateway.create(kind, want).await?;
                let mut row = want.clone();
                row.insert("id".into(), id);
                if kind == "sandbox" {
                    // Until readback, the binding records no URLs or policy.
                    row.insert(services::URLS.into(), "{}".into());
                    row.insert(crate::POLICY_HASH.into(), String::new());
                }
                row
            }
        };
        let readback = match self.observe(kind, workspace, name, false).await {
            Ok(Some(mut row)) if kind == "sandbox" => {
                row.remove(crate::LOADED_VERSION);
                self.observe_services(&mut row, want, false)
                    .await
                    .map(|()| Some(row))
            }
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
                // The ID and the computed URLs and policy hash come from the
                // gateway; every other field must read back as written.
                // A provider records no policy authority; its profile does.
                if want.iter().any(|(key, v)| {
                    ![
                        "id",
                        services::URLS,
                        crate::POLICY_HASH,
                        crate::POLICY_PROVENANCE,
                    ]
                    .contains(&key.as_str())
                        && !(kind == "provider" && key == crate::POLICY_AUTHORITY)
                        && row.get(key) != Some(v)
                }) {
                    return Ok(Mutation::partial(row, ObservationError::Incomplete));
                }
                // An APF-governed sandbox binds only with APF's provenance.
                if kind == "sandbox"
                    && value(&row, crate::POLICY_AUTHORITY) == "apf"
                    && value(&row, crate::POLICY_PROVENANCE).is_empty()
                {
                    return Ok(Mutation::partial(row, ObservationError::BindingMismatch));
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
        // Why OpenShell reports the sandbox exited, if it did.
        let mut exited = String::new();
        // Whether the loaded policy is not the one APF issued.
        let mut unproven = false;
        if kind == "sandbox"
            && !removing
            && let Some(row) = &observed
        {
            verify_identity(prior, row)?;
            // The loaded policy, as recorded when it was applied, must not
            // have changed since, unless APF issued the change.
            if !policy_unchanged(prior, row) {
                if value(row, crate::POLICY_AUTHORITY) != "apf" {
                    return Err(ObservationError::BindingMismatch);
                }
                // APF issues a policy with a new token. A change under the
                // token it recorded is not APF's, so APF is asked again, and
                // a change already found unproven stays so until APF's
                // reissue records its policy.
                let recorded = value(prior, crate::POLICY_PROVENANCE);
                unproven = recorded.is_empty() || value(row, crate::POLICY_PROVENANCE) == recorded;
            }
            match self.check_sandbox_phase(row).await {
                Ok(()) => {}
                Err(nemoclaw_backend::Error::SandboxStartup {
                    phase,
                    reason,
                    exit_code,
                }) => exited = format!("{phase}, reason {reason}, exit code {exit_code}"),
                Err(error) => return Err(error.into_observation()),
            }
        }
        if kind == "sandbox"
            && let Some(row) = &mut observed
        {
            row.remove(crate::LOADED_VERSION);
            if unproven {
                *row = unproven_policy(std::mem::take(row), prior);
            }
            row.insert(crate::EXITED.into(), exited);
            // Teardown, or a sandbox that isn't ready yet, doesn't observe the
            // loaded policy, so the recorded hash still stands.
            if row.get(crate::POLICY_HASH).is_none_or(String::is_empty)
                && let Some(recorded) = prior.get(crate::POLICY_HASH)
            {
                row.insert(crate::POLICY_HASH.into(), recorded.clone());
            }
            self.observe_services(row, prior, removing).await?;
        }
        Ok(observed)
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        self.converge(kind, desired, None).await
    }
    /// A sandbox's update needs the exposures its prior binding declared, to
    /// delete those the desired row no longer declares.
    async fn update(&self, kind: &str, desired: &Row, prior: &Row) -> Mutation {
        let prior = nemoclaw_openshell::without_gateway(prior);
        self.converge(kind, desired, Some(&prior)).await
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
impl OpenShell {
    /// Check the desired row, then reconcile it, given the prior binding when
    /// it updates one in place.
    async fn converge(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Mutation {
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
        self.reconcile(kind, desired, prior)
            .await
            .unwrap_or_else(Mutation::failed)
    }
}
