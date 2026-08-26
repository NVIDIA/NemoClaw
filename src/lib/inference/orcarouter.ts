// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ORCAROUTER_ENDPOINT_URL = "https://api.orcarouter.ai/v1";
export const ORCAROUTER_PROVIDER_NAME = "orcarouter-api";
export const ORCAROUTER_HELP_URL = "https://www.orcarouter.ai";
export const ORCAROUTER_CREDENTIAL_ENV = "ORCAROUTER_API_KEY";
// OrcaRouter exposes an OpenAI-compatible endpoint, so OpenShell registers it
// through the OpenAI-compatible provider profile with a distinct provider name
// and credential binding in NemoClaw, mirroring the OpenRouter provider.
export const ORCAROUTER_PROVIDER_TYPE = "openai";
