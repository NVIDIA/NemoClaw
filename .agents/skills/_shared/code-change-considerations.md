<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Code Change Considerations

Use these questions while planning, implementing, and reviewing a code change. Apply them to the
current lifecycle stage; do not turn them into a separate report when the workflow already owns an
output format.

## Authority

Current code, tests, workflows, and active `AGENTS.md` files own implementation details. Derive
paths, commands, test mappings, selectors, and architecture from the current checkout rather than
recording them here.

## Questions

- What accepted outcome and current consumer require the change?
- What current code owns the behavior, and can that owner be extended directly?
- Would the change duplicate an existing structure or create another source of truth?
- What state, success, failure, and partial-failure behavior must remain coherent?
- What ordering or concurrency can change the result or bypass a guarantee?
- How do absent values, defaults, retries, recovery, and cleanup behave?
- Which alternate entry, error, cached, resumed, or compatibility paths can bypass the change?
- Can code or configuration be removed, or can an existing or native mechanism replace new code?
- What shortest stable test proves the changed behavior, including the relevant negative path?
- Does a real process, network, filesystem, container, hardware, or service boundary require deeper
  runtime or end-to-end evidence?
- Which active issues, pull requests, or recent changes overlap, conflict, or affect delivery order?
