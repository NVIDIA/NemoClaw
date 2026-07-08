// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const PR_HEAD_COMMIT_PROSE_GUIDANCE = [
  "Human-facing commit terminology: call the commit identified by `headSha` the PR head commit.",
  'Say "current PR head commit" only when freshness matters and "same PR head commit" when comparing evidence.',
  'Use "full commit SHA" only when the identifier format matters.',
  'Do not use "exact head", "exact-head", "exact SHA", or "exact-SHA".',
  "Keep `headSha` and `head_sha` unchanged in machine-readable fields.",
].join(" ");
