// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { describe } from "vitest";

import { type DockerCommandResult, DockerProbe, resultText } from "./e2e/fixtures/docker-probe.ts";
import { expect, test } from "./e2e/fixtures/e2e-test.ts";

const TARGET_ID = "openclaw-security-revision-container-e2e";
const RUN_ENV = "NEMOCLAW_RUN_OPENCLAW_SECURITY_REVISION_CONTAINER_E2E";
const IMAGE_ENV = "NEMOCLAW_OPENCLAW_SECURITY_REVISION_IMAGE";
const EVIDENCE_PREFIX = "NEMOCLAW_SECURITY_REVISION_EVIDENCE=";
const OPENCLAW_ROOT = "/usr/local/lib/node_modules/openclaw";
const OPENCLAW_ENTRYPOINT = "/usr/local/bin/openclaw";
const TAR_VERSION = "7.5.19";
const TAR_INTEGRITY =
  "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==";
const TAR_TARBALL = "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz";
const BRACE_EXPANSION_VERSION = "5.0.7";
const BRACE_EXPANSION_INTEGRITY =
  "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==";
const BRACE_EXPANSION_TARBALL =
  "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.7.tgz";
const FS_SAFE_INTEGRITY =
  "sha512-uIBE441CIt1kIURoP9qRGKZ8LkGyfD9ZzeESjwAd29ZPWtghws/5GR3Pjb67jKdcJHP1I6roNXcvnhzAU7lHlA==";
const FS_SAFE_TARBALL = "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.3.0.tgz";
const JSZIP_VERSION = "3.10.1";
const JSZIP_INTEGRITY =
  "sha512-xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==";
const JSZIP_TARBALL = "https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz";
const RUN_TIMEOUT_MS = 5 * 60_000;
const NPM_LS_ARGS = [
  "ls",
  "--global",
  "--depth=1",
  "openclaw",
  "@openclaw/fs-safe",
  "tar",
  "jszip",
] as const;

type LockedPackage = Readonly<{
  hasOptionalDependencies: boolean;
  integrity: string | null;
  optionalDependencies: Readonly<Record<string, string>> | null;
  resolved: string | null;
  version: string | null;
}>;

type ProbeEvidence = Readonly<{
  command: Readonly<{
    exitCode: number;
    output: string;
    target: string | null;
  }>;
  npmLs: Readonly<{
    args: readonly string[];
    exitCode: number;
    output: string;
  }>;
  fsSafeHasOptionalDependencies: boolean;
  fsSafeOptionalDependencies: Readonly<Record<string, string>> | null;
  openClaw: Readonly<{
    bundledDependencies: readonly string[] | null;
    dependencies: Readonly<Record<string, string>>;
    name: string | null;
    version: string | null;
  }>;
  packageVersions: Readonly<{
    braceExpansion: readonly string[];
    fsSafe: readonly string[];
    jszip: readonly string[];
    tar: readonly string[];
  }>;
  shrinkwrap: Readonly<{
    braceExpansion: LockedPackage;
    fsSafe: LockedPackage;
    hasNestedFsSafeJszip: boolean;
    hasNestedFsSafeTar: boolean;
    jszip: LockedPackage;
    lockfileVersion: number | null;
    rootDependencies: Readonly<Record<string, string>>;
    tar: LockedPackage;
  }>;
}>;

function requireCondition(condition: boolean, message: string): void {
  switch (condition) {
    case true:
      return;
    default:
      throw new Error(message);
  }
}

function requireSafeImageReference(value: string): string {
  const image = value.trim();
  requireCondition(
    /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,438}@sha256:[0-9a-f]{64}$/iu.test(image),
    `${IMAGE_ENV} must be an immutable named Docker image digest`,
  );
  return image;
}

function resolveConfiguredImage(env: NodeJS.ProcessEnv): string | undefined {
  const selected = env.E2E_TARGET_ID === TARGET_ID;
  const explicit = env[RUN_ENV];
  requireCondition(
    explicit === undefined || explicit === "0" || explicit === "1",
    `${RUN_ENV} must be 0 or 1`,
  );
  const enabled = selected || explicit === "1";
  const image = env[IMAGE_ENV]?.trim();
  switch (enabled) {
    case false:
      requireCondition(!image, `${IMAGE_ENV} requires ${RUN_ENV}=1`);
      return undefined;
    default:
      requireCondition(
        Boolean(image),
        `${IMAGE_ENV} is required when the container E2E is enabled`,
      );
      return requireSafeImageReference(image as string);
  }
}

