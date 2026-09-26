// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAgent } from "../../agent/defs";
import type { AgentDefinition } from "../../agent/definition-types";
import {
  assertCurrentHermesPortableStoredStartupContract,
  assertCurrentHermesPortableStartupContract,
  resolveHermesPortableStartupContract,
} from "./hermes-portable-contract";

const SANDBOX = "alpha";
const PRE_DEFERRED_ONBOARDING_MANIFEST_SHA256 =
  "4600403d80c0ca038a89ac627f248a41148f1d97f649a49588a06b29427cee6c";
const PRE_UPGRADE_MANIFEST_SHA256 =
  "27453a10ca2e75f16ce5a1487192d11ac92b4d1752e8538131b5233c17a89d85";
const PRE_SKILLS_MANIFEST_SHA256 =
  "c7bcd6e0616904ab66c1f2f39a670d920cfb1b7ef7c1edc496e20e554db6a6c2";
const PRE_NATIVE_OWNERSHIP_MANIFEST_SHA256 =
  "e78822837d5530f61a26ea1d554d7f9b21be13e3e223e294f0999187dc0fa71e";
const temporaryDirectories: string[] = [];

function startupArgv(...extra: string[]): string[] {
  return startupArgvFor(SANDBOX, ...extra);
}

function startupArgvFor(sandboxName: string, ...extra: string[]): string[] {
  return [
    "env",
    "NEMOCLAW_HERMES_API_PORT=8642",
    `NEMOCLAW_SANDBOX_NAME=${sandboxName}`,
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

function setExpectedManifestVersion(
  agent: AgentDefinition,
  expectedVersion: string | undefined,
): void {
  const source = fs.readFileSync(agent.manifestPath, "utf8");
  const replacement =
    expectedVersion === undefined ? "" : `expected_version: ${JSON.stringify(expectedVersion)}`;
  fs.writeFileSync(agent.manifestPath, source.replace(/^expected_version:.*$/mu, replacement), {
    mode: 0o644,
  });
  agent.expected_version = expectedVersion;
}

function removeDeferredOnboardingMetadata(agent: AgentDefinition): void {
  const source = fs.readFileSync(agent.manifestPath, "utf8");
  const marker = "deferred_onboarding: true\n";
  expect(source.split(marker)).toHaveLength(2);
  fs.writeFileSync(agent.manifestPath, source.replace(marker, ""), { mode: 0o644 });
  agent.deferred_onboarding = false;
}

function restorePreviousReviewedManifest(agent: AgentDefinition): void {
  removeDeferredOnboardingMetadata(agent);
  const source = fs.readFileSync(agent.manifestPath, "utf8");
  const previous = source
    .replace('expected_version: "0.21.3"', 'expected_version: "0.20.6"')
    .replace("for example, `0.21.3`", "for example, `0.20.6`")
    .replace("(`v2026.9.14`)", "(`v2026.8.27`)");
  expect(previous).not.toBe(source);
  fs.writeFileSync(agent.manifestPath, previous, { mode: 0o644 });
  agent.expected_version = "0.20.6";
}

function removeReviewedSkillsMetadata(agent: AgentDefinition): void {
  const source = fs.readFileSync(agent.manifestPath, "utf8");
  const metadata = [
    "# Static integration metadata only. Hermes remains the authority on which",
    "# skills are visible or active.",
    "skills:",
    "  writable_root: /sandbox/.hermes/skills",
    "  list_command: [skills, list]",
    "",
    "",
  ].join("\n");
  expect(source.split(metadata)).toHaveLength(2);
  fs.writeFileSync(agent.manifestPath, source.replace(metadata, ""), { mode: 0o644 });
}

function removeReviewedNativeOwnershipMetadata(agent: AgentDefinition): void {
  const source = fs.readFileSync(agent.manifestPath, "utf8");
  const previous = source
    .replace("  - path: lazy-packages\n    clear_when_absent: false\n", "  - lazy-packages\n")
    .replace("  - path: plugins\n    clear_when_absent: false\n", "  - plugins\n");
  expect(previous).not.toBe(source);
  fs.writeFileSync(agent.manifestPath, previous, { mode: 0o644 });
  Object.defineProperty(agent, "stateDirectories", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: agent.stateDirectories.map((entry) =>
      entry.kind === "path" && ["lazy-packages", "plugins"].includes(entry.path)
        ? { ...entry, clearWhenAbsent: true }
        : entry,
    ),
  });
}

function expectStartupCandidatesRejected(
  contract: ReturnType<typeof resolveHermesPortableStartupContract>,
  agent: AgentDefinition,
  candidates: readonly string[][],
): void {
  candidates.forEach((candidateArgv) => {
    expect(() =>
      assertCurrentHermesPortableStartupContract(contract, {
        agent,
        sandboxName: SANDBOX,
        startupArgv: candidateArgv,
      }),
    ).toThrow("current startup authority disagrees");
  });
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
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
    expect(agent.expected_version).toBe("0.21.3");
  });

  it.each(["0.20.6", "0.21.3"] as const)(
    "accepts exact reviewed Hermes manifest version %s in the portable matrix (#9203)",
    (expectedVersion) => {
      const agent = copyAgent();
      setExpectedManifestVersion(agent, expectedVersion);
      const input = {
        agent,
        sandboxName: SANDBOX,
        startupArgv: startupArgv(),
      };
      const contract = resolveHermesPortableStartupContract(input);

      expect(assertCurrentHermesPortableStartupContract(contract, input)).toEqual(contract);
    },
  );

  it.each([undefined, "", "0.19.0"])(
    "rejects Hermes manifest version %j outside the accepted portable matrix (#9203)",
    (expectedVersion) => {
      const agent = copyAgent();
      setExpectedManifestVersion(agent, expectedVersion);

      expect(() =>
        resolveHermesPortableStartupContract({
          agent,
          sandboxName: SANDBOX,
          startupArgv: startupArgv(),
        }),
      ).toThrow("current Hermes manifest does not match the accepted lifecycle contract");
    },
  );

  it("rejects an accepted receipt when the current Hermes matrix version drifts (#9203)", () => {
    const accepted = copyAgent();
    const contract = resolveHermesPortableStartupContract({
      agent: accepted,
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    });
    setExpectedManifestVersion(accepted, "0.19.0");

    expect(() =>
      assertCurrentHermesPortableStartupContract(contract, {
        agent: accepted,
        sandboxName: SANDBOX,
        startupArgv: startupArgv(),
      }),
    ).toThrow("current Hermes manifest does not match the accepted lifecycle contract");
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
      startupArgv: startupArgv("NEMOCLAW_PROXY_HOST=proxy.internal"),
    });

    expectStartupCandidatesRejected(contract, agent, [
      startupArgv(),
      startupArgv("NEMOCLAW_PROXY_HOST=other.internal"),
      startupArgv("NEMOCLAW_PROXY_HOST=proxy.internal", "NEMOCLAW_PROXY_PORT=8080"),
    ]);
  });

  it("accepts the complete current stored startup contract during lifecycle recovery (#9203)", () => {
    const contract = resolveHermesPortableStartupContract({
      agent: loadAgent("hermes"),
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    });
    expect(() => assertCurrentHermesPortableStoredStartupContract(contract, SANDBOX)).not.toThrow();
  });

  it.each([
    {
      expectedManifestSha256: PRE_DEFERRED_ONBOARDING_MANIFEST_SHA256,
      prepare: removeDeferredOnboardingMetadata,
      startupDescriptorChanged: false,
    },
    {
      expectedManifestSha256: PRE_UPGRADE_MANIFEST_SHA256,
      prepare: restorePreviousReviewedManifest,
      startupDescriptorChanged: false,
    },
    {
      expectedManifestSha256: PRE_SKILLS_MANIFEST_SHA256,
      prepare: (agent: AgentDefinition) => {
        restorePreviousReviewedManifest(agent);
        removeReviewedSkillsMetadata(agent);
        removeReviewedNativeOwnershipMetadata(agent);
      },
      startupDescriptorChanged: true,
    },
    {
      expectedManifestSha256: PRE_NATIVE_OWNERSHIP_MANIFEST_SHA256,
      prepare: (agent: AgentDefinition) => {
        restorePreviousReviewedManifest(agent);
        removeReviewedNativeOwnershipMetadata(agent);
      },
      startupDescriptorChanged: true,
    },
  ])(
    "accepts reviewed manifest metadata transition $expectedManifestSha256 when startup authority is unchanged (#11248, #11766)",
    ({ expectedManifestSha256, prepare, startupDescriptorChanged }) => {
      const installedAgent = copyAgent();
      prepare(installedAgent);
      const installed = resolveHermesPortableStartupContract({
        agent: installedAgent,
        sandboxName: SANDBOX,
        startupArgv: startupArgv(),
      });
      const input = {
        agent: loadAgent("hermes"),
        sandboxName: SANDBOX,
        startupArgv: startupArgv(),
      };
      const current = resolveHermesPortableStartupContract(input);

      expect(installed.manifestSha256).toBe(expectedManifestSha256);
      expect(installed.startupDescriptorSha256 !== current.startupDescriptorSha256).toBe(
        startupDescriptorChanged,
      );
      expect(() =>
        assertCurrentHermesPortableStoredStartupContract(installed, SANDBOX),
      ).not.toThrow();
      expect(assertCurrentHermesPortableStartupContract(installed, input)).toEqual(current);
    },
  );

  it("derives reviewed transition descriptors for the actual sandbox name (#11766)", () => {
    const sandboxName = "hermes-portable-e2e";
    const installedAgent = copyAgent();
    restorePreviousReviewedManifest(installedAgent);
    removeReviewedSkillsMetadata(installedAgent);
    removeReviewedNativeOwnershipMetadata(installedAgent);
    const installed = resolveHermesPortableStartupContract({
      agent: installedAgent,
      sandboxName,
      startupArgv: startupArgvFor(sandboxName),
    });
    const input = {
      agent: loadAgent("hermes"),
      sandboxName,
      startupArgv: startupArgvFor(sandboxName),
    };
    const current = resolveHermesPortableStartupContract(input);

    expect(installed.startupDescriptorSha256).not.toBe(current.startupDescriptorSha256);
    expect(() =>
      assertCurrentHermesPortableStoredStartupContract(installed, sandboxName),
    ).not.toThrow();
    expect(assertCurrentHermesPortableStartupContract(installed, input)).toEqual(current);
  });

  it("rejects unreviewed manifest transitions with an unchanged startup descriptor (#11248)", () => {
    const current = resolveHermesPortableStartupContract({
      agent: loadAgent("hermes"),
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    });

    expect(() =>
      assertCurrentHermesPortableStoredStartupContract(
        { ...current, manifestSha256: "0".repeat(64) },
        SANDBOX,
      ),
    ).toThrow("current startup authority disagrees");
  });

  it("rejects security authority drift during the reviewed manifest transition (#11248)", () => {
    const current = resolveHermesPortableStartupContract({
      agent: loadAgent("hermes"),
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    });

    expect(() =>
      assertCurrentHermesPortableStoredStartupContract(
        {
          ...current,
          manifestSha256: PRE_SKILLS_MANIFEST_SHA256,
          stateIdentitySha256: "0".repeat(64),
        },
        SANDBOX,
      ),
    ).toThrow("current startup authority disagrees");
  });

  it.each([
    {
      argv: [
        "env",
        `NEMOCLAW_SANDBOX_NAME=${SANDBOX}`,
        "NEMOCLAW_HERMES_API_PORT=8642",
        "/usr/local/bin/nemoclaw-start",
      ],
    },
    { argv: startupArgv("NEMOCLAW_PROXY_HOST=proxy.internal") },
  ])("rejects stored startup renderer drift %# during lifecycle recovery (#9203)", ({ argv }) => {
    const contract = resolveHermesPortableStartupContract({
      agent: loadAgent("hermes"),
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    });

    expect(() =>
      assertCurrentHermesPortableStoredStartupContract({ ...contract, argv }, SANDBOX),
    ).toThrow("current startup authority disagrees");
  });

  it.each([
    "API_SERVER_KEY=secret-value",
    "NEMOCLAW_SANDBOX_NAME=other",
    "NEMOCLAW_HERMES_API_PORT=8643",
    "CHAT_UI_URL=http://127.0.0.1:8643/",
    "NEMOCLAW_HERMES_DASHBOARD=0",
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

  it.each([
    "HTTPS_PROXY=https://proxy.example/?token=do-not-store",
    "HTTPS_PROXY=https://proxy.example/path/do-not-store",
    "CHAT_UI_URL=https://dashboard.example/#do-not-store",
    "HTTP_PROXY=file:///tmp/do-not-store",
  ])("rejects durable URL components that could carry credentials: %s (#9203)", (assignment) => {
    let error: unknown;
    try {
      resolveHermesPortableStartupContract({
        agent: copyAgent(),
        sandboxName: SANDBOX,
        startupArgv: startupArgv(assignment),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("do-not-store");
  });
});
