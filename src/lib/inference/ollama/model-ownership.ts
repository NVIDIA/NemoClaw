// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry";
import { ollamaModelRefsMatch } from "./model-discovery";

/** The registry fields an Ollama GPU-release decision reads. */
export type OllamaModelHolder = Pick<SandboxEntry, "name" | "provider" | "model">;

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
): T[] {
  const model = sandbox.model?.trim();
  if (!model) return [];
  return peers.filter(
    (peer) =>
      peer.name !== sandbox.name &&
      !!peer.provider?.includes("ollama") &&
      !!peer.model &&
      ollamaModelRefsMatch(peer.model, model),
  );
}

export function decideOllamaModelOwnership(
  sandbox: OllamaModelHolder,
  peers: readonly OllamaModelHolder[],
  activeSandboxNames: ReadonlySet<string>,
): OllamaModelOwnershipDecision {
  const model = sandbox.model?.trim();
  if (!model) return { kind: "missing-model" };

  const matchingPeers = matchingOllamaModelPeers(sandbox, peers);
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
): string | null {
  const decision = decideOllamaModelOwnership(
    sandbox,
    peers,
    new Set(peers.map((peer) => peer.name)),
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
  nextModel: string,
  peers: readonly OllamaModelHolder[],
): string | null {
  if (!previous?.provider?.includes("ollama")) return null;
  const next = nextModel?.trim();
  if (!next) return null;
  const held = exclusivelyHeldOllamaModel(previous, peers);
  if (!held) return null;
  return ollamaModelRefsMatch(held, next) ? null : held;
}
