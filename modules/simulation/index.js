const {
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarLongList,
  toBigInt,
  writeBool,
  writeFloatLE,
  writeInt64LE,
  writeIntList,
  writeNullableObject,
  writeNullObject,
  writeObjectList,
  writeObjectMapInt,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../packet-codec");

const COUNTERCASE_UNLOCK_REQ = 1204;
const COUNTERCASE_UNLOCK_ACK = 1205;
const DUNGEON_SKIP_REQ = 855;
const DUNGEON_SKIP_ACK = 856;
const START_SIMULATED_PVP_TEST_REQ = 2684;
const START_SIMULATED_PVP_TEST_ACK = 2685;
const NGT_PVE_SIMULATED = 27;
const PVP_RESULT_WIN = 0;
const PROTOCOL_VERSION = 960;

function createSimulationHandlers() {
  return [
    {
      packetId: DUNGEON_SKIP_REQ,
      name: "DUNGEON_SKIP_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeDungeonSkipReq(ctx, packet.payload);
        const payload =
          ctx && typeof ctx.buildDungeonSkipAckPayload === "function"
            ? ctx.buildDungeonSkipAckPayload(socket, req)
            : buildDungeonSkipFallbackAckPayload(req);
        console.log(`[simulation:DUNGEON_SKIP_REQ] ACK packetId=${DUNGEON_SKIP_ACK} dungeonID=${req.dungeonId} skip=${req.skip}`);
        send(ctx, socket, packet, DUNGEON_SKIP_ACK, payload, "dungeon-skip");
        if (ctx && typeof ctx.sendStageClearMissionUpdate === "function") {
          ctx.sendStageClearMissionUpdate(socket, user, { label: "simulation-skip-mission-update" });
        }
        return true;
      },
    },
    {
      packetId: COUNTERCASE_UNLOCK_REQ,
      name: "COUNTERCASE_UNLOCK_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeCounterCaseUnlockReq(ctx, packet.payload);
        const state = unlockCounterCase(user, req.dungeonID);
        const payload = buildCounterCaseUnlockAckPayload(user, state.dungeonID);
        console.log(`[simulation:COUNTERCASE_UNLOCK_REQ] ACK packetId=${COUNTERCASE_UNLOCK_ACK} dungeonID=${state.dungeonID}`);
        send(ctx, socket, packet, COUNTERCASE_UNLOCK_ACK, payload, "countercase-unlock");
        track(ctx, user, "COUNTER_CASE_OPEN", 1, { dungeonId: state.dungeonID, value: state.dungeonID });
        track(ctx, user, "COUNTER_CASE_OPENED", 1, { dungeonId: state.dungeonID, value: state.dungeonID });
        persist(ctx);
        return true;
      },
    },
    {
      packetId: START_SIMULATED_PVP_TEST_REQ,
      name: "START_SIMULATED_PVP_TEST_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeStartSimulatedPvpTestReq(ctx, packet.payload);
        const payload = buildStartSimulatedPvpTestAckPayload(ctx, user, req);
        console.log(
          `[simulation:START_SIMULATED_PVP_TEST_REQ] ACK packetId=${START_SIMULATED_PVP_TEST_ACK} a=${String(
            req.playerUserUidA
          )} b=${String(req.playerUserUidB)}`
        );
        send(ctx, socket, packet, START_SIMULATED_PVP_TEST_ACK, payload, "simulated-pvp-test");
        track(ctx, user, "PVP_PLAY_ASYNC", 1, { value: 1 });
        persist(ctx);
        return true;
      },
    },
  ];
}

function ensureSimulationState(user) {
  if (!user || typeof user !== "object") return { counterCases: {}, simulatedPvpHistory: [] };
  user.simulation = user.simulation && typeof user.simulation === "object" ? user.simulation : {};
  user.simulation.counterCases =
    user.simulation.counterCases && typeof user.simulation.counterCases === "object" ? user.simulation.counterCases : {};
  user.simulation.simulatedPvpHistory = Array.isArray(user.simulation.simulatedPvpHistory)
    ? user.simulation.simulatedPvpHistory
    : [];
  return user.simulation;
}

