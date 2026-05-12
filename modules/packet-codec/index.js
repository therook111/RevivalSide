const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;

function writeString(value) {
  if (value == null) return writeSignedVarInt(-1);
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.concat([writeSignedVarInt(bytes.length), bytes]);
}

function writeBool(value) {
  return Buffer.from([value ? 1 : 0]);
}

function writeByte(value) {
  return Buffer.from([Number(value) & 0xff]);
}

function writeSByte(value) {
  return Buffer.from([Number(value) & 0xff]);
}

function writeInt64LE(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(BigInt(value || 0), 0);
  return buffer;
}

function writeDoubleLE(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(Number(value || 0), 0);
  return buffer;
}

function writeFloatLE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(Number(value || 0), 0);
  return buffer;
}

function writeVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function writeSignedVarInt(value) {
  const v = Number(value) | 0;
  return writeVarInt(((v << 1) ^ (v >> 31)) >>> 0);
}

function writeVarLong(value) {
  let current = zigZagEncode64(BigInt(value || 0));
  const bytes = [];
  while (current > 0x7fn) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  bytes.push(Number(current));
  return Buffer.from(bytes);
}

function writeSignedVarLong(value) {
  return writeVarLong(value);
}

function zigZagEncode64(value) {
  return (value << 1n) ^ (value >> 63n);
}

function writeNullableObject(payload) {
  return Buffer.concat([writeBool(true), payload || Buffer.alloc(0)]);
}

function writeNullObject() {
  return writeBool(false);
}

function writeNullableObjectOrNull(payload) {
  return payload ? writeNullableObject(payload) : writeNullObject();
}

function writeObjectList(values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeVarInt(list.length), ...list]);
}

function writeNullableObjectList(values) {
  const list = Array.isArray(values) ? values : [];
  return writeObjectList(list.map((payload) => writeNullableObject(payload)));
}

function writeObjectMapLong(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return Buffer.concat([
    writeVarInt(list.length),
    ...list.flatMap(([key, payload]) => [writeSignedVarLong(BigInt(key || 0)), writeNullableObject(payload)]),
  ]);
}

function writeObjectMapInt(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return Buffer.concat([
    writeVarInt(list.length),
    ...list.flatMap(([key, payload]) => [writeSignedVarInt(Number(key) || 0), writeNullableObject(payload)]),
  ]);
}

function writeIntList(values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeVarInt(list.length), ...list.map((value) => writeSignedVarInt(Number(value) || 0))]);
}

function writeShortList(values) {
  return writeIntList(values);
}

function writeFloatList(values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeVarInt(list.length), ...list.map((value) => writeFloatLE(value))]);
}

function writeLongArray(values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeVarInt(list.length), ...list.map((value) => writeSignedVarLong(BigInt(value || 0)))]);
}

function buildEquipItemStatData(stat) {
  const data = stat || {};
  return Buffer.concat([
    writeSignedVarInt(statTypeValue(data.type != null ? data.type : data.statType)),
    writeFloatLE(data.value != null ? data.value : data.stat_value || 0),
    writeFloatLE(data.levelValue != null ? data.levelValue : data.stat_level_value || 0),
  ]);
}

function buildPotentialSocketData(socket) {
  const data = socket || {};
  return Buffer.concat([
    writeFloatLE(data.statValue != null ? data.statValue : data.value || 0),
    writeSignedVarInt(Number(data.precision || 0) || 0),
  ]);
}

function buildPotentialOptionData(option) {
  const data = option || {};
  const sockets = normalizeFixedArray(data.sockets || data.socketData, 3, null);
  return Buffer.concat([
    writeSignedVarInt(Number(data.optionKey || data.optionId || 0) || 0),
    writeSignedVarInt(statTypeValue(data.statType || data.type)),
    writeObjectList(sockets.map((socket) => (socket ? writeNullableObject(buildPotentialSocketData(socket)) : writeNullObject()))),
    writeSignedVarInt(Number(data.precisionChangeCount || data.changeCount || 0) || 0),
  ]);
}

