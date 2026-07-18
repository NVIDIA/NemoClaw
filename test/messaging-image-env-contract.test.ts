// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const MESSAGING_PLAN_ENV_KEY = "NEMOCLAW_MESSAGING_PLAN_B64";

function dockerfileEnvNames(dockerfile: string): string[] {
  const directives = dockerfile.match(/^ENV[ \t]+(?:.*\\\r?\n)*.*$/gm) ?? [];
  return directives.flatMap((directive) => {
    const body = directive
      .replace(/^ENV[ \t]+/, "")
      .replace(/\\\r?\n/g, " ")
      .trim();
    const firstToken = body.split(/\s+/, 1)[0] ?? "";
    const modernNames = body
      .split(/\s+/)
      .map((token) => token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
      .filter((name): name is string => Boolean(name));
    const legacyName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(firstToken) ? [firstToken] : [];
    return firstToken.includes("=") ? modernNames : legacyName;
  });
}

describe("messaging plan final image environment contract", () => {
  it("recognizes modern and legacy Dockerfile ENV forms", () => {
    expect(
      dockerfileEnvNames(
        "ENV MODERN=value OTHER=second\nENV LEGACY value\nENV LEGACY_B64 eyJhIjoxfQ=\n",
      ),
    ).toEqual(["MODERN", "OTHER", "LEGACY", "LEGACY_B64"]);
  });

  // source-shape-contract: security -- Full serialized messaging plans must remain build-only while final agent images retain only reduced runtime metadata
  it.each([
    ["OpenClaw", "Dockerfile.base", "Dockerfile", "openclaw"],
    ["Hermes", "agents/hermes/Dockerfile.base", "agents/hermes/Dockerfile", "hermes"],
  ])("%s keeps the full plan in build processes but not final runtime environments (#5896)", (_label, basePath, finalPath, agent) => {
    const baseDockerfile = path.join(ROOT, basePath);
    const finalDockerfile = path.join(ROOT, finalPath);
    const dockerfile = fs.readFileSync(finalDockerfile, "utf-8");
    const planArgIndex = dockerfile.indexOf(`ARG ${MESSAGING_PLAN_ENV_KEY}=`);

    expect(planArgIndex).toBeGreaterThan(dockerfile.lastIndexOf("\nFROM "));
    const imageEnvNames = [baseDockerfile, finalDockerfile].flatMap((file) =>
      dockerfileEnvNames(fs.readFileSync(file, "utf-8")),
    );
    expect(imageEnvNames).not.toContain(MESSAGING_PLAN_ENV_KEY);

    for (const phase of ["runtime-setup", "agent-install", "post-agent-install"]) {
      const phaseIndex = dockerfile.indexOf(`--agent ${agent} --phase ${phase}`);
      expect(phaseIndex, `${agent} is missing the ${phase} messaging build phase`).toBeGreaterThan(
        planArgIndex,
      );
    }

    const runtimeProbe = spawnSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(String(Object.hasOwn(process.env, ${JSON.stringify(MESSAGING_PLAN_ENV_KEY)})))`,
      ],
      {
        encoding: "utf-8",
        env: Object.fromEntries(imageEnvNames.map((name) => [name, "image-config-value"])),
        timeout: 5000,
      },
    );
    expect(runtimeProbe.status, runtimeProbe.stderr).toBe(0);
    expect(runtimeProbe.stdout).toBe("false");
  });
});
