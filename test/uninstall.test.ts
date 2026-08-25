// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "../src/lib/onboard/docker-driver-gateway-config";
import { writeDockerDriverGatewayRuntimeMarkerForStateDir } from "../src/lib/onboard/docker-driver-gateway-runtime-marker";
import {
  getNemoclawOpenShellGatewayUserServicePath,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
} from "../src/lib/onboard/docker-driver-gateway-service";
import { deriveCheckpointFromSession } from "../src/lib/state/onboard-checkpoint-migrate";
import { createSession } from "../src/lib/state/onboard-session";

const UNINSTALL_SCRIPT = path.join(import.meta.dirname, "..", "uninstall.sh");

describe("uninstall CLI flags", () => {
  function writeFakeTools(fakeBin: string) {
    fs.mkdirSync(fakeBin);
    for (const cmd of ["npm", "docker", "ollama", "pgrep"]) {
      fs.writeFileSync(path.join(fakeBin, cmd), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
    }
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
case "$*" in
  "gateway list -o json") printf '[{"name":"nemoclaw"}]\\n' ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
  }

  function seedPreservedState(tmp: string): string {
    const stateDir = seedCompletedDefaultAuthority(tmp);
    fs.mkdirSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json"),
      "{}",
    );
    fs.mkdirSync(path.join(stateDir, "backups", "20260320-120000"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "backups", "20260320-120000", "USER.md"), "hello");
    return stateDir;
  }

  function seedManagedHermesStateVolume(tmp: string): string {
    return seedCompletedDefaultAuthority(tmp, "standalone", {
      agent: "hermes",
      name: "hermes",
      workload: { kind: "managed-image" },
    });
  }

  function seedCompletedDefaultAuthority(
    tmp: string,
    source: "packaged-service" | "standalone" = "standalone",
    sandbox: {
      agent: "hermes" | "openclaw";
      name: string;
      workload?: { kind: "managed-image" };
    } = { agent: "openclaw", name: "ordinary-authority" },
  ): string {
    const stateDir = path.join(tmp, ".nemoclaw");
    const sandboxName = sandbox.name;
    const gateway = {
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed" as const,
      source,
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    };
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDir, 0o700);
    const session = createSession({
      agent: sandbox.agent,
      sandboxName,
      metadata: { gatewayName: gateway.gatewayName, fromDockerfile: null },
    });
    session.status = "complete";
    session.resumable = false;
    session.machine = { ...session.machine, state: "complete", revision: 1 };
    session.checkpoint = {
      ...deriveCheckpointFromSession(session, { profile: "default" }),
      sandboxIdentity: {
        kind: "selected",
        value: { name: sandboxName, agent: sandbox.agent },
      },
      gatewayAuthority: { kind: "selected", value: gateway },
    };
    fs.writeFileSync(path.join(stateDir, "onboard-session.json"), `${JSON.stringify(session)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(stateDir, "sandboxes.json"),
      `${JSON.stringify({
        defaultSandbox: sandboxName,
        sandboxes: {
          [sandboxName]: {
            name: sandboxName,
            agent: sandbox.agent === "openclaw" ? null : sandbox.agent,
            dashboardPort: null,
            gatewayName: gateway.gatewayName,
            gatewayPort: gateway.gatewayPort,
            lifecycleGeneration: `${sandboxName}-generation`,
            openshellDriver: "docker",
            ...(sandbox.workload ? { workload: sandbox.workload } : {}),
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    return stateDir;
  }

  function sanitizedParentEnv(): NodeJS.ProcessEnv {
    return Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("NEMOCLAW_")),
    ) as NodeJS.ProcessEnv;
  }

  function runUninstall(
    tmp: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
  ): ReturnType<typeof spawnSync> {
    return spawnSync("bash", [UNINSTALL_SCRIPT, ...args], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...sanitizedParentEnv(),
        HOME: tmp,
        PATH: `${path.join(tmp, "bin")}:/usr/bin:/bin`,
        XDG_BIN_HOME: path.join(tmp, ".local", "bin"),
        XDG_CONFIG_HOME: path.join(tmp, ".config"),
        NEMOCLAW_NODE: process.execPath,
        TMPDIR: tmp,
        ...extraEnv,
      },
    });
  }

  function writeManagedHermesVolumeDocker(fakeBin: string, tmp: string) {
    const callsPath = path.join(tmp, "docker-calls");
    const volumeName = "nemoclaw-hermes-state-v1-hermes";
    const volumePath = path.join(tmp, "managed-hermes-volume");
    const volume = JSON.stringify({
      Labels: {
        "io.nvidia.nemoclaw.hermes-state.managed": "true",
        "io.nvidia.nemoclaw.hermes-state.sandbox": "hermes",
        "io.nvidia.nemoclaw.hermes-state.schema": "1",
        "io.nvidia.nemoclaw.hermes-state.target": "/sandbox/.hermes",
      },
      Name: volumeName,
    });
    fs.writeFileSync(volumePath, "present\n");
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${callsPath}'
case "$*" in
  "volume inspect --format {{json .}} ${volumeName}") printf '%s\\n' '${volume}' ;;
  "volume rm ${volumeName}") rm -f '${volumePath}' ;;
  "volume inspect openshell-cluster-nemoclaw") exit 1 ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    return { callsPath, volumeName, volumePath };
  }

  function writeHostedFallbackCli(fakeBin: string): void {
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
exec '${process.execPath}' '${path.join(path.dirname(UNINSTALL_SCRIPT), "bin", "nemoclaw.js")}' "$@"
`,
      { mode: 0o755 },
    );
  }

  function writeManagedGatewayConfig(tmp: string): string {
    const stateDir = path.join(tmp, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "openshell-gateway.toml"),
      buildDockerDriverGatewayConfigToml(
        {
          OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
          OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
          OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
          OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
        },
        "/usr/bin/openshell-sandbox",
        jwtBundle,
        gatewayIdForStateDir(stateDir),
      ),
      { mode: 0o600 },
    );
    return stateDir;
  }

  function startManagedGatewayProcess(tmp: string): ChildProcess {
    const stateDir = writeManagedGatewayConfig(tmp);
    const processScript = path.join(tmp, "managed-gateway-process.mjs");
    fs.writeFileSync(processScript, "setInterval(() => {}, 1_000);\n", { mode: 0o600 });
    const child = spawn(process.execPath, [processScript, "--name", "nemoclaw", "--port", "8080"], {
      env: {
        ...sanitizedParentEnv(),
        [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: gatewayIdForStateDir(stateDir),
      },
      stdio: "ignore",
    });
    const childPid =
      child.pid ??
      (() => {
        throw new Error("managed gateway fixture did not start");
      })();
    fs.writeFileSync(path.join(stateDir, "openshell-gateway.pid"), `${String(childPid)}\n`, {
      mode: 0o600,
    });
    writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
      desiredEnv: {},
      endpoint: "https://127.0.0.1:8080",
      pid: childPid,
    });
    return child;
  }

  function startPackagedGatewayProcess(
    tmp: string,
    fakeBin: string,
  ): {
    child: ChildProcess;
    servicePath: string;
    stateDir: string;
    systemctlCalls: string;
  } {
    const stateDir = writeManagedGatewayConfig(tmp);
    const gatewayBinDir = path.join(tmp, ".local", "bin");
    const gatewayBin = path.join(gatewayBinDir, "openshell-gateway");
    const processScript = path.join(tmp, "packaged-gateway-process.mjs");
    fs.mkdirSync(gatewayBinDir, { recursive: true });
    fs.symlinkSync(process.execPath, gatewayBin);
    fs.writeFileSync(processScript, "setInterval(() => {}, 1_000);\n", { mode: 0o600 });
    const child = spawn(gatewayBin, [processScript], {
      env: {
        ...sanitizedParentEnv(),
        [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: gatewayIdForStateDir(stateDir),
      },
      stdio: "ignore",
    });
    const childPid =
      child.pid ??
      (() => {
        throw new Error("packaged gateway fixture did not start");
      })();
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(tmp, { HOME: tmp });
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE}\n[Service]\nExecStart=${gatewayBin} ${processScript}\n`,
    );
    const systemctlCalls = path.join(tmp, "systemctl-calls");
    fs.writeFileSync(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${systemctlCalls}'
case "$*" in
  "--user show ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE} --property=FragmentPath --property=ExecStart")
    printf '%s\\n' 'FragmentPath=${servicePath}' 'ExecStart={ path=${gatewayBin} ; argv[]=${gatewayBin} ${processScript} ; }'
    ;;
  "--user show ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE} --property=FragmentPath --property=ExecStart --property=ActiveState --property=MainPID")
    printf '%s\\n' 'FragmentPath=${servicePath}' 'ExecStart={ path=${gatewayBin} ; argv[]=${gatewayBin} ${processScript} ; }' 'ActiveState=active' 'MainPID=${String(childPid)}'
    ;;
  "--user show ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE} --property=MainPID --value")
    printf '%s\\n' '${String(childPid)}'
    ;;
  "--user disable --now ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}")
    :
    ;;
  "--user daemon-reload")
    :
    ;;
  *)
    exit 1
    ;;
