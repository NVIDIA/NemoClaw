// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dockerfileInstructions } from "./helpers/dockerfile-run-commands";

const DOCKERFILE = join(import.meta.dirname, "../Dockerfile");

describe("corporate proxy CA build-time TLS anchor (#6839)", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf-8");

  // source-shape-contract: security -- The single corporate CA build arg is the sole onboard-patched supply-chain trust input
  it("declares exactly one corporate CA build arg so onboard patching stays unambiguous", () => {
    const matches = dockerfile.match(/^ARG NEMOCLAW_CORPORATE_CA_B64=/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  // source-shape-contract: security -- The build-time TLS trust anchor must precede registry and signature-verifying fetches
  it("decodes the CA and exports NODE_EXTRA_CA_CERTS before the reinstall audit-signatures step", () => {
    const argIndex = dockerfile.indexOf("ARG NEMOCLAW_CORPORATE_CA_B64=");
    const decodeIndex = dockerfile.indexOf('RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then');
    const anchorIndex = dockerfile.indexOf(
      "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem",
    );
    const curlAnchorIndex = dockerfile.indexOf(
      "export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem",
      anchorIndex,
    );
    const ipAddressPatchIndex = dockerfile.indexOf(
      "node --experimental-strip-types /scripts/lib/patch-bundled-npm-ip-address.mts",
      curlAnchorIndex,
    );
    const auditSignaturesIndex = dockerfile.indexOf("mcporter-runtime audit signatures");

    for (const [name, index] of Object.entries({
      argIndex,
      decodeIndex,
      anchorIndex,
      curlAnchorIndex,
      ipAddressPatchIndex,
      auditSignaturesIndex,
    })) {
      expect(index, name).toBeGreaterThan(-1);
    }
    expect(argIndex).toBeLessThan(decodeIndex);
    expect(decodeIndex).toBeLessThan(anchorIndex);
    expect(anchorIndex).toBeLessThan(curlAnchorIndex);
    expect(curlAnchorIndex).toBeLessThan(ipAddressPatchIndex);
    expect(anchorIndex).toBeLessThan(auditSignaturesIndex);
  });
});

describe("DCode corporate proxy CA cold-build trust (#8119)", () => {
  const baseDockerfile = readFileSync(
    join(import.meta.dirname, "../agents/langchain-deepagents-code/Dockerfile.base"),
    "utf-8",
  );
  const finalDockerfile = readFileSync(
    join(import.meta.dirname, "../agents/langchain-deepagents-code/Dockerfile"),
    "utf-8",
  );

  // source-shape-contract: security -- DCode cold base builds must establish corporate CA trust before HTTPS dependency fetches
  it("accepts the corporate CA build arg in the DCode base image before HTTPS fetches", () => {
    const argIndex = baseDockerfile.indexOf("ARG NEMOCLAW_CORPORATE_CA_B64=");
    const nativeBuilderIndex = baseDockerfile.indexOf("AS native-security-builder", argIndex);
    const nativeArgIndex = baseDockerfile.indexOf(
      "ARG NEMOCLAW_CORPORATE_CA_B64",
      nativeBuilderIndex,
    );
    const nativeTrustIndex = baseDockerfile.indexOf("update-ca-certificates", nativeArgIndex);
    const nativeFetchIndex = baseDockerfile.indexOf(
      "build-native-security-packages.sh /out",
      nativeTrustIndex,
    );
    const perlFetchIndex = baseDockerfile.indexOf(
      "RUN bash /scripts/security/build-perl-security-packages.sh",
      nativeFetchIndex,
    );
    const finalFromIndex = baseDockerfile.indexOf("FROM node:22-trixie-slim", perlFetchIndex);
    const finalArgIndex = baseDockerfile.indexOf("ARG NEMOCLAW_CORPORATE_CA_B64", finalFromIndex);
    const finalTrustIndex = baseDockerfile.indexOf("update-ca-certificates", finalArgIndex);
    const firstSnapshotCurlIndex = baseDockerfile.indexOf(
      "https://snapshot.debian.org/archive",
      finalTrustIndex,
    );

    for (const [name, index] of Object.entries({
      argIndex,
      nativeBuilderIndex,
      nativeArgIndex,
      nativeTrustIndex,
      nativeFetchIndex,
      perlFetchIndex,
      finalFromIndex,
      finalArgIndex,
      finalTrustIndex,
      firstSnapshotCurlIndex,
    })) {
      expect(index, name).toBeGreaterThan(-1);
    }
    expect(nativeArgIndex).toBeLessThan(nativeTrustIndex);
    expect(nativeTrustIndex).toBeLessThan(nativeFetchIndex);
    expect(nativeFetchIndex).toBeLessThan(perlFetchIndex);
    expect(finalArgIndex).toBeLessThan(finalTrustIndex);
    expect(finalTrustIndex).toBeLessThan(firstSnapshotCurlIndex);
  });

  // source-shape-contract: security -- DCode discovery npm installs must trust the host corporate CA before registry access
  it("trusts the corporate CA before the DCode discovery runtime npm install", () => {
    const discoveryStageIndex = finalDockerfile.indexOf("AS mcp-tool-discovery-runtime");
    const discoveryArgIndex = finalDockerfile.indexOf(
      "ARG NEMOCLAW_CORPORATE_CA_B64",
      discoveryStageIndex,
    );
    const discoveryTrustIndex = finalDockerfile.indexOf(
      "export NODE_EXTRA_CA_CERTS=/tmp/nemoclaw-corporate-ca.pem",
      discoveryArgIndex,
    );
    const discoveryInstallIndex = finalDockerfile.indexOf(
      "./install-reviewed-runtime.sh",
      discoveryTrustIndex,
    );

    expect(discoveryStageIndex).toBeGreaterThan(-1);
    expect(discoveryArgIndex).toBeGreaterThan(discoveryStageIndex);
    expect(discoveryTrustIndex).toBeGreaterThan(discoveryArgIndex);
    expect(discoveryInstallIndex).toBeGreaterThan(discoveryTrustIndex);
  });

  // source-shape-contract: security -- DCode final images must decode the sandbox-specific corporate CA even when the base is reused
  it("decodes the corporate CA again in the DCode final image", () => {
    const finalFromIndex = finalDockerfile.indexOf("FROM ${BASE_IMAGE}");
    const finalArgIndex = finalDockerfile.indexOf("ARG NEMOCLAW_CORPORATE_CA_B64", finalFromIndex);
    const finalDecodeIndex = finalDockerfile.indexOf(
      'RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then',
      finalArgIndex,
    );
    const trustDirectoryIndex = finalDockerfile.indexOf(
      "install -d -o root -g root -m 0755 /usr/local/share/nemoclaw",
      finalDecodeIndex,
    );
    const runtimeProbeIndex = finalDockerfile.indexOf(
      "mcp-tool-discovery-runtime",
      finalDecodeIndex,
    );
    const curlAnchorIndex = finalDockerfile.indexOf(
      "export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem",
      finalDecodeIndex,
    );
    const ipAddressPatchIndex = finalDockerfile.indexOf(
      "node --experimental-strip-types /scripts/lib/patch-bundled-npm-ip-address.mts",
      curlAnchorIndex,
    );

    for (const [name, index] of Object.entries({
      finalFromIndex,
      finalArgIndex,
      finalDecodeIndex,
      trustDirectoryIndex,
      runtimeProbeIndex,
      curlAnchorIndex,
      ipAddressPatchIndex,
    })) {
      expect(index, name).toBeGreaterThan(-1);
    }
    expect(finalFromIndex).toBeLessThan(finalArgIndex);
    expect(finalArgIndex).toBeLessThan(finalDecodeIndex);
    expect(finalDecodeIndex).toBeLessThan(trustDirectoryIndex);
    expect(trustDirectoryIndex).toBeLessThan(runtimeProbeIndex);
    expect(trustDirectoryIndex).toBeLessThan(curlAnchorIndex);
    expect(curlAnchorIndex).toBeLessThan(ipAddressPatchIndex);
  });
});

describe("Hermes corporate proxy CA final-stage trust", () => {
  const dockerfile = readFileSync(
    join(import.meta.dirname, "../agents/hermes/Dockerfile"),
    "utf-8",
  );

  // source-shape-contract: security -- Hermes final-stage registry clients must trust the decoded corporate CA before making HTTPS requests
  it("uses the corporate CA conditionally for all Hermes registry remediations", () => {
    const finalFromIndex = dockerfile.indexOf("FROM ${BASE_IMAGE}");
    const finalStage = dockerfile.slice(finalFromIndex);
    const argIndex = finalStage.indexOf("ARG NEMOCLAW_CORPORATE_CA_B64");
    const decodeIndex = finalStage.indexOf(
      'RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then',
      argIndex,
    );
    const nodeAnchorIndex = finalStage.indexOf(
      "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem",
      decodeIndex,
    );
    const payloadCopyIndex = finalStage.indexOf(
      "COPY --from=hermes-npm-patch-payload / /",
      nodeAnchorIndex,
    );
    const conditionalCurlTrust = `RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \\
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \\
    fi; \\`;
    const remediationCommands = [
      "node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
      "node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts",
      "node --experimental-strip-types /scripts/lib/patch-bundled-npm-ip-address.mts",
    ];
    const agentInstallCommand =
      "node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent hermes --phase agent-install";
    const packageInstallRun = dockerfileInstructions(finalStage).find(
      (instruction) =>
        instruction.keyword === "RUN" && instruction.body.includes(agentInstallCommand),
    );
    const expectedPackageInstallRun = [
      "RUN unset SSL_CERT_FILE REQUESTS_CA_BUNDLE; \\",
      "    if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \\",
      "      export SSL_CERT_FILE=/usr/local/share/nemoclaw/corporate-ca.pem; \\",
      "      export REQUESTS_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \\",
      "    fi; \\",
      `    ${agentInstallCommand} \\`,
      '    && if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]; then \\',
      "        node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts \\",
      "            --agent hermes --phase managed-image-capability-union; \\",
      "    fi \\",
      "    && /opt/hermes/.venv/bin/python -I -c \\",
      "        \"from importlib.metadata import version; expected = {'aiohttp': '3.14.3', 'cryptography': '50.0.0'}; actual = {name: version(name) for name in expected}; assert actual == expected, actual\"",
      "",
    ].join("\n");
    const npmCommandIndexes = [...finalStage.matchAll(/^\s*npm\s+(?:ci|run)\b/gmu)].map(
      (match) => match.index,
    );

    for (const [name, index] of Object.entries({
      finalFromIndex,
      argIndex,
      decodeIndex,
      nodeAnchorIndex,
      payloadCopyIndex,
    })) {
      expect(index, name).toBeGreaterThan(-1);
    }
    expect(argIndex).toBeLessThan(decodeIndex);
    expect(decodeIndex).toBeLessThan(nodeAnchorIndex);
    expect(nodeAnchorIndex).toBeLessThan(payloadCopyIndex);
    for (const remediationCommand of remediationCommands) {
      const remediationIndex = finalStage.indexOf(remediationCommand, payloadCopyIndex);
      expect(remediationIndex, remediationCommand).toBeGreaterThan(payloadCopyIndex);
      const runIndex = finalStage.lastIndexOf("\nRUN ", remediationIndex) + 1;
      expect(runIndex, remediationCommand).toBeGreaterThan(payloadCopyIndex);
      expect(finalStage.slice(runIndex, remediationIndex).trim(), remediationCommand).toBe(
        conditionalCurlTrust,
      );
    }
    expect(npmCommandIndexes.length).toBeGreaterThan(0);
    for (const npmCommandIndex of npmCommandIndexes) {
      expect(nodeAnchorIndex).toBeLessThan(npmCommandIndex);
    }
    expect(packageInstallRun?.text).toBe(expectedPackageInstallRun);
    expect(packageInstallRun?.text).not.toContain("else");
    expect(finalStage.match(/^ENV (?:SSL_CERT_FILE|REQUESTS_CA_BUNDLE)=/gmu) ?? []).toEqual([]);
  });
});
