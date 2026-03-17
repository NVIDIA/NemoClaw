# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent / "_ext"))

project = "NVIDIA NemoClaw Developer Guide"
this_year = date.today().year
copyright = f"2025-{this_year}, NVIDIA Corporation"
author = "NVIDIA Corporation"
release = "latest"

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
]

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
html_extra_path = ["project.json"]
highlight_language = "console"

html_theme_options = {
    # "public_docs_features": True, # TODO: Uncomment this when the docs are public
    "icon_links": [
        {
            "name": "GitHub",
            "url": "https://github.com/NVIDIA/NemoClaw",
            "icon": "fa-brands fa-github",
            "type": "fontawesome",
        },
    ],
}

html_baseurl = "https://docs.nvidia.com/nemoclaw/latest/"
