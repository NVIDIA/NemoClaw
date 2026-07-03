// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { assertExitZero, resultText } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import type { SandboxClient } from "../clients/sandbox.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import type { DcodeInvalidCredentialRebuildOptions } from "./lifecycle-dcode-options.ts";

const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";
const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
const OPENSHELL_MANAGED_BY_VALUE = "openshell";
const DOCKER_PROBE_TIMEOUT_MS = 15_000;
const ROUTE_ATTEMPTS = 8;
const ROUTE_DELAY_MS = 2_000;
export const DCODE_MARKER_PATH =
  "/sandbox/.deepagents/.state/nemoclaw-dcode-invalid-credential-rebuild-marker";
export const DCODE_MARKER_VALUE = "NEMOCLAW_DCODE_INVALID_CREDENTIAL_MARKER";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function sortedUniqueLines(text: string): string[] {
  return [...new Set(nonEmptyLines(text))].sort();
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function routeHttpCode(result: ShellProbeResult): string | undefined {
  const code = result.stdout.trim();
  return /^\d{3}$/.test(code) ? code : undefined;
}

export function is2xx(code: string | undefined): boolean {
  return code !== undefined && /^2\d\d$/.test(code);
}

function outputContainsExactLine(output: string, expected: string): boolean {
  return nonEmptyLines(stripAnsi(output)).includes(expected);
}

function outputContainsReadySandbox(result: ShellProbeResult, sandboxName: string): boolean {
  return stripAnsi(`${result.stdout}\n${result.stderr}`)
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const [name] = trimmed.split(/\s+/);
      return name === sandboxName && /\bReady\b/i.test(trimmed);
    });
}

export class DcodeInvalidCredentialProbes {
  constructor(
    private readonly host: HostCliClient,
    private readonly sandbox: SandboxClient,
    private readonly sandboxName: string,
    private readonly options: DcodeInvalidCredentialRebuildOptions,
  ) {}

  gatewayEnv(): NodeJS.ProcessEnv {
    return {
      ...buildAvailabilityProbeEnv(),
      OPENSHELL_GATEWAY: this.options.gatewayName,
    };
  }

  async gatewaySandboxNames(): Promise<ShellProbeResult> {
    const result = await this.host.command(
      "openshell",
      ["sandbox", "list", "--names", "--limit", "2", "-g", this.options.gatewayName],
      {
        artifactName: "lifecycle-dcode-gateway-sandbox-names",
        env: this.gatewayEnv(),
        timeoutMs: 30_000,
      },
    );
    assertExitZero(result, "list gateway-scoped sandboxes before DCode credential rotation");
    return result;
  }

  async assertReady(phase: string): Promise<ShellProbeResult> {
    const result = await this.host.command(
      "openshell",
      ["sandbox", "list", "-g", this.options.gatewayName],
      {
        artifactName: `lifecycle-dcode-sandbox-ready-${phase}`,
        env: this.gatewayEnv(),
        timeoutMs: 30_000,
      },
    );
    assertExitZero(result, `list DCode sandbox during ${phase}`);
    if (!outputContainsReadySandbox(result, this.sandboxName)) {
      throw new Error(
        `DCode sandbox '${this.sandboxName}' was not exactly Ready during ${phase}: ${resultText(result)}`,
      );
    }
    return result;
  }

  async assertNemoclawStatus(phase: string): Promise<ShellProbeResult> {
    const result = await this.host.nemoclaw([this.sandboxName, "status"], {
      artifactName: `lifecycle-dcode-nemoclaw-status-${phase}`,
      env: this.gatewayEnv(),
      timeoutMs: 3 * 60_000,
    });
    assertExitZero(result, `nemoclaw ${this.sandboxName} status during ${phase}`);
    if (!/Phase:\s*Ready/i.test(stripAnsi(resultText(result)))) {
      throw new Error(
        `nemoclaw status did not report DCode sandbox '${this.sandboxName}' Ready during ${phase}: ${resultText(result)}`,
      );
    }
    return result;
  }

  async assertProviderListed(): Promise<ShellProbeResult> {
    const result = await this.host.command(
      "openshell",
      ["provider", "list", "--names", "-g", this.options.gatewayName],
      {
        artifactName: "lifecycle-dcode-provider-names-before",
        env: this.gatewayEnv(),
        timeoutMs: 30_000,
      },
    );
    assertExitZero(result, "list gateway-scoped providers before DCode credential rotation");
    if (!outputContainsExactLine(result.stdout, this.options.providerName)) {
      throw new Error(
        `gateway '${this.options.gatewayName}' does not list recorded provider '${this.options.providerName}'`,
      );
    }
    return result;
  }

