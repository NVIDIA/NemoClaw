---
title:
  page: "NemoClaw Quickstart — Install, Launch, and Run Your First Agent"
  nav: "Quickstart"
description: "Install NemoClaw, launch a sandbox, and run your first agent prompt."
keywords: ["nemoclaw quickstart", "install nemoclaw openclaw sandbox"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "inference_routing", "nemoclaw"]
content:
  type: get_started
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Quickstart

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

:::{note}
NemoClaw currently requires a fresh installation of OpenClaw.
:::

```{include} ../../README.md
:start-after: <!-- start-quickstart-guide -->
:end-before: <!-- end-quickstart-guide -->
```

## Troubleshooting: `Creating sandbox` exits with `Killed` or `exit 137`

If `nemoclaw onboard` fails during **Creating sandbox** and the shell reports `Killed` or exit code `137`, the host likely ran out of memory while building or starting the sandbox image.

Community reports have reproduced this on small VMs with 8 GB of RAM; retrying with more memory resolved the failure.

Before rerunning `nemoclaw onboard`:

- Increase the VM or host memory allocation.
- Restart the shell session if the Docker or OpenShell processes were terminated by the OOM killer.
- Retry the onboard flow after the host has enough free memory headroom for the image build and sandbox startup.

## Next Steps

- [Switch inference providers](../inference/switch-inference-providers.md) to use a different model or endpoint.
- [Approve or deny network requests](../network-policy/approve-network-requests.md) when the agent tries to reach external hosts.
- [Customize the network policy](../network-policy/customize-network-policy.md) to pre-approve trusted domains.
- [Deploy to a remote GPU instance](../deployment/deploy-to-remote-gpu.md) for always-on operation.
- [Monitor sandbox activity](../monitoring/monitor-sandbox-activity.md) through the OpenShell TUI.

### Troubleshooting

If you run into issues during installation or onboarding, refer to the [Troubleshooting guide](../reference/troubleshooting.md) for common error messages and resolution steps.