function hasSimulationState(user) {
  if (!user || typeof user !== "object" || !user.simulation) return false;
  const state = ensureSimulationState(user);
  return Object.keys(state.counterCases || {}).length > 0 || state.simulatedPvpHistory.length > 0;
}

function unlockCounterCase(user, dungeonID) {
  const state = ensureSimulationState(user);
  const resolvedDungeonID = Math.max(0, Number(dungeonID || 0) || 0);
  const key = String(resolvedDungeonID);
  const previous = state.counterCases[key] || {};
  state.counterCases[key] = {
    dungeonID: resolvedDungeonID,
    unlocked: true,
    unlockedAt: previous.unlockedAt || new Date().toISOString(),
  };
  return state.counterCases[key];
}

function buildCounterCaseDataEntries(user) {
  const state = ensureSimulationState(user);
  return Object.values(state.counterCases || {})
    .map(normalizeCounterCaseState)
    .filter((entry) => entry.dungeonID > 0 && entry.unlocked)
    .sort((left, right) => left.dungeonID - right.dungeonID)
    .map((entry) => [entry.dungeonID, buildCounterCaseData(entry)]);
}

function normalizeCounterCaseState(entry) {
  return {
    dungeonID: Number((entry && (entry.dungeonID || entry.dungeonId || entry.m_DungeonID)) || 0) || 0,
    unlocked: entry && (entry.unlocked === true || entry.m_Unlocked === true),
  };
}

function buildCounterCaseData(entry) {
  const data = normalizeCounterCaseState(entry);
  return Buffer.concat([writeSignedVarInt(data.dungeonID), writeBool(data.unlocked)]);
}

function buildCounterCaseUnlockAckPayload(user, dungeonID) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number(dungeonID || 0) || 0),
    writeNullObject(), // costItemData; null is accepted by the client inventory updater.
  ]);
}

function buildDungeonSkipFallbackAckPayload(req = {}) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullObject(),
    writeObjectList([]),
    writeObjectList([]),
    writeObjectList([]),
  ]);
}

function buildStartSimulatedPvpTestAckPayload(ctx, user, req = {}) {
  const now = ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNowCompat();
  const gameUid = makeGameUid();
  const history = {
    gameUid,
    myUserLevel: Number((user && user.level) || 1) || 1,
    targetUserLevel: 1,
    targetNickName: "Simulated Opponent",
    targetFriendCode: Number(req.playerUserUidB || 0n) || 0,
    regdateTick: now,
  };

  if (user && typeof user === "object") {
    const state = ensureSimulationState(user);
    state.simulatedPvpHistory.unshift({
      gameUid: String(gameUid),
      targetUserUid: String(req.playerUserUidB || 0n),
      targetNickName: history.targetNickName,
      result: PVP_RESULT_WIN,
      createdAt: new Date().toISOString(),
    });
    state.simulatedPvpHistory = state.simulatedPvpHistory.slice(0, 50);
  }

  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildReplayData({ gameUid, now })),
    writeNullableObject(buildPvpSingleHistory(history)),
  ]);
}

function buildReplayData({ gameUid, now }) {
  return Buffer.concat([
    writeString(""),
    writeString("9.2.c"),
    Buffer.from([0]), // sbyte streamID
    writeSignedVarInt(PROTOCOL_VERSION),
    writeInt64LE(now),
    writeNullObject(), // gameData
    writeNullObject(), // gameRuntimeData
    writeObjectList([]), // syncList
    writeSignedVarInt(PVP_RESULT_WIN),
    writeFloatLE(0),
    writeNullObject(), // gameRecord
    writeObjectList([]), // emoticonList
  ]);
}

function buildPvpSingleHistory(history = {}) {
  return Buffer.concat([
    writeSignedVarLong(history.gameUid || 0n),
    writeSignedVarInt(Number(history.myUserLevel || 1) || 1),
    writeSignedVarInt(Number(history.targetUserLevel || 1) || 1),
    writeString(history.targetNickName || "Simulated Opponent"),
    writeSignedVarInt(PVP_RESULT_WIN),
    writeSignedVarInt(0), // GainScore
    writeSignedVarInt(0), // MyTier
    writeSignedVarInt(0), // MyScore
    writeSignedVarInt(0), // TargetTier
    writeSignedVarInt(0), // TargetScore
    writeSignedVarLong(history.regdateTick || 0n),
    writeNullableObject(buildAsyncDeckData()),
    writeNullableObject(buildAsyncDeckData()),
    writeSignedVarInt(NGT_PVE_SIMULATED),
    writeSignedVarLong(toBigInt(history.targetFriendCode || 0)),
    writeSignedVarLong(0n),
    writeString(""),
    writeSignedVarLong(0n),
    writeSignedVarLong(0n),
    writeString(""),
    writeSignedVarLong(0n),
    writeIntList([]),
    writeIntList([]),
    writeBool(false),
    writeSignedVarInt(0),
    writeIntList([]),
    writeIntList([]),
  ]);
}

