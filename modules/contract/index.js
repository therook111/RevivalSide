const { randomInt } = require("crypto");
const {
  writeSignedVarInt,
  writeInt64LE,
  writeNullableObject,
  writeNullObject,
  writeNullableObjectList,
  buildItemMiscData,
  buildUnitData,
  buildOperatorData,
  buildRewardData,
  buildContractStateData,
  buildContractBonusStateData,
  buildSelectableContractStateData,
  farFutureDateTimeBinary,
  readSignedVarInt,
} = require("../packet-codec");
const {
  getContractRecord,
  getVisibleContractIds,
  getContractPoolUnitIds,
  getContractPoolUnitEntries,
  getContractTabRecord,
  getMiscContractRecord,
  getMiscItemTemplet,
  getCustomPickupContractRecords,
  getRandomGradeTable,
  getUnitTemplet,
  resolveUnitId,
} = require("../game-data");
const { grantUnit, grantOperator, grantUnitFromPiece, getPieceRequirement } = require("../unit");
const { grantRewardByType, createEmptyReward, mergeReward } = require("../reward");
const { spendMiscItem, toBigInt } = require("../inventory");

const PACKETS = Object.freeze({
  CONTRACT_REQ: 2800,
  CONTRACT_ACK: 2801,
  SELECTABLE_CONTRACT_CHANGE_POOL_REQ: 2802,
  SELECTABLE_CONTRACT_CHANGE_POOL_ACK: 2803,
  SELECTABLE_CONTRACT_CONFIRM_REQ: 2804,
  SELECTABLE_CONTRACT_CONFIRM_ACK: 2805,
  CONTRACT_STATE_LIST_REQ: 2806,
  CONTRACT_STATE_LIST_ACK: 2807,
  MISC_CONTRACT_OPEN_REQ: 2808,
  MISC_CONTRACT_OPEN_ACK: 2809,
  INSTANT_CONTRACT_LIST_REQ: 2810,
  INSTANT_CONTRACT_LIST_ACK: 2811,
  CUSTOM_PICKUP_REQ: 2812,
  CUSTOM_PICKUP_ACK: 2813,
  CUSTOM_PICUP_SELECT_TARGET_REQ: 2814,
  CUSTOM_PICUP_SELECT_TARGET_ACK: 2815,
  EXCHANGE_PIECE_TO_UNIT_REQ: 1422,
  EXCHANGE_PIECE_TO_UNIT_ACK: 1423,
});

const CUSTOM_PICKUP_CATEGORY = 6;
const CUSTOM_PICKUP_TYPE_ORDER = Object.freeze({
  AWAKEN: 0,
  BASIC: 1,
  OPERATOR: 2,
});

