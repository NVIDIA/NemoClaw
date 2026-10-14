// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { createExtraGatewayProvider } from "../fixtures/gateway-providers.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";

const TOKEN_ENV = "NEMOCLAW_E2E_EXTRA_PROVIDER_TOKEN";
const TOKEN = "fixture-secret-value";
const PROFILE_ID = "nemoclaw-e2e-extra-provider-v1";

type Step = { operation: "import" | "export" | "create"; result: ShellProbeResult };

function probe(exitCode: number, stdout = "", stderr = ""): ShellProbeResult {
  return {
    command: ["openshell"],
    durationMs: 1,
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: { stdout: "stdout", stderr: "stderr", result: "result" },
  };
}

function matchingExport(): string {
  const source = fs.readFileSync(
    new URL("../fixtures/provider-profiles/nemoclaw-e2e-extra-provider-v1.yaml", import.meta.url),
    "utf8",
  );
  return JSON.stringify(YAML.parse(source));
}

function gateway(steps: Step[]) {
  const remaining = [...steps];
  const events: string[] = [];
  const command = vi.fn<HostCliClient["command"]>(
    async (_command, args = [], options: ShellProbeRunOptions = {}) => {
      const step = remaining.shift()!;
      expect(args).toEqual(expect.arrayContaining(["-g", "nemoclaw", step.operation]));
      expect(args.join(" ")).not.toContain(TOKEN);
      expect(options.redactionValues).toContain(TOKEN);
      expect(options.env?.[TOKEN_ENV]).toBe(step.operation === "create" ? TOKEN : undefined);
      events.push(step.operation);
      return step.result;
    },
  );
  const host = {
    command,
    openshellCommandPath: "/usr/local/bin/openshell",
  } as unknown as HostCliClient;
  const create = () =>
    createExtraGatewayProvider(host, "e2e-extra-provider", {
      artifactName: "extra-provider",
      env: { [TOKEN_ENV]: TOKEN },
    });
  return { command, create, events, remaining };
}

describe("E2E extra-provider profile", () => {
  it("imports and verifies the restricted profile before provider creation (#12940)", async () => {
    const fixture = gateway([
      { operation: "import", result: probe(0) },
      { operation: "export", result: probe(0, matchingExport()) },
      { operation: "create", result: probe(0) },
    ]);
    await fixture.create();
    expect(fixture.events).toEqual(["import", "export", "create"]);
    expect(fixture.remaining).toEqual([]);
    const createArgs = fixture.command.mock.calls[2][1]!;
    expect(createArgs[createArgs.indexOf("--type") + 1]).toBe(PROFILE_ID);
    expect(createArgs[createArgs.indexOf("--credential") + 1]).toBe(TOKEN_ENV);
  });

  it("reuses a matching imported profile before provider creation (#12940)", async () => {
    const fixture = gateway([
      { operation: "import", result: probe(1, "", "already exists") },
      { operation: "export", result: probe(0, matchingExport()) },
      { operation: "create", result: probe(0) },
    ]);
    await fixture.create();
    expect(fixture.events).toEqual(["import", "export", "create"]);
  });

  it("refuses a conflicting profile before provider creation (#12940)", async () => {
    const fixture = gateway([
      { operation: "import", result: probe(1, "", "already exists") },
      {
        operation: "export",
        result: probe(
          0,
          JSON.stringify({
            id: PROFILE_ID,
            credentials: [],
            endpoints: [],
            binaries: [],
            inference_capable: false,
          }),
        ),
      },
    ]);
    await expect(fixture.create()).rejects.toThrow("does not match");
    expect(fixture.events).toEqual(["import", "export"]);
  });

  it("stops when profile import fails (#12940)", async () => {
    const fixture = gateway([{ operation: "import", result: probe(1, "", "import failed") }]);
    await expect(fixture.create()).rejects.toThrow("Could not import");
    expect(fixture.events).toEqual(["import"]);
  });

  it("stops when profile export fails after import (#12940)", async () => {
    const fixture = gateway([
      { operation: "import", result: probe(0) },
      { operation: "export", result: probe(1, "", "export failed") },
    ]);
    await expect(fixture.create()).rejects.toThrow("does not match");
    expect(fixture.events).toEqual(["import", "export"]);
  });

  it("stops when provider creation fails after profile verification (#12940)", async () => {
    const fixture = gateway([
      { operation: "import", result: probe(0) },
      { operation: "export", result: probe(0, matchingExport()) },
      { operation: "create", result: probe(1, "", "create failed") },
    ]);
    await expect(fixture.create()).rejects.toThrow("Could not create the E2E extra provider.");
    expect(fixture.events).toEqual(["import", "export", "create"]);
    expect(fixture.command).toHaveBeenCalledTimes(3);
    expect(fixture.remaining).toEqual([]);
  });

  it("stops before profile import when the credential is absent (#12940)", async () => {
    const fixture = gateway([]);
    await expect(
      createExtraGatewayProvider(
        { command: fixture.command, openshellCommandPath: "openshell" } as unknown as HostCliClient,
        "e2e-extra-provider",
        { artifactName: "extra-provider", env: {} },
      ),
    ).rejects.toThrow(`Missing provider credential env value: ${TOKEN_ENV}`);
    expect(fixture.events).toEqual([]);
  });
});
