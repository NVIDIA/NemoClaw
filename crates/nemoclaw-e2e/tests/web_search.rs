// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_e2e::image_runtime::targets;
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{ObservationError, backend::Backend, compile::Generations, config::Document};
use openshell_provider::{OpenShell, Secrets};
use std::sync::Arc;
struct Key(&'static str);
impl Secrets for Key {
    fn resolve(&self, name: &str) -> Result<String, ObservationError> {
        assert_eq!(name, "SEARCH_KEY");
        Ok(self.0.into())
    }
}
#[tokio::test]
async fn search_preserves_credentials_on_unchanged_ensure_and_removes_owned_registrations() {
    for (provider_type, credential_env) in
        [("brave", "BRAVE_API_KEY"), ("tavily", "TAVILY_API_KEY")]
    {
        search_credential_lifecycle(provider_type, credential_env).await;
    }
}

/// The profile and registration an `openshell_web_search` resource owns,
/// exercised through the OpenShell client directly.
async fn search_credential_lifecycle(provider_type: &str, credential_env: &str) {
    let fixture = Fixture::start().await;
    let mut doc =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    *doc.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    doc.spec.integrations = serde_json::from_value(serde_json::json!({
        "search":{"kind":"webSearch","provider":provider_type,"credential":{"env":"SEARCH_KEY"}}
    }))
    .unwrap();
    doc.spec.sandboxes[0].agent.integration_refs = vec!["search".into()];
    let client = OpenShell::connect(
        &doc.spec.gateway.connection(),
        Arc::new(Key("owned-search-key")),
    )
    .unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let targets = targets(&doc, &generations).unwrap();
    assert!(
        client
            .ensure("workspace", &targets[0].values)
            .await
            .error()
            .is_none()
    );
    let search = &targets
        .iter()
        .find(|t| t.kind == "web_search" && t.values["provider_type"] == provider_type)
        .unwrap()
        .values;
    let (profile, target) = openshell_provider::web_search_rows(search).unwrap();
    let profile = &profile;
    fixture.state.lock().unwrap().lose_create = true;
    assert!(
        client
            .ensure("provider_profile", profile)
            .await
            .error()
            .is_some()
    );
    let recovered = client.ensure("provider_profile", profile).await;
    assert!(recovered.error().is_none(), "{:?}", recovered.error());
    let profile = recovered.into_parts().0.unwrap();
    let target = &target;
    let result = client.ensure("provider", target).await;
    assert!(result.error().is_none(), "{:?}", result.error());
    let provider = result.into_parts().0.unwrap();
    assert!(
        !serde_json::to_string(&provider)
            .unwrap()
            .contains("owned-search-key")
    );
    let key = format!("{}/{}", doc.workspace(), provider["name"]);
    {
        let state = fixture.state.lock().unwrap();
        let stored = &state.providers[&key];
        assert_eq!(stored.credentials[credential_env], "owned-search-key");
        assert!(stored.config.is_empty());
        assert_eq!(stored.profile_workspace, doc.workspace());
    }
    let effects = fixture.state.lock().unwrap().effects;
    let changed_key_client = OpenShell::connect(
        &doc.spec.gateway.connection(),
        Arc::new(Key("changed-search-key")),
    )
    .unwrap();
    let unchanged = changed_key_client.ensure("provider", target).await;
    assert!(unchanged.error().is_none(), "{:?}", unchanged.error());
    assert_eq!(unchanged.into_parts().0.unwrap()["id"], provider["id"]);
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.effects, effects);
        assert_eq!(
            state.providers[&key].credentials[credential_env],
            "owned-search-key"
        );
    }
    let key = format!("{}/{}", doc.workspace(), profile["name"]);
    let original = fixture.state.lock().unwrap().profiles[&key].clone();
    fixture
        .state
        .lock()
        .unwrap()
        .profiles
        .get_mut(&key)
        .unwrap()
        .credentials[0]
        .header_name = "X-Unexpected-Token".into();
    assert!(
        client
            .read("provider_profile", &profile, false)
            .await
            .is_err()
    );
    assert!(
        client
            .remove("provider_profile", &profile, true)
            .await
            .is_err()
    );
    fixture.state.lock().unwrap().profiles.insert(key, original);
    client.remove("provider", &provider, true).await.unwrap();
    fixture.state.lock().unwrap().lose_delete = true;
    assert!(
        client
            .remove("provider_profile", &profile, true)
            .await
            .is_err()
    );
    client
        .remove("provider_profile", &profile, true)
        .await
        .unwrap();
    assert!(fixture.state.lock().unwrap().profiles.is_empty());
    assert!(fixture.state.lock().unwrap().providers.is_empty());
}

#[tokio::test]
async fn separate_search_credentials_reach_only_their_selected_sandbox_attachments() {
    struct Keys;
    impl Secrets for Keys {
        fn resolve(&self, reference: &str) -> Result<String, ObservationError> {
            match reference {
                "SEARCH_A" | "SEARCH_B" => Ok(format!("fixture-{reference}")),
                _ => Err(ObservationError::Authentication),
            }
        }
    }
    let fixture = Fixture::start().await;
    let mut doc =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    *doc.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let mut other = doc.spec.sandboxes[0].clone();
    other.name = "other".into();
    doc.spec.sandboxes.push(other);
    for (sandbox, reference) in doc.spec.sandboxes.iter_mut().zip(["SEARCH_A", "SEARCH_B"]) {
        sandbox.integrations = serde_json::from_value(serde_json::json!({"search":{"kind":"webSearch","provider":"brave","credential":{"env":reference}}})).unwrap();
        sandbox.agent.integration_refs = vec!["search".into()];
    }
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let targets = targets(&doc, &generations).unwrap();
    let client = OpenShell::connect(&doc.spec.gateway.connection(), Arc::new(Keys)).unwrap();
    // Web search targets expand to the profile and registration they own.
    for kind in [
        "workspace",
        "provider_profile",
        "provider",
        "web_search",
        "sandbox",
    ] {
        for target in targets.iter().filter(|t| t.kind == kind) {
            let rows = if kind == "web_search" {
                let (profile, registration) =
                    openshell_provider::web_search_rows(&target.values).unwrap();
                vec![("provider_profile", profile), ("provider", registration)]
            } else {
                vec![(kind, target.values.clone())]
            };
            for (kind, row) in rows {
                let result = client.ensure(kind, &row).await;
                assert!(result.error().is_none(), "{kind}: {:?}", result.error());
            }
        }
    }
    let state = fixture.state.lock().unwrap();
    for (sandbox, reference) in doc.spec.sandboxes.iter().zip(["SEARCH_A", "SEARCH_B"]) {
        let search = targets
            .iter()
            .find(|t| t.kind == "web_search" && t.values["credential_env"] == reference)
            .unwrap();
        let registration = openshell_provider::web_search_rows(&search.values)
            .unwrap()
            .1["name"]
            .clone();
        let stored = &state.providers[&format!("{}/{}", doc.workspace(), registration)];
        assert_eq!(
            stored.credentials["BRAVE_API_KEY"],
            format!("fixture-{reference}")
        );
        let attached = &state.sandboxes[&format!("{}/{}", doc.workspace(), sandbox.name)]
            .spec
            .as_ref()
            .unwrap()
            .providers;
        assert_eq!(
            attached
                .iter()
                .filter(|name| name.starts_with("brave-search-"))
                .collect::<Vec<_>>(),
            vec![&registration]
        );
    }
}
