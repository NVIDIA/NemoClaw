// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use nemoclaw_sdk::config::SearchProvider;

const PROFILE_METADATA: &str = "nemoclaw.nvidia.com/profile-v1";

fn annotations(fields: Row) -> std::collections::HashMap<String, String> {
    // OpenShell v0.1.2 hashed protobuf map iteration order when computing profile
    // revisions (NVIDIA/NemoClaw#12458), so one annotation holds canonical JSON.
    // The pinned gateway sorts annotations before hashing (NVIDIA/OpenShell#4122),
    // so this single-annotation encoding is no longer required.
    [(
        PROFILE_METADATA.into(),
        serde_json::to_string(&fields).expect("string map"),
    )]
    .into()
}

fn binaries(want: &Row) -> Result<Vec<proto::NetworkBinary>, ObservationError> {
    let paths: Vec<String> = serde_json::from_str(
        want.get("binaries_json")
            .ok_or(ObservationError::Incomplete)?,
    )
    .map_err(|_| ObservationError::Query)?;
    if paths.is_empty()
        || paths.iter().any(|path| {
            !path.starts_with('/')
                || path.contains('\0')
                || path.split('/').any(|part| part == "..")
        })
    {
        return Err(ObservationError::Query);
    }
    Ok(paths
        .into_iter()
        .map(|path| proto::NetworkBinary { path })
        .collect())
}

fn definition(
    provider: SearchProvider,
    want: &Row,
) -> Result<proto::ProviderProfile, ObservationError> {
    let mut rule = nemoclaw_sdk::config::search_policy(provider);
    let name = &want["name"];
    rule.name = name.clone();
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
    Ok(proto::ProviderProfile {
        id: name.clone(),
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
        binaries: binaries(want)?,
        annotations: annotations(
            ["owner", "generation", "binaries_json"]
                .map(|key| (key.into(), want[key].clone()))
                .into(),
        ),
        ..Default::default()
    })
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
            nemoclaw_sdk::config::InferenceProviderKind::Anthropic
        } else {
            nemoclaw_sdk::config::InferenceProviderKind::Openai
        },
        authenticated,
    )?;
    profile.binaries = binaries(want)?;
    profile.annotations = annotations(
        [
            "owner",
            "generation",
            "endpoint",
            "provider_type",
            "authenticated",
            "binaries_json",
        ]
        .map(|key| (key.into(), want.get(key).cloned().unwrap_or_default()))
        .into(),
    );
    Ok(profile)
}

