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
            "no saved deployment configuration; apply a configuration before exporting",
        ))?;
        if record.pending {
            return Err(Error::Conflict(
                "cannot export while apply is unfinished; run apply again with the same configuration and state directory",
            ));
        }
        if record.destroying {
            return Err(Error::Conflict(
                "cannot export while destroy is unfinished; run destroy again with the same state directory",
            ));
        }
        if record.destroyed {
            return Err(Error::Conflict(
                "cannot export a destroyed deployment; apply its configuration again using the same state directory before exporting",
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
                    .ok_or(Error::Conflict("resource has no saved ID"))?
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
                "provider"
                    if expected
                        .get("provider_type")
                        .is_some_and(|kind| kind == "brave") =>
                {
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
        .find(|provider| document.provider_key(provider) == expected["name"])
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
    let definition = document.sandbox(&expected["name"])?;
    if document.sandbox_harness(definition)?.kind == "pi" {
        expected.insert(
            "pi_model_config".into(),
            serde_json::to_string(
                &document
                    .agent_inference(&definition.agent)?
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

    #[tokio::test]
    async fn export_reports_recovery_for_each_saved_operation_state_without_changing_files() {
        let bundle = tempfile::tempdir().unwrap();
        let mut manifest = crate::bundle::Manifest {
            version: "0.1.0".into(),
            rust: "fixture".into(),
            opentofu: compile::OPENTOFU_VERSION.into(),
            files: BTreeMap::new(),
        };
        for name in crate::bundle::required_files(&manifest.version).unwrap() {
            let path = bundle.path().join(&name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"not an executable").unwrap();
            manifest
                .files
                .insert(name, crate::bundle::hash_file(&path).unwrap());
        }
        save_json(&bundle.path().join("manifest.json"), &manifest).unwrap();
        let document =
            Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
                .unwrap();
        for (flags, expected) in [
            (
                None,
                "no saved deployment configuration; apply a configuration before exporting",
            ),
            (
                Some((true, false, false)),
                "cannot export while apply is unfinished; run apply again with the same configuration and state directory",
            ),
            (
                Some((false, true, false)),
                "cannot export while destroy is unfinished; run destroy again with the same state directory",
            ),
            (
                Some((false, false, true)),
                "cannot export a destroyed deployment; apply its configuration again using the same state directory before exporting",
            ),
        ] {
            let state = tempfile::tempdir().unwrap();
            let intent = state.path().join("intent.json");
            if let Some((pending, destroying, destroyed)) = flags {
                let mut record = Record::new(document.clone()).unwrap();
                record.pending = pending;
                record.destroying = destroying;
                record.destroyed = destroyed;
                Store::open(state.path()).unwrap().save(&record).unwrap();
            }
            let before = fs::read(&intent).ok();
            let resource_state = state.path().join("terraform.tfstate");
            fs::write(&resource_state, br#"{"version":4,"resources":[]}"#).unwrap();
            let before_resources = fs::read(&resource_state).unwrap();
            let deployment = Deployment::new(state.path(), bundle.path());
            let error = deployment
                .export(&CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(error.to_string(), expected, "{flags:?}");
            assert_eq!(fs::read(&intent).ok(), before);
            assert_eq!(fs::read(&resource_state).unwrap(), before_resources);
        }
    }

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
        value["spec"]["inferenceProviders"].as_array_mut().unwrap().push(serde_json::json!({"name":"hosted","provider":"openai","endpoint":"https://hosted.example/v1","credential":{"env":"OLD_KEY"}}));
        let inference = &mut value["spec"]["sandboxes"][0]["agent"]["inference"];
        inference["default"] = serde_json::json!("primary");
        inference["routes"].as_array_mut().unwrap().push(serde_json::json!({"name":"smart","providerRef":"hosted","overrides":{"model":"smart"}}));
        let mut document = Document::parse(value.to_string().as_bytes()).unwrap();
        let original = document.spec.inference_providers[0].clone();
        let record = Record::new(document.clone()).unwrap();
        let expected = compile::targets(&document, &record.generations)
            .unwrap()
            .into_iter()
            .find(|target| target.kind == "provider" && target.values["name"] == "hosted")
            .unwrap()
            .values;
        let mut observed = expected.clone();
        observed.insert("credential_env".into(), "NEW_KEY".into());
        export_provider(&mut document, &expected, &observed).unwrap();
        assert_eq!(&document.spec.inference_providers[0], &original);
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
