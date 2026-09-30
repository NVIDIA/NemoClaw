<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Error Modifications

Upstream source: NVIDIA/NeMo-Fabric, revision `24f068c895e5cbc30286bc743498be4e5014d658`.
The modified files are `crates/fabric-python/src/lib.rs` and the Python SDK's `nemo_fabric/client.py` and `nemo_fabric/runtime.py` under `sdk/python/nemo-fabric-runtime/src/`.
Their original Apache-2.0 notices remain intact, and the unmodified upstream files remain in the retained Fabric source archive.

2026-09-29: apply `fabric-error-codes.patch` before building the Fabric runtime wheel.
The native binding adds the structured `AdapterLifecycleOperation.code` to its Python exception.
The Python start, invoke, and stop wrappers preserve that attribute when constructing `FabricRuntimeError`.
The patch does not parse exception text or change adapter execution, configuration validation, or failure-state handling.
A native regression verifies the exception attribute; NemoClaw's bridge tests exercise the public SDK and an actual owner-fixture process.

2026-09-30: preserve missing evidence from the native planner.
The binding maps `UnverifiedAdapterCapability` to the fixed code `adapter_capability_unverified`; the Python `plan` wrapper preserves it in `FabricConfigError`.
This lets the bridge distinguish missing descriptor evidence from invalid configuration without parsing exception text or changing Fabric's validation rules.
A native regression checks the exception code, and a bridge regression exercises both missing and incompatible settings schemas through the installed planner.

NemoClaw separately restricts bridge and provider diagnostics to fixed stage, code, and runtime-state vocabularies.
Raw exception messages and details remain excluded from deployment diagnostics.
The image retains this notice and patch under `/opt/nemoclaw/source/local/`, with their hashes in `/opt/nemoclaw/provenance.json`.
The wheel requirement hash binds installation to the modified wheel bytes.
See the adjacent `FABRIC-LICENSE` for the upstream license.
