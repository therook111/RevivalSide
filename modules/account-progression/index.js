const { dateTimeBinaryNow, toBigInt } = require("../packet-codec");
const {
  getEquipTemplet,
  getMissionTemplet,
  getMissionTemplets,
  getMissionTempletsByTabId,
  getMissionTabTemplet,
  getPlayerExpRecord,
  getPlayerLevelByTotalExp,
  getPlayerMaxLevel,
  getPlayerRequiredExpForLevel,
  getPlayerTotalExpForLevel,
} = require("../game-data");
const { getMiscItem, getMiscItems, getSkinIds, spendMiscItem } = require("../inventory");
const { getArmyUnits, getArmyShips, getArmyOperators } = require("../unit");
const { getEquipItems } = require("../equipment");
const {
  mergeReward,
  grantRewardByType,
} = require("../reward");

const CONFIGURED_MAX_USER_LEVEL = Number(process.env.CS_MAX_USER_LEVEL || 0);
const DEFAULT_MISSION_EXP = Number(process.env.CS_DEFAULT_MISSION_EXP || 50);
const DEFAULT_STAGE_EXP = Number(process.env.CS_DEFAULT_STAGE_EXP || 75);
const DEFAULT_ACHIEVEMENT_POINT = Number(process.env.CS_DEFAULT_ACHIEVEMENT_POINT || 10);
const DEFAULT_PROFILE_EMBLEM_SLOTS = Number(process.env.CS_PROFILE_EMBLEM_SLOTS || 3);
const ACHIEVEMENT_POINT_ITEM_ID = 202;
const DAILY_MISSION_POINT_ID = 203;
const WEEKLY_MISSION_POINT_ID = 204;
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_TICKS_MASK = 0x3fffffffffffffffn;
const MAX_CLAIM_ALL_PASSES = 512;
let missionIdsWithMultipleGroups = null;

function ensureAccountProgress(user) {
  if (!user || typeof user !== "object") return user;
  normalizeUserLevelExp(user);
  user.achievePoint = String(nonNegativeBigInt(user.achievePoint));
  user.completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  user.missionCounters = user.missionCounters && typeof user.missionCounters === "object" ? user.missionCounters : {};
  user.missionLoginDays = Array.isArray(user.missionLoginDays) ? user.missionLoginDays : [];
  user.dailyMissionPoint = nonNegativeInt(user.dailyMissionPoint);
  user.weeklyMissionPoint = nonNegativeInt(user.weeklyMissionPoint);
  user.eventPassExp = nonNegativeInt(user.eventPassExp);
  user.craft = user.craft && typeof user.craft === "object" ? user.craft : {};
  user.craft.molds = user.craft.molds && typeof user.craft.molds === "object" ? user.craft.molds : {};
  user.bingoTiles = user.bingoTiles && typeof user.bingoTiles === "object" ? user.bingoTiles : {};
  user.profileEmblems = normalizeEmblems(user.profileEmblems);
  user.friendIntro = String(user.friendIntro || "");
  user.selfiFrameId = Number(user.selfiFrameId || user.frameId || 0) || 0;
  user.frameId = Number(user.frameId || user.selfiFrameId || 0) || 0;
  user.titleId = Number(user.titleId || 0) || 0;
  user.mainUnitId = Number(user.mainUnitId || 0) || 0;
  user.mainUnitSkinId = Number(user.mainUnitSkinId || 0) || 0;
  user.mainUnitTacticLevel = Number(user.mainUnitTacticLevel || 0) || 0;
  return user;
}

function grantUserExp(user, amount, options = {}) {
  ensureAccountProgress(user);
  const grant = nonNegativeInt(amount);
  if (!user || grant <= 0) {
    return {
      userExp: 0,
      beforeLevel: user ? Number(user.level || 1) : 1,
      afterLevel: user ? Number(user.level || 1) : 1,
      beforeExp: user ? nonNegativeInt(user.exp) : 0,
      afterExp: user ? nonNegativeInt(user.exp) : 0,
      leveledUp: false,
    };
  }

  const beforeLevel = clampInt(user.level, 1, getMaxUserLevel());
  const beforeExp = nonNegativeInt(user.exp);
  const next = splitUserTotalExp(nonNegativeBigInt(user.totalExp) + BigInt(grant));

  user.level = next.level;
  user.exp = String(next.exp);
  user.totalExp = String(next.totalExp);
  if (options.reason) user.lastExpReason = String(options.reason);
  user.lastExpAt = new Date().toISOString();

  return {
    userExp: grant,
    beforeLevel,
    afterLevel: next.level,
    beforeExp,
    afterExp: next.exp,
    leveledUp: next.level > beforeLevel,
  };
}

function expToNextLevel(level) {
  const current = Math.max(1, Number(level) || 1);
  const tableValue = getPlayerRequiredExpForLevel(current);
  if (tableValue > 0 || getPlayerExpRecord(current)) return tableValue;
  return Math.max(100, 100 + (current - 1) * 50);
}

function normalizeUserLevelExp(user) {
  if (!user || typeof user !== "object") return user;
  const maxLevel = getMaxUserLevel();
  const storedLevel = clampInt(user.level, 1, maxLevel);
  const storedExp = nonNegativeInt(user.exp);
  const storedTotalExp = nonNegativeBigInt(user.totalExp);
  const levelTotalExp = BigInt(getPlayerTotalExpForLevel(storedLevel) + storedExp);
  const normalized = splitUserTotalExp(storedTotalExp > levelTotalExp ? storedTotalExp : levelTotalExp, maxLevel);
  user.level = normalized.level;
  user.exp = String(normalized.exp);
  user.totalExp = String(normalized.totalExp);
  return user;
}

function splitUserTotalExp(totalExp, maxLevel = getMaxUserLevel()) {
  const cap = clampInt(maxLevel, 1, getPlayerMaxLevel() || Number(maxLevel) || 1);
  const maxTotalExp = BigInt(getPlayerTotalExpForLevel(cap));
  const rawTotalExp = nonNegativeBigInt(totalExp);
  const boundedTotalExp = maxTotalExp > 0n && rawTotalExp > maxTotalExp ? maxTotalExp : rawTotalExp;
  const total = Number(boundedTotalExp);
  const level = getPlayerLevelByTotalExp(total, cap);
  const baseTotal = getPlayerTotalExpForLevel(level);
  const required = expToNextLevel(level);
  const exp =
    level >= cap || required <= 0
      ? 0
      : Math.max(0, Math.min(required - 1, total - baseTotal));
  return {
    level,
    exp,
    totalExp: BigInt(baseTotal + exp),
  };
}

function getMaxUserLevel() {
  const tableMax = getPlayerMaxLevel() || 120;
  const configured = Math.trunc(Number(CONFIGURED_MAX_USER_LEVEL) || 0);
  if (configured > 0) return Math.max(1, Math.min(configured, tableMax));
  return tableMax;
}

