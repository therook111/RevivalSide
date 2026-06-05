const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  findCounterSideDataDir,
  findCounterSideManagedDir,
  normalizeManagedDir,
} = require("../modules/counterside-install");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CACHE_ROOT = path.join(ROOT_DIR, ".cache", "cutscene-bg-16x9");
const MANIFEST_NAME = ".revivalside-cutscene-bg-cache.json";
const DEFAULT_MAX_BUNDLES = 24;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const managedDir = normalizeManagedDir(
    args.managedDir || env.CS_COUNTERSIDE_MANAGED_DIR || env.COUNTERSIDE_MANAGED_DIR || env.CS_COUNTERSIDE_DIR || findCounterSideManagedDir({ env })
  );
  if (!managedDir || !fs.existsSync(path.join(managedDir, "Assembly-CSharp.dll"))) {
    throw new Error("CounterSide Data\\Managed\\Assembly-CSharp.dll was not found");
  }

  const cacheRoot = path.resolve(ROOT_DIR, args.cacheDir || env.CS_CUTSCENE_BG_CACHE_DIR || DEFAULT_CACHE_ROOT);
  const maxBundles = Number.isFinite(args.maxBundles) ? args.maxBundles : DEFAULT_MAX_BUNDLES;
  const candidates = findCutsceneBundleFiles(managedDir);
  if (!candidates.length) throw new Error(`no ab_ui_nkm_ui_cutscen_bg*.asset bundles were found from ${managedDir}`);
  const selected = selectSpread(candidates, maxBundles);
  const inventory = selected.map((item) => fileInventory(item.path, item.root, item.label));

  if (!args.force && isCacheFresh(cacheRoot, { managedDir, maxBundles, inventory })) {
    log(args, `[cutscene-assets] cache ready: ${countFiles(backgroundsDir(cacheRoot), /\.png$/i)} backgrounds at ${backgroundsDir(cacheRoot)}`);
    return;
  }

  buildCutsceneCache({
    args,
    cacheRoot,
    managedDir,
    maxBundles,
    selected,
    inventory,
  });
}

function findCutsceneBundleFiles(managedDir) {
  const dataDir = findCounterSideDataDir({ managedDir });
  if (!dataDir) return [];
  const streamingAssets = path.join(dataDir, "StreamingAssets");
  const roots = [
    { label: "StreamingAssets", root: streamingAssets },
    { label: "StreamingAssets-Assetbundles", root: path.join(streamingAssets, "Assetbundles") },
    { label: "Assetbundles", root: path.join(dataDir, "Assetbundles") },
  ];
  const seen = new Set();
  const result = [];
  for (const source of roots) {
    if (!fs.existsSync(source.root)) continue;
    for (const name of fs.readdirSync(source.root)) {
      if (!/^ab_ui_nkm_ui_cutscen_bg.*\.asset$/i.test(name)) continue;
      const fullPath = path.join(source.root, name);
      if (!fs.statSync(fullPath).isFile()) continue;
      const key = path.normalize(fullPath).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...source, path: fullPath });
    }
  }
  return result.sort((left, right) => path.basename(left.path).localeCompare(path.basename(right.path)));
}