function buildEquipItemData(equip) {
  const data = equip || {};
  const stats = Array.isArray(data.stats)
    ? data.stats
    : Array.isArray(data.m_Stat)
      ? data.m_Stat
      : [{ type: data.statType || "NST_HP", value: data.statValue || 0, levelValue: data.statLevelValue || 0 }];
  const potentials = Array.isArray(data.potentialOptions) ? data.potentialOptions : [];
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.equipUid != null ? data.equipUid : data.m_ItemUid || 0)),
    writeSignedVarInt(Number(data.itemEquipId != null ? data.itemEquipId : data.m_ItemEquipID || 0) || 0),
    writeSignedVarInt(Number(data.enchantLevel != null ? data.enchantLevel : data.m_EnchantLevel || 0) || 0),
    writeSignedVarInt(Number(data.enchantExp != null ? data.enchantExp : data.m_EnchantExp || 0) || 0),
    writeNullableObjectList(stats.map(buildEquipItemStatData)),
    writeSignedVarLong(toBigInt(data.ownerUnitUid != null ? data.ownerUnitUid : data.m_OwnerUnitUID != null ? data.m_OwnerUnitUID : -1)),
    writeBool(Boolean(data.locked || data.m_bLock)),
    writeSignedVarInt(Number(data.precision != null ? data.precision : data.m_Precision || 0) || 0),
    writeSignedVarInt(Number(data.precision2 != null ? data.precision2 : data.m_Precision2 || 0) || 0),
    writeSignedVarInt(Number(data.setOptionId != null ? data.setOptionId : data.m_SetOptionId || 0) || 0),
    writeSignedVarInt(Number(data.imprintUnitId != null ? data.imprintUnitId : data.m_ImprintUnitId || 0) || 0),
    writeNullableObjectList(potentials.map(buildPotentialOptionData)),
  ]);
}

function buildEquipTuningCandidateData(candidate) {
  const data = candidate || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.equipUid || 0)),
    writeSignedVarInt(statTypeValue(data.option1 || data.statType1)),
    writeSignedVarInt(statTypeValue(data.option2 || data.statType2)),
    writeSignedVarInt(Number(data.setOptionId || 0) || 0),
  ]);
}

function buildPotentialOptionCandidateData(candidate) {
  const data = candidate || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.equipUid || 0)),
    writeSignedVarInt(Number(data.precision || 0) || 0),
    writeSignedVarInt(Number(data.socketIndex || 0) || 0),
    writeSignedVarInt(Number(data.accumulateCount || 0) || 0),
  ]);
}

function buildEquipPresetData(preset) {
  const data = preset || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.presetIndex || data.index || 0) || 0),
    writeSignedVarInt(Number(data.presetType || 0) || 0),
    writeString(data.presetName || data.name || ""),
    writeLongArray(normalizeFixedArray(data.equipUids || [], 4, 0)),
  ]);
}

function buildDeckIndexData(deckIndex) {
  const data = deckIndex || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.deckType != null ? data.deckType : data.m_eDeckType || 0) || 0),
    writeByte(Number(data.index != null ? data.index : data.m_iIndex || 0) || 0),
  ]);
}

function buildDeckData(deck) {
  const data = deck || {};
  const slotCount = Number(data.deckType || 0) === 4 ? 16 : 8;
  return Buffer.concat([
    writeString(data.name != null ? data.name : data.deckName || ""),
    writeSignedVarLong(toBigInt(data.shipUid != null ? data.shipUid : data.m_ShipUID || 0)),
    writeSignedVarLong(toBigInt(data.operatorUid != null ? data.operatorUid : data.m_OperatorUID || 0)),
    writeLongArray(normalizeFixedArray(data.unitUids || data.m_listDeckUnitUID || [], slotCount, 0)),
    writeSByte(Number(data.leaderIndex != null ? data.leaderIndex : data.m_LeaderIndex != null ? data.m_LeaderIndex : -1)),
    writeSignedVarInt(Number(data.state != null ? data.state : data.m_DeckState || 0) || 0),
  ]);
}

