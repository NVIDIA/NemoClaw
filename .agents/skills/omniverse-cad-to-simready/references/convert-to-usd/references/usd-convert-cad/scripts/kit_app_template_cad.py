# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import shlex
import subprocess
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "shared"))

from script_utils import check_result as _check


SKILL = "usd-convert-cad"
NEXT_STEP = "validate-usd-minimum"
KIT_APP_TEMPLATE_URL = "https://github.com/NVIDIA-Omniverse/kit-app-template"
KIT_APP_TEMPLATE_DOCS_URL = "https://docs.omniverse.nvidia.com/kit/docs/kit-app-template/latest/"
CAD_CONVERTER_DOCS_URL = "https://docs.omniverse.nvidia.com/kit/docs/omni.kit.converter.cad/latest/"
CAD_CONVERTER_SERVICE_DOCS_URL = "https://docs.omniverse.nvidia.com/kit/docs/omni.services.convert.cad/latest/Usage.html"
DEFAULT_KIT_APP_TEMPLATE_ROOT = Path("~/.kit-app-template")
KIT_CAD_CONVERTER_TOOL = "NVIDIA Kit App Template CAD Converter"
KIT_INSTALL_HINT = (
    "Clone https://github.com/NVIDIA-Omniverse/kit-app-template to $HOME/.kit-app-template, "
    "add the required CAD Converter extension to the app dependencies, then run "
    "`./repo.sh template new` and `./repo.sh build --config release`. Set "
    "KIT_APP_TEMPLATE_ROOT, KIT_APP_TEMPLATE_BUILD_DIR, or KIT_APP_TEMPLATE_KIT_EXECUTABLE "
    "when using a non-default location."
)
USD_OUTPUT_SUFFIXES = {".usd", ".usda", ".usdc", ".usdz"}
CAD_CORE_BY_SUFFIX = {
    ".dgn": "dgn",
    ".jt": "jt",
}
CAD_CORE_EXTENSION = {
    "dgn": "omni.kit.converter.dgn_core",
    "hoops": "omni.kit.converter.hoops_core",
    "jt": "omni.kit.converter.jt_core",
}
CAD_PROCESS_SCRIPT = {
    "dgn": "dgn_main.py",
    "hoops": "hoops_main.py",
    "jt": "jt_main.py",
}
CAD_CORE_MODULE = {
    "dgn": "omni.kit.converter.dgn_core",
    "hoops": "omni.kit.converter.hoops_core",
    "jt": "omni.kit.converter.jt_core",
}
FINE_TESSELLATION_CHORD = 0.001
FINE_TESSELLATION_ANGLE = 10.0
COARSE_TESSELLATION_CHORD = 0.1
COARSE_TESSELLATION_ANGLE = 45.0


def is_arm64_host() -> bool:
    return platform.machine().lower() in {"aarch64", "arm64"}


def real_suffix(source_asset: Path) -> str:
    suffix = source_asset.suffix.lower()
    if suffix.lstrip(".").isdigit():
        return Path(source_asset.stem).suffix.lower()
    return suffix


def kit_supports_source(source_asset: Path) -> bool:
    return True


def discover_generated_files(output_directory: Path) -> list[str]:
    if not output_directory.exists():
        return []
    return sorted(
        str(path.relative_to(output_directory))
        for path in output_directory.rglob("*")
        if path.is_file()
    )


def _compact(value: str, limit: int = 4000) -> str:
    value = value.strip()
    if len(value) <= limit:
        return value
    return value[:limit] + "\n... truncated ..."


def _host_platform() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if machine in {"amd64", "x86_64"}:
        arch = "x86_64"
    elif machine in {"arm64", "aarch64"}:
        arch = "aarch64"
    else:
        arch = machine
    if system == "windows":
        return f"windows-{arch}"
    if system == "linux":
        return f"linux-{arch}"
    return f"{system}-{arch}"


def _resolve_path(value: str | Path | None, env_name: str) -> Path | None:
    if value:
        return Path(value).expanduser().resolve()
    env_value = os.getenv(env_name)
    if env_value:
        return Path(env_value).expanduser().resolve()
    return None


def _resolve_kit_root(kit_app_template_root: Path | None) -> Path:
    explicit = _resolve_path(kit_app_template_root, "KIT_APP_TEMPLATE_ROOT")
    if explicit is not None:
        return explicit
    return DEFAULT_KIT_APP_TEMPLATE_ROOT.expanduser().resolve()


