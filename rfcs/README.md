<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Requests for Comments

This directory contains design proposals for changes that affect more than one NemoClaw subsystem or establish a maintained product contract.

An RFC describes a proposed decision.
It does not document released behavior.
User-facing documentation under `docs/` remains the source of truth for implemented behavior and support claims.

## RFC status

Each RFC uses one of these states:

- **Draft** means the proposal is open for review.
- **Accepted** means maintainers approved the design direction.
- **Rejected** means maintainers chose not to pursue the proposal.
- **Withdrawn** means the authors ended the proposal.
- **Superseded** means another RFC replaced the proposal.

An accepted RFC does not make an implementation supported.
The implementation, validation evidence, platform matrix, and user documentation must land through their normal review paths.

## File names

Use a four-digit sequence followed by a short descriptive name:

```text
0001-managed-inference-serving-specifications.md
```

Do not reuse an RFC number.
Link the RFC to its GitHub discussion or issue after that public review thread exists.
