// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";

import { dockerSpawnSync } from "../../../adapters/docker/exec";
import type {
  PreparedOpenClawLegacyImage,
  PreparedOpenClawLegacyImageFinalization,
} from "../../../onboard/build-context-stage";
import { isImmutableDockerImageId } from "../../../onboard/openshell-docker-sandbox-containers";
import { dockerBuildSubprocessEnv } from "../../../onboard/sandbox-prebuild";

const DOCKER_IDENTITY_TIMEOUT_MS = 30_000;
const SAFE_VALUE_MAX_LENGTH = 4096;

export interface OpenClawLegacyDockerBinding {
  readonly dockerEnv: Readonly<Record<string, string>>;
  readonly engineId: string;
}

export interface OpenClawLegacyDockerBindingDeps {
  cwd: string;
  buildDockerEnv?(): Record<string, string>;
  runDocker?: typeof dockerSpawnSync;
  addExitListener?(listener: () => void): void;
  removeExitListener?(listener: () => void): void;
}

type InternalBinding = {
  readonly dockerOptions: Readonly<SpawnSyncOptions>;
  readonly runDocker: typeof dockerSpawnSync;
  readonly addExitListener: (listener: () => void) => void;
  readonly removeExitListener: (listener: () => void) => void;
};

const internalBindings = new WeakMap<OpenClawLegacyDockerBinding, InternalBinding>();

function isSafeSingleLineValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= SAFE_VALUE_MAX_LENGTH &&
    !/[\s\u0000-\u001f\u007f]/.test(value)
  );
}

function normalizeDockerOutput(output: string | Buffer | null | undefined): string {
  return typeof output === "string" ? output.trim() : String(output ?? "").trim();
}

function commandSucceeded(result: ReturnType<typeof dockerSpawnSync>): boolean {
  return result.error == null && result.status === 0;
}

function runDockerCapture(internal: InternalBinding, args: readonly string[]): string | null {
  try {
    const result = internal.runDocker(args, internal.dockerOptions);
    if (!commandSucceeded(result)) return null;
    return normalizeDockerOutput(result.stdout);
  } catch {
    return null;
  }
}

function requireInternalBinding(binding: OpenClawLegacyDockerBinding): InternalBinding {
  const internal = internalBindings.get(binding);
  if (!internal) {
    throw new Error("OpenClaw legacy-image Docker binding is not authentic.");
  }
  return internal;
}

function validateMutableImageRef(imageRef: string): string {
  if (
    !isSafeSingleLineValue(imageRef) ||
    isImmutableDockerImageId(imageRef) ||
    imageRef.includes("@") ||
    imageRef.lastIndexOf(":") <= imageRef.lastIndexOf("/")
  ) {
    throw new Error("OpenClaw legacy-image reference must be a mutable Docker tag.");
  }
  return imageRef;
}

function validateImageId(imageId: string): string {
  const normalized = imageId.trim().toLowerCase();
  if (!isImmutableDockerImageId(normalized)) {
    throw new Error("OpenClaw legacy-image ID must be an immutable sha256 identifier.");
  }
  return normalized;
}

function currentEngineMatches(
  binding: OpenClawLegacyDockerBinding,
  internal: InternalBinding,
): boolean {
  const currentEngineId = runDockerCapture(internal, ["info", "--format", "{{.ID}}"]);
  return currentEngineId !== null && currentEngineId === binding.engineId;
}

function inspectImageId(internal: InternalBinding, imageSelector: string): string | null {
  const output = runDockerCapture(internal, [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    imageSelector,
  ]);
  if (output === null || !isImmutableDockerImageId(output)) return null;
  return output.toLowerCase();
}

function verifyImageIdentity(
  binding: OpenClawLegacyDockerBinding,
  internal: InternalBinding,
  imageRef: string,
  imageId: string,
): boolean {
  if (!currentEngineMatches(binding, internal)) return false;
  if (inspectImageId(internal, imageRef) !== imageId) return false;
  return inspectImageId(internal, imageId) === imageId;
}

/**
 * Pin the Docker selector used by a rebuild. The default context is made
 * explicit so a later ambient `docker context use` cannot redirect the lease.
 */
