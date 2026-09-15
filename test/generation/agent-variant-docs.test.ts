// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  agentVariants,
  findGeneratedNavigationTargets,
  renderAgentVariantPage,
} from "../../scripts/sync-agent-variant-docs.mts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every page that `docs/index.yml` publishes through a generated agent variant,
 * paired with the variants that actually publish it. Discovery goes through the
 * renderer's own parsed navigation so the test cannot drift from what ships.
 */
function sharedVariantPages(): readonly {
  sourcePath: string;
  source: string;
  variants: readonly (typeof agentVariants)[number][];
}[] {
  const targets = findGeneratedNavigationTargets();

  return [...new Set(targets.map((target) => target.sourcePath))].sort().map((sourcePath) => ({
    sourcePath,
    source: readFileSync(path.join(repoRoot, "docs", sourcePath), "utf8"),
    variants: agentVariants.filter((variant) =>
      targets.some((target) => target.sourcePath === sourcePath && target.variant === variant),
    ),
  }));
}

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
<AgentOnly variant="pi">
Pi only.
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

  it("publishes Deep Agents forward recovery scope only for Deep Agents (#11176)", () => {
    const sourcePath = "manage-sandboxes/recover-rebuild-sandboxes.mdx";
    const pageSource = readFileSync(path.join(repoRoot, "docs", sourcePath), "utf8");
    const render = (variant: "openclaw" | "hermes" | "deepagents") =>
      renderAgentVariantPage(pageSource, variant, { sourcePath });
    const gatewayStartRepair =
      "The `start` command repairs the agent runtime and host-side port forwards.";
    const gatewayStartSuccess =
      "It returns success only after it authenticates the recovered agent runtime, OpenShell reports the sandbox ready, and host-side port forwards pass their checks.";
    const gatewayStartFailure =
      "If a check fails, the command exits nonzero, identifies the failure, and prints recovery guidance before you retry `start`.";
    const terminalRuntimeScope =
      "Deep Agents uses a terminal runtime without an in-sandbox agent gateway or host-side port forward.";
    const forwardPrerequisites =
      "The OpenShell ownership and local endpoint reachability prerequisites for an active port forward do not apply.";

    expect(render("openclaw")).toContain(gatewayStartRepair);
    expect(render("hermes")).toContain(gatewayStartRepair);
    expect(render("deepagents")).not.toContain(gatewayStartRepair);
    expect(render("openclaw")).toContain(gatewayStartSuccess);
    expect(render("hermes")).toContain(gatewayStartSuccess);
    expect(render("deepagents")).not.toContain(gatewayStartSuccess);
    expect(render("openclaw")).toContain(gatewayStartFailure);
    expect(render("hermes")).toContain(gatewayStartFailure);
    expect(render("deepagents")).not.toContain(gatewayStartFailure);
    expect(render("deepagents")).toContain(terminalRuntimeScope);
    expect(render("deepagents")).toContain(forwardPrerequisites);
    expect(render("openclaw")).not.toContain(terminalRuntimeScope);
    expect(render("openclaw")).not.toContain(forwardPrerequisites);
    expect(render("hermes")).not.toContain(terminalRuntimeScope);
    expect(render("hermes")).not.toContain(forwardPrerequisites);
  });

  it("renders Pi placeholder code and content", () => {
    const rendered = renderAgentVariantPage(source, "pi");

    expect(rendered).not.toContain("OpenClaw only.");
    expect(rendered).not.toContain("Hermes only.");
    expect(rendered).not.toContain("Deep Agents only.");
    expect(rendered).toContain("Pi only.");
    expect(rendered).not.toContain("Gateway agents only.");
    expect(rendered).toContain('description-agent: "Use when looking up nemoclaw commands."');
    expect(rendered).toContain("nemoclaw list");
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
import { AgentOnly } from "../../_components/AgentGuide";
`;

    expect(() => renderAgentVariantPage(runtimeImport, "deepagents")).toThrow(
      "unresolved AgentGuide import",
    );
  });

  it("rewrites relative imports but preserves Fern route links for generated build output", () => {
    const rendered = renderAgentVariantPage(
      `${source}\nimport { Example } from "../../_components/Example";\n\nSee [Commands](../reference/commands#$$nemoclaw-list).\nSee [Backup](backup-restore).\n![Diagram](images/diagram.png)\n`,
      "hermes",
      {
        outputPath:
          "/repo/docs/_build/agent-variants/manage-sandboxes/lifecycle.hermes.generated.mdx",
        sourcePath: "/repo/docs/manage-sandboxes/lifecycle.mdx",
      },
    );

    expect(rendered).toContain('import { Example } from "../../../../_components/Example";');
    expect(rendered).toContain("[Commands](../reference/commands#nemohermes-list)");
    expect(rendered).toContain("[Backup](backup-restore)");
    expect(rendered).toContain("![Diagram](../../../manage-sandboxes/images/diagram.png)");
  });

  it("rejects a heading whose body is filtered out of the variant (#9731)", () => {
    const orphanHeading = `---
title: "Example"
---
## Set OpenClaw Limits

<AgentOnly variant="openclaw">

OpenClaw only.

</AgentOnly>
`;

    expect(() => renderAgentVariantPage(orphanHeading, "openclaw")).not.toThrow();
    expect(() => renderAgentVariantPage(orphanHeading, "hermes")).toThrow(
      "renders ## Set OpenClaw Limits with no content in the hermes generated variant",
    );
  });

  it("accepts a section whose only content is a fenced Markdown example (#9731)", () => {
    const fencedExample = `---
title: "Example"
---
## Parent

\`\`\`markdown
## Example Heading

## Example Sibling
\`\`\`
`;

    expect(() => renderAgentVariantPage(fencedExample, "openclaw")).not.toThrow();
  });

  it("rejects a section whose only content is a comment that renders nothing (#9731)", () => {
    const commentOnly = `---
title: "Example"
---
## Parent

{/* nothing renders here */}

## Sibling

Real content.
`;

    expect(() => renderAgentVariantPage(commentOnly, "openclaw")).toThrow(
      "renders ## Parent with no content",
    );
  });

  it("treats an indented Markdown example as content, not a heading (#9731)", () => {
    const indentedExample = `---
title: "Example"
---
## Parent

    ## Indented Example Heading

## Sibling

Real content.
`;

    expect(() => renderAgentVariantPage(indentedExample, "openclaw")).not.toThrow();
  });

  it("keeps scanning after text that looks like a closing fence (#9731)", () => {
    const looseFenceClose = `---
title: "Example"
---
## Parent

~~~text
~~~not-a-close
~~~

## Empty Sibling

## Last

Real content.
`;

    expect(() => renderAgentVariantPage(looseFenceClose, "openclaw")).toThrow(
      "renders ## Empty Sibling with no content",
    );
  });

  it("keeps comment state separate from fences and indentation (#9731)", () => {
    const commentWithMarkers = `---
title: "Example"
---
## Parent

{/*
    ~~~
    ## Commented Heading
*/}

## Sibling

Real content.
`;

    expect(() => renderAgentVariantPage(commentWithMarkers, "openclaw")).toThrow(
      "renders ## Parent with no content",
    );
  });

  it("names every empty heading in one message (#9731)", () => {
    const twoEmpty = `---
title: "Example"
---
## First

## Second

## Last

Real content.
`;

    expect(() => renderAgentVariantPage(twoEmpty, "openclaw")).toThrow(
      "renders ## First, ## Second with no content",
    );
  });

  it("closes a comment that spaces the terminator from its brace (#9731)", () => {
    // MDX allows `*/ }`. Failing to close the comment swallows the content
    // below it, so the section reads as empty when it is not.
    const spacedCommentEnd = `---
title: "Example"
---
## Parent

{/* note */ }

Real content.
`;

    expect(() => renderAgentVariantPage(spacedCommentEnd, "openclaw")).not.toThrow();
  });

  it("keeps text that follows a comment terminator (#9731)", () => {
    const trailingText = `---
title: "Example"
---
## Parent

{/* note */} Real content here.
`;

    expect(() => renderAgentVariantPage(trailingText, "openclaw")).not.toThrow();
  });

  it("does not open a fence on an inline code span (#9731)", () => {
    const inlineSpan = `---
title: "Example"
---
## Parent

\`\`\`inline\`\`\` mentioned in prose.

## Empty Sibling

## Last

Real content.
`;

    expect(() => renderAgentVariantPage(inlineSpan, "openclaw")).toThrow(
      "renders ## Empty Sibling with no content",
    );
  });

  it("does not close a fence on an indented marker (#9731)", () => {
    // The indented marker is code, so the headings below it stay inside the
    // fence and never open a section.
    const indentedClose = `---
title: "Example"
---
## Parent

\`\`\`\`text
    \`\`\`\`
## Not A Heading
## Still Not A Heading
\`\`\`\`

Real content.
`;

    expect(() => renderAgentVariantPage(indentedClose, "openclaw")).not.toThrow();
  });

  it("closes a fence on a longer marker (#9731)", () => {
    const longerClose = `---
title: "Example"
---
## Parent

\`\`\`text
fenced content
\`\`\`\`\`

## Empty Sibling

## Last

Real content.
`;

    expect(() => renderAgentVariantPage(longerClose, "openclaw")).toThrow(
      "renders ## Empty Sibling with no content",
    );
  });

  it("sees a level-one heading as a section boundary (#9731)", () => {
    const topLevelAfterEmpty = `---
title: "Example"
---
## Empty

# Title

Real content.
`;

    expect(() => renderAgentVariantPage(topLevelAfterEmpty, "openclaw")).toThrow(
      "renders ## Empty with no content",
    );
  });

  it("reports an empty Setext section (#9731)", () => {
    const setextHeadings = `---
title: "Example"
---
Empty Section
-------------

Last Section
------------

Real content.
`;

    expect(() => renderAgentVariantPage(setextHeadings, "openclaw")).toThrow(
      "renders Empty Section with no content",
    );
  });

  it("does not treat a Setext underline as its section's content (#9731)", () => {
    const underlineOnly = `---
title: "Example"
---
Only Heading
============
`;

    expect(() => renderAgentVariantPage(underlineOnly, "openclaw")).toThrow(
      "renders Only Heading with no content",
    );
  });

  it("keeps a Setext heading above an ATX section honest (#9731)", () => {
    const mixed = `---
title: "Example"
---
Setext Parent
=============

## Child

Real content.
`;

    expect(() => renderAgentVariantPage(mixed, "openclaw")).not.toThrow();
  });

  it("points OpenClaw enterprise readiness at the OpenClaw OTEL command fragment (#11145)", () => {
    const sourcePath = path.join(repoRoot, "docs/reference/enterprise-readiness.mdx");
    const rendered = renderAgentVariantPage(readFileSync(sourcePath, "utf8"), "openclaw", {
      sourcePath,
    });

    expect(rendered).toContain("#openclaw-conversation-otel-diagnostics");
    expect(rendered).not.toContain("#deep-agents-code-otlp-traces");
  });

  it("does not send Hermes enterprise readiness to the Deep Agents OTLP command fragment (#11145)", () => {
    const sourcePath = path.join(repoRoot, "docs/reference/enterprise-readiness.mdx");
    const rendered = renderAgentVariantPage(readFileSync(sourcePath, "utf8"), "hermes", {
      sourcePath,
    });

    expect(rendered).not.toContain("#deep-agents-code-otlp-traces");
    expect(rendered).toContain("#messaging-bridge-appears-running-but-no-messages-arrive");
  });

  it("keeps the messaging-bridge heading on the Hermes troubleshooting page (#11145)", () => {
    const sourcePath = path.join(repoRoot, "docs/reference/troubleshooting.mdx");
    const rendered = renderAgentVariantPage(readFileSync(sourcePath, "utf8"), "hermes", {
      sourcePath,
    });

    expect(rendered).toContain("### Messaging bridge appears running but no messages arrive");
  });

  it("omits the messaging-bridge fragment from Deep Agents pages (#11145)", () => {
    const readinessPath = path.join(repoRoot, "docs/reference/enterprise-readiness.mdx");
    const troubleshootingPath = path.join(repoRoot, "docs/reference/troubleshooting.mdx");
    const readiness = renderAgentVariantPage(readFileSync(readinessPath, "utf8"), "deepagents", {
      sourcePath: readinessPath,
    });
    const troubleshooting = renderAgentVariantPage(
      readFileSync(troubleshootingPath, "utf8"),
      "deepagents",
      { sourcePath: troubleshootingPath },
    );

    expect(troubleshooting).not.toContain(
      "### Messaging bridge appears running but no messages arrive",
    );
    expect(readiness).not.toContain("#messaging-bridge-appears-running-but-no-messages-arrive");
  });

  it("points Hermes recovery at the variant recover command fragment (#11147)", () => {
    const sourcePath = path.join(repoRoot, "docs/manage-sandboxes/recover-rebuild-sandboxes.mdx");
    const pageSource = readFileSync(sourcePath, "utf8");
    const rendered = renderAgentVariantPage(pageSource, "hermes", { sourcePath });

    expect(rendered).toContain("#nemohermes-name-recover");
    expect(rendered).not.toContain("#nemoclaw-name-recover");
  });

  it("leaves no shared page section heading without content in any published variant (#9731)", () => {
    const pages = sharedVariantPages();
    const renderEveryPublishedVariant = () =>
      pages.flatMap(({ sourcePath, source: pageSource, variants }) =>
        variants.map((variant) => renderAgentVariantPage(pageSource, variant, { sourcePath })),
      );

    expect(pages.length).toBeGreaterThan(0);
    expect(renderEveryPublishedVariant).not.toThrow();
  });
});
