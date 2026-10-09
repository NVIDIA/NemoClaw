// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use nemoclaw_openshell::search::SearchProvider;

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
    let mut rule = nemoclaw_openshell::search::search_policy(provider);
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
    profile.annotations = annotations(metadata);
    Ok(profile)
}

fn row(
    mut profile: proto::ProviderProfile,
    workspace: &str,
    name: &str,
    catalog_entry: bool,
    services: &dyn Services,
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
        if search.is_none() && !want["name"].starts_with("nemoclaw-inference-") {
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
                    profile: Some(if let Some(search) = search {
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
    if !inference::provider_names(&want["provider_names_json"], &want["agent_runtime"])?
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

    struct TestServices;

    #[async_trait::async_trait]
    impl Services for TestServices {
        fn validate_credential_source(
            &self,
            source: &str,
            owner: &str,
            endpoint: &str,
        ) -> Result<(), ObservationError> {
            nemoclaw_sdk::services::authentication::Source::parse(source, owner, endpoint)
                .map(|_| ())
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
            let storage = nemoclaw_sdk::kubernetes::services::StorageSpec::decode(
                fields
                    .get("cluster_source")
                    .ok_or(ObservationError::Incomplete)?,
            )
            .map_err(|_| ObservationError::BindingMismatch)?;
            if fields.get("owner") != Some(&storage.owner) {
                return Err(ObservationError::BindingMismatch);
            }
            let name = fields["name"]
                .strip_prefix("nemoclaw-inference-")
                .ok_or(ObservationError::Query)?;
            let authenticated = match fields.get("authenticated").map(String::as_str) {
                Some("true") => true,
                Some("false") => false,
                _ => return Err(ObservationError::Query),
            };
            let kind = if fields
                .get("provider_type")
                .is_some_and(|kind| kind == "anthropic")
            {
                nemoclaw_sdk::config::InferenceProviderKind::Anthropic
            } else {
                nemoclaw_sdk::config::InferenceProviderKind::Openai
            };
            nemoclaw_sdk::config::cluster_inference_profile(
                name,
                &fields["endpoint"],
                kind,
                authenticated,
                &storage,
                &[],
            )
            .map(|_| ())
        }

        async fn cluster_addresses(
            &self,
            _: &Row,
        ) -> Result<Vec<std::net::IpAddr>, ObservationError> {
            panic!("profile tests must supply observed addresses explicitly")
        }
    }

    fn cluster_case(example: &[u8]) -> (Row, Row) {
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
        let targets = nemoclaw_sdk::compile::targets(&document, &generations).unwrap();
        let mut sandbox = targets
            .iter()
            .find(|target| target.kind == "sandbox")
            .unwrap()
            .values
            .clone();
        let mut runtime: serde_json::Value =
            serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
        runtime["binaries"] =
            serde_json::json!({"org.fixture.openclaw": ["/opt/fabric/bin/python"]});
        sandbox.insert(
            "runtime_json".into(),
            serde_json::json!({"runtime": runtime, "adapter_id": "org.fixture.openclaw"})
                .to_string(),
        );
        let mut fields = targets
            .iter()
            .find(|target| target.kind == "provider_profile")
            .unwrap()
            .values
            .clone();
        fields.insert(
            "binaries_json".into(),
            r#"["/opt/fabric/bin/python"]"#.into(),
        );
        fields.insert(
            "cluster_addresses".into(),
            r#"["10.96.0.42","fd00::42"]"#.into(),
        );
        (sandbox, fields)
    }

    #[test]
    fn cluster_sandbox_create_request_is_accepted_beside_its_provider_profile() {
        for example in [
            include_bytes!("../../../examples/kubernetes/local-vllm.yaml").as_slice(),
            include_bytes!("../../../examples/kubernetes/local-ollama.yaml").as_slice(),
        ] {
            let (sandbox, fields) = cluster_case(example);
            let profile = native_definition(&fields, &TestServices).unwrap();
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
    }

    #[test]
    fn owned_cluster_profiles_reject_non_service_addresses() {
        let (_, fields) = cluster_case(include_bytes!(
            "../../../examples/kubernetes/local-ollama.yaml"
        ));
        for address in ["255.255.255.255", "::ffff:127.0.0.1", "::ffff:10.0.0.1"] {
            let mut want = fields.clone();
            want.insert(
                "cluster_addresses".into(),
                serde_json::json!([address]).to_string(),
            );
            assert!(
                native_definition(&want, &TestServices).is_err(),
                "{address}"
            );
        }
    }

    #[tokio::test]
    async fn profile_removal_validates_recorded_grants_when_the_service_is_absent() {
        let (_, fields) = cluster_case(include_bytes!(
            "../../../examples/kubernetes/local-ollama.yaml"
        ));
        let mut profile = native_definition(&fields, &TestServices).unwrap();
        profile.resource_version = 1;
        profile.source = "user".into();
        profile.scope = "workspace".into();
        let absent_service = |_| async { Err(ObservationError::BindingMismatch) };
        assert!(
            checked_profile_row_with(
                profile.clone(),
                "workspace",
                &profile.id,
                true,
                false,
                &TestServices,
                absent_service
            )
            .await
            .is_err()
        );
        assert!(
            checked_profile_row_with(
                profile.clone(),
                "workspace",
                &profile.id,
                true,
                true,
                &TestServices,
                absent_service
            )
            .await
            .is_ok()
        );
        profile.endpoints[0].allowed_ips = vec!["10.0.0.0/8".into()];
        assert!(
            checked_profile_row_with(
                profile.clone(),
                "workspace",
                &profile.id,
                true,
                true,
                &TestServices,
                absent_service
            )
            .await
            .is_err()
        );
    }

    #[test]
    fn cluster_sandbox_grants_require_the_matching_owned_profile_and_exact_host_addresses() {
        let (sandbox, fields) = cluster_case(include_bytes!(
            "../../../examples/kubernetes/local-vllm.yaml"
        ));
        let profile = native_definition(&fields, &TestServices).unwrap();
        let addresses =
            cluster_grant(&sandbox, &profile.id, &profile, &fields, &TestServices).unwrap();
        let grants: network::ClusterGrants = [(profile.id.clone(), addresses)].into();
        for replacement in [
            vec![],
            vec!["10.0.0.0/8".into()],
            vec!["::ffff:10.0.0.1/128".into()],
            vec!["255.255.255.255/32".into()],
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
                cluster_grant(&sandbox, &profile.id, &profile, &wrong, &TestServices).is_err(),
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
                cluster_grant(&sandbox, &profile.id, &wrong, &fields, &TestServices).is_err(),
                "{field}"
            );
        }
    }

    #[tokio::test]
    async fn sandbox_refresh_verifies_current_grants_but_removal_uses_recorded_policy() {
        let (sandbox, fields) = cluster_case(include_bytes!(
            "../../../examples/kubernetes/local-ollama.yaml"
        ));
        let profile = native_definition(&fields, &TestServices).unwrap();
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
        let current = checked_sandbox_row_with(
            response.clone(),
            &sandbox["workspace"],
            &sandbox["name"],
            false,
            |_| async { Ok(grants.clone()) },
        )
        .await
        .unwrap();
        assert_eq!(current.2, grants);
        let mut moved = grants.clone();
        moved.insert(profile.id, vec!["10.96.0.43/32".into()]);
        assert!(
            checked_sandbox_row_with(
                response.clone(),
                &sandbox["workspace"],
                &sandbox["name"],
                false,
                |_| async { Ok(moved) }
            )
            .await
            .is_err()
        );
        let absent = |_| async { Err(ObservationError::BindingMismatch) };
        assert!(
            checked_sandbox_row_with(
                response.clone(),
                &sandbox["workspace"],
                &sandbox["name"],
                false,
                absent
            )
            .await
            .is_err()
        );
        assert!(
            checked_sandbox_row_with(
                response.clone(),
                &sandbox["workspace"],
                &sandbox["name"],
                true,
                absent
            )
            .await
            .is_ok()
        );
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
        assert!(
            checked_sandbox_row_with(drift, &sandbox["workspace"], &sandbox["name"], true, absent)
                .await
                .is_err()
        );
    }

    #[test]
    fn owned_cluster_profiles_preserve_exact_observed_addresses_and_reject_broader_grants() {
        for example in [
            include_bytes!("../../../examples/kubernetes/local-vllm.yaml").as_slice(),
            include_bytes!("../../../examples/kubernetes/local-ollama.yaml").as_slice(),
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
            let mut profile = native_definition(&want, &TestServices).unwrap();
            assert_eq!(
                profile.endpoints[0].allowed_ips,
                ["10.96.0.42/32", "fd00::42/128"]
            );
            profile.resource_version = 1;
            profile.source = "user".into();
            profile.scope = "workspace".into();
            let observed = row(
                profile.clone(),
                "workspace",
                &profile.id,
                true,
                &TestServices,
            )
            .unwrap();
            assert_eq!(observed["cluster_source"], want["cluster_source"]);
            profile.endpoints[0].allowed_ips = vec!["10.0.0.0/8".into()];
            assert!(
                row(
                    profile.clone(),
                    "workspace",
                    &profile.id,
                    true,
                    &TestServices
                )
                .is_err()
            );
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
                assert!(
                    native_definition(&changed, &TestServices).is_err(),
                    "{key}: {value}"
                );
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
    fn imported_profiles_have_stable_revision_bytes_after_wire_round_trips() {
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
                // The pinned gateway hashes these bytes after rebuilding its catalog.
                let decoded = proto::ProviderProfile::decode(bytes.as_slice()).unwrap();
                assert!(
                    decoded.encode_to_vec() == bytes,
                    "unstable profile: {}",
                    profile.id
                );
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
                row(missing, "workspace", &profile.id, true, &DockerServices).is_err(),
                "missing {key}"
            );
        }
        for value in ["{}", "null", "not JSON", "{\"owner\":7}"] {
            let mut malformed = profile.clone();
            malformed
                .annotations
                .insert(PROFILE_METADATA.into(), value.into());
            assert!(row(malformed, "workspace", &profile.id, true, &DockerServices).is_err());
        }
        let mut extra = profile.clone();
        extra.annotations.insert(OWNER.into(), "deployment".into());
        assert!(row(extra, "workspace", &profile.id, true, &DockerServices).is_err());
        let mut unknown = profile.clone();
        let mut metadata: Row =
            serde_json::from_str(&unknown.annotations[PROFILE_METADATA]).unwrap();
        metadata.insert("unexpected".into(), "value".into());
        unknown.annotations = annotations(metadata);
        assert!(row(unknown, "workspace", &profile.id, true, &DockerServices).is_err());
        for key in ["owner", "generation"] {
            let mut foreign = profile.clone();
            let mut metadata: Row =
                serde_json::from_str(&foreign.annotations[PROFILE_METADATA]).unwrap();
            metadata.insert(key.into(), "someone-else".into());
            foreign.annotations = annotations(metadata);
            let observed = row(foreign, "workspace", &profile.id, true, &DockerServices).unwrap();
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
}
