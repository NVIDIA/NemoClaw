// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createOldBaseBuildContext,
  directDockerfileBaseCopySources,
  dockerignoreSecretPatterns,
} from "../live/rebuild-openclaw-old-base-context.ts";
import { createLegacyOpenClawOpenShellWrapper } from "../live/rebuild-openclaw-old-openshell-wrapper.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const copiedContexts: string[] = [];
const testFiles: string[] = [];
const MULTILINE_COPY_SOURCES = [
  "agents/openclaw/openclaw-runtime/package-lock.json",
  "agents/openclaw/mcporter-runtime/package-lock.json",
  "scripts/lib/reviewed-npm-audit.mts",
  "scripts/lib/openclaw-npm-remediation.mts",
];

describe("rebuild-openclaw old-base build context", () => {
  afterEach(() => {
    for (const contextPath of copiedContexts.splice(0)) {
      fs.rmSync(contextPath, { recursive: true, force: true });
    }
    for (const filePath of testFiles.splice(0)) {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  });

  it("stages every direct Dockerfile.base COPY dependency", () => {
    const buildContext = createOldBaseBuildContext();
    copiedContexts.push(buildContext);

    const stagedSources = directDockerfileBaseCopySources().map((source) =>
      path.join(buildContext, ...source.split("/")),
    );

    expect(stagedSources).not.toHaveLength(0);
    expect(directDockerfileBaseCopySources()).toEqual(
      expect.arrayContaining(MULTILINE_COPY_SOURCES),
    );
    expect(stagedSources.every((source) => fs.existsSync(source))).toBe(true);
  });

  it.each([{ fromArgs: ["--from", "DOCKERFILE"] }, { fromArgs: ["--from=DOCKERFILE"] }])(
    "patches the generated sandbox create context for $fromArgs",
    ({ fromArgs }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-wrapper-"));
      testFiles.push(root);
      const realOpenShell = path.join(root, "real-openshell");
      const argvLog = path.join(root, "real-openshell-argv.log");
      const buildContext = path.join(root, "context");
      const dockerfile = path.join(buildContext, "Dockerfile");
      const blueprint = path.join(buildContext, "nemoclaw-blueprint", "blueprint.yaml");
      fs.mkdirSync(path.dirname(blueprint), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, "Dockerfile"), dockerfile);
      fs.copyFileSync(path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml"), blueprint);
      fs.chmodSync(dockerfile, 0o444);
      fs.chmodSync(blueprint, 0o444);
      fs.writeFileSync(
        realOpenShell,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >"$FAKE_OPENSHELL_ARGV_LOG"\n`,
        { mode: 0o755 },
      );
      const wrapper = createLegacyOpenClawOpenShellWrapper({
        root: path.join(root, "wrapper"),
        realOpenShell,
        baseImage: "nemoclaw-old-base:test",
        openClawVersion: "2026.3.11",
      });

      const resolvedFromArgs = fromArgs.map((argument) =>
        argument.replace("DOCKERFILE", dockerfile),
      );
      execFileSync(
        wrapper.executable,
        ["sandbox", "create", "--name", "fixture", ...resolvedFromArgs, "--", "nemoclaw-start"],
        { env: { ...process.env, FAKE_OPENSHELL_ARGV_LOG: argvLog } },
      );

      expect(fs.readFileSync(argvLog, "utf8").trim().split("\n")).toEqual([
        "sandbox",
        "create",
        "--name",
        "fixture",
        ...resolvedFromArgs,
        "--",
        "nemoclaw-start",
      ]);
      const patchedDockerfile = fs.readFileSync(dockerfile, "utf8");
      expect(patchedDockerfile.match(/^ARG BASE_IMAGE=.*$/gm)).toEqual([
        "ARG BASE_IMAGE=nemoclaw-old-base:test",
      ]);
      expect(patchedDockerfile.match(/^ARG OPENCLAW_VERSION=.*$/gm)).toEqual([
        "ARG OPENCLAW_VERSION=2026.3.11",
      ]);
      expect(patchedDockerfile.match(/^ARG NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=.*$/gm)).toEqual([
        "ARG NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1",
      ]);
      expect(fs.readFileSync(blueprint, "utf8")).toMatch(
        /^\s*min_openclaw_version: "2026\.3\.11"$/m,
      );
      expect(fs.readFileSync(wrapper.logFile, "utf8")).toContain(
        "patch sandbox create NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1",
      );
    },
  );

  it("passes OpenShell preflight commands through without patching", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-wrapper-"));
    testFiles.push(root);
    const realOpenShell = path.join(root, "real-openshell");
    fs.writeFileSync(realOpenShell, "#!/usr/bin/env bash\nprintf 'openshell 0.0.106\\n'\n", {
      mode: 0o755,
    });
    const wrapper = createLegacyOpenClawOpenShellWrapper({
      root: path.join(root, "wrapper"),
      realOpenShell,
      baseImage: "nemoclaw-old-base:test",
      openClawVersion: "2026.3.11",
    });

    const output = execFileSync(wrapper.executable, ["--version"], { encoding: "utf8" });

    expect(output).toBe("openshell 0.0.106\n");
    expect(fs.existsSync(wrapper.logFile)).toBe(false);
  });

  it("parses direct Dockerfile.base COPY syntax without silently ignoring variants", () => {
    const dockerfilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
      "Dockerfile.base",
    );
    testFiles.push(path.dirname(dockerfilePath));
    fs.writeFileSync(
      dockerfilePath,
      [
        "FROM base AS build",
        "copy scripts/lib/sandbox-rlimits.sh /tmp/lowercase",
        "COPY\tnemoclaw-blueprint/blueprint.yaml /tmp/tabbed",
        "COPY --chown=sandbox:sandbox \\",
        "  agents/openclaw/openclaw-runtime/package.json \\",
        "  agents/openclaw/openclaw-runtime/package-lock.json \\",
        "  /tmp/openclaw/",
        "COPY scripts/lib/reviewed-npm-archive.mts scripts/lib/reviewed-npm-audit.mts /tmp/lib/",
        "COPY --from=build \\",
        "  /tmp/ignored-one \\",
        "  /tmp/ignored-two \\",
        "  /tmp/ignored/",
      ].join("\r\n"),
      "utf8",
    );

    expect(directDockerfileBaseCopySources(dockerfilePath)).toEqual([
      "scripts/lib/sandbox-rlimits.sh",
      "nemoclaw-blueprint/blueprint.yaml",
      "agents/openclaw/openclaw-runtime/package.json",
      "agents/openclaw/openclaw-runtime/package-lock.json",
      "scripts/lib/reviewed-npm-archive.mts",
      "scripts/lib/reviewed-npm-audit.mts",
    ]);
  });

  it("returns every source from a multiline direct COPY instruction", () => {
    const dockerfilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
      "Dockerfile.base",
    );
    testFiles.push(path.dirname(dockerfilePath));
    fs.writeFileSync(
      dockerfilePath,
      [
        "COPY agents/openclaw/openclaw-runtime/package.json \\",
        "    agents/openclaw/openclaw-runtime/package-lock.json \\",
        "    /usr/local/lib/nemoclaw/openclaw-runtime/",
      ].join("\n"),
      "utf8",
    );

    expect(directDockerfileBaseCopySources(dockerfilePath)).toEqual([
      "agents/openclaw/openclaw-runtime/package.json",
      "agents/openclaw/openclaw-runtime/package-lock.json",
    ]);
  });

  it.each([
    {
      dockerfile: 'COPY ["scripts/lib/sandbox-rlimits.sh", "/tmp/"]',
      expectedError: "Unsupported direct Dockerfile.base COPY form at line 1",
    },
    {
      dockerfile: "COPY <<EOF /tmp/generated",
      expectedError: "Unsupported Dockerfile.base heredoc instruction at line 1",
    },
    {
      dockerfile: "COPY scripts/lib/sandbox-rlimits.sh",
      expectedError: "Unsupported direct Dockerfile.base COPY form at line 1",
    },
    {
      dockerfile: "COPY --from build /tmp/source /tmp/destination",
      expectedError: "Unsupported direct Dockerfile.base COPY form at line 1",
    },
    {
      dockerfile: "COPY --exclude=*.md scripts/lib/sandbox-rlimits.sh /tmp/",
      expectedError: "Unsupported direct Dockerfile.base COPY form at line 1",
    },
    {
      dockerfile: "COPY scripts/lib/sandbox-rlimits.sh --chmod=755 /tmp/",
      expectedError: "Unsupported direct Dockerfile.base COPY form at line 1",
    },
    {
      dockerfile: "COPY scripts/lib/sandbox-rlimits.sh \\",
      expectedError: "Dangling Dockerfile.base continuation at line 1",
    },
    {
      dockerfile: [
        "RUN <<EOF",
        "COPY scripts/lib/sandbox-rlimits.sh /tmp/not-an-instruction",
        "EOF",
      ].join("\n"),
      expectedError: "Unsupported Dockerfile.base heredoc instruction at line 1",
    },
    {
      dockerfile: "# escape=`\nFROM base",
      expectedError: "Unsupported Dockerfile.base escape directive at line 1",
    },
    {
      dockerfile: "COPY scripts/$*?[]\"' /tmp/unsafe",
      expectedError: "Unsupported direct Dockerfile.base COPY source",
    },
  ])(
    "rejects malformed direct Dockerfile.base COPY forms instead of omitting sources [case %#]",
    ({ dockerfile, expectedError }) => {
      const dockerfilePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
        "Dockerfile.base",
      );
      testFiles.push(path.dirname(dockerfilePath));
      fs.writeFileSync(dockerfilePath, dockerfile, "utf8");

      expect(() => directDockerfileBaseCopySources(dockerfilePath), dockerfile).toThrow(
        expectedError,
      );
    },
  );

  it("rejects out-of-context direct Dockerfile.base COPY sources before staging", () => {
    const parentRelativeDockerfilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
      "Dockerfile.base",
    );
    const absoluteDockerfilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
      "Dockerfile.base",
    );
    testFiles.push(
      path.dirname(parentRelativeDockerfilePath),
      path.dirname(absoluteDockerfilePath),
    );
    fs.writeFileSync(parentRelativeDockerfilePath, "COPY ../outside /tmp/outside\n", "utf8");
    fs.writeFileSync(
      absoluteDockerfilePath,
      ["COPY scripts/lib/sandbox-rlimits.sh \\", "  /etc/passwd \\", "  /tmp/passwd"].join("\n"),
      "utf8",
    );

    expect(() => directDockerfileBaseCopySources(parentRelativeDockerfilePath)).toThrow(
      "Unsupported direct Dockerfile.base COPY source",
    );
    expect(() => directDockerfileBaseCopySources(absoluteDockerfilePath)).toThrow(
      "Unsupported direct Dockerfile.base COPY source",
    );
  });

  it("rejects every current .dockerignore secret COPY pattern before staging", () => {
    const representativeSourceByPattern = new Map([
      [".env", ".env"],
      [".env.*", ".env.prod"],
      [".envrc", ".envrc"],
      [".npmrc", ".npmrc"],
      [".netrc", ".netrc"],
      [".pypirc", ".pypirc"],
      [".direnv/", ".direnv/config"],
      [".ssh/", ".ssh/id_rsa.pub"],
      ["secrets/", "secrets/token.json"],
      [".credentials", ".credentials"],
      ["*.key", "private.key"],
      ["*.pem", "private.pem"],
      ["*.pfx", "private.pfx"],
      ["*.p12", "private.p12"],
      ["*.jks", "private.jks"],
      ["*.keystore", "private.keystore"],
      ["*.tfvars", "terraform.tfvars"],
      ["*_ecdsa", "id_ecdsa"],
      ["*_ed25519", "id_ed25519"],
      ["*_rsa", "id_rsa"],
      ["credentials.json", "credentials.json"],
      ["key.json", "key.json"],
      ["secrets.json", "secrets.json"],
      ["secrets.yaml", "secrets.yaml"],
      ["service-account*.json", "service-account-prod.json"],
      ["token.json", "token.json"],
    ]);

    const securityPatterns = dockerignoreSecretPatterns();
    expect(securityPatterns).not.toHaveLength(0);
    expect(securityPatterns).toEqual([...representativeSourceByPattern.keys()]);

    securityPatterns.forEach((pattern) => {
      const dockerfilePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
        "Dockerfile.base",
      );
      testFiles.push(path.dirname(dockerfilePath));
      const source = representativeSourceByPattern.get(pattern);
      expect(
        source,
        `missing representative source for .dockerignore pattern ${pattern}`,
      ).toBeDefined();
      fs.writeFileSync(dockerfilePath, `COPY ${source} /tmp/secret\n`, "utf8");

      expect(
        () => directDockerfileBaseCopySources(dockerfilePath),
        `.dockerignore pattern ${pattern} should reject representative source ${source}`,
      ).toThrow("Unsupported .dockerignore-secret Dockerfile.base COPY source");
    });
  });
});
