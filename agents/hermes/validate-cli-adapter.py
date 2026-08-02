#!/usr/bin/python3 -I
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Validate the NemoClaw Hermes CLI adapter against upstream parser metadata."""

import argparse
import ast
import json
import subprocess
import sys
from pathlib import Path

_ADAPTER_VERSION = 1
_ALLOWED_ARITIES = {"boolean", "optional_session", "required", "session"}
_SESSION_NAME_COALESCER = {
    "module": "hermes_cli.main",
    "function": "_coalesce_session_name_args",
    "boundary_set": "_SUBCOMMANDS",
}


def _fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def _parser_actions(parser) -> dict[str, object]:
    actions: dict[str, object] = {}
    for action in parser._actions:
        for name in action.option_strings:
            actions[name] = action
    return actions


def _validate_action(option: dict, action: object, surface: str) -> None:
    arity = option["arity"]
    nargs = getattr(action, "nargs", None)
    if arity == "boolean":
        valid = nargs == 0
    elif arity == "optional_session":
        valid = nargs == "?"
    else:
        valid = nargs is None
    if not valid:
        _fail(
            f"adapter option {option['id']} has arity {arity}, "
            f"but {surface} parser metadata differs"
        )


def _validate_session_name_coalescer(contract: dict, package_path: Path) -> None:
    coalescer = contract.get("session_name_coalescer")
    if coalescer != _SESSION_NAME_COALESCER:
        _fail("Hermes CLI adapter has an unsupported session-name coalescer")
    source_path = package_path.with_name("main.py")
    try:
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
    except (OSError, UnicodeError, SyntaxError) as exc:
        _fail(f"could not read the Hermes session-name coalescer ({exc.__class__.__name__})")
    functions = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == coalescer["function"]
    ]
    if len(functions) != 1:
        _fail("Hermes session-name coalescer function is incompatible")
    assignments = [
        node
        for node in functions[0].body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == coalescer["boundary_set"]
    ]
    if len(assignments) != 1:
        _fail("Hermes session-name coalescer boundary set is incompatible")
    try:
        boundaries = ast.literal_eval(assignments[0].value)
    except (ValueError, TypeError, SyntaxError):
        _fail("Hermes session-name coalescer boundary set is not literal")
    if (
        not isinstance(boundaries, set)
        or not boundaries
        or not all(isinstance(boundary, str) and boundary for boundary in boundaries)
    ):
        _fail("Hermes session-name coalescer boundary set is invalid")


def validate(contract_path: Path, hermes_binary: str) -> None:
    try:
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        _fail(f"could not read Hermes CLI adapter contract ({exc.__class__.__name__})")

    if contract.get("adapter_version") != _ADAPTER_VERSION:
        _fail(f"unsupported Hermes CLI adapter version: {contract.get('adapter_version')!r}")
    if contract.get("managed_commands") != ["chat"]:
        _fail("Hermes CLI adapter has unsupported managed commands")

    from hermes_cli import __file__ as upstream_package_path
    from hermes_cli import __version__ as upstream_version
    from hermes_cli._parser import PRE_ARGPARSE_INHERITED_FLAGS, build_top_level_parser

    if contract.get("upstream_cli_version") != upstream_version:
        _fail(
            "Hermes CLI adapter targets "
            f"{contract.get('upstream_cli_version')!r}, installed Hermes is {upstream_version!r}"
        )

    if not upstream_package_path:
        _fail("could not locate the installed Hermes CLI package")
    _validate_session_name_coalescer(contract, Path(upstream_package_path))

    parser, _subparsers, chat_parser = build_top_level_parser()
    surfaces = {
        "top": _parser_actions(parser),
        "chat": _parser_actions(chat_parser),
    }
    preparse = {name: takes_value for name, takes_value in PRE_ARGPARSE_INHERITED_FLAGS}

    options = contract.get("options")
    if not isinstance(options, list) or not options:
        _fail("Hermes CLI adapter options must be a non-empty list")

    option_ids: set[str] = set()
    option_names: set[str] = set()
    for option in options:
        if not isinstance(option, dict):
            _fail("Hermes CLI adapter option must be an object")
        option_id = option.get("id")
        names = option.get("names")
        arity = option.get("arity")
        option_surfaces = option.get("surfaces")
        if not isinstance(option_id, str) or not option_id:
            _fail("Hermes CLI adapter option id must be a non-empty string")
        if option_id in option_ids:
            _fail(f"duplicate Hermes CLI adapter option id: {option_id}")
        option_ids.add(option_id)
        if (
            not isinstance(names, list)
            or not names
            or not all(isinstance(name, str) for name in names)
        ):
            _fail(f"adapter option {option_id} must declare names")
        if arity not in _ALLOWED_ARITIES:
            _fail(f"adapter option {option_id} has unsupported arity: {arity!r}")
        if not isinstance(option_surfaces, list) or not option_surfaces:
            _fail(f"adapter option {option_id} must declare parser surfaces")
        for name in names:
            if name in option_names:
                _fail(f"duplicate Hermes CLI adapter option name: {name}")
            option_names.add(name)
        for surface in option_surfaces:
            if surface == "preparse":
                if arity != "required":
                    _fail(
                        f"adapter option {option_id} has arity {arity}, "
                        "but preparse parser metadata requires a value"
                    )
                missing = sorted(name for name in names if preparse.get(name) is not True)
                if missing:
                    _fail(
                        "adapter preparse option differs from upstream metadata: "
                        f"{', '.join(missing)}"
                    )
                continue
            actions = surfaces.get(surface)
            if actions is None:
                _fail(f"adapter option {option_id} has unknown parser surface: {surface!r}")
            for name in names:
                action = actions.get(name)
                if action is None:
                    _fail(f"adapter option {name} is absent from the upstream {surface} parser")
                _validate_action(option, action, surface)

    required_ids = {
        "accept_hooks",
        "continue",
        "ignore_rules",
        "ignore_user_config",
        "model",
        "no_restore_cwd",
        "oneshot",
        "profile",
        "provider",
        "resume",
        "safe_mode",
        "usage_file",
        "worktree",
        "yolo",
    }
    if not required_ids <= option_ids:
        missing = ", ".join(sorted(required_ids - option_ids))
        _fail(f"Hermes CLI adapter is missing managed options: {missing}")

    translations = contract.get("translations")
    if not isinstance(translations, dict) or set(translations) != {
        "provider_model_composition",
        "resumed_oneshot",
    }:
        _fail("Hermes CLI adapter must declare the two managed translations")
    for name, translation in translations.items():
        if not isinstance(translation, dict):
            _fail(f"adapter translation {name} must be an object")
        for field in (
            "forms",
            "issue",
            "reason",
            "removal_condition",
            "source_fix_constraint",
        ):
            if not translation.get(field):
                _fail(f"adapter translation {name} must declare {field}")

    # Help is runtime evidence that the owned public surfaces still start. Parser
    # metadata above is the compatibility authority.
    for argv in ([hermes_binary, "--help"], [hermes_binary, "chat", "--help"]):
        result = subprocess.run(argv, stdout=subprocess.DEVNULL, timeout=30, check=False)
        if result.returncode != 0:
            _fail(f"Hermes public help probe failed: {' '.join(argv[1:])}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--hermes", required=True)
    args = parser.parse_args(argv)
    validate(args.contract, args.hermes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
