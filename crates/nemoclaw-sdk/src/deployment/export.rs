// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;

pub(super) fn settled(bindings: &BTreeMap<String, StateBinding>) -> Result<(), Error> {
    if bindings.values().any(|binding| !binding.deposed.is_empty()) {
        return Err(Error::Conflict(
            "replacement cleanup is unfinished; apply again before exporting",
        ));
    }
    Ok(())
}

impl Deployment {
    pub async fn export(&self, cancel: &CancellationToken) -> Result<Document, Error> {
        Box::pin(self.export_inner(cancel)).await
    }

    // Refresh an opaque state copy with provider configuration only. OpenTofu's
    // refresh-only mode reads the existing resources without planning mutations;
    // omitting data sources avoids running deployment readiness during export.
    pub(super) async fn export_observations(
        &self,
        bundle: &Bundle,
        store: &Store,
        record: &Record,
        runtime: bool,
        cancel: &CancellationToken,
    ) -> Result<BTreeMap<String, Value>, Error> {
        let graph = if runtime {
            compile::compile_runtime(
                &record.document,
                &record.generations,
                &bundle.manifest.version,
            )?
        } else {
            compile::compile(
                &record.document,
                &record.generations,
                &bundle.manifest.version,
            )?
        };
        let temporary = tempfile::Builder::new()
            .prefix(".export-")
            .tempdir_in(&store.directory)
            .map_err(|_| Error::State("cannot create export observation directory"))?;
        let stage = Store::open(temporary.path())?;
        fs::copy(
            store.directory.join("terraform.tfstate"),
            stage.directory.join("terraform.tfstate"),
        )
        .map_err(|_| Error::State("export requires readable deployment state"))?;
        self.prepare(
            bundle,
            &stage,
            &json!({"terraform":graph["terraform"], "provider":graph["provider"]}),
        )?;
        let schema_environment = crate::state::schema_environment(&stage.directory);
        crate::process::run(
            &stage.directory,
            &bundle.tofu(),
            &["init", "-upgrade", "-input=false", "-no-color"],
            &schema_environment,
            cancel,
        )
        .await?;
        let bindings = stage.bindings(&bundle.tofu(), cancel).await?;
        settled(&bindings)?;
        let targets = if runtime {
            compile::runtime_targets(&record.document, &record.generations)?
        } else {
            compile::targets(&record.document, &record.generations)?
        };
        let targets: Vec<_> = targets
            .iter()
            .filter(|target| !target.address.starts_with("data."))
            .collect();
        if bindings.len() != targets.len() {
            return Err(Error::Conflict(
                "export requires all declared resource bindings",
            ));
        }
        for target in &targets {
            let binding = bindings.get(&target.address).ok_or(Error::Conflict(
                "export requires established resource identity",
            ))?;
            if !plan::disposable(&target.address)
                && target
                    .values
                    .get("spec")
                    .is_some_and(|spec| *spec != binding.spec)
            {
                return Err(Error::Conflict(
                    "resource state differs from intent; no YAML exported",
                ));
            }
        }
        let environment =
            gateway_environment(&record.document, self.secrets.as_ref(), &stage.directory)?;
        crate::process::run(
            &stage.directory,
            &bundle.tofu(),
            &[
                "plan",
                "-refresh-only",
                "-input=false",
                "-no-color",
                "-out=export.plan",
            ],
            &environment,
            cancel,
        )
        .await?;
        let bytes = crate::process::run(
            &stage.directory,
            &bundle.tofu(),
            &["show", "-json", "export.plan"],
            &schema_environment,
            cancel,
        )
        .await?;
        let plan: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Error::State("invalid OpenTofu export observation"))?;
        if plan["format_version"]
            .as_str()
            .and_then(|version| version.split('.').next())
            != Some("1")
        {
            return Err(Error::State(
                "unsupported OpenTofu export observation version",
            ));
        }
        // The public plan's prior_state is the state after provider refresh,
        // before configuration planning. With a provider-only configuration,
        // planned_values excludes orphan resources even in refresh-only mode.
        let mut observations = crate::state::parse_resources(&plan["prior_state"]["values"])?;
        observations.retain(|address, _| !address.starts_with("data."));
        if observations.len() != bindings.len() {
            return Err(Error::Conflict(
                "resource is confirmed absent; no configuration exported",
            ));
        }
        for (address, binding) in bindings {
            if observations
                .get(&address)
                .and_then(|row| row.get("id"))
                .and_then(Value::as_str)
                != Some(binding.id.as_str())
            {
                return Err(crate::ObservationError::BindingMismatch.into());
            }
        }
        for target in targets {
            validate_projection(target, &observations[&target.address])?;
        }
        Ok(observations)
    }

    async fn export_inner(&self, cancel: &CancellationToken) -> Result<Document, Error> {
        let (bundle, store) = self.open()?;
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

        self.export_runtime(&bundle, &store, &record, cancel)
            .await?;
        (self.progress)(Progress::Exporting);
        let observations = self
            .export_observations(&bundle, &store, &record, false, cancel)
            .await?;
        let mut document = record.document;
        for target in compile::targets(&document, &record.generations)? {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if target.address.starts_with("data.") || plan::disposable(&target.address) {
                continue;
            }
            let observed: Row = serde_json::from_value(observations[&target.address].clone())
                .map_err(|_| Error::State("invalid provider export observation"))?;
            let mut expected = target.values;
            expected.insert("id".into(), observed["id"].clone());
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
                "sandbox" => export_sandbox(&expected, &observed)?,
                _ => {}
            }
        }
        document.validate()?;
        Ok(document)
    }
}

