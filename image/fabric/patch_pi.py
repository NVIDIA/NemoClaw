# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Apply the model-selection correction to the checksum-verified Fabric source."""
from pathlib import Path
import shutil
import json


def patch_pi(source):
    directory = source / 'adapters/typescript/pi/src'
    path = directory / 'pi-sdk.ts'
    text = path.read_text()
    old = '''    const modelRuntime = await pi.ModelRuntime.create({
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
    const model = selected.base_url ? { ...catalogModel, baseUrl: selected.base_url } : catalogModel;'''
    if text.count(old) != 1:
        raise ValueError('pinned Pi model-selection source changed')
    text = text.replace('import { realpath', 'import { loadConfiguredModel } from "./pi-model.js";\n\nimport { realpath').replace(old,
        '    const { modelRuntime, model, cleanup } = await loadConfiguredModel(selected, credentials);\n'
        '    await modelRuntime.setRuntimeApiKey(selected.provider, apiKey).catch(async (error) => { await cleanup(); throw error; });')
    text = text.replace('      excludeTools: blocked,\n    });',
        '      excludeTools: blocked,\n    }).catch(async (error) => { await cleanup(); throw error; });')
    text = text.replace('    const handle = new PiSdkSessionHandle(session, state);',
        '    const handle = new PiSdkSessionHandle(session, state);\n'
        '    const stop = handle.stop.bind(handle);\n'
        '    handle.stop = async () => { try { await stop(); } finally { await cleanup(); } };')
    path.write_text(text)
    for name in ('pi-model.ts', 'pi-probe.ts'):
        shutil.copyfile(Path(__file__).with_name(name), directory / name)

    descriptor = source / 'adapters/typescript/pi/pi.fabric-adapter.json'
    value = json.loads(descriptor.read_text())
    value['model_schema']['properties']['settings'] = {
        'type': 'object', 'properties': {'model_metadata': {'type': 'object'}},
    }
    descriptor.write_text(json.dumps(value, indent=2) + '\n')
