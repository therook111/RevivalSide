# Combat Host

This project is the C# combat boundary for RevivalSide.

`cs-listener.js` owns TCP framing, encryption, packet routing, and packet ordering. `combat-host` owns the local combat session boundary and can run the official managed local-server path through `NKCGameServerLocal`.

At runtime the host:

1. Loads `Assembly-CSharp.dll` from the contributor's local CounterSide `Data\Managed` folder.
2. Patches a local cache copy so Lua table loading can be redirected to the installed-client Lua bytecode cache or checked-in gameplay JSON tables.
3. Starts the managed local server for battle state, deployment, sync packets, and end packets.

The patched managed cache is generated under `bin\...\patched-managed` or `bin\host-cache\...\patched-managed` and must not be committed. The project-built `CombatHost` binaries are published to `prebuilt\combat-host`.
