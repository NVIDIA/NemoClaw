<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Cobalt staging

Cobalt stages a harness-independent Station serving recipe for review. It is not a runnable or supported model.
The production catalog generator reads only `models/`, `recipes/`, and `presets/`; it does not read this directory.
The staged preset also disables selection. No feature flag enables it.

Scope: [#12492](https://github.com/NVIDIA/NemoClaw/issues/12492).

The artifact identity, zero revision, runtime image/digest, template contents, and one-byte download sizes remain release bindings.
Keep private artifacts, credentials, identities, and test results outside this repository.

## Prepared integration

The recipe requires NVFP4 weights with three-token MTP speculative decoding, a 49,152-token context, and one concurrent sequence.
It uses 85% GPU memory utilization, 8,192 batched tokens, and 32 GiB shared memory.
KV cache uses BF16. Mamba state uses float16, FlashInfer, stochastic rounding, and five Philox rounds.
Weight quantization comes from the released artifact metadata; a dtype flag does not convert BF16 weights to NVFP4.
The recipe enables thinking and parameter-strict JSON tools through the Hermes tool parser and the configured reasoning parser.
The recipe enables remote model code; activation requires review of that code at the pinned model revision.
Media is limited to eight inline images; video is disabled. No local-media directory is exposed.
The media-domain allowlist uses a reserved invalid domain. Do not replace it with unrestricted URL fetching.
The existing host-local materializer owns installation, fixed arguments, bearer authentication, and catalog receipts.
Existing lifecycle code owns recovery; this directory adds no runtime implementation or credential mechanism.

The recipe adds no agent configuration, workspace instructions, or harness-specific setup.
Tool and reasoning parsers are model-server settings; they do not select or configure an agent harness.

## Runtime and request requirements

The release image must support every staged option and bundle the reviewed JSON chat template at `/opt/cobalt/chat_template.jinja`.
The template must preserve string arguments, including trailing newlines, and support reasoning followed by JSON tool calls.
The runtime must correctly transition from reasoning to constrained tool output for both streaming and non-streaming requests.
This remains a runtime dependency; an unpatched image is not qualified by these declarations.
Pin the complete runtime image, including required fixes and the template. Do not install patches at startup.

Clients must send `chat_template_kwargs: {"enable_thinking": true}` and `parallel_tool_calls: false` for the staged serial-tool contract.
The latter uses native response filtering; it is not a server flag and does not prevent generation of additional calls.
No additional serial-tool grammar patch is required by this contract.
Clients must budget prompt and output within 49,152 tokens, with at most 8,192 requested output tokens.
That output limit is a client requirement, not a server-enforced limit or the batched-token setting.
This recipe does not configure clients or certify that every harness sends these fields.

Integration tests compile these documents and materialize the serving command through existing consumers.
They also prove that production discovery and selection still exclude Cobalt.
These tests do not prove runtime flag compatibility, model quality, prompt fit, harness compatibility, or hardware performance.
The model capabilities describe the candidate contract, not completed release qualification.

## Release activation

Activation requires a separate reviewed change:

1. Record the released NVFP4/MTP model identity, immutable revision, file manifest, template hash, and complete runtime image digest.
2. Replace the release bindings and validate all serving options and template contents against the pinned runtime and target hardware.
3. Qualify chat, images, context fit, and streaming/non-streaming tools, including serial responses and trailing-newline preservation with thinking enabled.
   Include authentication, restart, rebuild, cleanup, recovery, and the staged media restrictions.
4. Record the harness and configuration used for each live test; do not imply untested harnesses are qualified.
5. Promote the reviewed catalog documents and set selection and support states from accepted evidence.
6. Review any proposed default or fallback change separately from staging.

Renaming Cobalt, setting a feature flag, or copying these files without replacing and qualifying the placeholders does not establish support.