function buildEquipProfileInfoData(equip) {
  const data = equip || {};
  const stats = Array.isArray(data.stats) ? data.stats : [];
  const stat1 = stats[1] || {};
  const stat2 = stats[2] || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.equipUid || 0)),
    writeSignedVarInt(Number(data.itemEquipId || 0) || 0),
    writeSignedVarInt(Number(data.enchantLevel || 0) || 0),
    writeSignedVarInt(statTypeValue(stat1.type || stat1.statType)),
    writeFloatLE(stat1.value || 0),
    writeSignedVarInt(statTypeValue(stat2.type || stat2.statType)),
    writeFloatLE(stat2.value || 0),
    writeSignedVarInt(Number(data.setOptionId || 0) || 0),
  ]);
}

function buildItemMiscData(item) {
  const data = item || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.itemId || data.m_ItemMiscID || data.ItemID) || 0),
    writeSignedVarLong(toBigInt(data.countFree != null ? data.countFree : data.m_CountFree || data.CountFree || 0)),
    writeSignedVarLong(toBigInt(data.countPaid != null ? data.countPaid : data.m_CountPaid || data.CountPaid || 0)),
    writeSignedVarInt(Number(data.bonusRatio != null ? data.bonusRatio : data.BonusRatio || 0) || 0),
    writeInt64LE(toBigInt(data.regDate != null ? data.regDate : data.m_RegDate || 0)),
  ]);
}

function buildRewardUnitExpData(unitExp) {
  const data = unitExp || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.unitUid != null ? data.unitUid : data.m_UnitUid || 0)),
    writeSignedVarInt(Number(data.exp != null ? data.exp : data.m_Exp || 0) || 0),
    writeSignedVarInt(Number(data.bonusExp != null ? data.bonusExp : data.m_BonusExp || 0) || 0),
    writeSignedVarInt(Number(data.bonusRatio != null ? data.bonusRatio : data.m_BonusRatio || 0) || 0),
  ]);
}

function buildMoldItemData(mold) {
  const data = mold || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.moldId != null ? data.moldId : data.m_MoldID || 0) || 0),
    writeSignedVarLong(toBigInt(data.count != null ? data.count : data.m_Count || 0)),
  ]);
}

function buildBingoTileData(tile) {
  const data = tile || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.eventId != null ? data.eventId : data.m_EventID || 0) || 0),
    writeSignedVarInt(Number(data.tileIndex != null ? data.tileIndex : data.m_TileIndex || 0) || 0),
  ]);
}

function buildShipCmdSlotData(slot) {
  const data = slot || {};
  return Buffer.concat([
    writeIntList(data.targetStyleType || data.styleTypes || []),
    writeIntList(data.targetRoleType || data.roleTypes || []),
    writeSignedVarInt(statTypeValue(data.statType != null ? data.statType : data.type != null ? data.type : "NST_RANDOM")),
    writeFloatLE(data.statValue != null ? data.statValue : data.value || 0),
    writeBool(Boolean(data.isLock || data.locked)),
  ]);
}

function buildShipCmdModuleData(module) {
  const data = module || {};
  const slots = normalizeFixedArray(data.slots || data.slotData || [], 2, null).map((slot) =>
    slot ? writeNullableObject(buildShipCmdSlotData(slot)) : writeNullObject()
  );
  return writeObjectList(slots);
}

function buildShipModuleCandidateData(candidate) {
  const data = candidate || {};
  const slotCandidate = data.slotCandidate || data.module || null;
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.shipUid || data.shipUID || 0)),
    writeSignedVarInt(Number(data.moduleId || 0) || 0),
    slotCandidate ? writeNullableObject(buildShipCmdModuleData(slotCandidate)) : writeNullObject(),
  ]);
}

