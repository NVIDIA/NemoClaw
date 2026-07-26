// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "..", "scripts", "install.sh");
const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

const stateSymlinkCases = [
  {
    label: "gateways",
    setup(root: string, controlled: string): void {
      fs.mkdirSync(root);
      fs.symlinkSync(controlled, path.join(root, "gateways"), "dir");
    },
  },
  {
    label: "selected-port",
    setup(root: string, controlled: string): void {
      fs.mkdirSync(path.join(root, "gateways"), { recursive: true });
      fs.symlinkSync(controlled, path.join(root, "gateways", "9123"), "dir");
    },
  },
];

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function sanitizedParentEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("NEMOCLAW_")),
  ) as NodeJS.ProcessEnv;
}

function runInstallerFunctions(
  home: string,
  body: string,
): { output: string; status: number | null } {
  const result = spawnSync("bash", ["-c", `source "${INSTALLER}" >/dev/null\n${body}`], {
    encoding: "utf8",
    env: {
      ...sanitizedParentEnv(),
      BASH_ENV: "",
      ENV: "",
      HOME: home,
      NEMOCLAW_GATEWAY_PORT: "9123",
    },
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

describe("install.sh gateway-scoped recovery state", () => {
  it("filters a pre-segregation shared registry to the selected gateway before backup", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-legacy-port-"));
    try {
      const registry = path.join(home, ".nemoclaw", "sandboxes.json");
      writeJson(registry, {
        defaultSandbox: "default-box",
        sandboxes: {
          "default-box": {
            name: "default-box",
            gatewayName: "nemoclaw",
            gatewayPort: 8080,
            nemoclawVersion: "v1",
          },
          "port-box": {
            name: "port-box",
            gatewayName: "nemoclaw-9123",
            gatewayPort: 9123,
          },
        },
      });

      const result = runInstallerFunctions(
        home,
        `printf 'state=%s\n' "$(nemoclaw_state_dir)"
printf 'count=%s\n' "$(registered_sandbox_count)"
printf 'ambiguous=%s\n' "$(legacy_ambiguous_sandbox_names_json '${registry}')"`,
      );

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(`state=${home}/.nemoclaw/gateways/9123`);
      expect(result.output).toContain("count=1");
      expect(result.output).toContain('ambiguous=["port-box"]');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses only the selected port's session and registry for post-install recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-selected-port-"));
    try {
      const shared = path.join(home, ".nemoclaw");
      const selected = path.join(shared, "gateways", "9123");
      writeJson(path.join(shared, "onboard-session.json"), {
        sandboxName: "wrong-default",
        agent: "openclaw",
      });
      writeJson(path.join(selected, "onboard-session.json"), {
        sandboxName: "port-box",
        agent: "hermes",
      });
      writeJson(path.join(selected, "sandboxes.json"), {
        defaultSandbox: "port-box",
        sandboxes: {
          "port-box": {
            name: "port-box",
            gatewayName: "nemoclaw-9123",
            gatewayPort: 9123,
          },
        },
      });

      const result = runInstallerFunctions(
        home,
        `printf 'sandbox=%s\n' "$(resolve_default_sandbox_name)"
printf 'agent=%s\n' "$(resolve_onboarded_agent)"`,
      );

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("sandbox=port-box");
      expect(result.output).toContain("agent=hermes");
      expect(result.output).not.toContain("wrong-default");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("normalizes a leading-zero gateway port before selecting its state root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-normalized-port-"));
    try {
      const result = runInstallerFunctions(
        home,
        `NEMOCLAW_GATEWAY_PORT=09123
printf 'state=%s\n' "$(nemoclaw_state_dir)"`,
      );

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(`state=${home}/.nemoclaw/gateways/9123`);
      expect(result.output).not.toContain("gateways/09123");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an overlong digit-only gateway port before selecting its state root (#7203)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-overlong-port-"));
    try {
      const result = runInstallerFunctions(
        home,
        `NEMOCLAW_GATEWAY_PORT=9999999999999999999999999999999999999999
nemoclaw_state_dir`,
      );

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(
        "NEMOCLAW_GATEWAY_PORT must be an integer between 1024 and 65535",
      );
      expect(result.output).not.toContain("integer expression expected");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    "08000",
    "11434",
    "18790",
  ])("rejects conflicting gateway port %s before writing selected state", (gatewayPort) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-port-conflict-"));
    try {
      const result = runInstallerFunctions(
        home,
        `NEMOCLAW_GATEWAY_PORT=${gatewayPort}
save_usage_notice_acceptance_shell "test-version"`,
      );

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain("NEMOCLAW_GATEWAY_PORT");
      expect(fs.existsSync(path.join(home, ".nemoclaw", "gateways", gatewayPort))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(
    stateSymlinkCases,
  )("rejects a symlinked $label state ancestor before writing usage acceptance", ({ setup }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-state-symlink-"));
    try {
      const root = path.join(home, ".nemoclaw");
      const controlled = path.join(home, "controlled");
      fs.mkdirSync(controlled);
      setup(root, controlled);

      const result = runInstallerFunctions(
        home,
        'save_usage_notice_acceptance_shell "test-version"',
      );

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain("Refusing symbolic link in NemoClaw state path");
      expect(fs.existsSync(path.join(controlled, "usage-notice.json"))).toBe(false);
      expect(fs.existsSync(path.join(controlled, "9123", "usage-notice.json"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs the one-time partition before a normal selected-port CLI command", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-legacy-port-"));
    try {
      const shared = path.join(home, ".nemoclaw");
      const selected = path.join(shared, "gateways", "9123");
      writeJson(path.join(shared, "sandboxes.json"), {
        defaultSandbox: "port-box",
        sandboxes: {
          "port-box": {
            name: "port-box",
            gatewayName: "nemoclaw-9123",
            gatewayPort: 9123,
          },
        },
      });
      writeJson(path.join(shared, "onboard-session.json"), {
        sandboxName: "port-box",
        status: "complete",
        metadata: { gatewayName: "nemoclaw-9123" },
      });

      const result = spawnSync(process.execPath, [CLI, "agents", "list"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          NEMOCLAW_GATEWAY_PORT: "9123",
          PATH: "",
        },
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("Migrated legacy state for gateway port 9123");
      const selectedRegistry = readJson(path.join(selected, "sandboxes.json"));
      const sharedRegistry = readJson(path.join(shared, "sandboxes.json"));
      expect(Object.keys(selectedRegistry.sandboxes as object)).toEqual(["port-box"]);
      expect(Object.keys(sharedRegistry.sandboxes as object)).toEqual([]);
      expect(fs.existsSync(path.join(selected, "onboard-session.json"))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the gateway port as the uninstall selector and rejects a mismatched gateway flag", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-port-selector-"));
    try {
      const result = spawnSync(
        process.execPath,
        [CLI, "internal", "uninstall", "run-plan", "--yes", "--gateway", "nemoclaw-9000"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            NEMOCLAW_GATEWAY_PORT: "9123",
            PATH: "",
          },
        },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("NEMOCLAW_GATEWAY_PORT=9123 selects 'nemoclaw-9123'");
      expect(fs.existsSync(path.join(home, ".nemoclaw"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
