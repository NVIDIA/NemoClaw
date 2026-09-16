# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Apply NemoClaw model selection to the verified Fabric Pi adapter.

Upstream: NVIDIA/NeMo-Fabric 6e155bfbe9e740fb8ce1e1fda900d96f1435a23c,
Apache-2.0. 2026-09-15: resolve declared models through Pi's native loader,
retain cleanup on failure and shutdown, and add a matching inference probe.
"""

import json
import shutil
from pathlib import Path


def patch_pi(source):
    directory = source / "adapters/typescript/pi/src"
    path = directory / "pi-sdk.ts"
    text = path.read_text()
    old = """    const modelRuntime = await pi.ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey(selected.provider, apiKey);
    const catalogModel = modelRuntime.getModel(selected.provider, selected.model);
    if (catalogModel === undefined) {
      throw new LifecycleError("pi_model_unknown", "The selected provider and model are not present in Pi's catalog");
    }
    const model = selected.base_url ? { ...catalogModel, baseUrl: selected.base_url } : catalogModel;"""
    if text.count(old) != 1:
        raise ValueError("pinned Pi model-selection source changed")
    text = text.replace(
        "import { realpath",
        'import { loadConfiguredModel } from "./pi-model.js";\n\nimport { realpath',
    ).replace(
        old,
        "    const { modelRuntime, model, cleanup } = await loadConfiguredModel(selected, credentials);\n"
        "    await modelRuntime.setRuntimeApiKey(selected.provider, apiKey).catch(async (error) => { await cleanup(); throw error; });",
    )
    text = text.replace(
        "      excludeTools: blocked,\n    });",
        "      excludeTools: blocked,\n    }).catch(async (error) => { await cleanup(); throw error; });",
    )
    text = text.replace(
        "    const handle = new PiSdkSessionHandle(session, state);",
        "    const handle = new PiSdkSessionHandle(session, state);\n"
        "    const stop = handle.stop.bind(handle);\n"
        "    handle.stop = async () => { try { await stop(); } finally { await cleanup(); } };",
    )
    path.write_text(
        "// NemoClaw modification, 2026-09-15: declared model selection and cleanup.\n"
        "// See NEMOCLAW-MODIFICATIONS.md beside this adapter.\n" + text
    )
    (source / "adapters/typescript/pi/NEMOCLAW-MODIFICATIONS.md").write_text(__doc__ + "\n")
    for name in ("pi-model.ts", "pi-probe.ts"):
        shutil.copyfile(Path(__file__).with_name(name), directory / name)

    descriptor = source / "adapters/typescript/pi/pi.fabric-adapter.json"
    value = json.loads(descriptor.read_text())
    value["model_schema"]["properties"]["settings"] = {
        "type": "object",
        "properties": {"model_metadata": {"type": "object"}},
    }
    descriptor.write_text(json.dumps(value, indent=2) + "\n")
