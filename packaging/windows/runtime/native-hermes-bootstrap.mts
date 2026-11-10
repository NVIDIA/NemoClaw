// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { hermesPipeLoopPythonSource } from "./native-hermes-pipe-loop.mts";
import { hermesInferencePipePythonSource } from "./native-hermes-inference-pipe.mts";

export function hermesBootstrapPythonSource() {
  return [
    "import os",
    "import sys",
    ...hermesPipeLoopPythonSource(),
    "def _activate_native_hermes_child():",
    "    if 'NEMOCLAW_HERMES_INFERENCE_PIPE_PORT' not in os.environ:",
    "        return",
    "    expected = os.environ.get('HERMES_PYTHON', '')",
    "    if not expected or not os.path.isabs(expected):",
    "        raise RuntimeError('The canonical Hermes interpreter is missing')",
    "    if os.path.normcase(os.path.abspath(sys.executable)) != os.path.normcase(os.path.abspath(expected)):",
    "        return",
    "    import asyncio",
    "    class NativeHermesPolicy(asyncio.DefaultEventLoopPolicy):",
    "        def new_event_loop(self): return _new_native_hermes_loop()",
    "    asyncio.set_event_loop_policy(NativeHermesPolicy())",
    ...hermesInferencePipePythonSource()[0]
      .split("\n")
      .map((line) => "    " + line),
    "try:",
    "    _activate_native_hermes_child()",
    "except BaseException as error:",
    "    raise SystemExit('Hermes contained transport bootstrap failed: ' + type(error).__name__) from None",
    "",
  ].join("\n");
}
