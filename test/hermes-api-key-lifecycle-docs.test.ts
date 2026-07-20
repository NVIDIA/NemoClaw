// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const COMMANDS_PATH = "docs/reference/commands.mdx";
const REBUILD_GUIDE_PATH = "docs/manage-sandboxes/recover-rebuild-sandboxes.mdx";
const QUICKSTART_PATH = "docs/get-started/quickstart-hermes.mdx";

function readDoc(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function readHermesGatewayTokenSection(): string {
  const commands = readDoc(COMMANDS_PATH);
  const heading = "### `$$nemoclaw <name> gateway-token`";
  const sectionStart = commands.indexOf(heading);
  const sectionEnd = commands.indexOf("\n### `", sectionStart + heading.length);

  expect(sectionStart).toBeGreaterThanOrEqual(0);
  expect(sectionEnd).toBeGreaterThan(sectionStart);

  const section = commands.slice(sectionStart, sectionEnd);
  const hermesStart = section.indexOf('<AgentOnly variant="hermes">');
  const hermesEnd = section.indexOf("</AgentOnly>", hermesStart);

  expect(hermesStart).toBeGreaterThanOrEqual(0);
  expect(hermesEnd).toBeGreaterThan(hermesStart);
  return section.slice(hermesStart, hermesEnd);
}

describe("Hermes API bearer token lifecycle documentation (#7175)", () => {
  it("distinguishes stable restarts from key-generating replacement operations", () => {
    const commands = readHermesGatewayTokenSection();

    expect(commands).toContain("generated once for each sandbox home");
    expect(commands).toContain("Different sandbox homes receive different tokens");
    expect(commands).toContain(
      "gateway restart, sandbox stop and start, and host OpenShell gateway restart",
    );
    expect(commands).toContain("rebuild or replace the sandbox");
    expect(commands).toContain("missing or is not exactly 64 lowercase hexadecimal characters");
    expect(commands).toContain("while the existing `API_SERVER_KEY` was present and valid");
  });

  it("points rebuild operators to supported token retrieval", () => {
    const commands = readHermesGatewayTokenSection();
    const rebuildGuide = readDoc(REBUILD_GUIDE_PATH);
    const quickstart = readDoc(QUICKSTART_PATH);

    expect(commands).toContain("nemohermes my-assistant gateway-token --quiet");
    expect(rebuildGuide).toContain("$$nemoclaw <sandbox-name> gateway-token --quiet");
    expect(commands).toContain("replacement home receives a new token");
    expect(rebuildGuide).toContain("new Hermes API bearer token");
    expect(commands).toContain("Treat the token like a password");
    expect(commands).toContain("The sandbox must be running");
    expect(commands).toContain("instead of reading or editing `.hermes/.env` directly");
    expect(quickstart).toContain("nemohermes my-hermes gateway-token --quiet");
    expect(quickstart).not.toContain("bearer token from the generated Hermes environment");
  });
});
