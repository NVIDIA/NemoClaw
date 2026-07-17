// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression guards for sandbox image provisioning.
// Verifies that the image-build sources (Dockerfile and Dockerfile.base)
// preserve the mutable-by-default config layout (#2227) and the gateway
// auth token externalization (#2378).
// These guards execute the relevant Dockerfile/startup snippets in temporary
// fixtures where practical, so coverage follows behavior rather than source
// text shape.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");
const DOCKERFILE_SANDBOX = path.join(ROOT, "test", "Dockerfile.sandbox");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");
const HERMES_DOCKERFILE_BASE = path.join(ROOT, "agents", "hermes", "Dockerfile.base");

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
    "# Stale-base fallback for the gateway/root-in-sandbox-group setup",
  );
  const permissionBlock = dockerRunCommandBetween(
    dockerfile,
    "# Keep the image readable to the root entrypoint",
    "# System-wide shell hooks",
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

function runOpenclawUserSetupBlock() {
  const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-users-"));
  const sandboxRoot = path.join(tmp, "sandbox");
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Create sandbox user (matches OpenShell convention)",
    "# Create .openclaw with all state subdirs directly",
  ).replaceAll("/sandbox", sandboxRoot);
  const result = runLoggedDockerShell(command, tmp, [
    'groupadd() { printf "groupadd %s\\n" "$*" >> "$call_log"; }',
    'useradd() { printf "useradd %s\\n" "$*" >> "$call_log"; }',
    'usermod() { printf "usermod %s\\n" "$*" >> "$call_log"; }',
    'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }',
  ]);
  return { ...result, tmp, sandboxRoot };
}

function runOpenclawStaleGroupFallback() {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-groups-"));
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Stale-base fallback for the gateway/root-in-sandbox-group setup",
    "# Keep the image readable to the root entrypoint",
  );
  const result = runLoggedDockerShell(command, tmp, [
    'id() { case "$*" in "gateway"|"sandbox"|"root") return 0 ;; "-nG gateway") printf "gateway\\n" ;; "-nG root") printf "root\\n" ;; *) return 1 ;; esac; }',
    'usermod() { printf "usermod %s\\n" "$*" >> "$call_log"; }',
  ]);
  return { ...result, tmp };
}

