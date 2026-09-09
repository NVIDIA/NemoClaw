// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { SandboxEntry } from "../../state/registry";
import {
  isLocalOllamaRouteOwner,
  readLocalAdapterJsonFile,
  removeLocalAdapterFile,
  resolveSharedLocalAdapterStateRoot,
  type OllamaHostRoute,
  writeLocalAdapterJsonFile,
} from "../local-adapter-lifecycle";
import { ollamaModelRefsMatch } from "./model-discovery";

export { isLocalOllamaRouteOwner } from "../local-adapter-lifecycle";
export type { OllamaHostRoute, OllamaRouteHolder } from "../local-adapter-lifecycle";

const PENDING_CLEANUP_DIRECTORY = "ollama-pending-model-cleanup";
const SAFE_SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function pendingCleanupPath(sandboxName: string, stateRoot: string): string {
  if (!SAFE_SANDBOX_NAME.test(sandboxName)) {
    throw new Error(`Invalid sandbox name for pending Ollama cleanup: ${sandboxName}`);
  }
  return path.join(stateRoot, PENDING_CLEANUP_DIRECTORY, `${sandboxName}.json`);
}

function validPendingModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    !/[\u0000\r\n]/u.test(value)
  );
}

export function loadPendingOllamaModelCleanup(
  sandboxName: string,
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): readonly string[] {
  const record = readLocalAdapterJsonFile(pendingCleanupPath(sandboxName, stateRoot));
  return record?.schemaVersion === 1 && Array.isArray(record.models)
    ? record.models.filter(validPendingModel)
    : [];
}

export function persistPendingOllamaModelCleanup(
  sandboxName: string,
  models: readonly string[],
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): void {
  const pending = [...loadPendingOllamaModelCleanup(sandboxName, stateRoot)];
  for (const model of models) {
    const normalized = model.trim();
    if (!validPendingModel(normalized)) continue;
    if (!pending.some((existing) => ollamaModelRefsMatch(existing, normalized))) {
      pending.push(normalized);
    }
  }
  if (pending.length === 0) return;
  writeLocalAdapterJsonFile(pendingCleanupPath(sandboxName, stateRoot), {
    schemaVersion: 1,
    sandboxName,
    models: pending,
  });
}

export function clearPendingOllamaModelCleanup(
  sandboxName: string,
  releasedModels?: readonly string[],
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): void {
  const receiptPath = pendingCleanupPath(sandboxName, stateRoot);
  if (!releasedModels) {
    removeLocalAdapterFile(receiptPath);
    return;
  }
  const remaining = loadPendingOllamaModelCleanup(sandboxName, stateRoot).filter(
    (pending) => !releasedModels.some((released) => ollamaModelRefsMatch(pending, released)),
  );
  if (remaining.length === 0) {
    removeLocalAdapterFile(receiptPath);
    return;
  }
  writeLocalAdapterJsonFile(receiptPath, {
    schemaVersion: 1,
    sandboxName,
    models: remaining,
  });
}

/** The registry fields an Ollama GPU-release decision reads. */
export type OllamaModelHolder = Pick<SandboxEntry, "name" | "provider" | "model" | "endpointUrl">;

export type OllamaModelRoute = Pick<SandboxEntry, "provider" | "model" | "endpointUrl">;

export type OllamaModelOwnershipDecision =
  | { readonly kind: "missing-model" }
  | {
      readonly kind: "exclusive";
      readonly model: string;
      readonly stalePeers: readonly string[];
    }
  | {
      readonly kind: "shared-active";
      readonly model: string;
      readonly activePeers: readonly string[];
      readonly stalePeers: readonly string[];
    };

/**
 * Decide whether this sandbox's Ollama model has another active owner.
 *
 * Registry rows persist after a sandbox stops and can also contain incomplete
 * onboarding reservations. Callers must supply the sandbox names that a live
 * runtime probe found in Ready or Running phase. A matching registry row that
 * is not in that set is evidence to report, not an owner that blocks release.
 */
export function matchingOllamaModelPeers<T extends OllamaModelHolder>(
  sandbox: OllamaModelHolder,
  peers: readonly T[],
  selectedHost: OllamaHostRoute | null = null,
): T[] {
  const model = sandbox.model?.trim();
  if (!model) return [];
  return peers.filter(
    (peer) =>
      peer.name !== sandbox.name &&
      isLocalOllamaRouteOwner(peer, selectedHost) &&
      !!peer.model &&
      ollamaModelRefsMatch(peer.model, model),
  );
}

export function decideOllamaModelOwnership(
  sandbox: OllamaModelHolder,
  peers: readonly OllamaModelHolder[],
  activeSandboxNames: ReadonlySet<string>,
  selectedHost: OllamaHostRoute | null = null,
): OllamaModelOwnershipDecision {
  const model = sandbox.model?.trim();
  if (!model) return { kind: "missing-model" };

  const matchingPeers = matchingOllamaModelPeers(sandbox, peers, selectedHost);
  const activePeers = matchingPeers
    .filter((peer) => activeSandboxNames.has(peer.name))
    .map((peer) => peer.name)
    .sort();
  const stalePeers = matchingPeers
    .filter((peer) => !activeSandboxNames.has(peer.name))
    .map((peer) => peer.name)
    .sort();

  return activePeers.length > 0
    ? { kind: "shared-active", model, activePeers, stalePeers }
    : { kind: "exclusive", model, stalePeers };
}

/**
 * Conservative compatibility helper for callers that do not probe live state.
 * Every matching registry peer remains protected on those paths.
 */
export function exclusivelyHeldOllamaModel(
  sandbox: OllamaModelHolder,
  peers: readonly OllamaModelHolder[],
  selectedHost: OllamaHostRoute | null = null,
): string | null {
  const decision = decideOllamaModelOwnership(
    sandbox,
    peers,
    new Set(peers.map((peer) => peer.name)),
    selectedHost,
  );
  return decision.kind === "exclusive" ? decision.model : null;
}

/**
 * The Ollama model a re-onboard just superseded, or null when nothing is safe
 * to release (#9110).
 *
 * The decision is keyed on the model reference, never on the provider name. A
 * provider switch that keeps the same model can still be served by the same
 * host daemon — an operator may move an `ollama-local` sandbox onto a
 * `compatible-endpoint` route pointed back at `http://127.0.0.1:11434/v1`.
 * Releasing there would evict the model the new route was just proven against.
 * Comparing model refs is strictly conservative: it can only miss a release,
 * never evict a model the new route still uses.
 */
export function supersededOllamaModel(
  previous: OllamaModelHolder | null,
  next: OllamaModelRoute,
  peers: readonly OllamaModelHolder[],
  selectedHost: OllamaHostRoute | null = null,
): string | null {
  if (!previous || !isLocalOllamaRouteOwner(previous, selectedHost)) return null;
  const nextModel = next.model?.trim();
  if (!nextModel) return null;
  const held = exclusivelyHeldOllamaModel(previous, peers, selectedHost);
  if (!held) return null;
  return isLocalOllamaRouteOwner(next, selectedHost) && ollamaModelRefsMatch(held, nextModel)
    ? null
    : held;
}