function buildUnitData(unit) {
  const data = unit || {};
  const shipCommandModules = data.shipCommandModules || data.ShipCommandModule || data.shipModules || [];
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.unitUid || data.m_UnitUID || 0)),
    writeSignedVarLong(toBigInt(data.userUid || data.m_UserUID || 0)),
    writeSignedVarInt(Number(data.unitId || data.m_UnitID || 0) || 0),
    writeSignedVarInt(Number(data.level || data.m_UnitLevel || 1) || 1),
    writeSignedVarInt(Number(data.exp || data.m_iUnitLevelEXP || 0) || 0),
    writeSignedVarInt(Number(data.skinId || data.m_SkinID || 0) || 0),
    writeFloatLE(Number(data.injury || data.m_fInjury || 0)),
    writeSignedVarInt(Number(data.limitBreakLevel || data.m_LimitBreakLevel || 0) || 0),
    writeBool(Boolean(data.locked || data.m_bLock)),
    writeBool(Boolean(data.summonUnit || data.m_bSummonUnit)),
    writeIntList(normalizeFixedArray(data.statExp || data.m_listStatEXP, 6, 0)),
    writeShortList(data.gameUnitUids || data.m_listGameUnitUID || []),
    writeShortList(data.gameUnitUidChanges || data.m_listGameUnitUIDChange || []),
    writeFloatList(data.nearTargetRange || data.m_listNearTargetRange || []),
    writeIntList(normalizeFixedArray(data.skillLevels || data.m_aUnitSkillLevel, 5, 1)),
    writeLongArray(normalizeFixedArray(data.equipItemUids || data.m_EquipItemList, 4, 0)),
    writeSignedVarInt(Number(data.loyalty || 0) || 0),
    writeBool(Boolean(data.isPermanentContract)),
    writeBool(Boolean(data.isSeized)),
    writeBool(data.fromContract !== false),
    writeSignedVarInt(Number(data.officeRoomId || 0) || 0),
    writeInt64LE(toBigInt(data.regDate || data.m_regDate || dateTimeBinaryNow())),
    writeSignedVarInt(Number(data.officeGrade || 0) || 0),
    writeInt64LE(toBigInt(data.officeGaugeStartTime || 0)),
    writeSignedVarLong(toBigInt(data.dungeonRespawnUnitTempletUid || data.m_DungeonRespawnUnitTempletUID || 0)),
    writeBool(Boolean(data.isFavorite)),
    writeNullableObjectList(shipCommandModules.map(buildShipCmdModuleData)),
    writeSignedVarInt(Number(data.tacticLevel || 0) || 0),
    writeSignedVarInt(Number(data.reactorLevel || 0) || 0),
  ]);
}

function buildOperatorSkillData(skill) {
  const data = skill || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.id || 0) || 0),
    writeByte(Number(data.level || 1) || 1),
    writeSignedVarInt(Number(data.exp || 0) || 0),
  ]);
}

function buildOperatorData(operator) {
  const data = operator || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.id || data.unitId || 0) || 0),
    writeSignedVarLong(toBigInt(data.uid || data.operatorUid || 0)),
    writeSignedVarInt(Number(data.level || 1) || 1),
    writeSignedVarInt(Number(data.exp || 0) || 0),
    writeBool(Boolean(data.locked || data.bLock)),
    writeNullableObject(buildOperatorSkillData(data.mainSkill || { level: 1 })),
    writeNullableObject(buildOperatorSkillData(data.subSkill || { level: 1 })),
    writeBool(data.fromContract !== false),
  ]);
}

