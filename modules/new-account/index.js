const fs = require("fs");
const path = require("path");

const { dateTimeBinaryNow } = require("../packet-codec");
const {
  getPlayableUnitIds,
  getPlayableShipIds,
  getPlayableOperatorIds,
  getTrophyUnitIds,
} = require("../game-data");
const {
  ensureArmy,
  ensureDefaultLineup,
  getArmyUnits,
  getArmyShips,
  getArmyOperators,
  getArmyTrophies,
  grantUnit,
  grantOperator,
} = require("../unit");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS_PATHS = [
  process.env.CS_NEW_ACCOUNT_DEFAULTS_PATH,
  path.join(ROOT_DIR, "server-data", "new-account-defaults.json"),
  path.join(ROOT_DIR, "gameplay-jsons", "new-account-defaults.json"),
].filter(Boolean);
const BUILTIN_DEFAULTS = Object.freeze({
  user: Object.freeze({
    level: 1,
    exp: "0",
    totalExp: "0",
  }),
  profile: Object.freeze({
    friendIntro: "",
    mainUnitId: 0,
    mainUnitSkinId: 0,
    mainUnitTacticLevel: 0,
    frameId: 0,
    selfiFrameId: 0,
    titleId: 0,
  }),
  roster: Object.freeze({
    units: Object.freeze([]),
    ships: Object.freeze([]),
    operators: Object.freeze([]),
  }),
});
const BOOTSTRAP_KEY = "officialNewAccountDefaultsV2";
const ROSTER_MODES = Object.freeze({
  NONE: "none",
  STARTER: "starter",
  ALL: "all",
});

let cachedDefaults = null;

function ensureOfficialNewAccountDefaults(user, options = {}) {
  const rosterMode = normalizeRosterMode(options.rosterMode || (options.seedRoster === true ? ROSTER_MODES.ALL : ROSTER_MODES.NONE));
  const result = {
    changed: false,
    rosterMode,
    units: 0,
    ships: 0,
    operators: 0,
    trophies: 0,
  };
  if (!user || typeof user !== "object") return result;

  if (applyOfficialProfileDefaults(user)) result.changed = true;

  if (rosterMode === ROSTER_MODES.NONE) {
    rememberBootstrap(user, result, { rosterSeeded: false, rosterMode });
    return result;
  }

  const seeded = seedOfficialRoster(user, {
    rosterMode,
    includeTrophies: options.includeTrophies === true,
  });
  Object.assign(result, seeded, { changed: result.changed || seeded.changed });

  ensureDefaultLineup(user);
  ensureDefaultLineup(user, { deckType: 3, index: 0 });
  rememberBootstrap(user, result, { rosterSeeded: true, rosterMode });
  return result;
}

function applyOfficialProfileDefaults(user) {
  const defaults = loadNewAccountDefaults();
  const profile = defaults.profile || {};
  const userDefaults = defaults.user || {};
  let changed = false;

  changed = setMissing(user, "level", Number(userDefaults.level || 1)) || changed;
  changed = setMissing(user, "exp", String(userDefaults.exp || "0")) || changed;
  changed = setMissing(user, "totalExp", String(userDefaults.totalExp || "0")) || changed;
  changed = setMissing(user, "friendIntro", String(profile.friendIntro || "")) || changed;
  changed = setMissing(user, "mainUnitId", Number(profile.mainUnitId || 0)) || changed;
  changed = setMissing(user, "mainUnitSkinId", Number(profile.mainUnitSkinId || 0)) || changed;
  changed = setMissing(user, "mainUnitTacticLevel", Number(profile.mainUnitTacticLevel || 0)) || changed;
  changed = setMissing(user, "frameId", Number(profile.frameId || 0)) || changed;
  changed = setMissing(user, "selfiFrameId", Number(profile.selfiFrameId || 0)) || changed;
  changed = setMissing(user, "titleId", Number(profile.titleId || 0)) || changed;
  return changed;
}

