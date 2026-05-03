# Setup Guide

This guide assumes Windows, Steam CounterSide, Node.js 20 or newer, .NET 8 SDK, Java, Python 3.11 or newer, and Wireshark if you plan to generate packet fixtures.

## 1. Clone And Configure

```powershell
git clone <repo-url> RevivalSide
cd RevivalSide
copy .env.example .env
npm install
npm run build:combat-host
```

If your CounterSide install is not in the default Steam path, edit `.env`:

```powershell
CS_COUNTERSIDE_MANAGED_DIR=C:\Path\To\CounterSide\Data\Managed
```

## 2. Patch Hosts As Administrator

Open PowerShell as Administrator from the repo root and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\patch-hosts.ps1
```

This adds a marked RevivalSide block to:

```text
C:\Windows\System32\drivers\etc\hosts
```

Default entries:

```text
127.0.0.1 ctsglobal-login.sbside.com ctskorea-login.sbside.com ctsglobal-cdndown.sbside.com
```

To remove the block later:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\patch-hosts.ps1 -Remove
```

The script writes a timestamped hosts backup before making changes.

## 3. Dump Assembly-CSharp Locally

The dump is for reference only and is intentionally ignored by git.

Install ILSpy command line:

```powershell
dotnet tool install --global ilspycmd
```

Dump your own client:

```powershell
$managed = "C:\Program Files (x86)\Steam\steamapps\common\CounterSide\Data\Managed"
ilspycmd -p -o .\Assembly-CSharp "$managed\Assembly-CSharp.dll"
```

See [dump-assembly-csharp.md](dump-assembly-csharp.md) for dnSpyEx and ILSpy notes.

## 4. Generate Gameplay Tables

The C# combat host uses the installed client `Managed` DLLs and local gameplay tables. These generated folders are ignored by git.

Install Python dependencies used by the asset extractor:

```powershell
py -m pip install UnityPy
```

Decrypt script bundles from your CounterSide install:

```powershell
$client = "C:\Program Files (x86)\Steam\steamapps\common\CounterSide"
py .\tools\cs_asset_decrypt.py dump-lua --root "$client\Data\StreamingAssets" --out-dir .\gameplay-tables\StreamingAssets --manifest .\gameplay-tables\catalog.json --overwrite
```

Decompile Lua bytecode:

```powershell
py .\tools\cs_lua_table_pipeline.py decompile --luac-root .\gameplay-tables --out-dir .\gameplay-tables-decompiled --jar .\tools\unluac.jar --overwrite
```

Parse Lua tables:

```powershell
py .\tools\cs_lua_table_pipeline.py parse --lua-root .\gameplay-tables-decompiled --out-dir .\gameplay-tables-json --overwrite
```

Build compact server indexes:

```powershell
py .\tools\cs_build_server_data.py --parsed-root .\gameplay-tables-json\StreamingAssets --out-dir .\server-data
```

## 5. Generate Local Packet Fixtures

Captured fixtures are local research data and are not committed. Use Wireshark/dumpcap, then extract the relevant TCP streams.

Start a broad capture:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\watch-counterside-capture.ps1
```

After stopping capture, identify the TCP stream in Wireshark or with `tshark`, then extract:

```powershell
node .\tools\extract-cs-pcap-fixtures.js .\captures\your-capture.pcapng .\server-data\captured-tcp tcp <stream>
node .\tools\extract-cs-pcap-fixtures.js .\captures\your-capture.pcapng .\server-data\captured-game-flow game <stream> <client-ip>
```

HTTP mirror fixtures live in `server-data/captured-flows`. Keep them local.

## 6. Run The Listener

```powershell
npm run listen
```

Expected startup lines include:

```text
[+] Listening on port 22000
[+] Captured HTTP mirror listening on http://127.0.0.1:8088
```

Combat sync defaults to roughly 30 Hz:

```powershell
CS_DYNAMIC_BATTLE_SYNC_INTERVAL_MS=33
```

Raising this value batches more managed combat frames per network tick and can make combat actions feel delayed or stacked.

If the C# host cannot start, confirm:

- `.env` points `CS_COUNTERSIDE_MANAGED_DIR` to a folder containing `Assembly-CSharp.dll`.
- `.NET 8` is installed.
- Local gameplay tables were generated.
- Captured tutorial fixtures exist if you are testing the tutorial flow.

## 7. Prebuilt Combat Host

`prebuilt/combat-host` contains RevivalSide-built host binaries. To force the listener to use that DLL instead of building from source:

```powershell
$env:CS_CSHARP_COMBAT_HOST_DLL = ".\prebuilt\combat-host\CombatHost.dll"
npm run listen
```

The managed game DLL is still loaded from your local CounterSide install and patched into a local cache at runtime. Do not commit that patched managed copy.
