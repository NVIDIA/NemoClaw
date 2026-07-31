// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LEAF_PEM, PEM } from "./__test-helpers__/corporate-ca-fixtures";
import {
  commitManagedStartupApplication,
  type ManagedStartupApplicationTestRuntime,
  prepareManagedStartupApplication,
} from "./managed-startup/application";
import {
  encodeManagedStartupProfile,
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  type ManagedStartupAgent,
  type ManagedStartupAgentConfig,
  type ManagedStartupProfile,
} from "./managed-startup/profile";

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function agentConfigFor(agent: ManagedStartupAgent): ManagedStartupAgentConfig {
  switch (agent) {
    case "openclaw":
      return {
        agent,
        webSearch: { enabled: false, provider: "brave" },
        otel: {
          enabled: false,
          endpointUrl: "http://host.openshell.internal:4318",
          serviceName: "openclaw-gateway",
          sampleRate: 1,
        },
        agentTimeoutSeconds: 900,
        heartbeatEvery: null,
        extraAgents: { agents: [], defaults: {}, main: {} },
        deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
        minimalBootstrap: true,
      };
    case "hermes":
      return { agent, webSearch: { enabled: false, provider: "tavily" } };
    case "langchain-deepagents-code":
      return { agent, autoApprovalMode: "thread-opt-in", observabilityEnabled: true };
  }
}

function profileFor(
  agent: ManagedStartupAgent,
  corporateCa: string | null = PEM,
): ManagedStartupProfile {
  const inference =
    agent === "openclaw"
      ? {
          routeProvider: "inference",
          upstreamProvider: "nvidia",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          routedBaseUrl: "https://inference.local/v1",
          upstreamEndpointUrl: null,
          api: "openai-responses" as const,
          primaryModelRef: "inference/nvidia/nemotron-3-ultra-550b-a55b",
          compatibility: null,
          inputModalities: ["text"] as const,
        }
      : {
          routeProvider: "inference",
          upstreamProvider: agent === "hermes" ? "nvidia" : "openrouter",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          routedBaseUrl: "https://inference.local/v1",
          upstreamEndpointUrl:
            agent === "langchain-deepagents-code" ? "https://openrouter.ai/api/v1" : null,
          api: "openai-completions" as const,
          primaryModelRef: null,
          compatibility: null,
          inputModalities: null,
        };
  const dashboard =
    agent === "openclaw"
      ? {
          agent,
          mode: "loopback" as const,
          url: "http://127.0.0.1:18789",
          port: 18_789,
          bindAddress: "127.0.0.1" as const,
          wslExposure: false,
        }
      : agent === "hermes"
        ? {
            agent,
            mode: "disabled" as const,
            url: "http://127.0.0.1:19189",
            publicPort: null,
            internalPort: null,
            tuiEnabled: false as const,
          }
        : {
            agent,
            mode: "disabled" as const,
          };
  return {
    schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
    agent,
    agentConfig: agentConfigFor(agent),
    inference,
    proxy: {
      managedHost: "10.200.0.1",
      managedPort: 3128,
      hostHttpUrl: null,
      hostHttpsUrl: null,
      hostNoProxy: [],
    },
    dashboard,
    tools: {
      disclosure: "progressive",
      enabledGateways: [],
    },
    messaging: { plan: null },
    tuning: {
      contextWindow: agent === "langchain-deepagents-code" ? null : 65_536,
      maxTokens: agent === "openclaw" ? 8192 : null,
      reasoning: agent === "openclaw" ? true : null,
      reasoningEffort: agent === "openclaw" ? "default" : null,
    },
    corporateCa: {
      bundleSha256: corporateCa === null ? null : sha256(corporateCa),
    },
  };
}

