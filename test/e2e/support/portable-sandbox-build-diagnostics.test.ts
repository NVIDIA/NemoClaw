// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";
import YAML from "yaml";

import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../../../src/lib/sandbox/build-context.ts";
import { prebuildSandboxImageIfEligible } from "../../../src/lib/onboard/sandbox-prebuild.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  PORTABLE_ASSERTION_CLEANUP_RESERVE_MS,
  PORTABLE_GATEWAY_STARTUP_BUDGET_MS,
  PORTABLE_HERMES_LIFECYCLE_BUDGET_MS,
  PORTABLE_IMAGE_COMMAND_TIMEOUT_MS,
  PORTABLE_PROFILE_LIVE_TIMEOUT_MS,
  PORTABLE_SANDBOX_CREATE_BUDGET_MS,
  PORTABLE_SANDBOX_DELETE_BUDGET_MS,
  buildPortableSandboxImageWithEvidence,
  cleanupPortablePodmanResources,
  createPodmanGroupReconciliationTracker,
  portableSandboxImageBuilder,
  preservePortableE2eCrun,
  probePortableSandboxOciAfterBuildFailure,
  probePodmanStore,
  publishPortableSandboxImage,
  runPortableE2eWithCleanup,
  verifyPortablePodmanStoreAuthority,
} from "../fixtures/portable-sandbox-build-diagnostics.ts";
import { startTestProgress } from "../fixtures/progress.ts";

it("parses only the fixed Podman store fields from the selected service", () => {
  const env = { XDG_CONFIG_HOME: "/private/config" };
  const runInfo = vi.fn(() => ({
    status: 0,
    stdout: JSON.stringify({
      store: { graphRoot: "/private/graph", runRoot: "/private/run" },
      host: { ociRuntime: { path: "/private/crun" } },
    }),
  }));
  expect(probePodmanStore(env, "unix:///run/user/1001/podman/podman.sock", runInfo)).toEqual({
    graphRoot: "/private/graph",
    runRoot: "/private/run",
    ociRuntimePath: "/private/crun",
  });
  expect(runInfo).toHaveBeenCalledWith(
    ["--url", "unix:///run/user/1001/podman/podman.sock", "info", "--format", "json"],
    env,
  );
  expect(() => probePodmanStore(env, undefined, () => ({ status: 1, stdout: "secret" }))).toThrow(
    "probe",
  );
  expect(() => probePodmanStore(env, undefined, () => ({ status: 0, stdout: "secret" }))).toThrow(
    "parse",
  );
  expect(() => probePodmanStore(env, undefined, () => ({ status: 0, stdout: "{}" }))).toThrow(
    "missing-field",
  );
});

