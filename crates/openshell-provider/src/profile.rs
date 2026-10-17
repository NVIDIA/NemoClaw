// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use nemoclaw_openshell::search::SearchProvider;

const BINARIES: &str = "nemoclaw.nvidia.com/binaries";
const ENDPOINT: &str = "nemoclaw.nvidia.com/endpoint";
const PROVIDER_TYPE: &str = "nemoclaw.nvidia.com/provider-type";
const AUTHENTICATED: &str = "nemoclaw.nvidia.com/authenticated";
const CLUSTER_SOURCE: &str = "nemoclaw.nvidia.com/cluster-source";
const CLUSTER_ADDRESSES: &str = "nemoclaw.nvidia.com/cluster-addresses";
const AUTH_STYLE: &str = "nemoclaw.nvidia.com/auth-style";
const HEADER_NAME: &str = "nemoclaw.nvidia.com/header-name";

/// Each ownership and definition field, and the profile annotation that carries it.
const FIELDS: [(&str, &str); 10] = [
    ("owner", OWNER),
    ("generation", GENERATION),
    ("binaries_json", BINARIES),
    ("endpoint", ENDPOINT),
    ("provider_type", PROVIDER_TYPE),
    ("authenticated", AUTHENTICATED),
    ("cluster_source", CLUSTER_SOURCE),
    ("cluster_addresses", CLUSTER_ADDRESSES),
    ("auth_style", AUTH_STYLE),
    ("header_name", HEADER_NAME),
];

fn annotations(fields: Row) -> Result<std::collections::HashMap<String, String>, ObservationError> {
    fields
        .into_iter()
        .map(|(field, value)| {
            let (_, key) = FIELDS
                .iter()
                .find(|(name, _)| *name == field)
                .ok_or(ObservationError::Incomplete)?;
            Ok(((*key).into(), value))
        })
        .collect()
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
    definition_with_rule(
        provider,
        want,
        nemoclaw_openshell::search::search_policy(provider),
    )
}

fn definition_with_rule(
    provider: SearchProvider,
    want: &Row,
    mut rule: nemoclaw_openshell::policy::PolicyRule,
) -> Result<proto::ProviderProfile, ObservationError> {
    let name = &want["name"];
    rule.name = name.clone();
    let policy = openshell_policy::parse_sandbox_policy(
        &serde_json::json!({
            "version": 1, "network_policies": {name: rule}
        })
        .to_string(),
    )
    .map_err(|_| ObservationError::Query)?;
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
        )?,
        ..Default::default()
    })
}
pub(super) fn cluster_source(
    want: &Row,
    services: &dyn Services,
) -> Result<bool, ObservationError> {
    let Some(_) = want
        .get("cluster_source")
        .filter(|source| !source.is_empty())
    else {
        return Ok(false);
    };
    services.validate_cluster_source(want)?;
    Ok(true)
}