describe("managed startup application", () => {
  let fixtureRoot: string;
  let stateDirectory: string;
  let runtime: ManagedStartupApplicationTestRuntime;

  beforeEach(() => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-startup-"));
    fs.chmodSync(fixtureRoot, 0o700);
    stateDirectory = path.join(fixtureRoot, "state");
    runtime = {
      rootUid: process.getuid?.() ?? 0,
      rootGid: process.getgid?.() ?? 0,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  });

  function prepare(
    agent: ManagedStartupAgent,
    corporateCa: string | null = PEM,
    corporateCaB64: string | undefined = corporateCa === null
      ? undefined
      : Buffer.from(corporateCa, "utf8").toString("base64"),
  ) {
    return prepareProfile(profileFor(agent, corporateCa), corporateCaB64);
  }

  function prepareProfile(
    profile: ManagedStartupProfile,
    corporateCaB64: string | undefined = profile.corporateCa.bundleSha256 === null
      ? undefined
      : Buffer.from(PEM, "utf8").toString("base64"),
    targetStateDirectory: string = stateDirectory,
  ) {
    return prepareManagedStartupApplication(
      {
        encodedProfile: encodeManagedStartupProfile(profile),
        expectedAgent: profile.agent,
        corporateCaB64,
        stateDirectory: targetStateDirectory,
      },
      runtime,
    );
  }

  it("requires effective uid 0 before touching state", () => {
    vi.mocked(process.geteuid as () => number).mockReturnValue(1000);
    expect(() =>
      prepareManagedStartupApplication(
        {
          encodedProfile: encodeManagedStartupProfile(profileFor("openclaw")),
          expectedAgent: "openclaw",
          corporateCaB64: Buffer.from(PEM).toString("base64"),
          stateDirectory,
        },
        runtime,
      ),
    ).toThrow(/effective uid 0/u);
    expect(fs.existsSync(stateDirectory)).toBe(false);
  });

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("prepares and commits a root-owned envelope for %s", (agent) => {
    const prepared = prepare(agent);

    expect(prepared.status).toBe("prepared");
    expect(prepared.profile.agent).toBe(agent);
    expect(fs.existsSync(path.join(stateDirectory, "committed.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDirectory, "pending.json"))).toBe(true);
    expect(fs.readFileSync(prepared.profilePath, "utf8")).toBe(
      JSON.stringify(JSON.parse(fs.readFileSync(prepared.profilePath, "utf8"))),
    );
    expect(fs.readFileSync(prepared.corporateCaPath as string)).toEqual(Buffer.from(PEM));

    const stateStat = fs.statSync(stateDirectory);
    const profileStat = fs.statSync(prepared.profilePath);
    expect(stateStat.mode & 0o777).toBe(0o700);
    expect(profileStat.mode & 0o777).toBe(0o600);
    expect(profileStat.uid).toBe(runtime.rootUid);
    expect(profileStat.gid).toBe(runtime.rootGid);

    const committed = commitManagedStartupApplication(prepared, runtime);
    expect(committed.status).toBe("committed");
    expect(fs.existsSync(path.join(stateDirectory, "committed.json"))).toBe(true);
    expect(fs.existsSync(path.join(stateDirectory, "pending.json"))).toBe(false);
  });

  it("rejects a canonical profile for the wrong image agent", () => {
    expect(() =>
      prepareManagedStartupApplication(
        {
          encodedProfile: encodeManagedStartupProfile(profileFor("hermes")),
          expectedAgent: "openclaw",
          corporateCaB64: Buffer.from(PEM).toString("base64"),
          stateDirectory,
        },
        runtime,
      ),
    ).toThrow(/targets hermes, expected openclaw/u);
  });

  it("requires the CA transport exactly when the profile records a digest", () => {
    expect(() =>
      prepareManagedStartupApplication(
        {
          encodedProfile: encodeManagedStartupProfile(profileFor("openclaw")),
          expectedAgent: "openclaw",
          stateDirectory,
        },
        runtime,
      ),
    ).toThrow(/canonical standard base64/u);

    expect(() =>
      prepareManagedStartupApplication(
        {
          encodedProfile: encodeManagedStartupProfile(profileFor("openclaw", null)),
          expectedAgent: "openclaw",
          corporateCaB64: Buffer.from(PEM).toString("base64"),
          stateDirectory,
        },
        runtime,
      ),
    ).toThrow(/must be absent/u);

    const prepared = prepare("openclaw", null);
    expect(prepared.corporateCaPath).toBeNull();
  });

  it.each([
    {
      label: "non-canonical standard base64",
      pem: PEM,
      encoded: `${Buffer.from(PEM).toString("base64")}\n`,
      message: /canonical standard base64/u,
    },
    {
      label: "wrong digest",
      pem: PEM,
      profilePem: LEAF_PEM,
      encoded: Buffer.from(PEM).toString("base64"),
      message: /SHA-256 digest/u,
    },
    {
      label: "invalid X.509",
      pem: "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n",
      message: /invalid X\.509/u,
    },
    {
      label: "non-CA certificate",
      pem: LEAF_PEM,
      message: /CA:TRUE/u,
    },
    {
      label: "trailing material",
      pem: `${PEM}not-a-certificate`,
      message: /trailing non-PEM material/u,
    },
    {
      label: "too many certificates",
      pem: PEM.repeat(25),
      message: /1-24 PEM CA certificates/u,
    },
  ])("rejects a corporate CA with $label", ({ pem, encoded, message, ...testCase }) => {
    const profilePem =
      "profilePem" in testCase && typeof testCase.profilePem === "string"
        ? testCase.profilePem
        : encoded === undefined
          ? pem
          : PEM;
    expect(() =>
      prepareManagedStartupApplication(
        {
          encodedProfile: encodeManagedStartupProfile(profileFor("openclaw", profilePem)),
          expectedAgent: "openclaw",
          corporateCaB64: encoded ?? Buffer.from(pem).toString("base64"),
          stateDirectory,
        },
        runtime,
      ),
    ).toThrow(message);
  });

  it("rejects a symlinked state directory", () => {
    const redirected = path.join(fixtureRoot, "redirected");
    fs.mkdirSync(redirected, { mode: 0o700 });
    fs.symlinkSync(redirected, stateDirectory);

    expect(() => prepare("openclaw")).toThrow(/real directory/u);
  });

  it("rejects permissive or non-root-owned state components", () => {
    fs.mkdirSync(stateDirectory, { mode: 0o700 });
    fs.chmodSync(stateDirectory, 0o755);
    expect(() => prepare("openclaw")).toThrow(/mode 0700/u);

    fs.chmodSync(stateDirectory, 0o700);
    expect(() =>
      prepareManagedStartupApplication(
        {
          encodedProfile: encodeManagedStartupProfile(profileFor("openclaw")),
          expectedAgent: "openclaw",
          corporateCaB64: Buffer.from(PEM).toString("base64"),
          stateDirectory,
        },
        { ...runtime, rootUid: runtime.rootUid + 1 },
      ),
    ).toThrow(/root:root/u);
  });

  it("rejects hardlinked generation files before commit", () => {
    const prepared = prepare("openclaw");
    const outside = path.join(fixtureRoot, "outside-profile");
    fs.writeFileSync(outside, fs.readFileSync(prepared.profilePath), { mode: 0o600 });
    fs.unlinkSync(prepared.profilePath);
    fs.linkSync(outside, prepared.profilePath);

    expect(() => commitManagedStartupApplication(prepared, runtime)).toThrow(/hardlinked/u);
  });

  it("is idempotent for one committed fingerprint and rejects profile changes", () => {
    const first = prepare("openclaw");
    commitManagedStartupApplication(first, runtime);

    const repeated = prepare("openclaw");
    expect(repeated.status).toBe("already-committed");
    expect(() => commitManagedStartupApplication(repeated, runtime)).not.toThrow();

    const changed = {
      ...profileFor("openclaw"),
      inference: {
        ...profileFor("openclaw").inference,
        model: "nvidia/a-different-model",
        primaryModelRef: "inference/nvidia/a-different-model",
      },
    };
    expect(() =>
      prepareManagedStartupApplication(
        {
          encodedProfile: encodeManagedStartupProfile(changed),
          expectedAgent: "openclaw",
          corporateCaB64: Buffer.from(PEM).toString("base64"),
          stateDirectory,
        },
        runtime,
      ),
    ).toThrow(/recreate the sandbox/u);
  });

  it("recovers a crash before commit without accepting the profile as applied", () => {
    const first = prepare("hermes");
    const abandoned = path.join(stateDirectory, `.prepare-999-${"a".repeat(24)}`);
    fs.mkdirSync(abandoned, { mode: 0o700 });
    fs.writeFileSync(path.join(abandoned, "profile.json"), "partial", { mode: 0o600 });

    const recovered = prepare("hermes");
    expect(recovered.status).toBe("prepared");
    expect(recovered.fingerprint).toBe(first.fingerprint);
    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(path.join(stateDirectory, "committed.json"))).toBe(false);

    commitManagedStartupApplication(recovered, runtime);
    expect(fs.existsSync(path.join(stateDirectory, "committed.json"))).toBe(true);
  });

  it("recovers a complete generation left before pending-state publication", () => {
    const first = prepare("hermes");
    fs.unlinkSync(path.join(stateDirectory, "pending.json"));

    const recovered = prepare("hermes");
    expect(recovered.status).toBe("prepared");
    expect(recovered.generationDirectory).toBe(first.generationDirectory);
    expect(() => commitManagedStartupApplication(recovered, runtime)).not.toThrow();
  });

  it("recovers an atomic-control link left after publication", () => {
    const first = prepare("hermes");
    const pending = path.join(stateDirectory, "pending.json");
    const interruptedTemporary = path.join(stateDirectory, `.pending.json-${"a".repeat(24)}.tmp`);
    fs.linkSync(pending, interruptedTemporary);
    expect(fs.statSync(pending).nlink).toBe(2);

    const recovered = prepare("hermes");
    expect(recovered.fingerprint).toBe(first.fingerprint);
    expect(fs.existsSync(interruptedTemporary)).toBe(false);
    expect(fs.statSync(pending).nlink).toBe(1);
    expect(() => commitManagedStartupApplication(recovered, runtime)).not.toThrow();
  });

  it("does not let a different profile replace an active pending transaction", () => {
    const active = prepare("openclaw");
    const pendingBefore = fs.readFileSync(path.join(stateDirectory, "pending.json"), "utf8");
    const changed = {
      ...profileFor("openclaw"),
      inference: {
        ...profileFor("openclaw").inference,
        model: "nvidia/a-competing-model",
        primaryModelRef: "inference/nvidia/a-competing-model",
      },
    };

    expect(() => prepareProfile(changed)).toThrow(/different startup profile is already pending/u);
    expect(fs.readFileSync(path.join(stateDirectory, "pending.json"), "utf8")).toBe(pendingBefore);
    expect(fs.existsSync(active.generationDirectory)).toBe(true);
    expect(() => commitManagedStartupApplication(active, runtime)).not.toThrow();
  });

  it("uses compare-and-swap when two profiles interleave before pending publication", () => {
    const changed = {
      ...profileFor("openclaw"),
      inference: {
        ...profileFor("openclaw").inference,
        model: "nvidia/a-competing-model",
        primaryModelRef: "inference/nvidia/a-competing-model",
      },
    };
    const originalRenameSync = fs.renameSync.bind(fs);
    const race: { active: ReturnType<typeof prepare> | null } = { active: null };
    let interleaved = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      originalRenameSync(source, destination);
      void (!interleaved &&
      path.dirname(destination.toString()) === stateDirectory &&
      path.basename(destination.toString()).startsWith("generation-")
        ? (() => {
            interleaved = true;
            race.active = prepare("openclaw");
          })()
        : undefined);
    });

    expect(() => prepareProfile(changed)).toThrow(/won the pending-state transaction/u);
    expect(race.active).not.toBeNull();
    const winner = race.active as ReturnType<typeof prepare>;
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDirectory, "pending.json"), "utf8")),
    ).toMatchObject({ fingerprint: winner.fingerprint });
    expect(
      fs
        .readdirSync(stateDirectory)
        .filter((entry) => entry.startsWith("generation-"))
        .sort(),
    ).toEqual([path.basename(winner.generationDirectory)]);
    expect(() => commitManagedStartupApplication(winner, runtime)).not.toThrow();
  });

  it("rejects a delayed contender after the pending owner commits", () => {
    const changed = {
      ...profileFor("openclaw"),
      inference: {
        ...profileFor("openclaw").inference,
        model: "nvidia/a-delayed-competing-model",
        primaryModelRef: "inference/nvidia/a-delayed-competing-model",
      },
    };
    const originalOpenSync = fs.openSync.bind(fs);
    const race: { committed: ReturnType<typeof prepare> | null } = { committed: null };
    let interleaved = false;
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      void (!interleaved &&
      path.dirname(target.toString()) === stateDirectory &&
      /^\.pending\.json-[a-f0-9]{24}\.tmp$/u.test(path.basename(target.toString()))
        ? (() => {
            interleaved = true;
            race.committed = prepare("openclaw");
            commitManagedStartupApplication(race.committed, runtime);
          })()
        : undefined);
      return originalOpenSync(target, flags, mode);
    });

    expect(() => prepareProfile(changed)).toThrow(
      /different startup profile committed during pending-state publication/u,
    );
    expect(race.committed).not.toBeNull();
    const winner = race.committed as ReturnType<typeof prepare>;
    expect(fs.existsSync(path.join(stateDirectory, "pending.json"))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDirectory, "committed.json"), "utf8")),
    ).toMatchObject({ fingerprint: winner.fingerprint });
    expect(
      fs
        .readdirSync(stateDirectory)
        .filter((entry) => entry.startsWith("generation-"))
        .sort(),
    ).toEqual([path.basename(winner.generationDirectory)]);
  });

  it("makes committed state authoritative for a reader straddling pending publication", () => {
    const winner = prepare("openclaw");
    commitManagedStartupApplication(winner, runtime);
    const committedPath = path.join(stateDirectory, "committed.json");
    const committedBefore = fs.readFileSync(committedPath, "utf8");

    const changed = {
      ...profileFor("openclaw"),
      inference: {
        ...profileFor("openclaw").inference,
        model: "nvidia/a-straddling-competing-model",
        primaryModelRef: "inference/nvidia/a-straddling-competing-model",
      },
    };
    const competingStateDirectory = path.join(fixtureRoot, "competing-state");
    const competing = prepareProfile(changed, undefined, competingStateDirectory);
    const competingGeneration = path.join(
      stateDirectory,
      path.basename(competing.generationDirectory),
    );
    fs.renameSync(competing.generationDirectory, competingGeneration);
    fs.renameSync(
      path.join(competingStateDirectory, "pending.json"),
      path.join(stateDirectory, "pending.json"),
    );

    const originalLstatSync = fs.lstatSync.bind(fs);
    let hidInitialCommittedRead = false;
    vi.spyOn(fs, "lstatSync").mockImplementation((target) => {
      return !hidInitialCommittedRead && target.toString() === committedPath
        ? (() => {
            hidInitialCommittedRead = true;
            throw Object.assign(new Error("simulated pre-commit read"), { code: "ENOENT" });
          })()
        : originalLstatSync(target);
    });

    expect(() => prepareProfile(changed)).toThrow(
      /different startup profile is already committed/u,
    );
    expect(hidInitialCommittedRead).toBe(true);
    expect(fs.readFileSync(committedPath, "utf8")).toBe(committedBefore);
    expect(fs.existsSync(path.join(stateDirectory, "pending.json"))).toBe(false);
    expect(fs.existsSync(competingGeneration)).toBe(false);
    expect(fs.existsSync(winner.generationDirectory)).toBe(true);
  });

  it("never accepts a partial committed generation", () => {
    const prepared = prepare("langchain-deepagents-code");
    commitManagedStartupApplication(prepared, runtime);
    fs.truncateSync(prepared.profilePath, 10);

    expect(() => prepare("langchain-deepagents-code")).toThrow(
      /not valid JSON|canonical managed startup profile/u,
    );
  });
});