  async assertInferenceRoute(phase: string): Promise<ShellProbeResult> {
    const result = await this.host.command(
      "openshell",
      ["inference", "get", "-g", this.options.gatewayName],
      {
        artifactName: `lifecycle-dcode-inference-route-${phase}`,
        env: this.gatewayEnv(),
        timeoutMs: 30_000,
      },
    );
    assertExitZero(result, `read DCode inference route during ${phase}`);
    const plain = stripAnsi(resultText(result));
    if (
      !plain.includes(`Provider: ${this.options.providerName}`) ||
      !plain.includes(`Model: ${this.options.model}`)
    ) {
      throw new Error(
        `DCode inference route during ${phase} did not match registry provider/model: ${plain}`,
      );
    }
    return result;
  }

  async assertDcodeIdentity(): Promise<ShellProbeResult> {
    const result = await this.sandbox.exec(
      this.sandboxName,
      [
        "sh",
        "-lc",
        "test -d /sandbox/.deepagents && test -x /usr/local/bin/dcode && " +
          "test -s /sandbox/.deepagents/config.toml && " +
          "printf '%s\\n' NEMOCLAW_DCODE_IDENTITY_OK",
      ],
      {
        artifactName: "lifecycle-dcode-identity",
        env: this.gatewayEnv(),
        timeoutMs: 30_000,
      },
    );
    assertExitZero(result, "verify the selected sandbox is Deep Agents Code");
    if (!outputContainsExactLine(result.stdout, "NEMOCLAW_DCODE_IDENTITY_OK")) {
      throw new Error("selected sandbox did not emit the Deep Agents Code identity marker");
    }
    return result;
  }

  async writeMarker(): Promise<ShellProbeResult> {
    const result = await this.sandbox.exec(
      this.sandboxName,
      [
        "sh",
        "-lc",
        `mkdir -p /sandbox/.deepagents/.state && printf '%s\\n' '${DCODE_MARKER_VALUE}' > '${DCODE_MARKER_PATH}'`,
      ],
      {
        artifactName: "lifecycle-dcode-marker-write",
        env: this.gatewayEnv(),
        timeoutMs: 30_000,
      },
    );
    assertExitZero(result, "write durable DCode rebuild marker");
    return result;
  }

  async assertMarker(): Promise<ShellProbeResult> {
    const result = await this.sandbox.exec(this.sandboxName, ["cat", DCODE_MARKER_PATH], {
      artifactName: "lifecycle-dcode-marker-after-invalid-rebuild",
      env: this.gatewayEnv(),
      timeoutMs: 30_000,
    });
    assertExitZero(result, "read DCode marker after rejected rebuild");
    if (!outputContainsExactLine(result.stdout, DCODE_MARKER_VALUE)) {
      throw new Error("DCode durable marker changed or disappeared after rejected rebuild");
    }
    return result;
  }

  async discoverManagedContainerIds(phase: string): Promise<ShellProbeResult> {
    const result = await this.host.command(
      "docker",
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${this.sandboxName}`,
        "--format",
        "{{.ID}}",
      ],
      {
        artifactName: `lifecycle-dcode-docker-container-ids-${phase}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
      },
    );
    assertExitZero(result, `discover managed DCode Docker container IDs during ${phase}`);
    return result;
  }

  async probeInferenceLocal(phase: string, attempt?: number): Promise<ShellProbeResult> {
    const payload = JSON.stringify({
      model: this.options.model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK" }],
      stream: false,
    });
    return await this.sandbox.exec(
      this.sandboxName,
      [
        "curl",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--connect-timeout",
        "5",
        "--max-time",
        "15",
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        payload,
        "https://inference.local/v1/chat/completions",
      ],
      {
        artifactName: `lifecycle-dcode-inference-local-${phase}${attempt ? `-${attempt}` : ""}`,
        env: this.gatewayEnv(),
        timeoutMs: 25_000,
      },
    );
  }

  async waitForRoute(
    accepted: (code: string | undefined) => boolean,
    phase: string,
  ): Promise<ShellProbeResult> {
    let last: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= ROUTE_ATTEMPTS; attempt += 1) {
      last = await this.probeInferenceLocal(phase, attempt);
      if (last.exitCode === 0 && accepted(routeHttpCode(last))) return last;
      if (attempt < ROUTE_ATTEMPTS) await sleep(ROUTE_DELAY_MS);
    }
    throw new Error(
      `DCode inference.local route did not reach the required HTTP state during ${phase}; ` +
        `last result: ${last ? resultText(last) : "no probe result"}`,
    );
  }

  async updateProviderCredential(
    credential: string,
    phase: "invalid" | "finally" | "cleanup",
  ): Promise<ShellProbeResult> {
    const result = await this.host.command(
      "openshell",
      [
        "provider",
        "update",
        "-g",
        this.options.gatewayName,
        this.options.providerName,
        "--credential",
        this.options.credentialEnv,
      ],
      {
        artifactName: `lifecycle-dcode-provider-credential-${phase}`,
        env: {
          ...this.gatewayEnv(),
          [this.options.credentialEnv]: credential,
        },
        redactionValues: [credential],
        timeoutMs: 30_000,
      },
    );
    assertExitZero(result, `restore/update provider credential (${phase})`);
    return result;
  }
}
