// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl Deployment {
    pub async fn export(&self, cancel: &CancellationToken) -> Result<Document, Error> {
        Box::pin(self.export_inner(cancel)).await
    }

    async fn export_inner(&self, cancel: &CancellationToken) -> Result<Document, Error> {
        let (_, store) = self.open()?;
        let record = store.load()?.ok_or(Error::Conflict(
            "export requires established resource bindings",
        ))?;
        if record.pending || record.destroying || record.destroyed {
            return Err(Error::Conflict(
                "export requires established bindings; reconcile unfinished operations first",
            ));
        }

        self.export_runtime(&store, &record, cancel).await?;
        (self.progress)(Progress::Exporting);
        let client = OpenShell::connect(&record.document.spec.gateway, self.secrets.clone())?;
        let bindings = store.bindings()?;
        let mut document = record.document;
        for target in compile::targets(&document, &record.generations)? {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let mut expected = target.values;
            expected.insert(
                "id".into(),
                bindings
                    .get(&target.address)
                    .ok_or(Error::Conflict("resource has no durable state identity"))?
                    .id
                    .clone(),
            );
            let observed = if crate::ollama::proxy::supports(&target.kind) {
                let proxy = document
                    .lifecycle_provider()?
                    .ollama_proxy
                    .as_ref()
                    .ok_or(Error::State("missing proxy settings"))?;
                crate::ollama::OllamaBackend::new(self.engines.resolve(&proxy.engine)?)
                    .read(&target.kind, &expected, false)
                    .await?
            } else {
                client.read(&target.kind, &expected, false).await?
            }
            .ok_or(Error::Conflict(
                "resource is confirmed absent; no configuration exported",
            ))?;
            verify_identity(&expected, &observed)?;
            match target.kind.as_str() {
                "provider" if target.address == "nemoclaw_provider.web_search" => {
                    if expected
                        .iter()
                        .any(|(key, value)| observed.get(key) != Some(value))
                    {
                        return Err(Error::Conflict(
                            "web search provider drift requires inspection",
                        ));
                    }
                }
                "provider" => export_provider(&mut document, &expected, &observed)?,
                "sandbox" => export_sandbox(&client, &document, &mut expected, &observed).await?,
                _ => {}
            }
        }
        tokio::select! { ()=cancel.cancelled()=>return Err(Error::Cancelled), result=self.export_ollama(&document, &record.generations, &bindings)=>result? }
        document.validate()?;
        Ok(document)
    }
}

fn export_provider(document: &mut Document, expected: &Row, observed: &Row) -> Result<(), Error> {
    if observed["provider_type"] != expected["provider_type"]
        || observed["endpoint"] != expected["endpoint"]
        || observed["credential_env"].is_empty() != expected["credential_env"].is_empty()
    {
        return Err(Error::Conflict(
            "native provider profile binding drift requires inspection",
        ));
    }
    if expected
        .get("credential_source")
        .filter(|s| !s.is_empty())
        .is_some()
    {
        if expected.get("credential_source") != observed.get("credential_source")
            || expected.get("endpoint") != observed.get("endpoint")
        {
            return Err(Error::Conflict(
                "managed inference credential or endpoint drift",
            ));
        }
        return Ok(());
    }
    let provider = document
        .selected_inference_providers()?
        .into_iter()
        .find(|provider| provider.name == expected["name"])
        .ok_or(Error::Conflict("observed provider is not selected"))?;
    let managed = provider.service.is_some();
    if managed
        && (observed["endpoint"] != document.provider_connection(provider)?.endpoint
            || !observed["credential_env"].is_empty())
    {
        return Err(Error::Conflict("managed inference registration drifted"));
    }
    let provider = document.selected_provider_mut(&expected["name"])?;
    provider.credential = (!observed["credential_env"].is_empty()).then(|| Credential {
        env: observed["credential_env"].clone(),
    });
    Ok(())
}

