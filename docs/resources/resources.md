<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation and Project Resources

Use the [documentation index](../README.md) for the v1 development branch and [Release Notes](../about/release-notes.md) for its development changes and release boundary.
Keep the documentation, configuration schema, and runtime bundle matched to the source revision you use.

## Documentation for Coding Agents

Repository Markdown and the [source-pinned v1 field reference](../references/v1-configuration.md) are available in this checkout. The generated reference at `docs/reference/configuration.md` belongs to this checkout's source revision. Its named-map shape matches the pinned v1 source, but three optional field types differ; consult the schema from the bundle's revision for validation.
Use [CLI reference](../references/cli.md) for accepted commands and [migration](../get-started/migration.md) for earlier-product boundaries.

### Choose the v1 Sources

Match the guide, bundle, and schema to the same implementation revision before using any hosted or checkout-local reference.

| Source | Use |
|---|---|
| This checkout's `docs/README.md` and task guides | V1 guidance grounded in the pinned implementation revision; use its [v1 field snapshot](../references/v1-configuration.md) or the generated reference in a matching v1 worktree |
| [v1 staging overview](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/overview) | Browser preview; choose **v1 (Development)** in the version selector |
| [v1 Markdown index](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/llms.txt) | Discover pages in this version |
| [v1 overview as Markdown](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/overview.md) | Fetch page text; append `.md` to another v1 page URL for that page |

The staging preview moves after successful pushes; inspect its revision-pinned source links when matching it to a bundle.
The site's unversioned `llms.txt` describes the default main version.
Use the `/nemoclaw/v1/` index for v1 tasks and keep that prefix when following published task-guide links.
Generic Markdown headers may point at the unversioned index or advertise an MCP server; those headers do not establish v1 search isolation or MCP availability.
Docs search, MCP and v1-scoped results are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).

### Give an Agent the Documentation Task

Use this prompt with an assistant that can read your checkout, replacing the final line with your task:

```text
Help me use the v1 development version of NemoClaw.
Read docs/README.md, docs/about/overview.md, and the guide for my task from this checkout.
Use CLI and configuration references from the same source revision as my bundle. For pinned v1, start with docs/references/v1-configuration.md.
For hosted documentation, use the v1 (Development) selector and /nemoclaw/v1/llms.txt.
Keep main-version commands and procedures separate from v1 guidance.
Treat anything listed in docs/resources/limits.md as not yet available or tested.
Identify the client, sandbox engine, inference host, image digests, and deployment state path before deployment work.
Describe which resources an operation changes or retains and how to verify its result.
Use credential references; do not request secret values in chat or put them in YAML or command arguments.
Preserve the original bundle and state for recovery; export does not back up agent files or history.
My task: [describe the task and environment]
```

This prompt routes documentation; it does not supply missing installers, native-data migration, or gateway provisioning.

### Use the Documentation Skill from a Checkout

The repository includes a [NemoClaw user-guide skill](../../.agents/skills/nemoclaw-user-guide/SKILL.md) for version selection and task routing.
For an assistant with access to this checkout, ask it to read `.agents/skills/nemoclaw-user-guide/SKILL.md` before answering your NemoClaw task.
Keep the skill in the checkout so its relative links resolve to the same revision's guides.
It checks the intended product version and available commands and options before choosing commands, and refuses to substitute main guidance when a v1 source is unavailable.
Review the cited version and task guide in its answer before operational work.

The skill only routes documentation; reading it does not install software or change deployment resources.
Automatic discovery, packaged installation across assistant clients and a rehearsed installation prompt are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).

## Contribute

Follow [repository instructions](../../AGENTS.md), [the writing guide](../../WRITING.md), and [documentation contribution guidance](../../internal-docs/contributing/documentation.md).

Use [NemoClaw issues](https://github.com/NVIDIA/NemoClaw/issues) for reproducible implementation/documentation problems and [discussions](https://github.com/NVIDIA/NemoClaw/discussions) for product questions or proposed capabilities.
Identify the v1 revision, bundle, relevant configuration, expected behavior, and the failure observed; follow [diagnostic collection](../observability/troubleshooting.md#capture-the-failing-operation) before sharing output.
Exclude credential values and private deployment data.

[NemoClaw Community](https://github.com/NVIDIA/nemoclaw-community) hosts community solutions and examples.
Check their target version before using them with v1; their existence does not establish v1 support or qualification.
v1 has no support policy yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).

## Licenses and Source Notices

Original NemoClaw code uses [Apache-2.0](../../LICENSE).
Read the notices for components and derived code:

- [Agent runtime sources](../../image/NOTICE.md).
- [Runtime memory and serving policy attribution](../../crates/nemoclaw-runtime/NOTICE.md).
- [vLLM runtime and Nemotron configuration sources](../../image/vllm/NOTICE.md).
- [Ollama runtime sources](../../image/ollama/NOTICE.md).

## Report a Security Issue

Use the private reporting channels in [SECURITY.md](../../SECURITY.md).
The [security guide](../security/security.md) describes current controls and their qualification limits.
