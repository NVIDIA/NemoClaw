// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../../test/helpers/timeouts";

import { ROOT } from "../../runner";
import { createHermesPortableBuildContextPlan } from "./hermes-portable-build-context";
import { HERMES_PORTABLE_BUILD_CONTEXT_FILES } from "./hermes-portable-build-context-files";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
const CREATE_INTENT = "a".repeat(64);
const BUILD_SETTINGS = {
  model: "qwen3-vl:4b",
  provider: "ollama-local",
  preferredInferenceApi: "openai-completions",
  toolDisclosure: "direct",
} as const;

let stateDir: string;

function emulatePrivateSourceAncestor(): void {
  const original = fs.lstatSync;
  const sharedTemporaryRoots = new Set([path.resolve("/tmp"), fs.realpathSync("/tmp")]);
  vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
    const stat = original(target, options as never);
    return sharedTemporaryRoots.has(path.resolve(String(target)))
      ? new Proxy(stat, {
          get(value, property) {
            const mode = BigInt(Reflect.get(value, "mode", value));
            return property === "mode" ? mode & ~0o22n : Reflect.get(value, property, value);
          },
        })
      : stat;
  }) as typeof fs.lstatSync);
}

function contextInput() {
  return {
    sandboxName: "alpha",
    transactionId: TRANSACTION_ID,
    createIntentSha256: CREATE_INTENT,
    stateDir,
  };
}

function transactionDirectory(): string {
  const root = path.join(stateDir, "hermes-portable-build-context");
  const sandboxDirectories = fs.readdirSync(root);
  expect(sandboxDirectories).toHaveLength(1);
  return path.join(root, sandboxDirectories[0]!);
}

function transactionArtifact(prefix: string): string {
  const directory = transactionDirectory();
  const match = fs.readdirSync(directory).find((entry) => entry.startsWith(prefix));
  expect(match, `missing ${prefix} artifact`).toBeDefined();
  return path.join(directory, match!);
}

function copyFixtureFile(
  root: string,
  relativePath: string,
  mode: "100644" | "100755",
  privateMode = false,
): void {
  const target = path.join(root, relativePath);
  fs.copyFileSync(path.join(ROOT, relativePath), target);
  fs.chmodSync(
    target,
    mode === "100755" ? (privateMode ? 0o700 : 0o755) : privateMode ? 0o600 : 0o644,
  );
}

