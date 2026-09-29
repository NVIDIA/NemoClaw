<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Recovery

- Missing release entry in a current-main plan: finish the candidate's documentation work and
  generate a new plan for the resulting commit. A historical plan uses only its plan-bound explicit
  exception.
- Documentation coverage shows a gap, failed checks, unapproved changes, unsupported paths, or an
  open managed docs PR: show that state. Let the maintainer proceed, create or update a docs PR, or
  stop. If documentation work changes the candidate, generate a new plan.
- Required GHCR evidence fails: check retry prerequisites, then repair and rerun only the affected
  image work with authorization. Do not replace it with the general E2E proceed decision.
- General E2E is old, incomplete, failed, or from another SHA: show it and offer focused, full, or
  proceed. Record the decision and reason in the brief.
- Candidate is no longer on `origin/main`, the previous release changed, or the version is no longer
  available: stop and generate a new plan.
- Signing or access fails: report the error and follow the shared hard-stop guidance. Do not
  improvise tag commands.
- A post-tag workflow fails: report that state and its rerun path separately. Do not move the
  already-published semver tag.
