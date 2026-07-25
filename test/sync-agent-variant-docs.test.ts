// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderAgentVariantPage } from "../scripts/sync-agent-variant-docs.mts";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SYNC_SCRIPT = path.join(REPO_ROOT, "scripts/sync-agent-variant-docs.mts");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");

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
  it("passes --check when generated docs are already synchronized", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-agent-variant-check-"));
    try {
      const fixtureScript = path.join(fixtureRoot, "scripts/sync-agent-variant-docs.mts");
      mkdirSync(path.dirname(fixtureScript), { recursive: true });
      writeFileSync(fixtureScript, readFileSync(SYNC_SCRIPT, "utf8"));
      symlinkSync(NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");

      const docsRoot = path.join(fixtureRoot, "docs");
      mkdirSync(path.join(docsRoot, "reference"), { recursive: true });
      writeFileSync(
        path.join(docsRoot, "index.yml"),
        `
navigation:
  - section: User Guide
    variants:
      - slug: openclaw
        layout:
          - page: Example
            path: _build/agent-variants/reference/example.openclaw.generated.mdx
      - slug: hermes
        layout:
          - page: Example
            path: _build/agent-variants/reference/example.hermes.generated.mdx
      - slug: deepagents
        layout:
          - page: Example
            path: _build/agent-variants/reference/example.deepagents.generated.mdx
`,
      );
      const sourcePath = path.join(docsRoot, "reference/example.mdx");
      const source = `---
title: "Example"
---
Run $$nemoclaw list.
`;
      writeFileSync(sourcePath, source);

      const generatedRoot = path.join(docsRoot, "_build/agent-variants/reference");
      mkdirSync(generatedRoot, { recursive: true });
      const generatedFiles = (["openclaw", "hermes", "deepagents"] as const).map((variant) => {
        const outputPath = path.join(generatedRoot, `example.${variant}.generated.mdx`);
        const contents = renderAgentVariantPage(source, variant, { outputPath, sourcePath });
        writeFileSync(outputPath, contents);
        return { path: outputPath, contents };
      });

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", realpathSync(fixtureScript), "--check"],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(0);
      expect(output).not.toContain("Out of sync");
      expect(output).not.toContain("Missing");
      expect(output).not.toContain("Stale");
      expect(output).not.toContain("Generated agent variant docs are out of sync");
      for (const file of generatedFiles) {
        expect(readFileSync(file.path, "utf8")).toBe(file.contents);
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("checks generated docs without rewriting or pruning files", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-agent-variant-check-"));
    try {
      const fixtureScript = path.join(fixtureRoot, "scripts/sync-agent-variant-docs.mts");
      mkdirSync(path.dirname(fixtureScript), { recursive: true });
      writeFileSync(fixtureScript, readFileSync(SYNC_SCRIPT, "utf8"));
      symlinkSync(NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");

      const docsRoot = path.join(fixtureRoot, "docs");
      mkdirSync(path.join(docsRoot, "reference"), { recursive: true });
      writeFileSync(
        path.join(docsRoot, "index.yml"),
        `
navigation:
  - section: User Guide
    variants:
      - slug: openclaw
        layout:
          - page: Example
            path: _build/agent-variants/reference/example.openclaw.generated.mdx
      - slug: hermes
        layout:
          - page: Example
            path: _build/agent-variants/reference/example.hermes.generated.mdx
      - slug: deepagents
        layout:
          - page: Example
            path: _build/agent-variants/reference/example.deepagents.generated.mdx
`,
      );
      writeFileSync(
        path.join(docsRoot, "reference/example.mdx"),
        `---
title: "Example"
---
Run $$nemoclaw list.
`,
      );

      const generatedRoot = path.join(docsRoot, "_build/agent-variants/reference");
      mkdirSync(generatedRoot, { recursive: true });
      const outOfSyncPath = path.join(generatedRoot, "example.openclaw.generated.mdx");
      const stalePath = path.join(generatedRoot, "obsolete.generated.mdx");
      const missingHermesPath = path.join(generatedRoot, "example.hermes.generated.mdx");
      const outOfSyncContents = "keep stale expected file\n";
      const staleContents = "keep obsolete generated file\n";
      writeFileSync(outOfSyncPath, outOfSyncContents);
      writeFileSync(stalePath, staleContents);

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", realpathSync(fixtureScript), "--check"],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("Out of sync");
      expect(output).toContain("example.openclaw.generated.mdx");
      expect(output).toContain("Missing");
      expect(output).toContain("example.hermes.generated.mdx");
      expect(output).toContain("Stale");
      expect(output).toContain("obsolete.generated.mdx");
      expect(readFileSync(outOfSyncPath, "utf8")).toBe(outOfSyncContents);
      expect(readFileSync(stalePath, "utf8")).toBe(staleContents);
      expect(existsSync(missingHermesPath)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

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

  it("omits gateway-agent session headings from the Deep Agents reference", () => {
    const source = readFileSync(new URL("../docs/reference/commands.mdx", import.meta.url), "utf8");
    const deepAgents = renderDeepAgentsCommandsVariant(source);
    const hermes = renderHermesCommandsVariant(source);

    expect(deepAgents).not.toContain("### `nemo-deepagents <name> sessions`");
    expect(deepAgents).not.toContain("### `nemo-deepagents <name> sessions list`");
    expect(hermes).toContain("### `nemohermes <name> sessions`");
    expect(hermes).toContain("### `nemohermes <name> sessions list`");
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
