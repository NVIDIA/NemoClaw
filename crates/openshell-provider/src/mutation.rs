// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use async_trait::async_trait;
use nemoclaw_backend::{Backend, Mutation};
use nemoclaw_openshell::{OpenShellLifecycle, openshell_lifecycle};
use std::time::Duration;

/// How long a sandbox has to load its policy: the time Fabric allows the
/// sandbox to start before it starts the agent.
const STARTUP_DEADLINE: Duration = Duration::from_secs(120);

fn value<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).map(String::as_str).unwrap_or("")
}
/// Whether the observed sandbox's loaded policy is the one recorded. Until a
/// loaded policy is observed, no hash is recorded and nothing is compared.
fn policy_unchanged(prior: &Row, row: &Row) -> bool {
    let (recorded, observed) = (
        value(prior, crate::POLICY_HASH),
        value(row, crate::POLICY_HASH),
    );
    recorded.is_empty() || observed.is_empty() || recorded == observed
}

/// The binding a mutation leaves once its readback settles: the object read
/// back, when it is the `established` one and reads back as `want` writes it.
fn settled(
    kind: &str,
    established: Row,
    want: &Row,
    readback: Result<Option<Row>, ObservationError>,
) -> Mutation {
    match readback {
        Ok(Some(row)) => {
            // The mutation response establishes the physical binding even when
            // the desired row did not yet have an ID. Never adopt a substituted
            // object during readback or discard the established recovery state.
            if let Err(error) = verify_identity(&established, &row) {
                return Mutation::partial(established, error);
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
                    && !(kind == "provider"
                        && [crate::POLICY_AUTHORITY, crate::credential::REGISTER]
                            .contains(&key.as_str()))
                    && row.get(key) != Some(v)
            }) {
                return Mutation::partial(row, ObservationError::Incomplete);
            }
            // An APF-governed sandbox binds only with APF's provenance.
            if kind == "sandbox"
                && value(&row, crate::POLICY_AUTHORITY) == "apf"
                && value(&row, crate::POLICY_PROVENANCE).is_empty()
            {
                return Mutation::partial(row, ObservationError::BindingMismatch);
            }
            Mutation::complete(row)
        }
        Ok(None) => Mutation::partial(established, ObservationError::Incomplete),
        Err(error) => Mutation::partial(established, error),
    }
}

