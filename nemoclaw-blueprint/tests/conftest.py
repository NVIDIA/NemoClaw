# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Shared fixtures for nemoclaw-blueprint tests."""

import pytest


@pytest.fixture()
def sample_blueprint():
    """Return a minimal valid blueprint dict matching blueprint.yaml structure."""
    return {
        "version": "0.1.0",
        "components": {
            "sandbox": {
                "image": "ghcr.io/nvidia/openshell-community/sandboxes/openclaw:latest",
                "name": "openclaw",
                "forward_ports": [18789],
            },
            "inference": {
                "profiles": {
                    "default": {
                        "provider_type": "nvidia",
                        "provider_name": "nvidia-inference",
                        "endpoint": "https://integrate.api.nvidia.com/v1",
                        "model": "nvidia/nemotron-3-super-120b-a12b",
                    },
                    "vllm": {
                        "provider_type": "openai",
                        "provider_name": "vllm-local",
                        "endpoint": "http://localhost:8000/v1",
                        "model": "nvidia/nemotron-3-nano-30b-a3b",
                        "credential_env": "OPENAI_API_KEY",
                        "credential_default": "dummy",
                    },
                }
            },
            "policy": {
                "base": "sandboxes/openclaw/policy.yaml",
                "additions": {
                    "nim_service": {
                        "name": "nim_service",
                        "endpoints": [
                            {"host": "nim-service.local", "port": 8000, "protocol": "rest"}
                        ],
                    }
                },
            },
        },
    }
