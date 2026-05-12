const {
  writeBool,
  writeByte,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
  writeNullableObject,
  writeNullableObjectOrNull,
  writeNullObject,
  writeObjectList,
  writeLongArray,
  buildEquipItemData,
  buildEquipTuningCandidateData,
  buildPotentialOptionCandidateData,
  buildEquipPresetData,
  buildEquipProfileInfoData,
  buildRewardData,
  buildItemMiscData,
  readBool,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarIntList,
  readSignedVarLongList,
  readString,
  statTypeValue,
  toBigInt,
} = require("../packet-codec");
const {
  grantEquipItem,
  removeEquipItems,
  equipItemToUnit,
  unequipItem,
  lockEquipItem,
  enchantEquipItem,
  rollEquipPrecision,
  rollEquipSubstat,
  confirmEquipSubstat,
  cancelEquipTuning,
  rollSetOption,
  confirmSetOption,
  imprintEquip,
  openPotentialSocket,
  rollPotentialOption,
  confirmPotentialOption,
  getEquipItems,
  getEquipPresets,
  addEquipPresets,
  setEquipPresetName,
  registerEquipPreset,
  registerEquipPresetFromUnit,
  applyEquipPreset,
  clearEquipPresets,
  changeEquipPresetIndices,
} = require("../equipment");
const { grantMiscItem, spendMiscItem } = require("../inventory");
const { grantRewardByType, createEmptyReward, grantChoiceItemReward } = require("../reward");

const EQUIP_PACKET_IDS = [
  1000, 1002, 1004, 1006, 1008, 1010, 1012, 1014, 1016, 1018,
  1020, 1022, 1024, 1026, 1028, 1030, 1032, 1034, 1036, 1040,
  1042, 1044, 1046, 1048, 1052, 1055, 1057, 1059, 1061, 1063,
  1066, 1068, 1070, 1072, 1074, 1076,
];

