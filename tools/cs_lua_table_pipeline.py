#!/usr/bin/env python3
"""Decompile and parse CounterSide Lua table bytecode dumps."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


VAR_RE = re.compile(r"^([A-Za-z_]\w*)$")
ASSIGN_RE = re.compile(r"^(.+?)\s*=\s*(.+)$")
FIELD_RE = re.compile(r"^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$")
INDEX_RE = re.compile(r"^([A-Za-z_]\w*)\[(.+)\]$")
NUMBER_RE = re.compile(r"^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")


def rel_output_path(path: Path, root: Path, out_root: Path, suffix: str) -> Path:
    try:
        rel = path.resolve().relative_to(root.resolve())
    except ValueError:
        rel = Path(path.name)
    return out_root / rel.with_suffix(suffix)


def decode_lua_string(raw: str) -> str:
    try:
        return bytes(raw, "utf-8").decode("unicode_escape")
    except Exception:
        return raw


def parse_literal(token: str, env: dict[str, Any]) -> Any:
    token = token.strip()
    if token == "{}":
        return {}
    if token == "true":
        return True
    if token == "false":
        return False
    if token == "nil":
        return None
    if len(token) >= 2 and token[0] == '"' and token[-1] == '"':
        return decode_lua_string(token[1:-1])
    if NUMBER_RE.match(token):
        if any(ch in token for ch in ".eE"):
            return float(token)
        return int(token)
    if VAR_RE.match(token):
        return env.get(token, {"__unresolved_var": token})
    return {"__unparsed_expr": token}


def parse_key(token: str, env: dict[str, Any]) -> str:
    value = parse_literal(token, env)
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    return str(value)


def assign_target(target: str, value: Any, env: dict[str, Any], globals_: dict[str, Any]) -> bool:
    target = target.strip()
    if VAR_RE.match(target):
        env[target] = value
        if not target.startswith("L"):
            globals_[target] = value
        return True

    field = FIELD_RE.match(target)
    if field:
        base_name, key = field.groups()
        base = env.setdefault(base_name, {})
        if isinstance(base, dict):
            base[key] = value
            return True
        return False

    index = INDEX_RE.match(target)
    if index:
        base_name, key_expr = index.groups()
        base = env.setdefault(base_name, {})
        if isinstance(base, dict):
            base[parse_key(key_expr, env)] = value
            return True
        return False

    return False


def normalize(value: Any) -> Any:
    if isinstance(value, dict):
        normalized = {key: normalize(val) for key, val in value.items()}
        numeric_keys = []
        for key in normalized:
            if isinstance(key, str) and key.isdigit():
                numeric_keys.append(int(key))
        if numeric_keys and len(numeric_keys) == len(normalized):
            ordered = sorted(numeric_keys)
            if ordered == list(range(1, len(ordered) + 1)):
                return [normalized[str(index)] for index in ordered]
        return normalized
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def root_records(root: Any) -> list[Any]:
    root = normalize(root)
    if isinstance(root, list):
        return root
    if not isinstance(root, dict):
        return []
    records = []
    for key, value in root.items():
        if isinstance(value, dict):
            record = {"__key": key}
            record.update(value)
            records.append(record)
        else:
            records.append({"__key": key, "value": value})
    return records


def parse_lua_table(path: Path) -> dict[str, Any]:
    globals_: dict[str, Any] = {}
    env: dict[str, Any] = {"_ENV": globals_}
    unsupported: list[str] = []

    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("local "):
            continue
        match = ASSIGN_RE.match(line)
        if not match:
            if not line.startswith("--"):
                unsupported.append(line)
            continue
        target, expr = match.groups()
        value = parse_literal(expr, env)
        if not assign_target(target, value, env, globals_):
            unsupported.append(line)

    root_name = None
    root = None
    for name, value in globals_.items():
        if isinstance(value, dict):
            root_name = name
            root = value
            break
    if root is None:
        root_name = "L0_1"
        root = env.get(root_name, {})

    normalized_globals = {name: normalize(value) for name, value in globals_.items()}
    normalized_root = normalize(root)
    records = root_records(root)
    return {
        "source": str(path),
        "rootName": root_name,
        "globalCount": len(normalized_globals),
        "globals": normalized_globals,
        "recordCount": len(records),
        "records": records,
        "root": normalized_root,
        "unsupportedCount": len(unsupported),
        "unsupported": unsupported[:200],
    }


def decompile_one(luac: Path, luac_root: Path, out_root: Path, jar: Path, overwrite: bool) -> dict[str, Any]:
    output = rel_output_path(luac, luac_root, out_root, ".lua")
    if output.exists() and not overwrite:
        return {"source": str(luac), "output": str(output), "skipped": True, "error": None}
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["java", "-jar", str(jar), "--output", str(output), str(luac)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    error = None
    if result.returncode != 0:
        error = (result.stderr or result.stdout).strip()
    return {"source": str(luac), "output": str(output), "skipped": False, "error": error}


def parse_one(lua: Path, lua_root: Path, out_root: Path, overwrite: bool) -> dict[str, Any]:
    output = rel_output_path(lua, lua_root, out_root, ".json")
    if output.exists() and not overwrite:
        return {"source": str(lua), "output": str(output), "skipped": True, "error": None}
    try:
        data = parse_lua_table(lua)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        return {
            "source": str(lua),
            "output": str(output),
            "records": data["recordCount"],
            "unsupported": data["unsupportedCount"],
            "skipped": False,
            "error": None,
        }
    except Exception as exc:
        return {"source": str(lua), "output": str(output), "skipped": False, "error": str(exc)}


def run_parallel(items: list[Path], worker, workers: int, label: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(worker, item): item for item in items}
        for index, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            results.append(result)
            if index == 1 or index == len(items) or index % 100 == 0:
                errors = sum(1 for item in results if item.get("error"))
                print(f"[{label}] {index}/{len(items)} errors={errors}")
    return results


def write_manifest(path: Path, root: Path, out_root: Path, results: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "root": str(root),
        "out_dir": str(out_root),
        "count": len(results),
        "error_count": sum(1 for result in results if result.get("error")),
        "results": results,
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    dec = sub.add_parser("decompile")
    dec.add_argument("--luac-root", type=Path, required=True)
    dec.add_argument("--out-dir", type=Path, required=True)
    dec.add_argument("--jar", type=Path, required=True)
    dec.add_argument("--pattern", default="*.luac")
    dec.add_argument("--manifest", type=Path)
    dec.add_argument("--workers", type=int, default=4)
    dec.add_argument("--limit", type=int, default=0)
    dec.add_argument("--overwrite", action="store_true")

    parse = sub.add_parser("parse")
    parse.add_argument("--lua-root", type=Path, required=True)
    parse.add_argument("--out-dir", type=Path, required=True)
    parse.add_argument("--pattern", default="*.lua")
    parse.add_argument("--manifest", type=Path)
    parse.add_argument("--workers", type=int, default=8)
    parse.add_argument("--limit", type=int, default=0)
    parse.add_argument("--overwrite", action="store_true")

    args = parser.parse_args()
    if args.cmd == "decompile":
        root = args.luac_root.resolve()
        out_root = args.out_dir.resolve()
        files = sorted(root.rglob(args.pattern))
        if args.limit > 0:
            files = files[: args.limit]
        results = run_parallel(
            files,
            lambda item: decompile_one(item, root, out_root, args.jar.resolve(), args.overwrite),
            args.workers,
            "decompile",
        )
        write_manifest(args.manifest or out_root / "manifest.json", root, out_root, results)
        return 0

    if args.cmd == "parse":
        root = args.lua_root.resolve()
        out_root = args.out_dir.resolve()
        files = sorted(root.rglob(args.pattern))
        if args.limit > 0:
            files = files[: args.limit]
        results = run_parallel(
            files,
            lambda item: parse_one(item, root, out_root, args.overwrite),
            args.workers,
            "parse",
        )
        write_manifest(args.manifest or out_root / "manifest.json", root, out_root, results)
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
