<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Find Documentation and Project Resources

Use the [documentation index](README.md) for the v1 development branch.
Keep the documentation, configuration schema, and runtime bundle matched to the source revision you use.

## Documentation for Coding Agents

Repository Markdown and the [generated configuration reference](reference/configuration.md) are available in this checkout.
Use [CLI reference](reference/cli.md) for accepted commands and [migration](migration.md) for earlier-product boundaries.

A v1 starter prompt and docs-routing skill: **TBD**.
The [documentation build](AUTOMATION.md) prepares v1 pages for Fern's browser and Markdown outputs.
Verification of hosted Markdown, `llms.txt`, and docs search/MCP: **TBD**; see [hosted output checks](AUTOMATION.md#hosted-outputs-and-release-verification).
Do not assume an existing public documentation endpoint describes this development branch.

## Contribute

Follow [repository instructions](../AGENTS.md), [the writing guide](../WRITING.md), and [documentation contribution guidance](CONTRIBUTING.md).
The [documentation migration plan](design/documentation-migration.md) defines page ownership and remaining publication work.

Current user-support and community contribution routes for v1: **TBD**.

## Licenses and Source Notices

Original NemoClaw code uses [Apache-2.0](../LICENSE).
Read the notices for components and derived code:

- [Agent runtime sources](../image/NOTICE.md).
- [Brave plugin attribution](../image/fabric/BRAVE-NOTICE.md).
- [Generic vLLM runtime](../runtimes/vllm/NOTICE.md).
- [AMD64 vLLM runtime and Nemotron configuration sources](../runtimes/vllm-amd64/NOTICE.md).
- [Qwen3.8 sources and AGPL-3.0-or-later adaptations](../runtimes/qwen38/NOTICE.md).

## Report a Security Issue

Private vulnerability-reporting instructions: **TBD**; see the [security guide](security.md).
