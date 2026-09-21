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
        description: "Declared Brave web search".into(),
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
fn native_definition(want: &Row) -> Result<proto::ProviderProfile, ObservationError> {
    let name = want["name"]
        .strip_prefix("nemoclaw-inference-")
        .ok_or(ObservationError::Query)?;
    let authenticated = match want.get("authenticated").map(String::as_str) {
        Some("true") => true,
        Some("false") => false,
        _ => return Err(ObservationError::Query),
    };
    let destination_ip = want
        .get("destination_ip")
        .filter(|value| !value.is_empty())
        .map(String::as_str);
    let mut profile = inference_profile_with_destination(
        name,
        &want["endpoint"],
        if want.get("provider_type").is_some_and(|s| s == "anthropic") {
            "anthropic"
        } else {
            "openai"
        },
        authenticated,
        destination_ip,
    )?;
    for key in [
        "owner",
        "generation",
        "endpoint",
        "provider_type",
        "authenticated",
    ] {
        profile.annotations.insert(
            format!("nemoclaw.nvidia.com/{key}"),
            want.get(key).cloned().unwrap_or_default(),
        );
    }
    if let Some(destination_ip) = destination_ip {
        profile.annotations.insert(
            "nemoclaw.nvidia.com/destination_ip".into(),
            destination_ip.into(),
        );
    }
    profile
        .annotations
        .insert(OWNER.into(), want["owner"].clone());
    profile
        .annotations
        .insert(GENERATION.into(), want["generation"].clone());
    Ok(profile)
}

fn row(
    mut profile: proto::ProviderProfile,
    workspace: &str,
    name: &str,
    catalog_entry: bool,
) -> Result<Row, ObservationError> {
    let owner = profile.annotations.get(OWNER).cloned().unwrap_or_default();
    let generation = profile
        .annotations
        .get(GENERATION)
        .cloned()
        .unwrap_or_default();
    if (!name.starts_with("nemoclaw-inference-") && name != "nemoclaw-brave")
        || profile.id != name
        || profile.resource_version == 0
        || if catalog_entry {
            profile.source != "user" || profile.scope != "workspace"
        } else {
            !profile.source.is_empty() || !profile.scope.is_empty()
        }
        || owner.is_empty()
        || generation.is_empty()
    {
        return Err(ObservationError::BindingMismatch);
    }
    let id = format!("{workspace}/{name}/{}", profile.resource_version);
    profile.resource_version = 0;
    profile.source.clear();
    profile.scope.clear();
    let mut fields: Row = [
        "endpoint",
        "provider_type",
        "authenticated",
        "destination_ip",
    ]
    .map(|key| (key.into(), String::new()))
    .into();
    let expected = if name.starts_with("nemoclaw-inference-") {
        fields.extend([
            ("name".into(), name.into()),
            ("owner".into(), owner.clone()),
            ("generation".into(), generation.clone()),
        ]);
        for key in [
            "endpoint",
            "provider_type",
            "authenticated",
            "destination_ip",
        ] {
            let annotation = profile
                .annotations
                .get(&format!("nemoclaw.nvidia.com/{key}"))
                .cloned();
            fields.insert(
                key.into(),
                if key == "destination_ip" {
                    annotation.unwrap_or_default()
                } else {
                    annotation.ok_or(ObservationError::Incomplete)?
                },
            );
        }
        native_definition(&fields)?
    } else {
        definition(&owner, &generation)
    };
    if profile != expected {
        return Err(ObservationError::BindingMismatch);
    }
    fields.extend(
        [
            ("id", id),
            ("name", name.into()),
            ("workspace", workspace.into()),
            ("owner", owner),
            ("generation", generation),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v)),
    );
    Ok(fields)
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
    if !provider.config.is_empty()
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
    if name != crate::config::search_provider_name(&credential) {
        return Err(ObservationError::BindingMismatch);
    }
    let mut result = base(provider.metadata, name, removing)?;
    result.insert("credential_source".into(), String::new());
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
                true,
            )
        })
        .transpose()
    }
    pub(super) async fn create_profile(&self, want: &Row) -> Result<String, ObservationError> {
        if want["name"] != "nemoclaw-brave" && !want["name"].starts_with("nemoclaw-inference-") {
            return Err(ObservationError::Query);
        }
        let response = self
            .grpc()
            .import_provider_profiles(self.request(proto::ImportProviderProfilesRequest {
                workspace: want["workspace"].clone(),
                profiles: vec![proto::ProviderProfileImportItem {
                    profile: Some(if want["name"] == "nemoclaw-brave" {
                        definition(&want["owner"], &want["generation"])
                    } else {
                        native_definition(want)?
                    }),
                    source: "NemoClaw".into(),
                }],
                ..Default::default()
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
            false,
        )?;
        verify_identity(want, &row)?;
        Ok(row["id"].clone())
    }
}