esac
`,
      { mode: 0o755 },
    );
    return { child, servicePath, stateDir, systemctlCalls };
  }

  it("exits 0 and shows usage for --help", () => {
    const result = spawnSync("bash", [UNINSTALL_SCRIPT, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/NemoClaw Uninstaller/);
    expect(output).toMatch(/--yes/);
    expect(output).toMatch(/--keep-openshell/);
    expect(output).toMatch(/--delete-models/);
    expect(output).toMatch(/--destroy-user-data/);
  });

  it("uses NemoHermes branding for --help when Hermes is active", () => {
    const result = spawnSync("bash", [UNINSTALL_SCRIPT, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_AGENT: "hermes",
        NEMOCLAW_NODE: process.execPath,
      },
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/NemoHermes Uninstaller/);
    expect(output).toMatch(/Remove host-side NemoHermes resources/);
    expect(output).toMatch(
      /Remove all Ollama models and non-credential Hugging\s+Face cache data \(authentication files remain\)/,
    );
    expect(output).not.toMatch(/NemoClaw Uninstaller/);
  });

  it("skips the confirmation prompt and completes successfully for --yes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-yes-"));
    writeFakeTools(path.join(tmp, "bin"));
    seedCompletedDefaultAuthority(tmp);
    try {
      const result = runUninstall(tmp, ["--yes"]);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(output).toMatch(/NemoClaw/);
      expect(output).toMatch(/Claws retracted/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("preserves rebuild-backups, backups, and sandboxes.json under ~/.nemoclaw for --yes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-yes-preserve-"));
    writeFakeTools(path.join(tmp, "bin"));
    const stateDir = seedPreservedState(tmp);
    try {
      const result = runUninstall(tmp, ["--yes"]);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(
        fs.existsSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json")),
      ).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "backups", "20260320-120000", "USER.md"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(stateDir, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("purges preserved ~/.nemoclaw entries through the public wrapper for --yes --destroy-user-data", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-destroy-"));
    writeFakeTools(path.join(tmp, "bin"));
    const stateDir = seedPreservedState(tmp);
    try {
      const result = runUninstall(tmp, ["--yes", "--destroy-user-data"]);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(output).toMatch(/--destroy-user-data set; purging user data under ~\/\.nemoclaw\//);
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    {
      environment: (_fakeBin: string, _tmp: string): NodeJS.ProcessEnv => ({}),
      label: "local packaged script",
    },
    {
      environment: (fakeBin: string, tmp: string): NodeJS.ProcessEnv => {
        writeHostedFallbackCli(fakeBin);
        return { NEMOCLAW_CLI_JS: path.join(tmp, "missing-cli.js") };
      },
      label: "hosted-script fallback",
    },
  ])("removes managed Hermes state volume through $label", ({ environment }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-hermes-volume-"));
    const fakeBin = path.join(tmp, "bin");
    writeFakeTools(fakeBin);
    seedManagedHermesStateVolume(tmp);
    const volume = writeManagedHermesVolumeDocker(fakeBin, tmp);
    const entrypointEnv = environment(fakeBin, tmp);
    try {
      const result = runUninstall(tmp, ["--yes", "--destroy-user-data"], {
        NEMOCLAW_AGENT: "hermes",
        ...entrypointEnv,
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(fs.existsSync(volume.volumePath)).toBe(false);
      expect(fs.readFileSync(volume.callsPath, "utf8")).toContain(`volume rm ${volume.volumeName}`);
      expect(output).toContain("Removed managed Hermes state volume for 'hermes'.");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("completes selected-gateway cleanup and exits 0 when the recorded sandbox is already absent (#7906)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-absent-sandbox-"));
    const fakeBin = path.join(tmp, "bin");
    writeFakeTools(fakeBin);
    const managedGateway = startManagedGatewayProcess(tmp);
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
case "$*" in
  "status -g nemoclaw") printf 'Status: Connected\\nGateway: nemoclaw\\n' ;;
  "gateway list -o json") printf '[{"name":"nemoclaw"},{"name":"nemoclaw-9124"}]\\n' ;;
  "sandbox delete -g nemoclaw my-assistant")
    printf "Error: status: NotFound, sandbox 'my-assistant' not found\\n" >&2
    exit 1
    ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    const stateDir = path.join(tmp, ".nemoclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "my-assistant",
        sandboxes: {
          "my-assistant": { name: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
          sibling: { name: "sibling", gatewayName: "nemoclaw-9124", gatewayPort: 9124 },
        },
      }),
    );
    try {
      await once(managedGateway, "spawn");
      const result = runUninstall(tmp, ["--yes", "--destroy-user-data"], {
        NEMOCLAW_OPENSHELL_GATEWAY_BIN: process.execPath,
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(output).toMatch(/OpenShell sandbox 'my-assistant' already removed/);
      expect(output).not.toMatch(/Selected gateway cleanup was incomplete/);
      expect(output).not.toMatch(/Uninstall completed with errors/);
    } finally {
      managedGateway.kill("SIGKILL");
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(process.platform === "linux")(
    "uninstalls the scoped package-managed gateway without standalone runtime files",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-packaged-gateway-"));
      const fakeBin = path.join(tmp, "bin");
      writeFakeTools(fakeBin);
      const { child, servicePath, stateDir, systemctlCalls } = startPackagedGatewayProcess(
        tmp,
        fakeBin,
      );
      const openshellCalls = path.join(tmp, "openshell-calls");
      fs.writeFileSync(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${openshellCalls}'
case "$*" in
  "gateway list -o json") printf '[{"name":"nemoclaw"},{"name":"nemoclaw-9124"}]\\n' ;;
esac
exit 0
`,
        { mode: 0o755 },
      );
      const registryRoot = seedCompletedDefaultAuthority(tmp, "packaged-service");
      const registryPath = path.join(registryRoot, "sandboxes.json");
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
        sandboxes: Record<string, unknown>;
      };
      registry.sandboxes.sibling = {
        gatewayName: "nemoclaw-9124",
        gatewayPort: 9124,
        name: "sibling",
      };
      fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });

      try {
        await once(child, "spawn");
        expect(fs.existsSync(path.join(stateDir, "openshell-gateway.pid"))).toBe(false);
        const result = runUninstall(tmp, ["--yes"]);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status, output).toBe(0);
        const openshellInvocations = fs.readFileSync(openshellCalls, "utf-8");
        expect(openshellInvocations).toContain("sandbox delete -g nemoclaw ordinary-authority");
        expect(openshellInvocations).not.toMatch(
          /sandbox delete .*nemoclaw-9124|sandbox delete .*sibling/,
        );
        const preservedRegistry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
          sandboxes: Record<string, unknown>;
        };
        expect(preservedRegistry.sandboxes.sibling).toEqual({
          gatewayName: "nemoclaw-9124",
          gatewayPort: 9124,
          name: "sibling",
        });
        const gatewayList = spawnSync(
          path.join(fakeBin, "openshell"),
          ["gateway", "list", "-o", "json"],
          { encoding: "utf-8" },
        );
        expect(gatewayList.status, gatewayList.stderr).toBe(0);
        expect(JSON.parse(gatewayList.stdout) as Array<{ name: string }>).toContainEqual({
          name: "nemoclaw-9124",
        });
        const serviceInvocations = fs.readFileSync(systemctlCalls, "utf-8");
        expect(serviceInvocations).toContain(
          `--user show ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE} --property=FragmentPath --property=ExecStart`,
        );
        expect(serviceInvocations).toContain(
          `--user show ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE} --property=FragmentPath --property=ExecStart --property=ActiveState --property=MainPID`,
        );
        expect(serviceInvocations).toContain(
          `--user show ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE} --property=MainPID --value`,
        );
        expect(serviceInvocations).toContain(
          `--user disable --now ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}`,
        );
        expect(serviceInvocations).toContain("--user daemon-reload");
        expect(output).not.toContain("selected gateway PID file is missing or invalid");
        expect(fs.existsSync(servicePath)).toBe(false);
      } finally {
        child.kill("SIGKILL");
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("uses NemoHermes branding for --yes when Hermes is active", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-uninstall-yes-"));
    writeFakeTools(path.join(tmp, "bin"));
    seedCompletedDefaultAuthority(tmp);
    try {
      const result = runUninstall(tmp, ["--yes"], { NEMOCLAW_AGENT: "hermes" });

      expect(result.status).toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toMatch(/NemoHermes Uninstaller/);
      expect(output).toMatch(/\[3\/6\] NemoHermes CLI/);
      expect(output).toMatch(/Removed global NemoHermes CLI package/);
      expect(output).toMatch(/Hermes has left the tidepool/);
      expect(output).not.toMatch(/NemoClaw Uninstaller/);
      expect(output).not.toMatch(/\[3\/6\] NemoClaw CLI/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