function seedOfficialRoster(user, options = {}) {
  ensureArmy(user);
  const roster = resolveRosterSeedIds(options.rosterMode);
  const result = {
    changed: false,
    units: seedUnitBucket(user, roster.units, getArmyUnits(user), grantUnit),
    ships: seedUnitBucket(user, roster.ships, getArmyShips(user), grantUnit),
    operators: seedUnitBucket(user, roster.operators, getArmyOperators(user), grantOperator),
    trophies: options.includeTrophies
      ? seedUnitBucket(user, getTrophyUnitIds(), getArmyTrophies(user), grantUnit)
      : 0,
  };
  result.changed = result.units > 0 || result.ships > 0 || result.operators > 0 || result.trophies > 0;
  return result;
}

function resolveRosterSeedIds(rosterMode) {
  if (rosterMode === ROSTER_MODES.ALL) {
    return {
      units: getPlayableUnitIds(),
      ships: getPlayableShipIds(),
      operators: getPlayableOperatorIds(),
    };
  }

  const defaults = loadNewAccountDefaults();
  const roster = defaults.roster && typeof defaults.roster === "object" ? defaults.roster : {};
  return {
    units: uniquePositiveInts(roster.units),
    ships: uniquePositiveInts(roster.ships),
    operators: uniquePositiveInts(roster.operators),
  };
}

function seedUnitBucket(user, ids, existingEntries, grant) {
  const ownedIds = new Set(
    (Array.isArray(existingEntries) ? existingEntries : [])
      .map((entry) => Number(entry && (entry.unitId || entry.id) || 0))
      .filter((id) => Number.isInteger(id) && id > 0)
  );
  let granted = 0;
  const regDate = dateTimeBinaryNow();
  for (const id of Array.isArray(ids) ? ids : []) {
    const unitId = Number(id || 0);
    if (!Number.isInteger(unitId) || unitId <= 0 || ownedIds.has(unitId)) continue;
    const entry = grant(user, unitId, {
      level: 1,
      exp: 0,
      regDate,
      fromContract: true,
    });
    if (!entry) continue;
    ownedIds.add(unitId);
    granted += 1;
  }
  return granted;
}

function rememberBootstrap(user, result, options = {}) {
  user.bootstrap = user.bootstrap && typeof user.bootstrap === "object" ? user.bootstrap : {};
  user.bootstrap[BOOTSTRAP_KEY] = {
    appliedAt: new Date().toISOString(),
    rosterSeeded: options.rosterSeeded === true,
    rosterMode: normalizeRosterMode(options.rosterMode),
    units: Number(result.units || 0),
    ships: Number(result.ships || 0),
    operators: Number(result.operators || 0),
    trophies: Number(result.trophies || 0),
  };
}

function loadNewAccountDefaults() {
  if (cachedDefaults) return cachedDefaults;
  for (const configuredPath of DEFAULTS_PATHS) {
    const filePath = path.resolve(ROOT_DIR, configuredPath);
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        cachedDefaults = parsed;
        return cachedDefaults;
      }
    } catch (_) {
      // Try the next defaults source; the built-in baseline is enough for
      // normal fresh accounts when the legacy gameplay-jsons folder is absent.
    }
  }
  cachedDefaults = BUILTIN_DEFAULTS;
  return cachedDefaults;
}

function normalizeRosterMode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "all" || text === "debug-all") return ROSTER_MODES.ALL;
  if (text === "starter" || text === "safe") return ROSTER_MODES.STARTER;
  return ROSTER_MODES.NONE;
}

function uniquePositiveInts(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  ).sort((a, b) => a - b);
}

function setMissing(target, key, value) {
  if (target[key] !== undefined && target[key] !== null) return false;
  target[key] = value;
  return true;
}

module.exports = {
  ensureOfficialNewAccountDefaults,
};
