// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderAgentVariantPage } from "../scripts/sync-agent-variant-docs.mts";

const source = `---
title: "Example"
description-agent: "Use when looking up $$nemoclaw commands."
---
<AgentOnly variant="openclaw">
OpenClaw only.
</AgentOnly>
<AgentOnly variant="hermes">
Hermes only.
</AgentOnly>
<AgentOnly variant="deepagents">
Deep Agents only.
</AgentOnly>
<AgentOnly variant="openclaw,hermes">
Gateway agents only.
</AgentOnly>

\`\`\`bash
$$nemoclaw list
\`\`\`

Use \`$$nemoclaw\` for the current variant.
`;

describe("agent variant docs", () => {
  it("renders OpenClaw placeholder code and content", () => {
    const rendered = renderAgentVariantPage(source, "openclaw");

    expect(rendered).toContain("OpenClaw only.");
    expect(rendered).toContain("Gateway agents only.");
    expect(rendered).toContain('description-agent: "Use when looking up nemoclaw commands."');
    expect(rendered).not.toContain("Hermes only.");
    expect(rendered).not.toContain("Deep Agents only.");
    expect(rendered).toContain("nemoclaw list");
    expect(rendered).not.toContain("$$nemoclaw");
    expect(rendered).not.toContain("<AgentOnly");
  });

  it("renders Hermes placeholder code and content", () => {
    const rendered = renderAgentVariantPage(source, "hermes");

    expect(rendered).not.toContain("OpenClaw only.");
    expect(rendered).toContain("Hermes only.");
    expect(rendered).toContain("Gateway agents only.");
    expect(rendered).not.toContain("Deep Agents only.");
    expect(rendered).toContain('description-agent: "Use when looking up nemohermes commands."');
    expect(rendered).toContain("nemohermes list");
    expect(rendered).not.toContain("$$nemoclaw");
    expect(rendered).not.toContain("<AgentOnly");
  });

  it("renders Deep Agents placeholder code and content", () => {
    const rendered = renderAgentVariantPage(source, "deepagents");

    expect(rendered).not.toContain("OpenClaw only.");
    expect(rendered).not.toContain("Hermes only.");
    expect(rendered).toContain("Deep Agents only.");
    expect(rendered).not.toContain("Gateway agents only.");
    expect(rendered).toContain(
      'description-agent: "Use when looking up nemo-deepagents commands."',
    );
    expect(rendered).toContain("nemo-deepagents list");
    expect(rendered).not.toContain("$$nemoclaw");
    expect(rendered).not.toContain("<AgentOnly");
  });

  it("keeps adjacent list items together after variant filtering", () => {
    const rendered = renderAgentVariantPage(
      `---
title: "Example"
---
## Prerequisites

<AgentOnly variant="openclaw">

- NemoClaw installed.

</AgentOnly>
<AgentOnly variant="hermes">

- NemoHermes installed.

</AgentOnly>
- A local model server running.
`,
      "openclaw",
    );

    expect(rendered).toContain("- NemoClaw installed.\n- A local model server running.");
    expect(rendered).not.toContain("- NemoClaw installed.\n\n- A local model server running.");
    expect(rendered).not.toContain("NemoHermes installed.");
  });

  it("preserves paragraph boundaries around retained variant prose", () => {
    const rendered = renderAgentVariantPage(
      `---
title: "Example"
---
Shared paragraph.

<AgentOnly variant="openclaw">

OpenClaw paragraph.

</AgentOnly>
Following paragraph.
`,
      "openclaw",
    );

    expect(rendered).toContain("Shared paragraph.\n\nOpenClaw paragraph.");
    expect(rendered).toContain("OpenClaw paragraph.\n\nFollowing paragraph.");
  });

  it("rejects nested AgentOnly blocks before they leak into generated variants", () => {
    const nested = `---
title: "Example"
---
<AgentOnly variant="openclaw,hermes">
Shared gateway content.
<AgentOnly variant="openclaw">
OpenClaw content.
</AgentOnly>
</AgentOnly>
`;

    expect(() => renderAgentVariantPage(nested, "openclaw")).toThrow("nested AgentOnly block");
  });

  it("rejects inline AgentOnly directives before they reach Fern", () => {
    const inline = `---
title: "Example"
---
<AgentOnly variant="openclaw">OpenClaw only.</AgentOnly>
`;

    expect(() => renderAgentVariantPage(inline, "openclaw")).toThrow(
      "unresolved AgentOnly directive",
    );
  });

  it("rejects runtime agent components before they reach Fern", () => {
    const runtimeComponent = `---
title: "Example"
---
Use <AgentCli /> for the current variant.
`;

    expect(() => renderAgentVariantPage(runtimeComponent, "hermes")).toThrow(
      "unresolved runtime agent component",
    );
  });

  it("rejects AgentGuide imports before they reach Fern", () => {
    const runtimeImport = `---
title: "Example"
---
import { AgentOnly } from "../_components/AgentGuide";
`;

    expect(() => renderAgentVariantPage(runtimeImport, "deepagents")).toThrow(
      "unresolved AgentGuide import",
    );
  });

  it("rewrites relative imports but preserves Fern route links for generated build output", () => {
    const rendered = renderAgentVariantPage(
      `${source}\nimport { Example } from "../_components/Example";\n\nSee [Commands](../reference/commands#$$nemoclaw-list).\nSee [Backup](backup-restore).\n![Diagram](images/diagram.png)\n`,
      "hermes",
      {
        outputPath:
          "/repo/docs/_build/agent-variants/manage-sandboxes/lifecycle.hermes.generated.mdx",
        sourcePath: "/repo/docs/manage-sandboxes/lifecycle.mdx",
      },
    );

    expect(rendered).toContain('import { Example } from "../../../_components/Example";');
    expect(rendered).toContain("[Commands](../reference/commands#nemohermes-list)");
    expect(rendered).toContain("[Backup](backup-restore)");
    expect(rendered).toContain("![Diagram](../../../manage-sandboxes/images/diagram.png)");
  });

  it("renders strict Landlock troubleshooting for Deep Agents only", () => {
    const troubleshooting = readFileSync(
      new URL("../docs/reference/troubleshooting.mdx", import.meta.url),
      "utf8",
    );
    const deepAgents = renderAgentVariantPage(troubleshooting, "deepagents", {
      sourcePath: "/repo/docs/reference/troubleshooting.mdx",
    });
    const openclaw = renderAgentVariantPage(troubleshooting, "openclaw", {
      sourcePath: "/repo/docs/reference/troubleshooting.mdx",
    });

    expect(deepAgents).toContain("### Landlock filesystem policy blocks sandbox startup");
    expect(deepAgents).toContain("Deep Agents uses strict Landlock compatibility.");
    expect(deepAgents).toContain(
      "OpenShell refuses to start the sandbox instead of silently degrading.",
    );
    expect(deepAgents).not.toContain("### Landlock filesystem restrictions silently degraded");
    expect(deepAgents).not.toContain("best_effort mode");
    expect(deepAgents).not.toContain(
      "This warning is informational and does not block sandbox creation.",
    );

    expect(openclaw).toContain("### Landlock filesystem restrictions silently degraded");
    expect(openclaw).toContain("best_effort mode");
    expect(openclaw).not.toContain("### Landlock filesystem policy blocks sandbox startup");
  });

  it("does not render managed web-search troubleshooting for Deep Agents", () => {
    const troubleshooting = readFileSync(
      new URL("../docs/reference/troubleshooting.mdx", import.meta.url),
      "utf8",
    );
    const deepAgents = renderAgentVariantPage(troubleshooting, "deepagents", {
      sourcePath: "/repo/docs/reference/troubleshooting.mdx",
    });
    const openclaw = renderAgentVariantPage(troubleshooting, "openclaw", {
      sourcePath: "/repo/docs/reference/troubleshooting.mdx",
    });

    expect(deepAgents).toContain("### Tavily remains blocked after opt-in");
    expect(deepAgents).toContain(
      "Deep Agents does not have a NemoClaw-managed web-search feature.",
    );
    expect(deepAgents).not.toContain("### Web search verification reports a warning");
    expect(deepAgents).not.toContain(
      "When web search is enabled, onboarding checks the selected agent configuration",
    );
    expect(deepAgents).not.toContain(
      "Rerunning onboarding with a different provider recreates the sandbox",
    );

    expect(openclaw).toContain("### Web search verification reports a warning");
    expect(openclaw).not.toContain(
      "Deep Agents does not have a NemoClaw-managed web-search feature.",
    );
  });

  it("lists only implemented commands in manifest iteration guidance (#7308)", () => {
    const manifest = readFileSync(
      new URL("../docs/inference/declarative-agents-manifest.mdx", import.meta.url),
      "utf8",
    );
    const rendered = renderAgentVariantPage(manifest, "openclaw", {
      sourcePath: "/repo/docs/inference/declarative-agents-manifest.mdx",
    });
    const iteratingStart = rendered.indexOf("## Iterating");
    const iteratingEnd = rendered.indexOf("## Apply to an Existing Sandbox", iteratingStart);
    const iterating = rendered.slice(iteratingStart, iteratingEnd);

    expect(iteratingStart).toBeGreaterThanOrEqual(0);
    expect(iteratingEnd).toBeGreaterThan(iteratingStart);
    expect(iterating).toContain("agents add|delete|list");
    expect(iterating).toContain("agents apply -f <agents.yaml>");
    expect(iterating).not.toContain("agents show");
  });

  it("renders provider-switch instructions for the applicable agent variants (#7309)", () => {
    const source = readFileSync(
      new URL("../docs/inference/switch-providers.mdx", import.meta.url),
      "utf8",
    );
    const render = (variant: "openclaw" | "hermes" | "deepagents") =>
      renderAgentVariantPage(source, variant, {
        sourcePath: "/repo/docs/inference/switch-providers.mdx",
      });
    const openclaw = render("openclaw");
    const hermes = render("hermes");
    const deepAgents = render("deepagents");
    const recreationHeading = "## Recreate a Deep Agents Sandbox";
    const namedSandboxSyntax =
      "The `shields` commands take a positional name. `inference set` takes `--sandbox <name>`.";

    expect(openclaw).toContain(namedSandboxSyntax);
    expect(openclaw).toContain("nemoclaw <name> shields down");
    expect(openclaw).not.toContain(recreationHeading);
    expect(hermes).toContain(namedSandboxSyntax);
    expect(hermes).toContain("nemohermes <name> shields down");
    expect(hermes).not.toContain(recreationHeading);
    expect(deepAgents).toContain(recreationHeading);
    expect(deepAgents).not.toContain(namedSandboxSyntax);
  });

  it("keeps the troubleshooting security review link within each agent guide (#6558)", () => {
    const troubleshooting = readFileSync(
      new URL("../docs/reference/troubleshooting.mdx", import.meta.url),
      "utf8",
    );

    for (const variant of ["openclaw", "hermes", "deepagents"] as const) {
      const rendered = renderAgentVariantPage(troubleshooting, variant, {
        outputPath: `/repo/docs/_build/agent-variants/reference/troubleshooting.${variant}.generated.mdx`,
        sourcePath: "/repo/docs/reference/troubleshooting.mdx",
      });

      expect(rendered).toContain(
        "[OpenShell gateway compatibility review](../security/openshell-0.0.72-compatibility-review#source-of-truth-boundaries)",
      );
      expect(rendered).not.toMatch(
        /\/user-guide\/(?:openclaw|hermes|deepagents)\/security\/openshell-0\.0\.72-compatibility-review/,
      );
    }
  });
});