fn validate_projection(target: &Target, observed: &Value) -> Result<(), Error> {
    if target.address.starts_with("docker_container.") {
        let name = match target.values.get("name") {
            Some(name) => name.clone(),
            None => {
                serde_json::from_str::<crate::managed::Spec>(&target.values["spec"])
                    .map_err(|_| Error::State("invalid runtime intent"))?
                    .name
            }
        };
        if observed["name"]
            .as_str()
            .map(|name| name.trim_start_matches('/'))
            != Some(name.as_str())
        {
            return Err(crate::ObservationError::BindingMismatch.into());
        }
    }
    if plan::disposable(&target.address) {
        return Ok(());
    }
    // Providers validate observations against their prior bindings. Export also
    // requires that the observed identity still belongs to this document.
    for field in ["name", "workspace", "owner", "generation"] {
        if let Some(expected) = target.values.get(field)
            && observed[field].as_str() != Some(expected)
        {
            return Err(crate::ObservationError::BindingMismatch.into());
        }
    }
    // Authored configuration cannot be exported as unchanged intent when the
    // provider reports drift. Compare JSON semantically, without harness dispatch.
    for (field, expected) in &target.values {
        if field.ends_with("_json") {
            let expected: Value = serde_json::from_str(expected)
                .map_err(|_| Error::State("invalid authored export configuration"))?;
            let actual: Value = serde_json::from_str(observed[field].as_str().unwrap_or(""))
                .map_err(|_| Error::State("invalid observed export configuration"))?;
            if actual != expected {
                return Err(Error::Conflict(
                    "resource configuration drift requires inspection",
                ));
            }
        }
    }
    Ok(())
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
        .selected_providers()?
        .into_iter()
        .find(|provider| provider.key == expected["name"])
        .ok_or(Error::Conflict("observed provider is not selected"))?;
    let provider = provider.definition;
    let managed = provider.service_ref.is_some();
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

fn export_sandbox(expected: &Row, observed: &Row) -> Result<(), Error> {
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_rejects_configuration_and_intent_identity_drift_from_provider_observations() {
        let target = Target {
            address: "nemoclaw_pi_configuration.agent".into(),
            kind: "pi_configuration".into(),
            values: Row::from([
                ("owner".into(), "deployment".into()),
                ("generation".into(), "generation".into()),
                ("name".into(), "agent".into()),
                ("model_json".into(), r#"{"model":"wanted"}"#.into()),
            ]),
        };
        let observed = serde_json::to_value(&target.values).unwrap();
        validate_projection(&target, &observed).unwrap();
        for (key, value) in [
            ("owner", "foreign"),
            ("generation", "foreign"),
            ("model_json", r#"{"model":"changed"}"#),
        ] {
            let mut changed = observed.clone();
            changed[key] = json!(value);
            assert!(validate_projection(&target, &changed).is_err(), "{key}");
        }
        let mut reformatted = observed;
        reformatted["model_json"] = json!(r#"{ "model": "wanted" }"#);
        validate_projection(&target, &reformatted).unwrap();
    }

    #[test]
    fn export_rejects_container_namespace_drift_from_provider_observations() {
        let target = Target {
            address: "docker_container.ollama_proxy_model".into(),
            kind: "ollama_proxy".into(),
            values: Row::from([("name".into(), "expected-proxy".into())]),
        };
        validate_projection(&target, &json!({"name":"expected-proxy"})).unwrap();
        assert!(validate_projection(&target, &json!({"name":"renamed-proxy"})).is_err());
    }

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
