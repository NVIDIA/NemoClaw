// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createOldBaseBuildContext,
  directDockerfileBaseCopySources,
  dockerignoreSecretPatterns,
} from "../live/rebuild-openclaw-old-base-context.ts";

const copiedContexts: string[] = [];
const testFiles: string[] = [];

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
    expect(stagedSources.every((source) => fs.existsSync(source))).toBe(true);
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
        "COPY --from=build /tmp/ignored /tmp/ignored",
      ].join("\n"),
      "utf8",
    );

    expect(directDockerfileBaseCopySources(dockerfilePath)).toEqual([
      "scripts/lib/sandbox-rlimits.sh",
      "nemoclaw-blueprint/blueprint.yaml",
    ]);
  });

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
    fs.writeFileSync(absoluteDockerfilePath, "COPY /etc/passwd /tmp/passwd\n", "utf8");

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

    for (const pattern of securityPatterns) {
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
    }
  });
});