function getMissionRowForRequest(request = {}, user = null) {
  const missionID = Number(request.missionID || request.missionId || request.id || 0);
  const tabId = Number(request.tabId || 0);
  const groupId = Number(request.groupId || request.group_id || 0);
  if (!Number.isInteger(missionID) || missionID <= 0) return null;
  if (tabId <= 0 && groupId <= 0) {
    const direct = getMissionTemplet(missionID);
    return direct && direct.m_Enabled !== false ? direct : null;
  }

  const candidates = (tabId > 0 ? getMissionTempletsByTabId(tabId) : [getMissionTemplet(missionID)])
    .filter((row) => row && Number(row.m_MissionID) === missionID && row.m_Enabled !== false);
  if (groupId > 0) {
    const grouped = candidates.find((row) => Number(row && row.m_MissionCounterGroupID) === groupId);
    if (grouped) return grouped;
  }
  if (user && user.completedMissions && candidates.length > 1) {
    const claimable = candidates.find((row) => {
      const state = buildEvaluatedMissionState(user, row, {});
      return (
        Number(state.groupId || row.m_MissionCounterGroupID || 0) === Number(row && row.m_MissionCounterGroupID || 0) &&
        state.rewardClaimed !== true &&
        (state.rewardReady === true || Number(state.times || 0) >= missionTargetTimes(row))
      );
    });
    if (claimable) return claimable;
  }
  return candidates[0] || getMissionTemplet(missionID);
}

function missionGroupId(row) {
  const missionID = Number(row && row.m_MissionID) || 0;
  return Number(row && row.m_MissionCounterGroupID) || missionID;
}

function missionStorageKeyForRow(row) {
  const missionID = Number(row && row.m_MissionID) || 0;
  if (!missionID) return "";
  return missionIdHasMultipleGroups(missionID) ? `${missionID}:${missionGroupId(row)}` : String(missionID);
}

function missionIdHasMultipleGroups(missionID) {
  if (!missionIdsWithMultipleGroups) {
    const groupsByMission = new Map();
    for (const row of getMissionTemplets()) {
      const id = Number(row && row.m_MissionID) || 0;
      if (!id) continue;
      if (!groupsByMission.has(id)) groupsByMission.set(id, new Set());
      groupsByMission.get(id).add(missionGroupId(row));
    }
    missionIdsWithMultipleGroups = new Set(
      Array.from(groupsByMission.entries())
        .filter(([, groups]) => groups.size > 1)
        .map(([id]) => id)
    );
  }
  return missionIdsWithMultipleGroups.has(Number(missionID) || 0);
}

function getStoredMissionState(user, row) {
  if (!user || !row) return {};
  const missionID = Number(row.m_MissionID || 0);
  const exactKey = missionStorageKeyForRow(row);
  const exact = exactKey ? user.completedMissions[exactKey] : null;
  if (exact) return exact;
  const legacy = user.completedMissions[String(missionID)] || {};
  if (!legacy || !Object.keys(legacy).length) return {};
  if (!missionIdHasMultipleGroups(missionID)) return legacy;
  return Number(legacy.groupId || missionGroupId(row)) === missionGroupId(row) ? legacy : {};
}

function setStoredMissionState(user, row, state) {
  if (!user || !row || !state) return;
  const key = missionStorageKeyForRow(row);
  if (!key) return;
  user.completedMissions[key] = state;
  const missionID = Number(row.m_MissionID || 0);
  const legacyKey = String(missionID);
  if (key !== legacyKey && user.completedMissions[legacyKey]) {
    const legacy = user.completedMissions[legacyKey];
    if (!legacy || Number(legacy.groupId || missionGroupId(row)) === missionGroupId(row)) {
      delete user.completedMissions[legacyKey];
    }
  }
}

function completeMission(user, request = {}, options = {}) {
  ensureAccountProgress(user);
  const missionID = Number(request.missionID || request.missionId || request.id || 0);
  const row = getMissionRowForRequest(request, user);
  if (!user || !Number.isInteger(missionID) || missionID <= 0 || !row) return emptyMissionResult(request);
  return completeMissionRow(user, row, request, options);
}

function completeMissionRow(user, row, request = {}, options = {}) {
  ensureAccountProgress(user);
  const missionID = Number(row && row.m_MissionID || request.missionID || request.missionId || request.id || 0);
  if (!user || !Number.isInteger(missionID) || missionID <= 0 || !row) return emptyMissionResult(request);
  const state = buildEvaluatedMissionState(user, row, { now: options.now });
  const forceTutorialComplete = isTutorialMissionRow(row);
  if (forceTutorialComplete && state.rewardClaimed !== true) {
    state.times = Math.max(Number(state.times || 0), missionTargetTimes(row));
    state.rewardReady = true;
    state.completedAt = state.completedAt || new Date().toISOString();
  }
  if (state.rewardClaimed === true || (!forceTutorialComplete && Number(state.times || 0) < missionTargetTimes(row))) {
    return {
      missionID,
      tabId: state.tabId,
      groupId: state.groupId,
      changed: false,
      exp: { userExp: 0 },
      reward: emptyReward(),
      mission: state,
    };
  }

  const reward = grantMissionRewards(user, row, options);
  state.rewardClaimed = true;
  state.rewardReady = true;
  state.isComplete = true;
  state.claimedAt = new Date().toISOString();
  state.lastUpdateDate = missionDateTicks(options.now);
  setStoredMissionState(user, row, state);

  return {
    missionID,
    tabId: state.tabId,
    groupId: state.groupId,
    changed: true,
    exp: { userExp: Number(reward.userExp || 0) },
    reward,
    mission: state,
  };
}

function isTutorialMissionRow(row) {
  if (!row) return false;
  if (normalizeMissionCondition(row.m_MissionCond) === "TUTORIAL") return true;
  const tab = getMissionTabTemplet(Number(row.m_MissionTabId) || 0);
  const tabName = String((tab && (tab.m_MissionTab || tab.m_MissionType)) || row.m_MissionTab || "").toUpperCase();
  return tabName === "TUTORIAL" || tabName === "TAB_TUTORIAL";
}

function completeAllMissionsForTab(user, tabId, options = {}) {
  ensureAccountProgress(user);
  const numericTabId = Number(tabId || 0);
  if (!user || !Number.isInteger(numericTabId) || numericTabId <= 0) {
    return { missionIDs: [], reward: emptyReward(), tabId: numericTabId };
  }

  refreshMissionProgress(user, { now: options.now, tabId: numericTabId });
  const groupedRows = buildMissionRowsByGroupForTab(numericTabId);
  const missionIDs = [];
  const seenMissionKeys = new Set();
  const reward = emptyReward();

  for (let pass = 0; pass < MAX_CLAIM_ALL_PASSES; pass += 1) {
    let claimedThisPass = 0;
    for (const group of groupedRows) {
      for (let groupPass = 0; groupPass < group.rows.length; groupPass += 1) {
        const claimable = findClaimableMissionInGroup(user, group, { now: options.now });
        const claimKey = claimable ? `${Number(claimable.mission.missionID || 0)}:${Number(claimable.mission.groupId || 0)}` : "";
        if (!claimable || seenMissionKeys.has(claimKey)) break;
        const result = completeMissionRow(user, claimable.row, claimable.mission, options);
        const missionID = Number(result.missionID || 0);
        if (!missionID || result.changed !== true || seenMissionKeys.has(claimKey)) break;
        group.cursor = claimable.index + 1;
        seenMissionKeys.add(claimKey);
        missionIDs.push(missionID);
        mergeMissionReward(reward, result.reward);
        claimedThisPass += 1;
      }
    }
    if (claimedThisPass <= 0) break;
  }

  return { missionIDs, reward, tabId: numericTabId };
}