function buildRewardData(reward) {
  const data = reward || {};
  const miscItems = Array.isArray(data.miscItems) ? data.miscItems : [];
  const skinIds = Array.isArray(data.skinIds) ? data.skinIds : [];
  const emoticonIds = Array.isArray(data.emoticonIds) ? data.emoticonIds : [];
  const units = Array.isArray(data.units) ? data.units : Array.isArray(data.unitDataList) ? data.unitDataList : [];
  const operators = Array.isArray(data.operators) ? data.operators : [];
  const moldItems = Array.isArray(data.moldItems)
    ? data.moldItems
    : Array.isArray(data.moldItemDataList)
      ? data.moldItemDataList
      : [];
  const bingoTiles = Array.isArray(data.bingoTiles)
    ? data.bingoTiles
    : Array.isArray(data.bingoTileList)
      ? data.bingoTileList
      : [];
  const unitExpDataList = Array.isArray(data.unitExpDataList)
    ? data.unitExpDataList
    : Array.isArray(data.unitExpData)
      ? data.unitExpData
      : [];
  const equips = Array.isArray(data.equips)
    ? data.equips
    : Array.isArray(data.equipItems)
      ? data.equipItems
      : Array.isArray(data.equipItemDataList)
        ? data.equipItemDataList
        : [];

  return Buffer.concat([
    writeSignedVarInt(Number(data.userExp || 0) || 0),
    writeSignedVarInt(Number(data.bonusRatioOfUserExp || 0) || 0),
    writeNullableObjectList(units.map(buildUnitData)),
    writeNullableObjectList(miscItems.map(buildItemMiscData)),
    writeNullableObjectList(equips.map(buildEquipItemData)), // equipItemDataList
    writeNullableObjectList(unitExpDataList.map(buildRewardUnitExpData)), // unitExpDataList
    writeIntList(skinIds),
    writeNullableObjectList(moldItems.map(buildMoldItemData)), // moldItemDataList
    writeNullableObjectList([]), // companyBuffDataList
    writeNullableObjectList([]), // companyBuffDataList duplicate
    writeIntList(emoticonIds),
    writeSignedVarInt(Number(data.dailyMissionPoint || 0) || 0),
    writeSignedVarInt(Number(data.weeklyMissionPoint || 0) || 0),
    writeNullableObjectList(bingoTiles.map(buildBingoTileData)), // bingoTileList
    writeSignedVarLong(toBigInt(data.achievePoint || 0)),
    writeNullableObjectList(operators.map(buildOperatorData)),
    writeNullableObjectList(data.contractList || []),
    writeNullableObjectList([]), // interiors
  ]);
}

function buildContractStateData(state) {
  const data = state || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.contractId || 0) || 0),
    writeSignedVarInt(Number(data.remainFreeChance || 0) || 0),
    writeInt64LE(toBigInt(data.nextResetDate || farFutureDateTimeBinary())),
    writeBool(data.isActive !== false),
    writeSignedVarInt(Number(data.totalUseCount || 0) || 0),
    writeSignedVarInt(Number(data.dailyUseCount || 0) || 0),
    writeIntList(data.bonusCandidate || []),
  ]);
}

function buildContractBonusStateData(state) {
  const data = state || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.bonusGroupId || 0) || 0),
    writeSignedVarInt(Number(data.useCount || 0) || 0),
    writeSignedVarInt(Number(data.resetCount || 0) || 0),
  ]);
}

function buildSelectableContractStateData(state) {
  const data = state || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.contractId || 0) || 0),
    writeIntList(data.unitIdList || []),
    writeSignedVarInt(Number(data.unitPoolChangeCount || 0) || 0),
    writeBool(data.isActive !== false),
  ]);
}

function dateTimeBinaryNow() {
  return BigInt(Date.now()) * 10000n + TICKS_AT_UNIX_EPOCH | DATE_TIME_LOCAL_MASK;
}

function farFutureDateTimeBinary() {
  return BigInt(Date.UTC(2099, 11, 31, 23, 59, 59)) * 10000n + TICKS_AT_UNIX_EPOCH | DATE_TIME_LOCAL_MASK;
}

