<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Actions

Actions orchestrate CLI workflows. They may compose domain helpers, adapters, state modules, and user-facing output, but they should stay independent of oclif command classes.

Preferred layout for migrated workflows:

```text
src/lib/actions/<area>/<verb>.ts
src/lib/actions/<area>/<verb>.test.ts
```

Examples:

```text
dns/index.ts                    # internal dns fix-coredns/setup-proxy orchestration
dev/npm-link-or-shim.ts          # prepare-time dev shim orchestration
installer/plan.ts                # deterministic installer planning
uninstall/plan.ts                # host uninstall planning
uninstall/run-plan.ts            # uninstall plan application
sandbox/*.ts                     # public sandbox workflows
```

Use `src/lib/domain/**` for pure decisions and `src/lib/adapters/**` for process/filesystem/network boundaries.
