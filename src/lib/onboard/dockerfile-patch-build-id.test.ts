// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type DockerfileBuildIdPolicy, patchStagedDockerfile } from "./dockerfile-patch";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const tmpRoots: string[] = [];

function dockerfileWith(content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-id-test-"));
  tmpRoots.push(root);
  const dockerfile = path.join(root, "Dockerfile");
  fs.writeFileSync(dockerfile, content, "utf8");
  return dockerfile;
}

function patchBuildId(
  dockerfile: string,
  buildId: string,
  buildIdPolicy?: DockerfileBuildIdPolicy,
): void {
  patchStagedDockerfile(
    dockerfile,
    "gpt-5.4",
    "http://127.0.0.1:19999",
    buildId,
    "openai-api",
    null,
    null,
    null,
    false,
    null,
    [],
    buildIdPolicy ? { buildIdPolicy } : undefined,
  );
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Dockerfile build-id cache policy (#4682)", () => {
  it("rewrites custom Dockerfiles even when an invoked script is the indirect consumer", () => {
    const dockerfile = dockerfileWith(
      [
        "FROM scratch",
        "ARG NEMOCLAW_BUILD_ID=default",
        "COPY generate-token.js /tmp/generate-token.js",
        "RUN node /tmp/generate-token.js",
        '# Literal documentation: "NEMOCLAW_BUILD_ID".',
      ].join("\n"),
    );

    patchBuildId(dockerfile, "custom-per-run-id");

    expect(fs.readFileSync(dockerfile, "utf8")).toMatch(
      /^ARG NEMOCLAW_BUILD_ID=custom-per-run-id$/m,
    );
  });

  it.each([
    ["OpenClaw", path.join(REPO_ROOT, "Dockerfile")],
    ["Hermes", path.join(REPO_ROOT, "agents", "hermes", "Dockerfile")],
  ])("keeps the managed stock %s context byte-identical across per-run IDs", (agentName, stockDockerfile) => {
    expect(fs.existsSync(stockDockerfile), `missing managed ${agentName} Dockerfile`).toBe(true);
    const stockSource = fs.readFileSync(stockDockerfile, "utf8");
    const buildIdLines = stockSource
      .split("\n")
      .filter((line) => line.includes("NEMOCLAW_BUILD_ID") && !line.trimStart().startsWith("#"));
    expect(buildIdLines, `${agentName} must not consume the preserved build ID`).toEqual([
      "ARG NEMOCLAW_BUILD_ID=default",
    ]);

    const firstBuild = dockerfileWith(stockSource);
    const secondBuild = dockerfileWith(stockSource);
    patchBuildId(firstBuild, "first-per-run-id", "preserve");
    patchBuildId(secondBuild, "second-per-run-id", "preserve");

    expect(fs.readFileSync(firstBuild, "utf8")).toBe(fs.readFileSync(secondBuild, "utf8"));
    expect(fs.readFileSync(firstBuild, "utf8")).toMatch(/^ARG NEMOCLAW_BUILD_ID=default$/m);
  });

  it("sanitizes the custom per-run build ID", () => {
    const dockerfile = dockerfileWith("ARG NEMOCLAW_BUILD_ID=default\n");

    patchBuildId(dockerfile, "build-safe\nRUN touch /tmp/build-id-injection");

    const patched = fs.readFileSync(dockerfile, "utf8");
    expect(patched).toContain("ARG NEMOCLAW_BUILD_ID=build-safeRUN touch /tmp/build-id-injection");
    expect(patched).not.toMatch(/\nRUN touch \/tmp\/build-id-injection/);
  });
});
