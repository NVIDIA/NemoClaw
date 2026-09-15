// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl Deployment {
    pub async fn export(&self, cancel: &CancellationToken) -> Result<Document, Error> {
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
            let observed =
                client
                    .read(&target.kind, &expected, false)
                    .await?
                    .ok_or(Error::Conflict(
                        "resource is confirmed absent; no configuration exported",
                    ))?;
            verify_identity(&expected, &observed)?;
            match target.kind.as_str() {
                "provider" => export_provider(&mut document, &expected, &observed)?,
                "route" => export_route(&mut document, &observed)?,
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
    if observed["provider_type"] != expected["provider_type"] {
        return Err(Error::Conflict("provider type drift requires inspection"));
    }
    if document.spec.inference_providers[0].service.is_some() {
        if observed["endpoint"] != document.inference_endpoint()?
            || !observed["credential_env"].is_empty()
        {
            return Err(Error::Conflict("managed inference registration drifted"));
        }
    } else {
        document.spec.inference_providers[0].endpoint = observed["endpoint"].clone();
    }
    document.spec.inference_providers[0].credential = (!observed["credential_env"].is_empty())
        .then(|| Credential {
            env: observed["credential_env"].clone(),
        });
    Ok(())
}

fn export_route(document: &mut Document, observed: &Row) -> Result<(), Error> {
    if observed["provider_name"] != document.spec.inference_providers[0].name {
        return Err(Error::Conflict(
            "route references a provider outside this deployment",
        ));
    }
    document.spec.sandboxes[0].agents[0].inference.routes[0]
        .overrides
        .model = observed["model"].clone();
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
    if document.spec.sandboxes[0].agents[0].harness == "pi" {
        expected.insert(
            "pi_model_config".into(),
            serde_json::to_string(
                &document.spec.sandboxes[0].agents[0].inference.routes[0].overrides,
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
    fn export_preserves_external_provider_references_and_observed_route_model() {
        let mut document =
            Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes())
                .unwrap();
        let expected = provider_row(&document);
        let mut observed = expected.clone();
        observed.insert("endpoint".into(), "https://changed.example/v1".into());
        observed.insert("credential_env".into(), "NEW_INFERENCE_KEY".into());
        export_provider(&mut document, &expected, &observed).unwrap();
        assert_eq!(
            document.spec.inference_providers[0].endpoint,
            "https://changed.example/v1"
        );
        assert_eq!(
            document.spec.inference_providers[0]
                .credential
                .as_ref()
                .unwrap()
                .env,
            "NEW_INFERENCE_KEY"
        );
        let route = Row::from([
            (
                "provider_name".into(),
                document.spec.inference_providers[0].name.clone(),
            ),
            ("model".into(), "updated-model".into()),
        ]);
        export_route(&mut document, &route).unwrap();
        assert_eq!(
            document.spec.sandboxes[0].agents[0].inference.routes[0]
                .overrides
                .model,
            "updated-model"
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
    fn export_rejects_a_route_outside_the_deployment_without_rewriting_intent() {
        let document =
            Document::parse(include_str!("../../tests/fixtures/config/local.yaml").as_bytes())
                .unwrap();
        let mut exported = document.clone();
        let observed = Row::from([
            ("provider_name".into(), "foreign".into()),
            ("model".into(), "foreign-model".into()),
        ]);
        assert!(export_route(&mut exported, &observed).is_err());
        assert_eq!(exported, document);
    }
}
