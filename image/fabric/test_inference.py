# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import unittest

from fabric import configuration


class InferenceConfiguration(unittest.TestCase):
    def test_completion_adapters_receive_output_limit(self):
        for harness in ("deepagents", "mini-swe-agent", "remote-agent"):
            config = configuration(
                "main",
                harness,
                inference={"api": "openai-completions", "tuning": {"maxTokens": 128}},
            )
            self.assertEqual(config["models"]["default"]["max_tokens"], 128)

    def test_remote_agent_endpoint_is_not_an_unsupported_model_setting(self):
        connection = {
            "provider": "openai",
            "model": "Qwen/Qwen3-4B",
            "base_url": "http://172.30.127.1:18905/v1",
            "api_key_env": "NEMOCLAW_ANONYMOUS_API_KEY",
        }
        config = configuration(
            "assistant",
            "remote-agent",
            inference={"api": "openai-completions", "connection": connection},
        )
        self.assertEqual(config["harness"]["settings"]["base_url"], connection["base_url"])
        self.assertNotIn("base_url", config["models"]["default"])
        self.assertEqual(config["models"]["default"]["model"], connection["model"])
        self.assertEqual(config["models"]["default"]["api_key_env"], connection["api_key_env"])

    def test_openclaw_receives_api_and_tuning(self):
        options = {
            "api": "openai-responses",
            "tuning": {
                "contextWindow": 65536,
                "maxTokens": 8192,
                "reasoning": True,
                "reasoningEffort": "high",
            },
        }
        config = configuration("main", "openclaw", inference=options)
        self.assertEqual(config["harness"]["settings"]["inference"], options)

    def test_hermes_api_modes_and_placeholder_auth(self):
        for api, mode in [
            ("openai-completions", "chat_completions"),
            ("openai-responses", "codex_responses"),
            ("anthropic-messages", "anthropic_messages"),
        ]:
            options = {
                "api": api,
                "tuning": {},
                "auth": {"method": "api-key", "providerRef": "nous"},
            }
            config = configuration("main", "hermes", inference=options)
            self.assertEqual(config["harness"]["settings"]["api_mode"], mode)
            self.assertEqual(config["models"]["default"]["api_key_env"], "OPENAI_API_KEY")
            self.assertEqual(config["models"]["default"]["base_url"], "https://inference.local/v1")
            self.assertNotIn("NOUS_API_KEY", str(config))

    def test_native_endpoint_and_model_reach_fabric_and_both_harnesses(self):
        from unittest.mock import patch

        from hermes_adapter import native_configuration as hermes
        from openclaw_adapter import native_configuration as openclaw

        connection = {
            "provider": "openai",
            "model": "real-model",
            "base_url": "https://models.example.com/v1",
            "api_key_env": "NEMOCLAW_INFERENCE_HOSTED_KEY",
        }
        options = {"api": "openai-completions", "tuning": {}, "connection": connection}
        with patch.dict("os.environ", {connection["api_key_env"]: "opaque-test-placeholder"}):
            for harness in ("openclaw", "hermes", "deepagents"):
                config = configuration("main", harness, inference=options)
                self.assertEqual(config["models"]["default"], connection)
            native = openclaw("main", options)
            provider = native["models"]["providers"]["openshell"]
            self.assertEqual(provider["baseUrl"], connection["base_url"])
            self.assertEqual(provider["models"][0]["id"], "real-model")
            self.assertEqual(provider["apiKey"], "${NEMOCLAW_INFERENCE_HOSTED_KEY}")
            self.assertEqual(
                native["agents"]["defaults"]["model"]["primary"], "openshell/real-model"
            )
            native = hermes(options)
            self.assertEqual(native["model"]["default"], "real-model")
            self.assertEqual(native["model"]["base_url"], connection["base_url"])
            self.assertEqual(native["custom_providers"][0]["api_key"], "opaque-test-placeholder")

    def test_pi_uses_mutable_model_configuration_with_native_connection(self):
        connection = {
            "provider": "openai",
            "base_url": "http://172.17.0.1:11434/v1",
            "api_key_env": "NEMOCLAW_ANONYMOUS_API_KEY",
        }
        options = {"api": "openai-completions", "tuning": {}, "connection": connection}
        for model in ("first-model", "second-model"):
            config = configuration("main", "pi", {"model": model}, options)
            self.assertEqual(config["models"]["default"], {**connection, "model": model})

    def test_missing_attached_credential_fails_before_native_configuration_is_written(self):
        from unittest.mock import patch

        from hermes_adapter import native_configuration

        options = {
            "api": "openai-completions",
            "tuning": {},
            "connection": {
                "provider": "openai",
                "model": "real-model",
                "base_url": "https://models.example.com/v1",
                "api_key_env": "NEMOCLAW_INFERENCE_MISSING_KEY",
            },
        }
        with patch.dict("os.environ", {}, clear=True), self.assertRaises(ValueError):
            native_configuration(options)