function buildMissionRowsByGroupForTab(tabId) {
  const numericTabId = Number(tabId || 0);
  const rowsByGroup = new Map();
  for (const row of getMissionTempletsByTabId(numericTabId)) {
    if (!row || row.m_Enabled === false) continue;
    const groupId = Number(row.m_MissionCounterGroupID || row.m_MissionID || 0);
    if (!Number.isInteger(groupId) || groupId <= 0) continue;
    if (!rowsByGroup.has(groupId)) rowsByGroup.set(groupId, []);
    rowsByGroup.get(groupId).push(row);
  }
  return Array.from(rowsByGroup.entries())
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([groupId, rows]) => ({ groupId, rows: rows.sort(compareMissionRows), cursor: 0 }));
}

function findClaimableMissionInGroup(user, group, options = {}) {
  const rows = Array.isArray(group) ? group : Array.isArray(group && group.rows) ? group.rows : [];
  const startIndex = Array.isArray(group) ? 0 : Math.max(0, Number(group.cursor || 0) || 0);
  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index];
    const state = buildEvaluatedMissionState(user, row, { now: options.now });
    if (state.rewardClaimed === true) {
      if (!Array.isArray(group)) group.cursor = index + 1;
      continue;
    }
    if (!Array.isArray(group)) group.cursor = index;
    if (!missionRequirementSatisfied(user, row)) continue;
    if (Number(state.times || 0) < missionTargetTimes(row)) return null;
    return { row, mission: state, index };
  }
  return null;
}

function updateMissionProgress(user, request = {}, options = {}) {
  ensureAccountProgress(user);
  const missionID = Number(request.missionID || request.missionId || request.id || 0);
  if (!user || !Number.isInteger(missionID) || missionID <= 0) return null;
  const row = getMissionRowForRequest(request, user);
  const existing = row ? getStoredMissionState(user, row) : user.completedMissions[String(missionID)] || {};
  const tabId = Number(request.tabId || existing.tabId || options.tabId || (row && row.m_MissionTabId) || 1) || 1;
  const groupId = Number(request.groupId || existing.groupId || options.groupId || (row && row.m_MissionCounterGroupID) || missionID) || missionID;
  const times = Math.max(Number(existing.times || 0), Number(request.times || options.times || 1));
  const mission = {
    tabId,
    groupId,
    missionID,
    times,
    targetTimes: Number((row && row.m_Times) || existing.targetTimes || times || 1),
    lastUpdateDate: missionDateTicks(options.now),
    rewardReady: Boolean(options.rewardReady != null ? options.rewardReady : existing.rewardReady),
    isComplete: Boolean(options.isComplete != null ? options.isComplete : existing.isComplete),
    rewardClaimed: Boolean(existing.rewardClaimed || options.rewardClaimed),
    completedAt: existing.completedAt || "",
    claimedAt: existing.claimedAt || "",
    resetKey: row ? currentResetKey(row, options.now) : existing.resetKey || "",
  };
  if (row) setStoredMissionState(user, row, mission);
  else user.completedMissions[String(missionID)] = mission;
  return mission;
}

function donateMissionItem(user, request = {}, options = {}) {
  ensureAccountProgress(user);
  const missionID = Number(request.missionID || request.missionId || request.id || 0);
  const row = getMissionRowForRequest(request, user);
  if (!user || !Number.isInteger(missionID) || missionID <= 0 || !row) {
    return { missionID, itemId: 0, count: 0, costItems: [], mission: null };
  }

  const condition = normalizeMissionCondition(row.m_MissionCond);
  if (condition !== "DONATE_MISSION_ITEM") {
    const mission = buildEvaluatedMissionState(user, row, { now: options.now });
    return { missionID, itemId: 0, count: 0, costItems: [], mission };
  }

  const itemId = primaryMissionValue(row, 0);
  const requested = nonNegativeInt(request.count);
  if (!itemId || requested <= 0) {
    const mission = buildEvaluatedMissionState(user, row, { now: options.now });
    return { missionID, itemId, count: 0, costItems: [], mission };
  }

  const current = getMiscItem(user, itemId);
  const owned = Number(nonNegativeBigInt(current && current.countFree) + nonNegativeBigInt(current && current.countPaid));
  const donated = Math.max(0, Math.min(requested, Number.isFinite(owned) ? owned : requested));
  const regDate = options.now || dateTimeBinaryNow();
  const updatedItem = donated > 0 ? spendMiscItem(user, itemId, donated, { regDate }) : current;
  if (donated > 0) {
    trackMissionEvent(user, "DONATE_MISSION_ITEM", donated, { now: options.now, itemId, value: itemId });
  }
  const mission = buildEvaluatedMissionState(user, row, { now: options.now });
  return {
    missionID,
    tabId: mission.tabId,
    groupId: mission.groupId,
    itemId,
    count: donated,
    costItems: updatedItem ? [updatedItem] : [],
    mission,
  };
}

function refreshMissionProgress(user, options = {}) {
  ensureAccountProgress(user);
  const now = options.now || dateTimeBinaryNow();
  const filterTabId = Number(options.tabId || 0);
  const conditionFilter = normalizeMissionConditionFilter(options.conditions || options.condition);
  const rows = (filterTabId > 0 ? getMissionTempletsByTabId(filterTabId) : getMissionTemplets()).filter(
    (row) => !conditionFilter.size || conditionFilter.has(normalizeMissionCondition(row && row.m_MissionCond))
  );
  const fullScan = filterTabId <= 0 && conditionFilter.size <= 0;
  const seen = new Set();
  for (const row of rows) {
    if (!row || row.m_Enabled === false) continue;
    const missionID = Number(row.m_MissionID || 0);
    if (!missionID) continue;
    const key = missionStorageKeyForRow(row) || String(missionID);
    seen.add(key);
    const existing = getStoredMissionState(user, row);
    const state = buildEvaluatedMissionState(user, row, { now });
    if (shouldPersistMissionState(state, existing)) {
      setStoredMissionState(user, row, state);
    } else {
      delete user.completedMissions[key];
    }
  }
  for (const [missionID, state] of Object.entries(user.completedMissions)) {
    if (seen.has(String(missionID))) continue;
    if (!fullScan && Number(state && state.tabId || 0) !== filterTabId) continue;
    if (!state || !(state.rewardClaimed === true || state.isComplete === true || state.claimedAt)) {
      delete user.completedMissions[String(missionID)];
    }
  }
  return user.completedMissions;
}

