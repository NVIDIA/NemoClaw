// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCliOpenShellSandboxCommandExecutor } from "../../adapters/openshell/sandbox-command-cli";
import {
  execSandbox,
  isGoogleChatPairingApproval,
  type ExecSandboxDeps,
  type SandboxExecCleanupDeps,
} from "./exec";
import { restartSandboxGatewayWithDeps } from "./gateway-restart";

const CLEANUP_SKIPPED: SandboxExecCleanupDeps = {
  getSandbox: () => null,
  inspectMutableConfigPerms: () => {
    throw new Error("cleanup should be skipped for an unregistered sandbox");
  },
  repairMutableConfigPerms: () => {
    throw new Error("cleanup should be skipped for an unregistered sandbox");
  },
};

function depsFor(status: number, restartGateway = vi.fn(() => ({ ok: true }))): ExecSandboxDeps {
  return {
    selectGateway: () => ({ outcome: "selected", gatewayName: "nemoclaw-alpha" }),
    commandExecutor: {
      probeDirectory: async () => ({ state: "present" }),
      runStreaming: async () => ({
        outcome: { kind: "completed", exitCode: status },
        release: () => {},
      }),
    },
    cleanupDeps: CLEANUP_SKIPPED,
    restartGateway,
    resolveSandboxAgent: () => "openclaw",
    policyHint: {
      now: () => 1_000,
      probeLogs: () => "",
      enableAudit: () => {},
      sleep: async () => {},
      attempts: 1,
      writeStderr: () => {},
    },
  };
}