class NativeInference(unittest.TestCase):
    def test_native_api_limits_and_reasoning_are_verified_without_overwriting_drift(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        import openclaw_adapter as adapter

        options = {
            "api": "anthropic-messages",
            "tuning": {
                "contextWindow": 65536,
                "maxTokens": 8192,
                "reasoning": True,
                "reasoningEffort": "high",
            },
        }
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(adapter, "ROOT", Path(directory)),
        ):
            runtime = adapter.OpenClawRuntime()
            runtime.name, runtime.home, runtime.inference = "main", Path(directory), options
            runtime.initialize_configuration()
            path = Path(directory) / "openclaw.json"
            config = json.loads(path.read_text())
            provider = config["models"]["providers"]["openshell"]
            self.assertEqual(provider["api"], "anthropic-messages")
            self.assertEqual(provider["models"][0]["maxTokens"], 8192)
            self.assertEqual(config["agents"]["defaults"]["thinkingDefault"], "high")
            self.assertTrue(adapter.configuration_matches("main", options))
            provider["models"][0]["maxTokens"] = 4096
            path.write_text(json.dumps(config))
            before = path.read_bytes()
            self.assertFalse(adapter.configuration_matches("main", options))
            with self.assertRaises(RuntimeError):
                runtime.initialize_configuration()
            self.assertEqual(path.read_bytes(), before)


class ToolDisclosure(unittest.TestCase):
    def test_native_disclosure_defaults_and_read_only_policy(self):
        from openclaw_adapter import native_configuration

        self.assertEqual(
            native_configuration("primary")["tools"]["toolSearch"],
            {"mode": "tools", "searchDefaultLimit": 8, "maxSearchLimit": 20},
        )
        for mode in ("direct", "progressive"):
            options = {
                "api": "openai-completions",
                "tuning": {},
                "agents": [
                    {"name": "primary", "tools": {"disclosure": mode}},
                ],
            }
            native = native_configuration("primary", options)
            self.assertEqual(native["tools"]["toolSearch"] is False, mode == "direct")
            self.assertNotIn("tools", native["agents"]["entries"]["primary"])
        options["agents"] = [{"name": "reader", "tools": {"allow": ["read"]}}]
        native = native_configuration("primary", options)
        self.assertEqual(native["agents"]["entries"]["reader"]["tools"], {"allow": ["read"]})

    def test_disclosure_drift_is_rejected_without_overwriting_native_state(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        import openclaw_adapter as adapter

        for mode in ("direct", "progressive"):
            options = {
                "api": "openai-completions",
                "tuning": {},
                "agents": [{"name": "primary", "tools": {"disclosure": mode}}],
            }
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.object(adapter, "ROOT", Path(directory)),
            ):
                runtime = adapter.OpenClawRuntime()
                runtime.name, runtime.home, runtime.inference = "primary", Path(directory), options
                runtime.initialize_configuration()
                path = Path(directory) / "openclaw.json"
                native = json.loads(path.read_text())
                native["tools"]["toolSearch"] = mode == "direct"
                path.write_text(json.dumps(native))
                before = path.read_bytes()
                self.assertFalse(adapter.configuration_matches("primary", options))
                with self.assertRaises(RuntimeError):
                    runtime.initialize_configuration()
                self.assertEqual(path.read_bytes(), before)


class MultipleModels(unittest.TestCase):
    def test_agent_selects_native_models_with_separate_provider_credentials(self):
        from openclaw_adapter import native_configuration

        fast = {
            "provider": "local",
            "connection": {
                "provider": "openai",
                "model": "fast-model",
                "base_url": "http://172.20.0.1:11434/v1",
                "api_key_env": "NEMOCLAW_ANONYMOUS_API_KEY",
            },
            "api": "openai-completions",
            "tuning": {"contextWindow": 8192},
        }
        smart = {
            "provider": "hosted",
            "connection": {
                "provider": "anthropic",
                "model": "smart-model",
                "base_url": "https://hosted.example/v1",
                "api_key_env": "NEMOCLAW_INFERENCE_HOSTED_KEY",
            },
            "api": "anthropic-messages",
            "tuning": {"maxTokens": 8192, "reasoningEffort": "high"},
        }
        options = {
            **smart,
            "agents": [
                {
                    "name": "researcher",
                    "inference": {"default": "smart", "models": {"smart": smart, "fast": fast}},
                },
            ],
        }
        native = native_configuration("researcher", options)
        providers = native["models"]["providers"]
        self.assertEqual(len(providers), 2)
        hosted = providers["nemoclaw_researcher_smart"]
        self.assertEqual(hosted["api"], "anthropic-messages")
        self.assertEqual(hosted["apiKey"], "${NEMOCLAW_INFERENCE_HOSTED_KEY}")
        self.assertEqual(hosted["models"][0]["id"], "smart-model")
        entries = native["agents"]["entries"]
        self.assertEqual(
            entries["researcher"]["model"]["primary"], "nemoclaw_researcher_smart/smart-model"
        )
        self.assertEqual(entries["researcher"]["thinkingDefault"], "high")
        self.assertEqual(
            entries["researcher"]["modelPolicy"]["allow"],
            ["nemoclaw_researcher_smart/smart-model", "nemoclaw_researcher_fast/fast-model"],
        )
        self.assertEqual(
            entries["researcher"]["models"]["nemoclaw_researcher_fast/fast-model"]["alias"], "fast"
        )
        self.assertNotIn("fallbacks", str(native))
        options["agents"][0]["inference"]["default"] = "missing"
        with self.assertRaises(ValueError):
            native_configuration("researcher", options)


if __name__ == "__main__":
    unittest.main()