function buildEvaluatedMissionState(user, row, options = {}) {
  const state = ensureMissionState(user, row, options);
  const progress = Math.max(Number(state.times || 0), evaluateMissionProgress(user, row, options));
  state.times = progress;
  state.targetTimes = missionTargetTimes(row);
  state.rewardReady = progress >= state.targetTimes;
  if (progress >= state.targetTimes) {
    state.completedAt = state.completedAt || new Date().toISOString();
  }
  state.isComplete = state.rewardClaimed === true;
  return state;
}

function shouldPersistMissionState(state, existing = {}) {
  if (!state) return false;
  if (state.rewardClaimed === true || (state.isComplete === true && state.claimedAt)) return true;
  if (existing.rewardClaimed === true || (existing.isComplete === true && existing.claimedAt)) return true;
  if (existing.isComplete === true) return true;
  return false;
}

function recordMissionLogin(user, options = {}) {
  ensureAccountProgress(user);
  const dayKey = localDayKey(options.now || Date.now());
  if (!dayKey) return false;
  user.missionLoginDays = Array.isArray(user.missionLoginDays) ? user.missionLoginDays : [];
  if (user.missionLoginDays.includes(dayKey)) return false;
  user.missionLoginDays.push(dayKey);
  user.missionLoginDays = Array.from(new Set(user.missionLoginDays)).sort();
  trackMissionEvent(user, "LOGIN_DAYS", 1, { now: options.now, uniqueKey: dayKey });
  trackMissionEvent(user, "LOGIN_TIMES", 1, { now: options.now, uniqueKey: dayKey });
  return true;
}

function trackMissionEvent(user, condition, amount = 1, details = {}) {
  ensureAccountProgress(user);
  const delta = Math.max(0, Math.trunc(Number(amount || 0) || 0));
  if (!user || delta <= 0) return false;
  const normalized = normalizeMissionCondition(condition);
  if (!normalized) return false;
  let changed = false;
  for (const scope of ["total", currentDailyCounterKey(details.now), currentWeeklyCounterKey(details.now)]) {
    changed = incrementMissionCounter(user, scope, normalized, delta, details) || changed;
  }
  return changed;
}

function incrementMissionCounter(user, scope, condition, amount, details = {}) {
  user.missionCounters = user.missionCounters && typeof user.missionCounters === "object" ? user.missionCounters : {};
  user.missionCounters[scope] =
    user.missionCounters[scope] && typeof user.missionCounters[scope] === "object" ? user.missionCounters[scope] : {};
  const counters = user.missionCounters[scope];
  const keys = [condition];
  const valueKeys = normalizeNumberList([details.value, details.itemId, details.resourceId, details.dungeonId, details.stageId, details.unitId]);
  for (const key of valueKeys) keys.push(`${condition}:${key}`);
  let changed = false;
  for (const key of keys) {
    const previous = Number(counters[key] || 0);
    counters[key] = previous + amount;
    changed = true;
  }
  return changed;
}

function ensureMissionState(user, row, options = {}) {
  const missionID = Number(row && row.m_MissionID);
  const resetKey = currentResetKey(row, options.now);
  const existing = getStoredMissionState(user, row);
  const resetChanged = existing.resetKey && resetKey && existing.resetKey !== resetKey;
  if (resetChanged) {
    return createMissionState(row, { now: options.now, resetKey });
  }
  const state = {
    ...createMissionState(row, { now: options.now, resetKey }),
    ...existing,
    tabId: Number(existing.tabId || row.m_MissionTabId || 1) || 1,
    groupId: Number(existing.groupId || row.m_MissionCounterGroupID || missionID) || missionID,
    missionID,
    resetKey,
  };
  state.times = Math.max(0, Number(existing.times || 0));
  state.targetTimes = missionTargetTimes(row);
  state.rewardClaimed = Boolean(existing.rewardClaimed || (existing.isComplete === true && existing.claimedAt));
  state.rewardReady = Boolean(existing.rewardReady || Number(state.times || 0) >= state.targetTimes);
  state.isComplete = state.rewardClaimed === true;
  state.lastUpdateDate = missionDateTicks(existing.lastUpdateDate || options.now);
  return state;
}

function createMissionState(row, options = {}) {
  const missionID = Number(row && row.m_MissionID);
  return {
    tabId: Number(row && row.m_MissionTabId) || 1,
    groupId: Number(row && row.m_MissionCounterGroupID) || missionID,
    missionID,
    times: 0,
    targetTimes: missionTargetTimes(row),
    lastUpdateDate: missionDateTicks(options.now),
    rewardReady: false,
    isComplete: false,
    rewardClaimed: false,
    completedAt: "",
    claimedAt: "",
    resetKey: options.resetKey || currentResetKey(row, options.now),
  };
}

function evaluateMissionProgress(user, row, options = {}) {
  const condition = normalizeMissionCondition(row && row.m_MissionCond);
  const target = missionTargetTimes(row);
  if (!condition) return 0;
  if (condition === "JUST_OPEN") return target;
  if (condition === "TUTORIAL") return isTutorialMissionComplete(user, row) ? target : 0;
  if (condition === "ACCOUNT_LEVEL") return Number(user && user.level) || 1;
  if (condition === "LOGIN_DAYS") return countLoginDays(user, row, options.now);
  if (condition === "LOGIN_TIMES") return countLoginDays(user, row, options.now) > 0 ? 1 : 0;
  if (condition === "HAVE_DAILY_POINT") return Number(user.dailyMissionPoint || 0);
  if (condition === "HAVE_WEEKLY_POINT") return Number(user.weeklyMissionPoint || 0);
  if (condition === "ACHIEVEMENT_CLEAR" || condition === "ACHIEVEMENT_CLEARED") return countClaimedMissions(user, { tabId: 4 });
  if (condition === "MISSION_EVENT_TAB_CLEAR") return countClaimedMissions(user, { tabIds: missionValueNumbers(row) });
  if (condition === "MISSION_CLEAR") return countClaimedMissions(user);

  const scopedCounter = getMissionScopedCounter(user, row, condition, options.now);
  const derived = evaluateDerivedMissionProgress(user, row, condition);
  return Math.max(scopedCounter, derived);
}

