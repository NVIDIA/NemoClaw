// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifySandboxCreateFailure } from "./validation";

describe("classifySandboxCreateFailure plugin-install network arm", () => {
  it("detects plugin install network denial from ENOTFOUND against the npm registry", () => {
    const output = [
      "npm error code ENOTFOUND",
      "npm error errno ENOTFOUND",
      "npm error network request to https://registry.npmjs.org/@openclaw%2Fbrave-plugin failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
      "Docker stream error: The command '/bin/bash -o pipefail -c set -eu;",
      '  openclaw plugins install "npm:@openclaw/brave-plugin@2026.5.27" --pin;',
      "  BRAVE_API_KEY=openshell:resolve:env:BRAVE_API_KEY openclaw doctor --fix --non-interactive;",
      "fi' returned a non-zero code: 1",
    ].join("\n");
    const result = classifySandboxCreateFailure(output);
    expect(result.kind).toBe("plugin_install_network_denied");
    expect(result.uploadedToGateway).toBe(false);
  });

  it("detects plugin install network denial from ECONNREFUSED against ClawHub", () => {
    const output = [
      "npm error code ECONNREFUSED",
      "npm error network request to https://registry.clawhub.io/@openclaw%2Fdiagnostics-otel failed, reason: connect ECONNREFUSED 34.120.54.1:443",
      "The command '...openclaw plugins install npm:@openclaw/diagnostics-otel@2026.5.27 --pin...' returned a non-zero code: 1",
    ].join("\n");
    expect(classifySandboxCreateFailure(output).kind).toBe("plugin_install_network_denied");
  });

  it("does NOT classify unrelated failures as plugin_install_network_denied", () => {
    expect(classifySandboxCreateFailure("npm install failed with ENOENT").kind).toBe("unknown");
    expect(classifySandboxCreateFailure("openclaw doctor --fix failed").kind).toBe("unknown");
  });

  it("does NOT classify as plugin_install_network_denied when plugin install fails for a non-network reason", () => {
    const output = [
      "npm error code E404",
      "npm error 404 Not Found - GET https://registry.npmjs.org/@openclaw%2Fmissing-plugin",
      "npm error 404 '@openclaw/missing-plugin@0.0.0' is not in the npm registry",
      "The command '/bin/bash -c openclaw plugins install npm:@openclaw/missing-plugin@0.0.0 --pin' returned a non-zero code: 1",
    ].join("\n");
    expect(classifySandboxCreateFailure(output).kind).toBe("unknown");
  });

  it("does NOT classify as plugin_install_network_denied when plugin install step succeeded and a later step failed", () => {
    const output = [
      "Step 3/10 : RUN openclaw plugins install npm:@openclaw/brave-plugin@2026.5.27 --pin",
      " ---> Running in abc123",
      " ---> def456",
      "Step 4/10 : RUN fail-step",
      " ---> Running in xyz789",
      "The command '/bin/sh -c fail-step' returned a non-zero code: 1",
    ].join("\n");
    expect(classifySandboxCreateFailure(output).kind).toBe("unknown");
  });

  it("does NOT classify as plugin_install_network_denied when plugin install succeeded but a later command in the same RUN block failed with a network error", () => {
    // The same RUN block runs `openclaw plugins install` followed by
    // `openclaw doctor --fix`. If the install succeeds but doctor's network
    // call fails, the block fails but npm never emits an "npm error" line,
    // so the classifier must not fire the plugin-install hint.
    const output = [
      "The command '/bin/bash -o pipefail -c set -eu;",
      '  openclaw plugins install "npm:@openclaw/brave-plugin@2026.5.27" --pin;',
      "  BRAVE_API_KEY=openshell:resolve:env:BRAVE_API_KEY openclaw doctor --fix --non-interactive;",
      "fi' returned a non-zero code: 1",
      "error: getaddrinfo ENOTFOUND api.openclaw.ai",
    ].join("\n");
    expect(classifySandboxCreateFailure(output).kind).toBe("unknown");
  });

  it("does NOT classify as plugin_install_network_denied when an npm script after the plugin install in the same RUN block emits a network npm error", () => {
    // If `openclaw plugins install` succeeds but a later npm-based command in
    // the same RUN block fails, its stderr appears before Docker's final failed-
    // command summary. Correlating the error URL to the requested plugin keeps
    // the unrelated package failure on the generic recovery path.
    const output = [
      "npm error code ENOTFOUND",
      "npm error network request to https://registry.npmjs.org/@openclaw%2Ftools failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
      "The command '/bin/bash -o pipefail -c set -eu;",
      '  openclaw plugins install "npm:@openclaw/brave-plugin@2026.5.27" --pin;',
      "  npm run doctor-fix;",
      "fi' returned a non-zero code: 1",
    ].join("\n");
    expect(classifySandboxCreateFailure(output).kind).toBe("unknown");
  });

  it("does NOT classify package-agnostic npm network output as a plugin install denial", () => {
    const output = [
      "npm error code ENOTFOUND",
      "npm error network request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
      "The command '/bin/bash -c openclaw plugins install npm:@openclaw/brave-plugin@2026.5.27 --pin' returned a non-zero code: 1",
    ].join("\n");
    expect(classifySandboxCreateFailure(output).kind).toBe("unknown");
  });

  it("does NOT classify a non-plugin command that names the same scoped package", () => {
    const output = [
      "npm error code ENOTFOUND",
      "npm error network request to https://registry.npmjs.org/@openclaw%2Ftools failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
      "The command '/bin/sh -c npm install npm:@openclaw/tools' returned a non-zero code: 1",
    ].join("\n");
    expect(classifySandboxCreateFailure(output).kind).toBe("unknown");
  });
});
