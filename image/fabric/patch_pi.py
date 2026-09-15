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
    old = '''    const catalogModel = modelRuntime.getModel(selected.provider, selected.model);
    if (catalogModel === undefined) {
      throw new LifecycleError("pi_model_unknown", "The selected provider and model are not present in Pi's catalog");
    }
    const model = selected.base_url ? { ...catalogModel, baseUrl: selected.base_url } : catalogModel;'''
    if text.count(old) != 1:
        raise ValueError('pinned Pi model-selection source changed')
    text = text.replace('import { realpath', 'import { resolveConfiguredModel } from "./pi-model.js";\n\nimport { realpath').replace(old,
        '    const model = resolveConfiguredModel(selected, modelRuntime.getModel(selected.provider, selected.model));\n'
        '    modelRuntime.registerProvider(selected.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });')
    path.write_text(text)
    for name in ('pi-model.ts', 'pi-probe.ts'):
        shutil.copyfile(Path(__file__).with_name(name), directory / name)

    descriptor = source / 'adapters/typescript/pi/pi.fabric-adapter.json'
    value = json.loads(descriptor.read_text())
    value['model_schema']['properties']['settings'] = {
        'type': 'object', 'additionalProperties': False,
        'required': ['model_metadata'], 'properties': {'model_metadata': {
            'type': 'object', 'additionalProperties': False,
            'required': ['api', 'contextTokens', 'maxOutputTokens', 'reasoning', 'input'],
            'properties': {
                'api': {'enum': ['openai-completions', 'openai-responses']},
                'contextTokens': {'type': 'integer', 'minimum': 1, 'maximum': 2147483647},
                'maxOutputTokens': {'type': 'integer', 'minimum': 1, 'maximum': 2147483647},
                'reasoning': {'type': 'boolean'},
                'input': {'type': 'array', 'minItems': 1, 'uniqueItems': True,
                          'items': {'enum': ['text', 'image']}},
            },
        }},
    }
    descriptor.write_text(json.dumps(value, indent=2) + '\n')