function createContractHandler(packetId, name) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      ctx.socket = socket;
      const user = getSessionUser(ctx);
      const request = decodeRequest(ctx, packetId, packet.payload);
      const response = buildContractResponse(ctx, user, packetId, request);
      if (!response) return false;
      trackContractMission(ctx, user, packetId, request);
      console.log(`[contract:${name}] ACK packetId=${response.packetId} ${formatRequest(request)}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      persistUserDb(ctx);
      return true;
    },
  };
}

function trackContractMission(ctx, user, packetId, request = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const nowValue = now(ctx);
  let changed = false;
  const changedConditions = new Set();
  const track = (condition, amount = 1, details = {}) => {
    const tracked = ctx.trackMissionEvent(user, condition, amount, { now: nowValue, ...details });
    if (tracked) changedConditions.add(condition);
    changed = tracked || changed;
  };
  switch (packetId) {
    case PACKETS.CONTRACT_REQ:
    case PACKETS.CUSTOM_PICKUP_REQ:
    case PACKETS.MISC_CONTRACT_OPEN_REQ:
      track("UNIT_CONTRACT", Math.max(1, Number(request.count || 1) || 1));
      break;
    case PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ:
      track("UNIT_CONTRACT", 1, { contractId: request.contractId });
      break;
    default:
      break;
  }
  if (changed && typeof ctx.refreshMissionProgress === "function") {
    ctx.refreshMissionProgress(user, { now: nowValue, conditions: Array.from(changedConditions) });
  }
}

function trackResourceSpend(ctx, user, itemId, amount) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const numericItemId = Number(itemId || 0);
  const numericAmount = Math.max(0, Math.trunc(Number(amount || 0) || 0));
  if (numericItemId <= 0 || numericAmount <= 0) return;
  const nowValue = now(ctx);
  const changed = ctx.trackMissionEvent(user, "USE_RESOURCE", numericAmount, {
    now: nowValue,
    itemId: numericItemId,
    resourceId: numericItemId,
    value: numericItemId,
  });
  if (changed && typeof ctx.refreshMissionProgress === "function") {
    ctx.refreshMissionProgress(user, { now: nowValue, conditions: ["USE_RESOURCE"] });
  }
}

function buildContractResponse(ctx, user, packetId, request) {
  switch (packetId) {
    case PACKETS.CONTRACT_STATE_LIST_REQ:
      return { packetId: PACKETS.CONTRACT_STATE_LIST_ACK, payload: buildContractStateListAck(user) };
    case PACKETS.INSTANT_CONTRACT_LIST_REQ:
      return { packetId: PACKETS.INSTANT_CONTRACT_LIST_ACK, payload: buildInstantContractListAck(user) };
    case PACKETS.CONTRACT_REQ:
      return { packetId: PACKETS.CONTRACT_ACK, payload: buildContractAck(ctx, user, request) };
    case PACKETS.CUSTOM_PICKUP_REQ:
      return { packetId: PACKETS.CUSTOM_PICKUP_ACK, payload: buildCustomPickupAck(ctx, user, request) };
    case PACKETS.CUSTOM_PICUP_SELECT_TARGET_REQ:
      return { packetId: PACKETS.CUSTOM_PICUP_SELECT_TARGET_ACK, payload: buildCustomPickupSelectTargetAck(user, request) };
    case PACKETS.MISC_CONTRACT_OPEN_REQ:
      return { packetId: PACKETS.MISC_CONTRACT_OPEN_ACK, payload: buildMiscContractOpenAck(ctx, user, request) };
    case PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_REQ:
      return { packetId: PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_ACK, payload: buildSelectableChangePoolAck(request) };
    case PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ:
      return { packetId: PACKETS.SELECTABLE_CONTRACT_CONFIRM_ACK, payload: buildSelectableConfirmAck(ctx, user, request) };
    case PACKETS.EXCHANGE_PIECE_TO_UNIT_REQ:
      return { packetId: PACKETS.EXCHANGE_PIECE_TO_UNIT_ACK, payload: buildPieceExchangeAck(ctx, user, request) };
    default:
      return null;
  }
}

function buildContractAck(ctx, user, request) {
  const contractId = resolveContractId(request.contractId);
  const count = Math.max(1, Number(request.count || 1));
  const costItems = spendContractCost(ctx, user, contractId, count);
  const reward = rollContract(ctx, user, contractId, count, { fromContract: true });
  applyContractRewards(ctx, user, contractId, count, reward);

  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number(request.costType || 0)),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeNullableObjectList(reward.units.map(buildUnitData)),
    writeNullableObjectList(reward.operators.map(buildOperatorData)),
    writeNullableObject(buildRewardData(reward)),
    writeNullableObject(buildContractStateData(getContractState(user, contractId))),
    writeNullableObject(buildContractBonusStateData(getContractBonusState(user, contractId))),
    writeSignedVarInt(contractId),
    writeSignedVarInt(count),
  ]);
}

function buildCustomPickupAck(ctx, user, request) {
  const customPickupId = Number(request.customPickupId || 0);
  const count = Math.max(1, Number(request.count || 1));
  const pickup = getCustomPickupContractRecords().find((record) => Number(record.customPickupId) === customPickupId) || {};
  const customState = getCustomPickupContractState(user, customPickupId);
  const poolId = pickup.m_UnitPoolID || customPickupId;
  const costItems = spendCostFromRecord(ctx, user, pickup, count);
  const reward = createEmptyReward();
  if (String(pickup.m_ContractType || "") === "OPERATOR") {
    reward.operators.push(
      ...rollPoolOperators(user, poolId, count, {
        fromContract: true,
        regDate: now(ctx),
        sourceRecord: pickup,
        customPickupTargetUnitId: customState.customPickupTargetUnitId,
      })
    );
  } else {
    reward.units.push(
      ...rollPoolUnits(user, poolId, count, {
        fromContract: true,
        regDate: now(ctx),
        sourceRecord: pickup,
        customPickupTargetUnitId: customState.customPickupTargetUnitId,
      })
    );
  }
  applyRecordResultRewards(ctx, user, pickup, count, reward);
  customState.totalUseCount = getContractBonusState(user, pickup).useCount;
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number(request.costType || 0)),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeNullableObjectList(reward.units.map(buildUnitData)),
    writeNullableObjectList(reward.operators.map(buildOperatorData)),
    writeNullableObject(buildRewardData(reward)),
    writeNullableObject(buildCustomPickupContractData(customState)),
    writeSignedVarInt(customPickupId),
    writeSignedVarInt(count),
    writeNullableObject(buildContractBonusStateData(getContractBonusState(user, pickup))),
  ]);
}

function buildCustomPickupSelectTargetAck(user, request) {
  const customPickupId = Number(request.customPickupId || 0);
  const targetUnitId = Number(request.targetUnitId || 0);
  const pickup = getCustomPickupContractRecords().find((record) => Number(record.customPickupId) === customPickupId) || {};
  const state = getCustomPickupContractState(user, customPickupId);
  const resolvedTargetId = normalizeCustomPickupTarget(pickup, targetUnitId, {
    includeOperators: String(pickup.m_ContractType || "") === "OPERATOR",
  });
  if (resolvedTargetId > 0) {
    const previousTargetId = Number(state.customPickupTargetUnitId || 0);
    const maxSelectCount = getCustomPickupMaxSelectCount(pickup);
    if (resolvedTargetId !== previousTargetId && (!maxSelectCount || state.currentSelectCount < maxSelectCount)) {
      state.customPickupTargetUnitId = resolvedTargetId;
      state.currentSelectCount += 1;
    }
  }
  if (String(pickup.m_ContractType || "") !== "AWAKEN") {
    const bonus = getContractBonusState(user, pickup);
    bonus.useCount = 0;
  }
  state.totalUseCount = getContractBonusState(user, pickup).useCount;
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildCustomPickupContractData(state)),
    writeNullableObject(buildContractBonusStateData(getContractBonusState(user, pickup))),
  ]);
}

function buildMiscContractOpenAck(ctx, user, request) {
  const count = Math.max(1, Number(request.count || 1));
  const sourceItemId = Number(request.miscItemId || 0);
  const costItem = sourceItemId > 0 ? spendMiscItem(user, sourceItemId, count, { regDate: now(ctx) }) : null;
  if (costItem) trackResourceSpend(ctx, user, sourceItemId, count);
  const contractId = resolveMiscContractId(sourceItemId);
  const result = openMiscContract(ctx, user, contractId, { count, sourceMiscItemId: sourceItemId }).result;

  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList(costItem ? [buildItemMiscData(costItem)] : []),
    writeNullableObjectList(result.map(buildMiscContractResultData)),
  ]);
}

function openMiscContract(ctx, user, contractId, options = {}) {
  const record = getMiscContractRecord(contractId) || {};
  const count = Math.max(1, Number(options.count || record.m_UnitCount || 1));
  const poolId = record.m_UnitPoolID || contractId;
  const units = rollPoolUnits(user, poolId, count, {
    fromContract: true,
    regDate: options.regDate || now(ctx),
    sourceRecord: record,
  });
  const reward = createEmptyReward();
  reward.units.push(...units);
  return {
    reward,
    result: [
      {
        miscItemId: Number(options.sourceMiscItemId || contractId || 0),
        units,
      },
    ],
  };
}

function buildSelectableChangePoolAck(request) {
  const contractId = resolveContractId(request.contractId);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildSelectableContractStateData(buildSelectableState(contractId))),
  ]);
}

function buildSelectableConfirmAck(ctx, user, request) {
  const contractId = resolveContractId(request.contractId);
  const units = rollContract(ctx, user, contractId, 1, { fromContract: true }).units;
  applyContractRewards(ctx, user, contractId, 1, { units, miscItems: [], operators: [], skinIds: [], emoticonIds: [] });
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(contractId),
    writeNullableObjectList([]),
    writeNullableObjectList(units.map(buildUnitData)),
    writeNullableObject(buildSelectableContractStateData(buildSelectableState(contractId))),
  ]);
}

function buildPieceExchangeAck(ctx, user, request) {
  const itemId = Number(request.itemId || 0);
  const count = Math.max(1, Number(request.count || 1));
  const alreadyOwned = false;
  const spendCount = getPieceRequirement(itemId, alreadyOwned) * count;
  const costItem = itemId > 0 ? spendMiscItem(user, itemId, spendCount, { regDate: now(ctx) }) : null;
  if (costItem) trackResourceSpend(ctx, user, itemId, spendCount);
  const units = grantUnitFromPiece(user, itemId, count, { regDate: now(ctx), fromContract: false });
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList(units.map(buildUnitData)),
    costItem ? writeNullableObject(buildItemMiscData(costItem)) : writeNullObject(),
  ]);
}

function buildContractStateListAck(user) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList(getAllContractStates(user).map(buildContractStateData)),
  ]);
}

function buildInstantContractListAck(user) {
  const activeCustom = getAllCustomPickupContracts(user).find((contract) => Number(contract.customPickupTargetUnitId) > 0);
  const activeRecord =
    activeCustom &&
    getCustomPickupContractRecords().find((record) => Number(record.customPickupId) === Number(activeCustom.customPickupId));
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList([]),
    writeSignedVarInt(Number(activeCustom && activeCustom.customPickupTargetUnitId) || 0),
    writeNullableObject(buildContractBonusStateData(activeRecord ? getContractBonusState(user, activeRecord) : { bonusGroupId: 0 })),
  ]);
}

function getAllContractStates(user) {
  return getVisibleContractIds().map((contractId) => getContractState(user, contractId));
}

function getAllContractBonusStates(user) {
  const seen = new Set();
  const states = [];
  for (const record of [
    ...getVisibleContractIds().map((contractId) => getContractRecord(contractId)).filter(Boolean),
    ...getActiveCustomPickupContractRecords(),
  ]) {
    const state = getContractBonusState(user, record);
    if (seen.has(state.bonusGroupId)) continue;
    seen.add(state.bonusGroupId);
    states.push(state);
  }
  return states;
}

function getContractState(user, contractId) {
  ensureContractStateStore(user);
  if (!user) {
    return {
      contractId: Number(contractId) || 0,
      remainFreeChance: Number((getContractRecord(contractId) || {}).m_FreeTryCnt || 0),
      nextResetDate: String(farFutureDateTimeBinary()),
      isActive: true,
      totalUseCount: 0,
      dailyUseCount: 0,
      bonusCandidate: [],
    };
  }
  const key = String(contractId);
  const existing = user.contractStates[key] || {};
  const record = getContractRecord(contractId) || {};
  const freeChance = existing.remainFreeChance != null ? existing.remainFreeChance : Number(record.m_FreeTryCnt || 0);
  const state = {
    contractId: Number(contractId) || 0,
    remainFreeChance: Math.max(0, Number(freeChance) || 0),
    nextResetDate: String(existing.nextResetDate || farFutureDateTimeBinary()),
    isActive: existing.isActive !== false,
    totalUseCount: Number(existing.totalUseCount || 0),
    dailyUseCount: Number(existing.dailyUseCount || 0),
    bonusCandidate: Array.isArray(existing.bonusCandidate) ? existing.bonusCandidate : [],
  };
  user.contractStates[key] = state;
  return state;
}

function getContractBonusState(user, contractId) {
  ensureContractStateStore(user);
  const bonusGroupId = getBonusGroupId(contractId);
  if (!user) return { bonusGroupId, useCount: 0, resetCount: 0 };
  const key = String(bonusGroupId);
  const legacyKey = String(Number(contractId && (contractId.m_ContractID || contractId.customPickupId)) || Number(contractId) || bonusGroupId);
  const existing = user.contractBonusStates[key] || user.contractBonusStates[legacyKey] || {};
  const state = {
    bonusGroupId,
    useCount: Number(existing.useCount || 0),
    resetCount: Number(existing.resetCount || 0),
  };
  user.contractBonusStates[key] = state;
  return state;
}

function applyContractRewards(ctx, user, contractId, count, reward, options = {}) {
  const state = getContractState(user, contractId);
  state.totalUseCount += Math.max(1, Number(count) || 1);
  state.dailyUseCount += Math.max(1, Number(count) || 1);
  if (state.remainFreeChance > 0) state.remainFreeChance = Math.max(0, state.remainFreeChance - Math.max(1, Number(count) || 1));
  if (!options.skipResultRewards && reward && Array.isArray(reward.miscItems)) {
    applyRecordResultRewards(ctx, user, getContractRecord(contractId) || {}, count, reward);
  }
}

function applyRecordResultRewards(ctx, user, record, count, reward) {
  for (let index = 1; index <= 4; index += 1) {
    const type = record[`m_ContractResultRewardType_${index}`];
    const id = record[`m_ContractResultRewardID_${index}`];
    if (!type || !id) continue;
    mergeReward(
      reward,
      grantRewardByType(ctx, user, type, id, Number(record[`m_ContractResultRewardValue_${index}`] || 1) * count, null, 0, {
        expandPackages: false,
        regDate: now(ctx),
      })
    );
  }
}

function rollContract(ctx, user, contractId, count, options = {}) {
  const reward = createEmptyReward();
  const record = getContractRecord(contractId) || {};
  if (String(record.m_NKM_UNIT_TYPE || "") === "NUT_OPERATOR") {
    const operators = rollPoolOperators(user, contractId, count, { ...options, regDate: now(ctx), sourceRecord: record });
    reward.operators.push(...operators);
    return reward;
  }
  const unitIds = rollPoolUnits(user, contractId, count, { ...options, regDate: now(ctx), sourceRecord: record });
  for (const unit of unitIds) reward.units.push(unit);
  return reward;
}

function rollPoolUnits(user, poolId, count, options = {}) {
  const record = options.sourceRecord || getContractRecord(poolId) || getMiscContractRecord(poolId) || {};
  let entries = getContractPoolUnitEntries(poolId);
  if (!entries.length) entries = getContractPoolUnitEntries(resolveContractId(poolId));
  if (!entries.length) entries = [buildSyntheticPoolEntry(1001)];
  const units = [];
  const bonus = createBonusTracker(user, record, entries, { ...options, includeOperators: false });
  for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
    const entry = advanceBonusAndPickEntry(bonus) || pickContractEntry(entries, record, { ...options, includeOperators: false });
    const unit = grantUnit(user, entry && entry.unitId, options);
    noteBonusRollResult(bonus, entry);
    if (unit) units.push(unit);
  }
  return units;
}

function rollPoolOperators(user, poolId, count, options = {}) {
  const record = options.sourceRecord || getContractRecord(poolId) || getMiscContractRecord(poolId) || {};
  let entries = getContractPoolUnitEntries(poolId, { includeOperators: true });
  if (!entries.length) entries = [buildSyntheticPoolEntry(30101)];
  const operators = [];
  const bonus = createBonusTracker(user, record, entries, { ...options, includeOperators: true });
  for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
    const entry = advanceBonusAndPickEntry(bonus) || pickContractEntry(entries, record, { ...options, includeOperators: true });
    const operator = grantOperator(user, entry && entry.unitId, options);
    noteBonusRollResult(bonus, entry);
    if (operator) operators.push(operator);
  }
  return operators;
}

function pickContractEntry(entries, record, options = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && Number(entry.unitId) > 0) : [];
  if (!list.length) return buildSyntheticPoolEntry(options.includeOperators ? 30101 : 1001);

  const gradeRoll = rollGradeCategory(record && record.m_RandomGradeID);
  const gradeCandidates = filterEntriesByGrade(list, gradeRoll.grade);
  if (gradeRoll.pickup) {
    const pickupCandidates = filterEntriesByGrade(getPickupEntries(record, list, options), gradeRoll.grade);
    if (pickupCandidates.length) return pickWeighted(pickupCandidates, (entry) => entry.ratio);
    if (gradeCandidates.length) return pickWeighted(gradeCandidates, (entry) => entry.ratio);
  }
  return pickWeighted(gradeCandidates.length ? gradeCandidates : list, (entry) => entry.ratio);
}

function rollGradeCategory(randomGradeId) {
  const table = getRandomGradeTable(randomGradeId);
  if (!table) return { grade: "", pickup: false };
  const entries = [
    ["SSR", "Rate_SSR", false],
    ["SSR", "Rate_Pick_SSR", true],
    ["SR", "Rate_SR", false],
    ["SR", "Rate_Pick_SR", true],
    ["R", "Rate_R", false],
    ["R", "Rate_Pick_R", true],
    ["N", "Rate_N", false],
    ["N", "Rate_Pick_N", true],
  ]
    .map(([grade, key, pickup]) => ({ grade, pickup, weight: Math.max(0, Number(table[key] || 0)) }))
    .filter((entry) => entry.weight > 0);
  if (!entries.length) return { grade: "", pickup: false };
  return pickWeighted(entries, (entry) => entry.weight);
}

function getPickupEntries(record, poolEntries, options = {}) {
  const entries = [];
  const customTarget = buildCustomPickupTargetEntry(record, poolEntries, options);
  if (customTarget) entries.push(customTarget);
  const additional = buildAdditionalPickupEntry(record, options);
  if (additional && !isAdminPlaceholderUnit(additional.unitId)) entries.push(additional);
  if (!entries.length && record && (Number(record.customPickupId) > 0 || (additional && isAdminPlaceholderUnit(additional.unitId)))) {
    entries.push(...poolEntries.filter((entry) => entry.pickupTarget === true));
  }
  return entries;
}

function buildCustomPickupTargetEntry(record, poolEntries, options = {}) {
  if (!record || Number(record.customPickupId) <= 0) return null;
  const targetUnitId = Number(options.customPickupTargetUnitId || 0);
  if (!Number.isInteger(targetUnitId) || targetUnitId <= 0) return null;
  return (
    (Array.isArray(poolEntries) ? poolEntries : []).find((entry) => Number(entry && entry.unitId) === targetUnitId) ||
    buildSyntheticPoolEntry(targetUnitId)
  );
}

function buildAdditionalPickupEntry(record, options = {}) {
  if (!record || !record.m_addUnitStrId) return null;
  const unitId = resolveUnitId(record.m_addUnitStrId);
  if (!Number.isInteger(unitId) || unitId <= 0) return null;
  const templet = getUnitTemplet(unitId) || {};
  const isOperator = String(templet.m_NKM_UNIT_TYPE || "") === "NUT_OPERATOR";
  if (options.includeOperators === true ? !isOperator : isOperator) return null;
  return {
    unitId,
    ratio: Math.max(1, Number(record.m_addUnitRatio || 1)),
    grade: normalizeGrade(templet.m_NKM_UNIT_GRADE),
    pickupTarget: true,
    record,
  };
}

function filterEntriesByGrade(entries, grade) {
  if (!grade) return entries.slice();
  return entries.filter((entry) => entry.grade === grade);
}

function pickWeighted(entries, weightFn) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return null;
  const weights = list.map((entry) => Math.floor(Math.max(0, Number(weightFn(entry) || 0))));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return list[randomInt(list.length)];
  let roll = randomInt(total);
  for (let index = 0; index < list.length; index += 1) {
    roll -= weights[index];
    if (roll < 0) return list[index];
  }
  return list[list.length - 1];
}

function createBonusTracker(user, record, entries, options = {}) {
  const threshold = getBonusThreshold(record);
  const bonusGroupId = getBonusGroupId(record);
  if (!threshold || !bonusGroupId) return null;
  const targets = getBonusTargetEntries(record, entries, options);
  if (!targets.length) return null;
  return {
    state: getContractBonusState(user, record),
    threshold,
    targets,
    targetIds: new Set(targets.map((entry) => Number(entry.unitId)).filter((unitId) => unitId > 0)),
  };
}

function advanceBonusAndPickEntry(tracker) {
  if (!tracker || !tracker.state) return null;
  tracker.state.useCount += 1;
  if (tracker.state.useCount < tracker.threshold) return null;
  return pickWeighted(tracker.targets, (entry) => entry.ratio);
}

function noteBonusRollResult(tracker, entry) {
  if (!tracker || !tracker.state || !entry) return;
  if (!tracker.targetIds.has(Number(entry.unitId))) return;
  tracker.state.useCount = 0;
  tracker.state.resetCount += 1;
}

function getBonusTargetEntries(record, poolEntries, options = {}) {
  const customTargetId = Number(options.customPickupTargetUnitId || 0);
  if (customTargetId > 0) {
    const existing = poolEntries.find((entry) => Number(entry.unitId) === customTargetId);
    return [existing || buildSyntheticPoolEntry(customTargetId)];
  }

  const additional = buildAdditionalPickupEntry(record, options);
  if (additional && !isAdminPlaceholderUnit(additional.unitId)) return [additional];

  const pickupTargets = getPickupEntries(record, poolEntries, options).filter((entry) => entry && Number(entry.unitId) > 0);
  if (pickupTargets.length) return pickupTargets;
  return additional ? [additional] : [];
}

function getBonusGroupId(contractIdOrRecord) {
  const record = normalizeContractLikeRecord(contractIdOrRecord);
  const groupId = Number(
    (record && (record.m_ContractBonusCountGroupID || record.ContractBonusCountGroupID)) ||
      (record && (record.m_ContractID || record.customPickupId)) ||
      Number(contractIdOrRecord) ||
      0
  );
  return Number.isInteger(groupId) && groupId > 0 ? groupId : 0;
}

function getBonusThreshold(record) {
  const threshold = Number(record && record.m_ContractBounsItemReqireCount);
  return Number.isInteger(threshold) && threshold > 0 ? threshold : 0;
}

function normalizeContractLikeRecord(contractIdOrRecord) {
  if (contractIdOrRecord && typeof contractIdOrRecord === "object") return contractIdOrRecord;
  const id = Number(contractIdOrRecord);
  if (!Number.isInteger(id) || id <= 0) return {};
  return (
    getContractRecord(id) ||
    getCustomPickupContractRecords().find((record) => Number(record.customPickupId) === id) ||
    {}
  );
}

function isAdminPlaceholderUnit(unitId) {
  const templet = getUnitTemplet(unitId) || {};
  return Number(unitId) === 1000 || String(templet.m_UnitStrID || "") === "NKM_NPC_ADMINISTRATOR";
}

function buildSyntheticPoolEntry(unitId) {
  const templet = getUnitTemplet(unitId) || {};
  return {
    unitId: Number(unitId) || 0,
    ratio: 1,
    grade: normalizeGrade(templet.m_NKM_UNIT_GRADE),
    pickupTarget: false,
    record: {},
  };
}

function normalizeGrade(value) {
  const text = String(value || "").toUpperCase();
  if (text.includes("SSR")) return "SSR";
  if (text.includes("SR")) return "SR";
  if (text.includes("R")) return "R";
  if (text.includes("N")) return "N";
  return "";
}

function spendContractCost(ctx, user, contractId, count) {
  return spendCostFromRecord(ctx, user, getContractRecord(contractId) || {}, count);
}

function spendCostFromRecord(ctx, user, record, count) {
  const prefix = Math.max(1, Number(count) || 1) >= 10 ? "m_MultiTryRequireItem" : "m_SingleTryRequireItem";
  const valuePrefix = Math.max(1, Number(count) || 1) >= 10 ? "m_MultiTryRequireItemValue" : "m_SingleTryRequireItemValue";
  const costItems = [];
  for (let index = 1; index <= 4; index += 1) {
    const itemId = Number(record[`${prefix}ID_${index}`] || 0);
    const value = toBigInt(record[`${valuePrefix}_${index}`] || 0, 0n);
    if (!Number.isInteger(itemId) || itemId <= 0 || value <= 0n) continue;
    const updated = spendMiscItem(user, itemId, value, { regDate: now(ctx) });
    if (updated) costItems.push(updated);
    if (updated) trackResourceSpend(ctx, user, itemId, value);
    break;
  }
  return costItems;
}

function buildMiscContractResultData(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.miscItemId || 0) || 0),
    writeNullableObjectList((result.units || []).map(buildUnitData)),
  ]);
}

function buildCustomPickupContractData(customPickupId, targetUnitId) {
  const state =
    customPickupId && typeof customPickupId === "object"
      ? customPickupId
      : {
          customPickupId,
          totalUseCount: 0,
          customPickupTargetUnitId: targetUnitId,
          currentSelectCount: 0,
        };
  return Buffer.concat([
    writeSignedVarInt(Number(state.customPickupId || 0) || 0),
    writeSignedVarInt(Number(state.totalUseCount || 0) || 0),
    writeSignedVarInt(Number(state.customPickupTargetUnitId || 0) || 0),
    writeSignedVarInt(Number(state.currentSelectCount || 0) || 0),
  ]);
}

function getAllCustomPickupContracts(user) {
  return getActiveCustomPickupContractRecords()
    .map((record) => getCustomPickupContractState(user, Number(record.customPickupId)));
}

function getCustomPickupContractState(user, customPickupId) {
  ensureContractStateStore(user);
  const record = getCustomPickupContractRecords().find((entry) => Number(entry.customPickupId) === Number(customPickupId)) || {};
  const includeOperators = String(record.m_ContractType || "") === "OPERATOR";
  const defaultTarget = normalizeCustomPickupTarget(record, 0, { includeOperators });
  if (!user) {
    return {
      customPickupId: Number(customPickupId) || 0,
      totalUseCount: 0,
      customPickupTargetUnitId: defaultTarget,
      currentSelectCount: 0,
    };
  }
  const key = String(Number(customPickupId) || 0);
  const existing = user.customPickupContracts[key] || findCustomPickupStateByType(user, record) || {};
  const maxSelectCount = getCustomPickupMaxSelectCount(record);
  const currentSelectCount = Math.max(0, Number(existing.currentSelectCount || 0));
  const state = {
    customPickupId: Number(customPickupId) || 0,
    totalUseCount: Number(existing.totalUseCount || 0),
    customPickupTargetUnitId: normalizeCustomPickupTarget(record, existing.customPickupTargetUnitId || defaultTarget, {
      includeOperators,
    }),
    currentSelectCount: maxSelectCount > 0 ? Math.min(currentSelectCount, maxSelectCount) : currentSelectCount,
  };
  user.customPickupContracts[key] = state;
  return state;
}

function getActiveCustomPickupContractRecords() {
  const selectedByType = new Map();
  for (const record of getCustomPickupContractRecords()) {
    if (!isMainCustomPickupRecord(record)) continue;
    const type = getCustomPickupType(record);
    const current = selectedByType.get(type);
    if (!current || scoreCustomPickupRecord(record) > scoreCustomPickupRecord(current)) {
      selectedByType.set(type, record);
    }
  }
  return Object.keys(CUSTOM_PICKUP_TYPE_ORDER)
    .map((type) => selectedByType.get(type))
    .filter(Boolean);
}

function isMainCustomPickupRecord(record) {
  if (!record || Number(record.customPickupId) <= 0) return false;
  const type = getCustomPickupType(record);
  if (!(type in CUSTOM_PICKUP_TYPE_ORDER)) return false;
  if (Number(record.m_ContractCategory || 0) !== CUSTOM_PICKUP_CATEGORY) return false;
  const openTag = String(record.m_OpenTag || "").toUpperCase();
  if (!openTag.includes("CONTRACT_CUSTOM")) return false;
  return !["DUMMY", "RETURN", "STARTER", "COMEBACK"].some((token) => openTag.includes(token));
}

function scoreCustomPickupRecord(record) {
  const maxSelectCount = getCustomPickupMaxSelectCount(record);
  const openTag = String(record && record.m_OpenTag || "").toUpperCase();
  return (
    (maxSelectCount >= 999 ? 100000 : 0) +
    (openTag.endsWith("_V2") ? 10000 : 0) +
    Math.max(0, Number(record && record.customPickupId) || 0)
  );
}

function getCustomPickupType(record) {
  return String(record && record.m_ContractType || "").toUpperCase();
}

function getCustomPickupMaxSelectCount(record) {
  return Math.max(0, Number(record && (record.maxSelectTargetCount || record.m_MaxSelectTargetCount || record.m_maxSelectTargetCount)) || 0);
}

function findCustomPickupStateByType(user, record) {
  if (!user || !record || !user.customPickupContracts) return null;
  const type = getCustomPickupType(record);
  const fallbackRecord = getCustomPickupContractRecords()
    .filter((entry) => Number(entry && entry.customPickupId) > 0 && getCustomPickupType(entry) === type)
    .sort((a, b) => scoreCustomPickupRecord(b) - scoreCustomPickupRecord(a))
    .find((entry) => user.customPickupContracts[String(Number(entry.customPickupId) || 0)]);
  return fallbackRecord ? user.customPickupContracts[String(Number(fallbackRecord.customPickupId) || 0)] : null;
}

function normalizeCustomPickupTarget(record, targetUnitId, options = {}) {
  const entries = getContractPoolUnitEntries(record && record.m_UnitPoolID, options).filter((entry) => entry.pickupTarget);
  const requested = Number(targetUnitId || 0);
  if (requested > 0 && entries.some((entry) => Number(entry.unitId) === requested)) return requested;
  return Number(entries[0] && entries[0].unitId) || 0;
}

function buildSelectableState(contractId) {
  const pool = getContractPoolUnitIds(contractId).slice(0, 10);
  return {
    contractId,
    unitIdList: pool,
    unitPoolChangeCount: 999999,
    isActive: true,
  };
}

function resolveContractId(contractId) {
  const id = Number(contractId);
  if (Number.isInteger(id) && id > 0 && (getContractRecord(id) || getContractTabRecord(id))) return id;
  return getVisibleContractIds()[0] || 4000;
}

function resolveMiscContractId(itemIdOrContractId) {
  const id = Number(itemIdOrContractId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  const misc = getMiscItemTemplet(id);
  if (misc && String(misc.m_ItemMiscType || "") === "IMT_CONTRACT") return Number(misc.m_typeValue || 0) || id;
  return id;
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  let payload = Buffer.alloc(0);
  try {
    payload = ctx.decryptCopy(encryptedPayload);
  } catch (_) {
    payload = Buffer.alloc(0);
  }
  let offset = 0;
  try {
    const nextInt = () => {
      const read = readSignedVarInt(payload, offset);
      offset = read.offset;
      return read.value;
    };
    switch (packetId) {
      case PACKETS.CONTRACT_REQ:
        return { contractId: nextInt(), count: nextInt(), costType: nextInt() };
      case PACKETS.CUSTOM_PICKUP_REQ:
        return { customPickupId: nextInt(), count: nextInt(), costType: nextInt() };
      case PACKETS.CUSTOM_PICUP_SELECT_TARGET_REQ:
        return { customPickupId: nextInt(), targetUnitId: nextInt() };
      case PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_REQ:
      case PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ:
        return { contractId: nextInt() };
      case PACKETS.MISC_CONTRACT_OPEN_REQ:
        return { miscItemId: nextInt(), count: nextInt() };
      case PACKETS.EXCHANGE_PIECE_TO_UNIT_REQ:
        return { itemId: nextInt(), count: nextInt() };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[contract] request decode failed packetId=${packetId}: ${err.message}`);
    return {};
  }
}

