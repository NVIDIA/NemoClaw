// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
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
  applyManagedStartupCommandEnvironmentPlan,
  buildManagedStartupImageActionPlan,
  MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION,
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
const OPENCLAW_APPLICATION_RUNTIME_NAMES = [
  "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
  "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
  "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
] as const;

describe("managed startup image runtime handoff and descriptor integrity", () => {
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

  function mockRuntimeDescriptorOwnership(
    runtimeEnvironmentFile: string,
    uid: bigint,
    gid: bigint,
  ): void {
    const realFstatSync = fs.fstatSync.bind(fs);
    const runtimeInode = fs.lstatSync(runtimeEnvironmentFile, { bigint: true }).ino;
    vi.spyOn(fs, "fstatSync").mockImplementation(((
      descriptor: number,
      options: { bigint: true },
    ) => {
      const stat = realFstatSync(descriptor, options);
      const isRuntimeDescriptor = stat.ino === runtimeInode;
      const ownership = new Map<PropertyKey, unknown>([
        ["uid", isRuntimeDescriptor ? uid : 0n],
        ["gid", isRuntimeDescriptor ? gid : 0n],
      ]);
      return new Proxy(stat, {
        get(inner, property) {
          const value = ownership.has(property)
            ? ownership.get(property)
            : (Reflect.get(inner, property, inner) as unknown);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    }) as typeof fs.fstatSync);
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
        schemaVersion: MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION,
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
  it.each(MANAGED_STARTUP_AGENTS)(
    "maps the complete %s profile into the reviewed image command contract",
    (agent) => {
      const mapped = mapManagedStartupProfileToAgentEnvironment(managedStartupE2eProfile(agent));
      const plan = buildManagedStartupImageActionPlan({
        agent: mapped.agent,
        actions: mapped.actions,
      });

      expect(plan.map(({ action }) => action)).toEqual(
        agent === "langchain-deepagents-code" || agent === "pi"
          ? ["generate-agent-config"]
          : ["messaging-runtime-setup", "generate-agent-config", "messaging-post-agent-install"],
      );
      expect(plan.some((command) => command.argv.includes("agent-install"))).toBe(false);
    },
  );

  it.each(MANAGED_STARTUP_AGENTS)(
    "provides valid same-profile and changed-profile fixtures for %s recreation checks",
    (agent) => {
      const initial = validateManagedStartupProfile(managedStartupE2eProfile(agent));
      const same = validateManagedStartupProfile(managedStartupE2eProfile(agent));
      const changed = validateManagedStartupProfile(managedStartupE2eProfile(agent, true));

      expect(fingerprintManagedStartupProfile(same)).toBe(
        fingerprintManagedStartupProfile(initial),
      );
      expect(fingerprintManagedStartupProfile(changed)).not.toBe(
        fingerprintManagedStartupProfile(initial),
      );
    },
  );

  it.each(MANAGED_STARTUP_AGENTS)(
    "accepts the root completion marker and exact runtime handoff for %s",
    (agent) => {
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
    },
  );

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

  it("rejects a replaced runtime handoff after a matching completion", () => {
    const fixture = writeCompletionFixture(managedStartupE2eProfile("hermes"));
    mockDescriptorOwnership(0n, 0n);
    const originalRuntimeEnvironment = fs.readFileSync(fixture.runtimeEnvironmentFile, "utf8");
    fs.renameSync(fixture.runtimeEnvironmentFile, `${fixture.runtimeEnvironmentFile}.original`);
    fs.writeFileSync(
      fixture.runtimeEnvironmentFile,
      `${originalRuntimeEnvironment}export NEMOCLAW_MODEL='tampered/model'\n`,
      { mode: 0o444 },
    );
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

  it("fails closed when the runtime handoff is missing", () => {
    const fixture = writeCompletionFixture(managedStartupE2eProfile("openclaw"));
    mockDescriptorOwnership(0n, 0n);
    fs.unlinkSync(fixture.runtimeEnvironmentFile);

    expect(() =>
      verifyManagedStartupImageCompletion(
        fixture.agent,
        fixture.fingerprint,
        fixture.completionFile,
        fixture.runtimeEnvironmentFile,
      ),
    ).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("fails closed when the runtime handoff is symlinked", () => {
    const fixture = writeCompletionFixture(managedStartupE2eProfile("openclaw"));
    mockDescriptorOwnership(0n, 0n);
    const replacement = `${fixture.runtimeEnvironmentFile}.replacement`;
    fs.renameSync(fixture.runtimeEnvironmentFile, replacement);
    fs.symlinkSync(replacement, fixture.runtimeEnvironmentFile);

    expect(() =>
      verifyManagedStartupImageCompletion(
        fixture.agent,
        fixture.fingerprint,
        fixture.completionFile,
        fixture.runtimeEnvironmentFile,
      ),
    ).toThrow(/refusing unsafe or unreadable file/u);
  });

  it("fails closed when the runtime handoff mode is not 0444", () => {
    const fixture = writeCompletionFixture(managedStartupE2eProfile("hermes"));
    mockDescriptorOwnership(0n, 0n);
    fs.chmodSync(fixture.runtimeEnvironmentFile, 0o640);

    expect(() =>
      verifyManagedStartupImageCompletion(
        fixture.agent,
        fixture.fingerprint,
        fixture.completionFile,
        fixture.runtimeEnvironmentFile,
      ),
    ).toThrow(/runtime environment must be root:root mode 0444/u);
  });

  it("fails closed when the runtime handoff is not root owned", () => {
    const fixture = writeCompletionFixture(managedStartupE2eProfile("langchain-deepagents-code"));
    mockRuntimeDescriptorOwnership(fixture.runtimeEnvironmentFile, 501n, 20n);

    expect(() =>
      verifyManagedStartupImageCompletion(
        fixture.agent,
        fixture.fingerprint,
        fixture.completionFile,
        fixture.runtimeEnvironmentFile,
      ),
    ).toThrow(/runtime environment must be root:root mode 0444/u);
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

  it.each(Array.from(MANAGED_STARTUP_AGENTS, (value) => [value]))(
    "binds the real corporate-CA fixture into the %s profile by exact digest",
    (agent) => {
      expect(() => new X509Certificate(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM)).not.toThrow();
      const digest = createHash("sha256")
        .update(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM)
        .digest("hex");

      expect(managedStartupE2eProfile(agent, false, true).corporateCa.bundleSha256).toBe(digest);
    },
  );

  it("writes a deterministic root-sourced runtime environment without profile transport", () => {
    const applicationRuntime = {
      exportEnvironment: {
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.25",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3",
      },
      unsetEnvironment: ["NEMOCLAW_MINIMAL_BOOTSTRAP", "REQUESTS_CA_BUNDLE"],
    };
    const script = serializeManagedStartupRuntimeEnvironment(
      {
        NEMOCLAW_MODEL: "model-with-'quote",
        NEMOCLAW_OBSERVABILITY: "0",
        SSL_CERT_FILE: "/pre-resume-ca.pem",
      },
      true,
      {
        CURL_CA_BUNDLE: "/pre-resume-ca.pem",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_MODEL: "model-with-'quote",
      },
      applicationRuntime,
    );

    expect(script).toContain("unset NEMOCLAW_INFERENCE_BASE_URL");
    expect(script).toContain("unset NEMOCLAW_MINIMAL_BOOTSTRAP");
    expect(script).toContain("export NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS='0.25'");
    expect(script).toContain("export NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS='3'");
    expect(script).toContain("export NEMOCLAW_MANAGED_STARTUP_APPLIED='1'");
    expect(script).toContain("export NEMOCLAW_MODEL='model-with-'\"'\"'quote'");
    expect(script).not.toMatch(
      /^(?:export|unset) (?:CURL_CA_BUNDLE|GIT_SSL_CAINFO|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|SSL_CERT_FILE)(?:=|$)/mu,
    );
    expect(script).toContain("export _NEMOCLAW_CORPORATE_CA_MERGED='1'");
    expect(script).not.toContain("NEMOCLAW_STARTUP_PROFILE_B64");
    expect(script).not.toContain("NEMOCLAW_CORPORATE_CA_B64");
    expect(script.endsWith("\n")).toBe(true);
    expect(
      serializeManagedStartupRuntimeEnvironment(
        {
          NEMOCLAW_MODEL: "model-with-'quote",
          NEMOCLAW_OBSERVABILITY: "0",
          SSL_CERT_FILE: "/pre-resume-ca.pem",
        },
        true,
        {
          CURL_CA_BUNDLE: "/pre-resume-ca.pem",
          NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
          NEMOCLAW_MODEL: "model-with-'quote",
        },
        applicationRuntime,
      ),
    ).toBe(script);
  });

  it("serializes the fixed Hermes paths into the validated supervisor environment", () => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(
      managedStartupE2eProfile("hermes"),
    );
    const script = serializeManagedStartupRuntimeEnvironment(
      mapped.runtimeEnvironment,
      false,
      mapped.configurationEnvironment,
      mapped.applicationRuntime,
    );
    const validated = spawnSync(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `${script}exec /usr/bin/python3 -I agents/hermes/validate-env-secret-boundary.py runtime-env`,
      ],
      {
        cwd: path.resolve(import.meta.dirname, "../../.."),
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 5000,
      },
    );

    expect(script.match(/^export HERMES_.*$/gmu)).toEqual([
      "export HERMES_BUNDLED_PLUGINS='/opt/hermes/plugins'",
      "export HERMES_HOME='/sandbox/.hermes'",
      "export HERMES_LAZY_INSTALL_TARGET='/sandbox/.hermes/lazy-packages'",
    ]);
    expect(validated.status, validated.stderr).toBe(0);
  });

  it("serializes OpenClaw reasoning into the managed runtime handoff", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const mapped = mapManagedStartupProfileToAgentEnvironment({
      ...profile,
      tuning: { ...profile.tuning, reasoning: true },
    });
    const script = serializeManagedStartupRuntimeEnvironment(
      mapped.runtimeEnvironment,
      false,
      mapped.configurationEnvironment,
      mapped.applicationRuntime,
    );

    expect(script.match(/^export NEMOCLAW_REASONING=.*$/gmu)).toEqual([
      "export NEMOCLAW_REASONING='true'",
    ]);
  });

  it("validates runtime plans while removing launch-only exports and unsets from child commands", () => {
    const ambient = {
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "stale",
      NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
      PRESERVED: "yes",
    };
    const applied = applyManagedStartupCommandEnvironmentPlan(ambient, {
      exportEnvironment: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3" },
      unsetEnvironment: ["NEMOCLAW_MINIMAL_BOOTSTRAP"],
    });

    expect(applied).toEqual({
      PRESERVED: "yes",
    });
    expect(ambient).toHaveProperty("NEMOCLAW_MINIMAL_BOOTSTRAP", "1");
    expect(() =>
      applyManagedStartupCommandEnvironmentPlan(ambient, {
        exportEnvironment: { NEMOCLAW_MINIMAL_BOOTSTRAP: "1" },
        unsetEnvironment: ["NEMOCLAW_MINIMAL_BOOTSTRAP"],
      }),
    ).toThrow(/both export and unset NEMOCLAW_MINIMAL_BOOTSTRAP/u);
    expect(ambient).toHaveProperty("NEMOCLAW_MINIMAL_BOOTSTRAP", "1");
  });

  it.each(["hermes", "langchain-deepagents-code"] as const)(
    "removes OpenClaw launch controls and cleanup obligations from %s children and runtime",
    (agent) => {
      const mapped = mapManagedStartupProfileToAgentEnvironment(managedStartupE2eProfile(agent), {
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "invalid-for-this-agent",
      });
      const ambient = {
        ...Object.fromEntries(OPENCLAW_APPLICATION_RUNTIME_NAMES.map((name) => [name, "ambient"])),
        NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
        NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
        PRESERVED: "yes",
      };
      const child = applyManagedStartupCommandEnvironmentPlan(ambient, mapped.applicationRuntime);
      const script = serializeManagedStartupRuntimeEnvironment(
        mapped.runtimeEnvironment,
        false,
        mapped.configurationEnvironment,
        mapped.applicationRuntime,
      );

      expect(child).toEqual({ PRESERVED: "yes" });
      [
        ...OPENCLAW_APPLICATION_RUNTIME_NAMES,
        "NEMOCLAW_DASHBOARD_BIND",
        "NEMOCLAW_MINIMAL_BOOTSTRAP",
      ].forEach((name) => {
        expect(script).toContain(`unset ${name}`);
        expect(script).not.toContain(`export ${name}=`);
      });
    },
  );

  it("rejects a serialized runtime export that conflicts with an explicit unset", () => {
    expect(() =>
      serializeManagedStartupRuntimeEnvironment(
        { NEMOCLAW_MINIMAL_BOOTSTRAP: "1" },
        false,
        {},
        { exportEnvironment: {}, unsetEnvironment: ["NEMOCLAW_MINIMAL_BOOTSTRAP"] },
      ),
    ).toThrow(/runtime environment cannot both export and unset NEMOCLAW_MINIMAL_BOOTSTRAP/u);
  });

  it.each([
    [
      { exportEnvironment: { "BAD-NAME": "value" }, unsetEnvironment: [] },
      /invalid application runtime environment key/u,
    ],
    [
      { exportEnvironment: { VALID_NAME: "line 1\nline 2" }, unsetEnvironment: [] },
      /must be single-line text/u,
    ],
    [
      { exportEnvironment: {}, unsetEnvironment: ["DUPLICATE", "DUPLICATE"] },
      /duplicate application runtime unset/u,
    ],
  ])("rejects a malformed application runtime plan before command mutation", (plan, message) => {
    const ambient = { PRESERVED: "yes" };
    expect(() => applyManagedStartupCommandEnvironmentPlan(ambient, plan)).toThrow(message);
    expect(ambient).toEqual({ PRESERVED: "yes" });
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
    PROXY_ENV_NAMES.forEach((name) => {
      expect(script).not.toMatch(new RegExp(`(?:export|unset) ${name}(?:=|$)`, "mu"));
    });
  });

  it.each(Array.from(PROXY_ENV_NAMES, (value) => [value]))(
    "clears launch-only proxy env %s when DCode pins managed routing",
    (name) => {
      const mapped = mapManagedStartupProfileToAgentEnvironment(
        managedStartupE2eProfile("langchain-deepagents-code", false, false, true),
      );
      const script = serializeManagedStartupRuntimeEnvironment(
        mapped.runtimeEnvironment,
        false,
        mapped.configurationEnvironment,
      );

      expect(script).toContain(`unset ${name}`);
    },
  );

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

  it("rejects a root-owned read-only Hermes descriptor", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, ".env");
    fs.writeFileSync(target, "OPENAI_API_KEY=managed\n", { mode: 0o444 });
    mockDescriptorOwnership(0n, 0n);
    expect(() =>
      normalizeHermesManagedConfigDescriptor(target, {
        uid: 501,
        gid: 20,
      }),
    ).toThrow(/unexpected Hermes managed config descriptor/u);
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
