<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# V0 export fixtures for V1

`pending-gemini.yaml` is the canonical V0 export of one OpenClaw Gemini route. It contains a credential reference, not a key value.

V1 revision `88c6600c06b0937907290362eef86912052c4ad0` rejects `provider: google` with `provider requires a lowercase name and openai or anthropic implementation`. V1 Gemini work should use this file without rewriting it and replace this pending result with parser, planner, and deployment evidence. Existing exports keep their pinned V1 consumer checks.