it("preserves trusted crun and selects pinned Netavark's supported backend after host preparation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-crun-"));
  try {
    const config = path.join(root, "containers.conf");
    const runtime = "/usr/local/libexec/nemoclaw/portable-crun.40669583707.1";
    const selectedUrl = "unix:///run/user/1001/podman/podman.sock";
    const env = { CONTAINERS_CONF: config, NETAVARK_FW: "iptables" };
    const probe = vi.fn((_env: NodeJS.ProcessEnv, url?: string) => ({
      graphRoot: "/private/graph",
      runRoot: "/private/run",
      ociRuntimePath: url
        ? runtime
        : fs.readFileSync(config, "utf8").includes(`crun = ["${runtime}"]`)
          ? runtime
          : "/usr/bin/crun",
    }));
    fs.writeFileSync(
      config,
      '[network]\ndefault_rootless_network_cmd = "pasta"\nfirewall_driver = "iptables"\n\n[engine]\nenv = ["NETAVARK_FW=iptables"]\n',
      {
        mode: 0o600,
      },
    );
    preservePortableE2eCrun(config, runtime, selectedUrl, env, probe);
    expect(probe).toHaveBeenCalledWith(env, selectedUrl);
    expect(probe).toHaveBeenCalledWith(env);
    expect(fs.readFileSync(config, "utf8")).toContain(
      `\n[engine.runtimes]\ncrun = ["${runtime}"]\n`,
    );
    expect(fs.readFileSync(config, "utf8")).toContain('firewall_driver = "nftables"');
    expect(fs.readFileSync(config, "utf8")).not.toContain('firewall_driver = "iptables"');
    expect(fs.readFileSync(config, "utf8")).toContain('env = ["NETAVARK_FW=iptables"]');

    fs.writeFileSync(config, "[network]\n");
    const wrongService = vi.fn(() => ({
      graphRoot: "/private/graph",
      runRoot: "/private/run",
      ociRuntimePath: "/usr/bin/crun",
    }));
    expect(() => preservePortableE2eCrun(config, runtime, selectedUrl, env, wrongService)).toThrow(
      "Portable E2E crun authority mismatch",
    );
    expect(fs.readFileSync(config, "utf8")).toBe("[network]\n");
    expect(() => preservePortableE2eCrun(config, runtime, selectedUrl, env, probe)).toThrow(
      "Portable E2E runtime config authority mismatch",
    );
    expect(fs.readFileSync(config, "utf8")).toBe("[network]\n");
    const linked = path.join(root, "linked.conf");
    fs.symlinkSync(config, linked);
    expect(() => preservePortableE2eCrun(linked, runtime, selectedUrl, env, probe)).toThrow(
      "Portable E2E runtime config authority mismatch",
    );
    expect(fs.readFileSync(config, "utf8")).toBe("[network]\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves the lifecycle failure and runs every cleanup after a cleanup failure", async () => {
  const primary = new Error("sandbox build failed");
  const cleanup = new Error("Podman cleanup failed");
  const steps: string[] = [];
  const reported = await runPortableE2eWithCleanup(async () => {
    throw primary;
  }, [
    async () => {
      steps.push("podman");
      throw cleanup;
    },
    () => {
      steps.push("gateway alias");
    },
    () => {
      steps.push("fixture");
    },
  ]).then(
    () => null,
    (error: unknown) => error,
  );
  expect(reported).toBeInstanceOf(AggregateError);
  expect((reported as AggregateError).errors).toEqual([primary, cleanup]);
  expect((reported as Error).cause).toBe(primary);
  expect(steps).toEqual(["podman", "gateway alias", "fixture"]);
});

it("reports a cleanup failure when the Portable lifecycle succeeds", async () => {
  const cleanup = new Error("Podman cleanup failed");
  await expect(
    runPortableE2eWithCleanup(async () => undefined, [async () => Promise.reject(cleanup)]),
  ).rejects.toBe(cleanup);
});

it("aligns only a trusted selected storage config and records fixed equality evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-store-authority-"));
  try {
    const source = path.join(root, "selected-storage.conf");
    const configHome = path.join(root, "fixture-config");
    fs.writeFileSync(source, '[storage]\ngraphroot="/private/graph"\nrunroot="/private/run"\n');
    const artifacts = new ArtifactSink(path.join(root, "artifacts"));
    const fullEnv = { CONTAINERS_STORAGE_CONF: source };
    const childEnv = { XDG_CONFIG_HOME: configHome };
    const probe = vi.fn(() => ({
      graphRoot: "/private/graph",
      runRoot: "/private/run",
      ociRuntimePath: "/private/crun",
    }));
    const selectedUrl = "unix:///run/user/1001/podman/podman.sock";
    await verifyPortablePodmanStoreAuthority(
      childEnv,
      fullEnv,
      selectedUrl,
      configHome,
      "store-first.json",
      artifacts,
      probe,
    );
    await verifyPortablePodmanStoreAuthority(
      childEnv,
      fullEnv,
      selectedUrl,
      configHome,
      "store-second.json",
      artifacts,
      probe,
    );
    const destination = path.join(configHome, "containers", "storage.conf");
    expect(fs.readFileSync(destination, "utf8")).toBe(fs.readFileSync(source, "utf8"));
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(probe.mock.calls).toHaveLength(6);
    expect(probe.mock.calls[0]).toEqual([childEnv]);
    expect(probe.mock.calls[1]).toEqual([fullEnv]);
    expect(probe.mock.calls[2]).toEqual([fullEnv, selectedUrl]);
    const evidence = fs.readFileSync(artifacts.pathFor("store-first.json"), "utf8");
    expect(JSON.parse(evidence)).toEqual({
      schemaVersion: 1,
      category: "match",
      childMatchesHost: true,
      hostMatchesService: true,
      childMatchesHostRuntime: true,
      hostMatchesServiceRuntime: true,
    });
    expect(evidence).not.toContain("/private/graph");
    fs.writeFileSync(source, "changed");
    await expect(
      verifyPortablePodmanStoreAuthority(
        childEnv,
        fullEnv,
        selectedUrl,
        configHome,
        "store-third.json",
        artifacts,
        probe,
      ),
    ).rejects.toThrow("Portable Podman storage config alignment failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the automatic lane unchanged and rejects mismatched or linked storage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-store-guard-"));
  try {
    const configHome = path.join(root, "config");
    const artifacts = new ArtifactSink(path.join(root, "artifacts"));
    const selectedUrl = "unix:///run/user/1001/podman/podman.sock";
    const probe = vi.fn(() => ({
      graphRoot: "/private/graph",
      runRoot: "/private/run",
      ociRuntimePath: "/private/crun",
    }));
    await verifyPortablePodmanStoreAuthority(
      {},
      {},
      selectedUrl,
      configHome,
      "store-absent.json",
      artifacts,
      probe,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(configHome)).toBe(false);
    const source = path.join(root, "storage.conf");
    fs.writeFileSync(source, "[storage]\n");
    const linked = path.join(root, "linked-storage.conf");
    fs.symlinkSync(source, linked);
    await expect(
      verifyPortablePodmanStoreAuthority(
        { XDG_CONFIG_HOME: configHome },
        { CONTAINERS_STORAGE_CONF: linked },
        selectedUrl,
        configHome,
        "store-linked.json",
        artifacts,
        probe,
      ),
    ).rejects.toThrow("Portable Podman storage config alignment failed");
    const mismatched = vi
      .fn()
      .mockReturnValueOnce({
        graphRoot: "/private/other",
        runRoot: "/private/run",
        ociRuntimePath: "/private/crun",
      })
      .mockReturnValue({
        graphRoot: "/private/graph",
        runRoot: "/private/run",
        ociRuntimePath: "/private/crun",
      });
    await expect(
      verifyPortablePodmanStoreAuthority(
        { XDG_CONFIG_HOME: configHome },
        { CONTAINERS_STORAGE_CONF: source },
        selectedUrl,
        configHome,
        "store-mismatch.json",
        artifacts,
        mismatched,
      ),
    ).rejects.toThrow("Portable Podman store authority mismatch");
    const evidence = fs.readFileSync(artifacts.pathFor("store-mismatch.json"), "utf8");
    expect(JSON.parse(evidence)).toMatchObject({ category: "mismatch", childMatchesHost: false });
    expect(evidence).not.toContain("/private/other");
    const runtimeMismatch = vi
      .fn()
      .mockReturnValueOnce({
        graphRoot: "/private/graph",
        runRoot: "/private/run",
        ociRuntimePath: "/private/other-runtime",
      })
      .mockReturnValue({
        graphRoot: "/private/graph",
        runRoot: "/private/run",
        ociRuntimePath: "/private/crun",
      });
    await expect(
      verifyPortablePodmanStoreAuthority(
        { XDG_CONFIG_HOME: configHome },
        { CONTAINERS_STORAGE_CONF: source },
        selectedUrl,
        configHome,
        "runtime-mismatch.json",
        artifacts,
        runtimeMismatch,
      ),
    ).rejects.toThrow("Portable Podman store authority mismatch");
    const runtimeEvidence = fs.readFileSync(artifacts.pathFor("runtime-mismatch.json"), "utf8");
    expect(JSON.parse(runtimeEvidence)).toMatchObject({
      category: "mismatch",
      childMatchesHost: true,
      childMatchesHostRuntime: false,
    });
    expect(runtimeEvidence).not.toContain("/private/other-runtime");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("records fixed Podman failure category and build step without output (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-diagnostic-"));
  const progress = startTestProgress(
    "portable build diagnostics",
    ["prepare build", "build sandbox image"],
    {
      logLine: () => undefined,
    },
  );
  try {
    const artifacts = new ArtifactSink(path.join(directory, "portable-build"));
    const runBuild = vi.fn(async () => ({
      status: 1,
      signal: null,
      diagnostic:
        "STEP 1/2: FROM private-base\nSTEP 2/2: RUN credential=private-build-token\nError: permission denied",
    }));

    const status = await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: { NEMOCLAW_DIAGNOSTIC_TEST: "1" }, stdio: "inherit" },
      artifacts,
      progress,
      runBuild,
    );

    expect(status).toBe(1);
    expect(runBuild).toHaveBeenCalledOnce();
    expect(runBuild).toHaveBeenCalledWith(
      ["build", "-t", "localhost/test:fixed", "."],
      {
        NEMOCLAW_DIAGNOSTIC_TEST: "1",
      },
      PORTABLE_IMAGE_COMMAND_TIMEOUT_MS,
      progress,
    );
    const published = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(published)).toEqual({
      schemaVersion: 1,
      status: 1,
      signal: null,
      errorCode: null,
      category: "permission",
      observedBuildStep: "dockerfile-run",
    });
    expect(published).not.toContain("private-build-token");

    await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: 1,
        signal: null,
        diagnostic: "STEP 1/2: FROM private-base\nError: credential=private-base-token",
      })),
    );
    const baseFailure = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(baseFailure)).toMatchObject({
      category: "unclassified",
      observedBuildStep: "base-image",
    });
    expect(baseFailure).not.toContain("private-base-token");
    expect(
      JSON.parse(
        fs.readFileSync(
          artifacts.pathFor("portable-sandbox-image-build-diagnostic-shape.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      schemaVersion: 1,
      stdoutObserved: null,
      stderrObserved: null,
      terminalErrorObserved: true,
      commitObserved: false,
      signals: [],
    });

    await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: 1,
        signal: null,
        diagnostic: "STEP 1/24: FROM private-base\nSTEP 7/24: RUN credential=private-build-token",
      })),
    );
    const multiStepFailure = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(multiStepFailure)).toMatchObject({ observedBuildStep: "dockerfile-run" });
    expect(multiStepFailure).not.toContain("private-build-token");
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects an errored image build even when Podman reports exit zero (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-diagnostic-"));
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  const dockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(dockerfile, "FROM scratch\n");
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable build diagnostics", ["prepare", "build"], {
    logLine: () => undefined,
  });
  const fetchRegistry = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const runBuild = vi.fn(async () => ({
    status: 0,
    signal: null,
    diagnostic: "",
    error: Object.assign(new Error("private error text"), { code: "ETIMEDOUT" }),
  }));

  try {
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: "rootless-e2e",
        createArgs: ["--from", dockerfile, "--name", "portable-e2e"],
        sandboxName: "portable-e2e",
        dockerDriverGateway: true,
        env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable", NEMOCLAW_SANDBOX_PREBUILD: "1" },
        origin: "generated",
        buildImage: (args, options) =>
          buildPortableSandboxImageWithEvidence(args, options, artifacts, progress, runBuild),
        log: () => undefined,
      }),
    ).rejects.toThrow("build failed without an exit status");

    expect(runBuild).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        fs.readFileSync(artifacts.pathFor("portable-sandbox-image-build-failure.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 1,
      status: 0,
      signal: null,
      errorCode: "ETIMEDOUT",
      category: "unclassified",
      observedBuildStep: "unknown",
    });
  } finally {
    fetchRegistry.mockRestore();
    progress.stop();
    fs.rmSync(buildCtx, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("retains fixed build error signals without Dockerfile output or credentials (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-signals-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable build diagnostics", ["prepare", "build"], {
    logLine: () => undefined,
  });
  try {
    await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: 1,
        signal: null,
        diagnostic:
          "STEP 1/2: FROM private-base\nSTEP 2/2: RUN credential=private-token\nError: building at STEP: while running runtime: crun: private-token",
        stdoutObserved: true,
        stderrObserved: true,
      })),
    );
    const diagnostic = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-diagnostic-shape.json"),
      "utf8",
    );
    expect(JSON.parse(diagnostic)).toEqual({
      schemaVersion: 1,
      stdoutObserved: true,
      stderrObserved: true,
      terminalErrorObserved: true,
      commitObserved: false,
      signals: ["runtime"],
    });
    expect(diagnostic).not.toContain("private-token");
    expect(diagnostic).not.toContain("private-base");
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("probes only a cached base with no pull or network and redacts child output (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oci-probe-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable OCI probe", ["prepare", "diagnose"], {
    logLine: () => undefined,
  });
  const result = (status: number, diagnostic = "") => ({ status, signal: null, diagnostic });
  const runCommand = vi
    .fn()
    .mockResolvedValueOnce(result(0))
    .mockResolvedValueOnce(result(1, "credential=private-token"))
    .mockResolvedValueOnce(result(0));
  try {
    await probePortableSandboxOciAfterBuildFailure(
      "docker.io/library/ubuntu@sha256:fixed",
      { XDG_CONFIG_HOME: "/private/config", API_KEY: "private-token" },
      artifacts,
      progress,
      runCommand,
    );
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(runCommand.mock.calls[0]?.[0]).toEqual([
      "image",
      "exists",
      "docker.io/library/ubuntu@sha256:fixed",
    ]);
    const runArgs = runCommand.mock.calls[1]?.[0] as string[];
    expect(runArgs.slice(0, 5)).toEqual([
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--name",
    ]);
    expect(runArgs.slice(6)).toEqual(["docker.io/library/ubuntu@sha256:fixed", "/bin/true"]);
    expect(runCommand.mock.calls[2]?.[0]).toEqual(["rm", "--force", "--ignore", runArgs[5]]);
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual([
      { XDG_CONFIG_HOME: "/private/config", API_KEY: "private-token" },
      { XDG_CONFIG_HOME: "/private/config", API_KEY: "private-token" },
      { XDG_CONFIG_HOME: "/private/config", API_KEY: "private-token" },
    ]);
    const evidence = fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8");
    expect(JSON.parse(evidence)).toEqual({
      schemaVersion: 1,
      category: "oci-execution-failed",
      baseImageCached: true,
      runStatus: 1,
      cleanupSucceeded: true,
    });
    expect(evidence).not.toContain("private-token");
    expect(evidence).not.toContain("/private/config");
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("skips OCI execution when the pinned base is absent (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oci-absent-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable OCI probe", ["prepare", "diagnose"], {
    logLine: () => undefined,
  });
  const runCommand = vi.fn().mockResolvedValue({ status: 1, signal: null, diagnostic: "" });
  try {
    await probePortableSandboxOciAfterBuildFailure(
      "pinned-base",
      {},
      artifacts,
      progress,
      runCommand,
    );
    expect(runCommand).toHaveBeenCalledOnce();
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "base-image-absent", baseImageCached: false, runStatus: null });
    const queryFailed = vi.fn().mockResolvedValue({ status: 125, signal: null, diagnostic: "" });
    await probePortableSandboxOciAfterBuildFailure(
      "pinned-base",
      {},
      artifacts,
      progress,
      queryFailed,
    );
    expect(queryFailed).toHaveBeenCalledOnce();
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "image-query-failed", baseImageCached: null, runStatus: null });
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("records a passing OCI probe and fails closed when exact cleanup is unproved (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oci-cleanup-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable OCI probe", ["prepare", "diagnose"], {
    logLine: () => undefined,
  });
  const result = (status: number) => ({ status, signal: null, diagnostic: "" });
  try {
    const passing = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0));
    await probePortableSandboxOciAfterBuildFailure("pinned-base", {}, artifacts, progress, passing);
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "oci-execution-passed", cleanupSucceeded: true });

    const cleanupFailed = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(125));
    await expect(
      probePortableSandboxOciAfterBuildFailure(
        "pinned-base",
        {},
        artifacts,
        progress,
        cleanupFailed,
      ),
    ).rejects.toThrow("Portable sandbox OCI probe cleanup unproved");
    expect(cleanupFailed).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "cleanup-unproved", cleanupSucceeded: false });

    const timedOut = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce({
        status: null,
        signal: "SIGKILL",
        diagnostic: "credential=private-token",
        error: Object.assign(new Error("private timeout"), { code: "ETIMEDOUT" }),
      })
      .mockResolvedValueOnce(result(0));
    await probePortableSandboxOciAfterBuildFailure(
      "pinned-base",
      {},
      artifacts,
      progress,
      timedOut,
    );
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "oci-execution-timeout", cleanupSucceeded: true });
    expect(
      fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8"),
    ).not.toContain("private-token");

    const unreconciled = {
      status: null,
      signal: "SIGKILL",
      diagnostic: "credential=private-token",
      error: Object.assign(new Error("private child survived"), { code: "EUNRECONCILED" }),
      unreconciledGroupId: 123,
    };
    const queryUnreconciled = vi.fn().mockResolvedValue(unreconciled);
    await expect(
      probePortableSandboxOciAfterBuildFailure(
        "pinned-base",
        {},
        artifacts,
        progress,
        queryUnreconciled,
      ),
    ).rejects.toThrow("Portable sandbox OCI probe cleanup unproved");
    expect(queryUnreconciled).toHaveBeenCalledOnce();
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "cleanup-unproved", cleanupSucceeded: false });

    const runUnreconciled = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(unreconciled);
    const onUnreconciled = vi.fn();
    await expect(
      probePortableSandboxOciAfterBuildFailure(
        "pinned-base",
        {},
        artifacts,
        progress,
        runUnreconciled,
        onUnreconciled,
      ),
    ).rejects.toThrow("Portable sandbox OCI probe cleanup unproved");
    expect(runUnreconciled).toHaveBeenCalledTimes(2);
    expect(onUnreconciled).toHaveBeenCalledOnce();
    expect(onUnreconciled).toHaveBeenCalledWith(123);
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "cleanup-unproved", cleanupSucceeded: false });

    const queryThrows = vi.fn().mockRejectedValue(new Error("private child state"));
    const onUnknown = vi.fn();
    await expect(
      probePortableSandboxOciAfterBuildFailure(
        "pinned-base",
        {},
        artifacts,
        progress,
        queryThrows,
        onUnknown,
      ),
    ).rejects.toThrow("Portable sandbox OCI probe cleanup unproved");
    expect(queryThrows).toHaveBeenCalledOnce();
    expect(onUnknown).toHaveBeenCalledOnce();
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("fails closed when a Podman group identity is missing or changes (#13482)", () => {
  const group = createPodmanGroupReconciliationTracker();
  expect(group.recoveryState()).toEqual({ unreconciled: false, unreconciledGroupId: undefined });
  group.mark(123);
  expect(group.recoveryState()).toEqual({ unreconciled: true, unreconciledGroupId: 123 });
  group.mark(124);
  expect(group.recoveryState()).toEqual({ unreconciled: true, unreconciledGroupId: undefined });
  group.mark(123);
  expect(group.recoveryState()).toEqual({ unreconciled: true, unreconciledGroupId: undefined });
  const unknown = createPodmanGroupReconciliationTracker();
  unknown.mark();
  expect(unknown.recoveryState()).toEqual({ unreconciled: true, unreconciledGroupId: undefined });
});

