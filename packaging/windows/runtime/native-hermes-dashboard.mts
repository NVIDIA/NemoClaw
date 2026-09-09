// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The dashboard is Hermes's shipped SPA and ConPTY-backed JavaScript TUI.
// Its server and children use the same contained state and broker as the console.
export function hermesDashboardPythonSource(): string[] {
  return [
    "from pathlib import Path",
    "from hermes_cli.win_pty_bridge import WinPtyBridge",
    "if not WinPtyBridge.is_available(): raise RuntimeError('Hermes native ConPTY is unavailable')",
    "_package = Path(os.environ['NEMOCLAW_AGENT_SITE_PACKAGES']) / 'hermes_cli'",
    "if not (_package / 'tui_dist' / 'entry.js').is_file(): raise RuntimeError('The bundled Hermes TUI is missing')",
    "if not (_package / 'web_dist' / 'index.html').is_file(): raise RuntimeError('The bundled Hermes dashboard is missing')",
    "os.environ['HERMES_WEB_DIST'] = str(_package / 'web_dist')",
    "os.environ['HERMES_NODE'] = os.environ['NEMOCLAW_AGENT_NODE']",
    "os.environ['HERMES_PYTHON'] = sys.executable",
    "os.environ['HERMES_SKIP_NODE_BOOTSTRAP'] = '1'",
    "from hermes_cli.web_server import start_server",
    "start_server(host='127.0.0.1', port=0, open_browser=False, allow_public=False, initial_profile='', headless=False)",
  ];
}
