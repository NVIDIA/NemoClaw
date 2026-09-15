// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Error, config::Service, hardware::GIB};

struct Settings<'a> {
    name: &'a str,
    gpu_bytes: u64,
    tool_parser: &'a str,
    reasoning_parser: &'a str,
    kv_cache_dtype: &'a str,
    mamba_cache_dtype: &'a str,
    kv_cache_bytes: Option<u64>,
    lazy_loading: bool,
    chunked_prefill: bool,
    compilation: Option<String>,
}
impl<'a> Settings<'a> {
    fn resolve(service: &'a Service) -> Self {
        if let Some(recipe) = &service.recipe {
            let s = &recipe.serving;
            Self {
                name: &s.model_name,
                gpu_bytes: recipe.resources.gpu_memory_bytes,
                tool_parser: &s.tool_parser,
                reasoning_parser: &s.reasoning_parser,
                kv_cache_dtype: &s.kv_cache_dtype,
                mamba_cache_dtype: &s.mamba_cache_dtype,
                kv_cache_bytes: None,
                lazy_loading: s.lazy_loading,
                chunked_prefill: s.chunked_prefill,
                compilation: Some(match &s.compilation {
                    Some(c) => serde_json::json!({"mode":c.mode,"cudagraph_mode":c.cudagraph_mode,"cudagraph_capture_sizes":c.capture_sizes}).to_string(),
                    None => "{\"mode\":0}".into(),
                }),
            }
        } else {
            Self {
                name: &service.model.repository,
                gpu_bytes: super::validation::gpu_bytes(service),
                tool_parser: &service.serving.tool_parser,
                reasoning_parser: &service.serving.reasoning_parser,
                kv_cache_dtype: "",
                mamba_cache_dtype: "",
                kv_cache_bytes: Some(service.memory.kv_cache_gib as u64 * GIB),
                lazy_loading: false,
                chunked_prefill: false,
                compilation: None,
            }
        }
    }
}
pub(crate) fn arguments(
    service: &Service,
    model_directory: &str,
    total: u64,
) -> Result<Vec<String>, Error> {
    service.validate()?;
    let model = Settings::resolve(service);
    if total == 0 || model.gpu_bytes > total {
        return Err(Error::Conflict("invalid total memory for inference budget"));
    }
    let v = &service.serving;
    let utilization = (model.gpu_bytes as f64 / total as f64 * 1000.0).floor() / 1000.0;
    let mut args: Vec<String> = [
        "-m",
        "vllm.entrypoints.openai.api_server",
        "--model",
        model_directory,
        "--served-model-name",
        model.name,
        "--host",
        "0.0.0.0",
        "--tensor-parallel-size",
        "1",
        "--load-format",
        "safetensors",
    ]
    .map(String::from)
    .into();
    for (flag, value) in [
        ("--port", v.port.to_string()),
        ("--gpu-memory-utilization", format!("{utilization:.3}")),
        ("--max-num-seqs", v.max_sequences.to_string()),
        ("--max-num-batched-tokens", v.batch_tokens.to_string()),
        ("--max-model-len", v.context_tokens.to_string()),
    ] {
        args.extend([flag.into(), value]);
    }
    for (flag, value) in [
        ("--kv-cache-dtype", model.kv_cache_dtype),
        ("--mamba-ssm-cache-dtype", model.mamba_cache_dtype),
        ("--reasoning-parser", model.reasoning_parser),
        ("--tool-call-parser", model.tool_parser),
    ] {
        if !value.is_empty() {
            args.extend([flag.into(), value.into()]);
        }
    }
    if !model.tool_parser.is_empty() {
        args.push("--enable-auto-tool-choice".into());
    }
    if model.lazy_loading {
        args.extend(["--safetensors-load-strategy".into(), "lazy".into()]);
    }
    if model.chunked_prefill {
        args.push("--enable-chunked-prefill".into());
    }
    if let Some(bytes) = model.kv_cache_bytes {
        args.extend(["--kv-cache-memory-bytes".into(), bytes.to_string()]);
    }
    if let Some(compilation) = model.compilation {
        args.extend([
            "--distributed-executor-backend".into(),
            "mp".into(),
            "--compilation-config".into(),
            compilation,
        ]);
    } else {
        args.push("--enforce-eager".into());
    }
    if v.speculative_tokens > 0 {
        args.extend([
            "--speculative-config".into(),
            format!(
                r#"{{"method":"mtp","num_speculative_tokens":{}}}"#,
                v.speculative_tokens
            ),
        ]);
    }
    Ok(args)
}
