# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Apply NemoClaw model selection to the verified Fabric Pi adapter.

Upstream: NVIDIA/NeMo-Fabric 6e155bfbe9e740fb8ce1e1fda900d96f1435a23c,
Apache-2.0. 2026-09-15: resolve declared models through Pi's native loader,
retain cleanup on failure and shutdown, and add a matching inference probe.
2026-09-17: load declared model choices with separate credential namespaces and
switch the native session model for explicit Fabric invocation selections.
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
        """    const { modelRuntime, model, models, cleanup } = await loadConfiguredModel(selected, credentials, input.config.models);
    try {
      for (const [alias, native] of Object.entries(models)) {
        const config = input.config.models?.[alias] ?? selected;
        const key = config.api_key_env ? credentialValue(input, config.api_key_env) : undefined;
        if (!key) throw new LifecycleError("pi_credential_missing", "A configured Pi model credential is unavailable");
        await modelRuntime.setRuntimeApiKey(native.provider, key);
      }
    } catch (error) { await cleanup(); throw error; }""",
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
    text = text.replace(
        "    return handle;",
        """    return Object.assign(handle, {
      selectModel: async (name: string) => {
        const choice = models[`route_${name}`];
        if (!choice) throw new LifecycleError("pi_model_unknown", "The requested Pi model choice is not declared");
        await session.setModel(choice);
      },
    });""",
    )
    runtime_path = directory / "runtime.ts"
    runtime = runtime_path.read_text().replace(
        "  prompt(text: string): Promise<PiPromptOutcome>;",
        "  prompt(text: string): Promise<PiPromptOutcome>;\n  selectModel?(name: string): Promise<void>;",
    )
    old_input = """    if (typeof request.input !== "string") {
      return failed("pi_unsupported_input", "The Pi adapter accepts only plain-text input");
    }

    const outcome = await this.session.prompt(request.input);"""
    new_input = """    let prompt = request.input;
    if (typeof prompt === "object" && prompt !== null && !Array.isArray(prompt)
        && Object.keys(prompt).length === 2 && typeof prompt.prompt === "string"
        && typeof prompt.model === "string" && this.session.selectModel) {
      try { await this.session.selectModel(prompt.model); }
      catch { return failed("pi_model_selection_failed", "The requested Pi model choice could not be selected"); }
      prompt = prompt.prompt;
    }
    if (typeof prompt !== "string") {
      return failed("pi_unsupported_input", "Pi requires text or an object containing prompt and model");
    }
    const outcome = await this.session.prompt(prompt);"""
    if runtime.count(old_input) != 1:
        raise ValueError("pinned Pi invocation source changed")
    runtime_path.write_text(
        "// NemoClaw modification, 2026-09-17: explicit model selection. See NEMOCLAW-MODIFICATIONS.md.\n"
        + runtime.replace(old_input, new_input)
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