def _resolve_build_dir(kit_build_dir: Path | None, kit_root: Path | None) -> Path | None:
    explicit = _resolve_path(kit_build_dir, "KIT_APP_TEMPLATE_BUILD_DIR")
    if explicit is not None:
        return explicit
    if kit_root is not None:
        return (kit_root / "_build" / _host_platform() / "release").resolve()
    return None


def _resolve_kit_executable(kit_executable: Path | None, kit_build_dir: Path | None) -> Path | None:
    explicit = _resolve_path(kit_executable, "KIT_APP_TEMPLATE_KIT_EXECUTABLE")
    if explicit is not None:
        return explicit
    explicit = _resolve_path(None, "KIT_EXECUTABLE")
    if explicit is not None:
        return explicit
    if kit_build_dir is None:
        return None
    name = "kit.exe" if platform.system().lower() == "windows" else "kit"
    return (kit_build_dir / "kit" / name).resolve()


def _resolve_service_extension_dir(
    cad_service_extension_dir: Path | None,
    kit_build_dir: Path | None,
) -> Path | None:
    explicit = _resolve_path(cad_service_extension_dir, "KIT_CAD_SERVICE_EXTENSION_DIR")
    if explicit is not None:
        return explicit
    if kit_build_dir is None:
        return None
    extension_cache = kit_build_dir / "extscache"
    if not extension_cache.exists():
        return None
    candidates = sorted(
        extension_cache.glob("omni.services.convert.cad-*"),
        key=lambda path: path.stat().st_mtime if path.exists() else 0,
        reverse=True,
    )
    return candidates[0].resolve() if candidates else None


def _cad_core_for_source(source_asset: Path) -> str:
    return CAD_CORE_BY_SUFFIX.get(real_suffix(source_asset), "hoops")


def _process_script_path(service_extension_dir: Path | None, cad_core: str) -> Path | None:
    if service_extension_dir is None:
        return None
    return (
        service_extension_dir
        / "omni"
        / "services"
        / "convert"
        / "cad"
        / "services"
        / "process"
        / CAD_PROCESS_SCRIPT[cad_core]
    ).resolve()


def _quality_options(
    *,
    fine: bool,
    coarse: bool,
    tessellation_chord: float,
    tessellation_angle: float,
) -> tuple[float, float]:
    if fine:
        return FINE_TESSELLATION_CHORD, FINE_TESSELLATION_ANGLE
    if coarse:
        return COARSE_TESSELLATION_CHORD, COARSE_TESSELLATION_ANGLE
    return tessellation_chord, tessellation_angle