async function runAndCaptureExit(
  command: readonly string[],
  deps: ExecSandboxDeps,
): Promise<number> {
  let exitCode = Number.NaN;
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__exec_exit__");
  }) as never);

  await execSandbox("alpha", command, {}, deps).catch((error: unknown) => {
    expect(error).toEqual(new Error("__exec_exit__"));
  });
  return exitCode;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Google Chat pairing approval gateway activation (#8553)", () => {
  it("recognizes only a direct Google Chat pairing approval with a code", () => {
    expect(
      isGoogleChatPairingApproval(["openclaw", "pairing", "approve", "googlechat", "ABCD1234"]),
    ).toBe(true);
    expect(
      isGoogleChatPairingApproval([
        "openclaw",
        "pairing",
        "approve",
        "googlechat",
        "ABCD1234",
        "--json",
      ]),
    ).toBe(true);
    expect(
      isGoogleChatPairingApproval(["openclaw", "pairing", "approve", "telegram", "ABCD1234"]),
    ).toBe(false);
    expect(
      isGoogleChatPairingApproval(["sh", "-lc", "openclaw pairing approve googlechat ABCD1234"]),
    ).toBe(false);
    expect(
      isGoogleChatPairingApproval(["openclaw", "pairing", "approve", "googlechat", "--help"]),
    ).toBe(false);
  });

  it("restarts the managed gateway after the exact approval succeeds", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      depsFor(0, restartGateway),
    );

    expect(restartGateway).toHaveBeenCalledOnce();
    expect(restartGateway).toHaveBeenCalledWith("alpha");
    expect(exitCode).toBe(0);
  });

  it("restarts only after the mutable OpenClaw config contract is verified", async () => {
    const order: string[] = [];
    const restartGateway = vi.fn(() => {
      order.push("restart");
      return { ok: true };
    });
    const deps = depsFor(0, restartGateway);
    deps.commandExecutor = {
      probeDirectory: async () => ({ state: "present" }),
      runStreaming: async () => {
        order.push("command");
        return { outcome: { kind: "completed", exitCode: 0 }, release: () => {} };
      },
    };
    deps.cleanupDeps = {
      getSandbox: () => ({ agent: "openclaw" }),
      inspectMutableConfigPerms: () => {
        order.push("cleanup");
        return {
          applies: true,
          ok: true,
          dirMode: "2770",
          dirOwner: "sandbox:sandbox",
          fileMode: "660",
          fileOwner: "sandbox:sandbox",
          configDir: "/sandbox/.openclaw",
          configFile: "openclaw.json",
          issues: [],
        };
      },
      repairMutableConfigPerms: () => {
        throw new Error("healthy config should not need repair");
      },
    };

    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      deps,
    );

    expect(order).toEqual(["command", "cleanup", "restart"]);
    expect(exitCode).toBe(0);
  });

  it("authorizes the approved sender after a sandbox-process approval and managed restart", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-googlechat-pairing-"));
    const openshellPath = path.join(fixtureRoot, "openshell");
    const configPath = path.join(fixtureRoot, "openclaw.json");
    const runtimePath = path.join(fixtureRoot, "gateway-runtime.json");
    const supervisorLog = path.join(fixtureRoot, "supervisor.log");
    const sender = "googlechat:users/123456789";

    fs.writeFileSync(configPath, JSON.stringify({ commands: { ownerAllowFrom: [] } }));
    fs.writeFileSync(runtimePath, JSON.stringify({ ownerAllowFrom: [] }));
    fs.writeFileSync(
      openshellPath,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'const commandIndex = args.indexOf("openclaw");',
        "const command = commandIndex === -1 ? [] : args.slice(commandIndex);",
        'if (args[0] !== "sandbox" || args[1] !== "exec" || command.join(" ") !== "openclaw pairing approve googlechat ABCD1234") process.exit(64);',
        'const config = JSON.parse(fs.readFileSync(process.env.NEMOCLAW_TEST_GOOGLECHAT_CONFIG, "utf8"));',
        "config.commands.ownerAllowFrom = [process.env.NEMOCLAW_TEST_GOOGLECHAT_SENDER];",
        "fs.writeFileSync(process.env.NEMOCLAW_TEST_GOOGLECHAT_CONFIG, JSON.stringify(config));",
        'process.stdout.write("Approved googlechat sender users/123456789\\n");',
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    vi.stubEnv("NEMOCLAW_TEST_GOOGLECHAT_CONFIG", configPath);
    vi.stubEnv("NEMOCLAW_TEST_GOOGLECHAT_RUNTIME", runtimePath);
    vi.stubEnv("NEMOCLAW_TEST_GOOGLECHAT_SENDER", sender);

    try {
      const exitCode = await runAndCaptureExit(
        ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
        {
          selectGateway: () => ({ outcome: "selected", gatewayName: "nemoclaw-alpha" }),
          commandExecutor: createCliOpenShellSandboxCommandExecutor({
            resolveBinary: () => openshellPath,
          }),
          cleanupDeps: {
            getSandbox: () => ({ agent: "openclaw" }),
            inspectMutableConfigPerms: () => ({
              applies: true,
              ok: true,
              dirMode: "2770",
              dirOwner: "sandbox:sandbox",
              fileMode: "660",
              fileOwner: "sandbox:sandbox",
              configDir: "/sandbox/.openclaw",
              configFile: "openclaw.json",
              issues: [],
            }),
            repairMutableConfigPerms: () => {
              throw new Error("healthy config should not need repair");
            },
          },
          resolveSandboxAgent: () => "openclaw",
          restartGateway: (sandboxName) =>
            restartSandboxGatewayWithDeps(sandboxName, {
              quiet: true,
              deps: {
                getSessionAgent: () => null,
                getSandbox: () => ({ name: sandboxName, agent: "openclaw" }),
                resolveSandboxDashboardPort: () => 18789,
                requestGatewaySupervisorAction: (_name, action) => {
                  const result = spawnSync(
                    process.execPath,
                    [
                      "-e",
                      [
                        'const fs = require("node:fs");',
                        'const config = JSON.parse(fs.readFileSync(process.env.NEMOCLAW_TEST_GOOGLECHAT_CONFIG, "utf8"));',
                        "fs.writeFileSync(process.env.NEMOCLAW_TEST_GOOGLECHAT_RUNTIME, JSON.stringify({ ownerAllowFrom: config.commands.ownerAllowFrom }));",
                        'fs.appendFileSync(process.env.NEMOCLAW_TEST_GOOGLECHAT_SUPERVISOR_LOG, process.argv[1] + "\\n");',
                        'process.stdout.write("GATEWAY_PID=4242\\n");',
                      ].join("\n"),
                      action,
                    ],
                    {
                      encoding: "utf8",
                      env: {
                        ...process.env,
                        NEMOCLAW_TEST_GOOGLECHAT_SUPERVISOR_LOG: supervisorLog,
                      },
                    },
                  );
                  return {
                    status: result.status ?? 1,
                    stdout: result.stdout,
                    stderr: result.stderr,
                  };
                },
                executeSandboxExecCommand: () => null,
                waitForRecoveredSandboxGateway: () => true,
                ensureSandboxPortForward: () => true,
                ensureHermesDashboardPortForwardIfEnabled: () => null,
                recoverMessagingHostForward: () => null,
                recoverDeclaredAgentForwardPorts: () => null,
                printGatewayWedgeDiagnostics: () => false,
                inspectHermesMcpReconciliationRefusal: () => null,
              },
            }),
          policyHint: {
            now: () => 1_000,
            probeLogs: () => "",
            enableAudit: () => {},
            sleep: async () => {},
            attempts: 1,
            writeStderr: () => {},
          },
        },
      );

      const nextDm = spawnSync(
        process.execPath,
        [
          "-e",
          'const fs = require("node:fs"); const runtime = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(runtime.ownerAllowFrom.includes(process.argv[2]) ? 0 : 1);',
          runtimePath,
          sender,
        ],
        { encoding: "utf8" },
      );

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(supervisorLog, "utf8")).toBe("restart\n");
      expect(nextDm.status, nextDm.stderr).toBe(0);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not restart when post-command config cleanup fails", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = depsFor(0, restartGateway);
    deps.cleanupDeps = {
      getSandbox: () => {
        throw new Error("invalid registry JSON");
      },
      inspectMutableConfigPerms: CLEANUP_SKIPPED.inspectMutableConfigPerms,
      repairMutableConfigPerms: CLEANUP_SKIPPED.repairMutableConfigPerms,
    };

    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      deps,
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("pairing approval committed for 'alpha'"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("nemoclaw alpha gateway restart"),
    );
  });

  it("fails the public command when activation restart fails", async () => {
    const restartGateway = vi.fn(() => ({ ok: false }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      depsFor(0, restartGateway),
    );

    expect(restartGateway).toHaveBeenCalledOnce();
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("pairing approval committed for 'alpha'"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("nemoclaw alpha gateway restart"),
    );
  });

  it("reports a controlled partial commit when the activation restart throws", async () => {
    const restartGateway = vi.fn(() => {
      throw new Error("supervisor transport unavailable");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      depsFor(0, restartGateway),
    );

    expect(restartGateway).toHaveBeenCalledOnce();
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("approval was not rolled back"));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("nemoclaw alpha gateway restart"),
    );
  });

  it("does not restart after a failed approval", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "BADCODE"],
      depsFor(17, restartGateway),
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(exitCode).toBe(17);
  });

  it("leaves unrelated successful exec commands unchanged", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "telegram", "ABCD1234"],
      depsFor(0, restartGateway),
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it.each(["hermes", "custom-agent"])(
    "does not restart a recorded non-OpenClaw %s sandbox",
    async (agent) => {
      const restartGateway = vi.fn(() => ({ ok: true }));
      const deps = depsFor(0, restartGateway);
      deps.resolveSandboxAgent = () => agent;

      const exitCode = await runAndCaptureExit(
        ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
        deps,
      );

      expect(restartGateway).not.toHaveBeenCalled();
      expect(exitCode).toBe(0);
    },
  );

  it("does not restart an unregistered sandbox", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const deps = depsFor(0, restartGateway);
    deps.resolveSandboxAgent = () => null;

    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      deps,
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it("does not activate or claim managed recovery without an owning gateway", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const deps = depsFor(0, restartGateway);
    deps.selectGateway = () => ({ outcome: "unregistered", gatewayName: null });
    deps.cleanupDeps = {
      getSandbox: () => {
        throw new Error("invalid registry JSON");
      },
      inspectMutableConfigPerms: CLEANUP_SKIPPED.inspectMutableConfigPerms,
      repairMutableConfigPerms: CLEANUP_SKIPPED.repairMutableConfigPerms,
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      deps,
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("approval was not rolled back"));
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("managed gateway activation failed"),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("nemoclaw alpha gateway restart"),
    );
  });

  it("fails closed when the recorded sandbox identity cannot be read", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const deps = depsFor(0, restartGateway);
    deps.resolveSandboxAgent = () => {
      throw new Error("registry unavailable");
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      deps,
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("pairing approval committed for 'alpha'"),
    );
  });
});
