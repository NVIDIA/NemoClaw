# Third-party components

The source in this experiment uses Apache-2.0. Dependencies retain their
respective licenses. `go.mod`, `go.sum`, and `versions.json` identify the inputs.

| Component | Role | License |
| --- | --- | --- |
| Go | Compiler and standard library | BSD-3-Clause |
| JetBrains Modern Go Guidelines | Development guidance and skill wrappers | Apache-2.0 |
| OpenTofu | Separate executable | MPL-2.0 |
| Terraform plugin framework | Provider protocol implementation | MPL-2.0 |
| OpenShell and its Go SDK | Gateway, isolation, and typed API | Apache-2.0 |
| OpenClaw | Agent image | MIT |
| Ollama | Managed inference service and live-test server | MIT |
| Moby Go client and API | Docker engine resource operations | Apache-2.0 |

Generated bundles and images are local artifacts and are not committed. A
distribution release still needs the complete transitive license inventory,
notices, corresponding-source obligations where applicable, signing, and
platform packaging. This file does not establish redistribution readiness.