const PROBE_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = ${JSON.stringify(OPENCLAW_ROOT)};
const entrypoint = ${JSON.stringify(OPENCLAW_ENTRYPOINT)};
let visited = 0;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readLockedPackage(value) {
  return {
    hasOptionalDependencies: Object.prototype.hasOwnProperty.call(
      value ?? {},
      "optionalDependencies",
    ),
    integrity: value?.integrity ?? null,
    optionalDependencies: value?.optionalDependencies ?? null,
    resolved: value?.resolved ?? null,
    version: value?.version ?? null,
  };
}

function packageDirectories(nodeModules) {
  if (!fs.existsSync(nodeModules)) return [];
  const directories = [];
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (++visited > 50000) throw new Error("installed package graph exceeded verifier bound");
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(nodeModules, entry.name);
    if (!entry.name.startsWith("@")) {
      directories.push(candidate);
      continue;
    }
    for (const scoped of fs.readdirSync(candidate, { withFileTypes: true })) {
      if (++visited > 50000) throw new Error("installed package graph exceeded verifier bound");
      if (scoped.isDirectory() && !scoped.isSymbolicLink()) {
        directories.push(path.join(candidate, scoped.name));
      }
    }
  }
  return directories;
}

const versions = new Map();
function collectPackages(packageRoot) {
  const manifestPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(manifestPath)) return;
  const manifest = readJson(manifestPath);
  if (typeof manifest.name === "string" && typeof manifest.version === "string") {
    const found = versions.get(manifest.name) ?? new Set();
    found.add(manifest.version);
    versions.set(manifest.name, found);
  }
  for (const child of packageDirectories(path.join(packageRoot, "node_modules"))) {
    collectPackages(child);
  }
}

function versionsFor(name) {
  return [...(versions.get(name) ?? [])].sort();
}

const packageJson = readJson(path.join(root, "package.json"));
const shrinkwrap = readJson(path.join(root, "npm-shrinkwrap.json"));
const packages = shrinkwrap.packages ?? {};
const fsSafePackage = readJson(path.join(root, "node_modules", "@openclaw", "fs-safe", "package.json"));
collectPackages(root);

const command = spawnSync(entrypoint, ["--version"], {
  encoding: "utf8",
  env: { ...process.env, HOME: "/tmp/openclaw-security-revision-home" },
  stdio: ["ignore", "pipe", "pipe"],
});
const npmLsArgs = ${JSON.stringify(NPM_LS_ARGS)};
const npmLs = spawnSync("npm", npmLsArgs, {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: "/tmp/openclaw-security-revision-home",
      npm_config_cache: "/tmp/npm-cache",
    },
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
});

let commandTarget = null;
try {
  commandTarget = fs.realpathSync(entrypoint);
} catch {}

const evidence = {
  command: {
    exitCode: command.status ?? -1,
    output: String(command.stdout ?? "").trim(),
    target: commandTarget,
  },
  fsSafeHasOptionalDependencies: Object.prototype.hasOwnProperty.call(
    fsSafePackage,
    "optionalDependencies",
  ),
  fsSafeOptionalDependencies: fsSafePackage.optionalDependencies ?? null,
  npmLs: {
    args: npmLsArgs,
    exitCode: npmLs.status ?? -1,
    output: String(npmLs.stderr || npmLs.stdout || "").trim().slice(-4000),
  },
  openClaw: {
    bundledDependencies: packageJson.bundledDependencies ?? null,
    dependencies: packageJson.dependencies ?? {},
    name: packageJson.name ?? null,
    version: packageJson.version ?? null,
  },
  packageVersions: {
    braceExpansion: versionsFor("brace-expansion"),
    fsSafe: versionsFor("@openclaw/fs-safe"),
    jszip: versionsFor("jszip"),
    tar: versionsFor("tar"),
  },
  shrinkwrap: {
    braceExpansion: readLockedPackage(packages["node_modules/brace-expansion"]),
    fsSafe: readLockedPackage(packages["node_modules/@openclaw/fs-safe"]),
    hasNestedFsSafeJszip: packages["node_modules/@openclaw/fs-safe/node_modules/jszip"] !== undefined,
    hasNestedFsSafeTar: packages["node_modules/@openclaw/fs-safe/node_modules/tar"] !== undefined,
    jszip: readLockedPackage(packages["node_modules/jszip"]),
    lockfileVersion: shrinkwrap.lockfileVersion ?? null,
    rootDependencies: packages[""]?.dependencies ?? {},
    tar: readLockedPackage(packages["node_modules/tar"]),
  },
};

