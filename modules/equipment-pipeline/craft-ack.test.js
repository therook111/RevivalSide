const test = require("node:test");
const assert = require("node:assert/strict");

const { createEquipmentPipelineHandlers } = require("./index");
const { getEquipItems, getCraftSlots } = require("../equipment");
const { setMiscItemBalance, getMiscItem } = require("../inventory");
const {
  writeByte,
  writeSignedVarInt,
  readBool,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
} = require("../packet-codec");

// A craftable, permanent mold whose only material cost is credits (item 1) and
// whose reward group resolves to an RT_EQUIP item. Picked from live game data so
// the test exercises the real startCraft/instantCraft mutation paths.
const CREDIT_ITEM_ID = 1;
const MOLD_ID = 1031;
const MOLD_CREDIT_COST = 5000;
const INSTANT_COMPLETE_ITEM_ID = 1012;
const SEED_CREDITS = 1000000n;

const HANDLERS = createEquipmentPipelineHandlers();

function handlerFor(packetId) {
  const handler = HANDLERS.find((entry) => entry.packetId === packetId);
  assert.ok(handler, `no handler registered for packetId ${packetId}`);
  return handler;
}

function makeHarness(nowTicks = 1000n) {
  const responses = [];
  const ctx = {
    config: { USE_LOCAL_USER_DB: false },
    nowTicks,
    createEphemeralUser: () => ({}),
    decryptCopy: (buf) => Buffer.from(buf),
    dateTimeBinaryNow() {
      return this.nowTicks;
    },
    buildEncryptedPacket: (sequence, packetId, payload) => ({ sequence, packetId, payload }),
    sendResponse(socket, sequence, packetId, builder) {
      responses.push(builder());
    },
    saveUserDb() {},
  };
  const user = {};
  const socket = { session: { user } };
  return { ctx, socket, user, responses };
}

function send(harness, packetId, payload) {
  const { ctx, socket, responses } = harness;
  const before = responses.length;
  handlerFor(packetId).handle(ctx, socket, { sequence: 1, payload });
  const sent = responses.slice(before);
  assert.equal(sent.length, 1, `expected exactly one ACK for packet ${packetId}`);
  return sent[0];
}

function totalMisc(user, itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt((item && item.countFree) || 0) + BigInt((item && item.countPaid) || 0);
}

// --- focused ACK reader (matches packet-schema.json wire shapes) ---

function reader(payload) {
  let offset = 0;
  const api = {
    get offset() {
      return offset;
    },
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
    unsignedCount() {
      let result = 0;
      let shift = 0;
      while (shift < 32) {
        const b = payload.readUInt8(offset++);
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return result >>> 0;
        shift += 7;
      }
      throw new Error("varint too long");
    },
    skip(count) {
      offset += count;
    },
  };
  return api;
}

// NKMCraftSlotData = byte(index) int(moldId) int(count) long(completeDate)
function skipCraftSlotData(r) {
  r.byte();
  r.int();
  r.int();
  r.long();
}

// NKMItemMiscData = int(itemId) long(countFree) long(countPaid) int(bonusRatio) int64LE(regDate)
function skipItemMiscData(r) {
  r.int();
  r.long();
  r.long();
  r.int();
  r.skip(8);
}

function readNullableObjectMarker(r) {
  return r.bool();
}

// Reads materialItemDataList (List<NKMItemMiscData>) and returns the element count.
function readMaterialItemDataList(r) {
  const count = r.unsignedCount();
  for (let index = 0; index < count; index += 1) {
    if (readNullableObjectMarker(r)) skipItemMiscData(r);
  }
  return count;
}

function decodeCraftStartAck(payload) {
  const r = reader(payload);
  const errorCode = r.int();
  const hasSlot = readNullableObjectMarker(r);
  if (hasSlot) skipCraftSlotData(r);
  const materialCount = readMaterialItemDataList(r);
  const resetCountPresent = readNullableObjectMarker(r);
  const resetCount = resetCountPresent ? { groupId: r.int(), count: r.int() } : null;
  return { errorCode, hasSlot, materialCount, resetCountPresent, resetCount };
}

function decodeCraftInstantAck(payload) {
  const r = reader(payload);
  const errorCode = r.int();
  const moldId = r.int();
  const moldCount = r.int();
  const materialCount = readMaterialItemDataList(r);
  const resetCountPresent = readNullableObjectMarker(r);
  const resetCount = resetCountPresent ? { groupId: r.int(), count: r.int() } : null;
  const rewardPresent = readNullableObjectMarker(r);
  return { errorCode, moldId, moldCount, materialCount, resetCountPresent, resetCount, rewardPresent };
}

function decodeCraftCompleteAck(payload) {
  const r = reader(payload);
  const errorCode = r.int();
  const hasSlot = readNullableObjectMarker(r);
  if (hasSlot) skipCraftSlotData(r);
  const rewardPresent = readNullableObjectMarker(r);
  return { errorCode, hasSlot, rewardPresent };
}

function decodeCraftInstantCompleteAck(payload) {
  const r = reader(payload);
  const errorCode = r.int();
  const hasSlot = readNullableObjectMarker(r);
  if (hasSlot) skipCraftSlotData(r);
  const extraCostPresent = readNullableObjectMarker(r);
  if (extraCostPresent) skipItemMiscData(r);
  const rewardPresent = readNullableObjectMarker(r);
  return { errorCode, hasSlot, extraCostPresent, rewardPresent };
}

