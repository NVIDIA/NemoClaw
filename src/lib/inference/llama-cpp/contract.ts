// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable constants for operator-run llama.cpp existing-server attachment. */
export const LLAMA_CPP_SELECTION_KEY = "llama-cpp";
export const LLAMA_CPP_PROVIDER_NAME = "llama-cpp-local";
export const LLAMA_CPP_PROVIDER_LABEL = "Local llama.cpp";
export const LLAMA_CPP_CREDENTIAL_ENV = "NEMOCLAW_LLAMACPP_LOCAL_TOKEN";
export const LLAMA_CPP_PORT = 8081;
export const LLAMA_CPP_HOST_BASE_URL = `http://127.0.0.1:${LLAMA_CPP_PORT}`;
export const LLAMA_CPP_HOST_OPENAI_BASE_URL = `${LLAMA_CPP_HOST_BASE_URL}/v1`;
export const LLAMA_CPP_GATEWAY_BASE_URL = `http://host.openshell.internal:${LLAMA_CPP_PORT}/v1`;
