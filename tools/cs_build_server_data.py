#!/usr/bin/env python3
"""Build private-server friendly indexes from parsed CounterSide table JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ID_HINTS = (
    "m_UnitID",
    "m_ItemMiscID",
    "m_ItemEquipID",
    "m_ItemMoldID",
    "m_PieceID",
    "m_DungeonID",
    "m_StageID",
    "m_WarfareID",
    "m_MapID",
    "m_SkinID",
    "m_MissionID",
    "m_EpisodeID",
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def rel(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.name


def records_from(path: Path) -> list[Any]:
    data = load_json(path)
    return data.get("records", [])


def detect_id_fields(records: list[Any]) -> list[str]:
    seen: set[str] = set()
    for record in records[:200]:
        if not isinstance(record, dict):
            continue
        for key in record:
            if key in ID_HINTS or key.endswith("ID") or key.endswith("Id"):
                seen.add(key)
    return sorted(seen)


def dict_by(records: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for record in records:
        value = record.get(key)
        if value is None:
            continue
        result[str(value)] = record
    return result


def string_map(records: list[Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for record in records:
        if isinstance(record, list) and len(record) >= 2:
            result[str(record[0])] = str(record[1])
        elif isinstance(record, dict):
            key = record.get("__key") or record.get("key") or record.get("m_StringID")
            value = record.get("value") or record.get("m_StringValue")
            if key is not None and value is not None:
                result[str(key)] = str(value)
    return result


def merge_units(root: Path) -> dict[str, Any]:
    unit_dir = root / "ab_script_unit_data" / "luac"
    base_files = [
        "LUA_UNIT_TEMPLET_BASE.json",
        "LUA_UNIT_TEMPLET_BASE2.json",
        "LUA_UNIT_TEMPLET_BASE_SD.json",
        "LUA_UNIT_TEMPLET_BASE_OPR.json",
    ]
    stat_files = [
        "LUA_UNIT_STAT_TEMPLET.json",
        "LUA_UNIT_STAT_TEMPLET2.json",
        "LUA_UNIT_STAT_TEMPLET_SD.json",
        "LUA_UNIT_STAT_TEMPLET_OPR.json",
    ]

    units: dict[str, dict[str, Any]] = {}
    for name in base_files:
        path = unit_dir / name
        if not path.exists():
            continue
        for record in records_from(path):
            if not isinstance(record, dict) or "m_UnitID" not in record:
                continue
            unit = dict(record)
            unit["_sourceTable"] = name
            units[str(record["m_UnitID"])] = unit

    stats_by_str: dict[str, dict[str, Any]] = {}
    for name in stat_files:
        path = unit_dir / name
        if not path.exists():
            continue
        for record in records_from(path):
            if isinstance(record, dict) and record.get("m_UnitStrID"):
                stats_by_str[str(record["m_UnitStrID"])] = record

    for unit in units.values():
        stat = stats_by_str.get(str(unit.get("m_UnitStrID")))
        if stat:
            unit["_stat"] = stat

    return {
        "count": len(units),
        "byId": dict(sorted(units.items(), key=lambda item: int(item[0]) if item[0].isdigit() else item[0])),
        "byStrId": {
            str(unit["m_UnitStrID"]): unit
            for unit in units.values()
            if unit.get("m_UnitStrID")
        },
    }


def merge_items(root: Path) -> dict[str, Any]:
    item_dir = root / "ab_script_item_templet" / "luac"
    tables: dict[str, Any] = {}
    for path in sorted(item_dir.glob("*.json")):
        records = [record for record in records_from(path) if isinstance(record, dict)]
        id_fields = detect_id_fields(records)
        table = {"count": len(records), "idFields": id_fields, "records": records}
        if id_fields:
            table["byId"] = dict_by(records, id_fields[0])
        tables[path.stem] = table
    return tables


def merge_dungeons(root: Path) -> dict[str, Any]:
    base = root / "ab_script_dungeon_templet" / "luac" / "LUA_DUNGEON_TEMPLET_BASE.json"
    records = [record for record in records_from(base) if isinstance(record, dict)] if base.exists() else []
    return {
        "count": len(records),
        "byId": dict_by(records, "m_DungeonID"),
        "byStrId": dict_by(records, "m_DungeonStrID"),
    }


def merge_warfare(root: Path) -> dict[str, Any]:
    base = root / "ab_script_warfare" / "luac" / "LUA_WARFARE_TEMPLET.json"
    records = [record for record in records_from(base) if isinstance(record, dict)] if base.exists() else []
    return {
        "count": len(records),
        "byId": dict_by(records, "m_WarfareID"),
        "byStrId": dict_by(records, "m_WarfareStrID"),
    }


def merge_strings(root: Path) -> dict[str, Any]:
    string_dir = root / "ab_script_string_table" / "luac"
    tables: dict[str, Any] = {}
    for path in sorted(string_dir.glob("LUA_STRING_*.json")):
        lang = path.stem.removeprefix("LUA_STRING_")
        values = string_map(records_from(path))
        tables[lang] = {"count": len(values), "strings": values}
    return tables


def build_catalog(root: Path, out_dir: Path) -> dict[str, Any]:
    tables = []
    for path in sorted(root.rglob("*.json")):
        data = load_json(path)
        records = data.get("records", [])
        table = {
            "table": path.stem,
            "path": rel(path, out_dir.parent),
            "rootName": data.get("rootName"),
            "recordCount": data.get("recordCount", 0),
            "idFields": detect_id_fields([record for record in records if isinstance(record, dict)]),
            "unsupportedCount": data.get("unsupportedCount", 0),
        }
        tables.append(table)
    return {"tableCount": len(tables), "tables": tables}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parsed-root", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()

    root = args.parsed_root.resolve()
    out = args.out_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)

    write_json(out / "units.json", merge_units(root))
    write_json(out / "items.json", merge_items(root))
    write_json(out / "dungeons.json", merge_dungeons(root))
    write_json(out / "warfare.json", merge_warfare(root))
    write_json(out / "strings.json", merge_strings(root))
    write_json(out / "table_catalog.json", build_catalog(root, out))

    readme = """# CounterSide Server Data

Generated from parsed `ab_script*` Lua table bytecode.

- `units.json`: unit templates merged with stat templates, indexed by unit id and string id.
- `items.json`: item/equipment/piece tables grouped by table name.
- `dungeons.json`: dungeon base templates indexed by dungeon id and string id.
- `warfare.json`: warfare templates indexed by id and string id.
- `strings.json`: localized string tables by language code.
- `table_catalog.json`: every parsed table with relative source path and detected ID fields.

The full parsed table JSON remains in `gameplay-tables-json/Assetbundles` when using the beginner setup guide. Older local setups may have the same data under `gameplay-tables-json/StreamingAssets`.
"""
    (out / "README.md").write_text(readme, encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