it("reconciles the exact supervised group before test-owned Podman cleanup (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-state-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const runCommand = vi.fn((_args: string[]) => ({ status: 0, signal: null }));
  const input = {
    artifacts,
    unreconciled: true,
    unreconciledGroupId: 123,
    disposableNetworkCreated: true,
    disposableNetworkId: "a".repeat(64),
    disposableNetworkName: "nemoclaw-portable-id-proof-123",
    runtimeDir: "/run/user/1001",
    selectedPodmanUrl: "unix:///run/user/1001/podman/podman.sock",
    hermesImageRef: "127.0.0.1:5000/nemoclaw-sandbox-local:hermes-fixed",
    env: {},
  };
  try {
    const stillPresent = vi.fn(async () => false);
    await expect(cleanupPortablePodmanResources(input, runCommand, stillPresent)).rejects.toThrow(
      "Portable Podman cleanup process group exit unproved",
    );
    expect(stillPresent).toHaveBeenCalledWith(123, 5_000);
    expect(runCommand).not.toHaveBeenCalled();
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-podman-cleanup-state.json"), "utf8")),
    ).toEqual({
      schemaVersion: 1,
      status: "skipped-unreconciled-process",
      resumeAfter: "supervised-process-group-exited",
      selectedPodmanSocket: "/run/user/1001/podman/podman.sock",
      skippedTargets: {
        network: "a".repeat(64),
        registryContainer: "nemoclaw-portable-registry",
        hermesImage: "127.0.0.1:5000/nemoclaw-sandbox-local:hermes-fixed",
        podmanSystemReset: true,
      },
    });
    await expect(
      cleanupPortablePodmanResources(
        { ...input, disposableNetworkId: null, unreconciledGroupId: undefined },
        runCommand,
        vi.fn(async () => true),
      ),
    ).rejects.toThrow("Portable Podman cleanup recovery identity unproved");
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-podman-cleanup-state.json"), "utf8")),
    ).toMatchObject({ skippedTargets: { network: "nemoclaw-portable-id-proof-123" } });
    expect(runCommand).not.toHaveBeenCalled();
    let releaseProof: (value: boolean) => void = () => undefined;
    const proof = new Promise<boolean>((resolve) => {
      releaseProof = resolve;
    });
    const cleanup = cleanupPortablePodmanResources(input, runCommand, () => proof);
    await Promise.resolve();
    expect(runCommand).not.toHaveBeenCalled();
    releaseProof(true);
    await cleanup;
    expect(runCommand.mock.calls.map(([args]) => args)).toEqual([
      ["--url", "unix:///run/user/1001/podman/podman.sock", "network", "rm", "a".repeat(64)],
      ["--url", input.selectedPodmanUrl, "rm", "--force", "nemoclaw-portable-registry"],
      [
        "--url",
        input.selectedPodmanUrl,
        "image",
        "rm",
        "--force",
        "127.0.0.1:5000/nemoclaw-sandbox-local:hermes-fixed",
      ],
      ["--remote=false", "system", "reset", "--force"],
    ]);
    expect(
      JSON.parse(
        fs.readFileSync(artifacts.pathFor("portable-podman-cleanup-reconciliation.json"), "utf8"),
      ),
    ).toEqual({ schemaVersion: 1, status: "reconciled-cleanup-completed" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("uses the selected Podman service and reports cleanup failures without output (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-authority-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const selectedPodmanUrl = "unix:///run/user/1001/alternate/podman.sock";
  const runCommand = vi
    .fn()
    .mockReturnValueOnce({
      status: null,
      signal: "SIGKILL",
      error: Object.assign(new Error("credential=private-token"), { code: "ETIMEDOUT" }),
    })
    .mockReturnValue({ status: 0, signal: null });
  try {
    await expect(
      cleanupPortablePodmanResources(
        {
          artifacts,
          unreconciled: false,
          selectedPodmanUrl,
          disposableNetworkCreated: true,
          disposableNetworkId: "a".repeat(64),
          disposableNetworkName: "nemoclaw-portable-id-proof-123",
          runtimeDir: "/run/user/1001",
          hermesImageRef: "127.0.0.1:5000/nemoclaw-sandbox-local:hermes-fixed",
          env: {},
        },
        runCommand,
      ),
    ).rejects.toThrow("Portable Podman cleanup failed for test-owned resources");
    expect(runCommand.mock.calls.map(([args]) => args)).toEqual([
      ["--url", selectedPodmanUrl, "network", "rm", "a".repeat(64)],
      ["--url", selectedPodmanUrl, "rm", "--force", "nemoclaw-portable-registry"],
      [
        "--url",
        selectedPodmanUrl,
        "image",
        "rm",
        "--force",
        "127.0.0.1:5000/nemoclaw-sandbox-local:hermes-fixed",
      ],
    ]);
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-podman-cleanup-state.json"), "utf8")),
    ).toEqual({
      schemaVersion: 1,
      status: "local-system-reset-skipped",
      reason: "selected-socket-is-not-local-default",
    });
    const evidence = fs.readFileSync(
      artifacts.pathFor("portable-podman-cleanup-failure.json"),
      "utf8",
    );
    expect(JSON.parse(evidence)).toEqual({
      schemaVersion: 1,
      failedTargets: [{ target: "network", category: "timeout" }],
    });
    expect(evidence).not.toContain("private-token");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("sequences authority, build evidence, and only safe sandbox OCI probes (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-callback-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable build callback", ["prepare", "build"], {
    logLine: () => undefined,
  });
  const selectedUrl = "unix:///run/user/1001/podman/podman.sock";
  const baseImage = "docker.io/library/ubuntu@sha256:fixed";
  const options = { env: { XDG_CONFIG_HOME: "/private/config" }, stdio: "inherit" as const };
  const args = ["build", "-t", "localhost/sandbox:fixed", "."];
  const events: string[] = [];
  const outcomes = [
    { status: 0, reconciled: true },
    { status: 1, reconciled: true },
    { status: null, reconciled: true },
    { status: 1, reconciled: true },
    { status: null, reconciled: false },
  ];
  const verifyAuthority = vi.fn(async () => {
    events.push("verify");
  });
  const buildWithEvidence = vi.fn(
    async (...call: Parameters<typeof buildPortableSandboxImageWithEvidence>) => {
      events.push("build");
      const outcome = outcomes.shift()!;
      call[5]?.(outcome.reconciled);
      return outcome.status;
    },
  );
  const probeOci = vi.fn(async () => {
    events.push("probe");
  });
  const onUnreconciled = vi.fn();
  try {
    const buildImage = portableSandboxImageBuilder(
      artifacts,
      progress,
      selectedUrl,
      baseImage,
      {
        verifyAuthority,
        buildWithEvidence,
        probeOci,
      },
      onUnreconciled,
    );
    expect(await buildImage("sandbox")(args, options)).toBe(0);
    expect(await buildImage("sandbox")(args, options)).toBe(1);
    expect(await buildImage("sandbox")(args, options)).toBeNull();
    expect(await buildImage("hermes")(args, options)).toBe(1);
    expect(await buildImage("sandbox")(args, options)).toBeNull();
    expect(events).toEqual([
      "verify",
      "build",
      "verify",
      "build",
      "probe",
      "verify",
      "build",
      "probe",
      "verify",
      "build",
      "verify",
      "build",
    ]);
    expect(verifyAuthority).toHaveBeenCalledTimes(5);
    expect(verifyAuthority).toHaveBeenNthCalledWith(
      1,
      options.env,
      process.env,
      selectedUrl,
      "/private/config",
      "portable-podman-store-sandbox.json",
      artifacts,
    );
    expect(verifyAuthority).toHaveBeenNthCalledWith(
      4,
      options.env,
      process.env,
      selectedUrl,
      "/private/config",
      "portable-podman-store-hermes.json",
      artifacts,
    );
    expect(buildWithEvidence).toHaveBeenCalledTimes(5);
    expect(buildWithEvidence).toHaveBeenNthCalledWith(
      1,
      args,
      options,
      artifacts,
      progress,
      undefined,
      expect.any(Function),
    );
    expect(probeOci).toHaveBeenCalledTimes(2);
    expect(probeOci).toHaveBeenNthCalledWith(
      1,
      baseImage,
      options.env,
      artifacts,
      progress,
      undefined,
      onUnreconciled,
    );
    expect(probeOci).toHaveBeenNthCalledWith(
      2,
      baseImage,
      options.env,
      artifacts,
      progress,
      undefined,
      onUnreconciled,
    );
    expect(onUnreconciled).toHaveBeenCalledOnce();
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// source-shape-contract: compatibility -- The trusted rootless job deadline must contain its live E2E and setup and artifact-upload budgets
it("reserves live-test time for bounded image, gateway, create, lifecycle, and cleanup work (#13482)", () => {
  expect(PORTABLE_GATEWAY_STARTUP_BUDGET_MS).toBeGreaterThanOrEqual(15_000);
  expect(PORTABLE_SANDBOX_CREATE_BUDGET_MS).toBeGreaterThanOrEqual(240_000);
  expect(PORTABLE_HERMES_LIFECYCLE_BUDGET_MS).toBeGreaterThanOrEqual(
    2 * 240_000 + 2 * (60_000 + 30_000),
  );
  expect(PORTABLE_SANDBOX_DELETE_BUDGET_MS).toBeGreaterThanOrEqual(60_000);
  expect(PORTABLE_ASSERTION_CLEANUP_RESERVE_MS).toBeGreaterThanOrEqual(6 * 60_000);
  expect(PORTABLE_PROFILE_LIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(
    4 * PORTABLE_IMAGE_COMMAND_TIMEOUT_MS +
      PORTABLE_GATEWAY_STARTUP_BUDGET_MS +
      PORTABLE_SANDBOX_CREATE_BUDGET_MS +
      PORTABLE_HERMES_LIFECYCLE_BUDGET_MS +
      PORTABLE_SANDBOX_DELETE_BUDGET_MS +
      PORTABLE_ASSERTION_CLEANUP_RESERVE_MS,
  );
  const workflow = YAML.parse(
    fs.readFileSync(".github/workflows/portable-profile-e2e.yaml", "utf8"),
  ) as { jobs: { "rootless-linux": { "timeout-minutes": number } } };
  const jobTimeoutMs = workflow.jobs["rootless-linux"]["timeout-minutes"] * 60_000;
  expect(jobTimeoutMs).toBeGreaterThanOrEqual(
    PORTABLE_PROFILE_LIVE_TIMEOUT_MS + 30 * 60_000 + 5 * 60_000,
  );
});

it("retains a build signal and allowlisted error code without error text (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-diagnostic-"));
  const progress = startTestProgress(
    "portable build diagnostics",
    ["prepare build", "build sandbox image"],
    {
      logLine: () => undefined,
    },
  );
  try {
    const artifacts = new ArtifactSink(path.join(directory, "portable-build"));
    const reconciled = vi.fn();
    const status = await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: null,
        signal: "SIGTERM" as const,
        diagnostic: "credential=private-build-token",
        error: Object.assign(new Error("private error text"), { code: "EACCES" }),
      })),
      reconciled,
    );

    expect(status).toBeNull();
    expect(reconciled).toHaveBeenCalledWith(true);
    const published = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(published)).toEqual({
      schemaVersion: 1,
      status: null,
      signal: "SIGTERM",
      errorCode: "EACCES",
      category: "unclassified",
      observedBuildStep: "unknown",
    });
    expect(published).not.toContain("private-build-token");
    expect(published).not.toContain("private error text");

    const unreconciledSignal = vi.fn();
    await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: null,
        signal: "SIGKILL" as const,
        diagnostic: "credential=private-build-token",
        error: Object.assign(new Error("private error text"), { code: "EUNRECONCILED" }),
        unreconciledGroupId: 456,
      })),
      unreconciledSignal,
    );
    expect(unreconciledSignal).toHaveBeenCalledWith(false, 456);
    const unreconciled = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(unreconciled)).toMatchObject({
      errorCode: "EUNRECONCILED",
      category: "process-isolation",
    });
    expect(unreconciled).not.toContain("private-build-token");
    const thrownSignal = vi.fn();
    await expect(
      buildPortableSandboxImageWithEvidence(
        ["build"],
        { env: {}, stdio: "inherit" },
        artifacts,
        progress,
        vi.fn().mockRejectedValue(new Error("unknown child state")),
        thrownSignal,
      ),
    ).rejects.toThrow("unknown child state");
    expect(thrownSignal).toHaveBeenCalledWith(false);
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps a failed registry push separate from build evidence (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-publish-diagnostic-"));
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  const dockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(dockerfile, "FROM scratch\n");
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable build diagnostics", ["build", "publish"], {
    logLine: () => undefined,
  });
  const fetchRegistry = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const runBuild = vi.fn(async (_args: readonly string[], _env: NodeJS.ProcessEnv) => ({
    status: 0,
    signal: null,
    diagnostic: "",
  }));
  const runPublish = vi.fn(
    async (_args: readonly string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) => ({
      status: 125,
      signal: null,
      diagnostic: "registry push refused; credential=private-push-token",
    }),
  );

  try {
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: "rootless-e2e",
        createArgs: ["--from", dockerfile, "--name", "portable-e2e"],
        sandboxName: "portable-e2e",
        dockerDriverGateway: true,
        env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable", NEMOCLAW_SANDBOX_PREBUILD: "1" },
        origin: "generated",
        buildImage: (args, options) =>
          buildPortableSandboxImageWithEvidence(args, options, artifacts, progress, runBuild),
        publishImage: (args, options) =>
          publishPortableSandboxImage(args, options, artifacts, progress, runPublish),
        inspectImageId: () => `sha256:${"a".repeat(64)}`,
        log: () => undefined,
      }),
    ).rejects.toThrow("Managed local registry publish failed (exit 125)");

    expect(fetchRegistry).toHaveBeenCalledOnce();
    expect(runBuild).toHaveBeenCalledOnce();
    expect(runBuild.mock.calls[0]?.[0]?.[0]).toBe("build");
    expect(runPublish).toHaveBeenCalledOnce();
    expect(runPublish.mock.calls[0]?.[0]?.[0]).toBe("push");
    expect(runPublish.mock.calls[0]?.[2]).toBe(PORTABLE_IMAGE_COMMAND_TIMEOUT_MS);
    expect(fs.existsSync(artifacts.pathFor("portable-sandbox-image-build-failure.json"))).toBe(
      false,
    );
    const publication = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-publish-failure.json"),
      "utf8",
    );
    expect(JSON.parse(publication)).toMatchObject({
      schemaVersion: 1,
      status: 125,
      signal: null,
      errorCode: null,
      category: "unclassified",
      observedBuildStep: "unknown",
    });
    expect(publication).not.toContain("private-push-token");
  } finally {
    fetchRegistry.mockRestore();
    progress.stop();
    fs.rmSync(buildCtx, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("stops live Podman cleanup after an unreconciled registry publish (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-publish-unreconciled-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable registry publish", ["build", "publish"], {
    logLine: () => undefined,
  });
  const runCommand = vi.fn(() => ({ status: 0, signal: null }));
  let unreconciled = false;
  let groupId: number | undefined;
  try {
    const status = await publishPortableSandboxImage(
      ["push", "localhost/test:fixed"],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: null,
        signal: "SIGKILL" as const,
        diagnostic: "credential=private-push-token",
        error: Object.assign(new Error("private error text"), { code: "EUNRECONCILED" }),
        unreconciledGroupId: 789,
      })),
      (observedGroupId) => {
        unreconciled = true;
        groupId = observedGroupId;
      },
    );
    expect(status).toBeNull();
    expect(unreconciled).toBe(true);
    expect(groupId).toBe(789);
    const published = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-publish-failure.json"),
      "utf8",
    );
    expect(JSON.parse(published)).toMatchObject({
      errorCode: "EUNRECONCILED",
      category: "process-isolation",
    });
    expect(published).not.toContain("private-push-token");
    expect(published).not.toContain("private error text");
    await expect(
      cleanupPortablePodmanResources(
        {
          artifacts,
          unreconciled,
          unreconciledGroupId: groupId,
          disposableNetworkCreated: true,
          disposableNetworkId: null,
          disposableNetworkName: "credential=private-network-token",
          runtimeDir: "/private/credential=private-socket-token",
          selectedPodmanUrl: "unix:///run/user/1001/podman/podman.sock",
          hermesImageRef: "credential=private-image-token",
          env: {},
        },
        runCommand,
        vi.fn(async () => false),
      ),
    ).rejects.toThrow("Portable Podman cleanup process group exit unproved");
    expect(runCommand).not.toHaveBeenCalled();
    const cleanupState = fs.readFileSync(
      artifacts.pathFor("portable-podman-cleanup-state.json"),
      "utf8",
    );
    expect(JSON.parse(cleanupState)).toEqual({
      schemaVersion: 1,
      status: "skipped-unreconciled-process",
      resumeAfter: "supervised-process-group-exited",
      selectedPodmanSocket: null,
      skippedTargets: {
        network: null,
        registryContainer: "nemoclaw-portable-registry",
        hermesImage: null,
        podmanSystemReset: true,
      },
    });
    expect(cleanupState).not.toContain("private-network-token");
    expect(cleanupState).not.toContain("private-socket-token");
    expect(cleanupState).not.toContain("private-image-token");
    unreconciled = false;
    await expect(
      publishPortableSandboxImage(
        ["push", "localhost/test:fixed"],
        { env: {}, stdio: "inherit" },
        artifacts,
        progress,
        vi.fn().mockRejectedValue(new Error("unknown child state")),
        () => {
          unreconciled = true;
        },
      ),
    ).rejects.toThrow("unknown child state");
    expect(unreconciled).toBe(true);
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
