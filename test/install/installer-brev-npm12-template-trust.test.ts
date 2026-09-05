// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const PARSER = path.join(REPO_ROOT, "scripts/checks/extract-installer-pins.mts");
const NPM_BOOTSTRAP = path.join(
  REPO_ROOT,
  ".github/actions/setup-reviewed-npm/verify-and-install-npm.sh",
);
const BREV_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/brev-launchable-ci-cpu.sh"),
  "utf8",
);
const REVIEWED_SOURCE_SHA256 = "aa6e42c034bf36a1bd28ae542159af8cb140bcb471008627609fb78d82ec9b32";
const REVIEWED_TEMPLATE_SHA256 = "773f3728a3b6404d909cbf395abee2a3b95872d6b93ec90b7814adbacc683470";
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function replaceUniqueSource(
  source: string,
  current: string,
  replacement: string,
  label: string,
): string {
  const start = source.indexOf(current);
  assert.notEqual(start, -1, `${label} source must exist`);
  assert.equal(
    source.indexOf(current, start + current.length),
    -1,
    `${label} source must be unique`,
  );
  return `${source.slice(0, start)}${replacement}${source.slice(start + current.length)}`;
}

function renderReviewedNpm12BrevTemplate(source: string): string {
  const nodeSectionStart = "# 3. Node.js 22\n";
  const nodeSectionEnd = "# 4. OpenShell CLI\n";
  const start = source.indexOf(nodeSectionStart);
  const end = source.indexOf(nodeSectionEnd, start + nodeSectionStart.length);
  assert.notEqual(start, -1, "reviewed npm Brev Node section start must exist");
  assert.notEqual(end, -1, "reviewed npm Brev Node section end must exist");
  const reviewedNodeSection = `# 3. Node.js 24.18.1
NODE_VERSION="24.18.1"
if command -v node >/dev/null 2>&1 && [[ "$(node --version)" == "v\${NODE_VERSION}" ]]; then
  info "Node.js already installed: $(node --version)"
else
  case "$(uname -m)" in
    x86_64)
      node_arch="x64"
      node_sha256="9f5eb6ac21845a66c493c91a253b1da32fd684e89e9b7202d4936982336be4ca"
      ;;
    aarch64 | arm64)
      node_arch="arm64"
      node_sha256="df224555a083b918e46260cc969838501b9f9a87140c1195e5b9597b56d5dae2"
      ;;
    *) fail "Unsupported Node.js architecture: $(uname -m)" ;;
  esac
  info "Installing Node.js \${NODE_VERSION}..."
  node_tmp="$(mktemp)"
  node_url="https://nodejs.org/dist/v\${NODE_VERSION}/node-v\${NODE_VERSION}-linux-\${node_arch}.tar.gz"
  curl -fsSL --proto '=https' --tlsv1.2 "$node_url" -o "$node_tmp" || {
    rm -f "$node_tmp"
    fail "Failed to download Node.js archive"
  }
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash="$(sha256sum "$node_tmp" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash="$(shasum -a 256 "$node_tmp" | awk '{print $1}')"
  else
    rm -f "$node_tmp"
    fail "No SHA-256 tool available (sha256sum/shasum)"
  fi
  if [[ "$actual_hash" != "$node_sha256" ]]; then
    rm -f "$node_tmp"
    fail "Node.js archive integrity check failed\\n  Expected: $node_sha256\\n  Actual:   $actual_hash"
  fi
  sudo tar -xzf "$node_tmp" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "$node_tmp"
  [[ "$(node --version)" == "v\${NODE_VERSION}" ]] || fail "Node.js installation did not produce v\${NODE_VERSION}"
  info "Node.js $(node --version) installed"
fi

`;
  const withNodePin = `${source.slice(0, start)}${reviewedNodeSection}${source.slice(end)}`;
  const withDescription = replaceUniqueSource(
    withNodePin,
    "#   2. Node.js 22 (nodesource)",
    "#   2. Node.js 24.18.1 and verified npm 12.0.2",
    "reviewed npm Brev description",
  );
  const dependencyInstallStart = `info "Installing npm dependencies..."
cd "$NEMOCLAW_CLONE_DIR"
`;
  return replaceUniqueSource(
    withDescription,
    dependencyInstallStart,
    `${dependencyInstallStart}reviewed_npm_tmp="$(mktemp -d)"
sudo env -u NODE_AUTH_TOKEN -u NPM_TOKEN -u NPM_CONFIG__AUTH_TOKEN \\
  RUNNER_TEMP="$reviewed_npm_tmp" \\
  bash .github/actions/setup-reviewed-npm/verify-and-install-npm.sh ci/reviewed-npm-audit.json
rm -rf "$reviewed_npm_tmp"
`,
    "reviewed npm Brev dependency install",
  );
}