def _write_converter_config(
    output_directory: Path,
    source_asset: Path,
    *,
    fine: bool,
    coarse: bool,
    tessellation_chord: float,
    tessellation_angle: float,
    no_materials: bool,
    single_mesh: bool,
    no_meter_units: bool,
    keep_hidden: bool,
) -> Path:
    chord, angle = _quality_options(
        fine=fine,
        coarse=coarse,
        tessellation_chord=tessellation_chord,
        tessellation_angle=tessellation_angle,
    )
    options = {
        "instancing": True,
        "bOptimize": True,
        "convertHidden": keep_hidden,
        "dMetersPerUnit": 0.0 if no_meter_units else 1.0,
        "iUpAxis": 2,
        "dChordHeight": chord,
        "dAngleTolerance": angle,
        "importMaterials": not no_materials,
        "singleMesh": single_mesh,
    }
    config_path = output_directory / f"{source_asset.stem}_cad_converter_options.json"
    config_path.write_text(json.dumps(options, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return config_path


def _write_core_runner_script(output_directory: Path, source_asset: Path) -> Path:
    runner_path = output_directory / f"{source_asset.stem}_kit_cad_core_runner.py"
    runner_path.write_text(
        """from __future__ import annotations

import argparse
import asyncio
import importlib
import inspect
import json
from pathlib import Path
import sys
import time


def _string_options(options: dict) -> dict[str, str]:
    result = {}
    for key, value in options.items():
        if isinstance(value, bool):
            result[key] = "true" if value else "false"
        else:
            result[key] = str(value)
    return result


def _run_async(awaitable):
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(awaitable)


def _status_code(status):
    for name in ("error_code", "code", "status", "result"):
        if hasattr(status, name):
            return getattr(status, name)
    if isinstance(status, (tuple, list)) and status:
        return status[0]
    return None


def _status_text(status) -> str:
    for name in ("error_message", "message", "details"):
        if hasattr(status, name):
            return str(getattr(status, name))
    if isinstance(status, (tuple, list)) and len(status) >= 2:
        return str(status[1])
    return str(status)


def _result_success_and_message(result) -> tuple[bool, str]:
    if isinstance(result, tuple) and len(result) >= 2:
        primary, secondary = result[0], result[1]
        if isinstance(primary, bool):
            success = primary
        elif isinstance(primary, int):
            success = primary == 0
        elif isinstance(primary, str):
            success = bool(primary)
        else:
            success = bool(primary)

        if not isinstance(secondary, str):
            code = _status_code(secondary)
            if isinstance(code, bool):
                success = success and code
            elif isinstance(code, int):
                success = success and code == 0
        return bool(success), _status_text(secondary)
    return bool(result), str(result)


def _wait_for_instance(module):
    converter = module.get_instance()
    if converter is not None:
        return converter
    try:
        import omni.kit.app

        app = omni.kit.app.get_app()
    except Exception:
        app = None
    for _ in range(60):
        if app is not None:
            app.update()
        time.sleep(0.5)
        converter = module.get_instance()
        if converter is not None:
            return converter
    return None


def _convert_with_core_instance(module_name: str, input_path: Path, output_path: Path, options: dict) -> tuple[bool, str]:
    module = importlib.import_module(module_name)
    converter = _wait_for_instance(module)
    if converter is None:
        return False, f"{module_name}.get_instance() returned None"
    string_options = _string_options(options)
    try:
        task = converter.create_converter_task(str(input_path), str(output_path), options)
    except TypeError:
        task = converter.create_converter_task(str(input_path), str(output_path), string_options)
    if hasattr(task, "wait_until_finished"):
        success = _run_async(task.wait_until_finished())
        status = getattr(task, "get_status", lambda: "")()
        return bool(success), str(status)
    if inspect.isawaitable(task):
        result = _run_async(task)
        return _result_success_and_message(result)
    return _result_success_and_message(task)


def _convert_with_hoops_function(input_path: Path, output_path: Path, options: dict) -> tuple[bool, str]:
    import omni.converter.hoops as hoops

    params = hoops.Parameters()
    string_options = _string_options(options)
    if hasattr(params, "parseArgs"):
        params.parseArgs(string_options)
    elif hasattr(params, "parse"):
        params.parse(string_options)
    result = hoops.convert(params, str(input_path), str(output_path), string_options)
    return _result_success_and_message(result)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run direct Kit CAD core conversion.")
    parser.add_argument("--core-module", required=True)
    parser.add_argument("--input-path", required=True, type=Path)
    parser.add_argument("--output-path", required=True, type=Path)
    parser.add_argument("--config-path", required=True, type=Path)
    args = parser.parse_args()

    options = json.loads(args.config_path.read_text(encoding="utf-8"))
    input_path = args.input_path.resolve()
    output_path = args.output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if args.core_module == "omni.kit.converter.hoops_core":
        try:
            success, message = _convert_with_hoops_function(input_path, output_path, options)
        except Exception as first_error:
            success, message = _convert_with_core_instance(args.core_module, input_path, output_path, options)
            if not success:
                message = f"hoops direct function failed: {first_error}; core instance failed: {message}"
    else:
        success, message = _convert_with_core_instance(args.core_module, input_path, output_path, options)

    if not success:
        print(message, file=sys.stderr)
        return 1
    if not output_path.exists():
        print(f"converter reported success but did not write {output_path}", file=sys.stderr)
        return 1
    print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
""",
        encoding="utf-8",
    )
    return runner_path


def _kit_exec_payload(process_script: Path, source_asset: Path, output_usd_path: Path, config_path: Path) -> str:
    return " ".join(
        [
            shlex.quote(str(process_script)),
            "--input-path",
            shlex.quote(str(source_asset)),
            "--output-path",
            shlex.quote(str(output_usd_path)),
            "--config-path",
            shlex.quote(str(config_path)),
        ]
    )


def _core_exec_payload(runner_script: Path, cad_core: str, source_asset: Path, output_usd_path: Path, config_path: Path) -> str:
    return " ".join(
        [
            shlex.quote(str(runner_script)),
            "--core-module",
            shlex.quote(CAD_CORE_MODULE[cad_core]),
            "--input-path",
            shlex.quote(str(source_asset)),
            "--output-path",
            shlex.quote(str(output_usd_path)),
            "--config-path",
            shlex.quote(str(config_path)),
        ]
    )


def _core_command(
    kit_executable: Path | None,
    runner_script: Path | None,
    source_asset: Path,
    output_usd_path: Path,
    config_path: Path | None,
    cad_core: str,
) -> list[str]:
    return [
        str(kit_executable) if kit_executable else "<KIT_APP_TEMPLATE_BUILD_DIR>/kit/kit",
        "--allow-root",
        "--enable",
        CAD_CORE_EXTENSION[cad_core],
        "--/app/fastShutdown=1",
        "--exec",
        _core_exec_payload(
            runner_script or Path("<generated-kit-cad-core-runner.py>"),
            cad_core,
            source_asset,
            output_usd_path,
            config_path or Path("<generated-cad-converter-options.json>"),
        ),
        "--info",
    ]


def _service_command(
    kit_executable: Path | None,
    process_script: Path | None,
    source_asset: Path,
    output_usd_path: Path,
    config_path: Path | None,
    cad_core: str,
) -> list[str]:
    return [
        str(kit_executable) if kit_executable else "<KIT_APP_TEMPLATE_BUILD_DIR>/kit/kit",
        "--allow-root",
        "--enable",
        CAD_CORE_EXTENSION[cad_core],
        "--/app/fastShutdown=1",
        "--exec",
        _kit_exec_payload(
            process_script or Path("<omni.services.convert.cad>/omni/services/convert/cad/services/process") / CAD_PROCESS_SCRIPT[cad_core],
            source_asset,
            output_usd_path,
            config_path or Path("<generated-cad-converter-options.json>"),
        ),
        "--info",
    ]


def _sidecar_inputs(*paths: Path | None) -> list[str]:
    return [str(path) for path in paths if path is not None]


def probe_source(source_asset: Path) -> dict[str, Any]:
    source_asset = source_asset.resolve()
    return {
        "source_asset_path": str(source_asset),
        "source_format": "cad",
        "converter_skill": SKILL,
        "converter_tool": KIT_CAD_CONVERTER_TOOL,
        "supported": True,
        "sidecar_inputs": [],
        "warnings": [
            "Linux arm64 host detected; probing the Kit App Template CAD Converter fallback because upstream usd-convert-cad is not available for this architecture.",
            f"Fallback does not maintain a local source-format allowlist; Kit App Template determines support at conversion time. Upstream Kit App Template: {KIT_APP_TEMPLATE_URL}.",
        ],
        "errors": [],
        "install_hint": KIT_INSTALL_HINT,
    }


def check_dependencies(
    *,
    kit_app_template_root: Path | None = None,
    kit_build_dir: Path | None = None,
    kit_executable: Path | None = None,
    cad_service_extension_dir: Path | None = None,
    execution_mode: str = "core",
) -> dict[str, Any]:
    kit_root = _resolve_kit_root(kit_app_template_root)
    build_dir = _resolve_build_dir(kit_build_dir, kit_root)
    resolved_kit_executable = _resolve_kit_executable(kit_executable, build_dir)
    service_extension_dir = _resolve_service_extension_dir(cad_service_extension_dir, build_dir)
    execution_mode = execution_mode.lower()

    checks = [
        _check("python_available", True, f"Python executable: {sys.executable}"),
        _check("host_is_arm64", is_arm64_host(), f"Host architecture: {platform.machine()}"),
        _check(
            "kit_app_template_root_exists",
            kit_root.exists() and ((kit_root / "repo.sh").exists() or (kit_root / "repo.bat").exists()),
            f"Kit App Template root: {kit_root}",
        ),
        _check(
            "kit_app_template_build_dir_exists",
            build_dir is not None and build_dir.exists(),
            f"Kit App Template build directory: {build_dir or '<unresolved>'}",
        ),
        _check(
            "kit_executable_exists",
            resolved_kit_executable is not None and resolved_kit_executable.exists(),
            f"Kit executable: {resolved_kit_executable or '<unresolved>'}",
        ),
    ]
    if execution_mode not in {"core", "service"}:
        checks.append(_check("kit_cad_execution_mode_supported", False, f"Unsupported execution mode: {execution_mode}"))
    if execution_mode == "service":
        process_script = _process_script_path(service_extension_dir, "hoops")
        checks.extend(
            [
                _check(
                    "cad_service_extension_dir_exists",
                    service_extension_dir is not None and service_extension_dir.exists(),
                    f"CAD service extension directory: {service_extension_dir or '<unresolved>'}",
                ),
                _check(
                    "cad_service_process_script_exists",
                    process_script is not None and process_script.exists(),
                    f"CAD service HOOPS process script: {process_script or '<unresolved>'}",
                ),
            ]
        )

    errors = [check["message"] for check in checks if not check["passed"]]
    payload = {
        "skill": SKILL,
        "passed": not errors,
        "runtime": "kit-app-template-cad-arm64-fallback",
        "checks": checks,
        "errors": errors,
        "upstream_repo": KIT_APP_TEMPLATE_URL,
        "kit_app_template_root": str(kit_root),
        "kit_build_dir": str(build_dir) if build_dir is not None else "",
        "kit_executable": str(resolved_kit_executable) if resolved_kit_executable is not None else "",
    }
    if errors:
        payload["install_hint"] = KIT_INSTALL_HINT
    return payload


def convert_with_kit_app_template(
    source_asset: Path,
    output_directory: Path,
    *,
    kit_app_template_root: Path | None = None,
    kit_build_dir: Path | None = None,
    kit_executable: Path | None = None,
    cad_service_extension_dir: Path | None = None,
    config_path: Path | None = None,
    output_extension: str = ".usd",
    execution_mode: str = "core",
    fine: bool = False,
    coarse: bool = False,
    tessellation_chord: float = 0.01,
    tessellation_angle: float = 30.0,
    no_materials: bool = False,
    single_mesh: bool = False,
    no_meter_units: bool = False,
    keep_hidden: bool = False,
    timeout: int = 1800,
) -> dict[str, Any]:
    source_asset = source_asset.resolve()
    output_directory = output_directory.resolve()
    output_extension = output_extension if output_extension.startswith(".") else f".{output_extension}"
    output_usd_path = output_directory / f"{source_asset.stem}{output_extension}"
    source_format = "cad"
    kit_root = _resolve_kit_root(kit_app_template_root)
    build_dir = _resolve_build_dir(kit_build_dir, kit_root)
    resolved_kit_executable = _resolve_kit_executable(kit_executable, build_dir)
    service_extension_dir = _resolve_service_extension_dir(cad_service_extension_dir, build_dir)
    cad_core = _cad_core_for_source(source_asset)
    execution_mode = execution_mode.lower()
    process_script = _process_script_path(service_extension_dir, cad_core) if execution_mode == "service" else None

    warnings = [
        "Linux arm64 host detected; using Kit App Template CAD Converter fallback because upstream usd-convert-cad is not available for this architecture.",
        f"Fallback runtime: {KIT_CAD_CONVERTER_TOOL}; upstream Kit App Template: {KIT_APP_TEMPLATE_URL}.",
        f"CAD Converter extension docs: {CAD_CONVERTER_DOCS_URL}.",
        "Default execution uses direct CAD core extension APIs, not the CAD service extension.",
        f"CAD Converter service CLI docs for optional service mode: {CAD_CONVERTER_SERVICE_DOCS_URL}.",
    ]
    errors: list[str] = []
    if not source_asset.exists():
        errors.append(f"source asset does not exist: {source_asset}")
    if output_extension.lower() not in USD_OUTPUT_SUFFIXES:
        errors.append(f"unsupported USD output extension: {output_extension}")
    if fine and coarse:
        errors.append("--fine and --coarse are mutually exclusive")
    if execution_mode not in {"core", "service"}:
        errors.append(f"unsupported CAD execution mode: {execution_mode}. Use core or service.")
    if not kit_root.exists() or not ((kit_root / "repo.sh").exists() or (kit_root / "repo.bat").exists()):
        errors.append(f"Kit App Template checkout was not found or is incomplete: {kit_root}")
    if build_dir is not None and not build_dir.exists() and resolved_kit_executable is None:
        dependency_hint = (
            "omni.services.convert.cad and the CAD core extensions"
            if execution_mode == "service"
            else f"{CAD_CORE_EXTENSION[cad_core]} or the bundled omni.kit.converter.cad extension"
        )
        errors.append(
            f"Kit App Template build directory was not found: {build_dir}. Run the upstream build flow from "
            f"{KIT_APP_TEMPLATE_URL} and include {dependency_hint} in the app dependencies."
        )
    if resolved_kit_executable is None or not resolved_kit_executable.exists():
        errors.append(
            "Kit executable was not found. Set --kit-executable, KIT_APP_TEMPLATE_KIT_EXECUTABLE, "
            "KIT_EXECUTABLE, or build Kit App Template so _build/<platform>/release/kit/kit exists."
        )
    if execution_mode == "service" and (service_extension_dir is None or not service_extension_dir.exists()):
        errors.append(
            "omni.services.convert.cad extension cache was not found. Add omni.services.convert.cad to the "
            "Kit App Template app dependencies and build/precache the app, or set --cad-service-extension-dir."
        )
    if execution_mode == "service" and (process_script is None or not process_script.exists()):
        errors.append(
            f"CAD service process script for {cad_core} conversion was not found: "
            f"{process_script or '<unresolved>'}"
        )

    effective_config_path = config_path.resolve() if config_path else None
    if effective_config_path is not None and not effective_config_path.exists():
        errors.append(f"CAD converter config path does not exist: {effective_config_path}")

    runner_script = None
    command = (
        _service_command(
            resolved_kit_executable,
            process_script,
            source_asset,
            output_usd_path,
            effective_config_path,
            cad_core,
        )
        if execution_mode == "service"
        else _core_command(
            resolved_kit_executable,
            runner_script,
            source_asset,
            output_usd_path,
            effective_config_path,
            cad_core,
        )
    )

    if errors:
        return {
            "source_asset_path": str(source_asset),
            "source_format": source_format,
            "converter_skill": SKILL,
            "converter_tool": KIT_CAD_CONVERTER_TOOL,
            "converter_command": command,
            "output_directory": str(output_directory),
            "output_usd_path": "",
            "generated_files": [],
            "sidecar_inputs": _sidecar_inputs(kit_root, build_dir, resolved_kit_executable, service_extension_dir, effective_config_path),
            "warnings": warnings,
            "errors": errors,
            "install_hint": KIT_INSTALL_HINT,
            "next_step": NEXT_STEP,
        }

    output_directory.mkdir(parents=True, exist_ok=True)
    if effective_config_path is None:
        effective_config_path = _write_converter_config(
            output_directory,
            source_asset,
            fine=fine,
            coarse=coarse,
            tessellation_chord=tessellation_chord,
            tessellation_angle=tessellation_angle,
            no_materials=no_materials,
            single_mesh=single_mesh,
            no_meter_units=no_meter_units,
            keep_hidden=keep_hidden,
        )
    if execution_mode == "core":
        runner_script = _write_core_runner_script(output_directory, source_asset)
        command = _core_command(
            resolved_kit_executable,
            runner_script,
            source_asset,
            output_usd_path,
            effective_config_path,
            cad_core,
        )
    else:
        command = _service_command(
            resolved_kit_executable,
            process_script,
            source_asset,
            output_usd_path,
            effective_config_path,
            cad_core,
        )

    env = os.environ.copy()
    env.setdefault("ACCEPT_EULA", "Y")
    env.setdefault("OMNI_KIT_ACCEPT_EULA", "yes")
    completed = subprocess.run(
        command,
        cwd=str(build_dir or resolved_kit_executable.parent),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )

    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        if not detail:
            detail = f"Kit App Template CAD conversion exited with {completed.returncode}"
        errors.append(_compact(detail))
    if completed.stdout.strip() and completed.returncode == 0:
        warnings.append(_compact(completed.stdout))
    if completed.stderr.strip() and completed.returncode == 0:
        warnings.append(_compact(completed.stderr))
    if not output_usd_path.exists():
        errors.append(f"converter did not produce expected USD output: {output_usd_path}")

    return {
        "source_asset_path": str(source_asset),
        "source_format": source_format,
        "converter_skill": SKILL,
        "converter_tool": KIT_CAD_CONVERTER_TOOL,
        "converter_command": command,
        "output_directory": str(output_directory),
        "output_usd_path": str(output_usd_path) if output_usd_path.exists() else "",
        "generated_files": discover_generated_files(output_directory),
        "sidecar_inputs": _sidecar_inputs(
            kit_root,
            build_dir,
            resolved_kit_executable,
            service_extension_dir,
            effective_config_path,
            runner_script,
        ),
        "warnings": warnings,
        "errors": errors,
        "install_hint": KIT_INSTALL_HINT if errors else "",
        "next_step": NEXT_STEP,
    }
