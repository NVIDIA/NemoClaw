<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# V1 consumer compatibility fixtures

`pending-gemini.yaml` preserves a proposed configuration for one OpenClaw Gemini route. It contains a credential reference, not a key value. Gemini config export rejects this unsupported provider before writing YAML.

V1 revision `88c6600c06b0937907290362eef86912052c4ad0` rejects `provider: google` with `provider requires a lowercase name and openai or anthropic implementation`. V1 Gemini work should use this file without rewriting it and replace the rejection result with parser, planner, apply, and deployment evidence under accepted scope. Existing exports keep their pinned V1 consumer checks.
