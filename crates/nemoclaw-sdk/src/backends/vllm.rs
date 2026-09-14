// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Error, config::Serving};
pub(crate) struct ModelSettings {
    pub name: &'static str,
    pub gpu_bytes: u64,
    pub kv_cache_dtype: &'static str,
    pub mamba_cache_dtype: &'static str,
    pub reasoning_parser: &'static str,
    pub tool_parser: &'static str,
    pub compilation: &'static str,
}
pub fn arguments(
    v: &Serving,
    model_directory: &str,
    total: u64,
    model: ModelSettings,
) -> Result<Vec<String>, Error> {
    if total == 0 || model.gpu_bytes > total {
        return Err(Error::Conflict("invalid total memory for inference budget"));
    }
    let utilization = (model.gpu_bytes as f64 / total as f64 * 1000.0).floor() / 1000.0;
    let mut args = vec![
        "-m".into(),
        "vllm.entrypoints.openai.api_server".into(),
        "--model".into(),
        model_directory.into(),
        "--served-model-name".into(),
        model.name.into(),
        "--host".into(),
        "0.0.0.0".into(),
        "--port".into(),
        v.port.to_string(),
        "--tensor-parallel-size".into(),
        "1".into(),
        "--gpu-memory-utilization".into(),
        format!("{utilization:.3}"),
        "--max-num-seqs".into(),
        v.max_sequences.to_string(),
        "--max-num-batched-tokens".into(),
        v.batch_tokens.to_string(),
        "--max-model-len".into(),
        v.context_tokens.to_string(),
    ];
    args.extend(
        [
            "--kv-cache-dtype",
            model.kv_cache_dtype,
            "--mamba-ssm-cache-dtype",
            model.mamba_cache_dtype,
            "--load-format",
            "safetensors",
            "--safetensors-load-strategy",
            "lazy",
            "--enable-chunked-prefill",
            "--reasoning-parser",
            model.reasoning_parser,
            "--enable-auto-tool-choice",
            "--tool-call-parser",
            model.tool_parser,
            "--distributed-executor-backend",
            "mp",
            "--compilation-config",
            model.compilation,
        ]
        .map(String::from),
    );
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
