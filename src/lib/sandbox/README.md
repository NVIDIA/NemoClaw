<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sandbox support

`src/lib/sandbox` is for sandbox configuration, build context, create-stream, version, and channel support that is not already owned by an action/domain module.

Suggested homes:

```text
config.ts                 sandbox config download/upload and mutation support
build-context.ts          sandbox build context construction
create-stream.ts          sandbox create progress parsing
version.ts                sandbox/agent version helpers
channels.ts               sandbox channel support, unless moved to messaging
```

Command workflows should continue to live under `src/lib/actions/sandbox/**`. Pure validation/classification helpers should live under `src/lib/domain/sandbox/**`.
