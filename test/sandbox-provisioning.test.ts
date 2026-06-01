// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression guards for sandbox image provisioning.
//
// Verifies that the image-build sources (Dockerfile and Dockerfile.base)
// preserve the mutable-by-default config layout (#2227) and the gateway
// auth token externalization (#2378).
//
// These guards execute the relevant Dockerfile/startup snippets in temporary
// fixtures where practical, so coverage follows behavior rather than source
// text shape.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");
const DOCKERFILE_SANDBOX = path.join(ROOT, "test", "Dockerfile.sandbox");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");
const HERMES_DOCKERFILE_BASE = path.join(ROOT, "agents", "hermes", "Dockerfile.base");
const HERMES_POLICY = path.join(ROOT, "agents", "hermes", "policy-additions.yaml");
const HERMES_POLICY_PERMISSIVE = path.join(ROOT, "agents", "hermes", "policy-permissive.yaml");
const HERMES_START = path.join(ROOT, "agents", "hermes", "start.sh");

function dockerRunCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile block between ${startMarker} and ${endMarker}`);
  }
  const runIndex = dockerfile.indexOf("RUN ", start);
  if (runIndex === -1 || runIndex > end) {
    throw new Error(`Expected RUN instruction after ${startMarker}`);
  }
  const runLines: string[] = [];
  for (const line of dockerfile.slice(runIndex, end).split("\n")) {
    runLines.push(line);
    if (!line.trimEnd().endsWith("\\")) {
      break;
    }
  }
  const lastLine = runLines[runLines.length - 1]?.trimEnd() ?? "";
  if (lastLine.endsWith("\\")) {
    throw new Error(`Expected complete RUN instruction before ${endMarker}`);
  }
  return runLines
    .join("\n")
    .trim()
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}

function dockerHealthCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker?: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = endMarker ? dockerfile.indexOf(endMarker, start) : dockerfile.length;
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile health check after ${startMarker}`);
  }
  const healthOffset = dockerfile.slice(start, end).search(/^HEALTHCHECK\b/m);
  const healthIndex = healthOffset === -1 ? -1 : start + healthOffset;
  if (healthIndex === -1) {
    throw new Error(`Expected HEALTHCHECK instruction after ${startMarker}`);
  }
  const healthLines: string[] = [];
  for (const line of dockerfile.slice(healthIndex, end).split("\n")) {
    healthLines.push(line);
    if (!line.trimEnd().endsWith("\\")) {
      break;
    }
  }
  const lastLine = healthLines[healthLines.length - 1]?.trimEnd() ?? "";
  if (lastLine.endsWith("\\")) {
    throw new Error(`Expected complete HEALTHCHECK instruction after ${startMarker}`);
  }
  const instruction = healthLines.join("\n").trim().replace(/\\\n/g, " ");
  const command = instruction.match(/(?:^|\s)CMD\s+([\s\S]+)$/)?.[1];
  if (!command) {
    throw new Error(`Expected shell-form HEALTHCHECK CMD after ${startMarker}`);
  }
  return command.trim();
}

function runDockerShell(command: string, sandboxRoot: string) {
  const logPath = path.join(sandboxRoot, "calls.log");
  fs.rmSync(logPath, { force: true });
  const rewritten = command.replaceAll("/sandbox", sandboxRoot);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(logPath)}`,
    'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }',
    rewritten,
  ].join("\n");
  const scriptPath = path.join(sandboxRoot, "run-docker-block.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { result, calls };
}

function runLoggedDockerShell(
  command: string,
  tmp: string,
  functionDefs: string[] = [],
  env: Record<string, string | undefined> = {},
) {
  const logPath = path.join(tmp, "calls.log");
  fs.rmSync(logPath, { force: true });
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(logPath)}`,
    ...functionDefs,
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run-docker-block.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete childEnv[key];
    } else {
      childEnv[key] = value;
    }
  }
  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    env: childEnv,
    timeout: 5000,
  });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { result, calls };
}

