// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertMcpCredentialBoundaryRuntimeVersion } from "../actions/sandbox/mcp-bridge-validation";
import type { Session } from "../state/onboard-session";
import { resolveSandboxCredentialProviderType } from "./agent-config";

export interface RotateTokenOpts {
  fromEnv?: string | null;
  fromStdin?: boolean;
}

type RotateTokenFailure = (lines: string | readonly string[], exitCode?: number) => never;

type RotateTokenSession = Pick<Session, "credentialEnv" | "provider" | "sandboxName"> & {
  readonly providerType?: string;
};

type RotateTokenSandboxRoute = import("./agent-config").SandboxCredentialRoute;

export function loadRotateTokenSession(): RotateTokenSession | null {
  const { loadSession } =
    require("../state/onboard-session") as typeof import("../state/onboard-session");
  return loadSession();
}

export type RotateTokenDeps = {
  readonly appendAuditEntry: typeof import("../state/audit/operational").appendAuditEntry;
  readonly captureOpenshellCommand: typeof import("../adapters/openshell/client").captureOpenshellCommand;
  readonly fail: RotateTokenFailure;
  readonly loadSandbox: (sandboxName: string) => RotateTokenSandboxRoute | null;
  readonly loadSession: () => RotateTokenSession | null;
  readonly promptSecret: typeof import("../credentials/store").promptSecret;
  readonly resolveAgentConfig: (sandboxName: string) => import("./agent-config").AgentConfigTarget;
  readonly runOpenshellCommand: typeof import("../adapters/openshell/client").runOpenshellCommand;
  readonly saveCredential: typeof import("../credentials/store").saveCredential;
  readonly validateName: typeof import("../runner").validateName;
};

export async function rotateSandboxToken(
  sandboxName: string,
  opts: RotateTokenOpts,
  deps: RotateTokenDeps,
): Promise<void> {
  deps.validateName(sandboxName, "sandbox name");

  const registeredRoute = deps.loadSandbox(sandboxName);
  const registeredProvider = nonEmptyString(registeredRoute?.provider);
  const session = registeredRoute ? null : deps.loadSession();

  let credentialEnv: string;
  let providerName: string;
  let providerType: string;
  if (registeredRoute) {
    if (!registeredProvider) {
      deps.fail([
        `  Cannot rotate a credential for sandbox '${sandboxName}'.`,
        "  Its registry entry has no inference provider.",
      ]);
    }
    const registeredCredentialEnv = nonEmptyString(registeredRoute?.credentialEnv);
    if (!registeredCredentialEnv) {
      deps.fail([
        `  Cannot rotate a credential for sandbox '${sandboxName}'.`,
        `  Its registered provider '${registeredProvider}' has no credential environment variable.`,
      ]);
    }
    credentialEnv = registeredCredentialEnv;
    providerName = registeredProvider;
    providerType = resolveSandboxCredentialProviderType(
      registeredProvider,
      registeredRoute?.preferredInferenceApi ?? null,
    );
  } else {
    if (!session || !session.credentialEnv) {
      deps.fail([
        `  Cannot determine credential for sandbox '${sandboxName}'.`,
        "  No registered inference route or onboard session was found with a credentialEnv.",
        "  Re-run: nemoclaw onboard --recreate-sandbox",
      ]);
    }

    if (session.sandboxName && session.sandboxName !== sandboxName) {
      deps.fail(`  Onboard session is for sandbox '${session.sandboxName}', not '${sandboxName}'.`);
    }
    credentialEnv = session.credentialEnv;
    providerName = session.provider || "inference";
    providerType = session.providerType || "generic";
  }

  const target = deps.resolveAgentConfig(sandboxName);

  console.log(`  Agent:          ${target.agentName}`);
  console.log(`  Provider:       ${providerName}`);
  console.log(`  Credential env: ${credentialEnv}`);

  let newToken: string | null = null;
  if (opts.fromEnv) {
    newToken = process.env[opts.fromEnv] || null;
    if (!newToken) deps.fail(`  Environment variable "${opts.fromEnv}" is not set or empty.`);
  } else if (opts.fromStdin) {
    newToken = await readStdin();
  } else {
    newToken = await deps.promptSecret(`  New ${credentialEnv} value: `);
  }

  if (!newToken || !newToken.trim()) deps.fail("  Token cannot be empty.");
  newToken = newToken.trim();
  if (/\s/.test(newToken)) deps.fail("  Token contains whitespace. This is likely a paste error.");

  const binary = getOpenshellBinary();
  try {
    assertMcpCredentialBoundaryRuntimeVersion({
      resolveOpenshell: () => binary,
      runVersionCommand: (versionBinary) => {
        const result = deps.captureOpenshellCommand(versionBinary, ["--version"], {
          ignoreError: true,
          includeStreams: true,
          maxBuffer: 16 * 1_024,
          timeout: 5_000,
        });
        return {
          ...(result.error ? { error: result.error } : {}),
          status: result.status,
          stderr: result.stderr ?? "",
          stdout: result.stdout ?? "",
        };
      },
    });
  } catch (error) {
    deps.fail(error instanceof Error ? error.message : "OpenShell version check failed.");
  }

  deps.saveCredential(credentialEnv, newToken);

  console.log("  Updating openshell provider...");
  const result = deps.runOpenshellCommand(
    binary,
    ["provider", "update", providerName, "--credential", credentialEnv],
    {
      env: { [credentialEnv]: newToken },
      ignoreError: true,
      errorLine: console.error,
      exit: (code: number) => process.exit(code),
    },
  );

  if (result.status !== 0) {
    const createResult = deps.runOpenshellCommand(
      binary,
      [
        "provider",
        "create",
        "--name",
        providerName,
        "--type",
        providerType,
        "--credential",
        credentialEnv,
      ],
      {
        env: { [credentialEnv]: newToken },
        ignoreError: true,
        errorLine: console.error,
        exit: (code: number) => process.exit(code),
      },
    );
    if (createResult.status !== 0)
      deps.fail("  Failed to update provider. You may need to re-onboard.");
  }

  deps.appendAuditEntry({
    action: "rotate_token",
    sandbox: sandboxName,
    timestamp: new Date().toISOString(),
    reason: `rotate-token ${target.agentName}:${credentialEnv}`,
  });

  const lastFour = newToken.length > 4 ? newToken.slice(-4) : "****";
  console.log(`  Token rotated: ****${lastFour}`);
  console.log("");
  console.log("  The new credential is active immediately for new sandbox requests.");
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getOpenshellBinary(): string {
  return process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
}

/** Read all data from stdin until EOF. */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8").trim()));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}