function primaryCloneFixture(privateFileModes = false): string {
  const requested = fs.mkdtempSync(path.join(stateDir, "primary-clone-"));
  const root = fs.realpathSync(requested);
  fs.chmodSync(root, 0o700);
  for (const entry of HERMES_PORTABLE_BUILD_CONTEXT_FILES) {
    const target = path.join(root, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    entry.mode === "160000"
      ? fs.mkdirSync(target, { mode: 0o755 })
      : copyFixtureFile(root, entry.path, entry.mode, privateFileModes);
  }
  const git = path.join(root, ".git");
  const ref = path.join(git, "refs/heads");
  fs.mkdirSync(ref, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
  fs.writeFileSync(path.join(ref, "main"), `${"b".repeat(40)}\n`, { mode: 0o600 });
  return root;
}

describe("Hermes portable staged build context", testTimeoutOptions(30_000), () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-context-test-"));
    fs.chmodSync(stateDir, 0o700);
    emulatePrivateSourceAncestor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("publishes, reuses, and retires only the reviewed exact source context (#9203)", () => {
    const plan = createHermesPortableBuildContextPlan(ROOT, BUILD_SETTINGS);
    const first = plan.materialize(contextInput());

    expect(first.dockerfilePath).toBe(path.join(first.buildContextPath, "Dockerfile"));
    const inferredContext = path.dirname(first.dockerfilePath);
    expect(inferredContext).toBe(first.buildContextPath);
    expect(
      fs.existsSync(
        path.join(
          inferredContext,
          "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/BUNDLED_PACKAGES.json",
        ),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(inferredContext, "agents/hermes/Dockerfile"))).toBe(false);
    expect(plan.authority.sourceRevision).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(plan.authority.contextManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    const stagedDockerfile = fs.readFileSync(first.dockerfilePath, "utf8");
    expect(stagedDockerfile).toContain("ARG NEMOCLAW_MODEL=qwen3-vl:4b");
    expect(stagedDockerfile).toContain("ARG NEMOCLAW_INFERENCE_PROVIDER_ID=inference");
    expect(stagedDockerfile).toContain("ARG NEMOCLAW_UPSTREAM_PROVIDER=ollama-local");
    expect(stagedDockerfile).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=direct");
    expect(stagedDockerfile).toContain("ARG CHAT_UI_URL=");
    expect(stagedDockerfile).not.toContain("ARG CHAT_UI_URL=http://127.0.0.1:18789");
    const globalArguments = stagedDockerfile.slice(0, stagedDockerfile.indexOf("\nFROM "));
    expect(globalArguments).toContain("ARG TARGETARCH=amd64");
    expect(stagedDockerfile).toContain(
      "FROM hermes-managed-teams-${TARGETARCH}-wheels AS hermes-managed-teams-1-wheels",
    );
    expect(stagedDockerfile).not.toMatch(/^ADD --chmod=/mu);
    expect(stagedDockerfile).toMatch(
      /^ADD --checksum=sha256:[a-f0-9]{64} https:\/\/files[.]pythonhosted[.]org\//mu,
    );
    const finalStage = stagedDockerfile.slice(stagedDockerfile.lastIndexOf("FROM ${BASE_IMAGE}"));
    const payloadCopyIndex = finalStage.indexOf("COPY --from=hermes-runtime-payload / /");
    const permissionNormalizationIndex = finalStage.search(
      /chmod 444 [^\n]*\/usr\/local\/lib\/nemoclaw\/corporate-ca-runtime[.]sh/u,
    );
    expect(payloadCopyIndex).toBeGreaterThanOrEqual(0);
    expect(permissionNormalizationIndex).toBeGreaterThan(payloadCopyIndex);
    expect(fs.existsSync(path.join(first.buildContextPath, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(first.buildContextPath, "node_modules"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(first.buildContextPath, "src/lib/messaging/channels/wechat/contract.ts"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(first.buildContextPath, "src/lib/messaging/channels/teams/contract.ts"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(first.buildContextPath, "src/lib/messaging/managed-startup-placeholders.ts"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(first.buildContextPath, "agents/hermes/plugin/__pycache__")),
    ).toBe(false);

    const reused = plan.materialize(contextInput());
    expect(reused.buildContextPath).toBe(first.buildContextPath);
    reused.assertCurrent();

    expect(plan.retire(contextInput())).toBe(true);
    expect(fs.existsSync(first.buildContextPath)).toBe(false);
    expect(plan.retire(contextInput())).toBe(true);
  });

  it("preserves and rejects a replaced or extended staged generation (#9203)", () => {
    const plan = createHermesPortableBuildContextPlan(ROOT, BUILD_SETTINGS);
    const staged = plan.materialize(contextInput());
    const foreign = path.join(staged.buildContextPath, "foreign.txt");
    fs.writeFileSync(foreign, "do not delete", { mode: 0o600 });

    expect(() => staged.assertCurrent()).toThrow("membership changed");
    expect(() => plan.retire(contextInput())).toThrow();
    expect(fs.readFileSync(foreign, "utf8")).toBe("do not delete");
  });

  it("reconciles a canonical authority hard-link crash without replacing context (#9203)", () => {
    const plan = createHermesPortableBuildContextPlan(ROOT, BUILD_SETTINGS);
    const staged = plan.materialize(contextInput());
    const authority = transactionArtifact("authority.");
    const next = path.join(
      path.dirname(authority),
      `.${path.basename(authority).replace(/\.json$/u, ".next")}`,
    );
    fs.linkSync(authority, next);

    const resumed = plan.materialize(contextInput());

    expect(resumed.buildContextPath).toBe(staged.buildContextPath);
    expect(fs.existsSync(next)).toBe(false);
    resumed.assertCurrent();
  });

  it("rebuilds only an exact same-transaction partial staged prefix (#9203)", () => {
    const plan = createHermesPortableBuildContextPlan(ROOT, BUILD_SETTINGS);
    const staged = plan.materialize(contextInput());
    fs.unlinkSync(transactionArtifact("authority."));
    const dockerfile = staged.dockerfilePath;
    const original = fs.readFileSync(dockerfile);
    fs.truncateSync(dockerfile, Math.max(1, Math.floor(original.byteLength / 2)));

    const resumed = plan.materialize(contextInput());

    expect(fs.readFileSync(resumed.dockerfilePath)).toEqual(original);
    resumed.assertCurrent();
  });

  it("resumes after a partial staged-file write before authority publication (#9203)", () => {
    const plan = createHermesPortableBuildContextPlan(ROOT, BUILD_SETTINGS);
    const originalWrite = fs.writeSync;
    let interrupted = false;
    const writeSpy = vi.spyOn(fs, "writeSync").mockImplementation(((
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      return !interrupted && length > 1
        ? (() => {
            interrupted = true;
            originalWrite(descriptor, buffer, offset, Math.floor(length / 2), position);
            throw new Error("simulated staged write exit");
          })()
        : originalWrite(descriptor, buffer, offset, length, position);
    }) as typeof fs.writeSync);
    expect(() => plan.materialize(contextInput())).toThrow("simulated staged write exit");
    writeSpy.mockRestore();

    const resumed = plan.materialize(contextInput());
    resumed.assertCurrent();
  });

  it("resumes retirement after the exact context was detached (#9203)", () => {
    const plan = createHermesPortableBuildContextPlan(ROOT, BUILD_SETTINGS);
    const staged = plan.materialize(contextInput());
    const retiring = path.join(
      path.dirname(staged.buildContextPath),
      path.basename(staged.buildContextPath).replace(/^context\./u, "retiring."),
    );
    fs.renameSync(staged.buildContextPath, retiring);

    expect(plan.retire(contextInput())).toBe(true);
    expect(fs.existsSync(staged.buildContextPath)).toBe(false);
    expect(fs.existsSync(retiring)).toBe(false);
  });

  it("resumes exact per-entry retirement after an interrupted unlink (#9203)", () => {
    const plan = createHermesPortableBuildContextPlan(ROOT, BUILD_SETTINGS);
    const staged = plan.materialize(contextInput());
    const originalUnlink = fs.unlinkSync;
    let interrupted = false;
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      return !interrupted && String(target).includes("retiring.")
        ? (() => {
            interrupted = true;
            originalUnlink(target);
            throw new Error("simulated retirement exit");
          })()
        : originalUnlink(target);
    });
    expect(() => plan.retire(contextInput())).toThrow("simulated retirement exit");
    unlinkSpy.mockRestore();

    expect(plan.retire(contextInput())).toBe(true);
    expect(fs.existsSync(staged.buildContextPath)).toBe(false);
  });

  it("preserves a staged symlink replacement during validation and retirement (#9203)", () => {
    const plan = createHermesPortableBuildContextPlan(ROOT, BUILD_SETTINGS);
    const staged = plan.materialize(contextInput());
    const target = staged.dockerfilePath;
    const foreign = path.join(stateDir, "foreign-Dockerfile");
    fs.writeFileSync(foreign, "do not delete\n", { mode: 0o600 });
    fs.unlinkSync(target);
    fs.symlinkSync(foreign, target);

    expect(() => staged.assertCurrent()).toThrow();
    expect(() => plan.retire(contextInput())).toThrow();
    expect(fs.readFileSync(foreign, "utf8")).toBe("do not delete\n");
  });

  it("captures the exact allowlist from an ordinary primary Git clone (#9203)", () => {
    const source = primaryCloneFixture();

    const plan = createHermesPortableBuildContextPlan(source, BUILD_SETTINGS);

    expect(plan.authority.sourceRevision).toBe("b".repeat(40));
    expect(plan.authority.contextManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts a private installer checkout created under umask 077 (#9203)", () => {
    const source = primaryCloneFixture(true);

    const plan = createHermesPortableBuildContextPlan(source, BUILD_SETTINGS);

    expect(plan.authority.sourceRevision).toBe("b".repeat(40));
    expect(plan.authority.contextManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    {
      relativePath: ".git",
      mode: 0o775,
      modeLabel: "0775",
      error: "Git directory authority is unsafe",
    },
    {
      relativePath: ".git/HEAD",
      mode: 0o664,
      modeLabel: "0664",
      error: "source revision evidence is unsafe",
    },
  ])(
    "rejects group-writable Git authority at $relativePath with mode $modeLabel (#9203)",
    ({ relativePath, mode, error }) => {
      const source = primaryCloneFixture();
      fs.chmodSync(path.join(source, relativePath), mode);

      expect(() => createHermesPortableBuildContextPlan(source, BUILD_SETTINGS)).toThrow(error);
    },
  );

  it.each([
    { access: "group", mode: 0o620 },
    { access: "other", mode: 0o602 },
  ])("rejects $access-write access on a source file (#9203)", ({ mode }) => {
    const source = primaryCloneFixture();
    fs.chmodSync(path.join(source, "agents/hermes/Dockerfile"), mode);

    expect(() => createHermesPortableBuildContextPlan(source, BUILD_SETTINGS)).toThrow(
      "source file authority is unsafe: agents/hermes/Dockerfile",
    );
  });

  it("rejects lowercase Dockerfile copy opcodes before reservation (#9203)", () => {
    const source = primaryCloneFixture();
    const dockerfile = path.join(source, "agents/hermes/Dockerfile");
    fs.writeFileSync(dockerfile, fs.readFileSync(dockerfile, "utf8").replace(/^COPY /mu, "copy "), {
      mode: 0o644,
    });

    expect(() => createHermesPortableBuildContextPlan(source, BUILD_SETTINGS)).toThrow(
      "noncanonical COPY or ADD opcode",
    );
  });

  it("rejects BuildKit-only local COPY options before reservation (#10007)", () => {
    const source = primaryCloneFixture();
    const dockerfile = path.join(source, "agents/hermes/Dockerfile");
    const reservationRoot = path.join(stateDir, "hermes-portable-build-context");
    fs.writeFileSync(
      dockerfile,
      fs
        .readFileSync(dockerfile, "utf8")
        .replace(
          "COPY scripts/lib/corporate-ca-runtime.sh",
          "COPY --chmod=0444 scripts/lib/corporate-ca-runtime.sh",
        ),
      { mode: 0o644 },
    );
    const reservationExistedBefore = fs.existsSync(reservationRoot);

    expect(() => createHermesPortableBuildContextPlan(source, BUILD_SETTINGS)).toThrow(
      "non-Portable local COPY option",
    );
    expect(fs.existsSync(reservationRoot)).toBe(reservationExistedBefore);
  });

  it("rejects BuildKit-only remote ADD options before reservation (#10007)", () => {
    const source = primaryCloneFixture();
    const dockerfile = path.join(source, "agents/hermes/Dockerfile");
    const reservationRoot = path.join(stateDir, "hermes-portable-build-context");
    fs.writeFileSync(
      dockerfile,
      fs
        .readFileSync(dockerfile, "utf8")
        .replace("ADD --checksum=sha256:", "ADD --chmod=0444 --checksum=sha256:"),
      { mode: 0o644 },
    );
    const reservationExistedBefore = fs.existsSync(reservationRoot);

    expect(() => createHermesPortableBuildContextPlan(source, BUILD_SETTINGS)).toThrow(
      "unsupported local or unpinned ADD instruction",
    );
    expect(fs.existsSync(reservationRoot)).toBe(reservationExistedBefore);
  });

  it("rejects source symlinks, hardlinks, and unreviewed secret paths (#9203)", () => {
    const source = primaryCloneFixture();
    const script = path.join(source, "agents/hermes/start.sh");
    const original = fs.readFileSync(script);
    fs.unlinkSync(script);
    fs.symlinkSync(path.join(source, "agents/hermes/Dockerfile"), script);
    expect(() => createHermesPortableBuildContextPlan(source, BUILD_SETTINGS)).toThrow(
      "symlink or special entry",
    );

    fs.unlinkSync(script);
    fs.writeFileSync(script, original, { mode: 0o755 });
    const link = path.join(stateDir, "start-link.sh");
    fs.linkSync(script, link);
    expect(() => createHermesPortableBuildContextPlan(source, BUILD_SETTINGS)).toThrow();
    fs.unlinkSync(link);

    const secret = path.join(source, "nemoclaw-blueprint/secrets/token.json");
    fs.mkdirSync(path.dirname(secret), { recursive: true, mode: 0o755 });
    fs.writeFileSync(secret, "do not stage\n", { mode: 0o600 });
    expect(() => createHermesPortableBuildContextPlan(source, BUILD_SETTINGS)).toThrow();
  });
});
