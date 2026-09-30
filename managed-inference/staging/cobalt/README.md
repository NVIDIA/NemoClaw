<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Cobalt staging

Cobalt stages a harness-independent Station serving recipe for review. It is not a runnable or supported model.
The production catalog generator reads only `models/`, `recipes/`, and `presets/`; it does not read this directory.
The staged preset also disables selection. No feature flag enables it.

Scope: [#12492](https://github.com/NVIDIA/NemoClaw/issues/12492).

Only the artifact identity, zero revision, runtime image and digest, and one-byte download sizes remain release-binding placeholders.
Keep private artifacts, credentials, identities, and test results outside this repository.

## Prepared integration

The recipe specifies BF16, a 16,384-token context, two concurrent sequences, 95% GPU memory utilization, and 32 GiB shared memory.
It configures direct tool calling and reasoning parsers through existing public vLLM options. Speculative decoding is not enabled.
The recipe enables remote model code; activation requires review of that code at the pinned model revision.
Media is limited to two inline images; video is disabled. No local-media directory is exposed.
The media-domain allowlist uses a reserved invalid domain. Do not replace it with unrestricted URL fetching.
The existing host-local materializer owns installation, fixed arguments, bearer authentication, and catalog receipts.
Existing lifecycle code owns recovery; this directory adds no runtime implementation or credential mechanism.

The recipe adds no agent configuration, workspace instructions, or harness-specific setup.
Tool and reasoning parsers are model-server settings; they do not select or configure an agent harness.

Integration tests compile these documents and materialize the serving command through existing consumers.
They also prove that production discovery and selection still exclude Cobalt.
These tests do not prove runtime flag compatibility, model quality, prompt fit, harness compatibility, or hardware performance.
The model capabilities describe the candidate contract, not completed release qualification.

## Release activation

Activation requires a separate reviewed change:

1. Record the released model identity, immutable revision, file manifest, and runtime image digest.
2. Replace the release-binding placeholders and validate all serving options against the pinned runtime and target hardware.
3. Qualify chat, images, tools and context fit, plus authentication, restart, rebuild, cleanup, and recovery.
4. Record the harness and configuration used for each live test; do not imply untested harnesses are qualified.
5. Promote the reviewed catalog documents and set selection and support states from accepted evidence.
6. Review any proposed default or fallback change separately from staging.

Renaming Cobalt, setting a feature flag, or copying these files without replacing and qualifying the placeholders does not establish support.
