// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { renderAgentVariantPage } from "../scripts/sync-agent-variant-docs";

const source = `---
title: "Example"
description-agent: "Use when looking up $$nemoclaw commands."
---
import { AgentCli, AgentOnly } from "../_components/AgentGuide";

<AgentOnly variant="openclaw">
OpenClaw only.
</AgentOnly>
<AgentOnly variant="hermes">
Hermes only.
</AgentOnly>

\`\`\`bash
$$nemoclaw list
\`\`\`

Use <AgentCli /> for the current variant.
`;

describe("agent variant docs", () => {
  it("renders OpenClaw placeholder code and content", () => {
    const rendered = renderAgentVariantPage(source, "openclaw");

    expect(rendered).toContain("OpenClaw only.");
    expect(rendered).toContain('description-agent: "Use when looking up nemoclaw commands."');
    expect(rendered).not.toContain("Hermes only.");
    expect(rendered).toContain("nemoclaw list");
    expect(rendered).not.toContain("$$nemoclaw");
    expect(rendered).not.toContain("<AgentOnly");
  });

  it("renders Hermes placeholder code and content", () => {
    const rendered = renderAgentVariantPage(source, "hermes");

    expect(rendered).not.toContain("OpenClaw only.");
    expect(rendered).toContain("Hermes only.");
    expect(rendered).toContain('description-agent: "Use when looking up nemohermes commands."');
    expect(rendered).toContain("nemohermes list");
    expect(rendered).not.toContain("$$nemoclaw");
    expect(rendered).not.toContain("<AgentOnly");
  });

  it("rewrites relative imports but preserves Fern route links for generated build output", () => {
    const rendered = renderAgentVariantPage(
      `${source}\nSee [Commands](../reference/commands#$$nemoclaw-list).\nSee [Backup](backup-restore).\n![Diagram](images/diagram.png)\n`,
      "hermes",
      {
        outputPath:
          "/repo/docs/_build/agent-variants/manage-sandboxes/lifecycle.hermes.generated.mdx",
        sourcePath: "/repo/docs/manage-sandboxes/lifecycle.mdx",
      },
    );

    expect(rendered).toContain(
      'import { AgentCli, AgentOnly } from "../../../_components/AgentGuide";',
    );
    expect(rendered).toContain("[Commands](../reference/commands#nemohermes-list)");
    expect(rendered).toContain("[Backup](backup-restore)");
    expect(rendered).toContain("![Diagram](../../../manage-sandboxes/images/diagram.png)");
  });
});