function normalizeFixedArray(values, length, fallback) {
  const array = Array.isArray(values) ? values.slice(0, length) : [];
  while (array.length < length) array.push(fallback);
  return array;
}

function toBigInt(value, fallback = 0n) {
  try {
    if (value == null || value === "") return fallback;
    return BigInt(value);
  } catch (_) {
    return fallback;
  }
}

function readSignedVarInt(buffer, offset = 0) {
  const raw = readVarInt(buffer, offset);
  return { value: (raw.value >>> 1) ^ -(raw.value & 1), offset: raw.offset };
}

function readSignedVarLong(buffer, offset = 0) {
  const raw = readVarLongRaw(buffer, offset);
  const value = (raw.value >> 1n) ^ (-(raw.value & 1n));
  return { value, offset: raw.offset };
}

function readVarLongRaw(buffer, offset = 0) {
  let result = 0n;
  let shift = 0n;
  while (shift < 64n) {
    if (offset >= buffer.length) throw new Error("truncated varlong");
    const byte = BigInt(buffer.readUInt8(offset++));
    result |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { value: result, offset };
    shift += 7n;
  }
  throw new Error("varlong too long");
}

function readBool(buffer, offset = 0) {
  if (offset >= buffer.length) throw new Error("truncated bool");
  return { value: buffer.readUInt8(offset) !== 0, offset: offset + 1 };
}

function readByte(buffer, offset = 0) {
  if (offset >= buffer.length) throw new Error("truncated byte");
  return { value: buffer.readUInt8(offset), offset: offset + 1 };
}

function readSByte(buffer, offset = 0) {
  if (offset >= buffer.length) throw new Error("truncated sbyte");
  return { value: buffer.readInt8(offset), offset: offset + 1 };
}

function readSignedVarIntList(buffer, offset = 0) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const read = readSignedVarInt(buffer, offset);
    offset = read.offset;
    values.push(read.value);
  }
  return { value: values, offset };
}

function readSignedVarLongList(buffer, offset = 0) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const read = readSignedVarLong(buffer, offset);
    offset = read.offset;
    values.push(read.value);
  }
  return { value: values, offset };
}

function readVarInt(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  while (shift < 32) {
    if (offset >= buffer.length) throw new Error("truncated varint");
    const byte = buffer.readUInt8(offset++);
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function readString(buffer, offset = 0) {
  const length = readSignedVarInt(buffer, offset);
  offset = length.offset;
  if (length.value < 0) return { value: "", offset };
  const end = Math.min(buffer.length, offset + length.value);
  return { value: buffer.subarray(offset, end).toString("utf8"), offset: end };
}

function statTypeValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^-?\d+$/.test(text)) return Number(text);
  return NKM_STAT_TYPE[text] != null ? NKM_STAT_TYPE[text] : 0;
}

