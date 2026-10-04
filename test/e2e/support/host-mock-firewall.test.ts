// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  type HostMockFirewallResult,
  registerOpenShellHostMockFirewall,
} from "../fixtures/host-mock-firewall.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";

const NETWORK_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BRIDGE_INTERFACE = "br-0123456789ab";
const SUBNET = "172.18.0.0/16";
const GATEWAY = "172.18.0.1";
const PORT = 31_337;
const BASELINE_RULES = [
  "Added user rules (see 'ufw status' for running firewall):",
  "ufw allow 22/tcp",
].join("\n");
const EXACT_RULE = `ufw allow in on ${BRIDGE_INTERFACE} from ${SUBNET} to ${GATEWAY} port ${PORT} proto tcp`;

type CommandCall = {
  args: string[];
  command: string;
  options: ShellProbeRunOptions;
};
type CommandResponse =
  | ShellProbeResult
  | ((call: CommandCall) => Promise<ShellProbeResult> | ShellProbeResult);

function shellResult(
  stdout = "",
  options: { exitCode?: number | null; stderr?: string; timedOut?: boolean } = {},
): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [],
    exitCode: options.exitCode === undefined ? 0 : options.exitCode,
    signal: null,
    stderr: options.stderr ?? "",
    stdout,
    timedOut: options.timedOut ?? false,
  };
}

function networkInspect(options: { bridgeInterface?: string; subnet?: string } = {}): string {
  return JSON.stringify([
    {
      Driver: "bridge",
      Id: NETWORK_ID,
      IPAM: {
        Config: [
          { Gateway: "fd00::1", Subnet: "fd00::/64" },
          { Gateway: GATEWAY, Subnet: options.subnet ?? SUBNET },
        ],
      },
      Options: options.bridgeInterface
        ? { "com.docker.network.bridge.name": options.bridgeInterface }
        : {},
    },
  ]);
}

function bridgeAddresses(bridgeInterface = BRIDGE_INTERFACE): string {
  return JSON.stringify([
    {
      addr_info: [{ family: "inet", local: GATEWAY, prefixlen: 16 }],
      ifname: bridgeInterface,
    },
  ]);
}

class FakeHost {
  readonly calls: CommandCall[] = [];
  readonly availabilityCalls: string[] = [];
  private readonly responses: CommandResponse[];
  private readonly ufwAvailable: boolean;

  constructor(responses: CommandResponse[], options: { ufwAvailable?: boolean } = {}) {
    this.responses = [...responses];
    this.ufwAvailable = options.ufwAvailable ?? true;
  }

  async command(
    command: string,
    args: string[] = [],
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    const call = { args, command, options };
    this.calls.push(call);
    const response =
      this.responses.shift() ??
      ((_call: CommandCall): never => {
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      });
    return typeof response === "function" ? response(call) : response;
  }

  async isCommandAvailable(command: string): Promise<boolean> {
    this.availabilityCalls.push(command);
    return this.ufwAvailable;
  }

  expectNoPendingResponses(): void {
    expect(this.responses).toEqual([]);
  }
}

function registration(host: FakeHost, cleanup: CleanupRegistry, authorized = true) {
  return registerOpenShellHostMockFirewall({
    authorized,
    cleanup,
    host,
    platform: "linux",
    port: PORT,
  });
}

