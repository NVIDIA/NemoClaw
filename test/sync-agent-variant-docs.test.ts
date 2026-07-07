// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { renderAgentVariantPage } from "../scripts/sync-agent-variant-docs";

const FRONTMATTER = `---
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
title: "NemoClaw CLI Commands Reference"
sidebar-title: "Commands"
description: "Full CLI reference for standalone NemoClaw commands and agent-specific in-sandbox commands."
description-agent: "Includes the full CLI reference for standalone NemoClaw commands and agent-specific in-sandbox commands. Use when looking up a specific \`nemoclaw\`, \`nemohermes\`, \`nemo-deepagents\`, \`dcode\`, or \`/nemoclaw\` subcommand, flag, argument, or exit code."
keywords: ["nemoclaw cli commands", "nemoclaw command reference", "nemo-deepagents commands", "dcode commands"]
content:
  type: "reference"
---
`;

describe("sync-agent-variant-docs", () => {
  function renderHermesCommandsVariant(source: string): string {
    return renderAgentVariantPage(source, "hermes", {
      sourcePath: "/repo/docs/reference/commands.mdx",
    });
  }

  function renderDeepAgentsCommandsVariant(source: string): string {
    return renderAgentVariantPage(source, "deepagents", {
      sourcePath: "/repo/docs/reference/commands.mdx",
    });
  }

  it("rewrites only NemoClaw CLI invocations for the NemoHermes reference", () => {
    const rendered = renderHermesCommandsVariant(`${FRONTMATTER}
import { AgentOnly } from "../_components/AgentGuide";

### \`nemoclaw list\`

\`\`\`bash
nemoclaw list
NEMOCLAW_PROVIDER=routed nemoclaw onboard --non-interactive
URL=$(nemoclaw my-assistant dashboard-url --quiet)
\`\`\`

Run [policy-add](#nemoclaw-name-policy-add) for presets.
The fallback command is \`nemoclaw onboard --agent hermes\`.
The trusted image is \`ghcr.io/nvidia/nemoclaw/sandbox-base:latest\`.
The gateway state path is \`~/.local/state/nemoclaw\`.
`);

    expect(rendered).toContain("### `nemohermes list`");
    expect(rendered).toContain("exclude-from-skills-gen: true");
    expect(rendered).toContain("nemohermes list");
    expect(rendered).toContain("NEMOCLAW_PROVIDER=routed nemohermes onboard --non-interactive");
    expect(rendered).toContain("URL=$(nemohermes my-assistant dashboard-url --quiet)");
    expect(rendered).toContain("[policy-add](#nemohermes-name-policy-add)");
    expect(rendered).toContain("`nemoclaw onboard --agent hermes`");
    expect(rendered).toContain("`ghcr.io/nvidia/nemoclaw/sandbox-base:latest`");
    expect(rendered).toContain("`~/.local/state/nemoclaw`");
    expect(rendered).not.toContain("ghcr.io/nvidia/nemohermes/sandbox-base");
    expect(rendered).not.toContain("~/.local/state/nemohermes");
    expect(rendered).not.toContain("nemohermes onboard --agent hermes");
  });

  it("rewrites only NemoClaw CLI invocations for the NemoDeepAgents reference", () => {
    const rendered = renderDeepAgentsCommandsVariant(`${FRONTMATTER}
import { AgentOnly } from "../_components/AgentGuide";

### \`nemoclaw list\`

\`\`\`bash
nemoclaw list
NEMOCLAW_AGENT=langchain-deepagents-code nemoclaw onboard --non-interactive
URL=$(nemoclaw my-assistant status --json)
\`\`\`

Run [policy-add](#nemoclaw-name-policy-add) for presets.
The fallback command is \`nemoclaw onboard --agent langchain-deepagents-code\`.
The trusted image is \`ghcr.io/nvidia/nemoclaw/sandbox-base:latest\`.
The gateway state path is \`~/.local/state/nemoclaw\`.
`);

    expect(rendered).toContain("### `nemo-deepagents list`");
    expect(rendered).toContain("exclude-from-skills-gen: true");
    expect(rendered).toContain("nemo-deepagents list");
    expect(rendered).toContain(
      "NEMOCLAW_AGENT=langchain-deepagents-code nemo-deepagents onboard --non-interactive",
    );
    expect(rendered).toContain("URL=$(nemo-deepagents my-assistant status --json)");
    expect(rendered).toContain("[policy-add](#nemo-deepagents-name-policy-add)");
    expect(rendered).toContain("`nemoclaw onboard --agent langchain-deepagents-code`");
    expect(rendered).toContain("`ghcr.io/nvidia/nemoclaw/sandbox-base:latest`");
    expect(rendered).toContain("`~/.local/state/nemoclaw`");
    expect(rendered).not.toContain("ghcr.io/nvidia/nemo-deepagents/sandbox-base");
    expect(rendered).not.toContain("~/.local/state/nemo-deepagents");
  });

  it("renders Hermes-only web search environment guidance", () => {
    const source = readFileSync(new URL("../docs/reference/commands.mdx", import.meta.url), "utf8");
    const rendered = renderHermesCommandsVariant(source);
    const onboardingStart = rendered.indexOf("### Onboarding Configuration");
    const onboardingEnd = rendered.indexOf("#### Extra placeholder keys", onboardingStart);
    const onboarding = rendered.slice(onboardingStart, onboardingEnd);

    expect(onboardingStart).toBeGreaterThanOrEqual(0);
    expect(onboardingEnd).toBeGreaterThan(onboardingStart);
    expect(onboarding).toContain("| `NEMOCLAW_WEB_SEARCH_PROVIDER` | `tavily` or `none` |");
    expect(onboarding).toContain("| `TAVILY_API_KEY` | Tavily Search API key |");
    expect(onboarding).not.toContain("| `BRAVE_API_KEY` |");
    expect(onboarding).not.toContain("Brave-first precedence");
  });
});
