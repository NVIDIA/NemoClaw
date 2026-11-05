// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../helpers/onboard-script-mocks.cjs";
import { createConnectHarness } from "../../support/connect-flow-test-harness";
import { launchReadinessRegistryFixture } from "../../helpers/launch-readiness-fixture";
import { CLI, runCliScriptAsync, runWithEnv } from "../../cli/helpers";

const ownerName = "nemoclaw-8245";
const ownerPort = 8245;
const homes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  homes.splice(0).forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
});

function createFixture(namedOwner = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-owner-diagnostic-"));
  homes.push(home);
  const bin = path.join(home, "bin");
  const calls = path.join(home, "openshell-calls");
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, "");
  fs.writeFileSync(path.join(bin, "docker"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  const registries = [
    { name: "healthy-b", port: 8080, gateway: "nemoclaw", directory: ".nemoclaw" },
    {
      name: "failure-a",
      port: ownerPort,
      gateway: ownerName,
      directory: ".nemoclaw/gateways/8245",
    },
  ].map(({ name, port, gateway, directory }) => {
    const root = path.join(home, directory);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "sandboxes.json");
    const contents = JSON.stringify({
      sandboxes: {
        [name]: {
          ...launchReadinessRegistryFixture(),
          name,
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          gatewayName: port === ownerPort && !namedOwner ? undefined : gateway,
          gatewayPort: port,
        },
      },
      defaultSandbox: name,
    });
    fs.writeFileSync(file, contents, { mode: 0o600 });
    return { file, contents };
  });
  fs.writeFileSync(
    path.join(bin, "openshell"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$HOME/openshell-calls"',
      'case "$*" in',
      '  "--version") echo "openshell 0.0.116"; exit 0 ;;',
      '  "status") echo "Gateway: nemoclaw"; exit 0 ;;',
      '  "gateway info -g nemoclaw") echo "Name: nemoclaw"; exit 0 ;;',
      '  *nemoclaw-8245*) echo "error trying to connect: connection refused" >&2; exit 1 ;;',
      '  "sandbox get -g nemoclaw healthy-b") printf "Id: abc\\nName: healthy-b\\nPhase: Ready\\n"; exit 0 ;;',
      '  "sandbox list -g nemoclaw") echo "healthy-b Ready"; exit 0 ;;',
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    home,
    calls,
    registries,
    env: { HOME: home, PATH: `${bin}:${process.env.PATH || ""}`, NEMOCLAW_GATEWAY_PORT: "8080" },
  };
}

describe("owning gateway diagnostics (#10656)", () => {
  it("names the recorded owner when public status cannot reach a sibling gateway", () => {
    const fixture = createFixture();

    const result = runWithEnv("failure-a status", fixture.env);

    expect(result.code).toBe(1);
    expect(result.out).toContain(ownerName);
    expect(result.out).not.toContain("does not exist");
    expect(result.out).not.toContain("not registered");
    const calls = fs.readFileSync(fixture.calls, "utf8");
    expect(calls).toContain(`gateway select ${ownerName}`);
    expect(calls).not.toContain("-g nemoclaw ");
    fixture.registries.forEach(({ file, contents }) =>
      expect(fs.readFileSync(file, "utf8")).toBe(contents),
    );
  });

  it.each([
    ["failure-a status", "8080", ownerName, true, true],
    ["failure-a status", "8080", String(ownerPort), true, false],
    ["sandbox status unregistered", "8446", "not recorded", false, true],
  ] as const)(
    "reports the recorded gateway before an RPC status exit for %s [case %#]",
    async (args, port, target, registered, namedOwner) => {
      const fixture = createFixture(namedOwner);
      const snapshotModule = path.resolve("dist/lib/actions/sandbox/status-snapshot.js");
      const script = `
      const snapshot = require(${JSON.stringify(snapshotModule)});
      snapshot.collectSandboxStatusSnapshot = async (_name, options) => ({
        sb: options.sandboxEntry, lookup: { state: "present", phase: "Ready" },
        rpcIssue: { kind: "protobuf_mismatch", output: "fixture schema mismatch" },
        currentModel: "test-model", currentProvider: "nvidia-prod",
        routeDrift: null, llamaCpp: null, inferenceHealth: null,
        terminalRuntimeHealth: null, servingProcessHealth: null,
      });
      require(${JSON.stringify(CLI)});
    `;

      const scriptPath = path.join(fixture.home, "status-fixture.cjs");
      fs.writeFileSync(scriptPath, script);
      const result = await runCliScriptAsync(scriptPath, args, {
        env: { ...fixture.env, NEMOCLAW_GATEWAY_PORT: port },
      });

      expect(result.code).toBe(1);
      expect(result.out).toMatch(
        registered ? /^Failure layer: docker_unreachable/ : /Recorded gateway:/,
      );
      expect(result.out).toContain(`Recorded gateway: ${target}`);
      expect(result.out).not.toContain("does not exist");
      expect(result.out).not.toContain("not registered");
      fixture.registries.forEach(({ file, contents }) =>
        expect(fs.readFileSync(file, "utf8")).toBe(contents),
      );
    },
  );

  it("names the recorded owner when public recovery refuses unsafe readiness authority", async () => {
    const fixture = createFixture();
    const readinessModule = path.resolve("dist/lib/actions/sandbox/launch-readiness.js");
    const script = `
      const readiness = require(${JSON.stringify(readinessModule)});
      readiness.inspectLaunchReadiness = async () => ({
        kind: "fallback", category: "unsafe", fence: null,
        gatewayName: ${JSON.stringify(ownerName)}, gatewayPort: ${ownerPort},
        fenceFailed: true, recoveryBlocked: true,
      });
      require(${JSON.stringify(CLI)});
    `;

    const scriptPath = path.join(fixture.home, "recover-fixture.cjs");
    fs.writeFileSync(scriptPath, script);
    const result = await runCliScriptAsync(scriptPath, "failure-a recover", { env: fixture.env });

    expect(result.code).toBe(1);
    expect(result.out).toContain(`Target gateway: ${ownerName}`);
    expect(result.out).toContain("prior launch-readiness evidence could not be fenced");
    expect(result.out).not.toContain("does not exist");
    expect(result.out).not.toContain("not registered");
    expect(fs.readFileSync(fixture.calls, "utf8")).toBe("");
    fixture.registries.forEach(({ file, contents }) =>
      expect(fs.readFileSync(file, "utf8")).toBe(contents),
    );
  });

  it.each(["fence", "mutation gate", "validation", "publication"] as const)(
    "names the owner and retains the refusal at %s",
    async (stage) => {
      vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });
      const harness = createConnectHarness({
        registryEntry: { gatewayName: ownerName, gatewayPort: ownerPort },
        readinessDecision: {
          kind: "fallback",
          category: "unsafe",
          fence: null,
          gatewayName: ownerName,
          gatewayPort: ownerPort,
          fenceFailed: stage === "fence",
          recoveryBlocked: stage === "fence",
        },
        readinessPublicationResult:
          stage === "validation"
            ? { kind: "validation-failed", category: "health" }
            : { kind: "evidence-failed" },
      });
      stage === "mutation gate" &&
        harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({ kind: "unsafe" });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
        "process.exit(1)",
      );

      const output = [...harness.logSpy.mock.calls, ...harness.errorSpy.mock.calls]
        .flat()
        .join("\n");
      expect(output).toContain(`Target gateway: ${ownerName}`);
      expect(output).not.toContain("Target gateway: nemoclaw\n");
      expect(harness.checkAndRecoverSpy.mock.calls).toHaveLength(
        stage === "fence" || stage === "mutation gate" ? 0 : 1,
      );
    },
  );

  it("reports a selected target without inventing an owner for an unregistered sandbox", async () => {
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const harness = createConnectHarness({
      registryEntries: [],
      readinessDecision: {
        kind: "fallback",
        category: "missing",
        fence: null,
        gatewayName: null,
        gatewayPort: null,
        fenceFailed: true,
        recoveryBlocked: true,
      },
    });

    await expect(harness.connectSandbox("unregistered", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const output = [...harness.logSpy.mock.calls, ...harness.errorSpy.mock.calls].flat().join("\n");
    expect(output).toMatch(/Target gateway: nemoclaw(?:-\d+)?/);
    expect(output).not.toContain("Owning gateway");
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
  });
});
