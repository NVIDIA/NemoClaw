// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HermesAcpSshTransport } from "../adapters/openshell/hermes-acp-ssh";
import type { OpenShellSandboxObserver } from "../adapters/openshell/sandbox-observer";
import type { HostGatewayRegistryEntry } from "../state/gateway-registry";
import { parseHermesAcpCommandArgs, resolveHermesAcpTarget, runHermesAcpCommand } from "./command";

const FINGERPRINT = "a".repeat(64);
const VERSION = "0.0.120-44-g8fed029c7a";

function registryEntry(
  name: string,
  gatewayPort = 8080,
  overrides: Record<string, unknown> = {},
): HostGatewayRegistryEntry {
  const gatewayName = gatewayPort === 8080 ? "nemoclaw" : `nemoclaw-${String(gatewayPort)}`;
  return {
    gatewayPort,
    registryFile: `/home/operator/.nemoclaw/${String(gatewayPort)}/sandboxes.json`,
    stateRoot: `/home/operator/.nemoclaw/${String(gatewayPort)}`,
    entry: {
      name,
      agent: "hermes",
      agentVersion: "0.20.6",
      fromDockerfile: null,
      gatewayName,
      gatewayPort,
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: FINGERPRINT,
      nemoclawVersion: VERSION,
      openshellVersion: "0.0.106",
      ...overrides,
    },
  };
}

function collector(): { stream: Writable; text: () => string } {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += String(chunk);
        callback();
      },
    }),
    text: () => value,
  };
}

function readyObserver(readiness: "ready" | "not_ready" | "terminal" = "ready") {
  return {
    listSandboxes: vi.fn(async () => ({
      ok: true as const,
      value: { sandboxes: [{ name: "alpha", phase: "Ready", readiness }] },
    })),
  } satisfies OpenShellSandboxObserver;
}

function commandHarness(
  overrides: {
    entries?: HostGatewayRegistryEntry[];
    fingerprint?: string;
    observer?: OpenShellSandboxObserver;
    recovered?: boolean;
    transport?: HermesAcpSshTransport;
  } = {},
) {
  const output = collector();
  const diagnostics = collector();
  const recoverGateway = vi.fn(async () => ({
    recovered: overrides.recovered ?? true,
    attempted: true,
    before: { state: "missing_named" },
    after: { state: overrides.recovered === false ? "missing_named" : "healthy_named" },
  }));
  const transport =
    overrides.transport ??
    ({
      run: vi.fn(async () => ({ kind: "completed" as const, exitCode: 0 })),
    } satisfies HermesAcpSshTransport);
  return {
    diagnostics,
    output,
    recoverGateway,
    transport,
    run: (argv: string[]) =>
      runHermesAcpCommand(
        argv,
        {
          input: Readable.from(["request"]),
          output: output.stream,
          diagnostics: diagnostics.stream,
        },
        {
          currentVersion: () => VERSION,
          home: () => "/home/operator",
          inspectIdentity: vi.fn(() => overrides.fingerprint ?? FINGERPRINT),
          listRegistry: vi.fn(() => overrides.entries ?? [registryEntry("alpha")]),
          observer: overrides.observer ?? readyObserver(),
          recoverGateway: recoverGateway as never,
          transport,
        },
      ),
  };
}

