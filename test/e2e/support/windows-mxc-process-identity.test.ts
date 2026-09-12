// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertExpectedOpenClawProcessIdentity,
  assertExpectedOpenShellForwardProcessIdentity,
  assertExpectedOpenShellGatewayProcessIdentity,
  sameWindowsProcessIdentity,
} from "../live/windows-mxc-openclaw-process-container-helpers.ts";

describe("Windows MXC process identity", () => {
  it("compares the complete Windows process identity (#8178)", () => {
    const child = {
      commandLine:
        '"C:\\artifact\\node.exe" --import file:///C:/probe/openclaw-appcontainer-preload.mjs "C:\\artifact\\openclaw.mjs" gateway run --port 23456',
      creationDate: "20260804180001.000000-420",
      executablePath: "C:\\artifact\\node.exe",
      parentProcessId: 41,
      processId: 42,
    };
    expect(
      sameWindowsProcessIdentity(child, {
        ...child,
        creationDate: "20260804180002.000000-420",
      }),
    ).toBe(false);
  });

  it("checks Windows OpenClaw process identities independently of the host platform (#8178)", () => {
    const parent = {
      commandLine: '"C:\\artifact\\node.exe" "C:\\probe\\probe-agent.mjs"',
      creationDate: "20260804180000.000000-420",
      executablePath: "C:\\artifact\\node.exe",
      parentProcessId: 40,
      processId: 41,
    };
    const child = {
      commandLine:
        '"C:\\artifact\\node.exe" --import file:///C:/probe/openclaw-appcontainer-preload.mjs "C:\\artifact\\openclaw.mjs" gateway run --port 23456',
      creationDate: "20260804180001.000000-420",
      executablePath: "C:\\artifact\\node.exe",
      parentProcessId: 41,
      processId: 42,
    };
    expect(() =>
      assertExpectedOpenClawProcessIdentity(
        { child, parent },
        {
          compatibilityPreloadPath: "C:\\probe\\openclaw-appcontainer-preload.mjs",
          entryPath: "C:\\artifact\\openclaw.mjs",
          nodePath: "C:\\artifact\\node.exe",
          port: 23456,
          probeAgentPath: "C:\\probe\\probe-agent.mjs",
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertExpectedOpenClawProcessIdentity(
        {
          child: {
            ...child,
            executablePath: "C:\\Windows\\System32\\svchost.exe",
          },
          parent,
        },
        {
          compatibilityPreloadPath: "C:\\probe\\openclaw-appcontainer-preload.mjs",
          entryPath: "C:\\artifact\\openclaw.mjs",
          nodePath: "C:\\artifact\\node.exe",
          port: 23456,
          probeAgentPath: "C:\\probe\\probe-agent.mjs",
        },
      ),
    ).toThrow(/does not match/u);
    expect(() =>
      assertExpectedOpenClawProcessIdentity(
        {
          child: {
            ...child,
            commandLine:
              '"C:\\artifact\\node.exe" --import file:///C:/probe/openclaw-appcontainer-preload.mjs "C:\\artifact\\openclaw.mjs.extra" gateway run --port 23456',
          },
          parent,
        },
        {
          compatibilityPreloadPath: "C:\\probe\\openclaw-appcontainer-preload.mjs",
          entryPath: "C:\\artifact\\openclaw.mjs",
          nodePath: "C:\\artifact\\node.exe",
          port: 23456,
          probeAgentPath: "C:\\probe\\probe-agent.mjs",
        },
      ),
    ).toThrow(/does not match/u);
  });

  it.each([
    { name: "bare", portArguments: "--port 17670" },
    { name: "quoted", portArguments: '"--port" "17670"' },
  ])("requires the gateway path and ordered $name port arguments (#8178)", ({ portArguments }) => {
    const identity = {
      commandLine: `"C:\\package (release)\\openshell-gateway.exe" ${portArguments} --disable-tls`,
      creationDate: "20260804180000.000000-420",
      executablePath: "C:\\package (release)\\openshell-gateway.exe",
      parentProcessId: 40,
      processId: 41,
    };
    expect(() =>
      assertExpectedOpenShellGatewayProcessIdentity(identity, {
        gatewayPath: "C:\\package (release)\\openshell-gateway.exe",
        port: 17670,
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectedOpenShellGatewayProcessIdentity(
        {
          ...identity,
          commandLine: '"C:\\package (release)\\openshell-gateway.exe" --disable-tls 17670 --port',
        },
        { gatewayPath: "C:\\package (release)\\openshell-gateway.exe", port: 17670 },
      ),
    ).toThrow(/does not match/u);
  });

  it("requires the exact OpenShell forward command and loopback ports (#8178)", () => {
    const identity = {
      commandLine:
        '"C:\\package\\openshell.exe" forward service mxc-oc-123 --target-port 18889 --local 127.0.0.1:18790',
      creationDate: "20260804180000.000000-420",
      executablePath: "C:\\package\\openshell.exe",
      parentProcessId: 40,
      processId: 41,
    };
    expect(() =>
      assertExpectedOpenShellForwardProcessIdentity(identity, {
        cliPath: "C:\\package\\openshell.exe",
        localPort: 18790,
        sandboxName: "mxc-oc-123",
        targetPort: 18889,
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectedOpenShellForwardProcessIdentity(
        {
          ...identity,
          commandLine: identity.commandLine.replace("mxc-oc-123", "other"),
        },
        {
          cliPath: "C:\\package\\openshell.exe",
          localPort: 18790,
          sandboxName: "mxc-oc-123",
          targetPort: 18889,
        },
      ),
    ).toThrow(/forward process identity/u);
  });
});