export function captureOpenClawLegacyDockerBinding(
  deps: OpenClawLegacyDockerBindingDeps,
): OpenClawLegacyDockerBinding {
  const runDocker = deps.runDocker ?? dockerSpawnSync;
  const initialEnv = (deps.buildDockerEnv ?? dockerBuildSubprocessEnv)();
  const dockerEnv: Record<string, string> = { ...initialEnv };
  const explicitDockerHost = dockerEnv.DOCKER_HOST;
  const explicitDockerContext = dockerEnv.DOCKER_CONTEXT;

  for (const selector of [explicitDockerHost, explicitDockerContext]) {
    if (selector !== undefined && !isSafeSingleLineValue(selector)) {
      throw new Error("OpenClaw legacy-image Docker selector is malformed.");
    }
  }

  const addExitListener =
    deps.addExitListener ?? ((listener: () => void) => process.once("exit", listener));
  const removeExitListener =
    deps.removeExitListener ?? ((listener: () => void) => process.removeListener("exit", listener));

  if (explicitDockerHost === undefined && explicitDockerContext === undefined) {
    const contextOptions: SpawnSyncOptions = Object.freeze({
      cwd: deps.cwd,
      encoding: "utf-8",
      env: Object.freeze({ ...dockerEnv }),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"] as SpawnSyncOptions["stdio"],
      timeout: DOCKER_IDENTITY_TIMEOUT_MS,
    });
    let contextResult: ReturnType<typeof dockerSpawnSync>;
    try {
      contextResult = runDocker(["context", "show"], contextOptions);
    } catch {
      throw new Error("OpenClaw legacy-image Docker context could not be captured.");
    }
    const context = commandSucceeded(contextResult)
      ? normalizeDockerOutput(contextResult.stdout)
      : "";
    if (!isSafeSingleLineValue(context)) {
      throw new Error("OpenClaw legacy-image Docker context could not be captured.");
    }
    dockerEnv.DOCKER_CONTEXT = context;
  }

  const frozenDockerEnv = Object.freeze({ ...dockerEnv });
  const dockerOptions: Readonly<SpawnSyncOptions> = Object.freeze({
    cwd: deps.cwd,
    encoding: "utf-8",
    env: frozenDockerEnv,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"] as SpawnSyncOptions["stdio"],
    timeout: DOCKER_IDENTITY_TIMEOUT_MS,
  });
  const internal: InternalBinding = Object.freeze({
    dockerOptions,
    runDocker,
    addExitListener,
    removeExitListener,
  });
  const engineId = runDockerCapture(internal, ["info", "--format", "{{.ID}}"]);
  if (engineId === null || !isSafeSingleLineValue(engineId)) {
    throw new Error("OpenClaw legacy-image Docker engine identity could not be captured.");
  }

  const binding = Object.freeze({
    dockerEnv: frozenDockerEnv,
    engineId,
  });
  internalBindings.set(binding, internal);
  return binding;
}

/** Resolve a mutable tag to one directly inspectable immutable ID on the bound engine. */
export function inspectOpenClawLegacyImageId(
  binding: OpenClawLegacyDockerBinding,
  imageRef: string,
): string {
  const internal = requireInternalBinding(binding);
  const validatedImageRef = validateMutableImageRef(imageRef);
  if (!currentEngineMatches(binding, internal)) {
    throw new Error("OpenClaw legacy-image Docker engine identity changed.");
  }
  const imageId = inspectImageId(internal, validatedImageRef);
  if (imageId === null || inspectImageId(internal, imageId) !== imageId) {
    throw new Error("OpenClaw legacy-image identity could not be verified.");
  }
  return imageId;
}

/**
 * Remove an unleased preflight image only when the bound engine, mutable tag,
 * and directly addressed immutable ID still agree.
 */
export function disposeOpenClawLegacyDockerImage(
  binding: OpenClawLegacyDockerBinding,
  imageRef: string,
  imageId?: string,
): boolean {
  const internal = requireInternalBinding(binding);
  let validatedImageRef: string;
  let expectedImageId: string;
  try {
    validatedImageRef = validateMutableImageRef(imageRef);
    if (imageId === undefined) return false;
    expectedImageId = validateImageId(imageId);
  } catch {
    return false;
  }
  if (!currentEngineMatches(binding, internal)) return false;
  const taggedImageId = inspectImageId(internal, validatedImageRef);
  if (taggedImageId !== expectedImageId) return false;
  if (inspectImageId(internal, expectedImageId) !== expectedImageId) return false;

  try {
    const result = internal.runDocker(["rmi", expectedImageId], internal.dockerOptions);
    return commandSucceeded(result);
  } catch {
    return false;
  }
}