describe("Hermes ACP command", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses an explicit target and bounded timeout", () => {
    expect(
      parseHermesAcpCommandArgs([
        "--sandbox",
        "alpha",
        "--gateway",
        "nemoclaw-8090",
        "--timeout",
        "30",
      ]),
    ).toEqual({
      gatewayName: "nemoclaw-8090",
      mode: "run",
      sandboxName: "alpha",
      timeoutMs: 30_000,
    });
  });

  it.each([
    [["--sandbox", "bad name"], "invalid name"],
    [["--sandbox", "alpha", "--gateway", "other"], "invalid NemoClaw gateway"],
    [["--sandbox", "alpha", "--timeout", "0"], "positive integer"],
    [["--sandbox", "alpha", "--timeout", "86401"], "must not exceed"],
    [["--sandbox", "alpha", "--unknown"], "Unknown option"],
  ])("rejects unsafe arguments %j", (argv, message) => {
    expect(() => parseHermesAcpCommandArgs(argv)).toThrow(message);
  });

  it("selects one compatible sandbox on its recorded gateway", () => {
    const resolved = resolveHermesAcpTarget([registryEntry("alpha", 8090)], {
      gatewayName: "nemoclaw-8090",
      sandboxName: "alpha",
      nemoclawVersion: VERSION,
    });

    expect(resolved).toMatchObject({
      ok: true,
      target: { gatewayName: "nemoclaw-8090", gatewayPort: 8090, sandboxName: "alpha" },
    });
  });

  it.each([
    ["missing", [], "missing"],
    ["ambiguous", [registryEntry("alpha"), registryEntry("alpha", 8090)], "ambiguous"],
    [
      "stale NemoClaw",
      [registryEntry("alpha", 8080, { nemoclawVersion: "other" })],
      "incompatible",
    ],
    ["wrong Hermes", [registryEntry("alpha", 8080, { agentVersion: "0.20.5" })], "incompatible"],
    [
      "custom image",
      [registryEntry("alpha", 8080, { fromDockerfile: "/tmp/Dockerfile" })],
      "incompatible",
    ],
    [
      "missing identity",
      [registryEntry("alpha", 8080, { lifecycleLiveIdentityFingerprint: null })],
      "incompatible",
    ],
  ])("classifies a %s registry target", (_label, entries, error) => {
    expect(
      resolveHermesAcpTarget(entries, { sandboxName: "alpha", nemoclawVersion: VERSION }),
    ).toMatchObject({ ok: false, error });
  });

  it("recovers the recorded gateway, validates live identity, and starts one transport", async () => {
    const fixture = commandHarness();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    fixture.recoverGateway.mockImplementationOnce(async () => {
      console.log("gateway lifecycle progress must not reach ACP stdout");
      return {
        recovered: true,
        attempted: true,
        before: { state: "missing_named" },
        after: { state: "healthy_named" },
      } as never;
    });

    expect(await fixture.run(["--sandbox", "alpha"])).toBe(0);

    expect(consoleLog).not.toHaveBeenCalled();
    expect(fixture.output.text()).toBe("");
    expect(fixture.diagnostics.text()).toBe("");
    expect(fixture.recoverGateway).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      runtimeSelection: { gatewayName: "nemoclaw", workspace: "default" },
    });
    expect(fixture.transport.run).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      streams: expect.objectContaining({ input: expect.any(Readable) }),
    });
  });

  it.each([
    ["stopped", readyObserver("not_ready"), FINGERPRINT, "stopped or not ready"],
    ["terminal", readyObserver("terminal"), FINGERPRINT, "stopped or not ready"],
    ["changed identity", readyObserver(), "b".repeat(64), "identity does not match"],
  ])("rejects a %s live sandbox", async (_label, observer, fingerprint, message) => {
    const fixture = commandHarness({ observer, fingerprint });

    expect(await fixture.run(["--sandbox", "alpha"])).toBe(1);

    expect(fixture.diagnostics.text()).toContain(message);
    expect(fixture.transport.run).not.toHaveBeenCalled();
  });

  it("rejects a gateway that recovery cannot make ready", async () => {
    const fixture = commandHarness({ recovered: false });

    expect(await fixture.run(["--sandbox", "alpha"])).toBe(1);

    expect(fixture.diagnostics.text()).toContain("gateway is not ready");
    expect(fixture.transport.run).not.toHaveBeenCalled();
  });

  it("rejects an endpoint override before gateway recovery", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://untrusted.invalid");
    const fixture = commandHarness();

    expect(await fixture.run(["--sandbox", "alpha"])).toBe(1);

    expect(fixture.diagnostics.text()).toBe(
      "OPENSHELL_GATEWAY_ENDPOINT must be unset before starting the ACP adapter.\n",
    );
    expect(fixture.recoverGateway).not.toHaveBeenCalled();
  });

  it("reduces registry and transport exceptions to fixed diagnostics", async () => {
    const output = collector();
    const diagnostics = collector();
    const exitCode = await runHermesAcpCommand(
      ["--sandbox", "alpha"],
      { input: Readable.from([]), output: output.stream, diagnostics: diagnostics.stream },
      {
        currentVersion: () => VERSION,
        home: () => "/home/operator",
        listRegistry: () => {
          throw new Error("Authorization: Bearer <fixture> ACP request payload");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(diagnostics.text()).toBe("NemoClaw could not safely inspect the sandbox registry.\n");
    expect(diagnostics.text()).not.toMatch(/Bearer|payload|secret/u);
  });
});