function runOpenclawRepairLayoutCase(legacy: boolean) {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const cleanupBlock = dockerRunCommandBetween(
    dockerfile,
    "# Flatten stale published base images",
    "# Stale-base fallback for the gateway-in-sandbox-group setup",
  );
  const permissionBlock = dockerRunCommandBetween(
    dockerfile,
    "# Keep the image readable to the root entrypoint",
    "# System-wide proxy hooks",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-repair-"));
  const sandboxRoot = path.join(tmp, "sandbox");
  const openclawDir = path.join(sandboxRoot, ".openclaw");
  const dataDir = path.join(sandboxRoot, ".openclaw-data");
  const marker = path.join(tmp, "legacy-marker");
  const rootNpm = path.join(tmp, "root-npm");
  const sandboxNpm = path.join(sandboxRoot, ".npm");
  const relativePath = (entry: string) => path.relative(openclawDir, entry) || ".";
  const listRelativeEntries = (dir: string, kind: "directory" | "file"): string[] => {
    const entries: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (kind === "directory") {
          entries.push(relativePath(entryPath));
        }
        entries.push(...listRelativeEntries(entryPath, kind));
      } else if (kind === "file" && entry.isFile()) {
        entries.push(relativePath(entryPath));
      }
    }
    return entries.sort();
  };
  const rewrite = (command: string) =>
    command
      .replaceAll("/sandbox/.openclaw-data", "__NEMOCLAW_TEST_OPENCLAW_DATA__")
      .replaceAll("/sandbox/.openclaw", "__NEMOCLAW_TEST_OPENCLAW_DIR__")
      .replaceAll("/sandbox/.npm", "__NEMOCLAW_TEST_SANDBOX_NPM__")
      .replaceAll("/tmp/nemoclaw-legacy-openclaw-layout", marker)
      .replaceAll("/root/.npm", rootNpm)
      .replaceAll("__NEMOCLAW_TEST_OPENCLAW_DATA__", dataDir)
      .replaceAll("__NEMOCLAW_TEST_OPENCLAW_DIR__", openclawDir)
      .replaceAll("__NEMOCLAW_TEST_SANDBOX_NPM__", sandboxNpm);
  const functionDefs = [
    'install() { printf "install %s\\n" "$*" >> "$call_log"; local target="${*: -1}"; mkdir -p "$target"; }',
    'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }',
    'chmod() { printf "chmod %s\\n" "$*" >> "$call_log"; command chmod "$@"; }',
    'find() { printf "find %s\\n" "$*" >> "$call_log"; command find "$@"; }',
  ];

  fs.mkdirSync(openclawDir, { recursive: true });
  if (legacy) {
    fs.mkdirSync(path.join(dataDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "extensions", "legacy-plugin.json"), "{}\n");
  }

  const cleanup = runLoggedDockerShell(rewrite(cleanupBlock), tmp, functionDefs);
  const markerExistsAfterCleanup = fs.existsSync(marker);
  const dirsAfterCleanup = [".", ...listRelativeEntries(openclawDir, "directory")];
  const filesAfterCleanup = listRelativeEntries(openclawDir, "file");
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
  const permission = runLoggedDockerShell(rewrite(permissionBlock), tmp, functionDefs);
  const markerExistsAfterPermission = fs.existsSync(marker);

  try {
    return {
      cleanup,
      dirsAfterCleanup,
      filesAfterCleanup,
      markerExistsAfterCleanup,
      markerExistsAfterPermission,
      openclawDir,
      permission,
      pluginRuntimeDeps: path.join(openclawDir, "plugin-runtime-deps"),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("sandbox provisioning: image health checks (#1430)", () => {
  it.each([
    ["default dashboard URL", {}, "http://127.0.0.1:18789/health"],
    [
      "CHAT_UI_URL with scheme",
      { CHAT_UI_URL: "http://127.0.0.1:19000" },
      "http://127.0.0.1:19000/health",
    ],
    [
      "CHAT_UI_URL without scheme",
      { CHAT_UI_URL: "remote-host:19111" },
      "http://127.0.0.1:19111/health",
    ],
    [
      "OPENCLAW_GATEWAY_PORT",
      { CHAT_UI_URL: "http://127.0.0.1:19000", OPENCLAW_GATEWAY_PORT: "19333" },
      "http://127.0.0.1:19333/health",
    ],
    [
      "NEMOCLAW_DASHBOARD_PORT override",
      {
        CHAT_UI_URL: "http://127.0.0.1:19000",
        NEMOCLAW_DASHBOARD_PORT: "19222",
        OPENCLAW_GATEWAY_PORT: "19333",
      },
      "http://127.0.0.1:19222/health",
    ],
  ])("routes production gateway probe through %s", (_label, env, expectedUrl) => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const command = dockerHealthCommandBetween(
      dockerfile,
      "# Health check: poll the gateway's /health endpoint",
      "# Entrypoint runs as root",
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-health-probe-"));

    try {
      const probe = runLoggedDockerShell(
        command,
        tmp,
        ['curl() { printf "%s\\n" "$*" >> "$call_log"; }'],
        {
          NEMOCLAW_DASHBOARD_PORT: undefined,
          OPENCLAW_GATEWAY_PORT: undefined,
          CHAT_UI_URL: undefined,
          ...env,
        },
      );

      expect(probe.result.status).toBe(0);
      expect(probe.calls).toContain("-sf");
      expect(probe.calls).toContain(expectedUrl);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // #3975: on runtime shapes where the dashboard port lives in a different
  // network namespace (DGX Spark / OpenShell-managed forwarding), the
  // in-container curl probe sees "connection refused" while the actual
  // delivery chain is fine. The healthcheck must not contradict that by
  // failing the container outright — it falls back to verifying that the
  // OpenClaw gateway process is still alive in this container.
  describe("falls back to local liveness when the in-container dashboard port has no listener (#3975)", () => {
    function runProductionHealthProbe({
      curlExit,
      pgrepExit,
      gatewayLog = "gateway log line\n",
      // The /tmp/nemoclaw-gateway-local marker is dropped by nemoclaw-start
      // only when this container runs the in-container OpenClaw gateway. Most
      // probes here exercise that path, so default it to present.
      gatewayLocalMarker = true,
    }: {
      curlExit: number;
      pgrepExit: number;
      gatewayLog?: string;
      gatewayLocalMarker?: boolean;
    }) {
      const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-health-fallback-"));
      const logPath = path.join(tmp, "gateway.log");
      const markerPath = path.join(tmp, "nemoclaw-gateway-local");
      const rawCommand = dockerHealthCommandBetween(
        dockerfile,
        "# Health check: poll the gateway's /health endpoint",
        "# Entrypoint runs as root",
      );
      const command = rawCommand
        .replaceAll("/tmp/gateway.log", logPath)
        .replaceAll("/tmp/nemoclaw-gateway-local", markerPath);

      if (gatewayLog !== "") {
        fs.writeFileSync(logPath, gatewayLog);
      }
      if (gatewayLocalMarker) {
        fs.writeFileSync(markerPath, "");
      }

      try {
        const probe = runLoggedDockerShell(command, tmp, [
          `curl() { printf "curl %s\\n" "$*" >> "$call_log"; return ${curlExit}; }`,
          `pgrep() { printf "pgrep %s\\n" "$*" >> "$call_log"; return ${pgrepExit}; }`,
        ]);
        return probe;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    it("reports healthy when in-container curl works (Docker-driver / standalone)", () => {
      const probe = runProductionHealthProbe({ curlExit: 0, pgrepExit: 1, gatewayLog: "" });
      expect(probe.result.status).toBe(0);
      expect(probe.calls).toContain("curl");
      // Fast path: should not consult pgrep at all.
      expect(probe.calls).not.toContain("pgrep");
    });

    it("reports healthy when curl gets connection refused but openclaw is alive and started (DGX Spark / OpenShell-managed)", () => {
      const probe = runProductionHealthProbe({ curlExit: 7, pgrepExit: 0 });
      expect(probe.result.status).toBe(0);
      expect(probe.calls).toContain("curl");
      // --ignore-ancestors prevents pgrep from self-matching the
      // healthcheck shell whose argv contains the gateway pattern.
      // The [ -] class matches both `openclaw gateway` (launcher) and
      // `openclaw-gateway` (re-execed binary).
      expect(probe.calls).toContain("pgrep --ignore-ancestors -f openclaw[ -]gateway");
    });

    it("reports unhealthy when curl times out (wedged HTTP server, not namespace mismatch)", () => {
      // A connect timeout means a listener exists but is not responding,
      // e.g. a wedged HTTP server. We deliberately do not fall back to the
      // process check there — Docker should restart the container.
      const probe = runProductionHealthProbe({ curlExit: 28, pgrepExit: 0 });
      expect(probe.result.status).toBe(1);
      expect(probe.calls).not.toContain("pgrep");
    });

    it("reports unhealthy when curl gets connection refused and openclaw is not running", () => {
      const probe = runProductionHealthProbe({ curlExit: 7, pgrepExit: 1 });
      expect(probe.result.status).toBe(1);
    });

    it("reports unhealthy when curl gets connection refused and the gateway log was never written (openclaw never started)", () => {
      const probe = runProductionHealthProbe({ curlExit: 7, pgrepExit: 0, gatewayLog: "" });
      expect(probe.result.status).toBe(1);
    });

    it("does not fall back when curl reports an HTTP error (gateway answered with failure)", () => {
      const probe = runProductionHealthProbe({ curlExit: 22, pgrepExit: 0 });
      expect(probe.result.status).toBe(1);
      // HTTP errors from the in-container probe should bypass the fallback;
      // a 4xx/5xx means the gateway is reachable and unhappy, not a
      // namespace mismatch — so pgrep should not run.
      expect(probe.calls).not.toContain("pgrep");
    });

    // #4503: OpenShell docker-driver sandboxes deliver the OpenClaw gateway
    // outside this container's network namespace (it runs on the host), so
    // nemoclaw-start never drops the /tmp/nemoclaw-gateway-local marker. The
    // in-container curl gets connection-refused and the in-container pgrep
    // finds no gateway process, yet `nemoclaw status`/OpenShell report Ready.
    // Without the marker the healthcheck must NOT mark the container unhealthy
    // off a signal it cannot observe.
    describe("does not falsely fail when the gateway runs outside this container's namespace (#4503)", () => {
      it("reports healthy on curl exit 7 with no in-container gateway process when the marker is absent", () => {
        const probe = runProductionHealthProbe({
          curlExit: 7,
          pgrepExit: 1,
          gatewayLog: "gateway log line\n",
          gatewayLocalMarker: false,
        });
        expect(probe.result.status).toBe(0);
        // The process-name fallback is meaningless out-of-namespace, so the
        // healthcheck must short-circuit before consulting pgrep.
        expect(probe.calls).not.toContain("pgrep");
      });

      it("reports healthy on curl exit 7 even when no gateway log exists and the marker is absent", () => {
        const probe = runProductionHealthProbe({
          curlExit: 7,
          pgrepExit: 1,
          gatewayLog: "",
          gatewayLocalMarker: false,
        });
        expect(probe.result.status).toBe(0);
        expect(probe.calls).not.toContain("pgrep");
      });

      it("still reports unhealthy on a wedged listener (curl exit 28) regardless of the marker", () => {
        const probe = runProductionHealthProbe({
          curlExit: 28,
          pgrepExit: 0,
          gatewayLocalMarker: false,
        });
        expect(probe.result.status).toBe(1);
        expect(probe.calls).not.toContain("pgrep");
      });
    });
  });

  it.each([
    [
      "base image",
      DOCKERFILE_BASE,
      "# Baseline health check.",
      undefined,
    ],
    [
      "test image",
      DOCKERFILE_SANDBOX,
      "# Test image: no long-running service",
      "ENTRYPOINT",
    ],
  ])("keeps %s non-service probe runtime-only", (_label, imagePath, startMarker, endMarker) => {
    const imageDefinition = fs.readFileSync(imagePath, "utf-8");
    const command = dockerHealthCommandBetween(imageDefinition, startMarker, endMarker);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-probe-"));

    try {
      const probe = runLoggedDockerShell(command, tmp, [
        'curl() { printf "%s\\n" "$*" >> "$call_log"; return 42; }',
      ]);

      expect(probe.result.status).toBe(0);
      expect(probe.calls).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("sandbox provisioning: unified .openclaw layout (#2227)", () => {
  it("uses targeted permission repair unless legacy migration ran", () => {
    const modern = runOpenclawRepairLayoutCase(false);
    expect(modern.cleanup.result.status).toBe(0);
    expect(modern.permission.result.status).toBe(0);
    expect(modern.markerExistsAfterCleanup).toBe(false);
    expect(modern.markerExistsAfterPermission).toBe(false);
    expect(modern.dirsAfterCleanup).toEqual([
      ".",
      "agents",
      "agents/main",
      "agents/main/agent",
      "canvas",
      "credentials",
      "cron",
      "devices",
      "extensions",
      "flows",
      "hooks",
      "identity",
      "logs",
      "media",
      "memory",
      "plugin-runtime-deps",
      "sandbox",
      "skills",
      "telegram",
      "wechat",
      "workspace",
    ]);
    expect(modern.filesAfterCleanup).toEqual(["exec-approvals.json", "update-check.json"]);
    expect(modern.cleanup.calls.split("\n").filter(Boolean)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^find /)]),
    );
    expect(modern.permission.calls.split("\n").filter(Boolean)).toEqual([
      `chown sandbox:sandbox ${modern.openclawDir} ${path.join(
        modern.openclawDir,
        "openclaw.json",
      )} ${modern.pluginRuntimeDeps}`,
      `chmod 2770 ${modern.openclawDir} ${modern.pluginRuntimeDeps}`,
      `chmod 660 ${path.join(modern.openclawDir, "openclaw.json")}`,
    ]);

    const legacy = runOpenclawRepairLayoutCase(true);
    expect(legacy.cleanup.result.status).toBe(0);
    expect(legacy.permission.result.status).toBe(0);
    expect(legacy.markerExistsAfterCleanup).toBe(true);
    expect(legacy.markerExistsAfterPermission).toBe(false);
    expect(legacy.cleanup.calls.split("\n").filter(Boolean)).toEqual(
      expect.arrayContaining([`find ${legacy.openclawDir} -type l -print`]),
    );
    expect(legacy.permission.calls.split("\n").filter(Boolean)).toEqual(
      expect.arrayContaining([
        `chown -R sandbox:sandbox ${legacy.openclawDir}`,
        `chmod -R g+rwX,o-rwx ${legacy.openclawDir}`,
        `find ${legacy.openclawDir} -type d -exec chmod g+s {} +`,
      ]),
    );
  });

  it("provisions unified mutable .openclaw layout and clean trusted rc files", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-layout-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    fs.mkdirSync(sandboxRoot, { recursive: true });

    try {
      const layout = runDockerShell(
        dockerRunCommandBetween(
          dockerfile,
          "# Create .openclaw with all state subdirs directly",
          "# Pre-create shell init files",
        ),
        sandboxRoot,
      );
      expect(layout.result.status).toBe(0);
      const openclawDir = path.join(sandboxRoot, ".openclaw");
      expect(fs.statSync(openclawDir).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(openclawDir, "exec-approvals.json")).isFile()).toBe(true);
      expect(fs.statSync(path.join(openclawDir, "update-check.json")).isFile()).toBe(true);
      for (const dir of ["credentials", "devices", "identity", "logs", "telegram"]) {
        const stateDir = path.join(openclawDir, dir);
        expect(fs.statSync(stateDir).isDirectory()).toBe(true);
        expect(fs.lstatSync(stateDir).isSymbolicLink()).toBe(false);
        expect(fs.statSync(stateDir).mode & 0o020).toBe(0o020);
        expect(fs.statSync(stateDir).mode & 0o2000).toBe(0o2000);
      }
      expect(fs.existsSync(path.join(sandboxRoot, ".openclaw-data"))).toBe(false);
      expect(fs.lstatSync(path.join(openclawDir, "exec-approvals.json")).isSymbolicLink()).toBe(
        false,
      );
      expect(layout.calls).toContain(`chown -R sandbox:sandbox ${openclawDir}`);

      const rc = runDockerShell(
        dockerRunCommandBetween(
          dockerfile,
          "# Pre-create shell init files for the sandbox user.",
          "# System-wide proxy hooks.",
        ),
        sandboxRoot,
      );
      expect(rc.result.status).toBe(0);
      for (const rcName of [".bashrc", ".profile"]) {
        const rcPath = path.join(sandboxRoot, rcName);
        const content = fs.readFileSync(rcPath, "utf-8");
        expect(content.toLowerCase()).not.toContain("proxy");
        expect(content).not.toContain("/tmp/nemoclaw-proxy-env.sh");
        expect((fs.statSync(rcPath).mode & 0o777).toString(8)).toBe("444");
      }
      expect(rc.calls).toContain(
        `chown root:root ${path.join(sandboxRoot, ".bashrc")} ${path.join(sandboxRoot, ".profile")}`,
      );
      expect(rc.calls).not.toContain("sandbox:sandbox");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("provisions system-wide runtime proxy hooks", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-system-proxy-"));
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const runtimeEnvShim = "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh";

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      fs.writeFileSync(bashrc, "# existing bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide proxy hooks",
        "# Install OpenClaw CLI + PyYAML",
      )
        .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const { result } = runLoggedDockerShell(command, tmp);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(profileHook, "utf-8").split(runtimeEnvShim).length - 1).toBe(1);
      expect((fs.statSync(profileHook).mode & 0o777).toString(8)).toBe("444");

      const bashrcContent = fs.readFileSync(bashrc, "utf-8");
      expect(bashrcContent.split(runtimeEnvShim).length - 1).toBe(1);
      expect(bashrcContent).toContain("# existing bashrc");
      expect((fs.statSync(bashrc).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("sandbox provisioning: base runtime tools", () => {
  it("base apt layer requests procps, e2fsprogs, and the SFTP server", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-apt-"));
    const lists = path.join(tmp, "apt-lists");
    const fakePy3 = path.join(tmp, "usr-bin", "python3");
    const fakePyLink = path.join(tmp, "usr-local-bin", "python");
    fs.mkdirSync(lists);
    fs.mkdirSync(path.dirname(fakePy3), { recursive: true });
    fs.mkdirSync(path.dirname(fakePyLink), { recursive: true });
    fs.writeFileSync(fakePy3, "#!/bin/sh\n", { mode: 0o755 });
    const command = dockerRunCommandBetween(
      dockerfile,
      "RUN apt-get update",
      "# gosu for privilege separation",
    )
      .replaceAll("/var/lib/apt/lists", lists)
      .replaceAll("/usr/local/bin/python", fakePyLink)
      .replaceAll("/usr/bin/python3", fakePy3);

    try {
      const { result, calls } = runLoggedDockerShell(command, tmp, [
        'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
      ]);
      expect(result.status).toBe(0);
      expect(calls).toContain("apt-get update");
      expect(calls).toContain("procps=2:4.0.4-9");
      expect(calls).toContain("e2fsprogs=1.47.2-3+b11");
      expect(calls).toContain("openssh-sftp-server=1:10.0p1-7+deb13u4");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("symlinks bare `python` to python3 so agent tool calls don't fail with command-not-found (#1452)", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-pysymlink-"));
    const lists = path.join(tmp, "apt-lists");
    const fakePy3 = path.join(tmp, "usr-bin", "python3");
    const fakePyLink = path.join(tmp, "usr-local-bin", "python");
    fs.mkdirSync(lists, { recursive: true });
    fs.mkdirSync(path.dirname(fakePy3), { recursive: true });
    fs.mkdirSync(path.dirname(fakePyLink), { recursive: true });
    fs.writeFileSync(fakePy3, "#!/bin/sh\necho 3.13\n", { mode: 0o755 });

    const command = dockerRunCommandBetween(
      dockerfile,
      "RUN apt-get update",
      "# gosu for privilege separation",
    )
      .replaceAll("/var/lib/apt/lists", lists)
      .replaceAll("/usr/local/bin/python", fakePyLink)
      .replaceAll("/usr/bin/python3", fakePy3);

    try {
      const { result } = runLoggedDockerShell(command, tmp, [
        'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
      ]);
      expect(result.status).toBe(0);
      expect(fs.lstatSync(fakePyLink).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(fakePyLink)).toBe(fakePy3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runtime hardening installs procps and e2fsprogs when a stale base lacks ps and chattr", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-procps-"));
    const log = path.join(tmp, "calls.log");
    const marker = path.join(tmp, "ps-installed");
    const chattrMarker = path.join(tmp, "chattr-installed");
    const lists = path.join(tmp, "apt-lists");
    fs.mkdirSync(lists);
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Harden: remove unnecessary build tools",
      "# Copy built plugin and blueprint",
    ).replaceAll("/var/lib/apt/lists", lists);
    const script = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `call_log=${JSON.stringify(log)}`,
      `ps_marker=${JSON.stringify(marker)}`,
      `chattr_marker=${JSON.stringify(chattrMarker)}`,
      'apt-mark() { printf "apt-mark %s\\n" "$*" >> "$call_log"; }',
      'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; if [[ "$*" == *"install"* && "$*" == *"procps=2:4.0.4-9"* ]]; then touch "$ps_marker"; fi; if [[ "$*" == *"install"* && "$*" == *"e2fsprogs=1.47.2-3+b11"* ]]; then touch "$chattr_marker"; fi; }',
      'command() { if [ "${1:-}" = "-v" ] && [ "${2:-}" = "ps" ]; then [ -f "$ps_marker" ]; elif [ "${1:-}" = "-v" ] && [ "${2:-}" = "chattr" ]; then [ -f "$chattr_marker" ]; else builtin command "$@"; fi; }',
      'ps() { [ -f "$ps_marker" ] || return 127; printf "procps test version\\n"; }',
      command,
    ].join("\n");
    const scriptPath = path.join(tmp, "run.sh");
    try {
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      const calls = fs.readFileSync(log, "utf-8");
      expect(calls).toContain("apt-mark manual procps e2fsprogs");
      expect(calls).toContain("apt-get autoremove --purge -y");
      expect(calls).toContain("apt-get update");
      expect(calls).toContain(
        "apt-get install -y --no-install-recommends procps=2:4.0.4-9",
      );
      expect(calls).toContain("apt-get install -y --no-install-recommends e2fsprogs=1.47.2-3+b11");
      expect(result.stdout).toContain("procps test version");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("sandbox provisioning: copied OpenClaw helper permissions (#2861)", () => {
  it("normalizes copied blueprint permissions before non-root config generation", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-mode-"));
    const blueprintRoot = path.join(tmp, "opt", "nemoclaw-blueprint");
    const nemoclawRoot = path.join(tmp, "opt", "nemoclaw");
    const manifestDir = path.join(blueprintRoot, "model-specific-setup", "openclaw");
    const manifestPath = path.join(manifestDir, "kimi-k2.6-managed-inference.json");
    const pluginPackageJson = path.join(nemoclawRoot, "package.json");

    try {
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(manifestPath, "{}\n", { mode: 0o600 });
      fs.chmodSync(path.join(blueprintRoot, "model-specific-setup"), 0o700);
      fs.chmodSync(manifestDir, 0o700);
      fs.chmodSync(manifestPath, 0o600);
      fs.mkdirSync(nemoclawRoot, { recursive: true });
      fs.writeFileSync(pluginPackageJson, "{}\n", { mode: 0o400 });
      fs.chmodSync(nemoclawRoot, 0o700);
      fs.chmodSync(pluginPackageJson, 0o400);

      const command = dockerRunCommandBetween(
        dockerfile,
        "# Copy built plugin and blueprint",
        "# Install runtime dependencies only",
      )
        .replaceAll("/opt/nemoclaw-blueprint", "__BLUEPRINT__")
        .replaceAll("/opt/nemoclaw", nemoclawRoot)
        .replaceAll("__BLUEPRINT__", blueprintRoot);
      const { result } = runLoggedDockerShell(command, tmp);

      expect(result.status, result.stderr).toBe(0);
      expect((fs.statSync(manifestDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(manifestPath).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(nemoclawRoot).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(pluginPackageJson).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes the config generator mode after Docker COPY preserves a restrictive source mode", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-helper-mode-"));
    const localBin = path.join(tmp, "usr", "local", "bin");
    const localLib = path.join(tmp, "usr", "local", "lib", "nemoclaw");
    const localShare = path.join(tmp, "usr", "local", "share", "nemoclaw");
    const pluginDir = path.join(localShare, "openclaw-plugins", "kimi-inference-compat");
    const pluginFile = path.join(pluginDir, "index.js");
    const nestedPluginDir = path.join(pluginDir, "lib");
    const nestedPluginFile = path.join(nestedPluginDir, "helper.js");
    const files = [
      path.join(localBin, "nemoclaw-start"),
      path.join(localBin, "nemoclaw-codex-acp"),
      path.join(localLib, "sandbox-init.sh"),
      path.join(localLib, "generate-openclaw-config.mts"),
      path.join(localLib, "openclaw-build-messaging-plugins.py"),
      path.join(localLib, "seed-wechat-accounts.py"),
      path.join(localLib, "ws-proxy-fix.js"),
      pluginFile,
      nestedPluginFile,
    ];

    try {
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(localLib, { recursive: true });
      fs.mkdirSync(nestedPluginDir, { recursive: true });
      for (const file of files) {
        fs.writeFileSync(file, "# fixture\n", { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      }

      const command = dockerRunCommandBetween(
        dockerfile,
        "# Copy startup script and shared sandbox initialisation library",
        "# Build args for config that varies per deployment.",
      )
        .replaceAll("/usr/local/bin", localBin)
        .replaceAll("/usr/local/lib/nemoclaw", localLib)
        .replaceAll("/usr/local/share/nemoclaw", localShare);
      const { result } = runLoggedDockerShell(command, tmp);

      expect(result.status, result.stderr).toBe(0);
      const generatorMode = (
        fs.statSync(path.join(localLib, "generate-openclaw-config.mts")).mode & 0o777
      ).toString(8);
      const messagingPluginMode = (
        fs.statSync(path.join(localLib, "openclaw-build-messaging-plugins.py")).mode & 0o777
      ).toString(8);
      const pluginDirMode = (fs.statSync(pluginDir).mode & 0o777).toString(8);
      const pluginMode = (fs.statSync(pluginFile).mode & 0o777).toString(8);
      const nestedPluginDirMode = (fs.statSync(nestedPluginDir).mode & 0o777).toString(8);
      const nestedPluginMode = (fs.statSync(nestedPluginFile).mode & 0o777).toString(8);
      expect(generatorMode).toBe("755");
      expect(messagingPluginMode).toBe("755");
      expect(pluginDirMode).toBe("755");
      expect(pluginMode).toBe("644");
      expect(nestedPluginDirMode).toBe("755");
      expect(nestedPluginMode).toBe("644");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Hermes sandbox provisioning", () => {
  function runHermesPathValidation(pathEntriesBeforeManifest: string[] = []) {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-path-"));
    const manifestHermes = path.join(tmp, "usr", "local", "bin", "hermes");
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Keep the final image contract explicit",
      "# Harden: remove unnecessary build tools",
    ).replaceAll("/usr/local/bin/hermes", manifestHermes);
    const scriptPath = path.join(tmp, "run.sh");
    try {
      fs.mkdirSync(path.dirname(manifestHermes), { recursive: true });
      fs.writeFileSync(
        manifestHermes,
        "#!/usr/bin/env bash\nprintf 'hermes manifest version\\n'\n",
        { mode: 0o755 },
      );
      fs.writeFileSync(
        scriptPath,
        ["#!/usr/bin/env bash", "set -euo pipefail", command].join("\n"),
        {
          mode: 0o700,
        },
      );
      return spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: [
            ...pathEntriesBeforeManifest,
            path.dirname(manifestHermes),
            "/usr/bin",
            "/bin",
          ].join(":"),
        },
        timeout: 5000,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  function runHermesUserSetupBlock() {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-users-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Create sandbox user (matches OpenShell convention)",
      "# Create .hermes with mutable integration dirs",
    ).replaceAll("/sandbox", sandboxRoot);
    const result = runLoggedDockerShell(command, tmp, [
      'groupadd() { printf "groupadd %s\\n" "$*" >> "$call_log"; }',
      'useradd() { printf "useradd %s\\n" "$*" >> "$call_log"; }',
      'usermod() { printf "usermod %s\\n" "$*" >> "$call_log"; }',
      'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }',
    ]);
    return { ...result, tmp, sandboxRoot };
  }

  function runHermesLayoutBlock(
    dockerfilePath: string,
    startMarker: string,
    endMarker: string,
    { precreateConfig = false }: { precreateConfig?: boolean } = {},
  ) {
    const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-layout-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    const hermesDir = path.join(sandboxRoot, ".hermes");
    fs.mkdirSync(hermesDir, { recursive: true });
    if (precreateConfig) {
      fs.writeFileSync(path.join(hermesDir, "config.yaml"), "model: test\n");
      fs.writeFileSync(path.join(hermesDir, ".env"), "TOKEN=test\n");
    }
    const command = dockerRunCommandBetween(dockerfile, startMarker, endMarker).replaceAll(
      "/root/.cache/pip",
      path.join(tmp, "root-cache", "pip"),
    );
    const result = runDockerShell(command, sandboxRoot);
    return { ...result, tmp, sandboxRoot };
  }

  it("final image validates and runs the manifest-declared hermes binary path", () => {
    const result = runHermesPathValidation();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hermes manifest version");
  });

  it("final image rejects a hermes binary from a different PATH location", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrong-path-"));
    const wrongBin = path.join(tmp, "bin");
    try {
      fs.mkdirSync(wrongBin);
      fs.writeFileSync(path.join(wrongBin, "hermes"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      const result = runHermesPathValidation([wrongBin]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("expected hermes");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("adds root to the Hermes sandbox group during base user setup", () => {
    const { result, calls, tmp, sandboxRoot } = runHermesUserSetupBlock();
    try {
      expect(result.status).toBe(0);
      expect(calls).toContain("groupadd -r sandbox");
      expect(calls).toContain("groupadd -r gateway");
      expect(calls).toContain("usermod -a -G sandbox root");
      expect(calls).toContain(`chown -R sandbox:sandbox ${sandboxRoot}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("grants the Hermes gateway group write access to runtime state directories", () => {
    const runs = [
      runHermesLayoutBlock(
        HERMES_DOCKERFILE_BASE,
        "# Create .hermes with mutable integration dirs",
        "# Pre-create shell init files",
      ),
      runHermesLayoutBlock(
        HERMES_DOCKERFILE,
        "# Flatten stale published base images",
        "# Pin config hash at build time",
        { precreateConfig: true },
      ),
    ];

    try {
      for (const run of runs) {
        expect(run.result.status).toBe(0);
        const hermesDir = path.join(run.sandboxRoot, ".hermes");
        expect((fs.statSync(hermesDir).mode & 0o7777).toString(8)).toBe("3770");
        for (const dir of [
          "logs",
          "logs/curator",
          "cache",
          "hooks",
          "image_cache",
          "audio_cache",
          "platforms",
        ]) {
          expect((fs.statSync(path.join(hermesDir, dir)).mode & 0o777).toString(8)).toBe("770");
        }
        expect((fs.statSync(path.join(hermesDir, "platforms")).mode & 0o7777).toString(8)).toBe(
          "2770",
        );
        const whatsappSessionDir = path.join(hermesDir, "platforms", "whatsapp", "session");
        expect((fs.statSync(whatsappSessionDir).mode & 0o7777).toString(8)).toBe("2770");
        expect((fs.statSync(path.join(hermesDir, "runtime")).mode & 0o7777).toString(8)).toBe(
          "2770",
        );
        expect(fs.readlinkSync(path.join(hermesDir, "gateway_state.json"))).toBe(
          "runtime/gateway_state.json",
        );
        expect(() => fs.lstatSync(path.join(hermesDir, "gateway.pid"))).toThrow();
        expect(run.calls).toContain(`chown gateway:sandbox ${path.join(hermesDir, "runtime")}`);
      }
    } finally {
      for (const run of runs) {
        fs.rmSync(run.tmp, { recursive: true, force: true });
      }
    }
  });
});