test("1012 -> 1013 craft start mutates state and emits a non-null resetCount", () => {
  const harness = makeHarness();
  const { user } = harness;
  setMiscItemBalance(user, CREDIT_ITEM_ID, SEED_CREDITS);
  const creditsBefore = totalMisc(user, CREDIT_ITEM_ID);

  const request = Buffer.concat([writeByte(1), writeSignedVarInt(MOLD_ID), writeSignedVarInt(1)]);
  const ack = send(harness, 1012, request);
  assert.equal(ack.packetId, 1013);

  const decoded = decodeCraftStartAck(ack.payload);
  assert.equal(decoded.errorCode, 0, "craft start should succeed");
  assert.equal(decoded.resetCountPresent, true, "resetCount must be a present (non-null) object");
  assert.deepEqual(decoded.resetCount, { groupId: 0, count: 0 });
  assert.ok(decoded.materialCount >= 1, "material cost list should be present");

  // Server state changed: credits spent and slot now occupied by the mold.
  assert.equal(totalMisc(user, CREDIT_ITEM_ID), creditsBefore - BigInt(MOLD_CREDIT_COST));
  const slot = getCraftSlots(user).find((entry) => entry.index === 1);
  assert.ok(slot, "slot 1 should exist");
  assert.equal(slot.moldId, MOLD_ID, "slot should now hold the started mold");
});

test("1066 -> 1067 instant craft mutates state, grants gear, and emits a non-null resetCount", () => {
  const harness = makeHarness();
  const { user } = harness;
  setMiscItemBalance(user, CREDIT_ITEM_ID, SEED_CREDITS);
  const creditsBefore = totalMisc(user, CREDIT_ITEM_ID);
  const equipsBefore = getEquipItems(user).length;

  const request = Buffer.concat([writeSignedVarInt(MOLD_ID), writeSignedVarInt(1)]);
  const ack = send(harness, 1066, request);
  assert.equal(ack.packetId, 1067);

  const decoded = decodeCraftInstantAck(ack.payload);
  assert.equal(decoded.errorCode, 0, "instant craft should succeed");
  assert.equal(decoded.moldId, MOLD_ID);
  assert.equal(decoded.resetCountPresent, true, "resetCount must be a present (non-null) object");
  assert.deepEqual(decoded.resetCount, { groupId: 0, count: 0 });
  assert.equal(decoded.rewardPresent, true, "created reward payload should be present");

  assert.equal(totalMisc(user, CREDIT_ITEM_ID), creditsBefore - BigInt(MOLD_CREDIT_COST));
  assert.equal(getEquipItems(user).length, equipsBefore + 1, "instant craft should grant one equip");
});

test("1014 -> 1015 complete clears a ready slot and returns the created reward", () => {
  const harness = makeHarness();
  const { user } = harness;
  // Seed a ready slot (completeDate in the past relative to the harness clock).
  user.craft = { molds: {}, slots: { 1: { index: 1, moldId: MOLD_ID, count: 1, completeDate: "1" } }, rewardCursors: {} };
  const equipsBefore = getEquipItems(user).length;

  const ack = send(harness, 1014, writeByte(1));
  assert.equal(ack.packetId, 1015);

  const decoded = decodeCraftCompleteAck(ack.payload);
  assert.equal(decoded.errorCode, 0, "complete should succeed for a ready slot");
  assert.equal(decoded.rewardPresent, true, "reward payload should be present");

  const slot = getCraftSlots(user).find((entry) => entry.index === 1);
  assert.equal(slot.moldId, 0, "slot should clear after completing");
  assert.equal(getEquipItems(user).length, equipsBefore + 1, "completing should grant the crafted equip");
});

test("1016 -> 1017 instant complete clears the slot, charges the rush item, and returns the reward", () => {
  const harness = makeHarness();
  const { user } = harness;
  // Slot still creating (future completeDate); instant complete forces it.
  user.craft = {
    molds: {},
    slots: { 1: { index: 1, moldId: MOLD_ID, count: 1, completeDate: "9999999999999999" } },
    rewardCursors: {},
  };
  setMiscItemBalance(user, INSTANT_COMPLETE_ITEM_ID, 5n);
  const equipsBefore = getEquipItems(user).length;
  const rushItemsBefore = totalMisc(user, INSTANT_COMPLETE_ITEM_ID);

  const ack = send(harness, 1016, writeByte(1));
  assert.equal(ack.packetId, 1017);

  const decoded = decodeCraftInstantCompleteAck(ack.payload);
  assert.equal(decoded.errorCode, 0, "instant complete should succeed");
  assert.equal(decoded.extraCostPresent, true, "rush item cost should be reported");
  assert.equal(decoded.rewardPresent, true, "reward payload should be present");

  const slot = getCraftSlots(user).find((entry) => entry.index === 1);
  assert.equal(slot.moldId, 0, "slot should clear after instant completion");
  assert.equal(getEquipItems(user).length, equipsBefore + 1, "instant completion should grant the crafted equip");
  assert.equal(totalMisc(user, INSTANT_COMPLETE_ITEM_ID), rushItemsBefore - 1n, "rush item should be consumed");
});
