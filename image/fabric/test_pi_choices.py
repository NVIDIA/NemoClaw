# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import unittest

from fabric import configuration


class PiChoices(unittest.TestCase):
    def test_choices_keep_their_own_connections_and_native_metadata(self):
        def choice(provider, model, endpoint, tokens):
            return {
                "provider": provider,
                "connection": {
                    "provider": "openai",
                    "base_url": endpoint,
                    "api_key_env": f"NEMOCLAW_INFERENCE_{provider.upper()}_KEY",
                },
                "api": "openai-completions",
                "tuning": {},
                "pi": {
                    "model": model,
                    "piModel": {"api": "openai-completions", "maxTokens": tokens},
                },
            }

        fast = choice("local", "fast", "https://local.example/v1", 128)
        smart = choice("oracle", "smart", "https://oracle.example/v1", 1024)
        inference = {
            **{k: v for k, v in fast.items() if k != "pi"},
            "agents": [
                {
                    "name": "main",
                    "inference": {"default": "fast", "models": {"fast": fast, "smart": smart}},
                }
            ],
        }
        config = configuration("main", "pi", fast["pi"], inference)
        self.assertEqual(config["models"]["default"], config["models"]["route_fast"])
        self.assertEqual(config["models"]["route_smart"]["model"], "smart")
        self.assertEqual(
            config["models"]["route_smart"]["api_key_env"], "NEMOCLAW_INFERENCE_ORACLE_KEY"
        )
        self.assertEqual(
            config["models"]["route_smart"]["settings"]["model_metadata"]["maxTokens"], 1024
        )
        with self.assertRaises(ValueError):
            configuration("missing", "pi", fast["pi"], inference)


if __name__ == "__main__":
    unittest.main()
