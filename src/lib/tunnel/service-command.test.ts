// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveDefaultSandboxName,
  resolveDefaultSandboxServiceOptions,
  runStartCommand,
  runStopCommand,
} from "./service-command";

describe("services command", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      NEMOCLAW_SANDBOX_NAME: process.env.NEMOCLAW_SANDBOX_NAME,
      NEMOCLAW_SANDBOX: process.env.NEMOCLAW_SANDBOX,
      SANDBOX_NAME: process.env.SANDBOX_NAME,
      NEMOCLAW_GATEWAY_PORT: process.env.NEMOCLAW_GATEWAY_PORT,
    };
    delete process.env.NEMOCLAW_SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    delete process.env.SANDBOX_NAME;
    delete process.env.NEMOCLAW_GATEWAY_PORT;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns a safe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "alpha-1" }))).toBe("alpha-1");
  });

  it("drops an unsafe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "bad name" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "../../oops" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: ".hidden" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "-leading-dash" }))).toBeUndefined();
  });

  it("prefers NEMOCLAW_SANDBOX_NAME env var over registry default", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "env-sandbox";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe(
      "env-sandbox",
    );
  });

  it("keeps explicit sandbox overrides independent of registry availability", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "env-sandbox";
    const listSandboxes = vi.fn(() => {
      throw new Error("registry unavailable");
    });

    expect(resolveDefaultSandboxServiceOptions({ listSandboxes })).toEqual({
      sandboxName: "env-sandbox",
    });
    expect(listSandboxes).toHaveBeenCalledTimes(1);
  });

  it.each(["NEMOCLAW_SANDBOX_NAME", "NEMOCLAW_SANDBOX", "SANDBOX_NAME"])(
    "starts the registered dashboard selected by %s",
    async (envKey) => {
      process.env[envKey] = "selected";
      const startAll = vi.fn(async () => {});
      await runStartCommand({
        listSandboxes: () => ({
          defaultSandbox: "default",
          sandboxes: [
            { name: "default", dashboardPort: 18_789 },
            { name: "selected", dashboardPort: 18_791 },
          ],
        }),
        startAll,
      });
      expect(startAll).toHaveBeenCalledWith({ sandboxName: "selected", dashboardPort: 18_791 });
    },
  );

  it("keeps the fallback for an unregistered override without using the default sandbox port", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "selected";
    expect(
      resolveDefaultSandboxServiceOptions({
        listSandboxes: () => ({
          defaultSandbox: "default",
          sandboxes: [{ name: "default", dashboardPort: 18_791 }],
        }),
      }),
    ).toEqual({ sandboxName: "selected" });
  });

  it("reports an unavailable registry when no explicit sandbox is selected", () => {
    expect(() =>
      resolveDefaultSandboxServiceOptions({
        listSandboxes: () => {
          throw new Error("registry unavailable");
        },
      }),
    ).toThrow("registry unavailable");
  });

  it("prefers NEMOCLAW_SANDBOX env var over registry default", () => {
    process.env.NEMOCLAW_SANDBOX = "env-sandbox-2";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe(
      "env-sandbox-2",
    );
  });

  it("ignores unsafe env var values and falls back to registry", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "bad name";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe(
      "registry-sandbox",
    );
  });

  it("starts services for the default sandbox when present", async () => {
    const startAll = vi.fn(async () => {});
    await runStartCommand({
      listSandboxes: () => ({
        defaultSandbox: "alpha",
        sandboxes: [{ name: "alpha", dashboardPort: 18_791 }],
      }),
      startAll,
    });
    expect(startAll).toHaveBeenCalledWith({ sandboxName: "alpha", dashboardPort: 18_791 });
  });

  it("keeps a cross-gateway sandbox's dashboard and tunnel state on the same gateway", async () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "alpha";
    const startAll = vi.fn(async () => {});

    await runStartCommand({
      listSandboxes: () => ({ defaultSandbox: null, sandboxes: [] }),
      findSandboxAcrossGatewayRoots: () => ({
        entry: { name: "alpha", dashboardPort: 18_791 },
        gatewayPort: 18_080,
      }),
      startAll,
    });

    expect(startAll).toHaveBeenCalledWith({
      sandboxName: "alpha",
      dashboardPort: 18_791,
      gatewayPort: 18_080,
    });
  });

  it("keeps an explicit gateway selection ahead of cross-gateway sandbox ownership", async () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "alpha";
    process.env.NEMOCLAW_GATEWAY_PORT = "19080";
    const startAll = vi.fn(async () => {});
    const findSandboxAcrossGatewayRoots = vi.fn(() => ({
      entry: { name: "alpha", dashboardPort: 18_791 },
      gatewayPort: 18_080,
    }));

    await runStartCommand({
      listSandboxes: () => ({
        defaultSandbox: null,
        sandboxes: [{ name: "alpha", dashboardPort: 19_791 }],
      }),
      findSandboxAcrossGatewayRoots,
      startAll,
    });

    expect(findSandboxAcrossGatewayRoots).not.toHaveBeenCalled();
    expect(startAll).toHaveBeenCalledWith({
      sandboxName: "alpha",
      dashboardPort: 19_791,
    });
  });

  it("keeps the service fallback when the selected sandbox is not registered", () => {
    expect(
      resolveDefaultSandboxServiceOptions({
        listSandboxes: () => ({ defaultSandbox: "alpha", sandboxes: [] }),
      }),
    ).toEqual({ sandboxName: "alpha" });
  });

  it.each([0, 65_536, 18_791.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps the service fallback for an invalid registered dashboard port (%s)",
    (dashboardPort) => {
      expect(
        resolveDefaultSandboxServiceOptions({
          listSandboxes: () => ({
            defaultSandbox: "alpha",
            sandboxes: [{ name: "alpha", dashboardPort }],
          }),
        }),
      ).toEqual({ sandboxName: "alpha" });
    },
  );

  it("stops services without a sandbox override when the default sandbox is unsafe", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "bad name" }),
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({ sandboxName: undefined });
  });

  it("opts the legacy full-stop command into managed gateway release", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "alpha" }),
      stopAll,
      releaseGatewayPort: true,
    });
    expect(stopAll).toHaveBeenCalledWith({ sandboxName: "alpha", releaseGatewayPort: true });
  });
});
