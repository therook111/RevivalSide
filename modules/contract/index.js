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
  getAllContractIds,
  getVisibleContractIds,
  getContractPoolUnitIds,
  getContractPoolUnitEntries,
  getContractTabRecord,
  getSelectableContractRecord,
  getSelectableContractRecords,
  getSelectableContractPoolSlotEntries,
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
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking, queueMissionTracking } = require("../mission-tracking");
const { dateTimeBinaryForDate } = require("../server-time");

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
const SELECTABLE_CONTRACT_SLOT_COUNT = 10;
const CUSTOM_PICKUP_TYPE_ORDER = Object.freeze({
  AWAKEN: 0,
  BASIC: 1,
  OPERATOR: 2,
});
const CONTRACT_COST_TYPE = Object.freeze({
  FREE_CHANCE: 0,
  TICKET: 1,
  MONEY: 2,
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
      const missionTracking = trackContractMission(ctx, user, packetId, request);
      console.log(`[contract:${name}] ACK packetId=${response.packetId} ${formatRequest(request)}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      completeMissionTracking(ctx, socket, user, missionTracking, { label: "contract-mission-update" });
      persistUserDb(ctx);
      return true;
    },
  };
}

function trackContractMission(ctx, user, packetId, request = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return null;
  const nowValue = now(ctx);
  const tracking = makeMissionTracking(nowValue);
  const track = (condition, amount = 1, details = {}) => {
    const tracked = ctx.trackMissionEvent(user, condition, amount, { now: nowValue, ...details });
    addMissionTrackingCondition(tracking, condition, tracked);
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
  return tracking;
}

function trackResourceSpend(ctx, user, itemId, amount) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const numericItemId = Number(itemId || 0);
  const numericAmount = Math.max(0, Math.trunc(Number(amount || 0) || 0));
  if (numericItemId <= 0 || numericAmount <= 0) return;
  const nowValue = now(ctx);
  const tracking = makeMissionTracking(nowValue);
  const changed = ctx.trackMissionEvent(user, "USE_RESOURCE", numericAmount, {
    now: nowValue,
    itemId: numericItemId,
    resourceId: numericItemId,
    value: numericItemId,
  });
  addMissionTrackingCondition(tracking, "USE_RESOURCE", changed);
  queueMissionTracking(ctx, tracking);
}

function buildContractResponse(ctx, user, packetId, request) {
  switch (packetId) {
    case PACKETS.CONTRACT_STATE_LIST_REQ:
      return { packetId: PACKETS.CONTRACT_STATE_LIST_ACK, payload: buildContractStateListAck(user, ctx) };
    case PACKETS.INSTANT_CONTRACT_LIST_REQ:
      return { packetId: PACKETS.INSTANT_CONTRACT_LIST_ACK, payload: buildInstantContractListAck(user, ctx) };
    case PACKETS.CONTRACT_REQ:
      return { packetId: PACKETS.CONTRACT_ACK, payload: buildContractAck(ctx, user, request) };
    case PACKETS.CUSTOM_PICKUP_REQ:
      return { packetId: PACKETS.CUSTOM_PICKUP_ACK, payload: buildCustomPickupAck(ctx, user, request) };
    case PACKETS.CUSTOM_PICUP_SELECT_TARGET_REQ:
      return { packetId: PACKETS.CUSTOM_PICUP_SELECT_TARGET_ACK, payload: buildCustomPickupSelectTargetAck(user, request) };
    case PACKETS.MISC_CONTRACT_OPEN_REQ:
      return { packetId: PACKETS.MISC_CONTRACT_OPEN_ACK, payload: buildMiscContractOpenAck(ctx, user, request) };
    case PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_REQ:
      return { packetId: PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_ACK, payload: buildSelectableChangePoolAck(ctx, user, request) };
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
  const costItems = spendContractCost(ctx, user, contractId, count, request.costType);
  const reward = rollContract(ctx, user, contractId, count, { fromContract: true });
  applyContractRewards(ctx, user, contractId, count, reward);

  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number(request.costType || 0)),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeNullableObjectList(reward.units.map(buildUnitData)),
    writeNullableObjectList(reward.operators.map(buildOperatorData)),
    writeNullableObject(buildRewardData(reward)),
    writeNullableObject(buildContractStateData(getContractState(user, contractId, ctx))),
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
  const costItems = spendCostFromRecord(ctx, user, pickup, count, request.costType);
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
  if (targetUnitId > 0 && resolvedTargetId <= 0) {
    console.log(
      `[contract:custom-pickup] rejected target customPickupId=${customPickupId} targetUnitId=${targetUnitId} poolId=${pickup.m_UnitPoolID || 0}`
    );
  }
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

function buildSelectableChangePoolAck(ctx, user, request) {
  const contractId = resolveSelectableContractId(request.contractId);
  const state = changeSelectableContractPool(user, contractId);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildSelectableContractStateData(state)),
  ]);
}

function buildSelectableConfirmAck(ctx, user, request) {
  const contractId = resolveSelectableContractId(request.contractId);
  const state = getSelectableContractState(user, contractId);
  let costItems = [];
  let units = [];
  if (state.isActive !== false) {
    if (state.unitIdList.length < SELECTABLE_CONTRACT_SLOT_COUNT) {
      changeSelectableContractPool(user, contractId);
    }
    costItems = spendSelectableContractCost(ctx, user, contractId);
    const unitIds = getSelectableContractState(user, contractId).unitIdList.slice(0, SELECTABLE_CONTRACT_SLOT_COUNT);
    units = unitIds
      .map((unitId) => grantUnit(user, unitId, { fromContract: true, regDate: now(ctx) }))
      .filter(Boolean);
    const contractState = getContractState(user, contractId, ctx);
    contractState.totalUseCount += units.length > 0 ? 1 : 0;
    contractState.dailyUseCount += units.length > 0 ? 1 : 0;
  }
  const finalState = closeSelectableContractState(user, contractId);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(contractId),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeNullableObjectList(units.map(buildUnitData)),
    writeNullableObject(buildSelectableContractStateData(finalState)),
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

function buildContractStateListAck(user, ctx) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList(getAllContractStates(user, ctx).map(buildContractStateData)),
  ]);
}

function buildInstantContractListAck(user, ctx) {
  const activeCustom = getAllCustomPickupContracts(user, ctx).find((contract) => Number(contract.customPickupTargetUnitId) > 0);
  const activeRecord =
    activeCustom &&
    getActiveCustomPickupContractRecords(ctx).find((record) => Number(record.customPickupId) === Number(activeCustom.customPickupId));
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList([]),
    writeSignedVarInt(Number(activeCustom && activeCustom.customPickupTargetUnitId) || 0),
    writeNullableObject(buildContractBonusStateData(activeRecord ? getContractBonusState(user, activeRecord) : { bonusGroupId: 0 })),
  ]);
}

function getAllContractStates(user, ctx) {
  return getVisibleActiveContractRecords(ctx).map((entry) => getContractState(user, entry.contractId, ctx));
}

function getAllContractBonusStates(user, ctx) {
  const seen = new Set();
  const states = [];
  for (const record of [
    ...getVisibleActiveContractRecords(ctx).map((entry) => entry.record),
    ...getActiveCustomPickupContractRecords(ctx),
  ]) {
    const state = getContractBonusState(user, record);
    if (seen.has(state.bonusGroupId)) continue;
    seen.add(state.bonusGroupId);
    states.push(state);
  }
  return states;
}

function getVisibleActiveContractRecords(ctx) {
  const clockState = getActiveContractClockState(ctx);
  const active = getVisibleContractIds()
    .map((contractId) => ({ contractId, record: resolveContractRecord(contractId) }))
    .filter((entry) => isContractEntryVisibleForContentsTags(entry.record, entry.contractId, clockState))
    .filter((entry) => !isRetiredContractRecord(entry.record, entry.contractId))
    .filter((entry) => isContractRecordActiveForClock(entry.record, clockState, "contract"));
  const bestByKey = new Map();
  for (const entry of active) {
    const key = contractDedupeKey(entry.record, entry.contractId);
    if (!key) continue;
    const current = bestByKey.get(key);
    if (!current || scoreContractDedupeRecord(entry.record, entry.contractId) > scoreContractDedupeRecord(current.record, current.contractId)) {
      bestByKey.set(key, entry);
    }
  }
  return active.filter((entry) => {
    const key = contractDedupeKey(entry.record, entry.contractId);
    return !key || bestByKey.get(key) === entry;
  });
}

function filterDuplicateContractOpenTags(tags) {
  return filterDuplicateContractTags(tags, getContractRecordOpenTags);
}

function filterDuplicateContractIntervalTags(tags) {
  return filterDuplicateContractTags(tags, getContractRecordIntervalTags);
}

function filterDuplicateContractIntervalData(intervalData) {
  const input = Array.isArray(intervalData) ? intervalData : [];
  const filteredKeys = new Set(
    filterDuplicateContractIntervalTags(input.map((interval) => interval && interval.strKey)).map((tag) => normalizeTag(tag))
  );
  return input.filter((interval) => {
    const key = normalizeTag(interval && interval.strKey);
    return !key || filteredKeys.has(key);
  });
}

function filterDuplicateContractTags(tags, getTagsForRecord) {
  const input = Array.isArray(tags) ? tags : [];
  const activeTagKeys = new Set(input.map((tag) => normalizeTag(tag)).filter(Boolean));
  if (!activeTagKeys.size) return input.slice();

  const entriesByDedupeKey = new Map();
  for (const contractId of getAllContractIds()) {
    const record = resolveContractRecord(contractId);
    if (!record || isRetiredContractRecord(record, contractId)) continue;
    const matchedTags = getTagsForRecord(record, contractId).filter((tag) => activeTagKeys.has(tag));
    if (!matchedTags.length) continue;
    const key = contractDedupeKey(record, contractId);
    if (!key) continue;
    if (!entriesByDedupeKey.has(key)) entriesByDedupeKey.set(key, []);
    entriesByDedupeKey.get(key).push({ contractId, record, tags: matchedTags });
  }

  const suppressed = new Set();
  for (const entries of entriesByDedupeKey.values()) {
    if (entries.length <= 1) continue;
    let keeper = entries[0];
    for (const entry of entries.slice(1)) {
      if (scoreContractDedupeRecord(entry.record, entry.contractId) > scoreContractDedupeRecord(keeper.record, keeper.contractId)) {
        keeper = entry;
      }
    }
    const keeperTags = new Set(keeper.tags);
    for (const entry of entries) {
      if (entry === keeper) continue;
      for (const tag of entry.tags) {
        if (!keeperTags.has(tag)) suppressed.add(tag);
      }
    }
  }

  if (!suppressed.size) return input.slice();
  return input.filter((tag) => !suppressed.has(normalizeTag(tag)));
}

function getContractRecordOpenTags(record, contractId = 0) {
  const id = Number(record && (record.m_ContractID || record.ContractID || record.contractId)) || Number(contractId) || 0;
  const baseRecord = getContractRecord(id) || {};
  return normalizeTags([
    getRecordOpenTags(record),
    getRecordOpenTags(baseRecord),
  ]);
}

function getContractRecordIntervalTags(record, contractId = 0) {
  const id = Number(record && (record.m_ContractID || record.ContractID || record.contractId)) || Number(contractId) || 0;
  const baseRecord = getContractRecord(id) || {};
  return normalizeTags([
    getRecordIntervalTags(record),
    getRecordIntervalTags(baseRecord),
  ]);
}

function contractDedupeKey(record, contractId = 0) {
  if (!record) return "";
  const baseRecord = getContractRecord(Number(record.m_ContractID || record.ContractID || record.contractId || contractId) || 0) || {};
  const addUnitStrId = String(record.m_addUnitStrId || baseRecord.m_addUnitStrId || record.addUnitStrId || "").trim().toUpperCase();
  const category = Number(record.m_ContractCategory || baseRecord.m_ContractCategory || 0);
  const tags = [
    ...getRecordOpenTags(record),
    ...getRecordOpenTags(baseRecord),
    ...getRecordIntervalTags(record),
    ...getRecordIntervalTags(baseRecord),
    String(record.m_ContractName || ""),
    String(baseRecord.m_ContractName || ""),
  ].join("|");
  const pickupLike =
    category === 200 ||
    record.m_bPickUp === true ||
    baseRecord.m_bPickUp === true ||
    record.m_addUnitPickUp === true ||
    baseRecord.m_addUnitPickUp === true ||
    /CLASSIFIED|PICKUP/i.test(tags);
  const addUnitKey = normalizeContractUnitToken(addUnitStrId);
  const dedupeUnitKey = isPlaceholderContractUnitKey(addUnitKey) ? "" : addUnitKey;
  const visibleName = normalizeContractUnitToken(record.m_ContractName || baseRecord.m_ContractName || "");
  const visibleBanner = normalizeDedupeToken(record.m_MainBannerFileName || baseRecord.m_MainBannerFileName || "");
  const identity = pickupLike
    ? dedupeUnitKey || visibleName || visibleBanner
    : visibleName || visibleBanner || dedupeUnitKey;
  if (!identity) return "";
  return `${category || "pickup"}:${identity}`;
}

function scoreContractDedupeRecord(record, contractId = 0) {
  const id = Number(record && (record.m_ContractID || record.ContractID || record.contractId)) || Number(contractId) || 0;
  const baseRecord = getContractRecord(id) || {};
  const tags = [
    ...getRecordOpenTags(record),
    ...getRecordOpenTags(baseRecord),
    ...getRecordIntervalTags(record),
    ...getRecordIntervalTags(baseRecord),
  ].join("|").toUpperCase();
  return (
    (/GLOBAL/.test(tags) ? 1000000 : 0) +
    (/V4/.test(tags) ? 10000 : 0) +
    Math.max(0, id)
  );
}

function isRetiredContractRecord(record, contractId = 0) {
  const id = Number(record && (record.m_ContractID || record.ContractID || record.contractId)) || Number(contractId) || 0;
  const baseRecord = getContractRecord(id) || {};
  const text = [
    ...getRecordOpenTags(record),
    ...getRecordOpenTags(baseRecord),
    ...getRecordIntervalTags(record),
    ...getRecordIntervalTags(baseRecord),
    String(record && (record.m_ContractName || record.m_ContractStrID) || ""),
    String(baseRecord && (baseRecord.m_ContractName || baseRecord.m_ContractStrID) || ""),
  ].join("|").toUpperCase();
  return (
    text.includes("TAG_KOR_CONTRACT_OLD_VERSION") ||
    text.includes("DATE_KOR_CONTRACT_OLD_VERSION") ||
    text.includes("DATE_GLOBAL_CLASSIFIED_OLD_VERSION") ||
    text.includes("SI_NAME_CONTRACT_OLD")
  );
}

function resolveContractRecord(contractId) {
  return getContractTabRecord(contractId) || getContractRecord(contractId);
}

function getActiveContractClockState(ctx) {
  const empty = {
    enabled: false,
    contractIds: new Set(),
    customPickupIds: new Set(),
    openTags: new Set(),
    intervalTags: new Set(),
    intervalsByTag: new Map(),
    contentsTags: getContextContentsTagSet(ctx),
  };
  const manager = ctx && ctx.eventManager;
  if (!manager || typeof manager.getActiveEventState !== "function") return empty;
  let state = null;
  try {
    const nowDate = ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : undefined;
    state = manager.getActiveEventState(nowDate);
  } catch (_) {
    state = null;
  }
  if (!state || !state.enabled) return empty;

  const result = {
    enabled: true,
    contractIds: new Set(),
    customPickupIds: new Set(),
    openTags: new Set(),
    intervalTags: new Set(),
    intervalsByTag: new Map(),
    contentsTags: getContextContentsTagSet(ctx, state),
  };
  for (const interval of Array.isArray(state.intervalData) ? state.intervalData : []) {
    const tag = normalizeTag(interval && interval.strKey);
    if (!tag) continue;
    result.intervalTags.add(tag);
    result.intervalsByTag.set(tag, interval);
  }
  for (const entry of Array.isArray(state.entries) ? state.entries : []) {
    if (!isContractClockEntry(entry)) continue;
    for (const tag of normalizeTags(entry.openTags || [])) result.openTags.add(tag);
    for (const tag of normalizeTags(entry.intervalTags || [])) result.intervalTags.add(tag);

    const tableName = String(entry && entry.source && entry.source.tableName || "").toUpperCase();
    const raw = entry && entry.raw && typeof entry.raw === "object" ? entry.raw : {};
    if (tableName.includes("CONTRACT_CUSTOM_PICKUP")) {
      const id = Number(raw.customPickupId || raw.m_CustomPickupID || raw.CustomPickupID || entry.id || 0);
      if (Number.isInteger(id) && id > 0) result.customPickupIds.add(id);
    } else if (tableName.includes("CONTRACT")) {
      const id = Number(raw.m_ContractID || raw.ContractID || raw.contractId || entry.id || 0);
      if (Number.isInteger(id) && id > 0) result.contractIds.add(id);
    }
  }
  return result;
}

function isContractClockEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const tableName = String(entry.source && entry.source.tableName || "").toUpperCase();
  const raw = entry.raw && typeof entry.raw === "object" ? entry.raw : {};
  if (tableName === "OFFICIAL_EVENT_SCHEDULE") {
    const scheduleType = String(raw.scheduleType || raw.type || "").toUpperCase();
    return /CONTRACT|PICKUP|CLASSIFIED/.test(scheduleType);
  }
  if (tableName.includes("CONTRACT_CUSTOM_PICKUP")) return !isShopInheritedEventEntry(entry);
  if (tableName === "CONTRACT_TAB" || (tableName.includes("CONTRACT") && Number(raw.m_ContractID || raw.ContractID || 0) > 0)) {
    return !isShopInheritedEventEntry(entry);
  }
  return false;
}

function isShopInheritedEventEntry(entry) {
  const inherited = entry && entry.inheritedWindowSource ? entry.inheritedWindowSource : null;
  const inheritedTable = String(inherited && inherited.tableName || "").toUpperCase();
  const inheritedPath = String(inherited && inherited.relativePath || "").toUpperCase();
  return /SHOP/.test(inheritedTable) || /SHOP/.test(inheritedPath);
}

function isContractRecordActiveForClock(record, clockState, kind = "contract") {
  if (!record) return false;
  if (!clockState || !clockState.enabled) return !isClockGatedContractRecord(record, kind);
  const contractId = Number(record.m_ContractID || record.ContractID || record.contractId || 0);
  const customPickupId = Number(record.customPickupId || record.m_CustomPickupID || record.CustomPickupID || 0);
  if (kind === "custom" && isAlwaysOnCustomPickupRecord(record)) return true;
  if (kind === "custom" && customPickupId > 0 && clockState.customPickupIds.has(customPickupId)) return true;
  if (contractId > 0 && clockState.contractIds.has(contractId)) return true;
  if (hasActiveClockTag(record, clockState)) return true;
  return !isClockGatedContractRecord(record, kind);
}

function isContractEntryVisibleForContentsTags(record, contractId, clockState) {
  const id = Number(record && (record.m_ContractID || record.ContractID || record.contractId)) || Number(contractId) || 0;
  const baseRecord = getContractRecord(id) || {};
  return isRecordVisibleForContentsTags(record, clockState) && isRecordVisibleForContentsTags(baseRecord, clockState);
}

function isRecordVisibleForContentsTags(record, clockState) {
  if (!record) return true;
  const activeTags = clockState && clockState.contentsTags instanceof Set ? clockState.contentsTags : new Set();
  const ignoreTags = getRecordContentsIgnoreTags(record);
  if (ignoreTags.some((tag) => activeTags.has(tag))) return false;

  const allowTags = getRecordContentsAllowTags(record);
  if (allowTags.length && !allowTags.some((tag) => activeTags.has(tag))) return false;
  return true;
}

function getContextContentsTagSet(ctx, activeState = null) {
  const tags = [];
  let hasContextTags = false;
  if (Array.isArray(ctx && ctx.contentsTags)) {
    tags.push(...ctx.contentsTags);
    hasContextTags = true;
  }
  if (ctx && typeof ctx.getEffectiveContentsTags === "function") {
    try {
      tags.push(...ctx.getEffectiveContentsTags((ctx.config && ctx.config.CONTENTS_TAGS) || []));
      hasContextTags = true;
    } catch (_) {
      // keep any explicit context tags collected above
    }
  }
  if (!hasContextTags && activeState && Array.isArray(activeState.contentsTags)) tags.push(...activeState.contentsTags);
  if (!hasContextTags && activeState && Array.isArray(activeState.counterPassContentsTags)) tags.push(...activeState.counterPassContentsTags);
  return new Set(normalizeTags(tags).filter((tag) => !isObsoleteContractContentsTag(tag)));
}

function hasActiveClockTag(record, clockState) {
  for (const tag of getRecordOpenTags(record)) {
    if (clockState.openTags.has(tag)) return true;
  }
  for (const tag of getRecordIntervalTags(record)) {
    if (clockState.intervalTags.has(tag)) return true;
  }
  return false;
}

function isClockGatedContractRecord(record, kind = "contract") {
  if (!record) return false;
  if (kind === "custom" || Number(record.customPickupId || 0) > 0) return true;
  if (record.m_bPickUp === true || record.m_bPickUp === "true") return true;
  const category = Number(record.m_ContractCategory || 0);
  if (category === CUSTOM_PICKUP_CATEGORY) return true;
  const tags = [...getRecordOpenTags(record), ...getRecordIntervalTags(record)];
  if (!tags.length) return false;
  if (tags.some(isAlwaysOnContractTag)) return false;
  return tags.some((tag) => /20\d{2}|PICKUP|AWAKEN|CLASSIFIED|CUSTOM|LIMITED|SPECIAL|EVENT|ADMIN|FIRST_UNIT|UNIT_/i.test(tag));
}

function isAlwaysOnContractTag(tag) {
  const key = String(tag || "").toUpperCase();
  return (
    key === "TAG_GLOBAL_CONTRACT_BASIC" ||
    key === "TAG_GLOBAL_CONTRACT_BASIC_V2" ||
    key === "TAG_GLOBAL_CONTRACT_BASIC_DISPATCH" ||
    key === "DATE_GLOBAL_CONTRACT_BASIC" ||
    key === "DATE_GLOBAL_CONTRACT_BASIC_V2" ||
    key === "DATE_GLOBAL_CONTRACT_BASIC_DISPATCH" ||
    key === "DATE_GLOBAL_CONTRACT_SELECTABLE" ||
    key === "TAG_GLOBAL_CONTRACT_SELECTABLE" ||
    key.includes("CONTRACT_NEWBIE")
  );
}

function isAlwaysOnCustomPickupRecord(record) {
  const tags = [...getRecordOpenTags(record), ...getRecordIntervalTags(record)];
  return tags.some((tag) => tag.includes("CONTRACT_CUSTOM") && !/20\d{2}|LIMITED|EVENT/.test(tag));
}

function getContractNextResetDate(contractId, ctx) {
  const clockState = getActiveContractClockState(ctx);
  const record = resolveContractRecord(contractId) || {};
  for (const tag of getRecordIntervalTags(record)) {
    const interval = clockState.intervalsByTag.get(tag);
    const endDate = interval && interval.endDate instanceof Date && !Number.isNaN(interval.endDate.getTime()) ? interval.endDate : null;
    if (endDate) return dateTimeBinaryForDate(endDate);
  }
  return farFutureDateTimeBinary();
}

function getRecordOpenTags(record) {
  return normalizeTags([
    record && record.m_OpenTag,
    record && record.OpenTag,
    record && record.openTag,
    ...(Array.isArray(record && record.listOpenTag) ? record.listOpenTag : []),
    ...(Array.isArray(record && record.listOpenTags) ? record.listOpenTags : []),
  ]);
}

function getRecordIntervalTags(record) {
  return normalizeTags([
    record && record.m_DateStrID,
    record && record.m_DateStrId,
    record && record.DateStrID,
    record && record.m_IntervalStrID,
    record && record.m_EventDateStrID,
    record && record.EventRateDateStrID,
  ]);
}

function getRecordContentsAllowTags(record) {
  return normalizeTags([
    record && record.listContentsTagAllow,
    record && record.contentsTagAllow,
    record && record.ContentsTagAllow,
    record && record.m_ContentsTagAllow,
    record && record.m_ContentsTag,
    record && record.listContentsTag,
  ]);
}

function getRecordContentsIgnoreTags(record) {
  return normalizeTags([
    record && record.listContentsTagIgnore,
    record && record.contentsTagIgnore,
    record && record.ContentsTagIgnore,
    record && record.m_ContentsTagIgnore,
  ]);
}

function normalizeTags(values) {
  return (Array.isArray(values) ? values : [values])
    .flatMap((value) => (Array.isArray(value) ? value : String(value || "").split(/[,|;\s]+/)))
    .map(normalizeTag)
    .filter(Boolean);
}

function normalizeTag(value) {
  const tag = String(value || "").trim().toUpperCase();
  return tag && tag !== "NONE" && tag !== "NULL" ? tag : "";
}

function normalizeDedupeToken(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeContractUnitToken(value) {
  return normalizeDedupeToken(value)
    .replace(/^NKM_UNIT_/, "")
    .replace(/^SI_UNIT_NAME_/, "")
    .replace(/^SI_UNIT_TITLE_/, "")
    .replace(/^SI_NAME_UNIT_/, "");
}

function isObsoleteContractContentsTag(tag) {
  const key = String(tag || "").toUpperCase();
  return (
    key === "TAG_GLOBAL_CONTRACT_BASIC" ||
    key === "TAG_GLOBAL_CONTRACT_OPERATOR_TUTORIAL" ||
    key === "TAG_GLOBAL_CONTRACT_CBT" ||
    key === "TAG_GLOBAL_CONTRACT_OBT"
  );
}

function isPlaceholderContractUnitKey(value) {
  const key = normalizeDedupeToken(value);
  return key === "NKM_NPC_ADMINISTRATOR" || key === "NPC_ADMINISTRATOR" || key === "ADMINISTRATOR";
}

function getContractState(user, contractId, ctx) {
  ensureContractStateStore(user);
  const resetDate = getContractNextResetDate(contractId, ctx);
  if (!user) {
    return {
      contractId: Number(contractId) || 0,
      remainFreeChance: Number((getContractRecord(contractId) || {}).m_FreeTryCnt || 0),
      nextResetDate: String(resetDate),
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
    nextResetDate: String(resetDate),
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
  const state = getContractState(user, contractId, ctx);
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

function spendContractCost(ctx, user, contractId, count, costType) {
  return spendCostFromRecord(ctx, user, getContractRecord(contractId) || {}, count, costType);
}

function spendCostFromRecord(ctx, user, record, count, costType) {
  const slot = getCostSlot(costType);
  if (slot <= 0) return [];

  const requestCount = Math.max(1, Math.trunc(Number(count) || 1));
  const cost = getTryCost(record, slot, requestCount);
  if (!cost) return [];

  const updated = spendMiscItem(user, cost.itemId, cost.amount, { regDate: now(ctx) });
  if (!updated) return [];
  trackResourceSpend(ctx, user, cost.itemId, cost.amount);
  return [updated];
}

function getCostSlot(costType) {
  const value = Number(costType);
  if (value === CONTRACT_COST_TYPE.FREE_CHANCE) return 0;
  if (value === CONTRACT_COST_TYPE.TICKET) return 1;
  if (value === CONTRACT_COST_TYPE.MONEY) return 2;
  return 0;
}

function getTryCost(record, slot, count) {
  const singleItemId = Number(record[`m_SingleTryRequireItemID_${slot}`] || 0);
  const singleValue = toBigInt(record[`m_SingleTryRequireItemValue_${slot}`] || 0, 0n);
  if (Number.isInteger(singleItemId) && singleItemId > 0 && singleValue > 0n) {
    return { itemId: singleItemId, amount: singleValue * BigInt(count) };
  }

  const multiItemId = Number(record[`m_MultiTryRequireItemID_${slot}`] || 0);
  const multiValue = toBigInt(record[`m_MultiTryRequireItemValue_${slot}`] || 0, 0n);
  if (count >= 10 && Number.isInteger(multiItemId) && multiItemId > 0 && multiValue > 0n) {
    return { itemId: multiItemId, amount: multiValue };
  }

  return null;
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

function getAllCustomPickupContracts(user, ctx) {
  return getActiveCustomPickupContractRecords(ctx)
    .map((record) => getCustomPickupContractState(user, Number(record.customPickupId)));
}

function getCustomPickupContractState(user, customPickupId) {
  ensureContractStateStore(user);
  const record = getCustomPickupContractRecords().find((entry) => Number(entry.customPickupId) === Number(customPickupId)) || {};
  const includeOperators = String(record.m_ContractType || "") === "OPERATOR";
  if (!user) {
    return {
      customPickupId: Number(customPickupId) || 0,
      totalUseCount: 0,
      customPickupTargetUnitId: 0,
      currentSelectCount: 0,
    };
  }
  const key = String(Number(customPickupId) || 0);
  const existing = user.customPickupContracts[key] || findCustomPickupStateByType(user, record) || {};
  const maxSelectCount = getCustomPickupMaxSelectCount(record);
  const currentSelectCount = Math.max(0, Number(existing.currentSelectCount || 0));
  const existingTarget = Number(existing.customPickupTargetUnitId || 0);
  const selectedTarget = existingTarget > 0 && currentSelectCount > 0
    ? normalizeCustomPickupTarget(record, existingTarget, { includeOperators })
    : 0;
  const state = {
    customPickupId: Number(customPickupId) || 0,
    totalUseCount: Number(existing.totalUseCount || 0),
    customPickupTargetUnitId: selectedTarget,
    currentSelectCount: maxSelectCount > 0 ? Math.min(currentSelectCount, maxSelectCount) : currentSelectCount,
  };
  user.customPickupContracts[key] = state;
  return state;
}

function getActiveCustomPickupContractRecords(ctx) {
  const clockState = getActiveContractClockState(ctx);
  const selectedByType = new Map();
  for (const record of getCustomPickupContractRecords()) {
    if (!isMainCustomPickupRecord(record)) continue;
    if (!isContractRecordActiveForClock(record, clockState, "custom")) continue;
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
  if (!Number.isInteger(requested) || requested <= 0) return 0;
  if (requested > 0 && entries.some((entry) => Number(entry.unitId) === requested)) return requested;
  if (requested <= entries.length) return Number(entries[requested - 1] && entries[requested - 1].unitId) || 0;
  return 0;
}

function getSelectableContractState(user, requestedContractId = 0) {
  const contractId = resolveSelectableContractId(requestedContractId);
  const config = getSelectableContractConfig(contractId);
  if (!user) {
    return createSelectableState(config.contractId, [], 0, config.isActive);
  }

  ensureContractStateStore(user);
  const existing = user.selectableContractState && typeof user.selectableContractState === "object" ? user.selectableContractState : {};
  const existingContractId = Number(existing.contractId || 0);
  if (existingContractId > 0 && existingContractId !== config.contractId && requestedContractId) {
    const state = createSelectableState(config.contractId, [], 0, config.isActive);
    user.selectableContractState = state;
    return state;
  }

  const state = createSelectableState(
    existingContractId || config.contractId,
    existing.unitIdList,
    existing.unitPoolChangeCount,
    existing.isActive !== false && config.isActive
  );
  user.selectableContractState = state;
  return state;
}

function changeSelectableContractPool(user, requestedContractId = 0) {
  const contractId = resolveSelectableContractId(requestedContractId);
  const config = getSelectableContractConfig(contractId);
  const state = getSelectableContractState(user, contractId);
  if (state.isActive === false) return state;

  const atLimit = config.maxChangeCount > 0 && state.unitPoolChangeCount >= config.maxChangeCount;
  if (atLimit && state.unitIdList.length === SELECTABLE_CONTRACT_SLOT_COUNT) return state;

  state.contractId = config.contractId;
  state.unitIdList = rollSelectableUnitIdList(config);
  state.unitPoolChangeCount = config.maxChangeCount > 0
    ? Math.min(config.maxChangeCount, state.unitPoolChangeCount + 1)
    : state.unitPoolChangeCount + 1;
  state.isActive = true;
  if (user) user.selectableContractState = state;
  return state;
}

function closeSelectableContractState(user, requestedContractId = 0) {
  const state = getSelectableContractState(user, requestedContractId);
  state.isActive = false;
  if (user) user.selectableContractState = state;
  return state;
}

function createSelectableState(contractId, unitIdList, unitPoolChangeCount, isActive) {
  return {
    contractId: Number(contractId) || 0,
    unitIdList: normalizeSelectableUnitIdList(unitIdList),
    unitPoolChangeCount: Math.max(0, Math.trunc(Number(unitPoolChangeCount || 0) || 0)),
    isActive: isActive !== false && Number(contractId) > 0,
  };
}

function rollSelectableUnitIdList(config) {
  const slotGroups = getSelectableContractPoolSlotEntries(config.poolId);
  const bySlot = new Map(slotGroups.map((group) => [Number(group.slotNumber), group.entries || []]));
  const fallbackEntries = slotGroups.flatMap((group) => group.entries || []);
  if (!fallbackEntries.length) {
    fallbackEntries.push(...getContractPoolUnitIds(config.poolId).map(buildSyntheticPoolEntry));
  }
  if (!fallbackEntries.length) fallbackEntries.push(buildSyntheticPoolEntry(1001));

  const unitIds = [];
  for (let slot = 1; slot <= SELECTABLE_CONTRACT_SLOT_COUNT; slot += 1) {
    const entries = bySlot.get(slot);
    const entry = pickWeighted(entries && entries.length ? entries : fallbackEntries, (candidate) => candidate.ratio);
    unitIds.push(Number(entry && entry.unitId) || 1001);
  }
  return unitIds;
}

function normalizeSelectableUnitIdList(unitIdList) {
  return (Array.isArray(unitIdList) ? unitIdList : [])
    .map((unitId) => Number(unitId))
    .filter((unitId) => Number.isInteger(unitId) && unitId > 0)
    .slice(0, SELECTABLE_CONTRACT_SLOT_COUNT);
}

function getSelectableContractConfig(requestedContractId = 0) {
  const contractId = resolveSelectableContractId(requestedContractId);
  const record = getSelectableContractRecord(contractId) || {};
  const poolId = record.m_SelectableUnitPoolId || record.m_UnitPoolID || contractId;
  return {
    contractId,
    poolId,
    maxChangeCount: Math.max(0, Math.trunc(Number(record.m_UnitPoolChangeCount || 0) || 0)),
    requireItemId: Number(record.m_RequireItemID || 0) || 0,
    requireItemCount: toBigInt(record.m_RequireItemValue || 0, 0n),
    isActive: contractId > 0,
  };
}

function spendSelectableContractCost(ctx, user, requestedContractId = 0) {
  const config = getSelectableContractConfig(requestedContractId);
  if (!config.requireItemId || config.requireItemCount <= 0n) return [];
  const updated = spendMiscItem(user, config.requireItemId, config.requireItemCount, { regDate: now(ctx) });
  if (!updated) return [];
  trackResourceSpend(ctx, user, config.requireItemId, config.requireItemCount);
  return [updated];
}

function resolveSelectableContractId(contractId) {
  const id = Number(contractId);
  if (Number.isInteger(id) && id > 0 && getSelectableContractRecord(id)) return id;
  const first = getSelectableContractRecords()
    .map((record) => Number(record && record.m_ContractID))
    .find((candidate) => Number.isInteger(candidate) && candidate > 0);
  if (first) return first;
  return resolveContractId(contractId);
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
  user.selectableContractState =
    user.selectableContractState && typeof user.selectableContractState === "object" ? user.selectableContractState : {};
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
  getSelectableContractState,
  buildContractStateData,
  buildContractBonusStateData,
  buildCustomPickupContractData,
  getAllCustomPickupContracts,
  filterDuplicateContractOpenTags,
  filterDuplicateContractIntervalTags,
  filterDuplicateContractIntervalData,
  openMiscContract,
};
