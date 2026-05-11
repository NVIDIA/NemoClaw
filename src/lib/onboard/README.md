<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboard support

`src/lib/onboard` is the transitional home for onboarding support modules while the large legacy `src/lib/onboard.ts` flow is split over time.

Good candidates:

```text
types.ts
providers.ts
preflight.ts
usage-notice.ts
legacy-command.ts
```

Related modules may live outside this folder when their ownership is clearer:

```text
src/lib/state/onboard-session.ts          persisted onboarding session state
src/lib/inference/onboard-probes.ts       inference validation probes used by onboarding
src/lib/inference/ollama/proxy.ts         Ollama proxy lifecycle helpers
src/lib/inference/vllm.ts                 vLLM onboarding helpers
src/lib/inference/ollama/windows.ts       Windows Ollama support
```

Do not move `src/lib/onboard.ts` casually. It is high-import and high-risk; if it moves, keep a compatibility re-export path or split it through focused behavior-preserving PRs.
