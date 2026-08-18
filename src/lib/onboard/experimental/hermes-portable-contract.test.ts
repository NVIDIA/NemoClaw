// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAgent } from "../../agent/defs";
import type { AgentDefinition } from "../../agent/definition-types";
import {
  assertCurrentHermesPortableStartupContract,
  resolveHermesPortableStartupContract,
} from "./hermes-portable-contract";

const SANDBOX = "alpha";
const temporaryDirectories: string[] = [];

function startupArgv(...extra: string[]): string[] {
  return [
    "env",
    `NEMOCLAW_SANDBOX_NAME=${SANDBOX}`,
    "NEMOCLAW_HERMES_API_PORT=8642",
    ...extra,
    "/usr/local/bin/nemoclaw-start",
  ];
}

function copyAgent(): AgentDefinition {
  const source = loadAgent("hermes");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-contract-"));
  temporaryDirectories.push(directory);
  const manifestPath = path.join(directory, "manifest.yaml");
  fs.copyFileSync(source.manifestPath, manifestPath);
  return { ...source, manifestPath };
}

function expectStartupCandidatesRejected(
  contract: ReturnType<typeof resolveHermesPortableStartupContract>,
  agent: AgentDefinition,
  candidates: readonly string[][],
): void {
  for (const candidateArgv of candidates) {
    expect(() =>
      assertCurrentHermesPortableStartupContract(contract, {
        agent,
        sandboxName: SANDBOX,
        startupArgv: candidateArgv,
      }),
    ).toThrow("current startup authority disagrees");
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Hermes portable startup contract", () => {
  it("derives Hermes startup, interactive, authenticated health, pairing, and state authority (#9203)", () => {
    const agent = copyAgent();
    const contract = resolveHermesPortableStartupContract({
      agent,
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    });

    expect(contract).toMatchObject({
      startupDescriptorSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      gatewayCommand: "hermes gateway run",
      interactiveCommand: "hermes",
      health: {
        url: "http://localhost:8642/health",
        port: 8642,
        auth: "bearer_token",
        credentialEnv: "API_SERVER_KEY",
        successStatus: 200,
      },
      devicePairing: false,
      configDir: "/sandbox/.hermes",
    });
  });

  it("rejects current manifest byte drift before reusing a receipt (#9203)", () => {
    const agent = copyAgent();
    const input = {
      agent,
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    };
    const contract = resolveHermesPortableStartupContract(input);
    fs.appendFileSync(agent.manifestPath, "\nfuture_required_startup_field: enabled\n");

    expect(() => assertCurrentHermesPortableStartupContract(contract, input)).toThrow(
      "current startup authority disagrees",
    );
  });

  it("rejects startup field addition, removal, or change during recovery (#9203)", () => {
    const agent = copyAgent();
    const contract = resolveHermesPortableStartupContract({
      agent,
      sandboxName: SANDBOX,
      startupArgv: startupArgv("NEMOCLAW_HERMES_DASHBOARD=0"),
    });

    expectStartupCandidatesRejected(contract, agent, [
      startupArgv(),
      startupArgv("NEMOCLAW_HERMES_DASHBOARD=1"),
      startupArgv("NEMOCLAW_HERMES_DASHBOARD=0", "NEMOCLAW_HERMES_DASHBOARD_TUI=0"),
    ]);
  });

  it.each([
    "API_SERVER_KEY=secret-value",
    "NEMOCLAW_SANDBOX_NAME=other",
    "NEMOCLAW_HERMES_API_PORT=8643",
    "NEMOCLAW_HERMES_DASHBOARD=$(touch /tmp/owned)",
    "UNREVIEWED_ENV=value",
  ])("rejects unsafe or unowned startup assignment %s (#9203)", (assignment) => {
    expect(() =>
      resolveHermesPortableStartupContract({
        agent: copyAgent(),
        sandboxName: SANDBOX,
        startupArgv: startupArgv(assignment),
      }),
    ).toThrow("Hermes portable startup contract");
  });

  it("rejects a credential-bearing proxy without persisting its value (#9203)", () => {
    expect(() =>
      resolveHermesPortableStartupContract({
        agent: copyAgent(),
        sandboxName: SANDBOX,
        startupArgv: startupArgv("HTTPS_PROXY=https://user:secret@proxy.example:8443"),
      }),
    ).toThrow("contains credentials");
  });
});