fn native_definition(
    want: &Row,
    services: &dyn Services,
) -> Result<proto::ProviderProfile, ObservationError> {
    let name = want["name"]
        .strip_prefix("nemoclaw-inference-")
        .ok_or(ObservationError::Query)?;
    let authenticated = match want.get("authenticated").map(String::as_str) {
        Some("true") => true,
        Some("false") => false,
        _ => return Err(ObservationError::Query),
    };
    let kind = if want.get("provider_type").is_some_and(|s| s == "anthropic") {
        nemoclaw_openshell::profile::InferenceProviderKind::Anthropic
    } else {
        nemoclaw_openshell::profile::InferenceProviderKind::Openai
    };
    let cluster = cluster_source(want, services)?;
    let mut profile = if cluster {
        let addresses: Vec<std::net::IpAddr> = serde_json::from_str(
            want.get("cluster_addresses")
                .ok_or(ObservationError::Incomplete)?,
        )
        .map_err(|_| ObservationError::BindingMismatch)?;
        if addresses.is_empty() {
            return Err(ObservationError::Incomplete);
        }
        nemoclaw_openshell::profile::cluster_definition(
            name,
            &want["endpoint"],
            kind,
            authenticated,
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
    if cluster {
        metadata.insert("cluster_source".into(), want["cluster_source"].clone());
        metadata.insert(
            "cluster_addresses".into(),
            want["cluster_addresses"].clone(),
        );
    }
    profile.annotations = annotations(metadata)?;
    Ok(profile)
}

pub(super) fn api_definition(want: &Row) -> Result<proto::ProviderProfile, ObservationError> {
    let name = want["name"]
        .strip_prefix("nemoclaw-api-")
        .ok_or(ObservationError::Query)?;
    let mut profile = nemoclaw_openshell::api::definition(
        name,
        &want["endpoint"],
        &want["auth_style"],
        &want["header_name"],
    )?;
    profile.binaries = binaries(want)?;
    profile.annotations = annotations(
        [
            "owner",
            "generation",
            "endpoint",
            "binaries_json",
            "auth_style",
            "header_name",
        ]
        .into_iter()
        .map(|field| (field.into(), want[field].clone()))
        .collect(),
    )?;
    Ok(profile)
}

fn row(
    mut profile: proto::ProviderProfile,
    workspace: &str,
    name: &str,
    catalog_entry: bool,
    services: &dyn Services,
) -> Result<Row, ObservationError> {
    let metadata: Row = FIELDS
        .iter()
        .filter_map(|(field, key)| {
            let value = profile.annotations.get(*key)?;
            Some(((*field).into(), value.clone()))
        })
        .collect();
    let owner = metadata.get("owner").cloned().unwrap_or_default();
    let generation = metadata.get("generation").cloned().unwrap_or_default();
    let search = SearchProvider::from_profile(name);
    let api = name.starts_with("nemoclaw-api-");
    if (!name.starts_with("nemoclaw-inference-") && !api && search.is_none())
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
    let expected = if api {
        for field in ["endpoint", "auth_style", "header_name"] {
            fields.insert(
                field.into(),
                metadata
                    .get(field)
                    .cloned()
                    .ok_or(ObservationError::Incomplete)?,
            );
        }
        api_definition(&fields)?
    } else if name.starts_with("nemoclaw-inference-") {
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
        native_definition(&fields, services)?
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
    if name
        != nemoclaw_openshell::search::search_provider_name(search, &credential, &provider.r#type)
    {
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
async fn checked_profile_row_with<F>(
    profile: proto::ProviderProfile,
    workspace: &str,
    name: &str,
    catalog_entry: bool,
    removing: bool,
    services: &dyn Services,
    check: impl FnOnce(Row) -> F,
) -> Result<Row, ObservationError>
where
    F: std::future::Future<Output = Result<Vec<std::net::IpAddr>, ObservationError>>,
{
    let fields = row(profile.clone(), workspace, name, catalog_entry, services)?;
    if !removing && cluster_source(&fields, services)? {
        let addresses = check(fields.clone()).await?;
        let mut current = fields.clone();
        current.insert(
            "cluster_addresses".into(),
            serde_json::to_string(&addresses).map_err(|_| ObservationError::Incomplete)?,
        );
        if native_definition(&current, services)?.endpoints != profile.endpoints {
            return Err(ObservationError::BindingMismatch);
        }
    }
    Ok(fields)
}

impl ConnectedOpenShellGateway {
    pub(super) async fn sandbox_cluster_grants(
        &self,
        want: &Row,
    ) -> Result<network::ClusterGrants, ObservationError> {
        let input = network::policy_input(want)?;
        let mut grants = network::ClusterGrants::new();
        for name in &input.cluster_grants {
            let profile = self
                .client
                .raw_grpc()
                .get_provider_profile(self.request(proto::GetProviderProfileRequest {
                    id: name.clone(),
                    workspace_scope: Some(proto::workspace_selector(&want["workspace"])),
                }))
                .await
                .map_err(|error| remote_error(&error))?
                .into_inner()
                .profile
                .ok_or(ObservationError::Incomplete)?;
            let fields = self
                .checked_profile_row(profile.clone(), &want["workspace"], name, true, false)
                .await?;
            grants.insert(
                name.clone(),
                cluster_grant(want, name, &profile, &fields, self.services.as_ref())?,
            );
        }
        network::granted_row_policy(want, &grants)?;
        Ok(grants)
    }
    async fn checked_profile_row(
        &self,
        profile: proto::ProviderProfile,
        workspace: &str,
        name: &str,
        catalog_entry: bool,
        removing: bool,
    ) -> Result<Row, ObservationError> {
        checked_profile_row_with(
            profile,
            workspace,
            name,
            catalog_entry,
            removing,
            self.services.as_ref(),
            |fields| async move { self.services.cluster_addresses(&fields).await },
        )
        .await
    }

    pub(super) async fn observe_profile(
        &self,
        workspace: &str,
        name: &str,
        removing: bool,
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
                    removing,
                )
                .await
                .map(Some),
            None => Ok(None),
        }
    }
    pub(super) async fn create_profile(&self, want: &Row) -> Result<String, ObservationError> {
        let search = SearchProvider::from_profile(&want["name"]);
        let api = want["name"].starts_with("nemoclaw-api-");
        if search.is_none() && !api && !want["name"].starts_with("nemoclaw-inference-") {
            return Err(ObservationError::Query);
        }
        let mut observed = want.clone();
        if cluster_source(want, self.services.as_ref())? {
            if search.is_some() {
                return Err(ObservationError::Query);
            }
            let addresses = self.services.cluster_addresses(want).await?;
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
                    profile: Some(if api {
                        api_definition(want)?
                    } else if let Some(search) = search {
                        definition(search, want)?
                    } else {
                        native_definition(&observed, self.services.as_ref())?
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
                false,
            )
            .await?;
        verify_identity(want, &row)?;
        Ok(row["id"].clone())
    }
}

fn cluster_grant(
    want: &Row,
    name: &str,
    profile: &proto::ProviderProfile,
    fields: &Row,
    services: &dyn Services,
) -> Result<Vec<String>, ObservationError> {
    if want.get("owner") != fields.get("owner")
        || !cluster_source(fields, services)?
        || profile.id != name
    {
        return Err(ObservationError::BindingMismatch);
    }
    let provider = name
        .strip_prefix("nemoclaw-inference-")
        .ok_or(ObservationError::BindingMismatch)?;
    if !inference::provider_names(&want["provider_names_json"])?
        .iter()
        .any(|name| name == provider)
    {
        return Err(ObservationError::BindingMismatch);
    }
    let policy = row_policy(want)?;
    let rule = policy
        .network_policies
        .get(name)
        .ok_or(ObservationError::BindingMismatch)?;
    if rule.endpoints.len() != 1 || profile.endpoints.len() != 1 {
        return Err(ObservationError::BindingMismatch);
    }
    let mut endpoint = profile.endpoints[0].clone();
    let addresses = std::mem::take(&mut endpoint.allowed_ips);
    if endpoint != rule.endpoints[0] {
        return Err(ObservationError::BindingMismatch);
    }
    Ok(addresses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    #[test]
    fn unsupported_profile_metadata_returns_an_error_instead_of_panicking() {
        let result = std::panic::catch_unwind(|| {
            annotations(Row::from([("unknown_field".into(), "value".into())]))
        });
        assert!(
            result.is_ok(),
            "unsupported metadata must return an observation error"
        );
        assert_eq!(result.unwrap(), Err(ObservationError::Incomplete));
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
    fn unsupported_search_rules_return_an_observation_error() {
        for provider in [SearchProvider::Brave, SearchProvider::Tavily] {
            for invalid_tls in [true, false] {
                let mut fields = native_fields("", true);
                fields.insert("name".into(), provider.profile().into());
                let mut rule = nemoclaw_openshell::search::search_policy(provider);
                if invalid_tls {
                    rule.endpoints[0].tls = Some("unsupported-mode".into());
                } else {
                    rule.endpoints[0].enforcement = Some("unsupported-mode".into());
                }
                let error = definition_with_rule(provider, &fields, rule)
                    .expect_err("unsupported search policy must return an error, not panic");
                assert_eq!(error, ObservationError::Query);
            }
        }
    }

    #[test]
    fn executable_grants_require_observed_paths_and_reject_live_broadening() {
        for encoded in ["[]", "{}", r#"["python"]"#, r#"["/srv/../bin/python"]"#] {
            let mut want = native_fields("", true);
            want.insert("binaries_json".into(), encoded.into());
            assert!(native_definition(&want, &DockerServices).is_err());
            want.insert("name".into(), SearchProvider::Brave.profile().into());
            assert!(definition(SearchProvider::Brave, &want).is_err());
        }
        let mut profile = native_definition(&native_fields("", true), &DockerServices).unwrap();
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
        assert!(
            row(
                profile.clone(),
                "workspace",
                &profile.id,
                true,
                &DockerServices
            )
            .is_ok()
        );
        profile.binaries.clear();
        assert!(
            row(
                profile.clone(),
                "workspace",
                &profile.id,
                true,
                &DockerServices
            )
            .is_err()
        );
    }

    #[test]
    fn imported_profiles_survive_wire_round_trips() {
        let mut profiles = vec![
            search_definition(SearchProvider::Brave),
            search_definition(SearchProvider::Tavily),
        ];
        for kind in ["", "anthropic"] {
            for authenticated in [false, true] {
                profiles.push(
                    native_definition(&native_fields(kind, authenticated), &DockerServices)
                        .unwrap(),
                );
            }
        }
        for mut profile in profiles {
            profile.resource_version = 1;
            profile.source = "user".into();
            profile.scope = "workspace".into();
            let bytes = profile.encode_to_vec();
            for _ in 0..64 {
                let decoded = proto::ProviderProfile::decode(bytes.as_slice()).unwrap();
                let observed =
                    row(decoded, "workspace", &profile.id, true, &DockerServices).unwrap();
                assert_eq!(observed["owner"], "deployment");
                assert_eq!(observed["generation"], "generation");
                assert_eq!(observed["id"], format!("workspace/{}/1", profile.id));
            }
        }
    }

    #[test]
    fn profile_observation_rejects_missing_ambiguous_or_foreign_metadata() {
        let want = native_fields("", true);
        let mut profile = native_definition(&want, &DockerServices).unwrap();
        profile.resource_version = 1;
        profile.source = "user".into();
        profile.scope = "workspace".into();
        let observed = row(
            profile.clone(),
            "workspace",
            &profile.id,
            true,
            &DockerServices,
        )
        .unwrap();
        verify_identity(&want, &observed).unwrap();
        for key in [
            OWNER,
            GENERATION,
            BINARIES,
            ENDPOINT,
            PROVIDER_TYPE,
            AUTHENTICATED,
        ] {
            let mut missing = profile.clone();
            assert!(missing.annotations.remove(key).is_some(), "{key}");
            assert!(
                row(missing, "workspace", &profile.id, true, &DockerServices).is_err(),
                "missing {key}"
            );
        }
        for value in ["", "{}", "null", "not JSON", "[7]"] {
            let mut malformed = profile.clone();
            malformed.annotations.insert(BINARIES.into(), value.into());
            assert!(row(malformed, "workspace", &profile.id, true, &DockerServices).is_err());
        }
        let mut unknown = profile.clone();
        unknown
            .annotations
            .insert("nemoclaw.nvidia.com/unexpected".into(), "value".into());
        assert!(row(unknown, "workspace", &profile.id, true, &DockerServices).is_err());
        for key in [OWNER, GENERATION] {
            let mut foreign = profile.clone();
            foreign
                .annotations
                .insert(key.into(), "someone-else".into());
            let observed = row(foreign, "workspace", &profile.id, true, &DockerServices).unwrap();
            assert_eq!(
                verify_identity(&want, &observed),
                Err(ObservationError::BindingMismatch)
            );
        }
    }

    #[test]
    fn profile_metadata_is_one_annotation_per_field() {
        let native = native_definition(&native_fields("anthropic", true), &DockerServices).unwrap();
        assert_eq!(
            native.annotations,
            [
                (OWNER, "deployment"),
                (GENERATION, "generation"),
                (BINARIES, r#"["/srv/python3.99","/srv/bun"]"#),
                (ENDPOINT, "https://inference.example.com/v1"),
                (PROVIDER_TYPE, "anthropic"),
                (AUTHENTICATED, "true"),
            ]
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .into()
        );
        let mut search: Vec<_> = search_definition(SearchProvider::Brave)
            .annotations
            .into_keys()
            .collect();
        search.sort();
        assert_eq!(search, [BINARIES, GENERATION, OWNER]);
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
            let observed = row(
                profile.clone(),
                "workspace",
                provider.profile(),
                true,
                &DockerServices,
            )
            .unwrap();
            assert_eq!(observed["owner"], "deployment");
            assert_eq!(
                observed["id"],
                format!("workspace/{}/1", provider.profile())
            );
            let mut changed = profile.clone();
            changed.endpoints[0].host = "other.example".into();
            assert!(
                row(
                    changed,
                    "workspace",
                    provider.profile(),
                    true,
                    &DockerServices
                )
                .is_err()
            );
            let mut changed = profile.clone();
            changed.credentials[0].env_vars = vec!["OTHER_KEY".into()];
            assert!(
                row(
                    changed,
                    "workspace",
                    provider.profile(),
                    true,
                    &DockerServices
                )
                .is_err()
            );
            profile.credentials[0].auth_style = "none".into();
            assert!(
                row(
                    profile,
                    "workspace",
                    provider.profile(),
                    true,
                    &DockerServices
                )
                .is_err()
            );
        }
    }
    const FIXTURE_CLUSTER_SOURCE: &str = "fixture-cluster-source";
    const CLUSTER_ENDPOINT: &str = "http://model.agents.svc.cluster.local:8000/v1";

    /// Accepts only the fixture cluster source; tests supply observed addresses.
    struct ClusterServices;

    #[async_trait::async_trait]
    impl Services for ClusterServices {
        fn validate_credential_source(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<(), ObservationError> {
            Err(ObservationError::Incomplete)
        }

        async fn resolve_credential_source(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<String, ObservationError> {
            panic!("profile tests must not resolve credentials")
        }

        fn validate_cluster_source(&self, fields: &Row) -> Result<(), ObservationError> {
            if fields.get("cluster_source").map(String::as_str) == Some(FIXTURE_CLUSTER_SOURCE)
                && fields.get("owner").is_some_and(|owner| !owner.is_empty())
            {
                Ok(())
            } else {
                Err(ObservationError::BindingMismatch)
            }
        }

        async fn cluster_addresses(
            &self,
            _: &Row,
        ) -> Result<Vec<std::net::IpAddr>, ObservationError> {
            panic!("profile tests must supply observed addresses explicitly")
        }
    }

    /// A sandbox whose managed inference rule takes its addresses from the
    /// cluster profile it uses, and that profile's desired fields.
    fn cluster_case() -> (Row, Row) {
        let rows = nemoclaw_test_fixtures::openshell::contract_rows("fabric-openclaw");
        let row = |kind: &str| {
            rows.iter()
                .find(|(name, _)| *name == kind)
                .unwrap()
                .1
                .clone()
        };
        let mut fields = row("provider_profile");
        fields.insert("endpoint".into(), CLUSTER_ENDPOINT.into());
        fields.insert("cluster_source".into(), FIXTURE_CLUSTER_SOURCE.into());
        fields.insert(
            "cluster_addresses".into(),
            r#"["10.96.0.42","fd00::42"]"#.into(),
        );
        let mut sandbox = row("sandbox");
        let mut policy: serde_json::Value = serde_json::from_str(&sandbox["policy_json"]).unwrap();
        let endpoint = &mut policy["managed"][fields["name"].as_str()]["endpoints"][0];
        endpoint["host"] = "model.agents.svc.cluster.local".into();
        endpoint["port"] = 8000.into();
        endpoint["allowed_ips"] = serde_json::json!([]);
        policy["cluster_grants"] = serde_json::json!([fields["name"]]);
        sandbox.insert("policy_json".into(), policy.to_string());
        (sandbox, fields)
    }

    #[test]
    fn docker_services_reject_cluster_profiles() {
        let (_, fields) = cluster_case();
        assert_eq!(
            native_definition(&fields, &DockerServices).err(),
            Some(ObservationError::BindingMismatch)
        );
    }

    #[test]
    fn owned_cluster_profiles_grant_exact_observed_addresses_and_reject_others() {
        let (_, fields) = cluster_case();
        let mut profile = native_definition(&fields, &ClusterServices).unwrap();
        assert_eq!(
            profile.endpoints[0].allowed_ips,
            ["10.96.0.42/32", "fd00::42/128"]
        );
        assert_eq!(profile.annotations[CLUSTER_SOURCE], FIXTURE_CLUSTER_SOURCE);
        profile.resource_version = 1;
        profile.source = "user".into();
        profile.scope = "workspace".into();
        let observed = row(
            profile.clone(),
            "workspace",
            &profile.id,
            true,
            &ClusterServices,
        )
        .unwrap();
        assert_eq!(observed["cluster_source"], FIXTURE_CLUSTER_SOURCE);
        assert!(!observed.contains_key("cluster_addresses"));
        for addresses in [
            r#"[]"#,
            r#"["255.255.255.255"]"#,
            r#"["::ffff:127.0.0.1"]"#,
            r#"["::ffff:10.0.0.1"]"#,
            r#"["10.0.0.0/8"]"#,
        ] {
            let mut want = fields.clone();
            want.insert("cluster_addresses".into(), addresses.into());
            assert!(
                native_definition(&want, &ClusterServices).is_err(),
                "{addresses}"
            );
        }
        let mut missing = fields.clone();
        missing.remove("cluster_addresses");
        assert!(native_definition(&missing, &ClusterServices).is_err());
        let mut broader = profile.clone();
        broader.endpoints[0].allowed_ips = vec!["10.0.0.0/8".into()];
        assert!(row(broader, "workspace", &profile.id, true, &ClusterServices).is_err());
    }

    #[test]
    fn cluster_grants_resolve_the_endpoint_ambiguity_with_the_provider_profile() {
        let (sandbox, fields) = cluster_case();
        let profile = native_definition(&fields, &ClusterServices).unwrap();
        let grants = [(profile.id.clone(), profile.endpoints[0].allowed_ips.clone())].into();
        let layer = openshell_policy::ProviderPolicyLayer {
            rule_name: "_provider_fixture".into(),
            rule: proto::NetworkPolicyRule {
                name: "_provider_fixture".into(),
                endpoints: profile.endpoints,
                binaries: profile.binaries,
            },
        };
        let ungranted = openshell_policy::compose_effective_policy(
            &row_policy(&sandbox).unwrap(),
            std::slice::from_ref(&layer),
        );
        assert_eq!(
            openshell_policy::find_endpoint_ambiguities(&ungranted).len(),
            1
        );
        let request = connected::create_sandbox_request(&sandbox, &grants).unwrap();
        let actual = request.spec.unwrap().policy.unwrap();
        let effective = openshell_policy::compose_effective_policy(&actual, &[layer]);
        let conflicts = openshell_policy::find_endpoint_ambiguities(&effective);
        assert!(conflicts.is_empty(), "{conflicts:?}");
    }

    #[tokio::test]
    async fn profile_removal_validates_recorded_grants_when_the_service_is_absent() {
        let (_, fields) = cluster_case();
        let mut profile = native_definition(&fields, &ClusterServices).unwrap();
        profile.resource_version = 1;
        profile.source = "user".into();
        profile.scope = "workspace".into();
        let check = |profile: proto::ProviderProfile, removing, observed| async move {
            let id = profile.id.clone();
            checked_profile_row_with(
                profile,
                "workspace",
                &id,
                true,
                removing,
                &ClusterServices,
                |_| async { observed },
            )
            .await
        };
        let absent = Err(ObservationError::BindingMismatch);
        assert!(check(profile.clone(), false, absent.clone()).await.is_err());
        assert!(check(profile.clone(), true, absent.clone()).await.is_ok());
        let moved = Ok(vec!["10.96.0.43".parse().unwrap()]);
        assert_eq!(
            check(profile.clone(), false, moved).await.err(),
            Some(ObservationError::BindingMismatch)
        );
        profile.endpoints[0].allowed_ips = vec!["10.0.0.0/8".into()];
        assert!(check(profile, true, absent).await.is_err());
    }

    #[test]
    fn cluster_sandbox_grants_require_the_matching_owned_profile_and_exact_host_addresses() {
        let (sandbox, fields) = cluster_case();
        let profile = native_definition(&fields, &ClusterServices).unwrap();
        let addresses =
            cluster_grant(&sandbox, &profile.id, &profile, &fields, &ClusterServices).unwrap();
        let grants: network::ClusterGrants = [(profile.id.clone(), addresses)].into();
        assert!(connected::create_sandbox_request(&sandbox, &grants).is_ok());
        for replacement in [
            vec![],
            vec!["10.0.0.0/8".into()],
            vec!["::ffff:10.0.0.1/128".into()],
            vec!["255.255.255.255/32".into()],
            vec![
                "10.96.0.42/32".into(),
                "10.96.0.43/32".into(),
                "10.96.0.44/32".into(),
            ],
            vec!["10.96.0.42/32".into(), "10.96.0.42/32".into()],
        ] {
            let mut bad = grants.clone();
            bad.insert(profile.id.clone(), replacement);
            assert!(connected::create_sandbox_request(&sandbox, &bad).is_err());
        }
        assert!(connected::create_sandbox_request(&sandbox, &Default::default()).is_err());
        let mut extra = grants.clone();
        extra.insert("unexpected".into(), vec!["10.96.0.43/32".into()]);
        assert!(connected::create_sandbox_request(&sandbox, &extra).is_err());
        for field in ["owner", "cluster_source"] {
            let mut wrong = fields.clone();
            wrong.remove(field);
            assert!(
                cluster_grant(&sandbox, &profile.id, &profile, &wrong, &ClusterServices).is_err(),
                "{field}"
            );
        }
        for field in ["host", "port", "path"] {
            let mut wrong = profile.clone();
            match field {
                "host" => wrong.endpoints[0].host = "foreign.example".into(),
                "port" => wrong.endpoints[0].port += 1,
                _ => wrong.endpoints[0].path = "/**".into(),
            }
            assert!(
                cluster_grant(&sandbox, &profile.id, &wrong, &fields, &ClusterServices).is_err(),
                "{field}"
            );
        }
        let mut unlisted = sandbox.clone();
        unlisted.insert("provider_names_json".into(), "[]".into());
        assert!(
            cluster_grant(&unlisted, &profile.id, &profile, &fields, &ClusterServices).is_err()
        );
    }

    #[tokio::test]
    async fn sandbox_refresh_verifies_current_grants_but_removal_uses_recorded_policy() {
        let (sandbox, fields) = cluster_case();
        let profile = native_definition(&fields, &ClusterServices).unwrap();
        let grants: network::ClusterGrants =
            [(profile.id.clone(), profile.endpoints[0].allowed_ips.clone())].into();
        let request = connected::create_sandbox_request(&sandbox, &grants).unwrap();
        let response = proto::SandboxResponse {
            sandbox: Some(proto::Sandbox {
                metadata: Some(proto::ObjectMeta {
                    id: "sandbox-id".into(),
                    name: request.name,
                    workspace: sandbox["workspace"].clone(),
                    labels: request.labels,
                    annotations: request.annotations,
                    ..Default::default()
                }),
                spec: request.spec,
                status: Some(proto::SandboxStatus {
                    phase: proto::SandboxPhase::Ready as i32,
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let (workspace, name) = (&sandbox["workspace"], &sandbox["name"]);
        let check = |response, removing, observed| async move {
            checked_sandbox_row_with(response, workspace, name, removing, |_| async { observed })
                .await
        };
        let current = check(response.clone(), false, Ok(grants.clone()))
            .await
            .unwrap();
        assert_eq!(current.2, grants);
        let mut moved = grants.clone();
        moved.insert(profile.id, vec!["10.96.0.43/32".into()]);
        assert!(check(response.clone(), false, Ok(moved)).await.is_err());
        let absent = Err(ObservationError::BindingMismatch);
        assert!(
            check(response.clone(), false, absent.clone())
                .await
                .is_err()
        );
        assert!(check(response.clone(), true, absent.clone()).await.is_ok());
        let mut drift = response;
        drift
            .sandbox
            .as_mut()
            .unwrap()
            .spec
            .as_mut()
            .unwrap()
            .policy
            .as_mut()
            .unwrap()
            .filesystem
            .as_mut()
            .unwrap()
            .read_write
            .push("/".into());
        assert!(check(drift, true, absent).await.is_err());
    }
}