const NKM_STAT_TYPE = Object.freeze({
  NST_RANDOM: -1,
  NST_HP: 0,
  NST_ATK: 1,
  NST_DEF: 2,
  NST_CRITICAL: 3,
  NST_HIT: 4,
  NST_EVADE: 5,
  NST_HP_REGEN_RATE: 6,
  NST_CRITICAL_DAMAGE_RATE: 7,
  NST_CRITICAL_RESIST: 8,
  NST_CRITICAL_DAMAGE_RESIST_RATE: 9,
  NST_DAMAGE_REDUCE_RATE: 10,
  NST_MOVE_SPEED_RATE: 11,
  NST_ATTACK_SPEED_RATE: 12,
  NST_SKILL_COOL_TIME_REDUCE_RATE: 13,
  NST_CC_RESIST_RATE: 14,
  NST_UNIT_TYPE_COUNTER_DAMAGE_RATE: 15,
  NST_UNIT_TYPE_COUNTER_DAMAGE_REDUCE_RATE: 16,
  NST_UNIT_TYPE_SOLDIER_DAMAGE_RATE: 17,
  NST_UNIT_TYPE_SOLDIER_DAMAGE_REDUCE_RATE: 18,
  NST_UNIT_TYPE_MECHANIC_DAMAGE_RATE: 19,
  NST_UNIT_TYPE_MECHANIC_DAMAGE_REDUCE_RATE: 20,
  NST_ROLE_TYPE_STRIKER_DAMAGE_RATE: 21,
  NST_ROLE_TYPE_STRIKER_DAMAGE_REDUCE_RATE: 22,
  NST_ROLE_TYPE_RANGER_DAMAGE_RATE: 23,
  NST_ROLE_TYPE_RANGER_DAMAGE_REDUCE_RATE: 24,
  NST_ROLE_TYPE_SNIPER_DAMAGE_RATE: 25,
  NST_ROLE_TYPE_SNIPER_DAMAGE_REDUCE_RATE: 26,
  NST_ROLE_TYPE_DEFFENDER_DAMAGE_RATE: 27,
  NST_ROLE_TYPE_DEFFENDER_DAMAGE_REDUCE_RATE: 28,
  NST_ROLE_TYPE_SUPPOERTER_DAMAGE_RATE: 29,
  NST_ROLE_TYPE_SUPPOERTER_DAMAGE_REDUCE_RATE: 30,
  NST_ROLE_TYPE_SIEGE_DAMAGE_RATE: 31,
  NST_ROLE_TYPE_SIEGE_DAMAGE_REDUCE_RATE: 32,
  NST_ROLE_TYPE_TOWER_DAMAGE_RATE: 33,
  NST_ROLE_TYPE_TOWER_DAMAGE_REDUCE_RATE: 34,
  NST_MOVE_TYPE_LAND_DAMAGE_RATE: 35,
  NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE: 36,
  NST_MOVE_TYPE_AIR_DAMAGE_RATE: 37,
  NST_MOVE_TYPE_AIR_DAMAGE_REDUCE_RATE: 38,
  NST_LONG_RANGE_DAMAGE_REDUCE_RATE: 39,
  NST_LONG_RANGE_DAMAGE_RATE: 40,
  NST_SHORT_RANGE_DAMAGE_REDUCE_RATE: 41,
  NST_SHORT_RANGE_DAMAGE_RATE: 42,
  NST_HEAL_REDUCE_RATE: 43,
  NST_DEF_PENETRATE_RATE: 44,
  NST_BARRIER_REINFORCE_RATE: 45,
  NST_SKILL_DAMAGE_RATE: 46,
  NST_SKILL_DAMAGE_REDUCE_RATE: 47,
  NST_HYPER_SKILL_DAMAGE_RATE: 48,
  NST_HYPER_SKILL_DAMAGE_REDUCE_RATE: 49,
  NST_UNIT_TYPE_CORRUPTED_DAMAGE_RATE: 50,
  NST_UNIT_TYPE_CORRUPTED_DAMAGE_REDUCE_RATE: 51,
  NST_UNIT_TYPE_REPLACER_DAMAGE_RATE: 52,
  NST_UNIT_TYPE_REPLACER_DAMAGE_REDUCE_RATE: 53,
  NST_ROLE_TYPE_DAMAGE_RATE: 54,
  NST_ROLE_TYPE_DAMAGE_REDUCE_RATE: 55,
  NST_HP_GROWN_ATK_RATE: 56,
  NST_HP_GROWN_DEF_RATE: 57,
  NST_HP_GROWN_EVADE_RATE: 58,
  NST_SPLASH_DAMAGE_REDUCE_RATE: 59,
  NST_DEFENDER_PROTECT_RATE: 60,
  NST_DAMAGE_INCREASE_DEFENCE: 61,
  NST_DAMAGE_REDUCE_PENETRATE: 62,
  NST_DAMAGE_INCREASE_REDUCE: 63,
  NST_DAMAGE_REDUCE_REDUCE: 64,
  NST_DAMAGE_LIMIT_RATE_BY_HP: 65,
  NST_ATTACK_COUNT_REDUCE: 66,
  NST_DAMAGE_RESIST: 67,
  NST_DAMAGE_REDUCE_RATE_AGAINST_BARRIER: 68,
  NST_NON_CRITICAL_DAMAGE_TAKE_RATE: 69,
  NST_HEAL_RATE: 70,
  NST_DAMAGE_BACK_RESIST: 71,
  NST_MAIN_STAT_RATE: 72,
  NST_EXTRA_ADJUST_DAMAGE_DEALT: 73,
  NST_EXTRA_ADJUST_DAMAGE_RECEIVE: 74,
  NST_ATTACK_DAMAGE_MODIFY_G2: 75,
  NST_COST_RETURN_RATE: 76,
  NST_ATTACK_VS_BOSS_DAMAGE_MODIFY_G1: 1000,
  NST_DEFEND_VS_BOSS_DAMAGE_MODIFY_G1: 1001,
  NST_ATTACK_VS_SUMMON_DAMAGE_MODIFY_G1: 1010,
  NST_DEFEND_VS_SUMMON_DAMAGE_MODIFY_G1: 1011,
  NST_ATTACK_DAMAGE_MODIFY_G1: 1021,
  NST_DEFEND_DAMAGE_MODIFY_G1: 1022,
  NST_ATTACK_ATTACK_DAMAGE_MODIFY_G2: 2000,
  NST_DEFEND_ATTACK_DAMAGE_MODIFY_G2: 2001,
  NST_ATTACK_VS_SOURCE_CONFLICT_G4: 4000,
  NST_DEFEND_VS_SOURCE_CONFLICT_G4: 4001,
  NST_ATTACK_VS_SOURCE_STABLE_G4: 4002,
  NST_DEFEND_VS_SOURCE_STABLE_G4: 4003,
  NST_ATTACK_VS_SOURCE_LIBERAL_G4: 4004,
  NST_DEFEND_VS_SOURCE_LIBERAL_G4: 4005,
  NST_SOURCE_ALL_RATE_G4: 4100,
  NST_BARRIER_GRANT_RATE: 5000,
  NST_HP_FACTOR: 10000,
  NST_ATK_FACTOR: 10001,
  NST_DEF_FACTOR: 10002,
  NST_CRITICAL_FACTOR: 10003,
  NST_HIT_FACTOR: 10004,
  NST_EVADE_FACTOR: 10005,
});

