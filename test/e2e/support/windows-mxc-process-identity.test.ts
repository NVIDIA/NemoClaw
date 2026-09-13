// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertExpectedOpenClawProcessIdentity,
  assertExpectedOpenShellForwardProcessIdentity,
  assertExpectedOpenShellGatewayProcessIdentity,
  sameWindowsProcessIdentity,
} from "../live/windows-mxc-openclaw-process-container-helpers.ts";

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
const expectedOpenClaw = {
  compatibilityPreloadPath: "C:\\probe\\openclaw-appcontainer-preload.mjs",
  entryPath: "C:\\artifact\\openclaw.mjs",
  nodePath: "C:\\artifact\\node.exe",
  port: 23456,
  probeAgentPath: "C:\\probe\\probe-agent.mjs",
};
const gateway = {
  ...parent,
  commandLine: '"C:\\package (release)\\openshell-gateway.exe" --port 17670 --disable-tls',
  executablePath: "C:\\package (release)\\openshell-gateway.exe",
};
const expectedGateway = { gatewayPath: gateway.executablePath, port: 17670 };
const forward = {
  ...parent,
  commandLine:
    '"C:\\package\\openshell.exe" forward service mxc-oc-123 --target-port 18889 --local 127.0.0.1:18790',
  executablePath: "C:\\package\\openshell.exe",
};
const expectedForward = {
  cliPath: forward.executablePath,
  localPort: 18790,
  sandboxName: "mxc-oc-123",
  targetPort: 18889,
};

describe("Windows MXC process identity", () => {
  it.each([
    { field: "processId", replacement: { processId: 43 } },
    { field: "parentProcessId", replacement: { parentProcessId: 40 } },
    { field: "creationDate", replacement: { creationDate: "20260804180002.000000-420" } },
    { field: "executablePath", replacement: { executablePath: "C:\\other\\node.exe" } },
    { field: "commandLine", replacement: { commandLine: child.commandLine + " --other" } },
  ])("rejects a changed $field in a recorded process identity (#8178)", ({ replacement }) => {
    expect(sameWindowsProcessIdentity(child, { ...child, ...replacement })).toBe(false);
  });

  it("accepts the same process with Windows path case and separator differences (#8178)", () => {
    expect(
      sameWindowsProcessIdentity(child, { ...child, executablePath: "c:/ARTIFACT/node.exe" }),
    ).toBe(true);
  });

  it("accepts the expected OpenClaw parent and child processes (#8178)", () => {
    expect(() =>
      assertExpectedOpenClawProcessIdentity({ child, parent }, expectedOpenClaw),
    ).not.toThrow();
  });

  it.each([
    {
      field: "child executable",
      childChange: { executablePath: "C:\\Windows\\System32\\svchost.exe" },
      parentChange: {},
    },
    {
      field: "parent executable",
      childChange: {},
      parentChange: { executablePath: "C:\\other\\node.exe" },
    },
    { field: "parent-child PID", childChange: { parentProcessId: 40 }, parentChange: {} },
    {
      field: "entrypoint",
      childChange: {
        commandLine: child.commandLine.replace('openclaw.mjs"', 'openclaw.mjs.extra"'),
      },
      parentChange: {},
    },
    {
      field: "preload pair",
      childChange: {
        commandLine: child.commandLine.replace(
          "--import file:///C:/probe/openclaw-appcontainer-preload.mjs",
          "file:///C:/probe/openclaw-appcontainer-preload.mjs --import",
        ),
      },
      parentChange: {},
    },
    {
      field: "gateway argument",
      childChange: { commandLine: child.commandLine.replace(" gateway ", " gateway-extra ") },
      parentChange: {},
    },
    {
      field: "port pair",
      childChange: { commandLine: child.commandLine.replace("--port 23456", "23456 --port") },
      parentChange: {},
    },
    {
      field: "parent probe",
      childChange: {},
      parentChange: {
        commandLine: parent.commandLine.replace("probe-agent.mjs", "other-probe.mjs"),
      },
    },
  ])("rejects a changed OpenClaw $field (#8178)", ({ childChange, parentChange }) => {
    expect(() =>
      assertExpectedOpenClawProcessIdentity(
        { child: { ...child, ...childChange }, parent: { ...parent, ...parentChange } },
        expectedOpenClaw,
      ),
    ).toThrow(/does not match/u);
  });

  it.each([
    { name: "bare", portArguments: "--port 17670" },
    { name: "quoted", portArguments: '"--port" "17670"' },
  ])("accepts ordered $name gateway port arguments (#8178)", ({ portArguments }) => {
    expect(() =>
      assertExpectedOpenShellGatewayProcessIdentity(
        { ...gateway, commandLine: gateway.commandLine.replace("--port 17670", portArguments) },
        expectedGateway,
      ),
    ).not.toThrow();
  });

  it.each([
    { field: "executable", replacement: { executablePath: "C:\\other\\openshell-gateway.exe" } },
    {
      field: "port pair",
      replacement: {
        commandLine: gateway.commandLine.replace(
          "--port 17670 --disable-tls",
          "--disable-tls 17670 --port",
        ),
      },
    },
    {
      field: "TLS flag",
      replacement: { commandLine: gateway.commandLine.replace(" --disable-tls", "") },
    },
  ])("rejects a changed gateway $field (#8178)", ({ replacement }) => {
    expect(() =>
      assertExpectedOpenShellGatewayProcessIdentity(
        { ...gateway, ...replacement },
        expectedGateway,
      ),
    ).toThrow(/does not match/u);
  });

  it("accepts the expected OpenShell forward command and loopback ports (#8178)", () => {
    expect(() =>
      assertExpectedOpenShellForwardProcessIdentity(forward, expectedForward),
    ).not.toThrow();
  });

  it.each([
    { field: "executable", replacement: { executablePath: "C:\\other\\openshell.exe" } },
    {
      field: "sandbox name",
      replacement: { commandLine: forward.commandLine.replace("mxc-oc-123", "other") },
    },
    {
      field: "service pair",
      replacement: {
        commandLine: forward.commandLine.replace("forward service", "service forward"),
      },
    },
    {
      field: "target-port pair",
      replacement: {
        commandLine: forward.commandLine.replace("--target-port 18889", "18889 --target-port"),
      },
    },
    {
      field: "local-port pair",
      replacement: {
        commandLine: forward.commandLine.replace(
          "--local 127.0.0.1:18790",
          "127.0.0.1:18790 --local",
        ),
      },
    },
  ])("rejects a changed forward $field (#8178)", ({ replacement }) => {
    expect(() =>
      assertExpectedOpenShellForwardProcessIdentity(
        { ...forward, ...replacement },
        expectedForward,
      ),
    ).toThrow(/forward process identity/u);
  });
});
