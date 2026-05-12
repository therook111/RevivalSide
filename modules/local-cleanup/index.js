const {
  ensureArmy,
  getArmyUnits,
  getArmyShips,
  getArmyOperators,
  removeArmyUnitUids,
  removeOperatorUids,
} = require("../unit");
const { ensureEquipInventory, getEquipItems } = require("../equipment");
const { toBigInt } = require("../packet-codec");

function applyLocalAccountCleanup(user, options = {}) {
  const result = {
    unitsLevel1: 0,
    shipsLevel1: 0,
    operatorsLevel1: 0,
    gearUnenhanced: 0,
    missionStatus: 0,
    changed: false,
  };
  if (!user || typeof user !== "object") return result;

  const clearAllMissionsStatus = optionFlag(
    options.CLEAR_ALL_MISSIONS_STATUS,
    "clearAllMissionsStatus",
    "clearallmissionsstatus",
    "CLEARALLMISSIONSSTATUS",
    "CS_CLEAR_ALL_MISSIONS_STATUS",
    "CS_CLEAR_ALL_MISSION_STATUS"
  );
  const clearUnitsLevel1 = optionFlag(options.CLEAR_UNITS_LEVEL1, "clearUnitsLevel1", "CLEARUNITSLEVEL1", "CS_CLEAR_UNITS_LEVEL1", "CS_CLEAR_UNITS_LEVEL_1");
  const clearGearUnenhanced = optionFlag(options.CLEAR_GEAR_UNENHANCED, "clearGearUnenhanced", "CLEARGEARUNENHANCED", "CS_CLEAR_GEAR_UNENHANCED");
  const clearShipsLevel1 = optionFlag(options.CLEAR_SHIPS_LEVEL1, "clearShipsLevel1", "CLEARSHIPSLEVEL1", "CS_CLEAR_SHIPS_LEVEL1", "CS_CLEAR_SHIPS_LEVEL_1");
  const clearOperatorsLevel1 = optionFlag(
    options.CLEAR_OPERATORS_LEVEL1,
    "clearOperatorsLevel1",
    "CLEAROPERATORSLEVEL1",
    "CS_CLEAR_OPERATORS_LEVEL1",
    "CS_CLEAR_OPERATORS_LEVEL_1"
  );

  if (!clearAllMissionsStatus && !clearUnitsLevel1 && !clearGearUnenhanced && !clearShipsLevel1 && !clearOperatorsLevel1) return result;

  if (clearAllMissionsStatus) {
    result.missionStatus = clearMissionStatus(user);
  }

  if (clearUnitsLevel1 || clearShipsLevel1 || clearOperatorsLevel1) ensureArmy(user);
  if (clearGearUnenhanced) ensureEquipInventory(user);

  const removedUnitUids = [];
  if (clearUnitsLevel1) {
    const unitUids = getArmyUnits(user)
      .filter(isLevelOne)
      .map((unit) => unit.unitUid);
    removedUnitUids.push(...removeArmyUnitUids(user, unitUids));
    result.unitsLevel1 = removedUnitUids.length;
  }

  const removedShipUids = [];
  if (clearShipsLevel1) {
    const shipUids = getArmyShips(user)
      .filter(isLevelOne)
      .map((ship) => ship.unitUid);
    removedShipUids.push(...removeArmyUnitUids(user, shipUids));
    result.shipsLevel1 = removedShipUids.length;
  }

  if (removedUnitUids.length || removedShipUids.length) {
    clearRemovedUnitEquipmentOwners(user, [...removedUnitUids, ...removedShipUids]);
  }

  if (clearOperatorsLevel1) {
    const operatorUids = getArmyOperators(user)
      .filter(isLevelOne)
      .map((operator) => operator.uid || operator.operatorUid);
    result.operatorsLevel1 = removeOperatorUids(user, operatorUids).length;
  }

  if (clearGearUnenhanced) {
    const equipUids = getEquipItems(user)
      .filter(isUnenhancedGear)
      .map((equip) => equip.equipUid);
    result.gearUnenhanced = removeEquipUids(user, equipUids).length;
  }

  result.changed =
    result.unitsLevel1 > 0 ||
    result.shipsLevel1 > 0 ||
    result.operatorsLevel1 > 0 ||
    result.gearUnenhanced > 0 ||
    result.missionStatus > 0;
  if (result.changed) {
    user.localCleanup = user.localCleanup && typeof user.localCleanup === "object" ? user.localCleanup : {};
    user.localCleanup.lastAppliedAt = new Date().toISOString();
    user.localCleanup.lastResult = {
      unitsLevel1: result.unitsLevel1,
      shipsLevel1: result.shipsLevel1,
      operatorsLevel1: result.operatorsLevel1,
      gearUnenhanced: result.gearUnenhanced,
      missionStatus: result.missionStatus,
    };
  }
  return result;
}