describe("OpenShell live E2E host mock firewall", () => {
  it("adds the detected bridge rule and restores the complete UFW baseline (#8696)", async () => {
    const host = new FakeHost([
      shellResult(networkInspect()),
      shellResult(bridgeAddresses()),
      shellResult("Status: active\n"),
      shellResult(BASELINE_RULES),
      shellResult("Rule added\n"),
      shellResult(`${BASELINE_RULES}\n${EXACT_RULE}\n`),
      shellResult(`${BASELINE_RULES}\n${EXACT_RULE}\n`),
      shellResult("Rule deleted\n"),
      shellResult(BASELINE_RULES),
    ]);
    const cleanup = new CleanupRegistry();

    const setup = await registration(host, cleanup);

    expect(setup).toEqual<HostMockFirewallResult>({
      bridgeInterface: BRIDGE_INTERFACE,
      changed: true,
      gatewayIp: GATEWAY,
      manualCommand: `sudo ${EXACT_RULE}`,
      prefixLength: 16,
      reason: "applied",
      subnet: SUBNET,
    });
    expect(host.calls[0]?.command).toBe("bash");
    expect(host.calls[0]?.args).toContain("openshell-docker");
    expect(host.calls[1]).toMatchObject({
      args: ["-j", "address", "show", "dev", BRIDGE_INTERFACE],
      command: "ip",
    });
    expect(host.calls[4]).toMatchObject({
      args: [
        "-n",
        "ufw",
        "allow",
        "in",
        "on",
        BRIDGE_INTERFACE,
        "from",
        SUBNET,
        "to",
        GATEWAY,
        "port",
        String(PORT),
        "proto",
        "tcp",
      ],
      command: "sudo",
    });

    expect(await cleanup.runAll()).toEqual({
      failures: [],
      passed: [`restore UFW state after host mock port ${PORT}`],
    });
    expect(host.calls[7]).toMatchObject({
      args: [
        "-n",
        "ufw",
        "--force",
        "delete",
        "allow",
        "in",
        "on",
        BRIDGE_INTERFACE,
        "from",
        SUBNET,
        "to",
        GATEWAY,
        "port",
        String(PORT),
        "proto",
        "tcp",
      ],
      command: "sudo",
    });
    host.expectNoPendingResponses();
  });

  it("preserves a pre-existing exact UFW rule (#8696)", async () => {
    const host = new FakeHost([
      shellResult(networkInspect()),
      shellResult(bridgeAddresses()),
      shellResult("Status: active\n"),
      shellResult(`${BASELINE_RULES}\n${EXACT_RULE}\n`),
    ]);
    const cleanup = new CleanupRegistry();

    await expect(registration(host, cleanup)).resolves.toMatchObject({
      changed: false,
      reason: "preexisting",
    });
    expect(await cleanup.runAll()).toEqual({
      failures: [],
      passed: [`restore UFW state after host mock port ${PORT}`],
    });
    expect(host.calls).toHaveLength(4);
    host.expectNoPendingResponses();
  });

  it("does not change UFW when UFW is inactive or unavailable (#8696)", async () => {
    const inactiveHost = new FakeHost([
      shellResult(networkInspect()),
      shellResult(bridgeAddresses()),
      shellResult("Status: inactive\n"),
    ]);
    const inactiveCleanup = new CleanupRegistry();

    await expect(registration(inactiveHost, inactiveCleanup)).resolves.toMatchObject({
      changed: false,
      reason: "ufw_inactive",
    });
    await inactiveCleanup.runAll();
    expect(inactiveHost.calls).toHaveLength(3);

    const missingHost = new FakeHost(
      [shellResult(networkInspect()), shellResult(bridgeAddresses())],
      { ufwAvailable: false },
    );
    const missingCleanup = new CleanupRegistry();
    await expect(registration(missingHost, missingCleanup)).resolves.toMatchObject({
      changed: false,
      reason: "ufw_missing",
    });
    await missingCleanup.runAll();
    expect(missingHost.calls).toHaveLength(2);
  });

  it("reports the bridge, subnet, gateway, port, and manual command when mutation is not authorized (#8696)", async () => {
    const customBridge = "br-custom0";
    const host = new FakeHost([
      shellResult(networkInspect({ bridgeInterface: customBridge })),
      shellResult(bridgeAddresses(customBridge)),
    ]);
    const cleanup = new CleanupRegistry();

    await expect(registration(host, cleanup, false)).rejects.toThrow(
      new RegExp(
        `bridge=${customBridge} subnet=${SUBNET.replace("/", "\\/")} gateway=${GATEWAY} port=${PORT}.*sudo ufw allow in on ${customBridge}`,
        "s",
      ),
    );
    await cleanup.runAll();
    expect(host.availabilityCalls).toEqual([]);
    expect(host.calls).toHaveLength(2);
  });

  it("rejects a broad bridge subnet before invoking UFW (#8696)", async () => {
    const host = new FakeHost([shellResult(networkInspect({ subnet: "172.0.0.0/8" }))]);
    const cleanup = new CleanupRegistry();

    await expect(registration(host, cleanup)).rejects.toThrow(
      "OpenShell bridge network has no narrow IPv4 subnet and gateway",
    );
    await cleanup.runAll();
    expect(host.availabilityCalls).toEqual([]);
    expect(host.calls).toHaveLength(1);
  });

  it("removes a rule when test interruption overlaps the apply command (#8696)", async () => {
    let resolveApply: ((value: ShellProbeResult) => void) | undefined;
    let markApplyStarted: (() => void) | undefined;
    const applyStarted = new Promise<void>((resolve) => {
      markApplyStarted = resolve;
    });
    const applyResult = new Promise<ShellProbeResult>((resolve) => {
      resolveApply = resolve;
    });
    const host = new FakeHost([
      shellResult(networkInspect()),
      shellResult(bridgeAddresses()),
      shellResult("Status: active\n"),
      shellResult(BASELINE_RULES),
      () => {
        markApplyStarted?.();
        return applyResult;
      },
      shellResult(`${BASELINE_RULES}\n${EXACT_RULE}\n`),
      shellResult("Rule deleted\n"),
      shellResult(BASELINE_RULES),
    ]);
    const cleanup = new CleanupRegistry();
    const setupOutcome = registration(host, cleanup).then(
      (value) => value,
      (error: unknown) => error,
    );
    await applyStarted;

    const cleanupResult = cleanup.runAll();
    resolveApply?.(shellResult("Rule added\n"));

    await expect(setupOutcome).resolves.toEqual(
      expect.objectContaining({
        message: "host mock firewall setup was interrupted while applying the UFW rule",
      }),
    );
    await expect(cleanupResult).resolves.toEqual({
      failures: [],
      passed: [`restore UFW state after host mock port ${PORT}`],
    });
    host.expectNoPendingResponses();
  });

  it("does not apply a rule when cleanup starts during baseline inspection (#8696)", async () => {
    const cleanup = new CleanupRegistry();
    const host = new FakeHost([
      shellResult(networkInspect()),
      shellResult(bridgeAddresses()),
      shellResult("Status: active\n"),
      async () => {
        await expect(cleanup.runAll()).resolves.toEqual({
          failures: [],
          passed: [`restore UFW state after host mock port ${PORT}`],
        });
        return shellResult(BASELINE_RULES);
      },
    ]);

    await expect(registration(host, cleanup)).rejects.toThrow(
      "host mock firewall setup was interrupted before applying the UFW rule",
    );
    expect(host.calls).toHaveLength(4);
    host.expectNoPendingResponses();
  });

  it("removes a rule after an apply timeout leaves an ambiguous host state (#8696)", async () => {
    const host = new FakeHost([
      shellResult(networkInspect()),
      shellResult(bridgeAddresses()),
      shellResult("Status: active\n"),
      shellResult(BASELINE_RULES),
      shellResult("", { exitCode: null, timedOut: true }),
      shellResult(`${BASELINE_RULES}\n${EXACT_RULE}\n`),
      shellResult("Rule deleted\n"),
      shellResult(BASELINE_RULES),
    ]);
    const cleanup = new CleanupRegistry();

    await expect(registration(host, cleanup)).rejects.toThrow(
      /UFW rule application was not confirmed \(timed out\).*Run this command manually/s,
    );
    await expect(cleanup.runAll()).resolves.toEqual({
      failures: [],
      passed: [`restore UFW state after host mock port ${PORT}`],
    });
    host.expectNoPendingResponses();
  });

  it("reports rule absence after a successful UFW inspection (#8696)", async () => {
    const host = new FakeHost([
      shellResult(networkInspect()),
      shellResult(bridgeAddresses()),
      shellResult("Status: active\n"),
      shellResult(BASELINE_RULES),
      shellResult("Rule added\n"),
      shellResult(BASELINE_RULES),
      shellResult(BASELINE_RULES),
    ]);
    const cleanup = new CleanupRegistry();

    await expect(registration(host, cleanup)).rejects.toThrow(
      /UFW inspection completed but the exact rule was absent.*Run this command manually/s,
    );
    await expect(cleanup.runAll()).resolves.toEqual({
      failures: [],
      passed: [`restore UFW state after host mock port ${PORT}`],
    });
    host.expectNoPendingResponses();
  });

  it("reports a cleanup failure when UFW rejects rule deletion (#8696)", async () => {
    const host = new FakeHost([
      shellResult(networkInspect()),
      shellResult(bridgeAddresses()),
      shellResult("Status: active\n"),
      shellResult(BASELINE_RULES),
      shellResult("Rule added\n"),
      shellResult(`${BASELINE_RULES}\n${EXACT_RULE}\n`),
      shellResult(`${BASELINE_RULES}\n${EXACT_RULE}\n`),
      shellResult("", { exitCode: 1, stderr: "delete rejected" }),
    ]);
    const cleanup = new CleanupRegistry();
    await registration(host, cleanup);

    await expect(cleanup.runAll()).resolves.toEqual({
      failures: [
        {
          message: expect.stringContaining("could not delete the host mock UFW rule"),
          name: `restore UFW state after host mock port ${PORT}`,
        },
      ],
      passed: [],
    });
    host.expectNoPendingResponses();
  });
});
