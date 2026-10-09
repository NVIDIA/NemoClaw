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
        let (graph, targets) = if runtime {
            compile::compiled_runtime(
                &record.document,
                &record.generations,
                &bundle.manifest.version,
            )?
        } else {
            compile::deployment_graph(
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
        let mut configuration =
            json!({"terraform":graph["terraform"], "provider":graph["provider"]});
        if let Some(variables) = graph.get("variable") {
            configuration["variable"] = variables.clone();
        }
        self.initialize(bundle, &stage, &configuration, cancel)
            .await?;
        let schema_environment = crate::state::schema_environment(&stage.directory);
        let bindings = stage.bindings(&bundle.tofu(), cancel).await?;
        settled(&bindings)?;
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
                && (target.values.contains_key("spec")
                    // Gateways, their storage, and Kubernetes resources are typed.
                    || target.values.contains_key("compute_driver")
                    || crate::services::resource_behavior(&target.kind).retained_storage)
                && binding.differs(&target.values)
            {
                return Err(Error::Conflict(
                    "resource state differs from intent; no YAML exported",
                ));
            }
        }
        let environment = self.provider_environment(&record.document, &stage.directory, true)?;
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
        if record.pending() {
            return Err(Error::Conflict(
                "cannot export while apply is unfinished; run apply again with the same configuration and state directory",
            ));
        }
        if record.destroying() {
            return Err(Error::Conflict(
                "cannot export while destroy is unfinished; run destroy again with the same state directory",
            ));
        }
        if record.destroyed() {
            return Err(Error::Conflict(
                "cannot export a destroyed deployment; apply its configuration again using the same state directory before exporting",
            ));
        }

        let (operation, _connection) = self
            .connected(&record.document, &record.generations, cancel)
            .await?;
        operation
            .export_runtime(&bundle, &store, &record, cancel)
            .await?;
        (self.progress)(Progress::Exporting);
        let observations = operation
            .export_observations(&bundle, &store, &record, false, cancel)
            .await?;
        let mut document = record.document;
        consistent_provider_credentials(&document, &record.generations, &observations)?;
        for target in compile::targets(&document, &record.generations)? {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if target.address.starts_with("data.") || plan::disposable(&target.address) {
                continue;
            }
            let mut observation = observations[&target.address].clone();
            // Typed OpenShell inputs return to the JSON their rows carry.
            for input in nemoclaw_openshell::structured_inputs(&target.kind) {
                if let Some(object) = observation.as_object_mut()
                    && let Some(value) = object.remove(input.attribute)
                {
                    let encoded = input
                        .row_value(value)
                        .map_err(|_| Error::State("invalid provider export observation"))?;
                    object.insert(input.field.into(), json!(encoded.unwrap_or_default()));
                }
            }
            let observed: Row = serde_json::from_value(observation)
                .map_err(|_| Error::State("invalid provider export observation"))?;
            let mut expected = target.values;
            expected.insert("id".into(), observed["id"].clone());
            match target.kind.as_str() {
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
    let inputs = nemoclaw_openshell::structured_inputs(&target.kind);
    for (field, expected) in &target.values {
        if field.ends_with("_json") {
            // Typed OpenShell inputs return to the JSON their rows carry; the
            // authored JSON takes the same path, which omits absent values.
            let (expected, observed) = match inputs.iter().find(|input| input.field == field) {
                Some(input) => {
                    let invalid = |_| Error::State("invalid authored export configuration");
                    let expected = input
                        .row_value(input.configuration(expected).map_err(invalid)?)
                        .map_err(invalid)?
                        .unwrap_or_default();
                    let observed = input
                        .row_value(observed[input.attribute].clone())
                        .map_err(|_| Error::State("invalid observed export configuration"))?
                        .unwrap_or_default();
                    (expected, observed)
                }
                None => (
                    expected.clone(),
                    observed[field].as_str().unwrap_or("").to_owned(),
                ),
            };
            let expected: Value = serde_json::from_str(&expected)
                .map_err(|_| Error::State("invalid authored export configuration"))?;
            let actual: Value = serde_json::from_str(&observed)
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

fn consistent_provider_credentials(
    document: &Document,
    generations: &compile::Generations,
    observations: &BTreeMap<String, Value>,
) -> Result<(), Error> {
    let selected = document.selected_providers()?;
    let mut credentials = BTreeMap::new();
    for target in compile::targets(document, generations)?
        .into_iter()
        .filter(|target| target.kind == "provider")
    {
        let Some(provider) = selected
            .iter()
            .find(|provider| provider.key == target.values["name"])
        else {
            continue;
        };
        let reference = observations
            .get(&target.address)
            .and_then(|row| row["credential_env"].as_str())
            .ok_or(Error::State("incomplete provider credential observation"))?;
        if credentials
            .insert(provider.path.clone(), reference)
            .is_some_and(|previous| previous != reference)
        {
            return Err(Error::Conflict(
                "registrations for one inference definition disagree on the credential reference; no YAML exported",
            ));
        }
    }
    Ok(())
}

fn export_provider(document: &mut Document, expected: &Row, observed: &Row) -> Result<(), Error> {
    // Search targets come from selected integrations, not inference definitions.
    // Keep their authored scopes and credential references unchanged on export.
    if expected
        .get("provider_type")
        .and_then(|kind| crate::config::SearchProvider::from_name(kind))
        .is_some()
    {
        if expected
            .iter()
            .any(|(key, value)| observed.get(key) != Some(value))
        {
            return Err(Error::Conflict(
                "web search provider drift requires inspection",
            ));
        }
        return Ok(());
    }
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
    let managed = matches!(
        provider.target()?,
        crate::config::InferenceTarget::Service { .. }
    );
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

/// A JSON input as its provider records it: typed OpenShell inputs omit
/// absent values. `None` for an empty or invalid input.
fn recorded(kind: &str, field: &str, encoded: &str) -> Option<Value> {
    if encoded.is_empty() {
        return None;
    }
    let encoded = match nemoclaw_openshell::structured_inputs(kind)
        .into_iter()
        .find(|input| input.field == field)
    {
        Some(input) => input.row_value(input.configuration(encoded).ok()?).ok()??,
        None => encoded.to_owned(),
    };
    serde_json::from_str(&encoded).ok()
}

fn export_sandbox(expected: &Row, observed: &Row) -> Result<(), Error> {
    let value = |row: &Row, key: &str| row.get(key).map(String::as_str).unwrap_or("").to_owned();
    // JSON inputs compare as the provider records them.
    let json = |row: &Row, key: &str| recorded("sandbox", key, &value(row, key));
    if ["image", "agent_name", "agent_runtime"]
        .iter()
        .any(|key| value(observed, key) != value(expected, key))
        || ["policy_json", "provider_names_json"]
            .iter()
            .any(|key| json(observed, key) != json(expected, key))
    {
        return Err(Error::Conflict(
            "sandbox configuration drift requires inspection",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "uses the verified bundle named by NEMOCLAW_TEST_BUNDLE"]
    async fn runtime_export_declares_the_native_helm_provider_inputs() {
        struct Kubeconfig(String);
        impl Secrets for Kubeconfig {
            fn resolve(&self, name: &str) -> Result<String, crate::ObservationError> {
                assert_eq!(name, "TEST_KUBECONFIG");
                Ok(self.0.clone())
            }
        }
        let bundle = Bundle::open(Path::new(
            &std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit verified bundle"),
        ))
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let kubeconfig = directory.path().join("synthetic.kubeconfig");
        save_json(&kubeconfig, &json!({
            "apiVersion": "v1", "kind": "Config", "current-context": "test-cluster",
            "clusters": [{"name": "fixture", "cluster": {"server": "https://127.0.0.1:9"}}],
            "contexts": [{"name": "test-cluster", "context": {"cluster": "fixture", "user": "fixture"}}],
            "users": [{"name": "fixture", "user": {}}],
        })).unwrap();
        let deployment = Deployment::new(directory.path(), &bundle.directory).with_secrets(
            Arc::new(Kubeconfig(kubeconfig.to_string_lossy().into_owned())),
        );
        let (document, _) = crate::deployment::tests::kubernetes_context();
        let record = Record::new(document).unwrap();
        let (graph, targets) = compile::compiled_runtime(
            &record.document,
            &record.generations,
            &bundle.manifest.version,
        )
        .unwrap();
        let stage = Store::open(&directory.path().join("runtime")).unwrap();
        let cancel = CancellationToken::new();
        deployment
            .initialize(&bundle, &stage, &graph, &cancel)
            .await
            .unwrap();
        let schema: Value = serde_json::from_slice(
            &crate::process::run(
                &stage.directory,
                &bundle.tofu(),
                &["providers", "schema", "-json"],
                &crate::state::schema_environment(&stage.directory),
                &cancel,
            )
            .await
            .unwrap(),
        )
        .unwrap();
        let resources: Vec<Value> = targets.iter().map(|target| {
            let (kind, name) = target.address.split_once('.').unwrap();
            let provider = if kind == "helm_release" {
                crate::kubernetes::gateway::PROVIDER_ADDRESS
            } else {
                compile::PROVIDER_ADDRESS
            };
            let resource_schema = &schema["provider_schemas"][provider]["resource_schemas"][kind];
            let mut attributes: serde_json::Map<String, Value> = resource_schema["block"]["attributes"]
                .as_object().unwrap().keys().map(|name| (name.clone(), Value::Null)).collect();
            for (name, value) in &target.values {
                attributes.insert(name.clone(), json!(value));
            }
            attributes.insert("id".into(), json!(if kind == "helm_release" { target.values["name"].as_str() } else { kind }));
            if kind != "helm_release" {
                attributes.insert("running".into(), json!("true"));
            }
            if target.kind == crate::kubernetes::AUTH_KIND {
                attributes.insert("release_present".into(), json!("true"));
                attributes.insert("gateway_values".into(), json!("{}"));
            }
            json!({
                "mode": "managed", "type": kind, "name": name,
                "provider": format!("provider[\"{provider}\"]"),
                "instances": [{"schema_version": resource_schema["version"], "attributes": attributes, "sensitive_attributes": []}],
            })
        }).collect();
        let state_path = stage.directory.join("terraform.tfstate");
        save_json(&state_path, &json!({
            "version": 4, "terraform_version": compile::OPENTOFU_VERSION, "serial": 1,
            "lineage": "11111111-1111-4111-8111-111111111111", "outputs": {}, "resources": resources,
        })).unwrap();
        assert_eq!(
            stage.bindings(&bundle.tofu(), &cancel).await.unwrap().len(),
            4
        );
        let before = fs::read(&state_path).unwrap();
        let error = deployment
            .export_observations(&bundle, &stage, &record, true, &cancel)
            .await
            .expect_err("the fixture has no reachable Kubernetes API");
        assert_eq!(
            fs::read(&state_path).unwrap(),
            before,
            "export preserves source state"
        );
        assert!(
            !error.to_string().contains("undeclared input variable"),
            "native export must declare its provider inputs before refreshing: {error}"
        );
        assert!(
            error.to_string().contains("Resource observation"),
            "native export must reach provider observation: {error}"
        );
    }

    #[test]
    fn export_requires_shared_definition_registrations_to_agree_on_credentials() {
        let mut document =
            Document::parse(include_bytes!("../../tests/fixtures/config/local.yaml").as_slice())
                .unwrap();
        let mut second = document.spec.sandboxes[0].clone();
        second.name = "second".into();
        second.image.ref_ = format!("fixture/second@sha256:{}", "b".repeat(64));
        document.spec.sandboxes.push(second);
        let generations = ["workspace", "provider", "sandbox"]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
        let mut observations: BTreeMap<String, Value> = compile::targets(&document, &generations)
            .unwrap()
            .into_iter()
            .filter(|target| target.kind == "provider")
            .map(|target| (target.address, json!({"credential_env":"SAME_KEY"})))
            .collect();
        assert_eq!(observations.len(), 2);
        consistent_provider_credentials(&document, &generations, &observations).unwrap();
        observations.values_mut().next().unwrap()["credential_env"] = json!("OTHER_KEY");
        assert!(consistent_provider_credentials(&document, &generations, &observations).is_err());
    }

    #[test]
    fn export_rejects_configuration_and_intent_identity_drift_from_provider_observations() {
        let target = Target {
            address: "fabric_agent_configuration.agent".into(),
            kind: "agent_configuration".into(),
            values: Row::from([
                ("owner".into(), "deployment".into()),
                ("generation".into(), "generation".into()),
                ("name".into(), "agent".into()),
                ("config_json".into(), r#"{"model":"wanted"}"#.into()),
            ]),
        };
        let observed = serde_json::to_value(&target.values).unwrap();
        validate_projection(&target, &observed).unwrap();
        for (key, value) in [
            ("owner", "foreign"),
            ("generation", "foreign"),
            ("config_json", r#"{"model":"changed"}"#),
        ] {
            let mut changed = observed.clone();
            changed[key] = json!(value);
            assert!(validate_projection(&target, &changed).is_err(), "{key}");
        }
        let mut reformatted = observed;
        reformatted["config_json"] = json!(r#"{ "model": "wanted" }"#);
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
                if pending {
                    let target = compile::targets(&document, &record.generations)
                        .unwrap()
                        .remove(0);
                    record.begin_apply(&document, [(target.address, target.values)].into());
                }
                if destroying {
                    record.begin_destroy();
                }
                if destroyed {
                    record.finish_destroy();
                }
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
    fn export_preserves_search_definitions_and_rejects_registration_drift() {
        for provider in ["tavily", "brave"] {
            for scope in ["deployment", "sandbox", "agent"] {
                let mut document = Document::parse(
                    include_str!("../../tests/fixtures/config/local.yaml").as_bytes(),
                )
                .unwrap();
                let definitions = serde_json::from_value(json!({
                    "search":{"kind":"webSearch", "provider":provider,
                        "credential":{"env":"SEARCH_KEY"}}
                }))
                .unwrap();
                let sandbox = &mut document.spec.sandboxes[0];
                sandbox.agent.integration_refs = vec!["search".into()];
                match scope {
                    "deployment" => document.spec.integrations = definitions,
                    "sandbox" => sandbox.integrations = definitions,
                    _ => {
                        sandbox.agent.integration_refs.clear();
                        sandbox.agent.integrations = definitions;
                    }
                }
                let record = Record::new(document.clone()).unwrap();
                let expected = compile::targets(&document, &record.generations)
                    .unwrap()
                    .into_iter()
                    .find(|target| {
                        target.kind == "provider" && target.values["provider_type"] == provider
                    })
                    .unwrap()
                    .values;
                let mut exported = document.clone();
                export_provider(&mut exported, &expected, &expected).unwrap();
                assert_eq!(exported, document, "{provider}/{scope}");
                for field in [
                    "provider_type",
                    "endpoint",
                    "credential_env",
                    "name",
                    "workspace",
                    "owner",
                    "generation",
                ] {
                    for replacement in [Some("foreign"), None] {
                        let mut observed = expected.clone();
                        if let Some(value) = replacement {
                            observed.insert(field.into(), value.into());
                        } else {
                            observed.remove(field);
                        }
                        assert!(
                            export_provider(&mut exported, &expected, &observed).is_err(),
                            "{provider}/{scope}/{field}/{replacement:?}"
                        );
                        assert_eq!(exported, document);
                    }
                }
            }
        }
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
            .find(|target| {
                target.kind == "provider"
                    && target.values["endpoint"] == "https://hosted.example/v1"
            })
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