function buildAsyncDeckData() {
  return Buffer.concat([
    writeSignedVarInt(0), // short leaderIndex
    writeNullableObject(buildAsyncUnitData()),
    writeObjectList([]),
    writeObjectList([]),
    writeSignedVarInt(0),
    writeNullObject(),
    writeNullableObject(buildAsyncUnitData()),
    writeObjectMapInt([]),
    writeObjectMapInt([]),
  ]);
}

function buildAsyncUnitData() {
  return Buffer.concat([
    writeSignedVarLong(0n),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeIntList([]),
    writeIntList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
  ]);
}

function decodeCounterCaseUnlockReq(ctx, encryptedPayload) {
  const payload = decryptPayload(ctx, encryptedPayload);
  try {
    return { dungeonID: readSignedVarInt(payload, 0).value };
  } catch (err) {
    console.log(`[simulation:COUNTERCASE_UNLOCK_REQ] request decode failed: ${err.message}`);
    return { dungeonID: 0 };
  }
}

function decodeDungeonSkipReq(ctx, encryptedPayload) {
  const payload = decryptPayload(ctx, encryptedPayload);
  let offset = 0;
  try {
    const dungeon = readSignedVarInt(payload, offset);
    offset = dungeon.offset;
    const skip = readSignedVarInt(payload, offset);
    offset = skip.offset;
    const unitUids = readSignedVarLongList(payload, offset).value;
    return {
      dungeonId: Math.max(0, Number(dungeon.value || 0) || 0),
      skip: Math.max(1, Number(skip.value || 1) || 1),
      unitUids: Array.isArray(unitUids) ? unitUids.map((uid) => String(toBigInt(uid || 0))).filter((uid) => toBigInt(uid) > 0n) : [],
    };
  } catch (err) {
    console.log(`[simulation:DUNGEON_SKIP_REQ] request decode failed: ${err.message}`);
    return { dungeonId: 0, skip: 1, unitUids: [] };
  }
}

function decodeStartSimulatedPvpTestReq(ctx, encryptedPayload) {
  const payload = decryptPayload(ctx, encryptedPayload);
  let offset = 0;
  try {
    const playerA = readSignedVarLong(payload, offset);
    offset = playerA.offset;
    const playerB = readSignedVarLong(payload, offset);
    return {
      playerUserUidA: toBigInt(playerA.value || 0),
      playerUserUidB: toBigInt(playerB.value || 0),
    };
  } catch (err) {
    console.log(`[simulation:START_SIMULATED_PVP_TEST_REQ] request decode failed: ${err.message}`);
    return { playerUserUidA: 0n, playerUserUidB: 0n };
  }
}

function decryptPayload(ctx, encryptedPayload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, packetId, payload, label);
  }
}

function persist(ctx) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function track(ctx, user, condition, amount, details = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const now = ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined;
  ctx.trackMissionEvent(user, condition, amount, { now, ...details });
  if (typeof ctx.refreshMissionProgress === "function") ctx.refreshMissionProgress(user, { now, conditions: [condition] });
}

function makeGameUid() {
  return BigInt(Date.now()) * 10000n + BigInt(process.pid % 10000);
}

function dateTimeBinaryNowCompat() {
  const ticksAtUnixEpoch = 621355968000000000n;
  const localMask = 0x4000000000000000n;
  return ticksAtUnixEpoch + BigInt(Date.now()) * 10000n | localMask;
}

module.exports = {
  createSimulationHandlers,
  ensureSimulationState,
  hasSimulationState,
  unlockCounterCase,
  buildCounterCaseData,
  buildCounterCaseDataEntries,
};