describe("sandbox provisioning: runtime npm online state", () => {
  it("replays the Dockerfile ENV directives so the runtime image inherits NPM_CONFIG_OFFLINE=false", () => {
    const exports = collectDockerfileEnvExports(DOCKERFILE);
    const probe = [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      ...exports,
      'printf "%s\\n" "${NPM_CONFIG_OFFLINE:-unset}"',
    ].join("\n");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-npm-online-"));
    const scriptPath = path.join(tmp, "replay.sh");
    try {
      fs.writeFileSync(scriptPath, probe, { mode: 0o700 });
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("false");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exercises the staged plugin install with the offline lock still applied", () => {
    const stage = stageDockerfileUntil(DOCKERFILE, "openclaw plugins install /opt/nemoclaw");
    const probe = [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      ...stage,
      'printf "%s\\n" "${NPM_CONFIG_OFFLINE:-unset}"',
    ].join("\n");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-npm-online-staged-"));
    const scriptPath = path.join(tmp, "staged.sh");
    try {
      fs.writeFileSync(scriptPath, probe, { mode: 0o700 });
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("true");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function dockerfileEnvDirectives(text: string): string[] {
  const lines = text.split("\n");
  const directives: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (!/^ENV\s/.test(raw)) continue;
    let collected = raw.replace(/^ENV\s+/, "");
    while (collected.endsWith("\\") && i + 1 < lines.length) {
      collected = `${collected.slice(0, -1)} ${lines[++i] ?? ""}`;
    }
    directives.push(collected.trim());
  }
  return directives;
}

function envDirectiveToExports(directive: string): string[] {
  const exports: string[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(directive)) !== null) {
    const name = match[1];
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    exports.push(`export ${name}=${JSON.stringify(value)}`);
  }
  return exports;
}

function collectDockerfileEnvExports(file: string): string[] {
  const text = fs.readFileSync(file, "utf-8");
  return dockerfileEnvDirectives(text).flatMap(envDirectiveToExports);
}

function linuxProcStat(pid: string, starttime: string, ppid = "1", state = "S"): string {
  return `${pid} (openclaw) ${state} ${ppid} ${Array(17).fill("0").join(" ")} ${starttime}\n`;
}

function stageDockerfileUntil(file: string, runMarker: string): string[] {
  const text = fs.readFileSync(file, "utf-8");
  const cutoff = text.indexOf(runMarker);
  if (cutoff === -1) {
    throw new Error(`Dockerfile is missing expected RUN marker: ${runMarker}`);
  }
  return dockerfileEnvDirectives(text.slice(0, cutoff)).flatMap(envDirectiveToExports);
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
    const nulArgv = (...argv: string[]) => `${argv.join("\0")}\0`;
    const unterminatedArgv = (...argv: string[]) => argv.join("\0");
    const npmGatewayCmdline = nulArgv(
      "node",
      "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
      "gateway",
      "run",
      "--port",
      "18789",
    );

    function runProductionHealthProbe({
      curlExit,
      gatewayCmdline = npmGatewayCmdline,
      gatewayLog = "gateway log line\n",
      // The /tmp/nemoclaw-gateway-local marker is dropped by nemoclaw-start
      // only when this container runs the in-container OpenClaw gateway. Most
      // probes here exercise that path, so default it to present.
      gatewayLocalMarker = true,
      recordedStartIdentity = "12345",
      observedStartIdentity = "12345",
    }: {
      curlExit: number;
      gatewayCmdline?: string | null;
      gatewayLog?: string;
      gatewayLocalMarker?: boolean;
      recordedStartIdentity?: string;
      observedStartIdentity?: string;
    }) {
      const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-health-fallback-"));
      const logPath = path.join(tmp, "gateway.log");
      const markerPath = path.join(tmp, "nemoclaw-gateway-local");
      const pidPath = path.join(tmp, "nemoclaw-gateway.pid");
      const procRoot = path.join(tmp, "proc");
      const rawCommand = dockerHealthCommandBetween(
        dockerfile,
        "# Health check: poll the gateway's /health endpoint",
        "# Entrypoint runs as root",
      );
      const command = rawCommand
        .replaceAll("/tmp/gateway.log", logPath)
        .replaceAll("/tmp/nemoclaw-gateway-local", markerPath)
        .replaceAll("/tmp/nemoclaw-gateway.pid", pidPath)
        .replaceAll("/proc/", `${procRoot}/`);

      if (gatewayLog !== "") {
        fs.writeFileSync(logPath, gatewayLog);
      }
      if (gatewayLocalMarker) {
        fs.writeFileSync(markerPath, "");
      }
      gatewayCmdline === null
        ? undefined
        : (() => {
            const pid = "4242";
            fs.mkdirSync(path.join(procRoot, pid), { recursive: true });
            fs.writeFileSync(
              path.join(procRoot, pid, "stat"),
              linuxProcStat(pid, observedStartIdentity),
            );
            fs.writeFileSync(path.join(procRoot, pid, "cmdline"), gatewayCmdline);
            fs.writeFileSync(pidPath, `${pid} ${recordedStartIdentity}\n`);
          })();

      try {
        const probe = runLoggedDockerShell(command, tmp, [
          `curl() { printf "curl %s\\n" "$*" >> "$call_log"; return ${curlExit}; }`,
        ]);
        return probe;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    it("reports healthy when in-container curl works (Docker-driver / standalone)", () => {
      const probe = runProductionHealthProbe({
        curlExit: 0,
        gatewayCmdline: null,
        gatewayLog: "",
      });
      expect(probe.result.status).toBe(0);
      expect(probe.calls).toContain("curl");
    });

    it("reports healthy when curl gets connection refused but the tracked npm OpenClaw gateway is alive", () => {
      const probe = runProductionHealthProbe({ curlExit: 7 });
      expect(probe.result.status).toBe(0);
      expect(probe.calls).toContain("curl");
    });

    it("rejects a live PID whose start identity differs from the recorded gateway", () => {
      const probe = runProductionHealthProbe({
        curlExit: 7,
        recordedStartIdentity: "12345",
        observedStartIdentity: "67890",
      });

      expect(probe.result.status).toBe(1);
    });

    it("reports unhealthy when curl times out (wedged HTTP server, not namespace mismatch)", () => {
      // A connect timeout means a listener exists but is not responding,
      // e.g. a wedged HTTP server. We deliberately do not fall back to the
      // process check there — Docker should restart the container.
      const probe = runProductionHealthProbe({ curlExit: 28, gatewayCmdline: null });
      expect(probe.result.status).toBe(1);
    });

    it("reports unhealthy when curl gets connection refused and openclaw is not running", () => {
      const probe = runProductionHealthProbe({ curlExit: 7, gatewayCmdline: null });
      expect(probe.result.status).toBe(1);
    });

    it("reports unhealthy when curl gets connection refused and the gateway log was never written (openclaw never started)", () => {
      const probe = runProductionHealthProbe({ curlExit: 7, gatewayLog: "" });
      expect(probe.result.status).toBe(1);
    });

    it("does not fall back when curl reports an HTTP error (gateway answered with failure)", () => {
      const probe = runProductionHealthProbe({ curlExit: 22, gatewayCmdline: null });
      expect(probe.result.status).toBe(1);
      // HTTP errors from the in-container probe should bypass the fallback;
      // a 4xx/5xx means the gateway is reachable and unhappy, not a
      // namespace mismatch.
    });

    // #4503: OpenShell docker-driver sandboxes deliver the OpenClaw gateway
    // outside this container's network namespace (it runs on the host), so
    // nemoclaw-start never drops the /tmp/nemoclaw-gateway-local marker. The
    // in-container curl gets connection-refused and no in-container process
    // can prove gateway liveness, yet `nemoclaw status`/OpenShell report Ready.
    // Without the marker the healthcheck must NOT mark the container unhealthy
    // off a signal it cannot observe.
    describe("does not falsely fail when the gateway runs outside this container's namespace (#4503)", () => {
      it("reports healthy on curl exit 7 with no in-container gateway process when the marker is absent", () => {
        const probe = runProductionHealthProbe({
          curlExit: 7,
          gatewayCmdline: null,
          gatewayLog: "gateway log line\n",
          gatewayLocalMarker: false,
        });
        expect(probe.result.status).toBe(0);
      });

      it("reports healthy on curl exit 7 even when no gateway log exists and the marker is absent", () => {
        const probe = runProductionHealthProbe({
          curlExit: 7,
          gatewayCmdline: null,
          gatewayLog: "",
          gatewayLocalMarker: false,
        });
        expect(probe.result.status).toBe(0);
      });

      it("still reports unhealthy on a wedged listener (curl exit 28) regardless of the marker", () => {
        const probe = runProductionHealthProbe({
          curlExit: 28,
          gatewayLocalMarker: false,
        });
        expect(probe.result.status).toBe(1);
      });
    });

    // #4952: OpenClaw can rewrite the gateway argv to a bare process title.
    // Exercise exact NUL-delimited launcher/title shapes against the recorded
    // PID and kernel start identity so unrelated OpenClaw processes cannot
    // keep a dead gateway container healthy.
    describe("matches the re-execed plain-`openclaw` gateway argv (#4952)", () => {
      function runHealthProbe({
        gatewayPid = null,
        gatewayCmdline = nulArgv("openclaw"),
        processPresent = true,
        recordedStart = "12345",
        observedStart = "12345",
        observedStartAfter,
        observedState = "S",
        curlExit = 7,
        gatewayLog = "gateway log line\n",
      }: {
        gatewayPid?: string | null;
        gatewayCmdline?: string | null;
        processPresent?: boolean;
        recordedStart?: string;
        observedStart?: string;
        observedStartAfter?: string;
        observedState?: string;
        curlExit?: number;
        gatewayLog?: string;
      }) {
        const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-health-argv-"));
        const logPath = path.join(tmp, "gateway.log");
        const markerPath = path.join(tmp, "nemoclaw-gateway-local");
        const pidPath = path.join(tmp, "nemoclaw-gateway.pid");
        const procRoot = path.join(tmp, "proc");
        let identityChangePrelude: string[] = [];
        const command = dockerHealthCommandBetween(
          dockerfile,
          "# Health check: poll the gateway's /health endpoint",
          "# Entrypoint runs as root",
        )
          .replaceAll("/tmp/gateway.log", logPath)
          .replaceAll("/tmp/nemoclaw-gateway-local", markerPath)
          .replaceAll("/tmp/nemoclaw-gateway.pid", pidPath)
          .replaceAll("/proc/", `${procRoot}/`);

        // Gateway is up and the marker is present: this container runs the
        // in-container gateway, so the liveness fallback is meaningful.
        if (gatewayLog !== "") {
          fs.writeFileSync(logPath, gatewayLog);
        }
        fs.writeFileSync(markerPath, "");
        if (gatewayPid !== null) {
          const statPath = path.join(procRoot, gatewayPid, "stat");
          const cmdlinePath = path.join(procRoot, gatewayPid, "cmdline");
          const changesIdentityDuringCmdline =
            processPresent && gatewayCmdline !== null && observedStartAfter !== undefined;
          fs.writeFileSync(pidPath, `${gatewayPid} ${recordedStart}\n`);
          processPresent && fs.mkdirSync(path.join(procRoot, gatewayPid), { recursive: true });
          processPresent &&
            fs.writeFileSync(
              statPath,
              linuxProcStat(gatewayPid, observedStart, "1", observedState),
            );
          changesIdentityDuringCmdline &&
            expect(spawnSync("mkfifo", [cmdlinePath], { encoding: "utf-8" }).status).toBe(0);
          processPresent &&
            gatewayCmdline !== null &&
            !changesIdentityDuringCmdline &&
            fs.writeFileSync(cmdlinePath, gatewayCmdline);
          identityChangePrelude = changesIdentityDuringCmdline
            ? [
                `python3 -c 'import pathlib,sys; stream = open(sys.argv[1], "wb"); stream.write(bytes.fromhex(sys.argv[2])); stream.flush(); pathlib.Path(sys.argv[3]).write_bytes(bytes.fromhex(sys.argv[4])); stream.close()' ${JSON.stringify(cmdlinePath)} ${Buffer.from(gatewayCmdline ?? "").toString("hex")} ${JSON.stringify(statPath)} ${Buffer.from(linuxProcStat(gatewayPid, observedStartAfter ?? observedStart, "1", observedState)).toString("hex")} &`,
              ]
            : [];
        }

        try {
          return runLoggedDockerShell(command, tmp, [
            ...identityChangePrelude,
            `curl() { printf "curl %s\\n" "$*" >> "$call_log"; return ${curlExit}; }`,
          ]);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }

      it.each([
        ["a bare rewritten title", nulArgv("openclaw")],
        ["the legacy rewritten title", nulArgv("openclaw-gateway")],
        ["a padded rewritten title", "openclaw-gateway\0\0\0"],
        [
          "the direct launcher",
          nulArgv("/usr/local/bin/openclaw", "gateway", "run", "--port", "18789"),
        ],
        [
          "the npm-installed Node launcher",
          nulArgv(
            "/usr/local/bin/node",
            "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
            "gateway",
            "run",
            "--port",
            "18789",
          ),
        ],
        [
          "the equals-form gateway port",
          nulArgv("nodejs", "/usr/local/bin/openclaw", "gateway", "run", "--port=18789"),
        ],
      ])("reports healthy for %s", (_label, gatewayCmdline) => {
        const probe = runHealthProbe({ gatewayPid: "4242", gatewayCmdline });
        expect(probe.result.status).toBe(0);
      });

      it("reports unhealthy when no openclaw process is alive and no gateway PID was recorded", () => {
        const probe = runHealthProbe({ gatewayPid: null });
        expect(probe.result.status).toBe(1);
      });

      // The tightening that closes the self-healing gap: an unrelated
      // `openclaw` one-shot is running (a bare `pgrep -x openclaw` would have
      // matched it and falsely reported healthy), but the recorded gateway PID
      // is dead. The container must report unhealthy so Docker restarts it.
      it("reports unhealthy when the recorded gateway PID is dead even if a non-gateway `openclaw` process exists", () => {
        const probe = runHealthProbe({
          gatewayPid: "9999",
          processPresent: false,
        });
        expect(probe.result.status).not.toBe(0);
      });

      it("reports unhealthy when the recorded gateway PID was reused by a non-openclaw process", () => {
        const probe = runHealthProbe({
          gatewayPid: "4242",
          gatewayCmdline: nulArgv("bash"),
        });
        expect(probe.result.status).toBe(1);
      });

      it.each([
        [
          "an unrelated Node script",
          nulArgv("node", "/tmp/openclaw-helper.mjs", "gateway", "run", "--port", "18789"),
        ],
        [
          "a same-basename Node script outside the installed path",
          nulArgv("node", "/tmp/openclaw.mjs", "gateway", "run", "--port", "18789"),
        ],
        [
          "a same-basename direct launcher outside the installed path",
          nulArgv("/tmp/openclaw", "gateway", "run", "--port", "18789"),
        ],
        ["a same-basename rewritten title outside the installed path", nulArgv("/tmp/openclaw")],
        [
          "a same-basename Node interpreter outside an installed path",
          nulArgv("/tmp/node", "/usr/local/bin/openclaw", "gateway", "run", "--port", "18789"),
        ],
        ["an OpenClaw one-shot command", nulArgv("openclaw", "agent", "run-task")],
        [
          "an OpenClaw gateway on the wrong port",
          nulArgv(
            "node",
            "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
            "gateway",
            "run",
            "--port",
            "19000",
          ),
        ],
        [
          "a launcher with a trailing empty argument",
          nulArgv("node", "/usr/local/bin/openclaw", "gateway", "run", "--port", "18789", ""),
        ],
        [
          "an unterminated launcher cmdline",
          unterminatedArgv("node", "/usr/local/bin/openclaw", "gateway", "run", "--port", "18789"),
        ],
        ["an unterminated rewritten title", "openclaw-gateway"],
        ["an empty cmdline", ""],
        ["a missing cmdline", null],
      ])("reports unhealthy for %s", (_label, gatewayCmdline) => {
        const probe = runHealthProbe({ gatewayPid: "4242", gatewayCmdline });
        expect(probe.result.status).toBe(1);
      });

      it("reports unhealthy when an OpenClaw-looking reused PID has a different starttime", () => {
        const probe = runHealthProbe({
          gatewayPid: "4242",
          recordedStart: "12345",
          observedStart: "99999",
          gatewayCmdline: nulArgv("openclaw"),
        });
        expect(probe.result.status).toBe(1);
      });

      it("reports unhealthy when the PID identity changes while cmdline is read", () => {
        const probe = runHealthProbe({
          gatewayPid: "4242",
          observedStart: "12345",
          observedStartAfter: "99999",
          gatewayCmdline: nulArgv("openclaw"),
        });
        expect(probe.result.status).toBe(1);
      });

      it("reports unhealthy when the recorded gateway identity is a zombie", () => {
        const probe = runHealthProbe({
          gatewayPid: "4242",
          observedState: "Z",
          gatewayCmdline: nulArgv("openclaw"),
        });
        expect(probe.result.status).toBe(1);
      });
    });
  });

  it.each([
    ["base image", DOCKERFILE_BASE, "# Baseline health check.", undefined],
    ["test image", DOCKERFILE_SANDBOX, "# Test image: no long-running service", "ENTRYPOINT"],
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
  it("keeps root in the sandbox group for capability-dropped lifecycle guards", () => {
    const base = runOpenclawUserSetupBlock();
    const fallback = runOpenclawStaleGroupFallback();
    try {
      expect(base.result.status, base.result.stderr).toBe(0);
      expect(base.calls).toContain("usermod -aG sandbox gateway");
      expect(base.calls).toContain("usermod -aG sandbox root");
      expect(fallback.result.status, fallback.result.stderr).toBe(0);
      expect(fallback.calls).toContain("usermod -aG sandbox gateway");
      expect(fallback.calls).toContain("usermod -aG sandbox root");
    } finally {
      fs.rmSync(base.tmp, { recursive: true, force: true });
      fs.rmSync(fallback.tmp, { recursive: true, force: true });
    }
  });

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
    const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const runtimeEnvShim = "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh";
    const rlimitShim = `[ -f ${rlimitLib} ] && . ${rlimitLib} && harden_resource_limits --quiet && verify_resource_limits --quiet || true`;

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      fs.writeFileSync(rlimitLib, "# rlimit fixture\n");
      fs.writeFileSync(bashrc, "# existing bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide proxy hooks",
        "# Install OpenClaw CLI + PyYAML",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const { result } = runLoggedDockerShell(command, tmp);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(rlimitHook, "utf-8").split(rlimitShim).length - 1).toBe(1);
      expect((fs.statSync(rlimitHook).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(rlimitLib).mode & 0o777).toString(8)).toBe("444");
      expect(fs.readFileSync(profileHook, "utf-8").split(runtimeEnvShim).length - 1).toBe(1);
      expect((fs.statSync(profileHook).mode & 0o777).toString(8)).toBe("444");

      const bashrcContent = fs.readFileSync(bashrc, "utf-8");
      expect(bashrcContent.split(rlimitShim).length - 1).toBe(1);
      expect(bashrcContent.split(runtimeEnvShim).length - 1).toBe(1);
      expect(bashrcContent.indexOf(runtimeEnvShim)).toBeLessThan(bashrcContent.indexOf(rlimitShim));
      expect(bashrcContent.split("\n").slice(0, 2).join("\n")).toContain(runtimeEnvShim);
      expect(bashrcContent).toContain("# existing bashrc");
      expect((fs.statSync(bashrc).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("repairs stale OpenClaw base images with system-wide rlimit hooks", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-thin-rlimits-"));
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
    const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const runtimeEnvShim = "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh";
    const rlimitShim = `[ -f ${rlimitLib} ] && . ${rlimitLib} && harden_resource_limits --quiet && verify_resource_limits --quiet || true`;

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      fs.writeFileSync(rlimitLib, "# rlimit fixture\n");
      fs.writeFileSync(bashrc, "# stale base bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide shell hooks",
        "# Pin config hash at build time",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const { result } = runLoggedDockerShell(command, tmp);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(rlimitHook, "utf-8").split(rlimitShim).length - 1).toBe(1);
      expect(fs.readFileSync(profileHook, "utf-8").split(runtimeEnvShim).length - 1).toBe(1);

      const bashrcContent = fs.readFileSync(bashrc, "utf-8");
      expect(bashrcContent.split(rlimitShim).length - 1).toBe(1);
      expect(bashrcContent.split(runtimeEnvShim).length - 1).toBe(1);
      expect(bashrcContent.indexOf(runtimeEnvShim)).toBeLessThan(bashrcContent.indexOf(rlimitShim));
      expect(bashrcContent.split("\n").slice(0, 2).join("\n")).toContain(runtimeEnvShim);
      expect(bashrcContent).toContain("# stale base bashrc");
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
    const tmuxMarker = path.join(tmp, "tmux-installed");
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
      `tmux_marker=${JSON.stringify(tmuxMarker)}`,
      'apt-mark() { printf "apt-mark %s\\n" "$*" >> "$call_log"; }',
      'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; if [[ "$*" == *"install"* && "$*" == *"procps=2:4.0.4-9"* ]]; then touch "$ps_marker"; fi; if [[ "$*" == *"install"* && "$*" == *"e2fsprogs=1.47.2-3+b11"* ]]; then touch "$chattr_marker"; fi; if [[ "$*" == *"install"* && "$*" == *"tmux=3.5a-3"* ]]; then touch "$tmux_marker"; fi; }',
      'command() { if [ "${1:-}" = "-v" ] && [ "${2:-}" = "ps" ]; then [ -f "$ps_marker" ]; elif [ "${1:-}" = "-v" ] && [ "${2:-}" = "chattr" ]; then [ -f "$chattr_marker" ]; elif [ "${1:-}" = "-v" ] && [ "${2:-}" = "tmux" ]; then [ -f "$tmux_marker" ]; else builtin command "$@"; fi; }',
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
      expect(calls).toContain("apt-get install -y --no-install-recommends procps=2:4.0.4-9");
      expect(calls).toContain("apt-get install -y --no-install-recommends e2fsprogs=1.47.2-3+b11");
      expect(result.stdout).toContain("procps test version");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Hermes sandbox provisioning", () => {
  it("stages privileged lifecycle helpers with root-only Hermes image modes", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-helper-modes-"));
    const localBin = path.join(tmp, "usr", "local", "bin");
    const localLib = path.join(tmp, "usr", "local", "lib", "nemoclaw");
    const etcDir = path.join(tmp, "etc");
    const profileDir = path.join(etcDir, "profile.d");
    const bashrcPath = path.join(etcDir, "bash.bashrc");
    const gatewayControlPath = path.join(localBin, "nemoclaw-gateway-control");
    const gatewaySupervisorPath = path.join(localLib, "gateway-supervisor.sh");
    const buildMcpDigestPath = path.join(localLib, "build-hermes-mcp-digest.py");
    const mcpConfigTransactionPath = path.join(localLib, "hermes-mcp-config-transaction.py");
    const mcpManifest = path.join(localLib, "openshell-child-visible-credentials.v0.0.85.json");
    const stateDirGuardPath = path.join(localLib, "state-dir-guard.py");
    const managedGatewayControlPath = path.join(localLib, "managed-gateway-control.py");
    const files = [
      path.join(localBin, "nemoclaw-start"),
      gatewayControlPath,
      path.join(localLib, "sandbox-init.sh"),
      path.join(localLib, "validate-hermes-env-secret-boundary.py"),
      path.join(localLib, "patch-hermes-session-list-preview.py"),
      path.join(localLib, "seed-hermes-dashboard-config.py"),
      path.join(localLib, "hermes-runtime-config-guard.py"),
      path.join(localLib, "finalize-tirith-marker.py"),
      buildMcpDigestPath,
      mcpConfigTransactionPath,
      mcpManifest,
      gatewaySupervisorPath,
      stateDirGuardPath,
      managedGatewayControlPath,
      path.join(localLib, "sandbox-rlimits.sh"),
    ];
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Dockerfile.base is the source of truth for rlimit hooks.",
      "# Wrap the hermes CLI",
    )
      .replaceAll("/usr/local/bin", localBin)
      .replaceAll("/usr/local/lib/nemoclaw", localLib)
      .replaceAll("/etc/profile.d", profileDir)
      .replaceAll("/etc/bash.bashrc", bashrcPath);
    try {
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(localLib, { recursive: true });
      fs.mkdirSync(etcDir, { recursive: true });
      fs.writeFileSync(bashrcPath, "# fixture\n", { mode: 0o600 });
      for (const file of files) fs.writeFileSync(file, "# fixture\n", { mode: 0o600 });
      const { result, calls } = runLoggedDockerShell(command, tmp, [
        'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }',
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain(
        `chown root:root ${gatewayControlPath} ${gatewaySupervisorPath} ${stateDirGuardPath} ${managedGatewayControlPath} ${buildMcpDigestPath} ${mcpManifest}`,
      );
      expect((fs.statSync(gatewayControlPath).mode & 0o777).toString(8)).toBe("700");
      expect((fs.statSync(mcpConfigTransactionPath).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(mcpManifest).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(buildMcpDigestPath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(gatewaySupervisorPath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(stateDirGuardPath).mode & 0o777).toString(8)).toBe("500");
      expect((fs.statSync(managedGatewayControlPath).mode & 0o777).toString(8)).toBe("500");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

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
  function runHermesUvExtrasExpansion() {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const extras = dockerfile.match(/^ARG HERMES_UV_EXTRAS="([^"]*)"$/m)?.[1];
    if (!extras) {
      throw new Error("Expected HERMES_UV_EXTRAS ARG in Hermes base Dockerfile");
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-uv-extras-"));
    const command = [
      "set -euo pipefail",
      `HERMES_UV_EXTRAS=${JSON.stringify(extras)}`,
      "set --",
      'for extra in ${HERMES_UV_EXTRAS}; do set -- "$@" --extra "$extra"; done',
      'printf "%s\\n" "$@"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", command], {
      encoding: "utf-8",
      cwd: tmp,
      timeout: 5000,
    });
    return { result, tmp };
  }

  it("installs Hermes' native Anthropic provider dependency (#4230)", () => {
    const { result, tmp } = runHermesUvExtrasExpansion();
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split(/\n/)).toEqual([
        "--extra",
        "anthropic",
        "--extra",
        "messaging",
        "--extra",
        "web",
        "--extra",
        "pty",
        "--extra",
        "mcp",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
  it("prebuilds the Hermes dashboard bundle in final images built from stale bases", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-build-"));
    const hermesRoot = path.join(tmp, "hermes");
    const hermesWebDir = path.join(hermesRoot, "web");
    const hermesWebDist = path.join(hermesRoot, "hermes_cli", "web_dist");
    fs.mkdirSync(hermesWebDir, { recursive: true });
    fs.writeFileSync(path.join(hermesWebDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(hermesWebDir, "package-lock.json"), "{}\n");
    fs.mkdirSync(path.join(hermesWebDir, "node_modules"), { recursive: true });
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Published base images can lag Dockerfile.base",
      "# Harden: remove unnecessary build tools",
    ).replaceAll("/opt/hermes", hermesRoot);
    try {
      const { result, calls } = runLoggedDockerShell(command, tmp, [
        'npm() { printf "npm %s\\n" "$*" >> "$call_log"; if [ -n "${hermes_web_dist:-}" ] && [ "${1:-}" = "run" ] && [ "${2:-}" = "build" ]; then mkdir -p "$hermes_web_dist"; fi; }',
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(calls).toContain(`npm ci --prefix ${hermesWebDir}`);
      expect(calls).toContain(`npm run build --prefix ${hermesWebDir}`);
      expect(fs.existsSync(hermesWebDist)).toBe(true);
      expect(fs.existsSync(path.join(hermesWebDir, "node_modules"))).toBe(false);
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
        expect((fs.statSync(path.join(hermesDir, "logs")).mode & 0o7777).toString(8)).toBe("2770");
        expect(
          (fs.statSync(path.join(hermesDir, "logs", "curator")).mode & 0o7777).toString(8),
        ).toBe("2770");
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
