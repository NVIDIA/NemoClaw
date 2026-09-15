// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCliOpenShellGatewayLifecycle,
  createCliOpenShellGatewayLifecycleFromRunner,
} from "./gateway-lifecycle-cli";

const target = { kind: "named", gatewayName: "nemoclaw-8091" } as const;

describe("gateway lifecycle CLI", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("targets every mutation explicitly without retrying", async () => {
    const capture = vi.fn().mockResolvedValue({ status: 0, output: "" });
    const gateway = createCliOpenShellGatewayLifecycle(capture);
    await expect(gateway.selectGateway({ target })).resolves.toEqual({
      ok: true,
      state: "completed",
    });
    await gateway.registerGateway({ target, endpoint: "https://127.0.0.1:8091" });
    await gateway.removeGateway({ target });
    await gateway.destroyGateway({ target });
    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ["gateway", "select", "nemoclaw-8091"],
      ["gateway", "add", "https://127.0.0.1:8091", "--local", "--name", "nemoclaw-8091"],
      ["gateway", "remove", "nemoclaw-8091"],
      ["gateway", "destroy", "-g", "nemoclaw-8091"],
    ]);
  });

  it.each(["selectGateway", "removeGateway"] as const)(
    "pins %s to the frozen runtime selection",
    async (operation) => {
      vi.stubEnv("OPENSHELL_GATEWAY", "ambient");
      vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
      const capture = vi.fn().mockResolvedValue({ status: 0, output: "" });
      const lifecycle = createCliOpenShellGatewayLifecycle(capture);
      const runtimeSelection = {
        gatewayName: target.gatewayName,
        workspace: "recorded",
        localTlsDir: "/recorded/tls",
      };
      await lifecycle[operation]({ target, runtimeSelection });
      expect(capture).toHaveBeenCalledOnce();
      const [, options] = capture.mock.calls[0];
      expect(options).toMatchObject({
        replaceEnv: true,
        env: {
          OPENSHELL_GATEWAY: target.gatewayName,
          OPENSHELL_WORKSPACE: "recorded",
          OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
        },
      });
      expect(options.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    },
  );

  it("rejects a mismatched frozen target before execution", async () => {
    const capture = vi.fn();
    await expect(
      createCliOpenShellGatewayLifecycle(capture).removeGateway({
        target,
        runtimeSelection: { gatewayName: "different", workspace: "default" },
      }),
    ).resolves.toMatchObject({ ok: false, unsupported: false, ambiguous: false });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    [0, "  start  Start gateway\n  gateway destroy  Destroy gateway", true],
    [0, "  add  Add gateway\n  remove  Remove gateway", false],
    [1, "  start  Start gateway\n  gateway destroy  Destroy gateway", false],
  ])("reports legacy capability for exit %s and help %s", async (status, output, supported) => {
    const capture = vi.fn().mockResolvedValue({ status, output });
    expect(
      await createCliOpenShellGatewayLifecycle(capture).supportsLegacyLifecycle({ target }),
    ).toBe(supported);
    expect(capture.mock.calls[0][0]).toEqual(["gateway", "--help"]);
  });

  it.each([
    ["error: unrecognized subcommand 'remove'", true],
    ["unknown command 'remove'", true],
    ["permission denied\nunknown command 'remove'", false],
    ["authentication failed\nunknown command 'remove'", false],
    ["connection refused\nunknown command 'remove'", false],
    ["A server message mentioned unknown command 'remove'", false],
  ])("classifies removal failure %s without invoking destruction", async (output, unsupported) => {
    const capture = vi.fn().mockResolvedValue({ status: 1, output });
    const result = await createCliOpenShellGatewayLifecycle(capture).removeGateway({ target });
    expect(result).toMatchObject({ ok: false, unsupported });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(output);
  });

  it("recognizes unsupported removal when the CLI uses its usage-error exit code", async () => {
    const capture = vi
      .fn()
      .mockResolvedValue({ status: 2, output: "error: unrecognized subcommand 'remove'" });
    await expect(
      createCliOpenShellGatewayLifecycle(capture).removeGateway({ target }),
    ).resolves.toMatchObject({ ok: false, unsupported: true, ambiguous: false });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("requires registry confirmation before accepting an exact no-active-gateway response", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 1, output: "No active gateway" })
      .mockResolvedValueOnce({ status: 0, output: "[]" });
    await expect(
      createCliOpenShellGatewayLifecycle(capture).destroyGateway({ target }),
    ).resolves.toEqual({ ok: true, state: "absent" });
    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ["gateway", "destroy", "-g", target.gatewayName],
      ["gateway", "list", "-o", "json"],
    ]);
  });

  it("fails a registry-confirmed missing selection (#11326)", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({
        status: 1,
        output:
          "Error:   × Unknown gateway 'nemoclaw-8091'.\n  │ Register it first: openshell gateway add <endpoint> --name nemoclaw-8091",
      })
      .mockResolvedValueOnce({ status: 0, output: "[]" });
    await expect(
      createCliOpenShellGatewayLifecycle(capture).selectGateway({ target }),
    ).resolves.toMatchObject({
      ok: false,
      unsupported: false,
      ambiguous: false,
      error: { kind: "command", reason: "failed" },
    });
    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ["gateway", "select", target.gatewayName],
      ["gateway", "list", "-o", "json"],
    ]);

    const mismatchedCapture = vi.fn().mockResolvedValue({
      status: 1,
      output: "Error:   × Unknown gateway 'foreign'.",
    });
    await expect(
      createCliOpenShellGatewayLifecycle(mismatchedCapture).selectGateway({ target }),
    ).resolves.toMatchObject({ ok: false });
    expect(mismatchedCapture).toHaveBeenCalledOnce();
  });

  it("treats a rejected mutation capture as ambiguous without retrying", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("secret transport detail"));
    const result = await createCliOpenShellGatewayLifecycle(capture).removeGateway({ target });
    expect(result).toMatchObject({ ok: false, ambiguous: true, unsupported: false });
    expect(JSON.stringify(result)).not.toContain("secret transport detail");
    expect(capture).toHaveBeenCalledOnce();
  });

  it("marks timeout as ambiguous and does not retry add", async () => {
    const capture = vi.fn().mockResolvedValue({
      status: null,
      output: "secret-token",
      error: Object.assign(new Error("secret-token"), { code: "ETIMEDOUT" }),
    });
    const result = await createCliOpenShellGatewayLifecycle(capture).registerGateway({
      target,
      endpoint: "https://127.0.0.1:8091",
    });
    expect(result).toMatchObject({ ok: false, ambiguous: true, unsupported: false });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it.each([
    "http://user:secret@localhost:8091",
    "file:///tmp/gateway",
    "https://localhost:8091?token=secret",
  ])("rejects an unsafe registration endpoint %s before execution", async (endpoint) => {
    const capture = vi.fn();
    expect(
      await createCliOpenShellGatewayLifecycle(capture).registerGateway({ target, endpoint }),
    ).toMatchObject({ ok: false, ambiguous: false });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([null, {}, [{ name: "../foreign" }], [{ name: "a" }, { name: "a" }]])(
    "rejects malformed registry %j",
    async (registry) => {
      const capture = vi.fn().mockResolvedValue({ status: 0, output: JSON.stringify(registry) });
      expect(
        await createCliOpenShellGatewayLifecycle(capture).listGateways({ target }),
      ).toMatchObject({ ok: false, error: { kind: "schema" } });
    },
  );

  it("returns validated registry identities", async () => {
    const capture = vi
      .fn()
      .mockResolvedValue({ status: 0, output: '[{"name":"nemoclaw"},{"name":"nemoclaw-8091"}]' });
    expect(await createCliOpenShellGatewayLifecycle(capture).listGateways({ target })).toEqual({
      ok: true,
      names: ["nemoclaw", "nemoclaw-8091"],
    });
  });
  it("reads buffered runner streams and reports invalid capture without retry", async () => {
    const run = vi.fn().mockReturnValue({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("permission denied"),
    });
    const lifecycle = createCliOpenShellGatewayLifecycleFromRunner(run);
    expect(await lifecycle.removeGateway({ target })).toMatchObject({
      ok: false,
      error: { kind: "authentication" },
      unsupported: false,
    });
    run.mockReturnValue({ status: 0, stdout: { unexpected: true } });
    expect(
      await lifecycle.registerGateway({ target, endpoint: "http://127.0.0.1:8091" }),
    ).toMatchObject({ ok: false, ambiguous: true });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