function evaluateDerivedMissionProgress(user, row, condition) {
  switch (condition) {
    case "DUNGEON_CLEAR":
    case "DUNGEON_CLEARED":
    case "WARFARE_CLEAR":
    case "WARFARE_CLEARED":
    case "PHASE_CLEAR":
    case "PHASE_CLEARED":
      if (isPeriodicMission(row)) return 0;
      return missionValueNumbers(row).length ? countClearedDungeons(user, missionValueNumbers(row)) : countClearedDungeons(user);
    case "DUNGEON_CLEAR_PERFECT":
    case "WARFARE_CLEAR_PERFECT":
    case "WARFARE_CLEARED_PERFECT":
    case "PHASE_CLEAR_PERFECT":
    case "PHASE_CLEARED_PERFECT":
      if (isPeriodicMission(row)) return 0;
      return missionValueNumbers(row).length ? countPerfectDungeons(user, missionValueNumbers(row)) : countPerfectDungeons(user);
    case "COLLECT_RESOURCE":
      return countOwnedMisc(user, missionValueNumbers(row));
    case "UNIT_GROWTH_GET":
    case "COLLECT_UNIT":
      return getArmyUnits(user).length;
    case "UNIT_CONTRACT":
      if (isPeriodicMission(row)) return 0;
      return getArmyUnits(user).filter((unit) => unit && unit.fromContract !== false).length;
    case "UNIT_GROWTH_LEVEL":
      return countUnitsAtLevel(user, missionSecondaryValue(row, missionTargetTimes(row)), primaryMissionValues(row));
    case "COLLECT_UNIT_LEVEL":
      return countUnitsAtLevel(user, primaryMissionValue(row, missionTargetTimes(row)));
    case "COLLECT_SHIP_LEVEL":
      return countShipsAtLevel(user, primaryMissionValue(row, missionTargetTimes(row)));
    case "SHIP_LEVELUP":
      return countShipsAtLevel(user, primaryMissionValue(row, missionTargetTimes(row)));
    case "COLLECT_OPR_LEVEL":
      return countOperatorsAtLevel(user, primaryMissionValue(row, missionTargetTimes(row)));
    case "UNIT_LIMITBREAK_CONFLUENCE":
      return sumUnitsByMinimumField(user, "limitBreakLevel", 1);
    case "UNIT_LIMITBREAK":
      return sumUnitsByMinimumField(user, "limitBreakLevel", 1);
    case "UNIT_GROWTH_LIMIT":
      return countUnitsByMinimumField(user, "limitBreakLevel", missionSecondaryValue(row, 1), primaryMissionValues(row));
    case "UNIT_GROWTH_TACTICAL":
      return countUnitsByMinimumField(user, "tacticLevel", missionSecondaryValue(row, 1), primaryMissionValues(row));
    case "COLLECT_UNIT_TACTICS_LEVEL":
      return countUnitsByMinimumField(user, "tacticLevel", primaryMissionValue(row, 1));
    case "UNIT_GROWTH_LOYALTY":
      return countUnitsByMinimumField(
        user,
        "loyalty",
        normalizeLoyaltyTarget(missionSecondaryValue(row, 100)),
        primaryMissionValues(row)
      );
    case "UNIT_GROWTH_PERMANENT":
      return countPermanentUnits(user, primaryMissionValues(row));
    case "UNIT_GROWTH_SKILL_LEVEL_3":
      return countUnitsBySkillLevel(user, 3, primaryMissionValues(row), secondaryMissionValues(row));
    case "UNIT_GROWTH_SKILL_LEVEL_MAX":
      return countUnitsBySkillLevel(user, 5, primaryMissionValues(row), secondaryMissionValues(row));
    case "COLLECT_EQUIP":
      return getEquipItems(user).length;
    case "COLLECT_EQUIP_ENCHANT_LEVEL":
      return countEquipsByMinimumField(user, "enchantLevel", primaryMissionValue(row, missionTargetTimes(row)));
    case "COLLECT_EQUIP_TIER":
      return countEquipsByTier(user, primaryMissionValue(row, 1));
    case "GET_SKIN":
      return getSkinIds(user).length;
    default:
      return 0;
  }
}

function getMissionScopedCounter(user, row, condition, now) {
  const scope = counterScopeForMission(row, now);
  const counters = user && user.missionCounters && user.missionCounters[scope] ? user.missionCounters[scope] : {};
  const values = missionValueNumbers(row);
  if (!values.length) return Number(counters[condition] || 0);
  return Math.max(...values.map((value) => Number(counters[`${condition}:${value}`] || 0)), 0);
}

function grantMissionRewards(user, row, options = {}) {
  const reward = emptyReward();
  const ctx = options.ctx || {};
  const regDate = options.now || (ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow());
  for (let index = 1; index <= 3; index += 1) {
    const type = String(row[`m_RewardType_${index}`] || "");
    const id = Number(row[`m_RewardID_${index}`] || 0);
    const value = Math.max(0, Number(row[`m_RewardValue_${index}`] || 0) || 0);
    if (!type || type === "RT_NONE" || value <= 0) continue;
    if (type === "RT_USER_EXP") {
      const exp = grantUserExp(user, value, { reason: `mission:${Number(row.m_MissionID || 0)}` });
      reward.userExp += Number(exp.userExp || 0);
    } else if (type === "RT_MISSION_POINT") {
      grantMissionPoint(user, id, value, reward, { now: regDate });
    } else if (type === "RT_MISC" && id === ACHIEVEMENT_POINT_ITEM_ID) {
      reward.achievePoint = String(nonNegativeBigInt(reward.achievePoint) + BigInt(value));
      user.achievePoint = String(nonNegativeBigInt(user.achievePoint) + BigInt(value));
    } else if (type === "RT_PASS_EXP") {
      grantEventPassExp(user, id, value, reward);
    } else if (type === "RT_MOLD") {
      grantMoldItem(user, id, value, reward);
    } else if (type === "RT_BINGO_TILE") {
      grantBingoTile(user, id, value, reward);
    } else {
      mergeMissionReward(
        reward,
        grantRewardByType(ctx, user, type, id, value, value, 0, {
          regDate,
          expandPackages: true,
        })
      );
    }
  }
  return reward;
}

function grantMissionPoint(user, pointId, value, reward, options = {}) {
  if (pointId === DAILY_MISSION_POINT_ID) {
    user.dailyMissionPoint = nonNegativeInt(user.dailyMissionPoint) + value;
    reward.dailyMissionPoint = Number(reward.dailyMissionPoint || 0) + value;
    trackMissionEvent(user, "HAVE_DAILY_POINT", value, { now: options.now });
  } else if (pointId === WEEKLY_MISSION_POINT_ID) {
    user.weeklyMissionPoint = nonNegativeInt(user.weeklyMissionPoint) + value;
    reward.weeklyMissionPoint = Number(reward.weeklyMissionPoint || 0) + value;
    trackMissionEvent(user, "HAVE_WEEKLY_POINT", value, { now: options.now });
  } else {
    mergeMissionReward(reward, grantRewardByType({}, user, "RT_MISC", pointId, value, value, 0, { regDate: options.now }));
  }
}

