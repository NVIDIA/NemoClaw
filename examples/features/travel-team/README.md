<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Travel Team

This example configures six Hermes roles: four researchers, a scheduler, and a buyer. A person or script passes results between them and supplies the approval before booking.

| Configuration | Behavior and prerequisites |
|---|---|
| [travel-team.yaml](travel-team.yaml) | Managed Docker gateway and Ollama on DGX Spark, plus hosted inference and web search. The booking key is registered, but the buyer does not send its credential placeholder. |
| [HCL project](hcl/README.md) | Existing Docker-backed gateway, configurable Ollama hardware, hosted inference, web search, authenticated booking, an enforced tool allowlist, and role instructions with handoff schemas. |

Keep the configuration, credentials, and state of each deployment separate. The YAML and HCL forms do not adopt one another's resources and do not have identical booking behavior.

For YAML, build the selected images, replace the deployment UID, image references, and illustrative endpoints, then follow the [shared procedure](../../README.md#prepare-and-run-a-yaml-example).
For HCL, follow its [setup and invocation instructions](hcl/README.md#run-it).
The HCL README records [live evidence and its limits](hcl/README.md#tried-live); it does not qualify every YAML or hardware variant.