module.exports = {
  writeString,
  writeBool,
  writeByte,
  writeSByte,
  writeInt64LE,
  writeDoubleLE,
  writeFloatLE,
  writeVarInt,
  writeSignedVarInt,
  writeSignedVarLong,
  writeNullableObject,
  writeNullableObjectOrNull,
  writeNullObject,
  writeObjectList,
  writeNullableObjectList,
  writeObjectMapLong,
  writeObjectMapInt,
  writeIntList,
  writeLongArray,
  buildEquipItemStatData,
  buildEquipItemData,
  buildEquipTuningCandidateData,
  buildPotentialOptionCandidateData,
  buildEquipPresetData,
  buildDeckIndexData,
  buildDeckData,
  buildEquipProfileInfoData,
  buildItemMiscData,
  buildRewardUnitExpData,
  buildMoldItemData,
  buildBingoTileData,
  buildShipCmdSlotData,
  buildShipCmdModuleData,
  buildShipModuleCandidateData,
  buildUnitData,
  buildOperatorData,
  buildRewardData,
  buildContractStateData,
  buildContractBonusStateData,
  buildSelectableContractStateData,
  dateTimeBinaryNow,
  farFutureDateTimeBinary,
  readSignedVarInt,
  readSignedVarLong,
  readBool,
  readByte,
  readSByte,
  readSignedVarIntList,
  readSignedVarLongList,
  readString,
  statTypeValue,
  toBigInt,
};
