<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation and Project Resources

Use the [documentation index](../README.md) for Agent Configs v0.1.0 and [Release Notes](../changelog/overview.md) for release status.
Keep the documentation, configuration schema, and runtime bundle matched to the source revision you use.

## Documentation for Coding Agents

Repository Markdown and the [generated field reference](../reference/configuration.md) are available in this checkout. The reference and its JSON Schema belong to this checkout's source revision.
Use the ones from the bundle's revision for validation.
Use [CLI reference](../references/cli.md) for accepted commands and [migration](../get-started/migration.md) for earlier-product boundaries.

### Choosing the v1 Sources

Match the guide, bundle, and schema to the same implementation revision before using any hosted or checkout-local reference.
Choose a source by its use:

| Source | Use |
|---|---|
| The `v0.1.0` tag's `docs/README.md` and task guides | Release-specific guidance. Use the [generated field reference](../reference/configuration.md) from the matching worktree and the JSON Schema from the installed archive. |
| [NemoClaw Agent Configs staging overview](https://nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw/v1/overview) | Preview the v1 guide on the staging site. |
| [v1 Markdown index](https://nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw/v1/llms.txt) | Discover pages in the v1 guide. |
| [v1 overview as Markdown](https://nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw/v1/overview.md) | Fetch the overview as text. Append `.md` to another v1 page URL for that page. |

Staging updates after successful pushes to `v1`.
Inspect its revision-pinned source links when matching it to a bundle.
For hosted NemoClaw Agent Configs guides, use the index at `/nemoclaw/v1/llms.txt`. For NemoClaw v0 guides, start with the [parent NemoClaw Markdown index](https://docs.nvidia.com/nemoclaw/llms.txt).
Before running commands from a hosted guide, confirm that it matches your installed version and source revision.
In the combined local preview, **Latest (main)** is the default.
Generic Markdown headers might point at the unversioned index or advertise an MCP server.
Those headers do not establish v1 search isolation or MCP availability.
Docs search, MCP and v1-scoped results are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).

### Giving an Agent the Documentation Task

Use this prompt with an assistant that can read your checkout, replacing the final line with your task:

```text
Help me use NemoClaw Agent Configs v0.1.0.
Read docs/README.md, docs/about/overview.md, and the guide for my task from this checkout.
Use CLI and configuration references from the same source revision as my bundle, starting with docs/reference/configuration.md.
For hosted NemoClaw Agent Configs documentation, use the index at /nemoclaw/v1/llms.txt.
Keep NemoClaw v0 commands and procedures separate from v1 guidance.
Treat anything listed in docs/resources/limits.md as not yet available or tested.
Identify the client, sandbox engine, inference host, image digests, and deployment state path before deployment work.
Describe which resources an operation changes or retains and how to verify its result.
Use credential references; do not request secret values in chat or put them in YAML or command arguments.
Preserve the original bundle and state for recovery; export does not back up agent files or history.
My task: [describe the task and environment]
```

This prompt routes documentation.
It does not supply missing installers, native-data migration, or gateway provisioning.

### Using the Documentation Skill From a Checkout

The repository includes a [NemoClaw user-guide skill](../../.agents/skills/nemoclaw-user-guide/SKILL.md) for version selection and task routing.
For an assistant with access to this checkout, ask it to read `.agents/skills/nemoclaw-user-guide/SKILL.md` before answering your NemoClaw task.
Keep the skill in the checkout so its relative links resolve to the same revision's guides.
It checks the intended product version and available commands and options before choosing commands, and refuses to substitute main guidance when a v1 source is unavailable.
Review the cited version and task guide in its answer before operational work.

The skill only routes documentation.
Reading it does not install software or change deployment resources.
To evaluate Agent Configs in a separate deployment using settings exported from NemoClaw v0, ask the assistant to read `.agents/skills/nemoclaw-v0-migration/SKILL.md`.
Refer to [migration](../get-started/migration.md#starting-from-the-earlier-export).
Automatic discovery, packaged installation across assistant clients and a rehearsed installation prompt are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).

## Getting Help

Use [NemoClaw issues](https://github.com/NVIDIA/NemoClaw/issues) for reproducible implementation or documentation problems and [discussions](https://github.com/NVIDIA/NemoClaw/discussions) for product questions or proposed capabilities.
Identify the v1 revision, bundle, relevant configuration, expected behavior, and the failure observed.
Follow [diagnostic collection](../observability/troubleshooting.md#capturing-the-failing-operation) before sharing output.
Exclude credential values and private deployment data.

[NemoClaw Community](https://github.com/NVIDIA/nemoclaw-community) hosts community solutions and examples.
Check their target version before using them with v1.
Their existence does not establish v1 support or qualification.
Refer to [Current Limits](limits.md) before choosing a deployment configuration.

## Licenses and Source Notices

Original NemoClaw code uses [Apache-2.0](../../LICENSE).
Read the notices for components and derived code:

- [Agent runtime sources](../../image/NOTICE.md).
- [Runtime memory and serving policy attribution](../../crates/nemoclaw-runtime/NOTICE.md).
- [vLLM runtime and NVIDIA Nemotron configuration sources](../../image/vllm/NOTICE.md).
- [Ollama runtime sources](../../image/ollama/NOTICE.md).
- [llama.cpp runtime sources](../../image/llama-cpp/NOTICE.md).

## Reporting a Security Issue

Use the private reporting channels in [SECURITY.md](../../SECURITY.md).
The [security guide](../security/security.md) describes current controls and their qualification limits.
