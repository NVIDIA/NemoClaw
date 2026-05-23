<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inference

`src/lib/inference` is for model/provider configuration, inference health checks, local runtime support, and model catalog helpers.

Suggested homes:

```text
config.ts                 inference config parsing and normalization
health.ts                 inference endpoint health checks
local.ts                  local inference orchestration helpers
provider-models.ts        provider model catalog support
model-prompts.ts          prompt/model display helpers
nim.ts                    NIM catalog and lifecycle support
ollama/model-size.ts      Ollama model size parsing
ollama/proxy.ts           Ollama auth proxy support
ollama/windows.ts         Windows Ollama support
vllm.ts                   vLLM support
web-search.ts             web-search capability helpers
onboard-probes.ts         onboarding-time inference validation probes
```

Longer term, pure inference decisions should move under `src/lib/domain/inference/**`, and HTTP/process boundaries should move under `src/lib/adapters/**`.
