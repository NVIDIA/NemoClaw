// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Serving-engine launch behavior; model and hardware qualification belongs to recipes.
use crate::{Error, config::Service};
pub(crate) mod vllm;
#[derive(Clone, Copy, Debug)]
pub enum Backend {
    Vllm,
}
impl Backend {
    pub fn arguments(
        self,
        service: &Service,
        model_directory: &str,
        total: u64,
    ) -> Result<Vec<String>, Error> {
        if let Some(recipe) = &service.recipe {
            service.validate()?;
            let settings = &recipe.serving;
            let compilation=match &settings.compilation {
                Some(c)=>serde_json::json!({"mode":c.mode,"cudagraph_mode":c.cudagraph_mode,"cudagraph_capture_sizes":c.capture_sizes}).to_string(),
                None=>"{\"mode\":0}".into(),
            };
            let mut args = vllm::arguments(
                &service.serving,
                model_directory,
                total,
                vllm::ModelSettings {
                    name: &settings.model_name,
                    gpu_bytes: recipe.resources.gpu_memory_bytes,
                    kv_cache_dtype: &settings.kv_cache_dtype,
                    mamba_cache_dtype: &settings.mamba_cache_dtype,
                    reasoning_parser: &settings.reasoning_parser,
                    tool_parser: &settings.tool_parser,
                    compilation,
                },
            )?;
            for (flag, value) in [
                ("--kv-cache-dtype", &settings.kv_cache_dtype),
                ("--mamba-ssm-cache-dtype", &settings.mamba_cache_dtype),
                ("--reasoning-parser", &settings.reasoning_parser),
                ("--tool-call-parser", &settings.tool_parser),
            ] {
                if value.is_empty()
                    && let Some(i) = args.iter().position(|v| v == flag)
                {
                    args.drain(i..i + 2);
                }
            }
            if settings.tool_parser.is_empty() {
                args.retain(|v| v != "--enable-auto-tool-choice");
            }
            if !settings.lazy_loading
                && let Some(i) = args.iter().position(|v| v == "--safetensors-load-strategy")
            {
                args.drain(i..i + 2);
            }
            if !settings.chunked_prefill {
                args.retain(|v| v != "--enable-chunked-prefill");
            }
            return Ok(args);
        }
        if service.backend == crate::recipes::huggingface::BACKEND {
            return crate::recipes::huggingface::arguments(service, model_directory, total);
        }
        match self {
            Self::Vllm => {
                let recipe = crate::recipes::resolve(service)?;
                vllm::arguments(
                    &service.serving,
                    model_directory,
                    total,
                    recipe.vllm_settings(service)?,
                )
            }
        }
    }
}
