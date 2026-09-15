// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{
    compile::Generations,
    ollama::{OllamaBackend, ServiceSpec},
};
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
        network: config.network.clone(),
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
        let row = [
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
        backend
            .read("ollama", &row, false)
            .await?
            .ok_or(Error::Conflict("owned Ollama service is absent"))?;
        let row = [
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
