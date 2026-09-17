// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ captureOpenshellCommandAsyncResult: vi.fn() }));

import type { OpenShellForwardIdentity } from "./forward";
import {
  createHarness,
  errors,
  executable,
  forward,
  legacyForwardList,
  listHeader,
  noActiveForwards,
  otherForward,
  runtimeSelection,
} from "./forward-cli-test-fixture";
import {
  buildCliOpenShellForwardListArgs,
  buildCliOpenShellForwardServiceArgs,
  buildCliOpenShellLegacyForwardStopArgs,
  parseCliOpenShellForwardList,
} from "./forward-cli";

describe("CLI OpenShell forward command builders", () => {
  it("builds explicit gateway endpoint, gateway, and workspace arguments for each command", () => {
    expect(buildCliOpenShellForwardListArgs(forward)).toEqual([
      "forward",
      "list",
      "--gateway",
      "nemoclaw",
      "--gateway-endpoint",
      "https://127.0.0.1:8080",
      "--workspace",
      "default",
    ]);
    expect(buildCliOpenShellForwardServiceArgs(forward)).toEqual([
      "--gateway",
      "nemoclaw",
      "--gateway-endpoint",
      "https://127.0.0.1:8080",
      "--workspace",
      "default",
      "forward",
      "service",
      "demo",
      "--target-port",
      "18789",
      "--target-host",
      "127.0.0.1",
      "--local",
      "127.0.0.1:18789",
    ]);
    expect(buildCliOpenShellLegacyForwardStopArgs(forward)).toEqual([
      "forward",
      "stop",
      "18789",
      "demo",
      "--gateway",
      "nemoclaw",
      "--gateway-endpoint",
      "https://127.0.0.1:8080",
      "--workspace",
      "default",
    ]);
  });
});

describe("CLI OpenShell forward list parser", () => {
  it("parses an ANSI-formatted forward table", () => {
    expect(
      parseCliOpenShellForwardList(
        "\u001b[1mSANDBOX\u001b[0m BIND PORT PID STATUS\n" +
          "\u001b[32mdemo\u001b[0m     127.0.0.1  18789  4312  running",
        "",
      ),
    ).toEqual({
      ok: true,
      rows: [
        {
          sandboxName: "demo",
          bind: "127.0.0.1",
          port: 18_789,
          pid: 4_312,
          status: "running",
        },
      ],
    });
  });

  it("parses the explicit empty marker", () => {
    expect(parseCliOpenShellForwardList("", noActiveForwards)).toEqual({ ok: true, rows: [] });
  });

  it.each([
    ["empty output", ""],
    ["missing header", "demo 127.0.0.1 18789 4312 running"],
    ["missing column", `${listHeader}\ndemo 127.0.0.1 18789 running`],
    ["extra column", `${listHeader}\ndemo 127.0.0.1 18789 4312 running extra`],
    ["invalid bind", `${listHeader}\ndemo localhost 18789 4312 running`],
    ["invalid port", `${listHeader}\ndemo 127.0.0.1 65536 4312 running`],
    ["invalid PID", `${listHeader}\ndemo 127.0.0.1 18789 0 running`],
    ["invalid status", `${listHeader}\ndemo 127.0.0.1 18789 4312 stopped`],
    ["mixed empty marker", `${noActiveForwards}\n${legacyForwardList}`],
    ["duplicate row", `${legacyForwardList}\ndemo 127.0.0.1 18789 4312 running`],
    ["conflicting owner", `${legacyForwardList}\nother 127.0.0.1 18789 9876 running`],
    ["unsupported control byte", `${listHeader}\n\u0001demo 127.0.0.1 18789 4312 running`],
    ["non-SGR ANSI sequence", `${listHeader}\n\u001b[31demo 127.0.0.1 18789 4312 running`],
  ])("rejects %s", (_case, output) => {
    expect(parseCliOpenShellForwardList(output, "")).toEqual({
      ok: false,
      error: errors.schema,
    });
  });

  it("rejects conflicting stdout and stderr evidence", () => {
    expect(parseCliOpenShellForwardList(noActiveForwards, legacyForwardList)).toEqual({
      ok: false,
      error: errors.schema,
    });
  });
});

