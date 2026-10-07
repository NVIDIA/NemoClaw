// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use nemoclaw_sdk::config::SearchProvider;

const PROFILE_METADATA: &str = "nemoclaw.nvidia.com/profile-v1";

fn annotations(fields: Row) -> std::collections::HashMap<String, String> {
    // OpenShell v0.1.2 hashes protobuf map iteration order when computing profile
    // revisions. One annotation containing canonical JSON keeps those bytes stable
    // while retaining all ownership and definition fields. Revisit when the pinned
    // gateway canonicalizes profile hashes: NVIDIA/NemoClaw#12458.
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
pub(super) fn cluster_source(
    want: &Row,
) -> Result<Option<nemoclaw_sdk::kubernetes::services::StorageSpec>, ObservationError> {
    let Some(source) = want
        .get("cluster_source")
        .filter(|source| !source.is_empty())
    else {
        return Ok(None);
    };
    let storage = nemoclaw_sdk::kubernetes::services::StorageSpec::decode(source)
        .map_err(|_| ObservationError::BindingMismatch)?;
    if want.get("owner") != Some(&storage.owner) {
        return Err(ObservationError::BindingMismatch);
    }
    Ok(Some(storage))
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
    let kind = if want.get("provider_type").is_some_and(|s| s == "anthropic") {
        nemoclaw_sdk::config::InferenceProviderKind::Anthropic
    } else {
        nemoclaw_sdk::config::InferenceProviderKind::Openai
    };
    let storage = cluster_source(want)?;
    let mut profile = if let Some(storage) = &storage {
        let addresses: Vec<std::net::IpAddr> = serde_json::from_str(
            want.get("cluster_addresses")
                .ok_or(ObservationError::Incomplete)?,
        )
        .map_err(|_| ObservationError::BindingMismatch)?;
        if addresses.is_empty() {
            return Err(ObservationError::Incomplete);
        }
        nemoclaw_sdk::config::cluster_inference_profile(
            name,
            &want["endpoint"],
            kind,
            authenticated,
            storage,
            &addresses,
        )?
    } else {
        inference_profile(name, &want["endpoint"], kind, authenticated)?
    };
    profile.binaries = binaries(want)?;
    let mut metadata: Row = [
        "owner",
        "generation",
        "endpoint",
        "provider_type",
        "authenticated",
        "binaries_json",
    ]
    .into_iter()
    .map(|key| (key.into(), want.get(key).cloned().unwrap_or_default()))
    .collect();
    if storage.is_some() {
        metadata.insert("cluster_source".into(), want["cluster_source"].clone());
        metadata.insert(
            "cluster_addresses".into(),
            want["cluster_addresses"].clone(),
        );
    }
    profile.annotations = annotations(metadata);
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
    let mut fields: Row = [
        "endpoint",
        "provider_type",
        "authenticated",
        "cluster_source",
    ]
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
        if let Some(source) = metadata.get("cluster_source") {
            fields.insert("cluster_source".into(), source.clone());
            fields.insert(
                "cluster_addresses".into(),
                metadata
                    .get("cluster_addresses")
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
    fields.remove("cluster_addresses");
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
    async fn checked_profile_row(
        &self,
        profile: proto::ProviderProfile,
        workspace: &str,
        name: &str,
        catalog_entry: bool,
    ) -> Result<Row, ObservationError> {
        let fields = row(profile.clone(), workspace, name, catalog_entry)?;
        if let Some(storage) = cluster_source(&fields)? {
            let addresses =
                crate::cluster_services::endpoint_addresses(&storage, &fields["endpoint"]).await?;
            let mut current = fields.clone();
            current.insert(
                "cluster_addresses".into(),
                serde_json::to_string(&addresses).map_err(|_| ObservationError::Incomplete)?,
            );
            if native_definition(&current)?.endpoints != profile.endpoints {
                return Err(ObservationError::BindingMismatch);
            }
        }
        Ok(fields)
    }

    pub(super) async fn observe_profile(
        &self,
        workspace: &str,
        name: &str,
    ) -> Result<Option<Row>, ObservationError> {
        let response = authoritative(
            self.client
                .raw_grpc()
                .get_provider_profile(self.request(proto::GetProviderProfileRequest {
                    id: name.into(),
                    workspace_scope: Some(proto::workspace_selector(workspace)),
                }))
                .await,
        )?;
        match response {
            Some(response) => self
                .checked_profile_row(
                    response.profile.ok_or(ObservationError::Incomplete)?,
                    workspace,
                    name,
                    true,
                )
                .await
                .map(Some),
            None => Ok(None),
        }
    }
    pub(super) async fn create_profile(&self, want: &Row) -> Result<String, ObservationError> {
        let search = SearchProvider::from_profile(&want["name"]);
        if search.is_none() && !want["name"].starts_with("nemoclaw-inference-") {
            return Err(ObservationError::Query);
        }
        let mut observed = want.clone();
        if let Some(storage) = cluster_source(want)? {
            if search.is_some() {
                return Err(ObservationError::Query);
            }
            let addresses =
                crate::cluster_services::endpoint_addresses(&storage, &want["endpoint"]).await?;
            observed.insert(
                "cluster_addresses".into(),
                serde_json::to_string(&addresses).map_err(|_| ObservationError::Incomplete)?,
            );
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
                        native_definition(&observed)?
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
        let row = self
            .checked_profile_row(
                response.profiles.into_iter().next().unwrap(),
                &want["workspace"],
                &want["name"],
                false,
            )
            .await?;
        verify_identity(want, &row)?;
        Ok(row["id"].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    #[test]
    fn owned_cluster_profiles_preserve_exact_observed_addresses_and_reject_broader_grants() {
        for example in [
            include_bytes!("../../../../examples/kubernetes/local-vllm.yaml").as_slice(),
            include_bytes!("../../../../examples/kubernetes/local-ollama.yaml").as_slice(),
        ] {
            let document = nemoclaw_sdk::config::Document::parse(example).unwrap();
            let generations = [
                "workspace",
                "provider",
                "sandbox",
                "kubernetes_storage",
                "kubernetes_gateway",
                "inference_service",
                "ollama_service",
            ]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
            let targets = nemoclaw_sdk::compile::runtime_targets(&document, &generations).unwrap();
            let target = targets
                .iter()
                .find(|target| target.kind == nemoclaw_sdk::kubernetes::services::SERVICE_KIND)
                .unwrap();
            let spec =
                nemoclaw_sdk::kubernetes::services::Spec::decode(&target.values["spec"]).unwrap();
            let mut want = native_fields("", spec.authenticated());
            want.insert("owner".into(), document.metadata.uid.clone());
            want.insert("endpoint".into(), spec.endpoint());
            want.insert("cluster_source".into(), spec.storage().encode().unwrap());
            want.insert(
                "cluster_addresses".into(),
                r#"["10.96.0.42","fd00::42"]"#.into(),
            );
            let mut profile = native_definition(&want).unwrap();
            assert_eq!(
                profile.endpoints[0].allowed_ips,
                ["10.96.0.42/32", "fd00::42/128"]
            );
            profile.resource_version = 1;
            profile.source = "user".into();
            profile.scope = "workspace".into();
            let observed = row(profile.clone(), "workspace", &profile.id, true).unwrap();
            assert_eq!(observed["cluster_source"], want["cluster_source"]);
            profile.endpoints[0].allowed_ips = vec!["10.0.0.0/8".into()];
            assert!(row(profile.clone(), "workspace", &profile.id, true).is_err());
            for (key, value) in [
                ("endpoint", "http://foreign.namespace.svc:8000/v1"),
                ("cluster_addresses", "[]"),
                ("cluster_addresses", r#"["127.0.0.1"]"#),
                (
                    "authenticated",
                    if spec.authenticated() {
                        "false"
                    } else {
                        "true"
                    },
                ),
            ] {
                let mut changed = want.clone();
                changed.insert(key.into(), value.into());
                assert!(native_definition(&changed).is_err(), "{key}: {value}");
            }
        }
    }

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
