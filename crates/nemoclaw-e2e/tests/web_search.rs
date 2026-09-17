// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{
    ObservationError,
    backend::Backend,
    compile::{Generations, targets},
    config::Document,
    openshell::{OpenShell, Secrets},
};
use std::sync::Arc;
struct Key;
impl Secrets for Key {
    fn resolve(&self, name: &str) -> Result<String, ObservationError> {
        assert_eq!(name, "SEARCH_KEY");
        Ok("owned-search-key".into())
    }
}
#[tokio::test]
async fn search_owns_profile_and_provider_preserves_secret_custody_and_rejects_profile_drift() {
    let fixture = Fixture::start().await;
    let mut doc =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    doc.spec.gateway.endpoint = fixture.endpoint.clone();
    doc.spec.integrations = serde_json::from_value(serde_json::json!({
        "search":{"kind":"webSearch","provider":"brave","credential":{"env":"SEARCH_KEY"}}
    }))
    .unwrap();
    doc.spec.sandboxes[0].agents[0].integration_refs = vec!["search".into()];
    let client = OpenShell::connect(&doc.spec.gateway, Arc::new(Key)).unwrap();
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
    let profile = &targets
        .iter()
        .find(|t| t.address == "nemoclaw_provider_profile.web_search")
        .unwrap()
        .values;
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
    let target = &targets
        .iter()
        .find(|t| {
            t.kind == "provider" && t.values.get("provider_type").is_some_and(|v| v == "brave")
        })
        .unwrap()
        .values;
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
        assert_eq!(stored.credentials["BRAVE_API_KEY"], "owned-search-key");
        assert!(stored.config.is_empty());
        assert_eq!(stored.profile_workspace, doc.workspace());
    }
    let key = format!("{}/nemoclaw-brave", doc.workspace());
    let original = fixture.state.lock().unwrap().profiles[&key].clone();
    fixture
        .state
        .lock()
        .unwrap()
        .profiles
        .get_mut(&key)
        .unwrap()
        .credentials[0]
        .header_name = "Authorization".into();
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
    doc.spec.gateway.endpoint = fixture.endpoint.clone();
    let mut other = doc.spec.sandboxes[0].clone();
    other.name = "other".into();
    doc.spec.sandboxes.push(other);
    for (sandbox, reference) in doc.spec.sandboxes.iter_mut().zip(["SEARCH_A", "SEARCH_B"]) {
        sandbox.integrations = serde_json::from_value(serde_json::json!({"search":{"kind":"webSearch","provider":"brave","credential":{"env":reference}}})).unwrap();
        sandbox.agents[0].integration_refs = vec!["search".into()];
    }
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let targets = targets(&doc, &generations).unwrap();
    let client = OpenShell::connect(&doc.spec.gateway, Arc::new(Keys)).unwrap();
    for kind in ["workspace", "provider_profile", "provider", "sandbox"] {
        for target in targets.iter().filter(|t| t.kind == kind) {
            let result = client.ensure(kind, &target.values).await;
            assert!(result.error().is_none(), "{kind}: {:?}", result.error());
        }
    }
    let state = fixture.state.lock().unwrap();
    for (sandbox, reference) in doc.spec.sandboxes.iter().zip(["SEARCH_A", "SEARCH_B"]) {
        let provider = targets
            .iter()
            .find(|t| {
                t.kind == "provider"
                    && t.values
                        .get("credential_env")
                        .is_some_and(|v| v == reference)
            })
            .unwrap();
        let stored = &state.providers[&format!("{}/{}", doc.workspace(), provider.values["name"])];
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
            vec![&provider.values["name"]]
        );
    }
}
