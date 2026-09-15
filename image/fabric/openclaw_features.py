# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Native integration settings owned by NemoClaw's declared configuration."""
import math
import re


def native_features(inference):
    observability = (inference or {}).get('observability')
    if observability is None:
        return {}
    otlp = observability.get('otlp') if isinstance(observability, dict) else None
    if (set(observability) != {'otlp'} or not isinstance(otlp, dict)
            or set(otlp) != {'enabled', 'endpoint', 'serviceName', 'sampleRate'}
            or otlp['enabled'] is not True
            or otlp['endpoint'] != 'http://host.openshell.internal:4318'
            or not isinstance(otlp['serviceName'], str) or len(otlp['serviceName']) > 256
            or not re.fullmatch(r'[!-~](?:[ -~]*[!-~])?', otlp['serviceName'])
            or type(otlp['sampleRate']) not in (int, float)
            or not math.isfinite(otlp['sampleRate']) or not 0 <= otlp['sampleRate'] <= 1):
        raise ValueError('invalid OpenClaw OTLP configuration')
    return {
        'diagnostics': {'enabled': True, 'otel': {
            **otlp, 'protocol': 'http/protobuf', 'traces': True, 'metrics': False, 'logs': False}},
        'plugins': {'allow': ['diagnostics-otel'], 'entries': {'diagnostics-otel': {'enabled': True}}},
    }


def features_match(actual, inference):
    expected = native_features(inference)
    if not expected:
        return True
    plugins = actual.get('plugins', {})
    return (actual.get('diagnostics') == expected['diagnostics']
            and plugins.get('enabled', True) is True
            and all(name in plugins.get('allow', []) and name not in plugins.get('deny', [])
                    and plugins.get('entries', {}).get(name) == entry
                    for name, entry in expected['plugins']['entries'].items()))