process.stdout.write(${JSON.stringify(EVIDENCE_PREFIX)} + JSON.stringify(evidence) + "\n");
`;

function secureDockerRunArgs(container: string, image: string): string[] {
  return [
    "run",
    "--rm",
    "--name",
    container,
    "--user",
    "sandbox:sandbox",
    "--read-only",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "256m",
    "--memory-swap",
    "256m",
    "--cpus",
    "1",
    "--ulimit",
    "nofile=1024:1024",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "--entrypoint",
    "node",
    image,
    "-e",
    PROBE_SOURCE,
  ];
}

function parseEvidence(result: DockerCommandResult): ProbeEvidence {
  requireCondition(result.exitCode === 0, resultText(result));
  const line = result.stdout
    .split(/\r?\n/gu)
    .reverse()
    .find((candidate) => candidate.startsWith(EVIDENCE_PREFIX));
  requireCondition(
    Boolean(line),
    `container did not emit security revision evidence\n${resultText(result)}`,
  );
  return JSON.parse((line as string).slice(EVIDENCE_PREFIX.length)) as ProbeEvidence;
}

function exactEvidence(): ProbeEvidence {
  return {
    command: {
      exitCode: 0,
      output: "OpenClaw 2026.6.10",
      target: `${OPENCLAW_ROOT}/openclaw.mjs`,
    },
    fsSafeHasOptionalDependencies: false,
    fsSafeOptionalDependencies: null,
    npmLs: {
      args: [...NPM_LS_ARGS],
      exitCode: 0,
      output: "",
    },
    openClaw: {
      bundledDependencies: ["@openclaw/fs-safe"],
      dependencies: {
        "@openclaw/fs-safe": "0.3.0",
        jszip: JSZIP_VERSION,
        tar: TAR_VERSION,
      },
      name: "openclaw",
      version: "2026.6.10",
    },
    packageVersions: {
      braceExpansion: [BRACE_EXPANSION_VERSION],
      fsSafe: ["0.3.0"],
      jszip: [JSZIP_VERSION],
      tar: [TAR_VERSION],
    },
    shrinkwrap: {
      braceExpansion: {
        hasOptionalDependencies: false,
        integrity: BRACE_EXPANSION_INTEGRITY,
        optionalDependencies: null,
        resolved: BRACE_EXPANSION_TARBALL,
        version: BRACE_EXPANSION_VERSION,
      },
      fsSafe: {
        hasOptionalDependencies: false,
        integrity: FS_SAFE_INTEGRITY,
        optionalDependencies: null,
        resolved: FS_SAFE_TARBALL,
        version: "0.3.0",
      },
      hasNestedFsSafeJszip: false,
      hasNestedFsSafeTar: false,
      jszip: {
        hasOptionalDependencies: false,
        integrity: JSZIP_INTEGRITY,
        optionalDependencies: null,
        resolved: JSZIP_TARBALL,
        version: JSZIP_VERSION,
      },
      lockfileVersion: 3,
      rootDependencies: {
        "@openclaw/fs-safe": "0.3.0",
        jszip: JSZIP_VERSION,
        tar: TAR_VERSION,
      },
      tar: {
        hasOptionalDependencies: false,
        integrity: TAR_INTEGRITY,
        optionalDependencies: null,
        resolved: TAR_TARBALL,
        version: TAR_VERSION,
      },
    },
  };
}

function requireExactRemediation(evidence: ProbeEvidence): void {
  expect(evidence.command.exitCode).toBe(0);
  expect(evidence.command.output).toMatch(/\b2026\.6\.10\b/u);
  expect(evidence.command.target).toBe(`${OPENCLAW_ROOT}/openclaw.mjs`);
  expect(evidence.npmLs.args).toEqual(NPM_LS_ARGS);
  expect(evidence.npmLs.exitCode).toBe(0);
  expect(evidence.openClaw.name).toBe("openclaw");
  expect(evidence.openClaw.version).toBe("2026.6.10");
  expect(evidence.openClaw.dependencies).toMatchObject({
    "@openclaw/fs-safe": "0.3.0",
    jszip: JSZIP_VERSION,
    tar: TAR_VERSION,
  });
  expect(evidence.openClaw.bundledDependencies).toEqual(["@openclaw/fs-safe"]);
  expect(evidence.packageVersions).toEqual({
    braceExpansion: [BRACE_EXPANSION_VERSION],
    fsSafe: ["0.3.0"],
    jszip: [JSZIP_VERSION],
    tar: [TAR_VERSION],
  });
  expect(evidence.fsSafeHasOptionalDependencies).toBe(false);
  expect(evidence.fsSafeOptionalDependencies).toBeNull();
  expect(evidence.shrinkwrap.lockfileVersion).toBe(3);
  expect(evidence.shrinkwrap.rootDependencies).toMatchObject({
    "@openclaw/fs-safe": "0.3.0",
    jszip: JSZIP_VERSION,
    tar: TAR_VERSION,
  });
  expect(evidence.shrinkwrap.tar).toMatchObject({
    hasOptionalDependencies: false,
    integrity: TAR_INTEGRITY,
    optionalDependencies: null,
    resolved: TAR_TARBALL,
    version: TAR_VERSION,
  });
  expect(evidence.shrinkwrap.braceExpansion).toMatchObject({
    hasOptionalDependencies: false,
    integrity: BRACE_EXPANSION_INTEGRITY,
    optionalDependencies: null,
    resolved: BRACE_EXPANSION_TARBALL,
    version: BRACE_EXPANSION_VERSION,
  });
  expect(evidence.shrinkwrap.fsSafe).toMatchObject({
    hasOptionalDependencies: false,
    integrity: FS_SAFE_INTEGRITY,
    optionalDependencies: null,
    resolved: FS_SAFE_TARBALL,
    version: "0.3.0",
  });
  expect(evidence.shrinkwrap.jszip).toMatchObject({
    hasOptionalDependencies: false,
    integrity: JSZIP_INTEGRITY,
    optionalDependencies: null,
    resolved: JSZIP_TARBALL,
    version: JSZIP_VERSION,
  });
  expect(evidence.shrinkwrap.hasNestedFsSafeJszip).toBe(false);
  expect(evidence.shrinkwrap.hasNestedFsSafeTar).toBe(false);
}

const configuredImage = resolveConfiguredImage(process.env);
const realContainerTest = configuredImage ? test : test.skip;

describe("OpenClaw current-image security revision contract (#7272)", () => {
  test("keeps real Docker execution explicitly opt-in until its image dependency lands (#7286)", () => {
    expect(resolveConfiguredImage({})).toBeUndefined();
    expect(() => resolveConfiguredImage({ [RUN_ENV]: "1" })).toThrow(IMAGE_ENV);
    expect(() => resolveConfiguredImage({ [IMAGE_ENV]: "candidate:local" })).toThrow(RUN_ENV);
    expect(() =>
      resolveConfiguredImage({ [RUN_ENV]: "1", [IMAGE_ENV]: "candidate:local" }),
    ).toThrow("immutable named Docker image digest");
    const immutableImage = `nemoclaw-production@sha256:${"a".repeat(64)}`;
    expect(resolveConfiguredImage({ [RUN_ENV]: "1", [IMAGE_ENV]: immutableImage })).toBe(
      immutableImage,
    );
  });

  test("uses an offline read-only least-privilege Docker boundary", () => {
    const args = secureDockerRunArgs("security-e2e", "candidate:local");
    for (const [option, value] of [
      ["--network", "none"],
      ["--cap-drop", "ALL"],
      ["--security-opt", "no-new-privileges"],
    ] as const) {
      const optionIndex = args.indexOf(option);
      expect(args.slice(optionIndex, optionIndex + 2)).toEqual([option, value]);
    }
    expect(args).not.toContain("host");
    expect(args).toContain("--read-only");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args).not.toContain("--mount");
  });

  test("rejects vulnerable or incomplete installed dependency evidence", () => {
    const good = exactEvidence();
    expect(() => requireExactRemediation(good)).not.toThrow();
    expect(() =>
      requireExactRemediation({
        ...good,
        packageVersions: { ...good.packageVersions, tar: ["7.5.16"] },
      }),
    ).toThrow();
    expect(() =>
      requireExactRemediation({
        ...good,
        fsSafeOptionalDependencies: { jszip: "^3.10.1", tar: "7.5.13" },
      }),
    ).toThrow();
    expect(() =>
      requireExactRemediation({
        ...good,
        fsSafeHasOptionalDependencies: true,
      }),
    ).toThrow();
    expect(() =>
      requireExactRemediation({
        ...good,
        shrinkwrap: { ...good.shrinkwrap, hasNestedFsSafeTar: true },
      }),
    ).toThrow();
    for (const compromisedJszip of [
      { integrity: "sha512-unreviewed" },
      { resolved: "https://registry.npmjs.org/jszip/-/jszip-3.10.0.tgz" },
      { version: "3.10.0" },
    ]) {
      expect(() =>
        requireExactRemediation({
          ...good,
          shrinkwrap: {
            ...good.shrinkwrap,
            jszip: { ...good.shrinkwrap.jszip, ...compromisedJszip },
          },
        }),
      ).toThrow();
    }
    for (const packageName of ["tar", "braceExpansion", "jszip"] as const) {
      for (const optionalDependencyState of [
        { hasOptionalDependencies: true },
        { optionalDependencies: { unreviewed: "1.0.0" } },
      ]) {
        expect(() =>
          requireExactRemediation({
            ...good,
            shrinkwrap: {
              ...good.shrinkwrap,
              [packageName]: {
                ...good.shrinkwrap[packageName],
                ...optionalDependencyState,
              },
            },
          }),
        ).toThrow();
      }
    }
    expect(() =>
      requireExactRemediation({
        ...good,
        npmLs: { ...good.npmLs, exitCode: 1, output: "invalid graph" },
      }),
    ).toThrow();
  });
});

realContainerTest(
  "the #7286 image ships only the reviewed OpenClaw dependency graph (#7272)",
  async ({ artifacts, docker, secrets }) => {
    const image = configuredImage as string;
    const probe = new DockerProbe(artifacts, (text, extraValues) =>
      secrets.redact(text, extraValues),
    );
    const container = `nemoclaw-security-e2e-${process.pid}-${randomUUID()}`.toLowerCase();

    await artifacts.target.declare({
      id: TARGET_ID,
      boundary: "openclaw-2026.6.10-installed-remediation",
      image,
      contracts: [
        "the current OpenClaw image contains the exact remediated dependency graph from #7286",
        "the verifier runs offline, read-only, unprivileged, and without host mounts",
      ],
    });
    await docker.requireDocker();
    await probe.expect(["image", "inspect", image], {
      artifactName: "inspect-security-revision-image",
      timeoutMs: 30_000,
    });

    const result = await probe.run(secureDockerRunArgs(container, image), {
      artifactName: "inspect-openclaw-installed-graph",
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const evidence = parseEvidence(result);
    requireExactRemediation(evidence);
    await artifacts.writeJson("evidence/openclaw-installed-graph.json", evidence);

    await artifacts.target.complete({
      id: TARGET_ID,
      image,
      assertions: {
        braceExpansionVersion: BRACE_EXPANSION_VERSION,
        fsSafeOptionalDependenciesRemoved: true,
        openClawVersion: "2026.6.10",
        tarVersion: TAR_VERSION,
      },
    });
  },
  10 * 60_000,
);
