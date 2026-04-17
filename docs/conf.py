# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent / "_ext"))

project = "NVIDIA NemoClaw Developer Guide"
this_year = date.today().year
copyright = f"{this_year}, NVIDIA Corporation"
author = "NVIDIA Corporation"

# Read the preferred version from versions1.json so the version switcher
# can match it.  versions1.json is the source of truth for the switcher
# dropdown; reading from it keeps conf.py in sync automatically.
_versions = json.loads((Path(__file__).parent / "versions1.json").read_text())
_preferred = [v["version"] for v in _versions if v.get("preferred")]
assert len(_preferred) == 1, (
    f"docs/versions1.json must have exactly one entry with preferred: true; found {len(_preferred)}"
)
release = _preferred[0]


extensions = [
    "myst_parser",
    "sphinx.ext.autodoc",
    "sphinx.ext.autosummary",
    "sphinx.ext.napoleon",
    "sphinx.ext.viewcode",
    "sphinx.ext.intersphinx",
    "sphinx_copybutton",
    "sphinx_design",
    "sphinxcontrib.mermaid",
    "json_output",
    "search_assets",
    "sphinx_reredirects",
]

redirects = {
    "reference/inference-profiles": "../inference/inference-options.html",
}

autodoc_default_options = {
    "members": True,
    "undoc-members": False,
    "show-inheritance": True,
    "member-order": "bysource",
}
autodoc_typehints = "description"
autodoc_class_signature = "separated"

copybutton_exclude = ".linenos, .gp, .go"

exclude_patterns = [
    "README.md",
    "SETUP.md",
    "CONTRIBUTING.md",
    "_build/**",
    "_ext/**",
]

suppress_warnings = ["myst.header"]

myst_linkify_fuzzy_links = False
myst_heading_anchors = 4
myst_enable_extensions = [
    "colon_fence",
    "deflist",
    "dollarmath",
    "fieldlist",
    "substitution",
]
myst_links_external_new_tab = True

myst_substitutions = {
    "version": release,
}

templates_path = ["_templates"]

html_theme = "nvidia_sphinx_theme"
html_copy_source = False
html_show_sourcelink = False
html_show_sphinx = False

mermaid_init_js = (
    "mermaid.initialize({"
    "  startOnLoad: true,"
    "  theme: 'base',"
    "  themeVariables: {"
    "    background: '#ffffff',"
    "    primaryColor: '#76b900',"
    "    primaryTextColor: '#000000',"
    "    primaryBorderColor: '#000000',"
    "    lineColor: '#000000',"
    "    textColor: '#000000',"
    "    mainBkg: '#ffffff',"
    "    nodeBorder: '#000000'"
    "  }"
    "});"
)

html_domain_indices = False
html_use_index = False
html_extra_path = ["project.json", "versions1.json"]
highlight_language = "console"

html_theme_options = {
    # "public_docs_features": True, # TODO: Uncomment this when the docs are public
    "announcement": (
        "&#x1F514; NVIDIA NemoClaw is <strong>alpha software</strong>. APIs and behavior"
        " may change without notice. Do not use in production."
    ),
    "switcher": {
        "json_url": "../versions1.json",
        "version_match": release,
    },
    "icon_links": [
        {
            "name": "NemoClaw GitHub",
            "url": "https://github.com/NVIDIA/NemoClaw",
            "icon": "fa-brands fa-github",
            "type": "fontawesome",
        },
        {
            "name": "NemoClaw Discord",
            "url": "https://discord.gg/XFpfPv9Uvx",
            "icon": "fa-brands fa-discord",
            "type": "fontawesome",
        },
    ],
}

html_baseurl = "https://docs.nvidia.com/nemoclaw/latest/"

# Keep project.json in sync with the resolved release version so the
# static copy served alongside the docs always reports the correct version.
# Write only when the contents change so sphinx-autobuild does not detect
# a self-induced source change and rebuild in an infinite loop.
_project_json = Path(__file__).parent / "project.json"
_project_json_contents = json.dumps({"name": "nemoclaw", "version": release}) + "\n"
if not _project_json.exists() or _project_json.read_text() != _project_json_contents:
    _project_json.write_text(_project_json_contents)
