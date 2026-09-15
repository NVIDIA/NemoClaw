// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{
    compile::Generations,
    ollama::{OllamaBackend, ServiceSpec},
};
pub(super) const STORAGE: &str = "nemoclaw_ollama_storage.models";
const SERVICE: &str = "nemoclaw_ollama.service";
const MODEL: &str = "nemoclaw_ollama_model.inference";
fn specification(document: &Document, generations: &Generations) -> Result<ServiceSpec, Error> {
    let provider = &document.spec.inference_providers[0];
    let config = provider
        .ollama
        .as_ref()
        .ok_or(Error::Conflict("Ollama is not declared"))?;
    let spec = ServiceSpec {
        name: format!("{}-ollama", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generations
            .get("ollama")
            .filter(|v| !v.is_empty())
            .ok_or(Error::State("missing Ollama generation"))?
            .clone(),
        image: config.image.clone(),
        network: config.network.name().into(),
        bind_address: provider
            .endpoint
            .strip_prefix("http://")
            .and_then(|v| v.strip_suffix("/v1"))
            .ok_or(Error::Conflict("invalid Ollama endpoint"))?
            .into(),
    };
    spec.validate()?;
    Ok(spec)
}
pub(super) fn extend_allowed(
    document: &Document,
    generations: &Generations,
    allowed: &mut BTreeMap<String, Row>,
) -> Result<(), Error> {
    if document.spec.inference_providers[0].ollama.is_none() {
        return Ok(());
    }
    let spec = specification(document, generations)?;
    allowed.insert(
        SERVICE.into(),
        [
            ("name".into(), spec.name),
            ("owner".into(), spec.owner),
            ("generation".into(), spec.generation),
        ]
        .into(),
    );
    allowed.insert(STORAGE.into(), allowed[SERVICE].clone());
    allowed.insert(MODEL.into(), Row::new());
    Ok(())
}
impl Deployment {
    pub(super) async fn preflight_ollama(
        &self,
        document: &Document,
        generations: &Generations,
        bindings: &BTreeMap<String, StateBinding>,
    ) -> Result<(), Error> {
        let Some(config) = &document.spec.inference_providers[0].ollama else {
            return Ok(());
        };
        self.engines
            .resolve(&config.engine)?
            .preflight_ollama(
                &specification(document, generations)?,
                bindings.get(SERVICE).map(|b| b.id.as_str()).unwrap_or(""),
            )
            .await
    }
    /// A stopped parent has no authoritative model API. Plan only its repair,
    /// then refresh the complete graph after explicit apply restores that API.
    pub(super) async fn recover_ollama(
        &self,
        bundle: &Bundle,
        store: &Store,
        document: &Document,
        record: &mut Record,
        apply: bool,
        cancel: &CancellationToken,
    ) -> Result<(Vec<Change>, bool), Error> {
        let Some(config) = &document.spec.inference_providers[0].ollama else {
            return Ok((Vec::new(), false));
        };
        let bindings = store.bindings()?;
        let Some(binding) = bindings.get(SERVICE) else {
            return Ok((Vec::new(), false));
        };
        let observed = self
            .engines
            .resolve(&config.engine)?
            .observe_ollama(&specification(document, &record.generations)?, &binding.id)
            .await?
            .ok_or(Error::Conflict(
                "bound Ollama is absent; recovery requires inspection",
            ))?;
        if observed.running {
            return Ok((Vec::new(), false));
        }
        self.tofu(
            bundle,
            store,
            document,
            &[
                "plan",
                "-input=false",
                "-no-color",
                "-parallelism=1",
                "-target=nemoclaw_ollama.service",
                "-out=ollama-recovery.plan",
            ],
            cancel,
        )
        .await?;
        let bytes = self
            .tofu(
                bundle,
                store,
                document,
                &["show", "-json", "ollama-recovery.plan"],
                cancel,
            )
            .await?;
        let plan: Plan = serde_json::from_slice(&bytes)
            .map_err(|_| Error::State("invalid Ollama recovery plan"))?;
        let mut allowed = BTreeMap::new();
        extend_allowed(document, &record.generations, &mut allowed)?;
        allowed.remove(MODEL);
        let bindings = bindings
            .into_iter()
            .filter(|(key, _)| allowed.contains_key(key))
            .collect();
        let changes = check_plan(&plan, &allowed, &bindings)?;
        if !apply {
            return Ok((changes, true));
        }
        record.document = document.clone();
        record.digest = document.digest();
        record.pending = true;
        record.succeeded = false;
        record.plan_digest =
            crate::bundle::hash_file(&store.directory.join("ollama-recovery.plan"))?;
        store.save(record)?;
        self.tofu(
            bundle,
            store,
            document,
            &[
                "apply",
                "-input=false",
                "-no-color",
                "-parallelism=1",
                "ollama-recovery.plan",
            ],
            cancel,
        )
        .await?;
        let ready = async {
            let service = self
                .engines
                .resolve(&config.engine)?
                .bound_ollama(&observed.id, &document.spec.inference_providers[0].endpoint)
                .await?;
            if !service.running {
                return Err(Error::Conflict(
                    "Ollama stopped during recovery; explicit apply required",
                ));
            }
            crate::ollama::Models::new(&document.spec.inference_providers[0].endpoint)?
                .ready(
                    &document.spec.sandboxes[0].agents[0].inference.routes[0]
                        .overrides
                        .model,
                )
                .await
        };
        tokio::select! { () = cancel.cancelled() => return Err(Error::Cancelled), result = ready => result? }
        Ok((changes, false))
    }
    pub(super) async fn export_ollama(
        &self,
        document: &Document,
        generations: &Generations,
        bindings: &BTreeMap<String, StateBinding>,
    ) -> Result<(), Error> {
        let provider = &document.spec.inference_providers[0];
        let Some(config) = &provider.ollama else {
            return Ok(());
        };
        let id = &bindings
            .get(SERVICE)
            .ok_or(Error::Conflict(
                "managed Ollama has no established bindings",
            ))?
            .id;
        if bindings
            .get(MODEL)
            .is_none_or(|b| b.id != format!("{id}/model"))
        {
            return Err(Error::Conflict(
                "managed Ollama model binding is missing or changed",
            ));
        }
        let spec = specification(document, generations)?;
        let row: Row = [
            ("id".into(), id.clone()),
            ("name".into(), spec.name),
            ("owner".into(), spec.owner),
            ("generation".into(), spec.generation),
            ("image".into(), spec.image),
            ("network".into(), spec.network),
            ("bind_address".into(), spec.bind_address),
        ]
        .into();
        let backend = OllamaBackend::new(self.engines.resolve(&config.engine)?);
        let storage = bindings.get(STORAGE).ok_or(Error::Conflict(
            "Ollama storage binding is missing; apply before export",
        ))?;
        let mut storage_row = row.clone();
        storage_row.insert("id".into(), storage.id.clone());
        backend
            .read("ollama_storage", &storage_row, false)
            .await?
            .ok_or(Error::Conflict("Ollama storage is absent"))?;
        backend
            .read("ollama", &row, false)
            .await?
            .ok_or(Error::Conflict("owned Ollama service is absent"))?;
        let row: Row = [
            ("id".into(), format!("{id}/model")),
            ("service_id".into(), id.clone()),
            ("endpoint".into(), provider.endpoint.clone()),
            (
                "model".into(),
                document.spec.sandboxes[0].agents[0].inference.routes[0]
                    .overrides
                    .model
                    .clone(),
            ),
        ]
        .into();
        backend
            .read("ollama_model", &row, false)
            .await?
            .ok_or(Error::Conflict("owned Ollama model is absent"))?;
        Ok(())
    }
}
