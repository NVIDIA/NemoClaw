<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Production signing boundary

Pull-request workflows build unsigned candidate packages and never receive
Windows code-signing credentials. Production publication remains blocked until
an NVIDIA-owned trusted release workflow performs the following sequence with
an approved Authenticode identity:

1. Sign and verify `openshell.exe` and `openshell-gateway.exe` before MSI
   binding.
2. Build the ARM64 MSI from those signed payloads, then sign and verify the MSI.
3. Build the Burn bundle with the signed MSI embedded.
4. Use the pinned WiX tool to detach the Burn engine, sign and verify the
   detached engine, reattach it, then sign and verify the complete setup
   executable.
5. Publish hashes and signature verification receipts beside the artifacts.

The signing implementation must execute only in a protected release context.
It must not copy certificates, private keys, tokens, or signing service
credentials into the repository, pull-request jobs, package payload, logs, or
artifacts. This PR does not create that trusted release workflow because the
repository currently has no approved NVIDIA Windows-signing integration to
reuse.
