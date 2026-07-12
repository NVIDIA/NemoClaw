// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Non-secret OpenShell proxy rewrite sentinel shared by Hermes config paths.
// Hermes/LiteLLM requires an `sk-`-prefixed value before it will issue a
// request, but OpenShell strips this placeholder and injects the real route
// credential at the egress boundary. Remove this once Hermes no longer gates
// custom endpoints on a credential-shaped API key.
export const HERMES_PROXY_API_KEY_PLACEHOLDER = "sk-OPENSHELL-PROXY-REWRITE";