function mergeMissionReward(target, source) {
  mergeReward(target, source);
  const incoming = source || {};
  target.userExp = Number(target.userExp || 0) + Number(incoming.userExp || 0);
  target.bonusRatioOfUserExp = Number(target.bonusRatioOfUserExp || 0) + Number(incoming.bonusRatioOfUserExp || 0);
  target.dailyMissionPoint = Number(target.dailyMissionPoint || 0) + Number(incoming.dailyMissionPoint || 0);
  target.weeklyMissionPoint = Number(target.weeklyMissionPoint || 0) + Number(incoming.weeklyMissionPoint || 0);
  target.achievePoint = String(nonNegativeBigInt(target.achievePoint) + nonNegativeBigInt(incoming.achievePoint));
  target.eventPassExpDelta = Number(target.eventPassExpDelta || 0) + Number(incoming.eventPassExpDelta || 0);
  if (!Array.isArray(target.moldItems)) target.moldItems = [];
  if (!Array.isArray(target.bingoTiles)) target.bingoTiles = [];
  if (Array.isArray(incoming.moldItems)) target.moldItems.push(...incoming.moldItems);
  if (Array.isArray(incoming.bingoTiles)) target.bingoTiles.push(...incoming.bingoTiles);
  return target;
}

function grantEventPassExp(user, passId, value, reward) {
  ensureAccountProgress(user);
  const amount = nonNegativeInt(value);
  if (amount <= 0) return;
  const key = String(Number(passId || 0) || "default");
  user.eventPassExp = nonNegativeInt(user.eventPassExp) + amount;
  user.eventPass = user.eventPass && typeof user.eventPass === "object" ? user.eventPass : {};
  user.eventPass[key] = user.eventPass[key] && typeof user.eventPass[key] === "object" ? user.eventPass[key] : {};
  user.eventPass[key].exp = nonNegativeInt(user.eventPass[key].exp) + amount;
  reward.eventPassExpDelta = Number(reward.eventPassExpDelta || 0) + amount;
}

function grantMoldItem(user, moldId, count, reward) {
  ensureAccountProgress(user);
  const id = Number(moldId || 0);
  const amount = nonNegativeBigInt(count);
  if (!Number.isInteger(id) || id <= 0 || amount <= 0n) return;
  const key = String(id);
  const current = user.craft.molds[key] && typeof user.craft.molds[key] === "object" ? user.craft.molds[key] : {};
  const next = nonNegativeBigInt(current.count) + amount;
  user.craft.molds[key] = { moldId: id, count: String(next) };
  if (!Array.isArray(reward.moldItems)) reward.moldItems = [];
  reward.moldItems.push({ moldId: id, count: String(amount) });
}

function grantBingoTile(user, eventId, tileIndex, reward) {
  ensureAccountProgress(user);
  const id = Number(eventId || 0);
  const index = Number(tileIndex || 0);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(index) || index <= 0) return;
  const key = String(id);
  const tiles = Array.isArray(user.bingoTiles[key]) ? user.bingoTiles[key].map(Number) : [];
  if (!tiles.includes(index)) tiles.push(index);
  user.bingoTiles[key] = Array.from(new Set(tiles)).sort((a, b) => a - b);
  if (!Array.isArray(reward.bingoTiles)) reward.bingoTiles = [];
  reward.bingoTiles.push({ eventId: id, tileIndex: index });
}

function grantStageClearExp(user, stageId, dungeonId, options = {}) {
  const amount = nonNegativeInt(options.exp != null ? options.exp : DEFAULT_STAGE_EXP);
  return grantUserExp(user, amount, { reason: `stage:${Number(stageId || 0)}:${Number(dungeonId || 0)}` });
}

function buildMissionDataEntries(user, options = {}) {
  ensureAccountProgress(user);
  const result = new Map();
  const rowsByGroup = new Map();
  const filterTabId = Number(options.tabId || 0);
  if (options.skipRefresh !== true) refreshMissionProgress(user, { now: options.now, tabId: filterTabId });
  const sourceRows = filterTabId > 0 ? getMissionTempletsByTabId(filterTabId) : getMissionTemplets();
  for (const row of sourceRows) {
    if (!row || row.m_Enabled === false) continue;
    if (filterTabId > 0 && Number(row.m_MissionTabId || 0) !== filterTabId) continue;
    if (filterTabId <= 0 && !shouldSerializeMissionTab(row)) continue;
    const groupId = Number(row.m_MissionCounterGroupID || row.m_MissionID || 0);
    if (!Number.isInteger(groupId) || groupId <= 0) continue;
    if (!rowsByGroup.has(groupId)) rowsByGroup.set(groupId, []);
    rowsByGroup.get(groupId).push(row);
  }

  for (const [groupId, rows] of rowsByGroup.entries()) {
    rows.sort(compareMissionRows);
    const row = selectSerializableMissionRow(user, rows, { now: options.now });
    if (!row) continue;
    const state = buildEvaluatedMissionState(user, row, { now: options.now });
    if (!shouldSerializeMissionState(state, row)) continue;
    result.set(groupId, [groupId, state]);
  }

  return Array.from(result.values()).sort((a, b) => Number(a[0]) - Number(b[0]));
}

function selectSerializableMissionRow(user, rows, options = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  const active = candidates.find((row) => {
    if (!missionRequirementSatisfied(user, row)) return false;
    const state = buildEvaluatedMissionState(user, row, { now: options.now });
    return state.rewardClaimed !== true;
  });
  if (active) return active;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const row = candidates[index];
    const state = buildEvaluatedMissionState(user, row, { now: options.now });
    if (state.rewardClaimed === true || (state.isComplete === true && state.claimedAt)) return row;
  }
  return null;
}

function getAchievePoint(user) {
  ensureAccountProgress(user);
  return nonNegativeBigInt(user && user.achievePoint);
}

function missionTargetTimes(row) {
  return Math.max(1, Number(row && row.m_Times) || 1);
}

function normalizeMissionCondition(condition) {
  return String(condition || "").trim().toUpperCase();
}

function normalizeMissionConditionFilter(conditions) {
  const values = Array.isArray(conditions) ? conditions : [conditions];
  return new Set(values.map(normalizeMissionCondition).filter(Boolean));
}

function missionValueNumbers(row) {
  return normalizeNumberList([row && row.m_MissionValue, row && row.m_MissionValue1, row && row.m_MissionValue2]);
}

function primaryMissionValues(row) {
  return normalizeNumberList([row && row.m_MissionValue, row && row.m_MissionValue1]);
}

function secondaryMissionValues(row) {
  return normalizeNumberList(row && row.m_MissionValue2);
}

function primaryMissionValue(row, fallback = 0) {
  const values = primaryMissionValues(row);
  return values.length ? values[0] : Number(fallback || 0);
}

function missionSecondaryValue(row, fallback = 0) {
  const values = secondaryMissionValues(row);
  return values.length ? values[0] : Number(fallback || 0);
}

function normalizeNumberList(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    if (Array.isArray(value)) {
      result.push(...normalizeNumberList(value));
      continue;
    }
    const parts = String(value == null ? "" : value)
      .split(/[,|/;\s]+/)
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry) && entry > 0);
    result.push(...parts);
  }
  return Array.from(new Set(result));
}

function currentResetKey(row, now = Date.now()) {
  const interval = String(row && row.m_ResetInterval || "NONE").trim().toUpperCase();
  if (interval === "DAILY") return currentDailyCounterKey(now);
  if (interval === "WEEKLY") return currentWeeklyCounterKey(now);
  return "total";
}

