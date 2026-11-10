// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { hermesPipeLoopPythonSource } from "./native-hermes-pipe-loop.mts";
import { hermesBrowserPipePythonSource } from "./native-hermes-browser-pipe.mts";
import { hermesBrowserIpcPythonSource } from "./native-hermes-browser-ipc.mts";

export function hermesBrowserBootstrapPythonSource() {
  return [
    "import os",
    "import sys",
    ...hermesPipeLoopPythonSource(),
    ...hermesBrowserPipePythonSource(),
    ...hermesBrowserIpcPythonSource(),
    "def _activate_native_browser():",
    "    import asyncio",
    "    from importlib.metadata import version",
    "    if sys.platform != 'win32' or sys.version_info[:3] != (3, 11, 16):",
    "        raise RuntimeError('Browser transport requires the shipping Windows Python 3.11.16')",
    "    if version('cdp-use') != '1.4.5' or version('browser-harness') != '0.1.13':",
    "        raise RuntimeError('Browser transport requires its pinned dependency versions')",
    "    port = os.environ['NEMOCLAW_HERMES_BROWSER_PIPE_PORT']",
    "    path = os.environ['NEMOCLAW_BROWSER_CDP_PATH']",
    "    endpoint = 'ws://127.0.0.1:' + port + path",
    "    if os.environ.get('BU_CDP_WS') != endpoint or os.environ.get('BU_CDP_URL'):",
    "        raise RuntimeError('Browser Harness did not select the contained Edge endpoint')",
    "    if os.environ.get('BROWSER_CDP_URL', endpoint) != endpoint:",
    "        raise RuntimeError('Browser Harness has a conflicting Edge endpoint')",
    "    _install_native_browser_pipe(port, path)",
    "    _install_native_browser_ipc(os.environ['NEMOCLAW_AGENT_SESSION_ID'])",
    "    class NativeBrowserPolicy(asyncio.DefaultEventLoopPolicy):",
    "        def new_event_loop(self): return _new_native_hermes_loop()",
    "    asyncio.set_event_loop_policy(NativeBrowserPolicy())",
    "try:",
    "    _activate_native_browser()",
    "except BaseException as error:",
    "    raise SystemExit('Hermes contained browser bootstrap failed: ' + type(error).__name__) from None",
    "",
  ].join("\n");
}
