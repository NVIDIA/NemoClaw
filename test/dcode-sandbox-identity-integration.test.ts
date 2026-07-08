// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentDefinition } from "../src/lib/agent/defs.ts";
import { prepareSandboxCreateLaunch } from "../src/lib/onboard/sandbox-create-launch.ts";
import { makeStartScriptFixture } from "./support/dcode-start-script-fixture.ts";

const WRAPPER = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "langchain-deepagents-code",
  "dcode-wrapper.sh",
);

function replaceOrThrow(source: string, search: string, replacement: string): string {
  expect(source, `dcode-wrapper.sh fixture patch target not found: ${search}`).toContain(search);
  return source.replace(search, replacement);
}

function makeWrapperFixture(tempDir: string): { wrapperPath: string; ranMarker: string } {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const ranMarker = path.join(tempDir, "dcode-ran");
  const dcodeEnvFile = path.join(tempDir, "dcode.env");
  const configFile = path.join(tempDir, "config.toml");
  let fixture = fs.readFileSync(WRAPPER, "utf8");
  fixture = replaceOrThrow(
    fixture,
    'readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"',
    `readonly DEEPAGENTS_ENV_FILE="${dcodeEnvFile}"`,
  );
  fixture = replaceOrThrow(
    fixture,
    'readonly DEEPAGENTS_CONFIG_FILE="/sandbox/.deepagents/config.toml"',
    `readonly DEEPAGENTS_CONFIG_FILE="${configFile}"`,
  );
  fixture = replaceOrThrow(
    fixture,
    "exec /opt/venv/bin/python3 -I -m deepagents_code",
    `touch "${ranMarker}"; exit 0; : /opt/venv/bin/python3 -I -m deepagents_code`,
  );

  fs.writeFileSync(dcodeEnvFile, "", "utf8");
  fs.writeFileSync(configFile, "", "utf8");
  fs.writeFileSync(wrapperPath, fixture, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
  return { wrapperPath, ranMarker };
}

describe.skipIf(process.platform !== "linux")("Deep Agents Code sandbox identity handoff", () => {
  it("propagates the validated onboarding name through start.sh to dcode status (#6202)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-identity-handoff-"));
    try {
      const validatedSandboxName = "validated-dcode-name";
      const launch = prepareSandboxCreateLaunch({
        agent: { name: "langchain-deepagents-code" } as AgentDefinition,
        chatUiUrl: "",
        createArgs: ["--name", "rendered-create-name"],
        sandboxName: validatedSandboxName,
        env: {},
        extraPlaceholderKeys: [],
        getDashboardForwardPort: () => "0",
        hermesDashboardState: { config: null, enabled: false },
        manageDashboard: false,
        openshellShellCommand: (args) => args.join(" "),
        buildEnv: () => ({}),
      });
      const { envFile, scriptPath } = makeStartScriptFixture(tempDir);
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
      const [envCommand, ...startupArgs] = launch.sandboxStartupCommand;

      expect(envCommand).toBe("env");
      expect(startupArgs.pop()).toBe("nemoclaw-start");
      const start = spawnSync(envCommand, [...startupArgs, scriptPath, "sh", "-c", ":"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      });

      expect(start.status, start.stderr).toBe(0);
      expect(fs.readFileSync(envFile, "utf8")).toContain(
        `export NEMOCLAW_SANDBOX_NAME=${validatedSandboxName}`,
      );

      const status = spawnSync(
        "bash",
        ["-c", '. "$1"; exec bash "$2" status', "bash", envFile, wrapperPath],
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          encoding: "utf8",
        },
      );

      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain(`Sandbox:  ${validatedSandboxName}`);
      expect(status.stdout).not.toContain("rendered-create-name");
      expect(fs.existsSync(ranMarker)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
