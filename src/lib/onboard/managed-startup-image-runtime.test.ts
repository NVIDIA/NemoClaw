// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { mapManagedStartupProfileToAgentEnvironment } from "./managed-startup/agent-environment";
import {
  buildManagedStartupImageActionPlan,
  MANAGED_STARTUP_MERGED_CA_FILE,
  normalizeHermesManagedConfigDescriptor,
  readStableRegularFile,
  serializeManagedStartupCompletionMarker,
  serializeManagedStartupRuntimeEnvironment,
  verifyManagedStartupImageCompletion,
} from "./managed-startup/image-runtime";
import {
  fingerprintManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile";

const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

describe("managed startup image runtime", () => {
  let temporaryDirectoryPath = "";

  beforeEach(() => {
    temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-startup-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryDirectoryPath, { force: true, recursive: true });
  });

  function temporaryDirectory(): string {
    return temporaryDirectoryPath;
  }

  function mockDescriptorOwnership(uid: bigint, gid: bigint): void {
    const realFstatSync = fs.fstatSync.bind(fs);
    const realLstatSync = fs.lstatSync.bind(fs);
    const ownership = new Map<PropertyKey, unknown>([
      ["uid", uid],
      ["gid", gid],
    ]);
    const owned = (stat: fs.BigIntStats): fs.BigIntStats =>
      new Proxy(stat, {
        get(inner, property) {
          const value = ownership.has(property)
            ? ownership.get(property)
            : (Reflect.get(inner, property, inner) as unknown);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor: number, options: { bigint: true }) =>
      owned(realFstatSync(descriptor, options))) as typeof fs.fstatSync);
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options: { bigint: true }) =>
      owned(realLstatSync(file, options))) as typeof fs.lstatSync);
  }

  function writeCompletionFixture(
    profile: ManagedStartupProfile,
    corporateCaMerged = false,
  ): {
    readonly agent: ManagedStartupAgent;
    readonly completionFile: string;
    readonly fingerprint: string;
    readonly runtimeEnvironmentFile: string;
  } {
    const mapped = mapManagedStartupProfileToAgentEnvironment(profile);
    const runtimeEnvironment = serializeManagedStartupRuntimeEnvironment(
      mapped.runtimeEnvironment,
      corporateCaMerged,
      mapped.configurationEnvironment,
    );
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const completionFile = path.join(temporaryDirectory(), "managed-startup-complete.json");
    const runtimeEnvironmentFile = path.join(temporaryDirectory(), "managed-startup-runtime.env");
    fs.writeFileSync(runtimeEnvironmentFile, runtimeEnvironment, { mode: 0o444 });
    fs.chmodSync(runtimeEnvironmentFile, 0o444);
    fs.writeFileSync(
      completionFile,
      serializeManagedStartupCompletionMarker({
        schemaVersion: 1,
        agent: profile.agent,
        profileFingerprint: fingerprint,
        runtimeEnvironmentSha256: createHash("sha256")
          .update(runtimeEnvironment, "utf8")
          .digest("hex"),
        corporateCaMerged,
      }),
      { mode: 0o444 },
    );
    fs.chmodSync(completionFile, 0o444);
    return {
      agent: profile.agent,
      completionFile,
      fingerprint,
      runtimeEnvironmentFile,
    };
  }

  it.each([
    "openclaw",
    "hermes",
  ] as const)("maps the complete %s profile to an offline messaging and config action plan", (agent) => {
    const profile = managedStartupE2eProfile(agent);
    const mapped = mapManagedStartupProfileToAgentEnvironment(profile);
    const plan = buildManagedStartupImageActionPlan(mapped);

    expect(plan.some((command) => command.argv.includes("agent-install"))).toBe(false);
    expect(
      plan.some((command) =>
        command.argv.some((argument) => /^(?:npm|npx|pip|pip3|uv)$/u.test(argument)),
      ),
    ).toBe(false);
    expect(plan.map(({ action, runAs }) => ({ action, runAs }))).toEqual([
      { action: "messaging-runtime-setup", runAs: "root" },
      { action: "generate-agent-config", runAs: "sandbox" },
      { action: "messaging-post-agent-install", runAs: "sandbox" },
    ]);
    expect(plan[0]?.argv).toContain("runtime-setup");
    expect(plan[2]?.argv).toContain("post-agent-install");
    expect(plan[0]?.argv).not.toContain("--managed-startup-runtime");
    expect(plan[2]?.argv).toContain("--managed-startup-runtime");
  });

  it("maps the complete DCode profile to its offline config action plan", () => {
    const agent = "langchain-deepagents-code";
    const profile = managedStartupE2eProfile(agent);
    const mapped = mapManagedStartupProfileToAgentEnvironment(profile);
    const plan = buildManagedStartupImageActionPlan(mapped);

    expect(plan.some((command) => command.argv.includes("agent-install"))).toBe(false);
    expect(
      plan.some((command) =>
        command.argv.some((argument) => /^(?:npm|npx|pip|pip3|uv)$/u.test(argument)),
      ),
    ).toBe(false);
    expect(plan).toEqual([
      {
        action: "generate-agent-config",
        runAs: "sandbox",
        argv: [
          "/usr/local/bin/node",
          "--experimental-strip-types",
          "/opt/nemoclaw-deepagents-code/generate-config.ts",
        ],
      },
    ]);
  });

  it.each(
    MANAGED_STARTUP_AGENTS,
  )("provides valid same-profile and changed-profile fixtures for %s recreation checks", (agent) => {
    const initial = validateManagedStartupProfile(managedStartupE2eProfile(agent));
    const same = validateManagedStartupProfile(managedStartupE2eProfile(agent));
    const changed = validateManagedStartupProfile(managedStartupE2eProfile(agent, true));

    expect(fingerprintManagedStartupProfile(same)).toBe(fingerprintManagedStartupProfile(initial));
    expect(fingerprintManagedStartupProfile(changed)).not.toBe(
      fingerprintManagedStartupProfile(initial),
    );
  });

  it.each(
    MANAGED_STARTUP_AGENTS,
  )("accepts the root completion marker and exact runtime handoff for %s", (agent) => {
    const fixture = writeCompletionFixture(managedStartupE2eProfile(agent));
    mockDescriptorOwnership(0n, 0n);
    expect(
      verifyManagedStartupImageCompletion(
        agent,
        fixture.fingerprint,
        fixture.completionFile,
        fixture.runtimeEnvironmentFile,
      ),
    ).toEqual({ agent, fingerprint: fixture.fingerprint });
  });

  it("rejects a changed profile against the root completion fingerprint", () => {
    const initial = writeCompletionFixture(managedStartupE2eProfile("openclaw"));
    const changedProfile = managedStartupE2eProfile("openclaw", true);
    mockDescriptorOwnership(0n, 0n);
    expect(() =>
      verifyManagedStartupImageCompletion(
        "openclaw",
        fingerprintManagedStartupProfile(changedProfile),
        initial.completionFile,
        initial.runtimeEnvironmentFile,
      ),
    ).toThrow(/completion marker does not match the requested profile/u);
  });

  it("rejects runtime handoff drift after a matching completion", () => {
    const fixture = writeCompletionFixture(managedStartupE2eProfile("hermes"));
    mockDescriptorOwnership(0n, 0n);
    fs.chmodSync(fixture.runtimeEnvironmentFile, 0o644);
    fs.appendFileSync(fixture.runtimeEnvironmentFile, "export NEMOCLAW_MODEL='tampered/model'\n");
    fs.chmodSync(fixture.runtimeEnvironmentFile, 0o444);

    expect(() =>
      verifyManagedStartupImageCompletion(
        "hermes",
        fixture.fingerprint,
        fixture.completionFile,
        fixture.runtimeEnvironmentFile,
      ),
    ).toThrow(/runtime environment digest mismatch/u);
  });

  it("accepts merged CA paths without putting the CA payload in the readable handoff", () => {
    const fixture = writeCompletionFixture(
      managedStartupE2eProfile("langchain-deepagents-code", false, true),
      true,
    );
    mockDescriptorOwnership(0n, 0n);
    expect(
      verifyManagedStartupImageCompletion(
        "langchain-deepagents-code",
        fixture.fingerprint,
        fixture.completionFile,
        fixture.runtimeEnvironmentFile,
      ),
    ).toEqual({
      agent: "langchain-deepagents-code",
      fingerprint: fixture.fingerprint,
    });
    expect(fs.readFileSync(fixture.runtimeEnvironmentFile, "utf8")).not.toContain(
      "NEMOCLAW_CORPORATE_CA_B64",
    );
  });

  it("binds the real corporate-CA fixture into every agent profile by exact digest", () => {
    expect(() => new X509Certificate(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM)).not.toThrow();
    const digest = createHash("sha256").update(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM).digest("hex");

    for (const agent of MANAGED_STARTUP_AGENTS) {
      expect(managedStartupE2eProfile(agent, false, true).corporateCa.bundleSha256).toBe(digest);
    }
  });

  it("writes a deterministic root-sourced runtime environment without profile transport", () => {
    const script = serializeManagedStartupRuntimeEnvironment(
      {
        NEMOCLAW_MODEL: "model-with-'quote",
        NEMOCLAW_OBSERVABILITY: "0",
      },
      true,
      {
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_MODEL: "model-with-'quote",
      },
    );

    expect(script).toContain("unset NEMOCLAW_INFERENCE_BASE_URL");
    expect(script).toContain("export NEMOCLAW_MANAGED_STARTUP_APPLIED='1'");
    expect(script).toContain("export NEMOCLAW_MODEL='model-with-'\"'\"'quote'");
    expect(script).toContain(`export SSL_CERT_FILE='${MANAGED_STARTUP_MERGED_CA_FILE}'`);
    expect(script).toContain("export _NEMOCLAW_CORPORATE_CA_MERGED='1'");
    expect(script).not.toContain("NEMOCLAW_STARTUP_PROFILE_B64");
    expect(script).not.toContain("NEMOCLAW_CORPORATE_CA_B64");
    expect(script.endsWith("\n")).toBe(true);
  });

  it.each(["openclaw", "hermes"] as const)("preserves launch-only proxy env for %s", (agent) => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(
      managedStartupE2eProfile(agent, false, false, true),
    );
    const script = serializeManagedStartupRuntimeEnvironment(
      mapped.runtimeEnvironment,
      false,
      mapped.configurationEnvironment,
    );
    for (const name of PROXY_ENV_NAMES) {
      expect(script).not.toMatch(new RegExp(`(?:export|unset) ${name}(?:=|$)`, "mu"));
    }
  });

  it("clears launch-only proxy env when DCode pins managed routing", () => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(
      managedStartupE2eProfile("langchain-deepagents-code", false, false, true),
    );
    const script = serializeManagedStartupRuntimeEnvironment(
      mapped.runtimeEnvironment,
      false,
      mapped.configurationEnvironment,
    );
    for (const name of PROXY_ENV_NAMES) {
      expect(script).toContain(`unset ${name}`);
    }
  });

  it("rejects multiline runtime values before producing a sourceable file", () => {
    expect(() =>
      serializeManagedStartupRuntimeEnvironment({ NEMOCLAW_MODEL: "bad\nvalue" }, false),
    ).toThrow(/single-line/u);
  });

  it("refuses a symlink instead of opening its target", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    fs.writeFileSync(target, "trusted\n");
    fs.symlinkSync(target, link);

    expect(() => readStableRegularFile(link, 1024)).toThrow(/unsafe or unreadable/u);
  });

  it("rejects descriptor metadata drift after a bounded read", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "material");
    fs.writeFileSync(target, "trusted\n", { mode: 0o600 });
    const realReadSync = fs.readSync.bind(fs);
    vi.spyOn(fs, "readSync")
      .mockImplementationOnce(((
        descriptor: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        const bytesRead = realReadSync(descriptor, buffer, offset, length, position);
        fs.chmodSync(target, 0o644);
        return bytesRead;
      }) as typeof fs.readSync)
      .mockImplementation(realReadSync as typeof fs.readSync);

    expect(() => readStableRegularFile(target, 1024)).toThrow(/changed while it was read/u);
  });

  it("normalizes mutable sandbox-owned Hermes config descriptors to mode 0640", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "config.yaml");
    fs.writeFileSync(target, "model: managed\n", { mode: 0o600 });
    mockDescriptorOwnership(501n, 20n);

    normalizeHermesManagedConfigDescriptor(target, {
      uid: 501,
      gid: 20,
    });

    expect(fs.readFileSync(target, "utf8")).toBe("model: managed\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("preserves a root-owned shields-up Hermes descriptor without chmod", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, ".env");
    fs.writeFileSync(target, "OPENAI_API_KEY=managed\n", { mode: 0o444 });
    mockDescriptorOwnership(0n, 0n);
    const chmod = vi.spyOn(fs, "fchmodSync");

    normalizeHermesManagedConfigDescriptor(target, {
      uid: 501,
      gid: 20,
    });

    expect(chmod).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("OPENAI_API_KEY=managed\n");
  });

  it.each([0o440, 0o644, 0o660])("fails closed on unexpected mutable Hermes mode %s", (mode) => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "config.yaml");
    fs.writeFileSync(target, "model: managed\n", { mode });
    fs.chmodSync(target, mode);
    mockDescriptorOwnership(501n, 20n);

    expect(() =>
      normalizeHermesManagedConfigDescriptor(target, {
        uid: 501,
        gid: 20,
      }),
    ).toThrow(/unexpected Hermes managed config descriptor/u);
    expect(fs.statSync(target).mode & 0o777).toBe(mode);
  });

  it("fails closed on an unexpected Hermes descriptor owner", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "config.yaml");
    fs.writeFileSync(target, "model: managed\n", { mode: 0o600 });
    mockDescriptorOwnership(502n, 21n);

    expect(() =>
      normalizeHermesManagedConfigDescriptor(target, {
        uid: 501,
        gid: 20,
      }),
    ).toThrow(/unexpected Hermes managed config descriptor/u);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("detects a path replacement while normalizing through the trusted descriptor", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "config.yaml");
    const displaced = path.join(directory, "displaced.yaml");
    const replacement = path.join(directory, "replacement.yaml");
    fs.writeFileSync(target, "model: managed\n", { mode: 0o600 });
    fs.writeFileSync(replacement, "model: replaced\n", { mode: 0o640 });
    mockDescriptorOwnership(501n, 20n);
    const realFchmodSync = fs.fchmodSync.bind(fs);
    vi.spyOn(fs, "fchmodSync").mockImplementation((descriptor, mode) => {
      realFchmodSync(descriptor, mode);
      fs.renameSync(target, displaced);
      fs.renameSync(replacement, target);
    });

    expect(() =>
      normalizeHermesManagedConfigDescriptor(target, {
        uid: 501,
        gid: 20,
      }),
    ).toThrow(/changed during normalization/u);
    expect(fs.readFileSync(target, "utf8")).toBe("model: replaced\n");
  });
});
