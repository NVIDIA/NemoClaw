<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuration contract fixtures

The YAML files are inputs that tests load and modify; examples under `examples/` cover the maintained configurations.

These files are parser fixtures, not authorization to apply the embedded live deployment UIDs.
Live tests must select independent identities.

The `spark.yaml` fixture exercises the inline recipe schema.

The `container-agent-connection.yaml` fixture supplies a complete application,
sandbox, external gateway, and inference declaration. Its test checks protected
input ordering, credential-reference separation, and YAML round-trip parsing.
Reserved endpoints and invented image digests make it unsuitable for live apply.
It does not qualify a VoiceClaw image or an OpenShell service identity.
Its explicit `allowUnsupportedHealth: true` accepts only unsupported native health
for installation; it does not establish agent readiness or a successful voice turn.