function runParser(brevInstaller: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-brev-npm12-trust-"));
  tempDirs.push(tempDir);
  const brevPath = path.join(tempDir, "brev-launchable-ci-cpu.sh");
  fs.writeFileSync(brevPath, brevInstaller);
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      PARSER,
      "--blueprint",
      path.join(REPO_ROOT, "nemoclaw-blueprint/blueprint.yaml"),
      "--installer",
      path.join(REPO_ROOT, "scripts/install-openshell.sh"),
      "--brev-installer",
      brevPath,
      "--supervisor-runtime",
      path.join(REPO_ROOT, "src/lib/onboard/docker-driver-gateway-runtime.ts"),
      "--format",
      "json",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
}

describe("reviewed npm 12 Brev template trust", () => {
  // source-shape-contract: security -- Exact prospective Brev bytes and install order must be base-authorized before trusted CI can admit the npm 12 runtime change
  it("binds the exact reviewed npm 12 Brev successor and rejects bootstrap drift", () => {
    const reviewedTemplate = renderReviewedNpm12BrevTemplate(BREV_TEMPLATE);
    const npmVerifier = reviewedTemplate.indexOf(
      "bash .github/actions/setup-reviewed-npm/verify-and-install-npm.sh ci/reviewed-npm-audit.json",
    );
    const dependencyInstall = reviewedTemplate.indexOf("npm install --ignore-scripts", npmVerifier);

    expect(createHash("sha256").update(reviewedTemplate).digest("hex")).toBe(
      REVIEWED_SOURCE_SHA256,
    );
    expect(reviewedTemplate).toContain('NODE_VERSION="24.18.1"');
    expect(reviewedTemplate).toContain(
      'node_sha256="9f5eb6ac21845a66c493c91a253b1da32fd684e89e9b7202d4936982336be4ca"',
    );
    expect(reviewedTemplate).toContain(
      'node_sha256="df224555a083b918e46260cc969838501b9f9a87140c1195e5b9597b56d5dae2"',
    );
    expect(npmVerifier).toBeGreaterThan(-1);
    expect(dependencyInstall).toBeGreaterThan(npmVerifier);
    expect(fs.statSync(NPM_BOOTSTRAP).isFile()).toBe(true);
    expect(fs.statSync(NPM_BOOTSTRAP).mode & 0o111).not.toBe(0);
    const bootstrapSource = fs.readFileSync(NPM_BOOTSTRAP, "utf8");
    expect(bootstrapSource).toContain("config.npmVersion");
    expect(bootstrapSource).toContain("config.npmIntegrity");
    expect(bootstrapSource).toContain("config.npmArchiveSha256");

    const accepted = runParser(reviewedTemplate);
    expect(accepted.status, accepted.stderr).toBe(0);
    const records = JSON.parse(accepted.stdout) as Array<{
      operationalTemplateSha256: string;
      source: string;
    }>;
    expect(
      new Set(
        records
          .filter((record) => record.source === "Brev launchable")
          .map((record) => record.operationalTemplateSha256),
      ),
    ).toEqual(new Set([REVIEWED_TEMPLATE_SHA256]));

    const forged = runParser(
      reviewedTemplate.replace("ci/reviewed-npm-audit.json", "ci/unreviewed-npm-audit.json"),
    );
    expect(forged.status).toBe(1);
    expect(forged.stderr).toContain("Brev launchable operational template is not base-trusted");
    expect(forged.stderr).toContain(REVIEWED_TEMPLATE_SHA256);
    expect(forged.stdout).toBe("");
  });
});
