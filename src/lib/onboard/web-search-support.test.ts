// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { agentSupportsWebSearch } from "./web-search-support";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-web-search-support-test-"));
  tmpRoots.push(dir);
  return dir;
}

function writeDockerfile(dir: string, content: string, fileName = "Dockerfile"): string {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agentSupportsWebSearch", () => {
  it("returns false for Hermes regardless of Dockerfile support", () => {
    const root = tmpRoot();
    const dockerfile = writeDockerfile(root, "ARG NEMOCLAW_WEB_SEARCH_ENABLED=1\n");

    expect(agentSupportsWebSearch({ name: "hermes", dockerfilePath: dockerfile }, null, root)).toBe(
      false,
    );
  });

  it("uses an override Dockerfile path first", () => {
    const root = tmpRoot();
    writeDockerfile(root, "FROM scratch\n");
    const override = writeDockerfile(root, "ARG NEMOCLAW_WEB_SEARCH_ENABLED=1\n", "Customfile");

    expect(agentSupportsWebSearch({ name: "openclaw" }, override, root)).toBe(true);
  });

  it("falls back to the agent Dockerfile and then the root Dockerfile", () => {
    const root = tmpRoot();
    const agentDockerfile = writeDockerfile(root, "FROM scratch\n", "Agentfile");
    writeDockerfile(root, "ARG NEMOCLAW_WEB_SEARCH_ENABLED=1\n");

    expect(agentSupportsWebSearch({ name: "openclaw", dockerfilePath: agentDockerfile }, null, root)).toBe(
      false,
    );
    const missingDockerfile = path.join(root, "missing-dockerfile");
    expect(
      agentSupportsWebSearch({ name: "openclaw", dockerfilePath: missingDockerfile }, null, root),
    ).toBe(true);
  });

  it("returns false when no candidate declares the web-search ARG", () => {
    const root = tmpRoot();
    writeDockerfile(root, "FROM scratch\n");

    expect(agentSupportsWebSearch({ name: "openclaw" }, null, root)).toBe(false);
  });
});
