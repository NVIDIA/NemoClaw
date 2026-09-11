// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isSafeServedModelReference } from "../probe/existing-server-attachment";

/** Stable contract for operator-run llmman existing-server attachment. */
export const LLMMAN_SELECTION_KEY = "llmman";
export const LLMMAN_PROVIDER_NAME = "llmman-local";
export const LLMMAN_PROVIDER_LABEL = "Local llmman";
export const LLMMAN_CREDENTIAL_ENV = "NEMOCLAW_LLMMAN_LOCAL_TOKEN";
/** llmman's default `LLMMAN_HOST` port. */
export const LLMMAN_PORT = 17434;
export const LLMMAN_HOST_BASE_URL = `http://127.0.0.1:${LLMMAN_PORT}`;
export const LLMMAN_HOST_OPENAI_BASE_URL = `${LLMMAN_HOST_BASE_URL}/v1`;

/** llmman model names are OCI or Hugging Face references such as `n/gemma4:latest`. */
export const isSafeLlmmanModelReference = isSafeServedModelReference;
