const path = require("path");
const {
  ensureGameplayLuaCache,
  getGameplayLuaCacheRoot,
} = require("../modules/gameplay-jsons");

const ROOT_DIR = path.resolve(__dirname, "..");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cacheRoot = ensureGameplayLuaCache({
    rootDir: ROOT_DIR,
    managedDir: args.managedDir,
    cacheRoot: args.cacheDir,
    force: args.force === true,
    quiet: args.quiet === true,
    logLabel: "gameplay-assets",
    progress: args.progressJson === true ? writeProgressEvent : undefined,
  });
  if (!args.quiet) {
    console.log(`[gameplay-assets] cache=${cacheRoot || getGameplayLuaCacheRoot({ rootDir: ROOT_DIR })}`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--managed-dir") args.managedDir = argv[++index];
    else if (arg === "--cache-dir") args.cacheDir = argv[++index];
    else if (arg === "--force") args.force = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--progress-json") args.progressJson = true;
    else if (arg === "--help" || arg === "-h") usage();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function writeProgressEvent(event) {
  console.log(`[gameplay-assets:progress] ${JSON.stringify(event)}`);
}

function usage() {
  console.log(
    [
      "Usage: node tools/ensure-gameplay-assets.js [options]",
      "",
      "Options:",
      "  --managed-dir <dir>   CounterSide Data/Managed directory or Assembly-CSharp.dll path",
      "  --cache-dir <dir>     output Lua bytecode cache (default: .cache/gameplay-luac)",
      "  --force               rebuild even when the installed asset inventory is unchanged",
      "  --quiet               suppress extractor output",
      "  --progress-json       emit machine-readable progress lines for the launcher",
    ].join("\n")
  );
  process.exit(0);
}

main();