function isPeriodicMission(row) {
  const interval = String(row && row.m_ResetInterval || "NONE").trim().toUpperCase();
  return interval !== "" && interval !== "NONE" && interval !== "ON_COMPLETE";
}

function missionDateTicks(now = Date.now()) {
  if (typeof now === "bigint") return String(now & DATE_TIME_TICKS_MASK);
  const text = String(now == null || now === "" ? "" : now);
  if (/^\d+$/.test(text)) {
    const value = BigInt(text);
    if (value > 9000000000000000n) return String(value & DATE_TIME_TICKS_MASK);
    if (value > 1000000000000n) return String(value * 10000n + TICKS_AT_UNIX_EPOCH);
    if (value > 0n) return String(value);
  }
  const parsed = Date.parse(text);
  const ms = Number.isFinite(parsed) ? parsed : Date.now();
  return String(BigInt(ms) * 10000n + TICKS_AT_UNIX_EPOCH);
}

function counterScopeForMission(row, now = Date.now()) {
  const interval = String(row && row.m_ResetInterval || "NONE").trim().toUpperCase();
  if (interval === "DAILY") return currentDailyCounterKey(now);
  if (interval === "WEEKLY") return currentWeeklyCounterKey(now);
  return "total";
}

function currentDailyCounterKey(now = Date.now()) {
  return `daily:${localDayKey(now)}`;
}

function currentWeeklyCounterKey(now = Date.now()) {
  const date = toDate(now);
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7);
  return `weekly:${day.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function localDayKey(now = Date.now()) {
  return toDate(now).toISOString().slice(0, 10);
}

function toDate(value) {
  if (typeof value === "bigint") return new Date();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1000000000000) return new Date(numeric);
  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return new Date(parsed);
  return new Date();
}

function countLoginDays(user, row, now = Date.now()) {
  const days = Array.isArray(user && user.missionLoginDays) ? user.missionLoginDays : [];
  const interval = String(row && row.m_ResetInterval || "NONE").trim().toUpperCase();
  if (interval === "DAILY") return days.includes(localDayKey(now)) ? 1 : 0;
  if (interval === "WEEKLY") {
    const week = currentWeeklyCounterKey(now);
    return days.filter((day) => currentWeeklyCounterKey(day) === week).length;
  }
  return days.length || (user && user.createdAt ? 1 : 0);
}

function countClearedDungeons(user, ids = []) {
  const clear = user && user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  if (ids.length) return ids.filter((id) => Boolean(clear[String(id)])).length;
  return Object.keys(clear).length;
}

function countPerfectDungeons(user, ids = []) {
  const clear = user && user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  const entries = ids.length ? ids.map((id) => clear[String(id)]).filter(Boolean) : Object.values(clear);
  return entries.filter((entry) => entry && entry.missionResult1 !== false && entry.missionResult2 !== false).length;
}

function countOwnedMisc(user, itemIds = []) {
  const items = getMiscItems(user);
  if (!itemIds.length) return items.reduce((total, item) => total + Number(toBigInt(item.countFree) + toBigInt(item.countPaid)), 0);
  return itemIds.reduce((total, itemId) => {
    const item = items.find((entry) => Number(entry.itemId) === Number(itemId));
    return total + Number(toBigInt(item && item.countFree) + toBigInt(item && item.countPaid));
  }, 0);
}

function countUnitsAtLevel(user, level, unitIds = []) {
  const ids = numberSet(unitIds);
  return getArmyUnits(user).filter(
    (unit) => (!ids.size || ids.has(Number(unit && unit.unitId))) && Number(unit && unit.level) >= Number(level)
  ).length;
}

function countShipsAtLevel(user, level, shipIds = []) {
  const ids = numberSet(shipIds);
  return getArmyShips(user).filter(
    (ship) => (!ids.size || ids.has(Number(ship && ship.unitId))) && Number(ship && ship.level) >= Number(level)
  ).length;
}

function countOperatorsAtLevel(user, level, operatorIds = []) {
  const ids = numberSet(operatorIds);
  return getArmyOperators(user).filter(
    (operator) => (!ids.size || ids.has(Number(operator && (operator.id || operator.unitId)))) && Number(operator && operator.level) >= Number(level)
  ).length;
}

function countUnitsByMinimumField(user, field, value, unitIds = []) {
  const ids = numberSet(unitIds);
  return getArmyUnits(user).filter(
    (unit) => (!ids.size || ids.has(Number(unit && unit.unitId))) && Number(unit && unit[field]) >= Number(value)
  ).length;
}

function sumUnitsByMinimumField(user, field, minimumValue) {
  const minimum = Number(minimumValue || 0);
  return getArmyUnits(user).reduce((total, unit) => {
    const value = Math.max(0, Number(unit && unit[field]) || 0);
    return total + (value >= minimum ? value : 0);
  }, 0);
}

function countPermanentUnits(user, unitIds = []) {
  const ids = numberSet(unitIds);
  return getArmyUnits(user).filter(
    (unit) => (!ids.size || ids.has(Number(unit && unit.unitId))) && unit && unit.isPermanentContract === true
  ).length;
}

function countUnitsBySkillLevel(user, level, unitIds = [], skillIds = []) {
  const ids = numberSet(unitIds);
  const skillIndexes = Array.from(numberSet(skillIds))
    .map((skillId) => Math.max(0, Math.min(4, Math.abs(skillId) % 10)))
    .filter((index) => Number.isInteger(index) && index >= 0 && index <= 4);
  return getArmyUnits(user).filter((unit) => {
    if (ids.size && !ids.has(Number(unit && unit.unitId))) return false;
    const skills = Array.isArray(unit && unit.skillLevels) ? unit.skillLevels : [];
    if (!skills.length) return false;
    if (skillIndexes.length) return skillIndexes.some((index) => Number(skills[index] || 1) >= Number(level));
    return skills.every((skillLevel) => Number(skillLevel) >= Number(level));
  }).length;
}

function countEquipsByMinimumField(user, field, value) {
  return getEquipItems(user).filter((equip) => Number(equip && equip[field]) >= Number(value)).length;
}

function countEquipsByTier(user, tier) {
  return getEquipItems(user).filter((equip) => getEquipTier(equip) >= Number(tier)).length;
}

function getEquipTier(equip) {
  const direct = Number(equip && (equip.tier || equip.itemTier || equip.m_Tier || equip.m_ItemTier));
  if (Number.isFinite(direct) && direct > 0) return direct;
  const templet = getEquipTemplet(equip && equip.itemEquipId) || {};
  return Math.max(
    0,
    Number(
      templet.m_NKM_ITEM_TIER ||
        templet.m_ItemEquipTier ||
        templet.m_Tier ||
        templet.m_iTier ||
        templet.ItemTier ||
        0
    ) || 0
  );
}

function normalizeLoyaltyTarget(value) {
  const target = Number(value || 0);
  if (!Number.isFinite(target) || target <= 0) return 0;
  return target <= 100 ? target * 100 : target;
}

function numberSet(values) {
  return new Set(
    normalizeNumberList(values)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0)
  );
}

function countClaimedMissions(user, options = {}) {
  const tabId = Number(options.tabId || 0);
  const tabIds = new Set(
    (Array.isArray(options.tabIds) ? options.tabIds : [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0)
  );
  const seen = new Set();
  return Object.values((user && user.completedMissions) || {}).filter((mission) => {
    if (!mission || !(mission.rewardClaimed === true || (mission.isComplete === true && mission.claimedAt))) return false;
    if (tabIds.size && !tabIds.has(Number(mission.tabId || 0))) return false;
    if (tabId && Number(mission.tabId) !== tabId) return false;
    const key = `${Number(mission.missionID || 0)}:${Number(mission.groupId || mission.missionID || 0)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).length;
}

