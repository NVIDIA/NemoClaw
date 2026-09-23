// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::config::SearchProvider;

fn definition(provider: SearchProvider, owner: &str, generation: &str) -> proto::ProviderProfile {
    let rule = crate::config::integration_policy::search_policy(provider);
    let name = provider.profile();
    let policy = openshell_policy::parse_sandbox_policy(
        &serde_json::json!({
            "version": 1, "network_policies": {name: rule}
        })
        .to_string(),
    )
    .expect("static search policy");
    let network = &policy.network_policies[name];
    let (display, auth_style, header_name) = match provider {
        SearchProvider::Brave => ("Brave", "header", "X-Subscription-Token"),
        SearchProvider::Tavily => ("Tavily", "bearer", "authorization"),
    };
    proto::ProviderProfile {
        id: name.into(),
        display_name: format!("NemoClaw {display} Search"),
        description: format!("Declared {display} web search"),
        category: proto::ProviderProfileCategory::Knowledge as i32,
        credentials: vec![proto::ProviderProfileCredential {
            name: provider.credential_env().into(),
            description: format!("{display} Search API key"),
            env_vars: vec![provider.credential_env().into()],
            required: true,
            auth_style: auth_style.into(),
            header_name: header_name.into(),
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
    let mut profile = inference_profile(
        name,
        &want["endpoint"],
        if want.get("provider_type").is_some_and(|s| s == "anthropic") {
            crate::config::InferenceProviderKind::Anthropic
        } else {
            crate::config::InferenceProviderKind::Openai
        },
        authenticated,
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
    let search = SearchProvider::from_profile(name);
    if (!name.starts_with("nemoclaw-inference-") && search.is_none())
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
    let mut fields: Row = ["endpoint", "provider_type", "authenticated"]
        .map(|key| (key.into(), String::new()))
        .into();
    let expected = if name.starts_with("nemoclaw-inference-") {
        fields.extend([
            ("name".into(), name.into()),
            ("owner".into(), owner.clone()),
            ("generation".into(), generation.clone()),
        ]);
        for key in ["endpoint", "provider_type", "authenticated"] {
            fields.insert(
                key.into(),
                profile
                    .annotations
                    .get(&format!("nemoclaw.nvidia.com/{key}"))
                    .cloned()
                    .ok_or(ObservationError::Incomplete)?,
            );
        }
        native_definition(&fields)?
    } else {
        definition(search.ok_or(ObservationError::Query)?, &owner, &generation)
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
    let search =
        SearchProvider::from_profile(&provider.r#type).ok_or(ObservationError::BindingMismatch)?;
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
    if name != crate::config::search_provider_name(search, &credential) {
        return Err(ObservationError::BindingMismatch);
    }
    let mut result = base(provider.metadata, name, removing)?;
    result.insert("credential_source".into(), String::new());
    result.extend([
        ("endpoint".into(), search.endpoint().into()),
        ("provider_type".into(), search.name().into()),
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
            self.client
                .raw_grpc()
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
        let search = SearchProvider::from_profile(&want["name"]);
        if search.is_none() && !want["name"].starts_with("nemoclaw-inference-") {
            return Err(ObservationError::Query);
        }
        let response = self
            .client
            .raw_grpc()
            .import_provider_profiles(self.request(proto::ImportProviderProfilesRequest {
                workspace: want["workspace"].clone(),
                profiles: vec![proto::ProviderProfileImportItem {
                    profile: Some(if let Some(search) = search {
                        definition(search, &want["owner"], &want["generation"])
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_profiles_define_provider_auth_and_reject_endpoint_or_credential_drift() {
        for (provider, auth, header, env) in [
            (
                SearchProvider::Brave,
                "header",
                "X-Subscription-Token",
                "BRAVE_API_KEY",
            ),
            (
                SearchProvider::Tavily,
                "bearer",
                "authorization",
                "TAVILY_API_KEY",
            ),
        ] {
            let mut profile = definition(provider, "deployment", "generation");
            assert_eq!(profile.credentials.len(), 1);
            assert_eq!(profile.credentials[0].auth_style, auth);
            assert_eq!(profile.credentials[0].header_name, header);
            assert_eq!(profile.credentials[0].env_vars, [env]);
            assert!(profile.credentials[0].required);
            assert_eq!(profile.endpoints.len(), 1);
            assert_eq!(
                format!("https://{}", profile.endpoints[0].host),
                provider.endpoint()
            );
            profile.resource_version = 1;
            profile.source = "user".into();
            profile.scope = "workspace".into();
            let observed = row(profile.clone(), "workspace", provider.profile(), true).unwrap();
            assert_eq!(observed["owner"], "deployment");
            assert_eq!(
                observed["id"],
                format!("workspace/{}/1", provider.profile())
            );
            let mut changed = profile.clone();
            changed.endpoints[0].host = "other.example".into();
            assert!(row(changed, "workspace", provider.profile(), true).is_err());
            let mut changed = profile.clone();
            changed.credentials[0].env_vars = vec!["OTHER_KEY".into()];
            assert!(row(changed, "workspace", provider.profile(), true).is_err());
            profile.credentials[0].auth_style = "none".into();
            assert!(row(profile, "workspace", provider.profile(), true).is_err());
        }
    }
}