function createEquipmentPipelineHandlers() {
  return EQUIP_PACKET_IDS.map((packetId) => ({
    packetId,
    name: `EQUIPMENT_PIPELINE_${packetId}`,
    handle(ctx, socket, packet) {
      const user = (socket.session && socket.session.user) || ctx.createEphemeralUser();
      if (socket.session) socket.session.user = user;
      const request = decodeRequest(ctx, packetId, packet.payload);
      const response = buildResponse(ctx, user, packetId, request);
      trackEquipmentMission(ctx, user, packetId, request);
      console.log(`[equipment:${packetId}] ACK packetId=${response.packetId} payloadSize=${response.payload.length}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      if (ctx.config.USE_LOCAL_USER_DB) ctx.saveUserDb();
      return true;
    },
  }));
}

function trackEquipmentMission(ctx, user, packetId, request = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const nowValue = now(ctx);
  let changed = false;
  const changedConditions = new Set();
  const track = (condition, amount = 1, details = {}) => {
    const tracked = ctx.trackMissionEvent(user, condition, amount, { now: nowValue, ...details });
    if (tracked) changedConditions.add(condition);
    changed = tracked || changed;
  };
  const trackResourceSpend = (itemId, amount) => {
    const numericItemId = Number(itemId || 0);
    const numericAmount = Math.max(0, Math.trunc(Number(amount || 0) || 0));
    if (numericItemId > 0 && numericAmount > 0) {
      track("USE_RESOURCE", numericAmount, { itemId: numericItemId, resourceId: numericItemId, value: numericItemId });
    }
  };

  switch (packetId) {
    case 1002:
    case 1057:
    case 1063:
      track("EQUIP_ENCHANT", 1, { equipUid: request.equipItemUID || request.equipUid });
      break;
    case 1076:
      track("EQUIP_ENCHANT", Math.max(1, (request.equipItemUIDList || []).length));
      break;
    case 1020:
    case 1024:
    case 1028:
    case 1032:
    case 1034:
      track("EQUIP_TUNING", 1, { equipUid: request.equipUID || request.equipUid });
      break;
    case 1014:
    case 1016:
      track("EQUIP_MAKE", 1);
      break;
    case 1066:
      track("EQUIP_MAKE", Math.max(1, Number(request.moldCount || 1) || 1), { itemId: request.moldId });
      break;
    case 1008:
      trackResourceSpend(request.itemID || request.itemId, request.count || 1);
      break;
    case 1026:
      trackResourceSpend(request.itemId, request.count || 1);
      break;
    default:
      break;
  }

  if (changed && typeof ctx.refreshMissionProgress === "function") {
    ctx.refreshMissionProgress(user, { now: nowValue, conditions: Array.from(changedConditions) });
  }
}

function buildResponse(ctx, user, packetId, req) {
  switch (packetId) {
    case 1000:
      return equipItemAck(user, req);
    case 1002:
      return enchantAck(user, req, 1003);
    case 1004:
      return lockAck(user, req);
    case 1006:
      return removeAck(user, req);
    case 1008:
      return randomBoxAck(ctx, user, req);
    case 1010:
      return craftUnlockAck();
    case 1012:
      return craftStartAck(user, req);
    case 1014:
    case 1016:
      return craftCompleteAck(user, req, packetId + 1);
    case 1018:
      return refineAck(user, req);
    case 1020:
      return statRollAck(user, req);
    case 1022:
      return statConfirmAck(user, req);
    case 1024:
      return statBonusConfirmAck(user, req);
    case 1026:
      return choiceItemAck(ctx, user, req);
    case 1028:
      return setOptionRollAck(user, req);
    case 1030:
      return setOptionConfirmAck(user, req);
    case 1032:
      return setOptionBonusConfirmAck(user, req);
    case 1034:
      return firstSetOptionAck(user, req);
    case 1036:
      return profileAck(user);
    case 1040:
      return presetAddAck(user, req);
    case 1042:
      return presetNameAck(user, req);
    case 1044:
      return presetRegisterAllAck(user, req);
    case 1046:
      return presetRegisterAck(user, req);
    case 1048:
      return presetApplyAck(user, req);
    case 1052:
      return tuningCancelAck(user);
    case 1055:
      return imprintAck(user, req);
    case 1057:
      return upgradeAck(user, req);
    case 1059:
      return openSocketAck(user, req);
    case 1061:
      return presetChangeIndexAck(user, req);
    case 1063:
      return enchantAck(user, req, 1064);
    case 1066:
      return craftInstantAck(user, req);
    case 1068:
      return potentialRollAck(user, req);
    case 1070:
      return potentialConfirmAck(user, req);
    case 1072:
      return potentialCancelAck(user);
    case 1074:
      return presetClearAck(user, req);
    case 1076:
      return multipleEnchantAck(user, req);
    default:
      return { packetId: packetId + 1, payload: writeSignedVarInt(0) };
  }
}

function equipItemAck(user, req) {
  const isUnequip = req.isEquip === false;
  const result = isUnequip
    ? unequipItem(user, req.equipItemUID)
    : equipItemToUnit(user, req.unitUID, req.equipItemUID, req.equipPosition);
  const equipItemUID = isUnequip ? 0 : req.equipItemUID || (result.equip && result.equip.equipUid) || 0;
  const unequipItemUID = isUnequip
    ? result.unequipItemUID || req.equipItemUID || 0
    : result.unequipItemUID || 0;
  return {
    packetId: 1001,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.unitUID || (result.unit && result.unit.unitUid) || 0)),
      writeSignedVarLong(toBigInt(equipItemUID)),
      writeSignedVarLong(toBigInt(unequipItemUID)),
      writeSignedVarInt(Number(result.position != null ? result.position : req.equipPosition || 0) || 0),
    ]),
  };
}

function enchantAck(user, req, packetId) {
  const result = enchantEquipItem(user, req.equipItemUID, req.consumeEquipItemUIDList || req.equipItemUIDList || []);
  const equip = result && result.equip;
  return {
    packetId,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipItemUID || 0)),
      writeSignedVarInt(Number(equip && equip.enchantLevel) || 0),
      writeSignedVarInt(Number(equip && equip.enchantExp) || 0),
      writeLongArray(result ? result.consumed : []),
      writeObjectList([]),
    ]),
  };
}

function lockAck(user, req) {
  const equip = lockEquipItem(user, req.equipItemUID, req.isLock);
  return {
    packetId: 1005,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipItemUID || 0)),
      writeBool(Boolean(equip && equip.locked)),
    ]),
  };
}

function removeAck(user, req) {
  const removed = removeEquipItems(user, req.removeEquipItemUIDList || []);
  const rewardItems = removed.length ? [grantMiscItem(user, 1, BigInt(removed.length * 1000), 0n)] : [];
  return {
    packetId: 1007,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeLongArray(removed),
      writeObjectList(rewardItems.filter(Boolean).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
  };
}

function randomBoxAck(ctx, user, req) {
  const itemId = Number(req.itemID || req.itemId || 0);
  const count = Math.max(1, Number(req.count || 1));
  const costItem = itemId > 0 ? spendMiscItem(user, itemId, count, { regDate: now(ctx) }) : null;
  const reward = grantRewardByType(ctx, user, "RT_MISC", itemId, count, count, 0, {
    expandPackages: true,
    regDate: now(ctx),
  });
  return {
    packetId: 1009,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildRewardData(reward)),
      writeNullableObjectOrNull(costItem ? buildItemMiscData(costItem) : null),
    ]),
  };
}

function craftUnlockAck() {
  return {
    packetId: 1011,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullObject(), writeObjectList([])]),
  };
}

function craftStartAck(_user, _req) {
  return {
    packetId: 1013,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullObject(), writeObjectList([]), writeNullObject()]),
  };
}

function craftCompleteAck(user, req, packetId) {
  const reward = createEmptyReward();
  const count = Math.max(1, Number(req.count || 1));
  for (let index = 0; index < count; index += 1) {
    const equip = grantEquipItem(user, 0, { cursor: index });
    if (equip) reward.equips.push(equip);
  }
  const extraCost = packetId === 1017 ? writeNullObject() : Buffer.alloc(0);
  return {
    packetId,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullObject(),
      extraCost,
      writeNullableObject(buildRewardData(reward)),
    ]),
  };
}

function refineAck(user, req) {
  const result = rollEquipPrecision(user, req.equipUID, req.equipOptionID);
  return {
    packetId: 1019,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarInt(0),
      writeSignedVarInt(Number(result && result.precision) || 0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeObjectList([]),
    ]),
  };
}

function statRollAck(user, req) {
  const result = rollEquipSubstat(user, req.equipUID, req.equipOptionID);
  return {
    packetId: 1021,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarInt(Number(req.equipOptionID || 0) || 0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeObjectList([]),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
      writeNullObject(),
    ]),
  };
}

function statConfirmAck(user, req) {
  const result = confirmEquipSubstat(user, req.equipUID, req.equipOptionID);
  return {
    packetId: 1023,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
    ]),
  };
}

function statBonusConfirmAck(user, req) {
  const rolled = rollEquipSubstat(user, req.equipUid, req.equipOptionId, req.statType);
  const result = confirmEquipSubstat(user, req.equipUid, req.equipOptionId);
  return {
    packetId: 1025,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : rolled && rolled.equip ? buildEquipItemData(rolled.equip) : null),
      writeNullObject(),
    ]),
  };
}

function choiceItemAck(ctx, user, req) {
  const itemId = Number(req.itemId || 0);
  const rewardId = Number(req.rewardId || 0);
  const count = Math.max(1, Number(req.count || 1));
  const costItem = itemId > 0 ? spendMiscItem(user, itemId, count, { regDate: now(ctx) }) : null;
  const reward = grantChoiceItemReward(ctx, user, itemId, rewardId, count, {
    expandPackages: true,
    regDate: now(ctx),
    rewardId,
    setOptionId: Number(req.setOptionId || 0),
    subSkillId: Number(req.subSkillId || 0),
  });
  return {
    packetId: 1027,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(costItem ? buildItemMiscData(costItem) : null),
      writeNullableObject(buildRewardData(reward)),
    ]),
  };
}

function setOptionRollAck(user, req) {
  const result = rollSetOption(user, req.equipUID);
  return {
    packetId: 1029,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUID || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
      writeObjectList([]),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
      writeNullObject(),
    ]),
  };
}

function setOptionConfirmAck(user, req) {
  const result = confirmSetOption(user, req.equipUID);
  return {
    packetId: 1031,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUID || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
    ]),
  };
}

function setOptionBonusConfirmAck(user, req) {
  const result = confirmSetOption(user, req.equipUid, req.setOptionId);
  return {
    packetId: 1033,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUid || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
      writeNullObject(),
    ]),
  };
}

function firstSetOptionAck(user, req) {
  const rolled = rollSetOption(user, req.equipUID);
  const result = confirmSetOption(user, req.equipUID, rolled && rolled.setOptionId);
  return {
    packetId: 1035,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUID || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
    ]),
  };
}

function profileAck(user) {
  return {
    packetId: 1037,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList(getEquipItems(user).map((equip) => writeNullableObject(buildEquipProfileInfoData(equip)))),
    ]),
  };
}

function presetListAck(user) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeObjectList(getEquipPresets(user).map((preset) => writeNullableObject(buildEquipPresetData(preset)))),
  ]);
}

function presetAddAck(user, req) {
  const count = addEquipPresets(user, req.addPresetCount);
  return {
    packetId: 1041,
    payload: Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(count), writeObjectList([])]),
  };
}

function presetNameAck(user, req) {
  setEquipPresetName(user, req.presetIndex, req.newPresetName);
  return {
    packetId: 1043,
    payload: Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(Number(req.presetIndex || 0) || 0), writeString(req.newPresetName || "")]),
  };
}

function presetRegisterAllAck(user, req) {
  const preset = registerEquipPresetFromUnit(user, req.unitUid, req.presetIndex);
  return {
    packetId: 1045,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildEquipPresetData(preset))]),
  };
}

function presetRegisterAck(user, req) {
  const preset = registerEquipPreset(user, req.presetIndex, req.equipPosition, req.equipUid);
  return {
    packetId: 1047,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildEquipPresetData(preset))]),
  };
}

function presetApplyAck(user, req) {
  const update = applyEquipPreset(user, req.presetIndex, req.applyUnitUid);
  return {
    packetId: 1049,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarInt(Number(req.presetIndex || 0) || 0),
      writeObjectList([writeNullableObject(Buffer.concat([writeSignedVarLong(toBigInt(update.unitUid || 0)), writeLongArray(update.equipUids || [])]))]),
    ]),
  };
}

function tuningCancelAck(user) {
  const candidate = cancelEquipTuning(user);
  return {
    packetId: 1053,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildEquipTuningCandidateData(candidate))]),
  };
}

function imprintAck(user, req) {
  const equip = imprintEquip(user, req.equipUid, req.unitId);
  return {
    packetId: 1056,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObjectOrNull(equip ? buildEquipItemData(equip) : null)]),
  };
}

function upgradeAck(user, req) {
  const result = enchantEquipItem(user, req.equipUid, req.consumeEquipItemUidList || [], { levels: 1 });
  return {
    packetId: 1058,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeLongArray(result ? result.consumed : []),
      writeObjectList([]),
    ]),
  };
}

function openSocketAck(user, req) {
  const equip = openPotentialSocket(user, req.equipUid, req.socketIndex);
  return {
    packetId: 1060,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(equip ? buildEquipItemData(equip) : null),
      writeObjectList([]),
    ]),
  };
}

function presetChangeIndexAck(user, req) {
  const presets = changeEquipPresetIndices(user, req.changeIndices || []);
  return {
    packetId: 1062,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList(presets.map((preset) => writeNullableObject(buildEquipPresetData(preset)))),
    ]),
  };
}

function craftInstantAck(user, req) {
  const reward = createEmptyReward();
  for (let index = 0; index < Math.max(1, Number(req.moldCount || 1)); index += 1) {
    const equip = grantEquipItem(user, 0, { cursor: index });
    if (equip) reward.equips.push(equip);
  }
  return {
    packetId: 1067,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarInt(Number(req.moldId || 0) || 0),
      writeSignedVarInt(Number(req.moldCount || 1) || 1),
      writeObjectList([]),
      writeNullObject(),
      writeNullableObject(buildRewardData(reward)),
    ]),
  };
}

function potentialRollAck(user, req) {
  const result = rollPotentialOption(user, req.equipUid, req.socketIndex);
  return {
    packetId: 1069,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList([]),
      writeNullableObject(buildPotentialOptionCandidateData((result && result.candidate) || {})),
    ]),
  };
}

function potentialConfirmAck(user, req) {
  const equip = confirmPotentialOption(user, req.equipUid, req.socketIndex);
  return {
    packetId: 1071,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObjectOrNull(equip ? buildEquipItemData(equip) : null)]),
  };
}

function potentialCancelAck(user) {
  const equip = getEquipItems(user).find((item) => item.potentialCandidate) || null;
  if (equip) equip.potentialCandidate = null;
  return {
    packetId: 1073,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObjectOrNull(equip ? buildEquipItemData(equip) : null)]),
  };
}

function presetClearAck(user, req) {
  const presets = clearEquipPresets(user, req.presetIndices || []);
  return {
    packetId: 1075,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList(presets.map((preset) => writeNullableObject(buildEquipPresetData(preset)))),
    ]),
  };
}

function multipleEnchantAck(user, req) {
  const updated = [];
  const opened = [];
  for (const equipUid of req.equipItemUIDList || []) {
    const result = enchantEquipItem(user, equipUid, [], { levels: Math.max(1, Number(req.enchantLevel || 1)) });
    if (result && result.equip) {
      updated.push(result.equip);
      if (req.openEquipSocket) {
        openPotentialSocket(user, result.equip.equipUid, 0);
        opened.push(result.equip.equipUid);
      }
    }
  }
  return {
    packetId: 1077,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList(updated.map((equip) => writeNullableObject(buildEquipItemData(equip)))),
      writeObjectList([]),
      writeLongArray(opened),
    ]),
  };
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  let payload = Buffer.alloc(0);
  try {
    payload = ctx.decryptCopy(encryptedPayload);
  } catch (_) {
    payload = Buffer.alloc(0);
  }
  const reader = createReader(payload);
  try {
    switch (packetId) {
      case 1000:
        return { isEquip: reader.bool(), unitUID: reader.long(), equipItemUID: reader.long(), equipPosition: reader.int() };
      case 1002:
        return { equipItemUID: reader.long(), consumeEquipItemUIDList: reader.longList() };
      case 1004:
        return { equipItemUID: reader.long(), isLock: reader.bool() };
      case 1006:
        return { removeEquipItemUIDList: reader.longList() };
      case 1008:
        return { itemID: reader.int(), count: reader.int() };
      case 1012:
        return { index: reader.byte(), moldID: reader.int(), count: reader.int() };
      case 1014:
      case 1016:
        return { index: reader.byte() };
      case 1018:
      case 1020:
      case 1022:
        return { equipUID: reader.long(), equipOptionID: reader.int() };
      case 1024:
        return { equipUid: reader.long(), equipOptionId: reader.int(), statType: reader.int() };
      case 1026:
        return { itemId: reader.int(), rewardId: reader.int(), count: reader.int(), setOptionId: reader.int(), subSkillId: reader.int() };
      case 1028:
      case 1030:
      case 1034:
      case 1036:
        return { equipUID: reader.long(), unitUid: toBigInt(payload.length ? 0 : 0) };
      case 1032:
        return { equipUid: reader.long(), setOptionId: reader.int() };
      case 1040:
        return { addPresetCount: reader.int() };
      case 1042:
        return { presetIndex: reader.int(), newPresetName: reader.string() };
      case 1044:
        return { unitUid: reader.long(), presetIndex: reader.int() };
      case 1046:
        return { presetIndex: reader.int(), equipPosition: reader.int(), equipUid: reader.long() };
      case 1048:
        return { presetIndex: reader.int(), applyUnitUid: reader.long() };
      case 1055:
        return { equipUid: reader.long(), unitId: reader.int() };
      case 1057:
        return { equipUid: reader.long(), consumeEquipItemUidList: reader.longList() };
      case 1059:
        return { equipUid: reader.long(), socketIndex: reader.int() };
      case 1061:
        return { changeIndices: reader.presetIndexChanges() };
      case 1063:
        return { equipItemUID: reader.long(), miscItemList: [] };
      case 1066:
        return { moldId: reader.int(), moldCount: reader.int() };
      case 1068:
      case 1070:
        return { equipUid: reader.long(), socketIndex: reader.int() };
      case 1074:
        return { presetIndices: reader.intList() };
      case 1076:
        return { equipItemUIDList: reader.longList(), enchantLevel: 1, openEquipSocket: false };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[equipment:${packetId}] request decode failed: ${err.message}`);
    return {};
  }
}

function createReader(payload) {
  let offset = 0;
  return {
    bool() {
      const read = readBool(payload, offset);
      offset = read.offset;
      return read.value;
    },
    byte() {
      const read = readByte(payload, offset);
      offset = read.offset;
      return read.value;
    },
    int() {
      const read = readSignedVarInt(payload, offset);
      offset = read.offset;
      return read.value;
    },
    long() {
      const read = readSignedVarLong(payload, offset);
      offset = read.offset;
      return read.value;
    },
    string() {
      const read = readString(payload, offset);
      offset = read.offset;
      return read.value;
    },
    intList() {
      const read = readSignedVarIntList(payload, offset);
      offset = read.offset;
      return read.value;
    },
    longList() {
      const read = readSignedVarLongList(payload, offset);
      offset = read.offset;
      return read.value;
    },
    presetIndexChanges() {
      const count = this.int();
      const changes = [];
      for (let index = 0; index < count; index += 1) {
        this.bool(); // nullable object marker
        changes.push({ from: this.int(), to: this.int() });
      }
      return changes;
    },
  };
}

function now(ctx) {
  return ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
}

module.exports = {
  createEquipmentPipelineHandlers,
  presetListAck,
};