function clearMissionStatus(user) {
  if (!user || typeof user !== "object") return 0;
  let cleared = 0;
  if (user.completedMissions && typeof user.completedMissions === "object") {
    cleared += Object.keys(user.completedMissions).length;
  }
  if (user.missionCounters && typeof user.missionCounters === "object") {
    cleared += Object.keys(user.missionCounters).length;
  }
  if (Array.isArray(user.missionLoginDays)) cleared += user.missionLoginDays.length;
  if (Number(user.dailyMissionPoint || 0) > 0) cleared += 1;
  if (Number(user.weeklyMissionPoint || 0) > 0) cleared += 1;
  user.completedMissions = {};
  user.missionCounters = {};
  user.missionLoginDays = [];
  user.dailyMissionPoint = 0;
  user.weeklyMissionPoint = 0;
  return cleared;
}

function optionFlag(value, ...envKeys) {
  if (value != null) return truthy(value);
  return envKeys.some((key) => truthy(process.env[key]));
}

function truthy(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isLevelOne(entry) {
  return Number(entry && (entry.level != null ? entry.level : entry.m_UnitLevel != null ? entry.m_UnitLevel : 1)) === 1;
}

function isUnenhancedGear(equip) {
  if (!equip || typeof equip !== "object") return false;
  const enchantLevel = Number(equip.enchantLevel != null ? equip.enchantLevel : equip.m_EnchantLevel || 0) || 0;
  const enchantExp = Number(equip.enchantExp != null ? equip.enchantExp : equip.m_EnchantExp || 0) || 0;
  return enchantLevel <= 0 && enchantExp <= 0;
}

function removeEquipUids(user, equipUids) {
  const inventory = ensureEquipInventory(user);
  const keys = uniqueUidStrings(equipUids);
  if (!keys.length) return [];

  clearEquipRefs(user, keys);
  const removed = [];
  for (const key of keys) {
    if (!inventory.equips[key]) continue;
    delete inventory.equips[key];
    removed.push(key);
  }
  if (removed.length) inventory.localTouchedAt = new Date().toISOString();
  return removed;
}

function clearRemovedUnitEquipmentOwners(user, unitUids) {
  const removed = new Set(uniqueUidStrings(unitUids));
  if (!removed.size) return;
  const inventory = ensureEquipInventory(user);
  for (const equip of Object.values(inventory.equips || {})) {
    if (!equip || typeof equip !== "object") continue;
    if (removed.has(String(toBigInt(equip.ownerUnitUid || 0)))) equip.ownerUnitUid = "-1";
  }
  inventory.localTouchedAt = new Date().toISOString();
}

function clearEquipRefs(user, equipUids) {
  const removed = new Set(uniqueUidStrings(equipUids));
  if (!removed.size) return;
  const army = ensureArmy(user);
  for (const unit of [...Object.values(army.units || {}), ...Object.values(army.ships || {})]) {
    if (!unit || !Array.isArray(unit.equipItemUids)) continue;
    unit.equipItemUids = unit.equipItemUids.map((uid) => (removed.has(String(toBigInt(uid || 0))) ? 0 : uid));
  }

  const inventory = ensureEquipInventory(user);
  for (const preset of inventory.equipPresets || []) {
    if (!preset || !Array.isArray(preset.equipUids)) continue;
    preset.equipUids = preset.equipUids.map((uid) => (removed.has(String(toBigInt(uid || 0))) ? 0 : uid));
  }
}

function uniqueUidStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(toBigInt(value || 0)))
        .filter((value) => value !== "0")
    )
  );
}

module.exports = {
  applyLocalAccountCleanup,
};
