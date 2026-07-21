// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const troubleshooting = readFileSync(
  path.join(repoRoot, "docs/reference/troubleshooting.mdx"),
  "utf8",
);

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = markdown.indexOf("\n### ", start + heading.length);
  return markdown.slice(start, next === -1 ? undefined : next);
}

describe("reboot recovery documentation", () => {
  it("routes macOS and Linux through managed OpenShell services before onboard resume", () => {
    const reboot = section(troubleshooting, "### Reconnect after a host reboot");

    expect(reboot).toContain("brew services restart openshell");
    expect(reboot).toContain("nemoclaw-openshell-gateway.service");
    expect(reboot).toContain("systemctl --user restart nemoclaw-openshell-gateway");
    expect(reboot).toContain("non-systemd Linux hosts");
    expect(reboot.indexOf("systemctl --user restart nemoclaw-openshell-gateway")).toBeLessThan(
      reboot.indexOf("$$nemoclaw onboard --resume"),
    );
  });
});