fn row(
    mut profile: proto::ProviderProfile,
    workspace: &str,
    name: &str,
    catalog_entry: bool,
) -> Result<Row, ObservationError> {
    let metadata: Row = serde_json::from_str(
        profile
            .annotations
            .get(PROFILE_METADATA)
            .ok_or(ObservationError::Incomplete)?,
    )
    .map_err(|_| ObservationError::BindingMismatch)?;
    let owner = metadata.get("owner").cloned().unwrap_or_default();
    let generation = metadata.get("generation").cloned().unwrap_or_default();
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
    fields.extend([
        ("name".into(), name.into()),
        ("owner".into(), owner.clone()),
        ("generation".into(), generation.clone()),
        (
            "binaries_json".into(),
            metadata
                .get("binaries_json")
                .cloned()
                .ok_or(ObservationError::Incomplete)?,
        ),
    ]);
    let expected = if name.starts_with("nemoclaw-inference-") {
        fields.extend([
            ("name".into(), name.into()),
            ("owner".into(), owner.clone()),
            ("generation".into(), generation.clone()),
        ]);
        for key in ["endpoint", "provider_type", "authenticated"] {
            fields.insert(
                key.into(),
                metadata
                    .get(key)
                    .cloned()
                    .ok_or(ObservationError::Incomplete)?,
            );
        }
        native_definition(&fields)?
    } else {
        definition(search.ok_or(ObservationError::Query)?, &fields)?
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
    if name != nemoclaw_sdk::config::search_provider_name(search, &credential, &provider.r#type) {
        return Err(ObservationError::BindingMismatch);
    }
    let mut result = base(provider.metadata, name, removing)?;
    result.insert("credential_source".into(), String::new());
    result.extend([
        ("endpoint".into(), search.endpoint().into()),
        ("provider_type".into(), search.name().into()),
        ("profile_name".into(), provider.r#type),
        ("credential_env".into(), credential),
    ]);
    Ok(result)
}
impl ConnectedOpenShellGateway {
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
                    workspace_scope: Some(proto::workspace_selector(workspace)),
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
                workspace_scope: Some(proto::workspace_selector(&want["workspace"])),
                profiles: vec![proto::ProviderProfileImportItem {
                    profile: Some(if let Some(search) = search {
                        definition(search, want)?
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
    use prost::Message;

    fn native_fields(kind: &str, authenticated: bool) -> Row {
        [
            ("binaries_json", r#"["/srv/python3.99","/srv/bun"]"#),
            ("name", "nemoclaw-inference-test"),
            ("owner", "deployment"),
            ("generation", "generation"),
            ("endpoint", "https://inference.example.com/v1"),
            ("provider_type", kind),
            (
                "authenticated",
                if authenticated { "true" } else { "false" },
            ),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
    }

    fn search_definition(provider: SearchProvider) -> proto::ProviderProfile {
        let mut fields = native_fields("", true);
        fields.insert("name".into(), provider.profile().into());
        definition(provider, &fields).unwrap()
    }

    #[test]
    fn executable_grants_require_observed_paths_and_reject_live_broadening() {
        for encoded in ["[]", "{}", r#"["python"]"#, r#"["/srv/../bin/python"]"#] {
            let mut want = native_fields("", true);
            want.insert("binaries_json".into(), encoded.into());
            assert!(native_definition(&want).is_err());
            want.insert("name".into(), SearchProvider::Brave.profile().into());
            assert!(definition(SearchProvider::Brave, &want).is_err());
        }
        let mut profile = native_definition(&native_fields("", true)).unwrap();
        assert_eq!(
            profile
                .binaries
                .iter()
                .map(|binary| binary.path.as_str())
                .collect::<Vec<_>>(),
            ["/srv/python3.99", "/srv/bun"]
        );
        profile.resource_version = 1;
        profile.source = "user".into();
        profile.scope = "workspace".into();
        assert!(row(profile.clone(), "workspace", &profile.id, true).is_ok());
        profile.binaries.clear();
        assert!(row(profile.clone(), "workspace", &profile.id, true).is_err());
    }

    #[test]
    fn imported_profiles_have_stable_revision_bytes_after_wire_round_trips() {
        let mut profiles = vec![
            search_definition(SearchProvider::Brave),
            search_definition(SearchProvider::Tavily),
        ];
        for kind in ["", "anthropic"] {
            for authenticated in [false, true] {
                profiles.push(native_definition(&native_fields(kind, authenticated)).unwrap());
            }
        }
        for mut profile in profiles {
            profile.resource_version = 1;
            profile.source = "user".into();
            profile.scope = "workspace".into();
            let bytes = profile.encode_to_vec();
            for _ in 0..64 {
                // The pinned gateway hashes these bytes after rebuilding its catalog.
                let decoded = proto::ProviderProfile::decode(bytes.as_slice()).unwrap();
                assert!(
                    decoded.encode_to_vec() == bytes,
                    "unstable profile: {}",
                    profile.id
                );
                let observed = row(decoded, "workspace", &profile.id, true).unwrap();
                assert_eq!(observed["owner"], "deployment");
                assert_eq!(observed["generation"], "generation");
                assert_eq!(observed["id"], format!("workspace/{}/1", profile.id));
            }
        }
    }

    #[test]
    fn profile_observation_rejects_missing_ambiguous_or_foreign_metadata() {
        let want = native_fields("", true);
        let mut profile = native_definition(&want).unwrap();
        profile.resource_version = 1;
        profile.source = "user".into();
        profile.scope = "workspace".into();
        let observed = row(profile.clone(), "workspace", &profile.id, true).unwrap();
        verify_identity(&want, &observed).unwrap();
        for key in [
            "owner",
            "generation",
            "endpoint",
            "provider_type",
            "authenticated",
        ] {
            let mut missing = profile.clone();
            let mut metadata: Row =
                serde_json::from_str(&missing.annotations[PROFILE_METADATA]).unwrap();
            metadata.remove(key);
            missing.annotations = annotations(metadata);
            assert!(
                row(missing, "workspace", &profile.id, true).is_err(),
                "missing {key}"
            );
        }
        for value in ["{}", "null", "not JSON", "{\"owner\":7}"] {
            let mut malformed = profile.clone();
            malformed
                .annotations
                .insert(PROFILE_METADATA.into(), value.into());
            assert!(row(malformed, "workspace", &profile.id, true).is_err());
        }
        let mut extra = profile.clone();
        extra.annotations.insert(OWNER.into(), "deployment".into());
        assert!(row(extra, "workspace", &profile.id, true).is_err());
        let mut unknown = profile.clone();
        let mut metadata: Row =
            serde_json::from_str(&unknown.annotations[PROFILE_METADATA]).unwrap();
        metadata.insert("unexpected".into(), "value".into());
        unknown.annotations = annotations(metadata);
        assert!(row(unknown, "workspace", &profile.id, true).is_err());
        for key in ["owner", "generation"] {
            let mut foreign = profile.clone();
            let mut metadata: Row =
                serde_json::from_str(&foreign.annotations[PROFILE_METADATA]).unwrap();
            metadata.insert(key.into(), "someone-else".into());
            foreign.annotations = annotations(metadata);
            let observed = row(foreign, "workspace", &profile.id, true).unwrap();
            assert_eq!(
                verify_identity(&want, &observed),
                Err(ObservationError::BindingMismatch)
            );
        }
    }

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
            let mut profile = search_definition(provider);
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
