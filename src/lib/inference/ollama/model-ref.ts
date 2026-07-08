// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Normalize the implicit Ollama `latest` tag without confusing registry ports for tags. */
export function normalizeOllamaModelRef(model: string): string {
  const ref = String(model || "").trim();
  const lastSegment = ref.slice(ref.lastIndexOf("/") + 1);
  return ref && !lastSegment.includes(":") ? `${ref}:latest` : ref;
}

/** Compare model references using Ollama's implicit `latest` tag semantics. */
export function ollamaModelRefsMatch(left: string, right: string): boolean {
  return normalizeOllamaModelRef(left) === normalizeOllamaModelRef(right);
}