async fn export_sandbox(
    client: &OpenShell,
    document: &Document,
    expected: &mut Row,
    observed: &Row,
) -> Result<(), Error> {
    if [
        "image",
        "agent_name",
        "agent_runtime",
        "policy_json",
        "proxy_host",
        "proxy_port",
        "inference_json",
    ]
    .iter()
    .any(|key| {
        observed.get(*key).map(String::as_str).unwrap_or("")
            != expected.get(*key).map(String::as_str).unwrap_or("")
    }) {
        return Err(Error::Conflict(
            "sandbox configuration drift requires inspection",
        ));
    }
    if document
        .agent_harness(&document.spec.sandboxes[0].agents[0])?
        .kind
        == "pi"
    {
        expected.insert(
            "pi_model_config".into(),
            serde_json::to_string(
                &document
                    .agent_inference(&document.spec.sandboxes[0].agents[0])?
                    .default_route()?
                    .overrides,
            )
            .map_err(|_| Error::State("cannot encode Pi model configuration"))?,
        );
    }
    client.configuration(expected).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_row(document: &Document) -> Row {
        let record = Record::new(document.clone()).unwrap();
        compile::targets(document, &record.generations)
            .unwrap()
            .into_iter()
            .find(|target| target.kind == "provider")
            .unwrap()
            .values
    }

    #[test]
    fn export_preserves_external_provider_references() {
        let mut document =
            Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes())
                .unwrap();
        document.spec.inference_providers[0].endpoint = "https://models.example/v1".into();
        document.spec.inference_providers[0].credential = Some(Credential {
            env: "OLD_KEY".into(),
        });
        let expected = provider_row(&document);
        for (field, value) in [
            ("endpoint", "https://changed.example/v1"),
            ("credential_env", ""),
        ] {
            let mut drift = expected.clone();
            drift.insert(field.into(), value.into());
            let original = document.clone();
            assert!(export_provider(&mut document, &expected, &drift).is_err());
            assert_eq!(document, original);
        }
        let mut observed = expected.clone();
        observed.insert("credential_env".into(), "NEW_INFERENCE_KEY".into());
        export_provider(&mut document, &expected, &observed).unwrap();
        assert_eq!(
            document.spec.inference_providers[0].endpoint,
            "https://models.example/v1"
        );
        assert_eq!(
            document.spec.inference_providers[0]
                .credential
                .as_ref()
                .unwrap()
                .env,
            "NEW_INFERENCE_KEY"
        );
        document.validate().unwrap();
    }

    #[test]
    fn export_rejects_managed_registration_drift_without_rewriting_intent() {
        let document =
            Document::parse(include_str!("../../tests/fixtures/config/spark.yaml").as_bytes())
                .unwrap();
        let expected = provider_row(&document);
        for (field, value) in [
            ("endpoint", "https://foreign.example/v1"),
            ("credential_env", "FOREIGN_KEY"),
            ("provider_type", "anthropic"),
        ] {
            let mut observed = expected.clone();
            observed.insert(field.into(), value.into());
            let mut exported = document.clone();
            assert!(
                export_provider(&mut exported, &expected, &observed).is_err(),
                "{field}"
            );
            assert_eq!(exported, document);
        }
        let mut exported = document.clone();
        export_provider(&mut exported, &expected, &expected).unwrap();
        assert_eq!(exported, document);
    }
    #[test]
    fn export_updates_only_the_observed_provider_definition() {
        let mut value: serde_json::Value = serde_json::to_value(
            Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes())
                .unwrap(),
        )
        .unwrap();
        value["spec"]["inferenceProviders"].as_array_mut().unwrap().push(serde_json::json!({"name":"oracle","provider":"openai","endpoint":"https://oracle.example/v1","credential":{"env":"OLD_KEY"}}));
        let inference = &mut value["spec"]["sandboxes"][0]["agents"][0]["inference"];
        inference["default"] = serde_json::json!("primary");
        inference["routes"].as_array_mut().unwrap().push(serde_json::json!({"name":"smart","providerRef":"oracle","overrides":{"model":"smart"}}));
        let mut document = Document::parse(value.to_string().as_bytes()).unwrap();
        let original = document.inference_provider().unwrap().clone();
        let record = Record::new(document.clone()).unwrap();
        let expected = compile::targets(&document, &record.generations)
            .unwrap()
            .into_iter()
            .find(|target| target.kind == "provider" && target.values["name"] == "oracle")
            .unwrap()
            .values;
        let mut observed = expected.clone();
        observed.insert("credential_env".into(), "NEW_KEY".into());
        export_provider(&mut document, &expected, &observed).unwrap();
        assert_eq!(document.inference_provider().unwrap(), &original);
        assert_eq!(
            document.spec.inference_providers[1]
                .credential
                .as_ref()
                .unwrap()
                .env,
            "NEW_KEY"
        );
    }
}