function isTutorialMissionComplete(user, row) {
  const forceStage = Number(row && row.m_ForceClearStage);
  if (forceStage > 0) {
    const play = user && user.stagePlayData && user.stagePlayData[String(forceStage)];
    if (play) return true;
  }
  return Boolean(user && user.tutorial && user.tutorial.completed === true);
}

function missionRequirementSatisfied(user, row) {
  const requiredMissionId = Number(row && row.m_MissionRequire);
  if (!requiredMissionId) return true;
  const required = findClaimedMissionState(user, requiredMissionId);
  return Boolean(required && (required.rewardClaimed === true || (required.isComplete === true && required.claimedAt)));
}

function findClaimedMissionState(user, missionID) {
  const direct = user && user.completedMissions && user.completedMissions[String(missionID)];
  if (direct && (direct.rewardClaimed === true || (direct.isComplete === true && direct.claimedAt))) return direct;
  return Object.values((user && user.completedMissions) || {}).find(
    (mission) =>
      Number(mission && mission.missionID) === Number(missionID) &&
      (mission.rewardClaimed === true || (mission.isComplete === true && mission.claimedAt))
  );
}

function shouldSerializeMissionState(state, row) {
  if (!state) return false;
  if (state.rewardClaimed === true || state.rewardReady === true) return true;
  if (Number(state.times || 0) >= missionTargetTimes(row)) return true;
  if (Number(state.times || 0) > 0) return true;
  const condition = normalizeMissionCondition(row && row.m_MissionCond);
  return condition === "JUST_OPEN" || condition === "ACCOUNT_LEVEL" || condition === "TUTORIAL";
}

function shouldSerializeMissionTab(row) {
  const tab = getMissionTabTemplet(Number(row && row.m_MissionTabId) || 0);
  if (!tab) return false;
  if (tab.m_Visible === false) return false;
  const openTag = String(tab.m_OpenTag || "").toUpperCase();
  if (openTag.includes("NO_USE")) return false;
  const allowedTags = Array.isArray(tab.listContentsTagAllow) ? tab.listContentsTagAllow : [];
  if (allowedTags.some((tag) => String(tag || "").toUpperCase() === "TAG_MISSION_NOT_USED")) return false;
  return true;
}

function compareMissionRows(left, right) {
  const leftRequire = Number(left && left.m_MissionRequire) || 0;
  const rightRequire = Number(right && right.m_MissionRequire) || 0;
  if (leftRequire === Number(right && right.m_MissionID)) return 1;
  if (rightRequire === Number(left && left.m_MissionID)) return -1;
  return Number(left && left.m_MissionID) - Number(right && right.m_MissionID);
}

function setProfileMainUnit(user, unitId, skinId = 0, tacticLevel = 0) {
  ensureAccountProgress(user);
  user.mainUnitId = Math.max(0, Number(unitId) || 0);
  user.mainUnitSkinId = Math.max(0, Number(skinId) || 0);
  user.mainUnitTacticLevel = Math.max(0, Number(tacticLevel) || 0);
}

function setProfileIntro(user, intro) {
  ensureAccountProgress(user);
  user.friendIntro = String(intro || "").slice(0, 80);
}

function setProfileFrame(user, frameId) {
  ensureAccountProgress(user);
  user.selfiFrameId = Math.max(0, Number(frameId) || 0);
  user.frameId = user.selfiFrameId;
}

function setProfileTitle(user, titleId) {
  ensureAccountProgress(user);
  user.titleId = Math.max(0, Number(titleId) || 0);
}

function setProfileEmblem(user, index, itemId, count = 1) {
  ensureAccountProgress(user);
  const slot = Math.max(0, Math.min(DEFAULT_PROFILE_EMBLEM_SLOTS - 1, Number(index) || 0));
  const emblems = normalizeEmblems(user.profileEmblems);
  emblems[slot] = {
    id: Math.max(0, Number(itemId) || 0),
    count: String(nonNegativeBigInt(count || 1)),
  };
  user.profileEmblems = emblems;
  return { index: slot, itemId: emblems[slot].id, count: emblems[slot].count };
}

function normalizeEmblems(values) {
  const source = Array.isArray(values) ? values : [];
  const result = source.slice(0, DEFAULT_PROFILE_EMBLEM_SLOTS).map((entry) => ({
    id: Math.max(0, Number(entry && entry.id) || 0),
    count: String(nonNegativeBigInt(entry && entry.count != null ? entry.count : 0)),
  }));
  while (result.length < DEFAULT_PROFILE_EMBLEM_SLOTS) result.push({ id: 0, count: "0" });
  return result;
}

function emptyMissionResult(request = {}) {
  return {
    missionID: Number(request.missionID || 0) || 0,
    tabId: Number(request.tabId || 1) || 1,
    groupId: Number(request.groupId || request.missionID || 0) || 0,
    changed: false,
    exp: { userExp: 0 },
    reward: emptyReward(),
  };
}

function emptyReward() {
  return { userExp: 0, bonusRatioOfUserExp: 0, achievePoint: "0" };
}

function defaultMissionAchievementPoint(tabId) {
  const numericTabId = Number(tabId || 0);
  return numericTabId > 0 ? DEFAULT_ACHIEVEMENT_POINT : 0;
}

function clampInt(value, min, max) {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function nonNegativeInt(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function nonNegativeBigInt(value) {
  const number = toBigInt(value, 0n);
  return number > 0n ? number : 0n;
}

module.exports = {
  DEFAULT_MISSION_EXP,
  DEFAULT_STAGE_EXP,
  DEFAULT_ACHIEVEMENT_POINT,
  ensureAccountProgress,
  grantUserExp,
  grantStageClearExp,
  completeMission,
  completeAllMissionsForTab,
  updateMissionProgress,
  donateMissionItem,
  refreshMissionProgress,
  recordMissionLogin,
  trackMissionEvent,
  buildMissionDataEntries,
  getAchievePoint,
  setProfileMainUnit,
  setProfileIntro,
  setProfileFrame,
  setProfileTitle,
  setProfileEmblem,
  expToNextLevel,
};
