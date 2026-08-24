// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry";
import { ollamaModelRefsMatch } from "./model-discovery";

/** The registry fields an Ollama GPU-release decision reads. */
export type OllamaModelHolder = Pick<SandboxEntry, "name" | "provider" | "model">;

/**
 * The Ollama model this sandbox alone is holding, or null when there is
 * nothing safe to release.
 *
 * The Ollama daemon is host-global, so unloading everything would evict a
 * model a sibling sandbox is still using. Release only this sandbox's own
 * model, and only when no other Ollama-backed sandbox is registered against
 * the same one. Peers are compared with Ollama's implicit `latest` tag
 * semantics, so a sibling recorded as `llama3` still protects `llama3:latest`.
 */
export function exclusivelyHeldOllamaModel(
  sandbox: OllamaModelHolder,
  peers: readonly OllamaModelHolder[],
): string | null {
  const model = sandbox.model?.trim();
  if (!model) return null;
  const sharedWithPeer = peers.some(
    (peer) =>
      peer.name !== sandbox.name &&
      !!peer.provider?.includes("ollama") &&
      !!peer.model &&
      ollamaModelRefsMatch(peer.model, model),
  );
  return sharedWithPeer ? null : model;
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