function selectSpread(items, maxItems) {
  if (!maxItems || maxItems < 0 || items.length <= maxItems) return items;
  if (maxItems <= 1) return [items[0]];
  const selected = [];
  const seen = new Set();
  const step = (items.length - 1) / (maxItems - 1);
  for (let index = 0; index < maxItems; index += 1) {
    const item = items[Math.round(index * step)];
    const key = path.normalize(item.path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
  }
  return selected;
}

function buildCutsceneCache({ args, cacheRoot, managedDir, maxBundles, selected, inventory }) {
  const decryptScript = path.join(ROOT_DIR, "tools", "cs_asset_decrypt.py");
  const extractScript = path.join(ROOT_DIR, "tools", "cs_extract_decrypted_assets.py");
  if (!fs.existsSync(decryptScript)) throw new Error(`missing asset decrypt helper: ${decryptScript}`);
  if (!fs.existsSync(extractScript)) throw new Error(`missing asset extract helper: ${extractScript}`);

  const workRoot = path.join(cacheRoot, "work");
  const decryptedRoot = path.join(workRoot, "decrypted");
  const extractedRoot = path.join(workRoot, "extracted");
  const finalBackgrounds = backgroundsDir(cacheRoot);
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.rmSync(finalBackgrounds, { recursive: true, force: true });
  fs.mkdirSync(decryptedRoot, { recursive: true });
  fs.mkdirSync(extractedRoot, { recursive: true });

  log(args, `[cutscene-assets] extracting ${selected.length} of ${findCutsceneBundleFiles(managedDir).length} installed cutscene background bundles from ${managedDir}`);
  for (const group of groupByRoot(selected)) {
    const decryptOut = path.join(decryptedRoot, safeLabel(group.label));
    runPython(
      [
        decryptScript,
        "decrypt-header",
        ...group.files.map((item) => item.path),
        "--root",
        group.root,
        "--out-dir",
        decryptOut,
        "--overwrite",
      ],
      args
    );
    runPython(
      [
        extractScript,
        "--root",
        decryptOut,
        "--out-dir",
        path.join(extractedRoot, safeLabel(group.label)),
        "--pattern",
        "ab_ui_nkm_ui_cutscen_bg*.asset.dec",
        "--types",
        "Sprite",
        "--type-tree",
        "none",
        "--cutscene-backgrounds-only",
        "--overwrite-manifest",
      ],
      args
    );
  }

  const pngs = listFiles(extractedRoot, (file) => file.toLowerCase().endsWith(".png") && file.replace(/\\/g, "/").includes("/CutsceneBG16x9/"));
  if (!pngs.length) throw new Error("installed cutscene background extraction produced no PNG files");
  fs.mkdirSync(finalBackgrounds, { recursive: true });
  for (const png of pngs) {
    const target = uniquePath(path.join(finalBackgrounds, path.basename(png)));
    fs.copyFileSync(png, target);
  }
  fs.rmSync(workRoot, { recursive: true, force: true });

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    managedDir,
    maxBundles,
    inventory,
    backgroundCount: countFiles(finalBackgrounds, /\.png$/i),
  };
  fs.writeFileSync(path.join(cacheRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(args, `[cutscene-assets] cache ready: ${manifest.backgroundCount} backgrounds at ${finalBackgrounds}`);
}

function groupByRoot(items) {
  const groups = new Map();
  for (const item of items) {
    const key = path.normalize(item.root).toLowerCase();
    if (!groups.has(key)) groups.set(key, { root: item.root, label: item.label, files: [] });
    groups.get(key).files.push(item);
  }
  return [...groups.values()];
}

function isCacheFresh(cacheRoot, expected) {
  const manifestPath = path.join(cacheRoot, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath) || countFiles(backgroundsDir(cacheRoot), /\.png$/i) <= 0) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return (
      parsed &&
      parsed.version === 1 &&
      path.normalize(parsed.managedDir || "").toLowerCase() === path.normalize(expected.managedDir || "").toLowerCase() &&
      Number(parsed.maxBundles || 0) === Number(expected.maxBundles || 0) &&
      JSON.stringify(parsed.inventory || []) === JSON.stringify(expected.inventory)
    );
  } catch (_) {
    return false;
  }
}

function fileInventory(filePath, root, label) {
  const stat = fs.statSync(filePath);
  return {
    label,
    root,
    name: path.basename(filePath),
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}

function runPython(args, options = {}) {
  const configured = parsePathList(process.env.CS_PYTHON_PATH || process.env.PYTHON || "");
  const commands = uniquePaths([...configured, process.platform === "win32" ? "py" : "", "python", "python3"].filter(Boolean));
  const failures = [];
  for (const command of commands) {
    const finalArgs = path.basename(command).toLowerCase() === "py" ? ["-3", ...args] : args;
    const result = spawnSync(command, finalArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    const output = `${result.stderr || ""}${result.stdout || ""}`.trim();
    if ((result.error && result.error.code === "ENOENT") || isPythonNotFoundResult(result, output)) {
      failures.push(`${command}: not found`);
      continue;
    }
    if (result.status === 0) {
      if (!options.quiet) {
        if (output) console.log(output);
      }
      return;
    }
    throw new Error(`${command} ${finalArgs.map(quoteArg).join(" ")} failed${result.status == null ? "" : ` (${result.status})`}${output ? `: ${output}` : ""}`);
  }
  throw new Error(`Python was not found (${failures.join("; ")})`);
}

function isPythonNotFoundResult(result, output) {
  if (process.platform !== "win32") return false;
  if (result.status !== 9009) return false;
  return /python was not found|microsoft store|app execution aliases/i.test(output || "");
}

function backgroundsDir(cacheRoot) {
  return path.join(cacheRoot, "backgrounds");
}

function listFiles(root, predicate) {
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && predicate(fullPath)) result.push(fullPath);
    }
  }
  return result.sort();
}

function countFiles(root, pattern) {
  return listFiles(root, (file) => pattern.test(path.basename(file))).length;
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const directory = path.dirname(filePath);
  const extension = path.extname(filePath);
  const stem = path.basename(filePath, extension);
  for (let index = 2; ; index += 1) {
    const candidate = path.join(directory, `${stem}_${index}${extension}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function parsePathList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  return raw.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = path.normalize(String(value)).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function safeLabel(value) {
  return String(value || "assets").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function quoteArg(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text}"` : text;
}

function log(args, message) {
  if (!args.quiet) console.log(message);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--managed-dir") args.managedDir = argv[++index];
    else if (arg === "--cache-dir") args.cacheDir = argv[++index];
    else if (arg === "--max-bundles") args.maxBundles = Number(argv[++index]);
    else if (arg === "--force") args.force = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--help" || arg === "-h") usage();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log(
    [
      "Usage: node tools/ensure-cutscene-backgrounds.js [options]",
      "",
      "Options:",
      "  --managed-dir <dir>   CounterSide Data/Managed directory or Assembly-CSharp.dll path",
      "  --cache-dir <dir>     output cache (default: .cache/cutscene-bg-16x9)",
      "  --max-bundles <n>     installed background bundles to sample (default: 24, <=0 for all)",
      "  --force               rebuild even when the cache is fresh",
      "  --quiet               suppress extractor output",
    ].join("\n")
  );
  process.exit(0);
}

main();
