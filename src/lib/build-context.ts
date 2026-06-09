// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for staging a Docker build context and classifying sandbox
 * creation failures.
 */

import fs from "node:fs";
import path from "node:path";
import { CLI_NAME } from "./cli/branding";

import { classifySandboxCreateFailure, planSandboxCreateRecovery } from "./validation";

const EXCLUDED_SEGMENTS = new Set([
  ".venv",
  ".ruff_cache",
  ".pytest_cache",
  ".mypy_cache",
  "__pycache__",
  "node_modules",
  ".git",
]);

export function shouldIncludeBuildContextPath(sourceRoot: string, candidatePath: string): boolean {
  const relative = path.relative(sourceRoot, candidatePath);
  if (!relative || relative === "") return true;

  const segments = relative.split(path.sep);
  const basename = path.basename(candidatePath);

  if (basename === ".DS_Store" || basename.startsWith("._")) {
    return false;
  }

  return !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

export function copyBuildContextDir(sourceDir: string, destinationDir: string): void {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    filter: (candidatePath) => shouldIncludeBuildContextPath(sourceDir, candidatePath),
  });
}

/**
 * Pull the built sandbox image tag/ref out of the OpenShell create output so a
 * recovery hint can tell the operator how to re-tag and push the *already
 * built* image instead of rebuilding from the Dockerfile. OpenShell/Docker emit
 * it on lines like "Successfully tagged <ref>" or "  Built image <ref>".
 * Returns null when no tag is present in the captured output.
 */
