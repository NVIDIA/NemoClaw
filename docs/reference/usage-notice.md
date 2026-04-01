---
title:
  page: "NemoClaw Usage Notice"
  nav: "Usage Notice"
description: "Usage notice and disclaimer shown during NemoClaw onboarding."
keywords: ["nemoclaw usage notice", "nemoclaw disclaimer", "nemoclaw terms"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "legal"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Usage Notice

NemoClaw shows this notice during first-run onboarding before it provisions a sandbox.
If the bundled notice version changes, NemoClaw shows the updated notice again on the next onboarding run.

```{admonition} Notice and Disclaimer
:class: warning

This software automatically retrieves, accesses or interacts with external materials.
Those retrieved materials are not distributed with this software and are governed solely by separate terms, conditions and licenses.
You are solely responsible for finding, reviewing and complying with all applicable terms, conditions, and licenses, and for verifying the security, integrity and suitability of any retrieved materials for your specific use case.
This software is provided "AS IS", without warranty of any kind.
The author makes no representations or warranties regarding any retrieved materials, and assumes no liability for any losses, damages, liabilities or legal consequences from your use or inability to use this software or any retrieved materials.
Use this software and the retrieved materials at your own risk.
```

## Operator Override

The bundled notice config lives in the CLI package.
To supply a different notice without changing JavaScript code, set `NEMOCLAW_ONBOARD_NOTICE_CONFIG` to a JSON file that contains:

- `version`
- `title`
- `summary`
- `details`
- `url`
- `prompt`
