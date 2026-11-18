<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes managed startup artifact

The Hermes image copies `managed-startup-image-runtime.bundle`. Rebuild and check it with:

```sh
node agents/hermes/build-managed-startup-runtime.ts
node agents/hermes/build-managed-startup-runtime.ts --check
```

The builder uses the shared direct-startup entrypoint and source. For the shared image-runtime
module only, it binds the filesystem import to `managed-startup-filesystem.ts`.
The adapter leaves Node's global filesystem object unchanged. Other imports use native Node APIs.
Other agents continue to use the existing reviewed shared artifact.

The adapter changes deletion only for the four fixed Hermes generated-policy and routing source
paths. If ordinary deletion returns `EACCES` or `EPERM`, it verifies the source, private parent,
numeric sandbox identity and Node executable. The parent retains either its existing private mode
or the exact shipped sandbox-owned `3770` mode. A bounded child deletes the unchanged source as
the sandbox user. Startup fails unless the child succeeds and the source is confirmed absent.
Policy installation, protected target ownership, private directory modes and container capabilities
are unchanged.

The integration tests check artifact freshness and deterministic cleanup failures. The image
workflows run `test/package-contract/onboard/hermes-policy-cleanup.test.ts` against the built
Hermes image. Its disposable, network-disabled container lacks DAC override and proves root deletion
denial and successful policy promotion followed by owner deletion for `0700` and `3770` parents.
The existing Hermes inference-switch E2E owns full rebuild and credential-preservation evidence.
