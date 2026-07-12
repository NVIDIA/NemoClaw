<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Core helpers

`src/lib/core` is for tiny cross-cutting primitives with minimal dependencies. These helpers should be safe to import from actions, domain modules, adapters, and CLI infrastructure.

Good candidates:

```text
version.ts
ports.ts
json-types.ts
errno.ts
wait.ts
url-utils.ts
shell-quote.ts
```

Keep product workflows out of this directory. If a helper starts depending on Docker, OpenShell, filesystem state, or a specific command workflow, move it to an adapter, action, domain area, or feature folder instead.
