<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw on DGX Spark

The guide for setting up NemoClaw on DGX Spark is available on the [NVIDIA Spark playbook instructions](https://build.nvidia.com/spark/nemoclaw/instructions).
DGX Spark needs no platform-specific pre-setup because Docker is pre-installed, so the standard [OpenClaw quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart.html) works directly.
Use the hosted installer without a version override.
It follows the last-known-good (`lkg`) release tag by default.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

Refer to the playbook for detailed instructions.
