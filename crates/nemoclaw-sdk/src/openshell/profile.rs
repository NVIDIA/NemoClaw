// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;

fn definition(owner: &str, generation: &str) -> proto::ProviderProfile {
    let rule = crate::config::integration_policy::brave_policy();
    let policy = openshell_policy::parse_sandbox_policy(
        &serde_json::json!({
            "version": 1, "network_policies": {"nemoclaw-brave": rule}
        })
        .to_string(),
    )
    .expect("static Brave policy");
    let network = &policy.network_policies["nemoclaw-brave"];
    proto::ProviderProfile {
        id: "nemoclaw-brave".into(),
        display_name: "NemoClaw Brave Search".into(),
        description: "Native OpenClaw web search".into(),
        category: proto::ProviderProfileCategory::Knowledge as i32,
        credentials: vec![proto::ProviderProfileCredential {
            name: "BRAVE_API_KEY".into(),
            description: "Brave Search API key".into(),
            env_vars: vec!["BRAVE_API_KEY".into()],
            required: true,
            auth_style: "header".into(),
            header_name: "X-Subscription-Token".into(),
            ..Default::default()
        }],
        endpoints: network.endpoints.clone(),
        binaries: network.binaries.clone(),
        annotations: [
            (OWNER.into(), owner.into()),
            (GENERATION.into(), generation.into()),
        ]
        .into(),
        ..Default::default()
    }
}
fn row(
    mut profile: proto::ProviderProfile,
    workspace: &str,
    name: &str,
) -> Result<Row, ObservationError> {
    let owner = profile.annotations.get(OWNER).cloned().unwrap_or_default();
    let generation = profile
        .annotations
        .get(GENERATION)
        .cloned()
        .unwrap_or_default();
    if name != "nemoclaw-brave"
        || profile.id != name
        || profile.resource_version == 0
        || profile.source != "user"
        || profile.scope != "workspace"
        || owner.is_empty()
        || generation.is_empty()
    {
        return Err(ObservationError::BindingMismatch);
    }
    let id = format!("{workspace}/{name}/{}", profile.resource_version);
    profile.resource_version = 0;
    profile.source.clear();
    profile.scope.clear();
    if profile != definition(&owner, &generation) {
        return Err(ObservationError::BindingMismatch);
    }
    Ok([
        ("id", id),
        ("name", name.into()),
        ("workspace", workspace.into()),
        ("owner", owner),
        ("generation", generation),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect())
}
pub(super) fn provider_row(
    provider: proto::Provider,
    name: &str,
    removing: bool,
) -> Result<Row, ObservationError> {
    let metadata = provider
        .metadata
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    if name != "brave-search"
        || !provider.config.is_empty()
        || metadata.workspace.is_empty()
        || provider.profile_workspace != metadata.workspace
    {
        return Err(ObservationError::BindingMismatch);
    }
    let credential = metadata
        .labels
        .get(CREDENTIAL)
        .filter(|s| !s.is_empty())
        .ok_or(ObservationError::Incomplete)?
        .clone();
    let mut result = base(provider.metadata, name, removing)?;
    result.extend([
        ("endpoint".into(), "https://api.search.brave.com".into()),
        ("provider_type".into(), "brave".into()),
        ("credential_env".into(), credential),
    ]);
    Ok(result)
}
impl OpenShell {
    pub(super) async fn observe_profile(
        &self,
        workspace: &str,
        name: &str,
    ) -> Result<Option<Row>, ObservationError> {
        authoritative(
            self.grpc()
                .get_provider_profile(self.request(proto::GetProviderProfileRequest {
                    id: name.into(),
                    workspace: workspace.into(),
                }))
                .await,
        )?
        .map(|response| {
            row(
                response.profile.ok_or(ObservationError::Incomplete)?,
                workspace,
                name,
            )
        })
        .transpose()
    }
    pub(super) async fn create_profile(&self, want: &Row) -> Result<String, ObservationError> {
        if want["name"] != "nemoclaw-brave" {
            return Err(ObservationError::Query);
        }
        let response = self
            .grpc()
            .import_provider_profiles(self.request(proto::ImportProviderProfilesRequest {
                workspace: want["workspace"].clone(),
                profiles: vec![proto::ProviderProfileImportItem {
                    profile: Some(definition(&want["owner"], &want["generation"])),
                    source: "NemoClaw".into(),
                }],
            }))
            .await
            .map_err(|e| remote_error(&e))?
            .into_inner();
        if !response.imported || response.profiles.len() != 1 {
            return Err(ObservationError::Incomplete);
        }
        let row = row(
            response.profiles.into_iter().next().unwrap(),
            &want["workspace"],
            &want["name"],
        )?;
        verify_identity(want, &row)?;
        Ok(row["id"].clone())
    }
}