describe("CLI OpenShell forward validation", () => {
  it("rejects an invalid request without echoing its identity or invoking dependencies", async () => {
    const credentialLikeValue = "token=sk-private-forward-value";
    const invalidForward: OpenShellForwardIdentity = {
      ...forward,
      sandboxName: credentialLikeValue,
    };
    const authorize = vi.fn(async () => {});
    const { adapter, inspect, inspectLegacy, probePort, run, spawn, terminate } = createHarness();

    const results = await Promise.all([
      adapter.observeForwards({ forwards: [invalidForward] }),
      adapter.startForward({ forward: invalidForward }),
      adapter.retireLegacyForward({ forward: invalidForward, authorize }),
      adapter.verifyForwardRelease({ forwards: [invalidForward] }),
    ]);

    expect(results).toEqual([
      [{ state: "indeterminate", error: errors.validation }],
      { state: "failed", effect: "none", error: errors.validation },
      { state: "failed", effect: "none", error: errors.validation },
      { state: "indeterminate", error: errors.validation },
    ]);
    expect(JSON.stringify(results)).not.toContain(credentialLikeValue);
    expect(run).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(inspectLegacy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(probePort).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["a relative executable", { executable: "openshell" }],
    ["a relative XDG_CONFIG_HOME", { environment: { XDG_CONFIG_HOME: "relative/config" } }],
    [
      "a mismatched runtime gateway",
      { runtimeSelection: { ...runtimeSelection, gatewayName: "nemoclaw-19080" } },
    ],
    [
      "a mismatched runtime workspace",
      { runtimeSelection: { ...runtimeSelection, workspace: "other" } },
    ],
    [
      "a relative authority TLS directory",
      { runtimeSelection: { ...runtimeSelection, localTlsDir: "relative/tls" } },
    ],
  ] as const)("rejects %s before invoking dependencies", async (_case, overrides) => {
    const { adapter, inspect, inspectLegacy, probePort, run, spawn, terminate } =
      createHarness(overrides);

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "failed",
      effect: "none",
      error: errors.validation,
    });
    expect(run).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(inspectLegacy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(probePort).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it.each([
    "https://attacker.invalid:8080",
    "https://127.0.0.1:8081",
    "https://127.0.0.1:8080/path",
    "https://user@127.0.0.1:8080",
    "https://localhost:8080",
  ])("rejects an endpoint outside the exact gateway authority: %s", async (gatewayEndpoint) => {
    const { adapter, inspect, run } = createHarness();

    await expect(
      adapter.observeForwards({ forwards: [{ ...forward, gatewayEndpoint }] }),
    ).resolves.toEqual([{ state: "indeterminate", error: errors.validation }]);
    expect(run).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1:19080", "https://[::1]:19080"])(
    "accepts the authority-bound local gateway endpoint %s",
    async (gatewayEndpoint) => {
      const selectedForward = {
        ...forward,
        gatewayEndpoint,
        gatewayName: "nemoclaw-19080",
      };
      const selectedRuntime = { ...runtimeSelection, gatewayName: "nemoclaw-19080" };
      const { adapter, run } = createHarness({
        gatewayEndpoint,
        runtimeSelection: selectedRuntime,
      });

      await adapter.observeForwards({ forwards: [selectedForward] });

      expect(run).toHaveBeenCalledExactlyOnceWith(
        executable,
        buildCliOpenShellForwardListArgs(selectedForward),
        expect.any(Object),
      );
    },
  );

  it("rejects a batch whose forwards disagree on the exact gateway endpoint", async () => {
    const { adapter, run } = createHarness();

    await expect(
      adapter.observeForwards({
        forwards: [forward, { ...otherForward, gatewayEndpoint: "http://127.0.0.1:8080" }],
      }),
    ).resolves.toEqual([
      { state: "indeterminate", error: errors.validation },
      { state: "indeterminate", error: errors.validation },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a request whose endpoint differs from the adapter authority", async () => {
    const { adapter, run } = createHarness();

    await expect(
      adapter.observeForwards({
        forwards: [{ ...forward, gatewayEndpoint: "http://127.0.0.1:8080" }],
      }),
    ).resolves.toEqual([{ state: "indeterminate", error: errors.validation }]);
    expect(run).not.toHaveBeenCalled();
  });
});
