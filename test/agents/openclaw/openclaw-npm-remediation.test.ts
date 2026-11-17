// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemediatedOpenClawPluginArchive,
  fatalOpenClawNpmRemediationDiagnostic,
  hashPackageTree,
  patchDiscordEmbeddedZodPackage,
  patchOpenClawDiagnosticsOtelPackageGraph,
  patchOpenClawBundledZodPackageGraph,
  patchOpenClawDiscordPackageGraph,
  patchOpenClawPluginPackageGraph,
  patchOpenClaw105PluginDependencies,
  patchOpenClawSlackProxyAddrPackageGraph,
  remediateInstalledOfficialOpenClawPlugin,
  OpenClawNpmRemediationCommandError,
  runOpenClawNpmRemediationCommand,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

const temporaryDirectories: string[] = [];

function writeFixture(axiosVersion = "1.16.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-npm-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/slack",
        version: "2026.7.1",
        dependencies: { "@slack/bolt": "4.7.3" },
        bundledDependencies: ["@slack/bolt"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/slack",
        version: "2026.7.1",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "@openclaw/slack",
            version: "2026.7.1",
            dependencies: { "@slack/bolt": "4.7.3" },
          },
          "node_modules/axios": {
            version: axiosVersion,
            resolved: `https://registry.npmjs.org/axios/-/axios-${axiosVersion}.tgz`,
            integrity: "sha512-old",
            dependencies: {
              "follow-redirects": "^1.16.0",
              "form-data": "^4.0.5",
              "proxy-from-env": "^2.1.0",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeDiagnosticsFixture(jaegerVersion = "2.8.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-otel-remediation-"));
  temporaryDirectories.push(directory);
  const sdkDirectory = path.join(directory, "node_modules", "@opentelemetry", "sdk-node");
  mkdirSync(sdkDirectory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name: "@openclaw/diagnostics-otel", version: "2026.7.1" }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(sdkDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "@opentelemetry/sdk-node",
        version: "0.219.0",
        dependencies: { "@opentelemetry/propagator-jaeger": jaegerVersion },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/diagnostics-otel",
        version: "2026.7.1",
        lockfileVersion: 3,
        packages: {
          "": { name: "@openclaw/diagnostics-otel", version: "2026.7.1" },
          "node_modules/@opentelemetry/sdk-node": {
            version: "0.219.0",
            dependencies: { "@opentelemetry/propagator-jaeger": jaegerVersion },
          },
          "node_modules/@opentelemetry/propagator-jaeger": {
            version: jaegerVersion,
            dependencies: { "@opentelemetry/core": jaegerVersion },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeDiscordFixture(undiciVersion = "8.5.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-discord-remediation-"));
  temporaryDirectories.push(directory);
  const dependencies = { undici: undiciVersion, ws: "8.21.0" };
  const bundledUndiciDirectory = path.join(directory, "node_modules", "undici");
  mkdirSync(bundledUndiciDirectory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/discord",
        version: "2026.7.1",
        dependencies,
        bundledDependencies: ["undici"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(bundledUndiciDirectory, "package.json"),
    `${JSON.stringify(
      { name: "undici", version: undiciVersion, engines: { node: ">=22.19.0" } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/discord",
        version: "2026.7.1",
        lockfileVersion: 3,
        packages: {
          "": { name: "@openclaw/discord", version: "2026.7.1", dependencies },
          "node_modules/undici": {
            version: undiciVersion,
            resolved: `https://registry.npmjs.org/undici/-/undici-${undiciVersion}.tgz`,
            integrity:
              "sha512-xamtWoB1EshgjpmlXd7GGm2VfdDtw1+rD8uhry8pSNW3If6S8E0m2T2+orSKeZXEn/aPJMviCpDBA65WJt8zhg==",
            engines: { node: ">=22.19.0" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeSlackProxyAddrFixture(
  sourceVersion = "2.0.7",
  replacementVersion = "2.0.8",
): { packageDirectory: string; replacementDirectory: string } {
  const packageDirectory = mkdtempSync(
    path.join(tmpdir(), "nemoclaw-openclaw-slack-proxy-addr-remediation-"),
  );
  temporaryDirectories.push(packageDirectory);
  const boltDirectory = path.join(packageDirectory, "node_modules", "@slack", "bolt");
  const expressDirectory = path.join(boltDirectory, "node_modules", "express");
  const proxyAddrDirectory = path.join(boltDirectory, "node_modules", "proxy-addr");
  mkdirSync(expressDirectory, { recursive: true });
  mkdirSync(proxyAddrDirectory, { recursive: true });
  writeJson(path.join(packageDirectory, "package.json"), {
    name: "@openclaw/slack",
    version: "2026.9.2",
    dependencies: { "@slack/bolt": "5.0.0" },
    bundledDependencies: ["@slack/bolt"],
  });
  writeJson(path.join(boltDirectory, "package.json"), {
    name: "@slack/bolt",
    version: "5.0.0",
    dependencies: { express: "^5.0.0" },
    license: "MIT",
    engines: { node: ">=20" },
  });
  writeJson(path.join(expressDirectory, "package.json"), {
    name: "express",
    version: "5.2.1",
    dependencies: { "proxy-addr": "^2.0.7" },
    license: "MIT",
    engines: { node: ">= 18" },
  });
  writeJson(path.join(proxyAddrDirectory, "package.json"), {
    name: "proxy-addr",
    version: sourceVersion,
    dependencies: { forwarded: "0.2.0", "ipaddr.js": "1.9.1" },
    license: "MIT",
    engines: { node: ">= 0.10" },
  });
  writeFileSync(path.join(proxyAddrDirectory, "index.js"), "module.exports = 'vulnerable';\n");

  const replacementDirectory = mkdtempSync(path.join(tmpdir(), "nemoclaw-proxy-addr-replacement-"));
  temporaryDirectories.push(replacementDirectory);
  writeJson(path.join(replacementDirectory, "package.json"), {
    name: "proxy-addr",
    version: replacementVersion,
    dependencies: { forwarded: "0.2.0", "ipaddr.js": "1.9.1" },
    license: "MIT",
    engines: { node: ">= 0.10" },
  });
  writeFileSync(path.join(replacementDirectory, "index.js"), "module.exports = 'patched';\n");
  return { packageDirectory, replacementDirectory };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readPackageField<T>(directory: string, field: string): T {
  let value: unknown = readJson<Record<string, unknown>>(path.join(directory, "package.json"));
  for (const part of field.split(".")) {
    value = (value as Record<string, unknown>)[part];
  }
  return value as T;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw npm remediation", () => {
  it.each(["openclaw@2026.3.11", "openclaw@2026.6.10", "openclaw@2026.7.1"])(
    "rejects retired core archive %s before starting remediation (#13594)",
    (packageSpec) => {
      const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-retired-core-"));
      temporaryDirectories.push(root);
      const workingDirectory = path.join(root, "work");
      expect(() =>
        buildRemediatedOpenClawPluginArchive({
          archivePath: path.join(root, "unused.tgz"),
          packageSpec,
          workingDirectory,
        }),
      ).toThrow(`No OpenClaw npm remediation is defined for ${packageSpec}`);
      expect(existsSync(workingDirectory)).toBe(false);
    },
  );

  it.each([
    ["package.json", "symlink", symlinkSync],
    ["package.json", "hardlink", linkSync],
    ["npm-shrinkwrap.json", "symlink", symlinkSync],
    ["npm-shrinkwrap.json", "hardlink", linkSync],
  ] as const)(
    "rejects linked %s metadata (%s) before Zod migration changes files",
    (name, _kind, link) => {
      const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-zod-metadata-link-"));
      temporaryDirectories.push(root);
      const plugin = path.join(root, "plugin");
      mkdirSync(plugin);
      const original = JSON.stringify({
        name: "@openclaw/slack",
        version: "2026.9.5",
        dependencies: { zod: "4.5.4" },
      });
      const external = path.join(root, "external.json");
      writeFileSync(external, original);
      writeFileSync(path.join(plugin, "package.json"), original);
      rmSync(path.join(plugin, name), { force: true });
      link(external, path.join(plugin, name));
      expect(() =>
        patchOpenClawBundledZodPackageGraph(
          plugin,
          path.join(root, "must-not-read"),
          "@openclaw/slack@2026.9.5",
        ),
      ).toThrow("single regular file");
      expect(readFileSync(external, "utf8")).toBe(original);
      expect(existsSync(path.join(plugin, "node_modules"))).toBe(false);
    },
  );

  it("bounds a non-returning remediation command and keeps its diagnostic generic", () => {
    const startedAt = Date.now();
    let failure: unknown;
    try {
      runOpenClawNpmRemediationCommand(
        process.execPath,
        ["-e", 'process.stdout.write("private command output"); setInterval(() => {}, 1000);'],
        undefined,
        process.env,
        "fetch replacement",
        64 * 1024 * 1024,
        750,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OpenClawNpmRemediationCommandError);
    expect(failure).toMatchObject({
      couldNotStart: false,
      operation: "fetch replacement",
      timedOut: true,
      timeoutMs: 750,
      message: "Remediation command timed out after 750 ms.",
    });
    expect(fatalOpenClawNpmRemediationDiagnostic(failure)).toBe(
      "OpenClaw npm remediation operation 'fetch replacement' timed out after 750 ms.",
    );
    expect(String(failure)).not.toContain("private command output");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.each([
    {
      failure: "malformed",
      prepare: (archivePath: string) => writeFileSync(archivePath, "not a tar archive"),
      env: {},
      message: "OpenClaw npm remediation operation 'list archive' failed.",
    },
    {
      failure: "missing",
      prepare: (_archivePath: string) => undefined,
      env: {},
      message: "OpenClaw npm remediation operation 'list archive' failed.",
    },
    {
      failure: "unavailable tar",
      prepare: (archivePath: string) => writeFileSync(archivePath, "not a tar archive"),
      env: { PATH: "" },
      message:
        "OpenClaw npm remediation operation 'list archive' could not start a required command.",
    },
  ])("withholds archive paths and child diagnostics when $failure", ({ prepare, env, message }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-private-archive-marker-"));
    temporaryDirectories.push(directory);
    const archivePath = path.join(directory, "private-archive-marker.tgz");
    prepare(archivePath);
    const request = {
      archivePath,
      packageSpec: "@openclaw/slack@2026.9.2",
      workingDirectory: path.join(directory, "work"),
      env,
    };

    let failure: unknown;
    try {
      buildRemediatedOpenClawPluginArchive(request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenClawNpmRemediationCommandError);
    expect(fatalOpenClawNpmRemediationDiagnostic(failure)).toBe(message);
    expect(String(failure)).not.toContain("private-archive-marker");
  });

  it("rejects unsafe archive members without echoing their names or archive path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-private-archive-marker-"));
    temporaryDirectories.push(directory);
    const memberName = "private-member-marker";
    writeFileSync(path.join(directory, memberName), "untrusted member");
    const archivePath = path.join(directory, "private-archive-marker.tgz");
    const packed = spawnSync("tar", ["-czf", archivePath, "-C", directory, memberName], {
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const request = {
      archivePath,
      packageSpec: "@openclaw/slack@2026.9.2",
      workingDirectory: path.join(directory, "work"),
    };

    expect(() => buildRemediatedOpenClawPluginArchive(request)).toThrow(
      "npm archive has an unsafe member",
    );
    expect(() => buildRemediatedOpenClawPluginArchive(request)).not.toThrow(
      "private-member-marker",
    );
    expect(() => buildRemediatedOpenClawPluginArchive(request)).not.toThrow(
      "private-archive-marker",
    );
  });

  it.each(["@slack/bolt", "@slack/bolt/node_modules/express"])(
    "rejects changed Slack %s contracts before replacing proxy bytes",
    (dependency) => {
      const { packageDirectory, replacementDirectory } = writeSlackProxyAddrFixture();
      const metadataPath = path.join(packageDirectory, "node_modules", dependency, "package.json");
      const metadata = readJson<Record<string, unknown>>(metadataPath);
      writeJson(metadataPath, { ...metadata, license: "unexpected" });
      expect(() =>
        patchOpenClawSlackProxyAddrPackageGraph(packageDirectory, replacementDirectory),
      ).toThrow("contract changed after review");
      expect(
        readFileSync(
          path.join(packageDirectory, "node_modules/@slack/bolt/node_modules/proxy-addr/index.js"),
          "utf8",
        ),
      ).toContain("vulnerable");
    },
  );
  it("replaces bundled Slack proxy-addr bytes and rejects an unexpected source version", () => {
    const { packageDirectory: directory, replacementDirectory: replacement } =
      writeSlackProxyAddrFixture();
    const target = path.join(directory, "node_modules/@slack/bolt/node_modules/proxy-addr");
    patchOpenClawSlackProxyAddrPackageGraph(directory, replacement);
    expect(readFileSync(path.join(target, "index.js"), "utf8")).toBe(
      readFileSync(path.join(replacement, "index.js"), "utf8"),
    );
    expect(readJson(path.join(target, "package.json"))).toMatchObject({ version: "2.0.8" });
    expect(() => patchOpenClawSlackProxyAddrPackageGraph(directory, replacement)).not.toThrow();
    writeFileSync(path.join(target, "index.js"), "changed after remediation");
    expect(() => patchOpenClawSlackProxyAddrPackageGraph(directory, replacement)).toThrow(
      "changed after remediation",
    );
  });
  it("hashes package entries through opened file descriptors", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-tree-integrity-"));
    temporaryDirectories.push(directory);
    mkdirSync(path.join(directory, "nested"));
    writeFileSync(path.join(directory, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(path.join(directory, "nested", "content.txt"), "reviewed content\n");

    const first = hashPackageTree(directory);
    const second = hashPackageTree(directory);

    expect(first).toMatch(/^sha512-/);
    expect(second).toBe(first);
  });

  it("rejects symbolic links in a remediated package tree", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-tree-symlink-"));
    temporaryDirectories.push(directory);
    const outside = path.join(directory, "..", `${path.basename(directory)}-outside`);
    writeFileSync(outside, "must not be hashed\n");
    temporaryDirectories.push(outside);
    symlinkSync(outside, path.join(directory, "linked-content"));

    expect(() => hashPackageTree(directory)).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects FIFOs without blocking in a remediated package tree",
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-tree-fifo-"));
      temporaryDirectories.push(directory);
      const fifo = path.join(directory, "blocked-reader");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 5000 });
      expect(created.status, created.stderr).toBe(0);

      const startedAt = Date.now();
      expect(() => hashPackageTree(directory)).toThrow(/unsupported entry/);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    },
  );

  // source-shape-contract: security -- Exact package and shrinkwrap identities prove the guarded Axios remediation installs only the reviewed replacement graph
  it("replaces the reviewed bundled Axios graph with the patched graph", () => {
    const directory = writeFixture();

    patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.7.1");

    expect(readPackageField<string>(directory, "dependencies.axios")).toBe("1.18.0");
    expect(readPackageField<string[]>(directory, "bundledDependencies")).toEqual([
      "@slack/bolt",
      "axios",
    ]);

    const shrinkwrap = readJson<{
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(shrinkwrap.packages["node_modules/axios"]).toMatchObject({
      version: "1.18.0",
      resolved: "https://registry.npmjs.org/axios/-/axios-1.18.0.tgz",
      integrity:
        "sha512-E32NzpYKp++W7XRe52rHiXV2ehxmh3wbdgO7MHeFM+vqxLBYHzt0ElkiImtOBxtOmyp0yoC8C6uESVV84Y2/hw==",
      dependencies: { "https-proxy-agent": "^5.0.1" },
    });
    expect(shrinkwrap.packages["node_modules/axios/node_modules/https-proxy-agent"]).toMatchObject({
      version: "5.0.1",
      resolved: "https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz",
      integrity:
        "sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==",
      dependencies: { "agent-base": "6" },
    });
    expect(
      shrinkwrap.packages[
        "node_modules/axios/node_modules/https-proxy-agent/node_modules/agent-base"
      ],
    ).toMatchObject({
      version: "6.0.2",
      resolved: "https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz",
      integrity:
        "sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==",
      dependencies: { debug: "4" },
    });
  });

  it("rejects an upstream Axios graph that changed after review", () => {
    const directory = writeFixture("1.17.0");

    expect(() => patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.7.1")).toThrow(
      "must resolve node_modules/axios to 1.16.0 before remediation",
    );
  });

  // source-shape-contract: security -- Exact Slack, Bolt, Express, and proxy-addr identities constrain the archive rewrite to the reviewed vulnerable package
  it("replaces only the reviewed Slack bundled proxy-addr package", () => {
    const { packageDirectory, replacementDirectory } = writeSlackProxyAddrFixture();

    patchOpenClawSlackProxyAddrPackageGraph(packageDirectory, replacementDirectory);

    const proxyAddrDirectory = path.join(
      packageDirectory,
      "node_modules",
      "@slack",
      "bolt",
      "node_modules",
      "proxy-addr",
    );
    expect(readPackageField<string>(proxyAddrDirectory, "version")).toBe("2.0.8");
    expect(readFileSync(path.join(proxyAddrDirectory, "index.js"), "utf8")).toBe(
      "module.exports = 'patched';\n",
    );
    expect(
      readPackageField<string>(
        path.join(packageDirectory, "node_modules", "@slack", "bolt", "node_modules", "express"),
        "dependencies.proxy-addr",
      ),
    ).toBe("^2.0.7");
  });

  it("rejects a Slack bundled proxy-addr identity that changed after review", () => {
    const { packageDirectory, replacementDirectory } = writeSlackProxyAddrFixture("2.0.6");

    expect(() =>
      patchOpenClawSlackProxyAddrPackageGraph(packageDirectory, replacementDirectory),
    ).toThrow("must be proxy-addr@2.0.7");
  });

  it("rejects a proxy-addr replacement identity that changed after review", () => {
    const { packageDirectory, replacementDirectory } = writeSlackProxyAddrFixture("2.0.7", "2.0.9");

    expect(() =>
      patchOpenClawSlackProxyAddrPackageGraph(packageDirectory, replacementDirectory),
    ).toThrow("must be proxy-addr@2.0.8");
  });

  // source-shape-contract: security -- Exact package and shrinkwrap identities prove the guarded Jaeger remediation installs only the reviewed aligned graph
  it("replaces the reviewed Jaeger propagator with its aligned patched core", () => {
    const directory = writeDiagnosticsFixture();

    patchOpenClawDiagnosticsOtelPackageGraph(directory);

    expect(
      readPackageField<string>(
        path.join(directory, "node_modules", "@opentelemetry", "sdk-node"),
        "dependencies.@opentelemetry/propagator-jaeger",
      ),
    ).toBe("2.9.0");
    const shrinkwrap = readJson<{
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(shrinkwrap.packages["node_modules/@opentelemetry/propagator-jaeger"]).toMatchObject({
      version: "2.9.0",
      dependencies: { "@opentelemetry/core": "2.9.0" },
    });
    expect(
      shrinkwrap.packages[
        "node_modules/@opentelemetry/propagator-jaeger/node_modules/@opentelemetry/core"
      ],
    ).toMatchObject({
      version: "2.9.0",
      dependencies: { "@opentelemetry/semantic-conventions": "^1.29.0" },
    });
  });

  it("rejects a diagnostics Jaeger graph that changed after review", () => {
    const directory = writeDiagnosticsFixture("2.8.1");

    expect(() => patchOpenClawDiagnosticsOtelPackageGraph(directory)).toThrow(
      "with Jaeger propagator 2.8.0 before remediation",
    );
  });

  // source-shape-contract: security -- Exact package and shrinkwrap identities prove the guarded Discord remediation installs only the reviewed undici graph
  it("replaces the reviewed OpenClaw Discord undici dependency", () => {
    const directory = writeDiscordFixture();

    patchOpenClawDiscordPackageGraph(directory);

    expect(readPackageField<string>(directory, "dependencies.undici")).toBe("8.12.2");
    const shrinkwrap = readJson<{
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>;
          integrity?: string;
          resolved?: string;
          version?: string;
        }
      >;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(shrinkwrap.packages[""].dependencies).toMatchObject({ undici: "8.12.2" });
    expect(shrinkwrap.packages["node_modules/undici"]).toMatchObject({
      version: "8.12.2",
      resolved: "https://registry.npmjs.org/undici/-/undici-8.12.2.tgz",
      integrity:
        "sha512-XtuDWVdqTLr3NAxm2ly9/hU6kUsJOgGh1RASzMBbsw6aWCOaQzHdW+QQDfdERjfJ2V5vL5pRPa4RetO9UfivDg==",
    });
  });

  it("rejects an OpenClaw Discord undici graph that changed after review", () => {
    const directory = writeDiscordFixture("8.4.0");

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow(
      "undici dependency changed after review",
    );
  });

  it.each([
    ["resolved", "https://registry.npmjs.org/undici/-/undici-8.4.0.tgz"],
    ["integrity", "sha512-deliberate-mismatch"],
    ["engines", { node: ">=22.20.0" }],
  ])("rejects an OpenClaw Discord undici shrinkwrap with changed %s", (field, value) => {
    const directory = writeDiscordFixture();
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson<{
      packages: Record<string, Record<string, unknown>>;
    }>(shrinkwrapPath);
    shrinkwrap.packages["node_modules/undici"][field] = value;
    writeJson(shrinkwrapPath, shrinkwrap);

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow(
      "undici layout changed after review",
    );
  });

  it("rejects a changed OpenClaw Discord bundled undici identity", () => {
    const directory = writeDiscordFixture();
    writeJson(path.join(directory, "node_modules", "undici", "package.json"), {
      name: "undici",
      version: "8.4.0",
      engines: { node: ">=22.19.0" },
    });

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow("must be undici@8.5.0");
  });

  it("rejects a changed OpenClaw Discord bundled undici layout", () => {
    const directory = writeDiscordFixture();
    writeJson(path.join(directory, "node_modules", "undici", "package.json"), {
      name: "undici",
      version: "8.5.0",
      engines: { node: ">=22.20.0" },
    });

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow(
      "bundled undici layout changed after review",
    );
  });
});

describe("Discord embedded Zod remediation trust boundary", () => {
  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-discord-zod-"));
    temporaryDirectories.push(root);
    const sdk = path.join(root, "sdk");
    const replacement = path.join(root, "replacement");
    mkdirSync(sdk);
    mkdirSync(replacement);
    writeFileSync(
      path.join(sdk, "package.json"),
      JSON.stringify({
        name: "@discord/embedded-app-sdk",
        version: "2.5.0",
        dependencies: { zod: "^3.9.8" },
      }),
    );
    writeFileSync(
      path.join(replacement, "package.json"),
      JSON.stringify({ name: "zod", version: "4.6.6" }),
    );
    return { root, sdk, replacement };
  }

  it("rejects unreviewed replacement bytes even when the package name and version match", () => {
    const { sdk, replacement } = fixture();
    const before = hashPackageTree(sdk);
    expect(() => patchDiscordEmbeddedZodPackage(sdk, replacement)).toThrow(
      "replacement Zod tree integrity mismatch",
    );
    expect(hashPackageTree(sdk)).toBe(before);
  });

  it("rejects a package directory symlink before changing its target", () => {
    const { root, sdk, replacement } = fixture();
    const link = path.join(root, "sdk-link");
    symlinkSync(sdk, link);
    const before = hashPackageTree(sdk);
    expect(() => patchDiscordEmbeddedZodPackage(link, replacement)).toThrow(
      "requires real package directories",
    );
    expect(hashPackageTree(sdk)).toBe(before);
  });

  it("rejects linked source members before reading outside the package", () => {
    const { root, sdk, replacement } = fixture();
    const outside = path.join(root, "outside");
    writeFileSync(outside, "preserved");
    symlinkSync(outside, path.join(sdk, "linked-member"));
    expect(() => patchDiscordEmbeddedZodPackage(sdk, replacement)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("preserved");
    expect(
      readJson<{ dependencies: { zod: string } }>(path.join(sdk, "package.json")),
    ).toMatchObject({ dependencies: { zod: "^3.9.8" } });
  });
});

describe("OpenClaw 10.5 bundled dependency repair", () => {
  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-plugin-security-"));
    temporaryDirectories.push(root);
    const plugin = path.join(root, "plugin");
    const zod = path.join(plugin, "node_modules/zod");
    mkdirSync(zod, { recursive: true });
    writeFileSync(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "@openclaw/googlechat",
        version: "2026.10.5",
        dependencies: { zod: "4.6.5" },
      }),
    );
    writeFileSync(
      path.join(zod, "package.json"),
      JSON.stringify({ name: "zod", version: "4.6.5" }),
    );
    return { root, plugin, zod };
  }

  it("rejects changed bundled bytes before fetching or replacing packages", () => {
    const { root, plugin } = fixture();
    const before = hashPackageTree(plugin);
    expect(() => patchOpenClaw105PluginDependencies(plugin, root)).toThrow(
      "source integrity mismatch",
    );
    expect(hashPackageTree(plugin)).toBe(before);
  });

  it("rejects a linked dependency parent without modifying its target", () => {
    const { root, plugin } = fixture();
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "sentinel"), "preserved");
    rmSync(path.join(plugin, "node_modules"), { recursive: true });
    symlinkSync(outside, path.join(plugin, "node_modules"));
    expect(() => patchOpenClaw105PluginDependencies(plugin, root)).toThrow(
      "requires real package directories",
    );
    expect(readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("preserved");
  });

  it("refuses an official plugin installed outside its named managed project", () => {
    const { root, plugin } = fixture();
    const before = hashPackageTree(plugin);
    expect(() =>
      remediateInstalledOfficialOpenClawPlugin({
        archivePath: path.join(root, "unused.tgz"),
        packageSpec: "@openclaw/googlechat@2026.10.5",
        packageDirectory: plugin,
        trustedStateRoot: root,
        workingDirectory: root,
      }),
    ).toThrow("requires a valid managed npm package directory");
    expect(hashPackageTree(plugin)).toBe(before);
  });
});

describe("Teams native dependency remediation", () => {
  function teamsFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-teams-msal-"));
    temporaryDirectories.push(root);
    const project = `openclaw-msteams-${createHash("sha256").update("@openclaw/msteams").digest("hex").slice(0, 10)}`;
    const modules = path.join(root, "npm/projects", project, "node_modules");
    const packageDirectory = path.join(modules, "@openclaw/msteams");
    const packages = [
      [
        "@openclaw/msteams",
        { name: "@openclaw/msteams", version: "2026.9.2", dependencies: { zod: "4.4.3" } },
      ],
      [
        "@azure/identity",
        {
          name: "@azure/identity",
          version: "4.13.2",
          dependencies: { "@azure/msal-node": "^5.1.5" },
        },
      ],
      [
        "@microsoft/teams.apps",
        {
          name: "@microsoft/teams.apps",
          version: "2.0.15",
          dependencies: { "@azure/msal-node": "^5.2.2" },
        },
      ],
      [
        "@azure/msal-node",
        {
          name: "@azure/msal-node",
          version: "5.6.0",
          main: "index.cjs",
          dependencies: { "@azure/msal-common": "16.13.0", jsonwebtoken: "^9.0.0" },
        },
      ],
      ["@azure/msal-common", { name: "@azure/msal-common", version: "16.14.0" }],
      ["zod", { name: "zod", version: "4.4.3", main: "index.cjs" }],
    ] as const;
    packages.forEach(([name, metadata]) => {
      mkdirSync(path.join(modules, name), { recursive: true });
      writeJson(path.join(modules, name, "package.json"), metadata);
    });
    const archives = path.join(root, "archives");
    mkdirSync(archives);
    ["msal-node-7.1.0", "msal-common-16.14.2", "zod-4.6.6"].forEach((name) =>
      cpSync(
        path.resolve(import.meta.dirname, "../../fixtures/npm", name, `${name}.tgz`),
        path.join(archives, `${name}.tgz`),
      ),
    );
    const target = path.join(modules, "@azure/msal-node");
    writeFileSync(path.join(target, "index.cjs"), "vulnerable-original");
    writeFileSync(path.join(modules, "zod/index.cjs"), "vulnerable-zod");
    return {
      root,
      modules,
      target,
      request: {
        archivePath: path.join(root, "unused.tgz"),
        packageSpec: "@openclaw/msteams@2026.9.2",
        workingDirectory: root,
        trustedStateRoot: root,
        packageDirectory,
        env: { NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: archives },
      },
    };
  }

  it("replaces shared MSAL and its Common together while preserving the browser Common", () => {
    const fixture = teamsFixture();
    remediateInstalledOfficialOpenClawPlugin(fixture.request);
    expect(readJson(path.join(fixture.target, "package.json"))).toMatchObject({ version: "7.1.0" });
    expect(
      readJson(path.join(fixture.target, "node_modules/@azure/msal-common/package.json")),
    ).toMatchObject({ version: "16.14.2" });
    expect(readJson(path.join(fixture.modules, "@azure/msal-common/package.json"))).toMatchObject({
      version: "16.14.0",
    });
    expect(existsSync(path.join(fixture.target, "index.cjs"))).toBe(false);
    const zod = createRequire(path.join(fixture.request.packageDirectory, "package.json"))("zod");
    expect(
      createRequire(path.join(fixture.request.packageDirectory, "package.json"))("zod/package.json")
        .version,
    ).toBe("4.6.6");
    let visited = 0;
    const bounded = zod
      .array(
        zod.string().superRefine(() => {
          visited += 1;
        }),
      )
      .max(1);
    expect(bounded.safeParse(["a", "b"]).success).toBe(false);
    expect(visited).toBe(0);
    expect(bounded.parse(["a"])).toEqual(["a"]);
  });

  it.each([
    "dependency link",
    "nested MSAL",
    "unreviewed SDK",
    "wrong project",
    "nested Zod",
    "Zod link",
    "unreviewed Zod",
  ])("denies %s before replacing MSAL", (scenario) => {
    const fixture = teamsFixture();
    const identity = path.join(fixture.modules, "@azure/identity");
    const mutations: Record<string, () => void> = {
      "dependency link": () => {
        const original = path.join(fixture.root, "original-identity");
        cpSync(identity, original, { recursive: true });
        rmSync(identity, { recursive: true });
        symlinkSync(original, identity);
      },
      "nested MSAL": () => {
        const nested = path.join(identity, "node_modules/@azure/msal-node");
        mkdirSync(nested, { recursive: true });
        writeJson(path.join(nested, "package.json"), {
          name: "@azure/msal-node",
          version: "5.6.0",
          main: "index.cjs",
        });
        writeFileSync(path.join(nested, "index.cjs"), "nested-vulnerable");
      },
      "unreviewed SDK": () =>
        writeJson(path.join(identity, "package.json"), {
          name: "@azure/identity",
          version: "5.0.0",
        }),
      "nested Zod": () => {
        const nested = path.join(fixture.request.packageDirectory, "node_modules/zod");
        mkdirSync(nested, { recursive: true });
        writeJson(path.join(nested, "package.json"), {
          name: "zod",
          version: "4.4.3",
          main: "index.cjs",
        });
        writeFileSync(path.join(nested, "index.cjs"), "nested-vulnerable");
      },
      "Zod link": () => {
        const target = path.join(fixture.modules, "zod");
        const original = path.join(fixture.root, "original-zod");
        cpSync(target, original, { recursive: true });
        rmSync(target, { recursive: true });
        symlinkSync(original, target);
      },
      "unreviewed Zod": () =>
        writeJson(path.join(fixture.modules, "zod/package.json"), {
          name: "zod",
          version: "5.0.0",
        }),
      "wrong project": () => {
        fixture.request.trustedStateRoot = fixture.modules;
      },
    };
    mutations[scenario]();
    expect(() => remediateInstalledOfficialOpenClawPlugin(fixture.request)).toThrow(
      "reviewed dependency graph",
    );
    expect(readFileSync(path.join(fixture.target, "index.cjs"), "utf8")).toBe(
      "vulnerable-original",
    );
  });
});