/// A sandbox observation whose loaded policy APF did not issue: no token, and
/// the hash recorded before the change, so the next observation still sees the
/// change and plans APF to issue its policy again.
fn unproven_policy(mut row: Row, recorded: &Row) -> Row {
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
    ///
    /// The plan leaves the token and hash unknown; a failed reissue keeps the
    /// hash `recorded` before it, so the next plan asks APF again.
    async fn reissue(
        &self,
        want: &Row,
        live: &Row,
        recorded: &Row,
    ) -> Result<Mutation, ObservationError> {
        self.gateway.reissue_policy(want).await?;
        let issued = |row: &Row| {
            let token = value(row, crate::POLICY_PROVENANCE);
            !token.is_empty()
                && token != value(live, crate::POLICY_PROVENANCE)
                && !value(row, crate::POLICY_HASH).is_empty()
        };
        // The new revision is pending until the sandbox loads it; a replaced
        // sandbox ends the wait.
        let settled = |row: &Row| issued(row) || verify_identity(live, row).is_err();
        let error = match self
            .read_back_sandbox_until(live, want, true, STARTUP_DEADLINE, settled)
            .await
        {
            Ok(Some(row)) => match verify_identity(live, &row) {
                Ok(()) if issued(&row) => return Ok(Mutation::complete(row)),
                Ok(()) => ObservationError::Incomplete,
                Err(error) => error,
            },
            Ok(None) => ObservationError::Incomplete,
            Err(error) => error,
        };
        Ok(Mutation::partial(
            unproven_policy(live.clone(), recorded),
            error,
        ))
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
    /// Read a sandbox back after it is created or updated, waiting for it to
    /// load its policy so the binding records the loaded policy's hash. Without
    /// one, a policy changed before the next apply would be recorded as the
    /// baseline.
    ///
    /// A sandbox that has not loaded its policy by the deadline is returned as
    /// observed, as are one that exited and one whose configuration OpenShell
    /// rejected, which never load one; the agent reports why. A sandbox loading
    /// its policy reads as incomplete only while it was just created, so a
    /// policy that differs from the declared one fails at once on an update.
    ///
    /// A failure to ask OpenShell for the phase (transport or authentication)
    /// says nothing about the sandbox, so the wait goes on. If the phase is
    /// still unavailable at the deadline, the readback fails, and the caller
    /// records the sandbox as partial rather than complete without a hash.
    pub(super) async fn read_back_sandbox(
        &self,
        bound: &Row,
        want: &Row,
        created: bool,
        patience: Duration,
    ) -> Result<Option<Row>, ObservationError> {
        self.read_back_sandbox_until(bound, want, created, patience, |row| {
            !value(row, crate::POLICY_HASH).is_empty()
        })
        .await
    }

    /// [`Self::read_back_sandbox`], waiting until `loaded` holds instead.
    async fn read_back_sandbox_until(
        &self,
        bound: &Row,
        want: &Row,
        created: bool,
        patience: Duration,
        loaded: impl Fn(&Row) -> bool,
    ) -> Result<Option<Row>, ObservationError> {
        let deadline = tokio::time::Instant::now() + patience;
        let mut unavailable = None;
        let observed = loop {
            let observed = self
                .observe(
                    "sandbox",
                    value(want, "workspace"),
                    value(want, "name"),
                    false,
                )
                .await;
            let loading = match &observed {
                Ok(Some(row)) => !loaded(row),
                Err(ObservationError::Incomplete) => created,
                _ => false,
            };
            if !loading {
                break observed;
            }
            if tokio::time::Instant::now() >= deadline {
                if let Some(error) = unavailable {
                    return Err(nemoclaw_backend::Error::into_observation(error));
                }
                break observed;
            }
            match self.gateway.sandbox_phase(bound, true).await {
                Ok(_) => unavailable = None,
                // A sandbox that exited or whose configuration was rejected
                // never loads a policy.
                Err(
                    nemoclaw_backend::Error::SandboxStartup { .. }
                    | nemoclaw_backend::Error::Observation(
                        ObservationError::SandboxConfigurationRejected { .. },
                    ),
                ) => break observed,
                Err(error) => unavailable = Some(error),
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        };
        match observed {
            Ok(Some(mut row)) => {
                self.observe_services(&mut row, want, false).await?;
                Ok(Some(row))
            }
            other => other,
        }
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
        let created = live.is_none();
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
                    return self.reissue(want, &row, prior.unwrap_or(want)).await;
                }
                // The plan changes the live sandbox's network rules.
                if kind == "sandbox"
                    && prior.is_some()
                    && value(want, crate::POLICY_AUTHORITY).is_empty()
                    && value(&row, "policy_json") != value(want, "policy_json")
                {
                    return self.change_policy(want, &row).await;
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
        let readback = if kind == "sandbox" {
            self.read_back_sandbox(&established, want, created, STARTUP_DEADLINE)
                .await
        } else {
            self.observe(kind, workspace, name, false).await
        };
        let mut expected = want.clone();
        if kind == "provider" && !created {
            // OpenShell keeps a provider's labels when it updates the
            // provider, so the registration still names the variable it was
            // created with.
            expected.insert(
                "credential_env".into(),
                value(&established, "credential_env").into(),
            );
        }
        let settled = settled(kind, established, &expected, readback);
        if kind != "provider" || value(want, crate::credential::REGISTER) != "true" {
            return Ok(settled);
        }
        // The registration took the value its variable holds; record that
        // value's digest with it.
        Ok(match settled.into_parts() {
            (Some(mut row), None) => match self.gateway.credential_digest(want).await {
                Ok(digest) => {
                    row.insert(crate::credential::CREDENTIAL_DIGEST.into(), digest);
                    Mutation::complete(row)
                }
                Err(error) => Mutation::partial(row, error),
            },
            (Some(row), Some(error)) => Mutation::partial(row, error),
            (None, Some(error)) => Mutation::failed(error),
            (None, None) => Mutation::failed(ObservationError::Incomplete),
        })
    }
    /// Change a bound sandbox's network rules to `want`'s in place, as
    /// `openshell policy set` does, then wait until the sandbox loads them,
    /// as a new sandbox's policy is waited for. The plan leaves the new
    /// revision's hash unknown.
    ///
    /// A sandbox that fails to load the new revision gets the policy it held
    /// before back, so the binding stays as recorded and the next plan
    /// proposes the change again.
    async fn change_policy(&self, want: &Row, live: &Row) -> Result<Mutation, ObservationError> {
        let previous = self.gateway.update_policy(want).await?;
        // Until the sandbox loads it, the binding records the new policy
        // without a hash.
        let mut established = live.clone();
        established.insert("policy_json".into(), value(want, "policy_json").into());
        established.insert(crate::POLICY_HASH.into(), String::new());
        let readback = self
            .read_back_sandbox(&established, want, true, STARTUP_DEADLINE)
            .await;
        let refused = ObservationError::SandboxConfigurationRejected {
            reason: crate::POLICY_REFUSED,
        };
        if !matches!(&readback, Err(error) if *error == refused) {
            return Ok(settled("sandbox", established, want, readback));
        }
        if self.gateway.set_policy(live, previous).await.is_err() {
            return Ok(Mutation::partial(established, refused));
        }
        let mut restoring = live.clone();
        restoring.insert(crate::POLICY_HASH.into(), String::new());
        Ok(
            match self
                .read_back_sandbox(&restoring, live, true, STARTUP_DEADLINE)
                .await
            {
                Ok(Some(row)) if verify_identity(live, &row).is_ok() => Mutation::partial(
                    row,
                    ObservationError::SandboxConfigurationRejected {
                        reason: crate::POLICY_RESTORED,
                    },
                ),
                _ => Mutation::partial(restoring, refused),
            },
        )
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
            // have changed since, unless APF issued the change. NemoClaw
            // changes it only with the policy input the sandbox records, so
            // both changed after an update whose reply was lost; the
            // observation has checked the loaded rules against that input.
            if !policy_unchanged(prior, row) {
                if value(row, crate::POLICY_AUTHORITY) != "apf" {
                    if value(prior, "policy_json") == value(row, "policy_json") {
                        return Err(ObservationError::BindingMismatch);
                    }
                } else {
                    // APF issues a policy with a new token. A change under the
                    // token it recorded is not APF's, so APF is asked again, and
                    // a change already found unproven stays so until APF's
                    // reissue records its policy.
                    let recorded = value(prior, crate::POLICY_PROVENANCE);
                    unproven =
                        recorded.is_empty() || value(row, crate::POLICY_PROVENANCE) == recorded;
                }
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
            // An API registration records its endpoint list instead of one server.
            "provider" if value(desired, "provider_type") == "api" => {
                &["name", "owner", "generation", "workspace", "endpoints_json"]
            }
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
