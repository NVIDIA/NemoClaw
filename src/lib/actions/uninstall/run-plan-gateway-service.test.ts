// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellUserConfigHome,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
} from "../../onboard/docker-driver-gateway-service";
import { HOST_GATEWAY_PGREP_PATTERN } from "../../onboard/host-gateway-process";
import { type RunResult, runUninstallPlan, type UninstallRunDeps } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

interface Fixture {
  env: NodeJS.ProcessEnv;
  home: string;
  root: string;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(useXdg = false): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: useXdg ? path.join(root, "xdg-config") : "",
    },
    home,
    root,
  };
}

function writeManagedService(test: Fixture): string {
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(test.home, test.env);
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.writeFileSync(
    servicePath,
    `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n[Service]\nExecStart=${test.home}/.local/bin/openshell-gateway\n`,
  );
  return servicePath;
}

function writeGatewayEnv(test: Fixture, contents = "OPENSHELL_SERVER_PORT=8080\n"): string {
  const envPath = path.join(
    getOpenShellUserConfigHome(test.home, test.env),
    "openshell",
    "gateway.env",
  );
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, contents);
  return envPath;
}

function writeGatewayState(test: Fixture): string {
  const configPath = path.join(
    test.home,
    ".local",
    "state",
    "nemoclaw",
    "openshell-docker-gateway",
    "openshell-gateway.toml",
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'listen_address = "127.0.0.1:8080"\n');
  return configPath;
}

function uninstall(
  test: Fixture,
  keepOpenShell: boolean,
  deps: Partial<UninstallRunDeps> = {},
  gateways: { name: string }[] = [{ name: "nemoclaw" }],
) {
  const { commandExists = () => false, run = () => ok(), ...overrides } = deps;
  return runUninstallPlan(
    { assumeYes: true, deleteModels: false, keepOpenShell },
    {
      env: test.env,
      existsSync: (target) => String(target).startsWith(test.root) && fs.existsSync(target),
      isTty: false,
      platform: "linux",
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: "packaged-service",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      rmSync: fs.rmSync,
      runDocker: () => ok(),
      ...overrides,
      commandExists: (command) => command === "openshell" || commandExists(command),
      run: (command, args, options) =>
        command === "openshell" && args[0] === "gateway" && args[1] === "list"
          ? ok(JSON.stringify(gateways))
          : run(command, args, options),
    },
  );
}

describe("uninstall OpenShell gateway user service", () => {
  it("keeps the service, env, gateway process, and state with --keep-openshell (#7830)", () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const envPath = writeGatewayEnv(test);
    const gatewayStatePath = writeGatewayState(test);
    const run = vi.fn((_command: string, _args: string[]) => ok());

    expect(uninstall(test, true, { commandExists: () => true, run }).exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
    expect(run.mock.calls.map(([, args]) => args)).not.toContainEqual([
      "-f",
      HOST_GATEWAY_PGREP_PATTERN,
    ]);
  });

  it("keeps selected gateway state when sibling gateways require scoped cleanup (#7830)", () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const envPath = writeGatewayEnv(test);
    const gatewayStatePath = writeGatewayState(test);

    const result = uninstall(test, true, { commandExists: () => true }, [
      { name: "nemoclaw" },
      { name: "sibling" },
    ]);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
  });

  it("keeps selected gateway state during scoped cleanup under external supervision (#6576)", () => {
    const test = fixture(true);
    const gatewayStatePath = writeGatewayState(test);

    const result = uninstall(
      test,
      false,
      {
        commandExists: () => true,
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "externally-supervised",
          source: "declared",
          endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
          stateDir: path.dirname(gatewayStatePath),
          supervisor: {
            kind: "systemd-user",
            serviceName: "external-openshell.service",
            execPath: "/usr/local/bin/openshell-gateway",
          },
          requiredCapabilities: [],
        }),
      },
      [{ name: "nemoclaw" }, { name: "sibling" }],
    );

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
  });

  it("removes only the marked Linux unit and managed env on full uninstall (#6903)", () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const envPath = writeGatewayEnv(test);
    const gatewayStatePath = writeGatewayState(test);
    const calls: string[][] = [];

    const result = uninstall(test, false, {
      commandExists: (command) => command === "systemctl",
      run: (command, args) => {
        calls.push([command, ...args]);
        return ok();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(false);
    expect(fs.existsSync(envPath)).toBe(false);
    expect(fs.existsSync(gatewayStatePath)).toBe(false);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
    ]);
    expect(calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
  });

  it("reports an incomplete uninstall when the marked service cannot be disabled (#6903)", () => {
    const test = fixture();
    const servicePath = writeManagedService(test);
    const errors: string[] = [];

    const result = uninstall(test, false, {
      commandExists: (command) => command === "systemctl",
      error: (line) => errors.push(line),
      run: (command, args) =>
        command === "systemctl" && args.includes("disable")
          ? { status: 1, stdout: "", stderr: "failed" }
          : ok(),
    });

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(errors).toContain(
      "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
    );
  });

  it("preserves a foreign unit at the NemoClaw service path (#6903)", () => {
    const test = fixture();
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(test.home, test.env);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, "# foreign service\n");

    expect(uninstall(test, false).exitCode).toBe(0);
    expect(fs.readFileSync(servicePath, "utf-8")).toBe("# foreign service\n");
  });

  it("refuses to follow symlinked service and env files (#6903)", () => {
    const test = fixture();
    const serviceTarget = path.join(test.root, "foreign.service");
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(test.home, test.env);
    const envTarget = path.join(test.root, "foreign.env");
    const envPath = path.join(
      getOpenShellUserConfigHome(test.home, test.env),
      "openshell",
      "gateway.env",
    );
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(serviceTarget, `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`);
    fs.writeFileSync(envTarget, "KEEP_ME=1\n");
    fs.symlinkSync(serviceTarget, servicePath);
    fs.symlinkSync(envTarget, envPath);

    expect(uninstall(test, false).exitCode).toBe(1);
    expect(fs.readFileSync(serviceTarget, "utf-8")).toContain(
      NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
    );
    expect(fs.readFileSync(envTarget, "utf-8")).toBe("KEEP_ME=1\n");
  });

  it("removes managed env keys while preserving unrelated content (#6903)", () => {
    const test = fixture();
    const envPath = writeGatewayEnv(
      test,
      [
        "KEEP_ME=1",
        "OPENSHELL_SERVER_PORT=8080",
        "OPENSHELL_BIND_ADDRESS=127.0.0.1",
        "DOCKER_HOST='unix:///tmp/docker.sock'",
        "",
      ].join("\n"),
    );

    expect(uninstall(test, false).exitCode).toBe(0);
    expect(fs.readFileSync(envPath, "utf-8")).toBe("KEEP_ME=1\n");
  });

  it("does not remove the Linux unit on macOS (#6903)", () => {
    const test = fixture();
    const servicePath = writeManagedService(test);

    expect(uninstall(test, false, { platform: "darwin" }).exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(true);
  });
});