/**
 * Remove only the expected immutable image from the bound engine.
 *
 * A retained lease can outlive its mutable tag. Cleanup therefore proves the
 * engine and direct immutable ID without consulting or removing whatever the
 * tag may reference now.
 */
function disposeRetainedOpenClawLegacyDockerImage(
  binding: OpenClawLegacyDockerBinding,
  internal: InternalBinding,
  imageId: string,
): boolean {
  if (!currentEngineMatches(binding, internal)) return false;
  if (inspectImageId(internal, imageId) !== imageId) return false;

  try {
    const result = internal.runDocker(["rmi", imageId], internal.dockerOptions);
    return commandSucceeded(result);
  } catch {
    return false;
  }
}

/**
 * Create a retained-image lease after proving the tag and immutable ID still
 * resolve on the exact Docker engine that built them.
 */
export function createPreparedOpenClawLegacyImage(
  binding: OpenClawLegacyDockerBinding,
  imageRef: string,
  imageId: string,
): PreparedOpenClawLegacyImage {
  const internal = requireInternalBinding(binding);
  const validatedImageRef = validateMutableImageRef(imageRef);
  const validatedImageId = validateImageId(imageId);
  if (!verifyImageIdentity(binding, internal, validatedImageRef, validatedImageId)) {
    throw new Error("OpenClaw legacy-image identity changed before lease creation.");
  }

  let state: "prepared" | "retained" | "finalized" | "disposed" = "prepared";
  let verifiedForCreate = false;
  let exitListenerRegistered = false;
  let lease: PreparedOpenClawLegacyImage;

  const removeExitListener = (): void => {
    if (!exitListenerRegistered) return;
    internal.removeExitListener(exitListener);
    exitListenerRegistered = false;
  };
  const exitListener = (): void => {
    lease.abort();
  };
  const abortLease = (): boolean => {
    if (state === "finalized" || state === "disposed") {
      removeExitListener();
      return true;
    }
    const removed =
      state === "retained"
        ? disposeRetainedOpenClawLegacyDockerImage(binding, internal, validatedImageId)
        : disposeOpenClawLegacyDockerImage(binding, validatedImageRef, validatedImageId);
    if (!removed) return false;
    state = "disposed";
    removeExitListener();
    return true;
  };

  lease = Object.freeze({
    dockerEnv: binding.dockerEnv,
    engineId: binding.engineId,
    imageRef: validatedImageRef,
    imageId: validatedImageId,
    verify(this: PreparedOpenClawLegacyImage): boolean {
      return (
        this === lease &&
        state === "prepared" &&
        verifyImageIdentity(binding, internal, validatedImageRef, validatedImageId)
      );
    },
    retainForRecreate(this: PreparedOpenClawLegacyImage): boolean {
      if (this !== lease || state !== "prepared") return false;
      if (!verifyImageIdentity(binding, internal, validatedImageRef, validatedImageId))
        return false;
      state = "retained";
      return true;
    },
    verifyForCreate(this: PreparedOpenClawLegacyImage): boolean {
      if (this !== lease || state !== "retained") return false;
      verifiedForCreate = verifyImageIdentity(
        binding,
        internal,
        validatedImageRef,
        validatedImageId,
      );
      return verifiedForCreate;
    },
    finalizeAfterCreate(
      this: PreparedOpenClawLegacyImage,
    ): PreparedOpenClawLegacyImageFinalization | null {
      if (this !== lease || state !== "retained" || !verifiedForCreate) return null;
      if (!currentEngineMatches(binding, internal)) return null;
      if (inspectImageId(internal, validatedImageId) !== validatedImageId) return null;
      const mutableTagVerified = inspectImageId(internal, validatedImageRef) === validatedImageId;

      // The registry does not persist the bound Docker selector and engine ID.
      // A later ambient context could therefore redirect tag-based deletion.
      // Keep the unique tag for maintenance GC, but do not register it for
      // per-sandbox cleanup.
      const finalization: PreparedOpenClawLegacyImageFinalization = Object.freeze({
        registryImageRef: null,
        mutableTagVerified,
      });
      state = "finalized";
      removeExitListener();
      return finalization;
    },
    abort(this: PreparedOpenClawLegacyImage): boolean {
      if (this !== lease) return false;
      return abortLease();
    },
    dispose(this: PreparedOpenClawLegacyImage): boolean {
      if (this !== lease) return false;
      return abortLease();
    },
  });

  internal.addExitListener(exitListener);
  exitListenerRegistered = true;
  return lease;
}
