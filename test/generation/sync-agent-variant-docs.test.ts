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

import { renderAgentVariantPage } from "../../scripts/sync-agent-variant-docs.mts";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SYNC_SCRIPT = path.join(REPO_ROOT, "scripts/sync-agent-variant-docs.mts");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const AGENT_VARIANTS = ["openclaw", "hermes", "deepagents", "pi"] as const;
type AgentVariant = (typeof AGENT_VARIANTS)[number];

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

function runVariantScopeFixture(
  source: string,
  publishedVariants: readonly AgentVariant[],
): { output: string; status: number | null } {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-agent-variant-scope-"));
  try {
    const fixtureScript = path.join(fixtureRoot, "scripts/sync-agent-variant-docs.mts");
    mkdirSync(path.dirname(fixtureScript), { recursive: true });
    writeFileSync(fixtureScript, readFileSync(SYNC_SCRIPT, "utf8"));
    symlinkSync(NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");

    const docsRoot = path.join(fixtureRoot, "docs");
    mkdirSync(path.join(docsRoot, "reference"), { recursive: true });
    const variantNavigation = AGENT_VARIANTS.map((variant) => {
      const layout = publishedVariants.includes(variant)
        ? `
          - page: Example
            path: reference/example.mdx`
        : " []";
      return `      - slug: ${variant}
        layout:${layout}`;
    }).join("\n");
    writeFileSync(
      path.join(docsRoot, "index.yml"),
      `navigation:
  - section: User Guide
    variants:
${variantNavigation}
`,
    );
    writeFileSync(path.join(docsRoot, "reference/example.mdx"), source);

    const result = spawnSync(process.execPath, ["--import", "tsx", realpathSync(fixtureScript)], {
      cwd: fixtureRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      output: `${result.stdout}\n${result.stderr}`,
      status: result.status,
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("sync-agent-variant-docs", () => {
  it("rejects a partial-variant page without an explicit scope declaration (#6576)", () => {
    const result = runVariantScopeFixture(
      `---
title: "Example"
---
OpenClaw content.
`,
      ["openclaw"],
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "docs/reference/example.mdx is published for [openclaw] but does not declare agent-variants",
    );
    expect(result.output).toContain(
      "Publish each source page in every applicable guide variant, or declare the intentional subset in frontmatter.",
    );
  });

  it("rejects a scope declaration that differs from navigation membership (#6576)", () => {
    const result = runVariantScopeFixture(
      `---
title: "Example"
agent-variants: ["openclaw", "hermes"]
---
OpenClaw content.
`,
      ["openclaw"],
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "docs/reference/example.mdx declares agent-variants [openclaw, hermes] but navigation publishes [openclaw]",
    );
  });

  it("accepts an explicit scope that matches navigation membership (#6576)", () => {
    const result = runVariantScopeFixture(
      `---
title: "Example"
agent-variants: ["openclaw"]
---
OpenClaw content.
`,
      ["openclaw"],
    );

    expect(result.status).toBe(0);
    expect(result.output).not.toContain("Guide variant scope does not match docs/index.yml");
  });

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
      - slug: pi
        layout:
          - page: Example
            path: _build/agent-variants/reference/example.pi.generated.mdx
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
      const generatedFiles = (["openclaw", "hermes", "deepagents", "pi"] as const).map(
        (variant) => {
          const outputPath = path.join(generatedRoot, `example.${variant}.generated.mdx`);
          const contents = renderAgentVariantPage(source, variant, { outputPath, sourcePath });
          writeFileSync(outputPath, contents);
          return { path: outputPath, contents };
        },
      );

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
      - slug: pi
        layout:
          - page: Example
            path: _build/agent-variants/reference/example.pi.generated.mdx
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
});