function ensureContractStateStore(user) {
  if (!user || typeof user !== "object") return;
  user.contractStates = user.contractStates && typeof user.contractStates === "object" ? user.contractStates : {};
  user.contractBonusStates =
    user.contractBonusStates && typeof user.contractBonusStates === "object" ? user.contractBonusStates : {};
  user.contractCursors = user.contractCursors && typeof user.contractCursors === "object" ? user.contractCursors : {};
  user.customPickupContracts =
    user.customPickupContracts && typeof user.customPickupContracts === "object" ? user.customPickupContracts : {};
}

function getSessionUser(ctx) {
  return ctx && ctx.socket && ctx.socket.session ? ctx.socket.session.user : null;
}

function persistUserDb(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function now(ctx) {
  return ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : farFutureDateTimeBinary();
}

function formatRequest(request) {
  const fields = [];
  for (const key of ["contractId", "customPickupId", "targetUnitId", "miscItemId", "itemId", "count", "costType"]) {
    if (request && request[key] != null) fields.push(`${key}=${request[key]}`);
  }
  return fields.join(" ");
}

module.exports = {
  PACKETS,
  createContractHandler,
  getAllContractStates,
  getAllContractBonusStates,
  getContractState,
  getContractBonusState,
  buildContractStateData,
  buildContractBonusStateData,
  buildCustomPickupContractData,
  getAllCustomPickupContracts,
  openMiscContract,
};
