// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readDoc(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("manage sandboxes docs command coverage", () => {
  it("documents day-two lifecycle commands that are easy to miss", () => {
    const lifecycle = readDoc("docs/manage-sandboxes/lifecycle.mdx");

    for (const command of [
      "nemoclaw my-assistant doctor",
      "nemoclaw my-assistant logs --tail 100",
      "nemoclaw my-assistant logs --since 10m",
      "nemoclaw my-assistant gateway-token",
      "nemoclaw inference get",
      "nemoclaw gc --dry-run",
    ]) {
      expect(lifecycle).toContain(command);
    }
  });

  it("documents runtime hosts aliases and workspace share commands", () => {
    const runtimeControls = readDoc("docs/manage-sandboxes/runtime-controls.mdx");
    const workspaceFiles = readDoc("docs/manage-sandboxes/workspace-files.mdx");

    for (const command of [
      "nemoclaw my-assistant hosts-add internal.example.com 10.0.0.42",
      "nemoclaw my-assistant hosts-list",
      "nemoclaw my-assistant hosts-remove internal.example.com",
    ]) {
      expect(runtimeControls).toContain(command);
    }

    for (const command of [
      "nemoclaw my-assistant share mount /sandbox/.openclaw/workspace ~/my-assistant-workspace",
      "nemoclaw my-assistant share status",
      "nemoclaw my-assistant share unmount ~/my-assistant-workspace",
    ]) {
      expect(workspaceFiles).toContain(command);
    }
  });
});