export function extractBuiltImageRef(output = ""): string | null {
  const text = String(output || "");
  const patterns = [/^Successfully tagged\s+(\S+)/im, /^\s*Built image\s+(\S+)/im];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Reconstruct the `openshell sandbox create` command for the image-ref
 * workaround from the structured `createArgs` onboard built. Swaps the
 * `--from <Dockerfile>` value for the pushed registry ref and replaces the
 * `--policy <tmp>` value with a placeholder, because onboard generates the
 * policy into a temporary file that is cleaned up after a failed create.
 *
 * Only the structured flags (providers, GPU/resource, name) are echoed — never
 * the `-- env … nemoclaw-start` runtime wrapper, which carries non-secret-by-
 * design but still host-specific env (proxy host, dashboard URL) we do not want
 * to dump to the console. The wrapper is represented by a placeholder instead.
 */
export function reconstructImageRefCreateCommand(
  createArgs: readonly string[],
  registryRef: string,
): string {
  const rebuilt: string[] = [];
  for (let i = 0; i < createArgs.length; i++) {
    const arg = createArgs[i];
    rebuilt.push(arg);
    if ((arg === "--from" || arg === "--policy") && i + 1 < createArgs.length) {
      rebuilt.push(arg === "--from" ? registryRef : "<your-policy-file>");
      i += 1; // skip the original (temporary) value
    }
  }
  return `openshell sandbox create ${rebuilt.join(" ")} -- env <YOUR_RUNTIME_ENV> nemoclaw-start`;
}

export function printSandboxCreateRecoveryHints(
  output = "",
  {
    platform = process.platform,
    arch = process.arch,
    createArgs,
  }: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    createArgs?: readonly string[];
  } = {},
): void {
  const failure = classifySandboxCreateFailure(output);
  if (failure.kind === "image_upload_container_missing") {
    const { arm64ImageRefWorkaround } = planSandboxCreateRecovery(failure, { platform, arch });
    const builtRef = extractBuiltImageRef(output);
    console.error(
      "  Hint: OpenShell built the sandbox image but failed to upload the image tar into the gateway container",
    );
    console.error(
      "        (Docker 404 'container does not exist'). The gateway container is healthy — this is the",
    );
    console.error("        OpenShell large-tar upload path failing, not a missing gateway.");
    if (arm64ImageRefWorkaround) {
      console.error("  This is a known limitation on Linux ARM64 (aarch64). Workaround without rebuilding:");
    } else {
      console.error("  Workaround without rebuilding the image:");
    }
    console.error("    1. Start a local registry the gateway can reach:");
    console.error("         docker run -d -p 5000:5000 --restart=always --name registry registry:2");
    const sourceRef = builtRef ?? "<built-image>";
    const registryRef = `localhost:5000/${sourceRef}`;
    // OpenShell builds the sandbox image with whichever builder the host uses
    // (Docker on most hosts; buildah on the Linux ARM64 path that triggers
    // #3266). A docker-only push fails with "No such image" when the image
    // lives in buildah/containers storage, so emit both forms and let the
    // operator match whichever the build log above showed. See #3266.
    console.error("    2. Push the image OpenShell just built to that registry, using the same");
    console.error("       builder the build log above used —");
    console.error("       Docker build:");
    console.error(`         docker tag ${sourceRef} ${registryRef}`);
    console.error(`         docker push ${registryRef}`);
    console.error("       buildah build (log shows `COMMIT` / buildah steps):");
    console.error(`         buildah push ${sourceRef} docker://${registryRef}`);
    // Reconstruct NemoClaw's own create command (when we have the structured
    // args) so the operator does not have to guess the provider/GPU/resource
    // flags onboard added. A pared-down command would build a misconfigured
    // sandbox that then blocks `onboard --resume`. When the args are not
    // available, fall back to describing the one-token swap.
    if (createArgs && createArgs.length > 0) {
      console.error("    3. Re-create the sandbox from that image ref. This is the create command");
      console.error("       NemoClaw ran, with --from swapped to the pushed image. Replace the policy");
      console.error("       placeholder with your policy file (onboard's was a temporary file) and the");
      console.error("       runtime env placeholder with the env NemoClaw set (dashboard port, proxy):");
      console.error(`         ${reconstructImageRefCreateCommand(createArgs, registryRef)}`);
    } else {
      console.error("    3. Re-run the sandbox create OpenShell just attempted, but replace the");
      console.error(`       \`--from <…/Dockerfile>\` argument with \`--from ${registryRef}\` (this skips`);
      console.error("       the tar upload). Keep every other flag NemoClaw used — the providers, any");
      console.error("       GPU/resource flags, and the trailing `-- env … nemoclaw-start` command.");
    }
    console.error(`  If you would rather let NemoClaw rebuild and retry from scratch: ${CLI_NAME} onboard --resume`);
    return;
  }
  if (failure.kind === "image_transfer_timeout") {
    console.error("  Hint: image upload into the OpenShell gateway timed out.");
    console.error(`  Recovery: ${CLI_NAME} onboard --resume`);
    if (failure.uploadedToGateway) {
      console.error(
        "  Progress reached the gateway upload stage, so resume may be able to reuse existing gateway state.",
      );
    }
    console.error("  If this repeats, check Docker memory and retry on a host with more RAM.");
    return;
  }
  if (failure.kind === "image_transfer_reset") {
    console.error("  Hint: the image push/import stream was interrupted.");
    console.error(`  Recovery: ${CLI_NAME} onboard --resume`);
    if (failure.uploadedToGateway) {
      console.error("  The image appears to have reached the gateway before the stream failed.");
    }
    console.error("  If this repeats, restart Docker or the gateway and retry.");
    return;
  }
  if (failure.kind === "sandbox_create_incomplete") {
    console.error("  Hint: sandbox creation started but the create stream did not finish cleanly.");
    console.error(`  Recovery: ${CLI_NAME} onboard --resume`);
    console.error(
      "  Check: openshell sandbox list        # verify whether the sandbox became ready",
    );
    return;
  }
  if (failure.kind === "tls_cert_mismatch") {
    console.error(
      "  Hint: TLS certificate mismatch — the gateway certificate changed since the CLI last trusted it.",
    );
    console.error("  Fix:  openshell gateway trust -g nemoclaw");
    console.error(`  Then: ${CLI_NAME} onboard --resume`);
    return;
  }
  console.error(`  Recovery: ${CLI_NAME} onboard --resume`);
  console.error(`  Or:      ${CLI_NAME} onboard`);
}
