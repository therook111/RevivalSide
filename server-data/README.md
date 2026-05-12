# CounterSide Server Data

This folder holds local generated data plus the sanitized fixture bundle used by the listener. Most generated files here are ignored by git, but the current tutorial fixtures are tracked so collaborators can run up to the shared progress point.

Generated from parsed `ab_script*` Lua table bytecode:

- `units.json`: unit templates merged with stat templates, indexed by unit id and string id.
- `items.json`: item/equipment/piece tables grouped by table name.
- `dungeons.json`: dungeon base templates indexed by dungeon id and string id.
- `warfare.json`: warfare templates indexed by id and string id.
- `strings.json`: localized string tables by language code.
- `table_catalog.json`: every parsed table with relative source path and detected ID fields.

Tracked capture-derived fixtures:

- `captured-flows/`: HTTP mirror responses.
- `captured-tcp/`: contents/login TCP fixtures.
- `captured-game-flow/`: game-stream client/server packet fixtures.

Regenerate table data from your own client. Do not commit account state, raw captures, full generated table output, or unsanitized fixture manifests.

The beginner setup guide writes parsed table JSON to `gameplay-tables-json/Assetbundles`. Older local setups may have the same data under `gameplay-tables-json/StreamingAssets`.
