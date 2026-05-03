const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const {
  createCombatHandler,
  buildCapturedRespawnUnitPools: buildCombatCapturedRespawnUnitPools,
} = require("./combat-handler");

const PORT = Number(process.env.CS_PORT || 22000);
const HTTP_MIRROR_PORT = Number(process.env.CS_HTTP_MIRROR_PORT || 8088);
const DEBUG_HEX = process.env.CS_DEBUG_HEX === "1";
const VERBOSE_CAPTURE_LOGS = process.env.CS_VERBOSE_CAPTURE === "1" || DEBUG_HEX;
const LOG_CONFIG_EACH_CONNECTION = process.env.CS_LOG_CONFIG_EACH_CONNECTION === "1";

const HEAD_FENCE = 0xaabbccdd;
const TAIL_FENCE = 0x11223344;

const LOGIN_ACK = 203;
const JOIN_LOBBY_REQ = 204;
const JOIN_LOBBY_ACK = 205;
const RECONNECT_REQ = 213;
const RECONNECT_ACK = 214;
const CONTENTS_VERSION_REQ = 216;
const CONTENTS_VERSION_ACK = 217;
const STEAM_LOGIN_REQ = 231;
const HEART_BIT_REQ = 600;
const HEART_BIT_ACK = 601;
const CONNECT_CHECK_REQ = 602;
const CONNECT_CHECK_ACK = 603;
const SERVER_TIME_REQ = 604;
const SERVER_TIME_ACK = 605;
const GAME_LOAD_ACK = 804;
const GAME_END_NOT = 811;
const GAME_PAUSE_ACK = 813;
const GAME_RESPAWN_ACK = 817;
const CUTSCENE_DUNGEON_START_REQ = 1200;
const CUTSCENE_DUNGEON_START_ACK = 1201;
const CUTSCENE_DUNGEON_CLEAR_REQ = 1202;
const CUTSCENE_DUNGEON_CLEAR_ACK = 1203;
const FRIEND_LIST_ACK = 401;
const GREETING_MESSAGE_ACK = 454;
const EQUIP_PRESET_LIST_ACK = 1039;
const FAVORITES_STAGE_ACK = 1244;
const POST_LIST_ACK = 1615;
const DEFENCE_INFO_ACK = 3905;
const NPT_GAME_SYNC_DATA_PACK_NOT = 822;

const CAPTURED_FLOW_DIR =
  process.env.CS_CAPTURED_FLOW_DIR || path.join(__dirname, "server-data", "captured-flows");
const CAPTURED_TCP_DIR =
  process.env.CS_CAPTURED_TCP_DIR || path.join(__dirname, "server-data", "captured-tcp");
const CAPTURED_GAME_FLOW_DIR =
  process.env.CS_CAPTURED_GAME_FLOW_DIR || path.join(__dirname, "server-data", "captured-game-flow");
const PACKET_HANDLER_DIR = process.env.CS_PACKET_HANDLER_DIR || path.join(__dirname, "packet-handlers");
const UNIT_TABLE_PATH = process.env.CS_UNIT_TABLE_PATH || path.join(__dirname, "server-data", "units.json");
const USE_LOCAL_USER_DB = process.env.CS_USE_LOCAL_USER_DB !== "0";
const REPLAY_CAPTURED_CONTENTS_VERSION = process.env.CS_REPLAY_CAPTURED_CONTENTS_VERSION !== "0";
const REPLAY_CAPTURED_LOGIN_ACK = process.env.CS_REPLAY_CAPTURED_LOGIN_ACK !== "0";
const REPLAY_CAPTURED_GAME_FLOW = process.env.CS_REPLAY_CAPTURED_GAME_FLOW !== "0";
const REPLAY_CAPTURED_GAME_AUTO_ADVANCE = process.env.CS_REPLAY_CAPTURED_GAME_AUTO_ADVANCE === "1";
const REPLAY_CAPTURED_GAME_AUTO_ADVANCE_MS = Number(process.env.CS_REPLAY_CAPTURED_GAME_AUTO_ADVANCE_MS || 9000);
const SYNTHETIC_SYNC_INTERVAL_MS = Number(process.env.CS_SYNTHETIC_SYNC_INTERVAL_MS || 200);
const BATTLE_SIMULATOR = process.env.CS_BATTLE_SIMULATOR === "1";
const DYNAMIC_BATTLE_MANAGER = process.env.CS_DYNAMIC_BATTLE_MANAGER !== "0";
const DYNAMIC_BATTLE_SYNC_INTERVAL_MS = Number(process.env.CS_DYNAMIC_BATTLE_SYNC_INTERVAL_MS || 33);
const DYNAMIC_BATTLE_GAME_UNIT_GROUPS = parseGameUnitGroups(process.env.CS_DYNAMIC_BATTLE_GAME_UNIT_GROUPS || "5,6;8,9;10,11;12,13");
const CSHARP_COMBAT_HOST = process.env.CS_CSHARP_COMBAT_HOST !== "0";
const CSHARP_COMBAT_HOST_PROJECT = process.env.CS_CSHARP_COMBAT_HOST_PROJECT || path.join(__dirname, "combat-host", "CombatHost.csproj");
const CSHARP_COMBAT_HOST_DLL = process.env.CS_CSHARP_COMBAT_HOST_DLL || "";
const CSHARP_COMBAT_HOST_TIMEOUT_MS = Number(process.env.CS_CSHARP_COMBAT_HOST_TIMEOUT_MS || 5000);
const CSHARP_COMBAT_HOST_DOTNET = process.env.CS_DOTNET_PATH || findDefaultDotnetRuntime();
const COUNTERSIDE_MANAGED_DIR = process.env.CS_COUNTERSIDE_MANAGED_DIR || findDefaultCounterSideManagedDir();
const GAMEPLAY_TABLES_DIR = process.env.CS_GAMEPLAY_TABLES_DIR || findDefaultGameplayTablesDir();
const OFFICIAL_COMBAT_REPLAY = process.env.CS_OFFICIAL_COMBAT_REPLAY === "1";
const OFFICIAL_COMBAT_REPLAY_START_INDEX = Number(process.env.CS_OFFICIAL_COMBAT_REPLAY_START_INDEX || 64);
const OFFICIAL_COMBAT_REPLAY_INTERVAL_MS = Number(process.env.CS_OFFICIAL_COMBAT_REPLAY_INTERVAL_MS || 320);
const TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX = Number(process.env.CS_TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX || 98);
const ALLOW_SYNTHETIC_GAME_SYNC = process.env.CS_ALLOW_SYNTHETIC_GAME_SYNC === "1";
const REFRAME_CAPTURED_GAME_FLOW = process.env.CS_REFRAME_CAPTURED_GAME_FLOW === "1";
const SKIP_TUTORIAL_CUTSCENE = process.env.CS_SKIP_TUTORIAL_CUTSCENE === "1";
const USE_STEAM_TOKEN_AS_ACCESS_TOKEN = process.env.CS_USE_STEAM_TOKEN_AS_ACCESS_TOKEN === "1";
const REWRITE_CAPTURED_SERVER_INFO = process.env.CS_REWRITE_CAPTURED_SERVER_INFO !== "0";
const MIRROR_PUBLIC_HOST = process.env.CS_HTTP_MIRROR_HOST || "127.0.0.1";
const MIRROR_PUBLIC_BASE_URL =
  process.env.CS_HTTP_MIRROR_BASE_URL || `http://${MIRROR_PUBLIC_HOST}:${HTTP_MIRROR_PORT}`;
const USER_DB_PATH = process.env.CS_USER_DB_PATH || path.join(__dirname, "server-data", "users.json");

const COMBAT_STATE_ID = Object.freeze({
  IDLE: 12,
  MOVE: 13,
  ATTACK: 45,
  DEAD: 18,
});
const DEFAULT_COMBAT_STATS = Object.freeze({
  damage: Number(process.env.CS_DEFAULT_UNIT_DAMAGE || 10),
  attackRange: Number(process.env.CS_DEFAULT_UNIT_ATTACK_RANGE || 130),
  moveSpeed: Number(process.env.CS_DEFAULT_UNIT_MOVE_SPEED || 55),
  attackCooldown: Number(process.env.CS_DEFAULT_UNIT_ATTACK_COOLDOWN || 1.2),
});
const DEFAULT_DEPLOYED_UNIT_HP = Number(process.env.CS_DEFAULT_DEPLOYED_UNIT_HP || 1989);
const STATIC_COMBAT_STATS = Object.freeze({
  damage: Number(process.env.CS_STATIC_UNIT_DAMAGE || 8),
  attackRange: Number(process.env.CS_STATIC_UNIT_ATTACK_RANGE || 180),
  moveSpeed: 0,
  attackCooldown: Number(process.env.CS_STATIC_UNIT_ATTACK_COOLDOWN || 1.6),
});

const GAME_SERVER_IP = process.env.CS_GAME_SERVER_IP || "127.0.0.1";
const GAME_SERVER_PORT = Number(process.env.CS_GAME_SERVER_PORT || PORT);
const CONTENTS_VERSION = process.env.CS_CONTENTS_VERSION || "9.2.c";
const CONTENTS_TAGS = parseTags(
  process.env.CS_CONTENTS_TAGS ||
    "GLOBAL,LANGUAGE_KOR,LANGUAGE_ENG,LANGUAGE_DEU,LANGUAGE_FRA,LANGUAGE_JPN,LANGUAGE_TRADITIONAL_CHN,VOICE_KOR,VOICE_JPN,CHECK_MAINTENANCE,MULTITASK_DOWNLOAD"
);
const OPEN_TAGS = parseTags(process.env.CS_OPEN_TAGS || "");

const CRYPTO_MASKS = [
  14170986657190717782n,
  15546886188969944187n,
  15913139373130964729n,
  3486779174683840252n,
];

const capturedTcpResponses = loadCapturedTcpResponses(CAPTURED_TCP_DIR);
const capturedTcpProfiles = buildCapturedTcpProfiles(capturedTcpResponses);
const capturedGameFlow = loadCapturedGameFlow(CAPTURED_GAME_FLOW_DIR);
const capturedRespawnUnitPools = buildCombatCapturedRespawnUnitPools(capturedGameFlow, {
  decodeGameRespawnReq,
  parseCapturedGameSyncPayload,
  gameRespawnAck: GAME_RESPAWN_ACK,
  gameSync: NPT_GAME_SYNC_DATA_PACK_NOT,
});
const capturedCombatReplayEntries = buildCapturedCombatReplayEntries(capturedGameFlow);
const capturedFlowMirror = loadCapturedFlowMirror(CAPTURED_FLOW_DIR);
const gameplayUnitStats = loadGameplayUnitStats(UNIT_TABLE_PATH);
const userDb = loadUserDb(USER_DB_PATH);
const packetHandlers = loadPacketHandlers(PACKET_HANDLER_DIR);

// Combat simulation is isolated behind combat-handler. This listener keeps the
// networking responsibilities: packet routing, encryption/framing, capture replay
// ordering, and socket writes.
const combatHandler = createCombatHandler({
  constants: {
    HEART_BIT_ACK,
    GAME_END_NOT,
    NPT_GAME_SYNC_DATA_PACK_NOT,
  },
  config: {
    DYNAMIC_BATTLE_MANAGER,
    DYNAMIC_BATTLE_SYNC_INTERVAL_MS,
    DYNAMIC_BATTLE_GAME_UNIT_GROUPS,
    CSHARP_COMBAT_HOST,
    CSHARP_COMBAT_HOST_PROJECT,
    CSHARP_COMBAT_HOST_DLL,
    CSHARP_COMBAT_HOST_TIMEOUT_MS,
    CSHARP_COMBAT_HOST_DOTNET,
    COUNTERSIDE_MANAGED_DIR,
    GAMEPLAY_TABLES_DIR,
  },
  combatStateId: COMBAT_STATE_ID,
  defaultCombatStats: DEFAULT_COMBAT_STATS,
  staticCombatStats: STATIC_COMBAT_STATS,
  defaultDeployedUnitHp: DEFAULT_DEPLOYED_UNIT_HP,
  gameplayUnitStats,
  capturedGameFlow,
  capturedRespawnUnitPools,
  parseCapturedGameSyncPayload,
  extractGameLoadUnitPools,
  makeDynamicGameUid,
  mapIdForStageDungeon,
});

let lastSteamAccessToken = "";
let lastEffectiveAccessToken = "";
let lastAckContentsVersion = "";
let lastAckContentsTags = [];
let runtimeConfigPrinted = false;

startTcpServer();
startHttpMirror();

function startTcpServer() {
  const server = net.createServer((socket) => {
    socket.recvBuffer = Buffer.alloc(0);
    socket.session = {
      user: null,
      steamLogin: null,
      gameReplay: createGameReplayState(),
    };
    lastSteamAccessToken = "";
    lastAckContentsVersion = "";
    lastAckContentsTags = [];

    console.log(`\n[+] Client connected: ${socket.remoteAddress}:${socket.remotePort}`);
    logRuntimeConfig();

    socket.on("data", (chunk) => {
      socket.recvBuffer = Buffer.concat([socket.recvBuffer, chunk]);
      processReceiveBuffer(socket);
    });

    socket.on("end", () => console.log("[*] Client ended socket"));
    socket.on("close", (hadError) => {
      stopGameSyncTimers(socket);
      console.log(`[-] Client disconnected hadError=${hadError}`);
    });
    socket.on("error", (err) => console.log(`[!] Socket error: ${err.message}`));
  });

  server.listen(PORT, () => console.log(`[+] Listening on port ${PORT}`));
}

function logRuntimeConfig() {
  if (runtimeConfigPrinted && !LOG_CONFIG_EACH_CONNECTION) return;
  runtimeConfigPrinted = true;

  console.log(`[cfg] localUserDb=${USE_LOCAL_USER_DB ? "on" : "off"} db=${USER_DB_PATH}`);
  console.log(
    `[cfg] tcpReplay contents=${REPLAY_CAPTURED_CONTENTS_VERSION ? "on" : "off"} login=${
      REPLAY_CAPTURED_LOGIN_ACK ? "on" : "off"
    } packets=${[...capturedTcpResponses.keys()].join(",") || "(none)"}`
  );
  console.log(
    `[cfg] gameReplay=${REPLAY_CAPTURED_GAME_FLOW && capturedGameFlow ? "on" : "off"} packets=${
      capturedGameFlow ? capturedGameFlow.server.length : 0
    } autoAdvance=${REPLAY_CAPTURED_GAME_AUTO_ADVANCE ? `${REPLAY_CAPTURED_GAME_AUTO_ADVANCE_MS}ms` : "off"} reframe=${
      REFRAME_CAPTURED_GAME_FLOW ? "on" : "off"
    }`
  );
  console.log(`[cfg] contentsVersion=${CONTENTS_VERSION}`);
  console.log(`[cfg] contentsTags=${CONTENTS_TAGS.length}`);
  if (capturedTcpProfiles.contentsVersionAck) {
    console.log(
      `[cfg] officialTcpVersion=${capturedTcpProfiles.contentsVersionAck.contentsVersion} tags=${capturedTcpProfiles.contentsVersionAck.contentsTag.length}`
    );
  }
  if (capturedTcpProfiles.loginAck) {
    console.log(
      `[cfg] officialLoginAck=on version=${capturedTcpProfiles.loginAck.contentsVersion} tags=${capturedTcpProfiles.loginAck.contentsTag.length} openTags=${capturedTcpProfiles.loginAck.openTag.length}`
    );
  }
  console.log(`[cfg] gameServer=${GAME_SERVER_IP}:${GAME_SERVER_PORT}`);
  console.log(`[cfg] accessTokenSource=${USE_STEAM_TOKEN_AS_ACCESS_TOKEN ? "steam" : "server-issued"}`);
  console.log(`[cfg] skipTutorialCutscene=${SKIP_TUTORIAL_CUTSCENE ? "on" : "off"}`);
  console.log(
    `[cfg] officialCombatReplay=${OFFICIAL_COMBAT_REPLAY ? "on" : "off"} packets=${
      capturedCombatReplayEntries.length
    } startIndex=${OFFICIAL_COMBAT_REPLAY_START_INDEX} interval=${OFFICIAL_COMBAT_REPLAY_INTERVAL_MS}ms`
  );
  console.log(`[cfg] battleSimulator=${BATTLE_SIMULATOR ? "on" : "off"} syncInterval=${SYNTHETIC_SYNC_INTERVAL_MS}ms`);
  console.log(
    `[cfg] dynamicBattleManager=${DYNAMIC_BATTLE_MANAGER ? "on" : "off"} syncInterval=${DYNAMIC_BATTLE_SYNC_INTERVAL_MS}ms spawnGroups=${DYNAMIC_BATTLE_GAME_UNIT_GROUPS.map((group) => group.join(",")).join(";")}`
  );
  console.log(
    `[cfg] csharpCombatHost=${CSHARP_COMBAT_HOST ? "on" : "off"} dotnet=${CSHARP_COMBAT_HOST_DOTNET} project=${CSHARP_COMBAT_HOST_PROJECT} managed=${
      COUNTERSIDE_MANAGED_DIR || "(none)"
    } tables=${GAMEPLAY_TABLES_DIR || "(none)"}`
  );
  console.log(`[cfg] verboseCaptureLogs=${VERBOSE_CAPTURE_LOGS ? "on" : "off"}`);
}

function startHttpMirror() {
  if (!capturedFlowMirror) {
    console.log(`[mirror] disabled; no manifest at ${path.join(CAPTURED_FLOW_DIR, "manifest.json")}`);
    return;
  }

  http
    .createServer((req, res) => serveCapturedFlow(req, res, capturedFlowMirror))
    .listen(HTTP_MIRROR_PORT, () => {
      console.log(`[+] Captured HTTP mirror listening on ${MIRROR_PUBLIC_BASE_URL}`);
      console.log(`[+] Captured HTTP mirror fixtureDir=${CAPTURED_FLOW_DIR}`);
    });
}

function processReceiveBuffer(socket) {
  while (socket.recvBuffer.length >= 12) {
    const headOffset = socket.recvBuffer.indexOf(Buffer.from([0xdd, 0xcc, 0xbb, 0xaa]));
    if (headOffset < 0) {
      console.log(`[!] Dropping ${socket.recvBuffer.length} bytes without packet fence`);
      socket.recvBuffer = Buffer.alloc(0);
      return;
    }

    if (headOffset > 0) {
      console.log(`[!] Dropping ${headOffset} leading bytes before packet fence`);
      socket.recvBuffer = socket.recvBuffer.subarray(headOffset);
    }

    if (socket.recvBuffer.length < 8) {
      return;
    }

    const totalLength = socket.recvBuffer.readInt32LE(4);
    if (totalLength <= 12) {
      console.log(`[!] Invalid packet length ${totalLength}; closing socket`);
      socket.destroy();
      return;
    }

    if (socket.recvBuffer.length < totalLength) {
      return;
    }

    const raw = socket.recvBuffer.subarray(0, totalLength);
    socket.recvBuffer = socket.recvBuffer.subarray(totalLength);

    let parsed;
    try {
      parsed = parsePacket(raw);
    } catch (err) {
      console.log(`[!] Failed to parse packet: ${err.message}`);
      socket.destroy();
      return;
    }

    handlePacket(socket, parsed);
  }
}

function handlePacket(socket, packet) {
  console.log(
    `[RECV] packetId=${packet.packetId} sequence=${packet.sequence} compressed=${packet.compressed ? 1 : 0} payloadSize=${packet.payloadSize}`
  );
  if (DEBUG_HEX) printHex(packet.raw);

  const handler = packetHandlers.get(packet.packetId);
  if (handler) {
    try {
      const handled = handler.handle(createPacketContext(), socket, packet);
      if (handled !== false) return;
    } catch (err) {
      console.log(`[handler:${handler.name || packet.packetId}] failed: ${err.stack || err.message}`);
      socket.destroy();
      return;
    }
  }

  if (handleFallbackPacket(createPacketContext(), socket, packet)) {
    return;
  }
}

function handleFallbackPacket(ctx, socket, packet) {
  console.log(
    `[official-missing] no sniffed handler/response for packetId=${packet.packetId} sequence=${packet.sequence} payloadSize=${packet.payloadSize}; no response sent`
  );
  return true;
}

function sendResponse(socket, sequence, packetId, builder) {
  const response = builder();
  socket.write(response);
  const parsed = parsePacket(response);
  console.log(
    `[SEND] packetId=${packetId} sequence=${sequence} compressed=${parsed.compressed ? 1 : 0} payloadSize=${parsed.payloadSize}`
  );
  if (DEBUG_HEX) printHex(response);
}

function createPacketContext() {
  return {
    constants: {
      LOGIN_ACK,
      JOIN_LOBBY_REQ,
      JOIN_LOBBY_ACK,
      RECONNECT_ACK,
      CONTENTS_VERSION_ACK,
      HEART_BIT_ACK,
      CONNECT_CHECK_ACK,
      SERVER_TIME_ACK,
      GAME_LOAD_ACK,
      GAME_END_NOT,
      GAME_PAUSE_ACK,
      GAME_RESPAWN_ACK,
      CUTSCENE_DUNGEON_START_ACK,
      CUTSCENE_DUNGEON_CLEAR_ACK,
      FRIEND_LIST_ACK,
      GREETING_MESSAGE_ACK,
      EQUIP_PRESET_LIST_ACK,
      FAVORITES_STAGE_ACK,
      POST_LIST_ACK,
      DEFENCE_INFO_ACK,
      NPT_GAME_SYNC_DATA_PACK_NOT,
    },
    config: {
      USE_LOCAL_USER_DB,
      REPLAY_CAPTURED_CONTENTS_VERSION,
      REPLAY_CAPTURED_LOGIN_ACK,
      REPLAY_CAPTURED_GAME_FLOW,
      BATTLE_SIMULATOR,
      DYNAMIC_BATTLE_MANAGER,
      DYNAMIC_BATTLE_SYNC_INTERVAL_MS,
      DYNAMIC_BATTLE_GAME_UNIT_GROUPS,
      OFFICIAL_COMBAT_REPLAY,
      VERBOSE_CAPTURE_LOGS,
      SKIP_TUTORIAL_CUTSCENE,
      CONTENTS_VERSION,
      CONTENTS_TAGS,
    },
    capturedTcpResponses,
    capturedTcpProfiles,
    capturedGameFlow,
    userDb,
    setLastAckContents(version, tags) {
      lastAckContentsVersion = version || "";
      lastAckContentsTags = Array.isArray(tags) ? tags.slice() : [];
    },
    setLastEffectiveAccessToken(token) {
      lastEffectiveAccessToken = token || "";
    },
    sendResponse,
    sendCapturedGameThrough,
    sendCapturedGameExact,
    sendCapturedGamePacketIdOnly,
    sendCapturedGameThroughPacketId,
    sendCapturedGameUntilBeforePacketIds,
    skipCapturedGameThroughPacketId,
    skipCapturedGameUntilBeforePacketIds,
    sendCapturedHeartbeatReply,
    maybeTransitionTutorialReplayToDynamic,
    peekCapturedGamePacketId,
    sendServerGamePacket,
    sendDynamicGameLoadAck,
    startDynamicBattleManager,
    handleDynamicBattleRespawn,
    startOfficialCombatReplay,
    startSyntheticGameSync,
    scheduleCapturedGameAutoAdvance,
    logCapturedClientPacketMatch,
    maybeSendTutorialCutsceneClear,
    logGameLoadReq,
    decodeGameLoadReq,
    decodeGameRespawnReq,
    buildGameLoadAck,
    getCapturedServerPayloadTemplate,
    buildRespawnAck,
    buildGameSync,
    buildGameSyncPackets,
    buildInitialBattleSync,
    buildInitialBattlePackets,
    deployStageLineup,
    buildGameRespawnAckPayload,
    buildGamePauseAckPayload,
    buildFramedPacket,
    buildEncryptedPacket,
    buildContentsVersionAck,
    buildCapturedLoginAck,
    buildCapturedReconnectAck,
    buildLoginAck,
    buildLoginLikePayload,
    buildMinimalJoinLobbyPayload,
    buildCutsceneDungeonStartAckPayload,
    buildCutsceneDungeonClearAckPayload,
    decodeSteamLoginReq,
    decodeJoinLobbyReq,
    readCutsceneDungeonReq,
    decryptCopy,
    safeReadString,
    safeReadSignedVarLong,
    writeSignedVarInt,
    writeSignedVarLong,
    writeInt64LE,
    dateTimeBinaryNow,
    getOrCreateUserForSteam,
    issueUserTokens,
    saveUserDb,
    findUserByAccessToken,
    findUserByReconnectKey,
    createEphemeralUser,
  };
}

function loadPacketHandlers(handlerDir) {
  const handlers = new Map();
  if (!fs.existsSync(handlerDir)) {
    console.log(`[handlers] no packet handler directory at ${handlerDir}`);
    return handlers;
  }

  for (const fileName of fs.readdirSync(handlerDir).filter((file) => file.endsWith(".js")).sort()) {
    const filePath = path.join(handlerDir, fileName);
    try {
      const handler = require(filePath);
      if (typeof handler.packetId !== "number" || typeof handler.handle !== "function") {
        console.log(`[handlers] skip ${fileName}; missing packetId/handle`);
        continue;
      }
      if (handlers.has(handler.packetId)) {
        console.log(`[handlers] duplicate packetId=${handler.packetId}; ${fileName} ignored`);
        continue;
      }
      handlers.set(handler.packetId, { ...handler, fileName });
    } catch (err) {
      console.log(`[handlers] failed to load ${fileName}: ${err.message}`);
    }
  }

  console.log(`[handlers] loaded ${handlers.size} packet handlers from ${handlerDir}`);
  return handlers;
}

function createGameReplayState() {
  return {
    inGameFlow: false,
    friendListCount: 0,
    pauseCount: 0,
    pendingPauseCount: 0,
    heartbeatCount: 0,
    loadCompleteReceived: false,
    firstPostLoadHeartbeatSyncSent: false,
    nextServerIndex: 1,
    nextServerSequence: 1,
    autoAdvanceTimer: null,
    syntheticSyncTimer: null,
    syntheticSyncCount: 0,
    officialCombatReplayTimer: null,
    officialCombatReplayCursor: 0,
    officialCombatReplayCount: 0,
    officialCaptureExhaustedLogged: false,
    syntheticGameTime: 0,
    lastRespawnReq: null,
    dynamicBattleTimer: null,
    dynamicBattleResultSent: false,
    battleSim: null,
    tutorialReplayPhase: "",
  };
}

function scheduleCapturedGameAutoAdvance(socket) {
  if (!REPLAY_CAPTURED_GAME_AUTO_ADVANCE) return;
  const replay = socket.session.gameReplay;
  if (replay.autoAdvanceTimer) clearTimeout(replay.autoAdvanceTimer);
  replay.autoAdvanceTimer = setTimeout(() => {
    if (socket.destroyed) return;
    if (replay.nextServerIndex <= 28) {
      console.log("[capture-game:auto-advance] client did not send post-804 load-complete; replaying 808/809/start sync");
      sendCapturedGameThrough(socket, 39, "auto-game-start");
    }
  }, REPLAY_CAPTURED_GAME_AUTO_ADVANCE_MS);
}

function sendCapturedGameThrough(socket, endIndex, label) {
  const replay = socket.session.gameReplay;
  sendCapturedGameRange(socket, replay.nextServerIndex, endIndex, label);
}

function sendCapturedGameExact(socket, index, label) {
  const replay = socket.session.gameReplay;
  const entry = capturedGameFlow.server[index - 1];
  if (!entry || !entry.raw) {
    console.log(`[capture-game] missing server packet index=${index} label=${label}`);
    return;
  }
  sendCapturedGameEntry(socket, entry, index, label);
  replay.nextServerIndex = Math.max(replay.nextServerIndex, index + 1);
}

function sendCapturedGamePacketIdOnly(socket, packetId, label) {
  const replay = socket.session.gameReplay;
  const index = findNextCapturedServerIndex(socket, (entry) => entry.packetId === packetId);
  if (!index) {
    console.log(`[official-missing] no captured server packetId=${packetId} label=${label}; no response sent`);
    return false;
  }
  sendCapturedGameEntry(socket, capturedGameFlow.server[index - 1], index, label, { forceReframe: true });
  replay.nextServerIndex = Math.max(replay.nextServerIndex, index + 1);
  return true;
}

function sendCapturedGameThroughPacketId(socket, packetId, label) {
  const replay = socket.session.gameReplay;
  const index = findNextCapturedServerIndex(socket, (entry) => entry.packetId === packetId);
  if (!index) {
    console.log(
      `[official-missing] no captured server packetId=${packetId} from index=${replay.nextServerIndex} label=${label}; no response sent`
    );
    return false;
  }
  sendCapturedGameRange(socket, replay.nextServerIndex, index, label);
  return true;
}

function sendCapturedGameUntilBeforePacketIds(socket, packetIds, label) {
  const replay = socket.session.gameReplay;
  const stops = new Set(packetIds);
  const stopIndex = findNextCapturedServerIndex(socket, (entry) => stops.has(entry.packetId));
  const endIndex = stopIndex ? stopIndex - 1 : capturedGameFlow.server.length;
  if (endIndex >= replay.nextServerIndex) {
    sendCapturedGameRange(socket, replay.nextServerIndex, endIndex, label);
    return true;
  }
  return false;
}

function skipCapturedGameThroughPacketId(socket, packetId) {
  const replay = socket.session.gameReplay;
  const index = findNextCapturedServerIndex(socket, (entry) => entry.packetId === packetId);
  if (index) replay.nextServerIndex = Math.max(replay.nextServerIndex, index + 1);
  return index;
}

function skipCapturedGameUntilBeforePacketIds(socket, packetIds) {
  const replay = socket.session.gameReplay;
  const stops = new Set(packetIds);
  const stopIndex = findNextCapturedServerIndex(socket, (entry) => stops.has(entry.packetId));
  const endIndex = stopIndex ? stopIndex - 1 : capturedGameFlow.server.length;
  if (endIndex >= replay.nextServerIndex) {
    replay.nextServerIndex = endIndex + 1;
    return true;
  }
  return false;
}

function sendCapturedHeartbeatReply(socket, time, label) {
  const replay = socket.session.gameReplay;
  sendServerGamePacket(socket, HEART_BIT_ACK, writeSignedVarLong(time), label);

  const next = capturedGameFlow && capturedGameFlow.server[replay.nextServerIndex - 1];
  if (next && next.packetId === HEART_BIT_ACK) {
    replay.nextServerIndex += 1;
  } else if (next) {
    console.log(
      `[capture-game:${label}] expected captured HEART_BIT_ACK at index=${replay.nextServerIndex}, nextPacketId=${next.packetId}; using live ACK only`
    );
  }

  const stopPacketIds =
    DYNAMIC_BATTLE_MANAGER &&
    replay.dynamicGame &&
    replay.dynamicGame.tutorial &&
    replay.nextServerIndex >= TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX - 8
      ? [HEART_BIT_ACK, 813, 817, GAME_END_NOT]
      : [HEART_BIT_ACK, 813, 817];
  sendCapturedGameUntilBeforePacketIds(socket, stopPacketIds, `${label}-post-sync`);
}

function maybeTransitionTutorialReplayToDynamic(socket, label) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.tutorialReplayPhase || replay.tutorialReplayPhase === "dynamic") return false;
  if (replay.nextServerIndex < TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX) return false;
  combatHandler.transitionTutorialReplayToDynamic(replay, replay.nextServerIndex);
  console.log(
    `[tutorial-replay:${label}] handoff to dynamic sync at serverIndex=${replay.nextServerIndex} units=${
      replay.battleState ? replay.battleState.units.map((unit) => unit.gameUnitUID).join(",") : ""
    }`
  );
  startDynamicBattleManager(socket, `tutorial-${label}`);
  return true;
}

function extractGameLoadUnitPools(rawPayload) {
  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  if (!rawPayload || rawPayload.length === 0) return pools;
  try {
    let offset = 0;
    offset = readSignedVarInt(rawPayload, offset).offset; // errorCode
    if (rawPayload.readUInt8(offset) === 0) return pools;
    offset += 1;
    const parsed = parseCapturedNkmGameDataUnitPools(rawPayload, offset);
    return parsed.pools;
  } catch (err) {
    if (DEBUG_HEX) console.log(`[dynamic-game-load] 804 unit-pool parse failed: ${err.message}`);
    return pools;
  }
}

function parseCapturedNkmGameDataUnitPools(buffer, offset) {
  offset = readSignedVarLong(buffer, offset).offset; // m_GameUID
  offset = readSignedVarInt(buffer, offset).offset; // m_GameUnitUIDIndex
  offset += 1; // m_bLocal
  offset = readSignedVarInt(buffer, offset).offset; // m_NKM_GAME_TYPE
  offset = readSignedVarInt(buffer, offset).offset; // m_DungeonID
  offset += 1; // m_bBossDungeon
  offset = readSignedVarInt(buffer, offset).offset; // m_WarfareID
  offset = readSignedVarLong(buffer, offset).offset; // m_RaidUID
  offset += 4; // m_fRespawnCostMinusPercentForTeamA
  offset = readSignedVarInt(buffer, offset).offset; // m_TeamASupply
  offset += 4; // m_fTeamAAttackPowerIncRateForWarfare
  offset = skipCapturedStringList(buffer, offset); // m_lstTeamABuffStrIDListForRaid
  offset += 4; // fExtraRespawnCostAddForA
  offset += 4; // fExtraRespawnCostAddForB
  offset = readSignedVarInt(buffer, offset).offset; // m_TeamBLevelAdd
  offset = readSignedVarInt(buffer, offset).offset; // m_TeamBLevelFix
  offset += 4; // m_fDoubleCostTime
  offset = readSignedVarInt(buffer, offset).offset; // m_MapID
  offset = skipCapturedSignedIntList(buffer, offset); // m_BattleConditionIDs

  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  const teamA = readCapturedNullableObject(buffer, offset, (inner, innerOffset) =>
    parseCapturedGameTeamUnitPools(inner, innerOffset, 1)
  );
  offset = teamA.offset;
  mergeExtractedUnitPools(pools, teamA.value);

  const teamB = readCapturedNullableObject(buffer, offset, (inner, innerOffset) =>
    parseCapturedGameTeamUnitPools(inner, innerOffset, 3)
  );
  offset = teamB.offset;
  mergeExtractedUnitPools(pools, teamB.value);
  return { pools, offset };
}

function parseCapturedGameTeamUnitPools(buffer, offset, team) {
  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  offset = readSignedVarInt(buffer, offset).offset; // m_eNKM_TEAM_TYPE
  offset = readSignedVarLong(buffer, offset).offset; // m_LeaderUnitUID
  offset = readSignedVarInt(buffer, offset).offset; // m_UserLevel
  offset = readString(buffer, offset).offset; // m_UserNickname
  offset = readSignedVarInt(buffer, offset).offset; // m_Tier
  offset = readSignedVarInt(buffer, offset).offset; // m_Score
  offset = readSignedVarInt(buffer, offset).offset; // m_WinStreak

  const mainShip = readCapturedNullableObject(buffer, offset, parseCapturedUnitDataPool);
  offset = mainShip.offset;
  mergeExtractedUnitPools(pools, mainShip.value, team);

  offset = skipCapturedNullableObject(buffer, offset, skipCapturedOperator);
  offset = readSignedVarLong(buffer, offset).offset; // m_user_uid

  const unitLists = [
    parseCapturedUnitDataPoolList,
    parseCapturedUnitDataPoolList,
    parseCapturedUnitDataPoolList,
    parseCapturedUnitDataPoolList,
    parseCapturedDynamicRespawnUnitPoolList,
    parseCapturedUnitDataPoolList,
  ];
  for (const parser of unitLists) {
    const parsed = parser(buffer, offset, team);
    offset = parsed.offset;
    mergeExtractedUnitPools(pools, parsed.pools, team);
  }

  offset = skipCapturedObjectListGeneric(buffer, offset, skipCapturedTacticalCommand);
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedGameTeamDeckData);
  offset += 4; // m_fInitHP
  offset = skipCapturedObjectMapLongGeneric(buffer, offset, skipCapturedEquipItemData);
  offset = readSignedVarLong(buffer, offset).offset; // m_FriendCode
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedEmoticonPresetData);
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedGuildSimpleData);
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedCommonProfile);

  return { value: pools, offset };
}

function parseCapturedUnitDataPoolList(buffer, offset, team) {
  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const parsed = readCapturedNullableObject(buffer, offset, parseCapturedUnitDataPool);
    offset = parsed.offset;
    mergeExtractedUnitPools(pools, parsed.value, team);
  }
  return { pools, offset };
}

function parseCapturedDynamicRespawnUnitPoolList(buffer, offset, team) {
  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const parsed = readCapturedNullableObject(buffer, offset, (inner, innerOffset) => {
      const unit = readCapturedNullableObject(inner, innerOffset, parseCapturedUnitDataPool);
      innerOffset = unit.offset;
      innerOffset = readSignedVarInt(inner, innerOffset).offset; // m_MasterGameUnitUID
      innerOffset += 2; // m_bLoadedServer, m_bLoadedClient
      return { value: unit.value, offset: innerOffset };
    });
    offset = parsed.offset;
    mergeExtractedUnitPools(pools, parsed.value, team);
  }
  return { pools, offset };
}

function parseCapturedUnitDataPool(buffer, offset) {
  const unitUID = readSignedVarLong(buffer, offset);
  offset = unitUID.offset;
  offset = readSignedVarLong(buffer, offset).offset; // m_UserUID
  const unitID = readSignedVarInt(buffer, offset);
  offset = unitID.offset;
  offset = readSignedVarInt(buffer, offset).offset; // level
  offset = readSignedVarInt(buffer, offset).offset; // exp
  offset = readSignedVarInt(buffer, offset).offset; // skin
  offset += 4; // injury
  offset = readSignedVarInt(buffer, offset).offset; // limit break
  offset += 2; // lock, summon unit
  offset = skipCapturedSignedIntList(buffer, offset); // stat EXP
  const gameUnitUIDs = readCapturedShortList(buffer, offset);
  offset = gameUnitUIDs.offset;
  offset = readCapturedShortList(buffer, offset).offset; // changed UID list
  offset = skipCapturedFloatList(buffer, offset); // near target ranges
  offset = skipCapturedSignedIntArrayOrList(buffer, offset, 5); // skill levels
  offset = skipCapturedSignedLongArrayOrList(buffer, offset, 4); // equips
  offset = readSignedVarInt(buffer, offset).offset; // loyalty
  offset += 3; // permanent contract, seized, from contract
  offset = readSignedVarInt(buffer, offset).offset; // officeRoomId
  offset += 8; // m_regDate
  offset = readSignedVarInt(buffer, offset).offset; // officeGrade
  offset += 8; // officeGaugeStartTime
  offset = readSignedVarLong(buffer, offset).offset; // m_DungeonRespawnUnitTempletUID
  offset += 1; // isFavorite
  offset = skipCapturedObjectListGeneric(buffer, offset, skipCapturedShipCmdModule);
  offset = readSignedVarInt(buffer, offset).offset; // tacticLevel
  offset = readSignedVarInt(buffer, offset).offset; // reactorLevel
  return {
    value: {
      unitUID: unitUID.value.toString(),
      unitID: unitID.value,
      gameUnitUIDs: gameUnitUIDs.value,
    },
    offset,
  };
}

function mergeExtractedUnitPools(target, source, team) {
  if (!target || !source) return;
  const entries = source.ordered
    ? source.ordered
    : source.gameUnitUIDs
      ? [{ unitUID: String(source.unitUID || ""), unitID: source.unitID || 0, gameUnitUIDs: source.gameUnitUIDs }]
      : [];
  for (const entry of entries) {
    const gameUnitUIDs = (entry.gameUnitUIDs || []).map(Number).filter((value) => Number.isInteger(value) && value > 0);
    for (const uid of gameUnitUIDs) {
      if (!target.allGameUnitUIDs.includes(uid)) target.allGameUnitUIDs.push(uid);
    }
    if (!entry.unitUID || gameUnitUIDs.length === 0) continue;
    const key = String(entry.unitUID);
    if (!target.byUnitUID.has(key)) {
      target.byUnitUID.set(key, { unitUID: key, unitID: entry.unitID || 0, team, gameUnitUIDs: [], cursor: 0 });
      target.ordered.push(target.byUnitUID.get(key));
    }
    const pool = target.byUnitUID.get(key);
    for (const uid of gameUnitUIDs) {
      if (!pool.gameUnitUIDs.includes(uid)) pool.gameUnitUIDs.push(uid);
    }
  }
}

function readCapturedNullableObject(buffer, offset, parser) {
  if (buffer.readUInt8(offset) === 0) return { value: null, offset: offset + 1 };
  return parser(buffer, offset + 1);
}

function skipCapturedNullableObject(buffer, offset, skipper) {
  if (buffer.readUInt8(offset) === 0) return offset + 1;
  return skipper(buffer, offset + 1);
}

function readCapturedShortList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const value = [];
  for (let index = 0; index < count.value; index += 1) {
    const item = readSignedVarInt(buffer, offset);
    offset = item.offset;
    value.push(item.value);
  }
  return { value, offset };
}

function skipCapturedSignedIntList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedStringList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readString(buffer, offset).offset;
  return offset;
}

function skipCapturedFloatList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset + count.value * 4;
  return offset;
}

function skipCapturedSignedIntArrayOrList(buffer, offset, fallbackCount) {
  const count = readVarInt(buffer, offset);
  if (count.value <= 32 && count.offset + count.value <= buffer.length) {
    let next = count.offset;
    for (let index = 0; index < count.value; index += 1) next = readSignedVarInt(buffer, next).offset;
    return next;
  }
  let next = offset;
  for (let index = 0; index < fallbackCount; index += 1) next = readSignedVarInt(buffer, next).offset;
  return next;
}

function skipCapturedSignedLongArrayOrList(buffer, offset, fallbackCount) {
  const count = readVarInt(buffer, offset);
  if (count.value <= 32 && count.offset + count.value <= buffer.length) {
    let next = count.offset;
    for (let index = 0; index < count.value; index += 1) next = readSignedVarLong(buffer, next).offset;
    return next;
  }
  let next = offset;
  for (let index = 0; index < fallbackCount; index += 1) next = readSignedVarLong(buffer, next).offset;
  return next;
}

function skipCapturedOperator(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset += 1;
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedOperatorSkill);
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedOperatorSkill);
  offset += 1;
  return offset;
}

function skipCapturedOperatorSkill(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset += 1;
  offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedObjectListGeneric(buffer, offset, skipper) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = skipCapturedNullableObject(buffer, offset, skipper);
  }
  return offset;
}

function skipCapturedObjectMapLongGeneric(buffer, offset, skipper) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readSignedVarLong(buffer, offset).offset;
    offset = skipCapturedNullableObject(buffer, offset, skipper);
  }
  return offset;
}

function skipCapturedGameTeamDeckData(buffer, offset) {
  offset += 1; // m_DataEncryptSeed
  offset = skipCapturedSignedLongList(buffer, offset);
  offset = readSignedVarLong(buffer, offset).offset; // m_NextDeck
  offset = skipCapturedSignedLongList(buffer, offset);
  offset = skipCapturedSignedLongList(buffer, offset);
  offset = readSignedVarInt(buffer, offset).offset; // m_AutoRespawnIndex
  offset = readSignedVarInt(buffer, offset).offset; // m_AutoRespawnIndexAssist
  offset = skipCapturedLongIntMap(buffer, offset); // m_dicRespawnLimitCount
  return offset;
}

function skipCapturedTacticalCommand(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset += 1;
  offset += 4;
  offset += 2;
  offset += 4;
  offset += 1;
  offset += 4;
  return offset;
}

function skipCapturedEquipItemData(buffer, offset) {
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = skipCapturedObjectListGeneric(buffer, offset, skipCapturedEquipItemStat);
  offset = readSignedVarLong(buffer, offset).offset;
  offset += 1;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = skipCapturedObjectListGeneric(buffer, offset, skipCapturedPotentialOption);
  return offset;
}

function skipCapturedEquipItemStat(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset += 8;
  return offset;
}

function skipCapturedPotentialOption(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = skipCapturedObjectArrayOrList(buffer, offset, 3, skipCapturedPotentialSocketData);
  offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedPotentialSocketData(buffer, offset) {
  offset += 4;
  offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedEmoticonPresetData(buffer, offset) {
  offset = skipCapturedSignedIntList(buffer, offset);
  offset = skipCapturedSignedIntList(buffer, offset);
  return offset;
}

function skipCapturedGuildSimpleData(buffer, offset) {
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readString(buffer, offset).offset;
  offset = readSignedVarLong(buffer, offset).offset;
  return offset;
}

function skipCapturedCommonProfile(buffer, offset) {
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readString(buffer, offset).offset;
  for (let index = 0; index < 6; index += 1) offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedSignedLongList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarLong(buffer, offset).offset;
  return offset;
}

function skipCapturedLongIntMap(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readSignedVarLong(buffer, offset).offset;
    offset = readSignedVarInt(buffer, offset).offset;
  }
  return offset;
}

function skipCapturedObjectArrayOrList(buffer, offset, fallbackCount, skipper) {
  const count = readVarInt(buffer, offset);
  if (count.value <= 32 && count.offset < buffer.length) {
    let next = count.offset;
    for (let index = 0; index < count.value; index += 1) next = skipCapturedNullableObject(buffer, next, skipper);
    return next;
  }
  let next = offset;
  for (let index = 0; index < fallbackCount; index += 1) next = skipCapturedNullableObject(buffer, next, skipper);
  return next;
}

function skipCapturedShipCmdModule(buffer, offset) {
  // Ship command slots are either an object array with a small count or the fixed two-slot array
  // used by NKMShipCmdModule. Handle the normal counted representation first.
  const count = readVarInt(buffer, offset);
  if (count.value <= 4 && count.offset < buffer.length) {
    let next = count.offset;
    for (let index = 0; index < count.value; index += 1) next = skipCapturedNullableObject(buffer, next, skipCapturedShipCmdSlot);
    return next;
  }
  let next = offset;
  for (let index = 0; index < 2; index += 1) next = skipCapturedNullableObject(buffer, next, skipCapturedShipCmdSlot);
  return next;
}

function skipCapturedShipCmdSlot(buffer, offset) {
  offset = skipCapturedSignedIntList(buffer, offset); // targetStyleType HashSet
  offset = skipCapturedSignedIntList(buffer, offset); // targetRoleType HashSet
  offset = readSignedVarInt(buffer, offset).offset; // statType
  offset += 4; // statValue
  offset += 1; // isLock
  return offset;
}

function parseCapturedGameSyncPayload(entry) {
  const payload = entry.compressed ? lz4StreamDecompress(entry.payload) : decryptCopy(entry.payload);
  let offset = 0;
  const gameTime = payload.readFloatLE(offset);
  offset += 4;
  const absoluteGameTime = payload.readFloatLE(offset);
  offset += 4;
  if (payload.readUInt8(offset) === 0) return { gameTime, absoluteGameTime, units: [], remainGameTime: null };
  offset += 1;
  const baseList = readVarInt(payload, offset);
  offset = baseList.offset;
  const units = [];
  let remainGameTime = null;
  for (let index = 0; index < baseList.value; index += 1) {
    if (payload.readUInt8(offset) === 0) {
      offset += 1;
      continue;
    }
    offset += 1;
    const parsed = parseCapturedGameSyncBase(payload, offset);
    offset = parsed.offset;
    remainGameTime = parsed.remainGameTime == null ? remainGameTime : parsed.remainGameTime;
    units.push(...parsed.units);
  }
  return { gameTime, absoluteGameTime, units, remainGameTime };
}

function parseCapturedGameSyncBase(buffer, offset) {
  const gameTimeHalf = readVarInt(buffer, offset);
  offset = gameTimeHalf.offset;
  const remainHalf = readVarInt(buffer, offset);
  offset = remainHalf.offset;
  const remainGameTime = remainHalf.value / 100;

  for (let index = 0; index < 7; index += 1) offset = readVarInt(buffer, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = readSignedVarInt(buffer, offset).offset;
  offset = skipCapturedObjectList(buffer, offset, skipCapturedDieUnit);

  const unitList = readVarInt(buffer, offset);
  offset = unitList.offset;
  const units = [];
  for (let index = 0; index < unitList.value; index += 1) {
    if (buffer.readUInt8(offset) === 0) {
      offset += 1;
      continue;
    }
    offset += 1;
    const unitObjectPresent = buffer.readUInt8(offset) !== 0;
    offset += 1;
    if (!unitObjectPresent) continue;
    const parsed = parseCapturedUnitSyncData(buffer, offset);
    offset = parsed.offset;
    units.push(parsed.unit);
  }

  return { offset, remainGameTime, units };
}

function skipCapturedObjectList(buffer, offset, skipItem) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    if (buffer.readUInt8(offset) === 0) {
      offset += 1;
      continue;
    }
    offset = skipItem(buffer, offset + 1);
  }
  return offset;
}

function skipCapturedDieUnit(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function parseCapturedUnitSyncData(buffer, offset) {
  const seed = buffer.readUInt8(offset);
  offset += 1;
  const playState = readSignedVarInt(buffer, offset);
  offset = playState.offset;
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject);
  const respawn = buffer.readUInt8(offset) !== 0;
  offset += 1;
  offset += 1; // m_bRespawnUsedRollback
  const gameUnitUID = readSignedVarInt(buffer, offset);
  offset = gameUnitUID.offset;
  const targetUID = readSignedVarInt(buffer, offset);
  offset = targetUID.offset;
  const subTargetUID = readSignedVarInt(buffer, offset);
  offset = subTargetUID.offset;
  const encryptedHp = buffer.readFloatLE(offset);
  offset += 4;
  const x = buffer.readFloatLE(offset);
  offset += 4;
  const z = buffer.readFloatLE(offset);
  offset += 4;
  const jumpY = buffer.readFloatLE(offset);
  offset += 4;
  const speedX = readVarInt(buffer, offset);
  offset = speedX.offset;
  const speedY = readVarInt(buffer, offset);
  offset = speedY.offset;
  const speedZ = readVarInt(buffer, offset);
  offset = speedZ.offset;
  const right = buffer.readUInt8(offset) !== 0;
  offset += 1;
  const stateId = buffer.readUInt8(offset);
  offset += 1;
  const stateChangeCount = buffer.readInt8(offset);
  offset += 1;
  offset += 2; // m_bDamageSpeedXNegative, m_bAttackerZUp
  for (let index = 0; index < 8; index += 1) offset = readVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset; // m_CatcherGameUnitUID
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject); // m_listDamageData
  offset = skipCapturedObjectMapShort(buffer, offset, skipUnsupportedCapturedObject); // m_dicBuffData
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject); // m_listStatusTimeData
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject); // m_listInvokedTrigger
  offset = skipCapturedStringIntMap(buffer, offset); // m_dicEventVariables
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject); // m_listUpdatedReaction
  const savedPosX = buffer.readFloatLE(offset);
  offset += 4;
  offset += 4; // m_fSavedPosY

  return {
    offset,
    unit: {
      gameUnitUID: gameUnitUID.value,
      hp: Math.max(0, encryptedHp - seed),
      maxHp: Math.max(1, encryptedHp - seed),
      x,
      z,
      jumpY,
      right,
      team: right ? 1 : 3,
      playState: playState.value,
      respawn,
      stateId,
      stateChangeCount,
      targetUID: targetUID.value,
      subTargetUID: subTargetUID.value,
      seed,
      speedX: 0,
      speedY: 0,
      speedZ: 0,
      savedPosX: Number.isFinite(savedPosX) ? savedPosX : x,
    },
  };
}

function skipCapturedObjectMapShort(buffer, offset, skipItem) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readSignedVarInt(buffer, offset).offset;
    if (buffer.readUInt8(offset) === 0) {
      offset += 1;
      continue;
    }
    offset = skipItem(buffer, offset + 1);
  }
  return offset;
}

function skipCapturedStringIntMap(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readString(buffer, offset).offset;
    offset = readSignedVarInt(buffer, offset).offset;
  }
  return offset;
}

function skipUnsupportedCapturedObject() {
  throw new Error("unsupported captured nested object in sync parser");
}

function peekCapturedGamePacketId(socket) {
  if (!capturedGameFlow || !Array.isArray(capturedGameFlow.server)) return 0;
  const replay = socket.session.gameReplay;
  const next = capturedGameFlow.server[(replay.nextServerIndex || 1) - 1];
  return next ? next.packetId : 0;
}

function findNextCapturedServerIndex(socket, predicate) {
  if (!capturedGameFlow || !Array.isArray(capturedGameFlow.server)) return 0;
  const startIndex = Math.max(1, socket.session.gameReplay.nextServerIndex || 1);
  for (let index = startIndex; index <= capturedGameFlow.server.length; index += 1) {
    const entry = capturedGameFlow.server[index - 1];
    if (entry && predicate(entry, index)) return index;
  }
  return 0;
}

function sendCapturedGameRange(socket, startIndex, endIndex, label) {
  const replay = socket.session.gameReplay;
  const quietRange = !VERBOSE_CAPTURE_LOGS && endIndex > startIndex;
  let sentCount = 0;
  if (quietRange) {
    console.log(`[capture-game:${label}] SEND range=${startIndex}-${endIndex}`);
  }
  for (let index = startIndex; index <= endIndex; index += 1) {
    const entry = capturedGameFlow.server[index - 1];
    if (!entry || !entry.raw) {
      console.log(`[capture-game] missing server packet index=${index} label=${label}`);
      continue;
    }
    sendCapturedGameEntry(socket, entry, index, label, { quiet: quietRange });
    sentCount += 1;
    replay.nextServerIndex = Math.max(replay.nextServerIndex, index + 1);
  }
  if (quietRange) {
    console.log(`[capture-game:${label}] sent=${sentCount}`);
  }
}

function sendCapturedGameEntry(socket, entry, index, label, options = {}) {
  const replay = socket.session.gameReplay;
  const reframe = options.forceReframe || REFRAME_CAPTURED_GAME_FLOW;
  const sendSequence = reframe ? replay.nextServerSequence : entry.sequence;
  const packet =
    reframe && entry.payload
      ? buildFramedPacket(sendSequence, entry.packetId, entry.payload, entry.compressed)
      : entry.raw;
  socket.write(packet);
  const quiet = options.quiet && !VERBOSE_CAPTURE_LOGS;
  if (!quiet) {
    console.log(
      `[capture-game:${label}] SEND index=${index} packetId=${entry.packetId} sequence=${sendSequence} sourceSequence=${entry.sequence} payloadSize=${entry.payloadSize}`
    );
  }
  if (DEBUG_HEX) printHex(packet);
  replay.nextServerSequence = Math.max(replay.nextServerSequence, Number(sendSequence) + 1);
}

function startOfficialCombatReplay(socket, label) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || replay.officialCombatReplayTimer || replay.syntheticSyncTimer) return;
  if (!OFFICIAL_COMBAT_REPLAY || capturedCombatReplayEntries.length === 0) {
    if (ALLOW_SYNTHETIC_GAME_SYNC || BATTLE_SIMULATOR) {
      startSyntheticGameSync(socket, label);
    } else {
      console.log(`[capture-game:${label}] official combat replay unavailable; no synthetic fallback enabled`);
    }
    return;
  }

  replay.officialCombatReplayCursor = 0;
  replay.officialCombatReplayCount = 0;
  console.log(
    `[capture-game:${label}] starting official combat replay packets=${capturedCombatReplayEntries.length} interval=${OFFICIAL_COMBAT_REPLAY_INTERVAL_MS}ms`
  );
  replay.officialCombatReplayTimer = setInterval(() => {
    if (socket.destroyed) {
      stopGameSyncTimers(socket);
      return;
    }
    const item = capturedCombatReplayEntries[replay.officialCombatReplayCursor % capturedCombatReplayEntries.length];
    replay.officialCombatReplayCursor += 1;
    replay.officialCombatReplayCount += 1;
    sendCapturedGameEntry(socket, item.entry, item.index, "official-combat-replay", {
      forceReframe: true,
      quiet: true,
    });
  }, OFFICIAL_COMBAT_REPLAY_INTERVAL_MS);
  if (typeof replay.officialCombatReplayTimer.unref === "function") replay.officialCombatReplayTimer.unref();
}

function sendServerGamePacket(socket, packetId, payload, label) {
  const replay = socket.session.gameReplay;
  const sequence = replay.nextServerSequence;
  const packet = buildEncryptedPacket(sequence, packetId, payload);
  socket.write(packet);
  const parsed = parsePacket(packet);
  const quietSynthetic =
    (label === "synthetic-game-sync" || label === "battle-sim-sync" || label === "battle-manager-sync") && !DEBUG_HEX;
  if (!quietSynthetic || replay.syntheticSyncCount % 20 === 1) {
    console.log(`[capture-game:${label}] SEND packetId=${packetId} sequence=${sequence} payloadSize=${parsed.payloadSize}`);
  }
  if (DEBUG_HEX) printHex(packet);
  replay.nextServerSequence = Math.max(replay.nextServerSequence, Number(sequence) + 1);
}

function startSyntheticGameSync(socket, label) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || replay.syntheticSyncTimer) return;
  if (BATTLE_SIMULATOR) {
    combatHandler.initBattleSimulator(replay);
  }
  replay.syntheticGameTime = Math.max(Number(replay.syntheticGameTime || 0), replay.battleSim ? replay.battleSim.gameTime : 4);
  replay.syntheticSyncCount = 0;
  console.log(
    `[capture-game:${label}] starting ${BATTLE_SIMULATOR ? "battle-sim" : "synthetic empty"} 822 ticks interval=${SYNTHETIC_SYNC_INTERVAL_MS}ms`
  );
  replay.syntheticSyncTimer = setInterval(() => {
    if (socket.destroyed) {
      stopSyntheticGameSync(socket);
      return;
    }
    replay.syntheticSyncCount += 1;
    let syncPayload;
    let syncLabel;
    if (BATTLE_SIMULATOR && replay.battleSim) {
      syncPayload = combatHandler.buildBattleSimSyncPayload(replay, DYNAMIC_BATTLE_SYNC_INTERVAL_MS / 1000);
      syncLabel = "battle-sim-sync";
    } else {
      replay.syntheticGameTime += 0.5;
      syncPayload = combatHandler.buildSyntheticGameSyncPayload(replay.syntheticGameTime);
      syncLabel = "synthetic-game-sync";
    }
    sendServerGamePacket(
      socket,
      NPT_GAME_SYNC_DATA_PACK_NOT,
      syncPayload,
      syncLabel
    );
  }, SYNTHETIC_SYNC_INTERVAL_MS);
  if (typeof replay.syntheticSyncTimer.unref === "function") replay.syntheticSyncTimer.unref();
}

function stopSyntheticGameSync(socket) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.syntheticSyncTimer) return;
  clearInterval(replay.syntheticSyncTimer);
  replay.syntheticSyncTimer = null;
}

function stopGameSyncTimers(socket) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay) return;
  if (replay.dynamicBattleTimer) {
    clearInterval(replay.dynamicBattleTimer);
    replay.dynamicBattleTimer = null;
  }
  if (replay.syntheticSyncTimer) {
    clearInterval(replay.syntheticSyncTimer);
    replay.syntheticSyncTimer = null;
  }
  if (replay.officialCombatReplayTimer) {
    clearInterval(replay.officialCombatReplayTimer);
    replay.officialCombatReplayTimer = null;
  }
}

function startDynamicBattleManager(socket, label) {
  // Networking adapter: combat-handler owns the timer logic and sync payloads;
  // callbacks keep socket writes and captured packet advancement in this file.
  return combatHandler.startBattleLoop(socket, label, {
    sendGamePacket: sendServerGamePacket,
    stopTimers: stopGameSyncTimers,
  });
}

function sendDynamicGameLoadAck(socket, req, stage) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !req) return false;
  const activeStage = stage || {};
  const gameLoadAckTemplate = getCapturedServerPayloadTemplate(GAME_LOAD_ACK);
  // Stage data enters combat-handler here, then the listener wraps the resulting
  // state in the existing captured GAME_LOAD_ACK template.
  combatHandler.startBattle({
    replay,
    req,
    stage: activeStage,
    gameLoadAckPayloadBase64: gameLoadAckTemplate ? gameLoadAckTemplate.toString("base64") : "",
  });
  const payload = buildGameLoadAck({
    ...replay.dynamicGame,
    patchStageFields: !replay.dynamicGame.tutorial,
  });
  combatHandler.attachGameLoadUnitPools(replay, activeStage, payload);
  sendServerGamePacket(socket, GAME_LOAD_ACK, payload, "dynamic-game-load");
  console.log(
    `[dynamic-game-load] stageID=${replay.dynamicGame.stageID} dungeonID=${replay.dynamicGame.dungeonID} mapID=${replay.dynamicGame.mapID} gameUID=${replay.dynamicGame.gameUID} battleUnits=${replay.battleState.units.map((unit) => unit.gameUnitUID).join(",")} deployPools=${combatHandler.describeRuntimeGameUnitPools(replay.dynamicGame.unitPools) || replay.dynamicGame.assignedGameUnitUIDs.join(",")}`
  );
  return true;
}

function handleDynamicBattleRespawn(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  const result = combatHandler.handleDeploy({ replay, req });
  if (!result || !result.handled) return false;
  if (result.mode === "managed-local-server") {
    const packets = Array.isArray(result.packets) ? result.packets : [];
    if (packets.length > 0) {
      for (const item of packets) {
        sendServerGamePacket(socket, item.packetId, item.payload, item.label || "managed-deploy");
      }
    } else if (result.ackPayload) {
      sendServerGamePacket(socket, GAME_RESPAWN_ACK, result.ackPayload, "managed-respawn");
    }
    startDynamicBattleManager(socket, "respawn");
    console.log(`[combat-host] deploy accepted unitUID=${req.unitUID} packets=${packets.length}`);
    return true;
  }
  const ackLabel = result.mode === "battleState" ? "battle-continuation-respawn" : "battle-manager-respawn";
  sendServerGamePacket(socket, GAME_RESPAWN_ACK, result.ackPayload, ackLabel);
  if (result.syncPayload) {
    sendServerGamePacket(socket, NPT_GAME_SYNC_DATA_PACK_NOT, result.syncPayload, "battle-continuation-deploy-sync");
  }
  if (result.mode === "battleState") {
    if (result.deployed) {
      console.log(
        `[battle-continuation] deploy unitUID=${req.unitUID} gameUnitUID=${result.deployed.gameUnitUID} x=${result.deployed.x.toFixed(
          2
        )} hp=${result.deployed.hp}`
      );
      startDynamicBattleManager(socket, "deploy");
    } else {
      console.log(`[battle-continuation] respawn acked without active battleState unitUID=${req.unitUID}`);
    }
  } else if (result.spawned && result.spawned.length) {
    startDynamicBattleManager(socket, "respawn");
    console.log(
      `[battle-manager] deploy gameUnitUIDs=${result.spawned.map((unit) => unit.gameUnitUID).join(",")} unitUID=${req.unitUID} x=${result.spawned[0].x.toFixed(1)} cost=${result.spawned[0].cost}`
    );
  } else {
    console.log(`[battle-manager] no unused gameUnitUID available for deploy unitUID=${req.unitUID}`);
  }
  return true;
}

function deployStageLineup(replay) {
  return combatHandler.deployStageLineup(replay);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function logCapturedClientPacketMatch(packet, clientIndex, label) {
  const entry = capturedGameFlow.client && capturedGameFlow.client[clientIndex - 1];
  if (!entry || !entry.payload) return;
  const actual = packet.payload.toString("hex");
  const expected = entry.payload.toString("hex");
  console.log(
    `[capture-game:${label}] clientPayloadMatch=${actual === expected ? 1 : 0} actualSize=${packet.payload.length} expectedSize=${
      entry.payload.length
    }`
  );
}

function maybeSendTutorialCutsceneClear(socket, payload) {
  if (!SKIP_TUTORIAL_CUTSCENE) return;
  const req = decodeGameLoadReq(payload);
  if (!req || req.dungeonID !== 1004) return;
  sendServerGamePacket(
    socket,
    CUTSCENE_DUNGEON_CLEAR_ACK,
    buildCutsceneDungeonClearAckPayload(req.dungeonID),
    `tutorial-cutscene-clear dungeonID=${req.dungeonID}`
  );
}

function readCutsceneDungeonReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    return readSignedVarInt(decrypted, 0).value;
  } catch (err) {
    console.log(`[CUTSCENE_DUNGEON_REQ] decode failed: ${err.message}`);
    return 0;
  }
}

function buildCutsceneDungeonStartAckPayload(dungeonId) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildStagePlayData(stageIdForDungeonId(dungeonId))),
  ]);
}

function buildCutsceneDungeonClearAckPayload(dungeonId) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildDungeonClearData(dungeonId)),
    writeNullObject(),
  ]);
}

function buildGameLoadAck(data = {}) {
  const template = getCapturedServerPayloadTemplate(GAME_LOAD_ACK);
  if (!template) {
    console.log("[dynamic-game-load] no captured 804 template; sending null gameData fallback");
    return Buffer.concat([writeSignedVarInt(0), writeNullObject(), writeObjectList([])]);
  }

  const raw = Buffer.from(template);
  try {
    const spans = getGameLoadAckPatchSpans(raw);
    const replacements = [
      { ...spans.gameUID, payload: writeSignedVarLong(BigInt(data.gameUID || makeDynamicGameUid())) },
      { ...spans.gameUnitUIDIndex, payload: writeSignedVarInt(Number(data.gameUnitUIDIndex || nextGameUnitUidIndex(data))) },
    ];
    if (data.patchStageFields !== false) {
      replacements.push(
        { ...spans.dungeonID, payload: writeSignedVarInt(Number(data.dungeonID || 0)) },
        { ...spans.mapID, payload: writeSignedVarInt(Number(data.mapID || mapIdForStageDungeon(data.stageID, data.dungeonID))) }
      );
    }
    replacements.sort((a, b) => b.start - a.start);

    return replacements.reduce(
      (buffer, replacement) => replaceBufferRange(buffer, replacement.start, replacement.end, replacement.payload),
      raw
    );
  } catch (err) {
    console.log(`[dynamic-game-load] template patch failed: ${err.message}; using captured 804 body`);
    return raw;
  }
}

function buildRespawnAck(data = {}) {
  return combatHandler.buildRespawnAck(data);
}

function buildGameSync(data = {}) {
  return combatHandler.buildSync(data);
}

function buildGameSyncPackets(data = {}) {
  return combatHandler.buildGameSyncPackets(data);
}

function continueBattleStateUnits(battleState, delta) {
  return combatHandler.tick(delta, battleState);
}

function buildInitialBattleSync(replay) {
  return combatHandler.buildInitialBattleSync(replay);
}

function buildInitialBattlePackets(replay) {
  return combatHandler.buildInitialBattlePackets(replay);
}

function getCapturedServerPayloadTemplate(packetId) {
  if (!capturedGameFlow || !Array.isArray(capturedGameFlow.server)) return null;
  const entry = capturedGameFlow.server.find((item) => item && item.packetId === packetId && item.payload);
  if (!entry) return null;
  return entry.compressed ? lz4StreamDecompress(entry.payload) : decryptCopy(entry.payload);
}

function getGameLoadAckPatchSpans(raw) {
  let offset = 0;
  const errorCode = readSignedVarInt(raw, offset);
  offset = errorCode.offset;
  if (raw.readUInt8(offset) === 0) throw new Error("captured GAME_LOAD_ACK has null gameData");
  offset += 1;

  const gameUID = readVarLong(raw, offset);
  const gameUIDSpan = { start: offset, end: gameUID.offset };
  offset = gameUID.offset;

  const gameUnitUIDIndex = readVarInt(raw, offset);
  const gameUnitUIDIndexSpan = { start: offset, end: gameUnitUIDIndex.offset };
  offset = gameUnitUIDIndex.offset;

  offset += 1; // m_bLocal
  const gameType = readSignedVarInt(raw, offset);
  offset = gameType.offset;

  const dungeonID = readSignedVarInt(raw, offset);
  const dungeonIDSpan = { start: offset, end: dungeonID.offset };
  offset = dungeonID.offset;

  offset += 1; // m_bBossDungeon
  offset = readSignedVarInt(raw, offset).offset; // m_WarfareID
  offset = readVarLong(raw, offset).offset; // m_RaidUID
  offset += 4; // m_fRespawnCostMinusPercentForTeamA
  offset = readSignedVarInt(raw, offset).offset; // m_TeamASupply
  offset += 4; // m_fTeamAAttackPowerIncRateForWarfare
  offset = skipStringList(raw, offset); // m_lstTeamABuffStrIDListForRaid
  offset += 4; // fExtraRespawnCostAddForA
  offset += 4; // fExtraRespawnCostAddForB
  offset = readSignedVarInt(raw, offset).offset; // m_TeamBLevelAdd
  offset = readSignedVarInt(raw, offset).offset; // m_TeamBLevelFix
  offset += 4; // m_fDoubleCostTime

  const mapID = readSignedVarInt(raw, offset);
  const mapIDSpan = { start: offset, end: mapID.offset };

  return {
    gameUID: gameUIDSpan,
    gameUnitUIDIndex: gameUnitUIDIndexSpan,
    dungeonID: dungeonIDSpan,
    mapID: mapIDSpan,
  };
}

function skipStringList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readString(buffer, offset).offset;
  }
  return offset;
}

function replaceBufferRange(buffer, start, end, replacement) {
  return Buffer.concat([buffer.subarray(0, start), replacement, buffer.subarray(end)]);
}

function makeDynamicGameUid() {
  return BigInt(Date.now()) * 10000n + BigInt(process.pid % 10000);
}

function nextGameUnitUidIndex(data) {
  const values = Array.isArray(data.assignedGameUnitUIDs) ? data.assignedGameUnitUIDs.map(Number) : [];
  return Math.max(18, values.length ? Math.max(...values) + 1 : 18);
}

function mapIdForStageDungeon(stageID, dungeonID) {
  if (Number(stageID) === 11211 || Number(dungeonID) === 1004) return 1064;
  return 1064;
}

function buildGameRespawnAckPayload(unitUID, assistUnit) {
  return combatHandler.buildGameRespawnAckPayload(unitUID, assistUnit);
}

function buildGamePauseAckPayload(isPause, isPauseEvent) {
  return Buffer.concat([writeSignedVarInt(0), writeBool(Boolean(isPause)), writeBool(Boolean(isPauseEvent))]);
}

function buildStagePlayData(stageId) {
  return Buffer.concat([
    writeSignedVarInt(stageId),
    writeSignedVarLong(1n),
    writeSignedVarLong(0n),
    writeSignedVarLong(0n),
    writeInt64LE(dateTimeBinaryNow()),
    writeSignedVarInt(0),
    writeSignedVarLong(1n),
  ]);
}

function stageIdForDungeonId(dungeonId) {
  if (Number(dungeonId) === 1004) return 11211;
  return 0;
}

function buildDungeonClearData(dungeonId) {
  return Buffer.concat([
    writeSignedVarInt(dungeonId),
    writeBool(true),
    writeBool(true),
    writeNullObject(),
    writeBool(false),
    writeNullObject(),
    writeBoolList([]),
    writeNullableObject(buildEmptyRewardData()),
    writeSignedVarInt(0),
  ]);
}

function buildEmptyRewardData() {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeObjectList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeIntList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeIntList([]),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeObjectList([]),
    writeSignedVarLong(0n),
    writeObjectList([]),
    writeObjectList([]),
    writeObjectList([]),
  ]);
}

function decodeGameLoadReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const isDev = decrypted.readUInt8(offset) !== 0;
    offset += 1;
    const selectDeckIndex = decrypted.readUInt8(offset);
    offset += 1;
    const stageID = readSignedVarInt(decrypted, offset);
    offset = stageID.offset;
    const diveStageID = readSignedVarInt(decrypted, offset);
    offset = diveStageID.offset;
    const dungeonID = readSignedVarInt(decrypted, offset);
    offset = dungeonID.offset;
    const palaceID = readSignedVarInt(decrypted, offset);
    offset = palaceID.offset;
    const fierceBossId = readSignedVarInt(decrypted, offset);
    offset = fierceBossId.offset;
    const exploreID = readSignedVarInt(decrypted, offset);
    offset = exploreID.offset;
    const supportingUserUid = readSignedVarLong(decrypted, offset);
    offset = supportingUserUid.offset;
    const hasEventDeckData = decrypted.readUInt8(offset) !== 0;
    offset += 1;
    const rewardMultiply = safeReadSignedVarInt(decrypted, offset);
    return {
      isDev,
      selectDeckIndex,
      stageID: stageID.value,
      diveStageID: diveStageID.value,
      dungeonID: dungeonID.value,
      palaceID: palaceID.value,
      fierceBossId: fierceBossId.value,
      exploreID: exploreID.value,
      supportingUserUid: supportingUserUid.value,
      hasEventDeckData,
      rewardMultiply: rewardMultiply.value,
    };
  } catch (_) {
    return null;
  }
}

function decodeGameRespawnReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const unitUID = readSignedVarLong(decrypted, offset);
    offset = unitUID.offset;
    const assistUnit = decrypted.readUInt8(offset) !== 0;
    offset += 1;
    const respawnPosX = decrypted.readFloatLE(offset);
    offset += 4;
    const gameTime = decrypted.readFloatLE(offset);
    offset += 4;
    return {
      unitUID: unitUID.value.toString(),
      assistUnit,
      respawnPosX,
      gameTime,
      decodedBytes: offset,
    };
  } catch (err) {
    console.log(`[GAME_RESPAWN_REQ] decode failed: ${err.message}`);
    return null;
  }
}

function logGameLoadReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const isDev = decrypted.readUInt8(offset) !== 0;
    offset += 1;
    const selectDeckIndex = decrypted.readUInt8(offset);
    offset += 1;
    const stageID = readSignedVarInt(decrypted, offset);
    offset = stageID.offset;
    const diveStageID = readSignedVarInt(decrypted, offset);
    offset = diveStageID.offset;
    const dungeonID = readSignedVarInt(decrypted, offset);
    offset = dungeonID.offset;
    const palaceID = readSignedVarInt(decrypted, offset);
    offset = palaceID.offset;
    const fierceBossId = readSignedVarInt(decrypted, offset);
    offset = fierceBossId.offset;
    const exploreID = readSignedVarInt(decrypted, offset);
    offset = exploreID.offset;
    const supportingUserUid = readSignedVarLong(decrypted, offset);
    offset = supportingUserUid.offset;
    const hasEventDeckData = decrypted.readUInt8(offset) !== 0;
    offset += 1;
    const rewardMultiply = safeReadSignedVarInt(decrypted, offset);
    console.log(
      `[GAME_LOAD_REQ] isDev=${isDev ? 1 : 0} deck=${selectDeckIndex} stageID=${stageID.value} diveStageID=${
        diveStageID.value
      } dungeonID=${dungeonID.value} palaceID=${palaceID.value} fierceBossId=${fierceBossId.value} exploreID=${
        exploreID.value
      } supportingUserUid=${supportingUserUid.value} eventDeck=${hasEventDeckData ? 1 : 0} rewardMultiply=${
        rewardMultiply.value
      }`
    );
  } catch (err) {
    console.log(`[GAME_LOAD_REQ] decode failed: ${err.message}`);
  }
}

function buildContentsVersionAck(sequence) {
  const payload = Buffer.concat([
    writeSignedVarInt(0),
    writeString(CONTENTS_VERSION),
    writeStringList(CONTENTS_TAGS),
    writeInt64LE(dateTimeBinaryNow()),
    writeInt64LE(0n),
  ]);

  console.log(`[CONTENTS_VERSION_ACK fallback] version=${CONTENTS_VERSION} tags=${CONTENTS_TAGS.length}`);
  return buildPlainPacket(sequence, CONTENTS_VERSION_ACK, payload);
}

function buildLoginAck(sequence, user) {
  const payload = buildLoginLikePayload(user);
  return buildEncryptedPacket(sequence, LOGIN_ACK, payload);
}

function buildCapturedLoginAck(sequence, user) {
  return buildCapturedLoginLikeAck(sequence, LOGIN_ACK, user, "LOGIN_ACK", () => buildLoginAck(sequence, user));
}

function buildCapturedReconnectAck(sequence, user) {
  return buildCapturedLoginLikeAck(sequence, RECONNECT_ACK, user, "RECONNECT_ACK", () =>
    buildEncryptedPacket(sequence, RECONNECT_ACK, buildLoginLikePayload(user))
  );
}

function buildCapturedLoginLikeAck(sequence, packetId, user, label, fallbackBuilder) {
  const template = capturedTcpProfiles.loginAck;
  if (!template) {
    console.log(`[${label} official-template] unavailable; using local fallback`);
    return fallbackBuilder();
  }

  const token =
    nonEmpty(process.env.CS_LOGIN_ACCESS_TOKEN) ||
    nonEmpty(user && user.accessToken) ||
    nonEmpty(lastEffectiveAccessToken) ||
    nonEmpty(lastSteamAccessToken) ||
    nonEmpty(template.accessToken) ||
    "local-access-token";
  lastEffectiveAccessToken = token;
  if (user && token) user.accessToken = token;

  const rawPayload = buildLoginAckRaw({
    errorCode: template.errorCode,
    accessToken: token,
    gameServerIP: GAME_SERVER_IP,
    gameServerPort: GAME_SERVER_PORT,
    contentsVersion: template.contentsVersion,
    contentsTag: template.contentsTag,
    openTag: template.openTag,
  });

  const compressedPayload = lz4StreamWrapUncompressed(rawPayload);
  console.log(
    `[${label} official-template] version=${template.contentsVersion} tags=${template.contentsTag.length} openTags=${template.openTag.length} tokenLen=${token.length} gameServer=${GAME_SERVER_IP}:${GAME_SERVER_PORT} payloadSize=${compressedPayload.length}`
  );
  return buildFramedPacket(sequence, packetId, compressedPayload, true);
}

function buildLoginAckRaw(fields) {
  return Buffer.concat([
    writeSignedVarInt(fields.errorCode || 0),
    writeString(fields.accessToken || ""),
    writeString(fields.gameServerIP || ""),
    writeSignedVarInt(fields.gameServerPort || 0),
    writeString(fields.contentsVersion || ""),
    writeStringList(fields.contentsTag || []),
    writeStringList(fields.openTag || []),
  ]);
}

function buildLoginLikePayload(user) {
  const token =
    nonEmpty(process.env.CS_LOGIN_ACCESS_TOKEN) ||
    nonEmpty(user && user.accessToken) ||
    nonEmpty(lastEffectiveAccessToken) ||
    nonEmpty(lastSteamAccessToken) ||
    "local-access-token";
  lastEffectiveAccessToken = token;
  if (user && token) user.accessToken = token;

  const version = (user && user.contentsVersion) || lastAckContentsVersion || CONTENTS_VERSION;
  const tags = user && user.contentsTags && user.contentsTags.length
    ? user.contentsTags
    : lastAckContentsTags.length
      ? lastAckContentsTags
      : CONTENTS_TAGS;
  const openTags = user && user.openTags ? user.openTags : OPEN_TAGS;

  console.log(
    `[LOGIN-like payload] uid=${user ? user.userUid : "(none)"} tokenLen=${token.length} gameServer=${GAME_SERVER_IP}:${GAME_SERVER_PORT} version=${version} tags=${tags.length} openTags=${openTags.length}`
  );

  return Buffer.concat([
    writeSignedVarInt(0),
    writeString(token),
    writeString(GAME_SERVER_IP),
    writeSignedVarInt(GAME_SERVER_PORT),
    writeString(version),
    writeStringList(tags),
    writeStringList(openTags),
  ]);
}

function buildMinimalJoinLobbyPayload(user) {
  const now = writeInt64LE(dateTimeBinaryNow());
  const userUid = BigInt(user.userUid || "1000000001");
  const friendCode = BigInt(user.friendCode || "10000001");
  const nickname = user.nickname || "LocalAdmin";

  console.log(
    `[JOIN_LOBBY_ACK fallback] uid=${userUid} friendCode=${friendCode} nickname=${JSON.stringify(
      nickname
    )} level=${user.level || 1} reconnectKey=${JSON.stringify(user.reconnectKey || "")}`
  );

  return Buffer.concat([
    writeSignedVarInt(0), // errorCode
    writeSignedVarLong(friendCode),
    writeNullableObject(buildMinimalUserData(userUid, friendCode, nickname)),
    writeNullObject(), // lobbyData
    writeNullObject(), // gameData
    writeNullObject(), // warfareGameData
    now, // utcTime
    writeInt64LE(0n), // utcOffset
    now, // lastCreditSupplyTakeTime
    now, // lastEterniumSupplyTakeTime
    writeDoubleLE(0),
    writeObjectList([]), // shopChainTabNestResetList
    writeNullObject(), // pvpBanResult
    writeNullObject(), // asyncPvpState
    writeNullObject(), // leaguePvpState
    now, // pvpPointChargeTime
    writeBool(false), // rankPvpOpen
    writeBool(false), // leaguePvpOpen
    writeObjectList([]), // ReturningUserStates
    writeObjectList([]), // contractState
    writeObjectList([]), // contractBonusState
    writeNullObject(), // selectableContractState
    writeObjectList([]), // stagePlayDataList
    writeNullObject(), // eventInfo
    writeString(user.reconnectKey || ""),
    writeNullObject(), // zlongUserData
    writeNullObject(), // backGroundInfo
    writeNullObject(), // privateGuildData
    now, // blockMuteEndDate
    writeBool(false), // marketReviewCompletion
    writeBool(false), // fierceDailyRewardReceived
    writeNullObject(), // guildDungeonRewardInfo
    writeNullObject(), // equipTuningCandidate
    writeNullObject(), // leaguePvpRoomData
    writeObjectList([]), // leaguePvpHistories
    writeObjectList([]), // privatePvpHistories
    writeNullObject(), // officeState
    writeNullObject(), // kakaoMissionData
    writeIntList(user.unlockedStageIds || []),
    writeObjectList([]), // phaseClearDataList
    writeNullObject(), // phaseModeState
    writeObjectList([]), // serverKillCountDataList
    writeObjectList([]), // killCountDataList
    writeObjectList([]), // completedUnitMissions
    writeObjectList([]), // rewardEnableUnitMissions
    writeNullObject(), // pvpCastingVoteData
    writeObjectList([]), // intervalData
    writeObjectList([]), // consumerPackages
    writeNullObject(), // npcPvpData
    writeNullObject(), // trimIntervalData
    writeObjectList([]), // trimClearList
    writeNullObject(), // shipSlotCandidate
    writeNullObject(), // trimModeState
    writeBool(false), // enableAccountLink
    writeNullObject(), // eventCollectionInfo
    writeNullObject(), // userProfileData
    writeNullObject(), // lastPlayInfo
    writeNullObject(), // eventPvpState
    writeObjectList([]), // customPickupContracts
    writeNullObject(), // potentialOptionCandidate
    writeNullObject(), // pvpDraftVoteData
    writeNullObject(), // supportUnitProfileData
    writeBool(false), // hasRemainReward
  ]);
}

function buildMinimalUserData(userUid, friendCode, nickname) {
  const now = dateTimeBinaryNow();
  return Buffer.concat([
    writeSignedVarLong(userUid),
    writeSignedVarLong(friendCode),
    writeString(nickname),
    writeSignedVarInt(1), // level
    writeSignedVarInt(0), // level exp
    writeSignedVarInt(1), // NORMAL_USER
    writeNullableObject(Buffer.concat([writeInt64LE(now), writeInt64LE(now), writeInt64LE(0n)])), // NKMUserDateData
    writeNullableObject(buildMinimalInventoryData()),
    writeNullableObject(buildMinimalArmyData()),
    writeNullableObject(buildMinimalUserOption()),
    writeObjectMapInt([]), // m_dicNKMDungeonClearData
    writeNullObject(), // m_WorldmapData
    writeObjectMapInt([]), // m_dicNKMWarfareClearData
    writeNullableObject(buildMinimalShopData()),
    writeNullableObject(buildMinimalMissionData()),
    writeObjectMapInt([]), // m_dicNKMCounterCaseData
    writeNullObject(), // m_CraftData
    writeObjectMapInt([]), // m_dicEpisodeCompleteData
    writeNullObject(), // m_PvpData
    writeNullObject(), // m_SyncPvpHistory
    writeNullObject(), // m_AsyncPvpHistory
    writeNullObject(), // m_EventPvpHistory
    writeNullObject(), // m_DiveGameData
    writeObjectList([]), // m_DiveClearData
    writeObjectList([]), // m_DiveHistoryData
    writeNullObject(), // m_AttendanceData
    writeSignedVarInt(0), // UserState
    writeObjectList([]), // m_companyBuffDataList
    writeNullObject(), // m_ShadowPalace
    writeNullObject(), // backGroundInfo
    writeNullObject(), // m_RecallHistoryData
    writeNullObject(), // m_BirthDayData
    writeNullObject(), // m_JukeboxData
  ]);
}

function buildMinimalInventoryData() {
  return Buffer.concat([
    writeSignedVarInt(300), // m_MaxItemEqipCount
    writeObjectMapInt([]), // m_ItemMiscData
    writeObjectMapLong([]), // m_ItemEquipData
    writeIntList([]), // m_ItemSkinData
    writeObjectMapInt([]), // m_dicMiscCollectionData
  ]);
}

function buildMinimalArmyData() {
  return Buffer.concat([
    writeSignedVarInt(300), // m_MaxUnitCount
    writeSignedVarInt(200), // m_MaxShipCount
    writeSignedVarInt(100), // m_MaxOperatorCount
    writeSignedVarInt(100), // m_MaxTrophyCount
    writeObjectList([]), // deckSets
    writeObjectMapLong([]), // ships
    writeObjectMapLong([]), // units
    writeObjectMapLong([]), // operators
    writeObjectMapLong([]), // trophies
    writeSignedVarInt(0), // illustrate unit id
    writeObjectMapInt([]), // team collection
  ]);
}

function buildMinimalUserOption() {
  return Buffer.concat([
    writeBool(false), // m_bAutoRespawn
    writeSignedVarInt(0), // ActionCameraType
    writeBool(true), // m_bTrackCamera
    writeBool(true), // m_bViewSkillCutIn
    writeBool(false), // m_bAutoWarfare
    writeBool(true), // m_bAutoWarfareRepair
    writeBool(false), // m_bPlayCutscene
    writeBool(false), // m_bAutoDive
    writeSignedVarInt(0), // speed
    writeSignedVarInt(0), // auto skill
    writeBool(true), // auto sync friend deck
    writeSignedVarInt(0), // default pvp auto respawn
    writeSignedVarInt(0), // private pvp invitation
  ]);
}

function buildMinimalShopData() {
  return Buffer.concat([
    writeObjectMapInt([]), // histories
    writeNullObject(), // randomShop
    writeObjectMapInt([]), // subscriptions
  ]);
}

function buildMinimalMissionData() {
  return Buffer.concat([
    writeObjectMapInt([]), // dicRefreshInfo
    writeObjectMapInt([]), // dicMissions
    writeSignedVarLong(0n), // achievePoint
  ]);
}

function loadUserDb(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return normalizeUserDb({});
    }
    return normalizeUserDb(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    console.log(`[user-db] failed to load ${filePath}: ${err.message}; starting empty`);
    return normalizeUserDb({});
  }
}

function loadGameplayUnitStats(filePath) {
  const result = { byId: new Map(), byStrId: new Map(), loaded: false };
  try {
    if (!filePath || !fs.existsSync(filePath)) return result;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const entries = parsed && parsed.byId && typeof parsed.byId === "object" ? Object.values(parsed.byId) : [];
    for (const entry of entries) {
      const stats = extractGameplayUnitStats(entry);
      if (!stats) continue;
      if (stats.unitID != null) result.byId.set(String(stats.unitID), stats);
      if (stats.unitStrID) result.byStrId.set(String(stats.unitStrID), stats);
    }
    result.loaded = result.byId.size > 0 || result.byStrId.size > 0;
  } catch (err) {
    console.log(`[gameplay-tables] unit stats load failed: ${err.message}`);
  }
  return result;
}

function extractGameplayUnitStats(entry) {
  if (!entry || typeof entry !== "object") return null;
  const statRoot = entry._stat && entry._stat.m_StatData && entry._stat.m_StatData.m_Stat;
  if (!statRoot || typeof statRoot !== "object") return null;
  const hp = finiteNumber(statRoot.NST_HP);
  const atk = finiteNumber(statRoot.NST_ATK);
  const moveRate = finiteNumber(statRoot.NST_MOVE_SPEED_RATE);
  const attackSpeedRate = finiteNumber(statRoot.NST_ATTACK_SPEED_RATE);
  return {
    unitID: entry.m_UnitID == null ? null : Number(entry.m_UnitID),
    unitStrID: entry.m_UnitStrID || entry._stat.m_UnitStrID || "",
    hp,
    atk,
    damage: atk > 0 ? Math.max(DEFAULT_COMBAT_STATS.damage, Math.round(atk * 0.2)) : DEFAULT_COMBAT_STATS.damage,
    attackRange: DEFAULT_COMBAT_STATS.attackRange,
    moveSpeed: DEFAULT_COMBAT_STATS.moveSpeed * (1 + clamp(moveRate || 0, -0.5, 1.5)),
    attackCooldown: Math.max(0.45, DEFAULT_COMBAT_STATS.attackCooldown / (1 + clamp(attackSpeedRate || 0, -0.5, 1.5))),
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeUserDb(db) {
  db.schemaVersion = 1;
  db.nextUserUid = String(db.nextUserUid || "1000000001");
  db.nextFriendCode = String(db.nextFriendCode || "10000001");
  db.users = db.users && typeof db.users === "object" ? db.users : {};
  db.usersBySteamAccountId =
    db.usersBySteamAccountId && typeof db.usersBySteamAccountId === "object" ? db.usersBySteamAccountId : {};
  db.accessTokens = db.accessTokens && typeof db.accessTokens === "object" ? db.accessTokens : {};
  db.reconnectKeys = db.reconnectKeys && typeof db.reconnectKeys === "object" ? db.reconnectKeys : {};

  for (const user of Object.values(db.users)) {
    if (user.steamAccountId) db.usersBySteamAccountId[user.steamAccountId] = user.userUid;
    if (user.accessToken) db.accessTokens[user.accessToken] = user.userUid;
    if (user.reconnectKey) db.reconnectKeys[user.reconnectKey] = user.userUid;
  }
  return db;
}

function saveUserDb() {
  fs.mkdirSync(path.dirname(USER_DB_PATH), { recursive: true });
  const tmpPath = `${USER_DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(userDb, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, USER_DB_PATH);
}

function getOrCreateUserForSteam(loginReq) {
  const steamAccountId = nonEmpty(loginReq.accountId) || `device:${loginReq.deviceUid || "unknown"}`;
  const existingUid = userDb.usersBySteamAccountId[steamAccountId];
  if (existingUid && userDb.users[existingUid]) {
    const user = userDb.users[existingUid];
    user.deviceUid = loginReq.deviceUid || user.deviceUid || "";
    user.lastLoginAt = new Date().toISOString();
    return ensureUserDefaults(user);
  }

  const userUid = userDb.nextUserUid;
  const friendCode = userDb.nextFriendCode;
  userDb.nextUserUid = String(BigInt(userDb.nextUserUid) + 1n);
  userDb.nextFriendCode = String(BigInt(userDb.nextFriendCode) + 1n);

  const user = ensureUserDefaults({
    userUid,
    friendCode,
    steamAccountId,
    deviceUid: loginReq.deviceUid || "",
    nickname: process.env.CS_DEFAULT_NICKNAME || "LocalAdmin",
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  });

  userDb.users[userUid] = user;
  userDb.usersBySteamAccountId[steamAccountId] = userUid;
  return user;
}

function ensureUserDefaults(user) {
  user.level = Number(user.level || 1);
  user.exp = String(user.exp || "0");
  user.authLevel = Number(user.authLevel || 1);
  user.contentsVersion = user.contentsVersion || CONTENTS_VERSION;
  user.contentsTags = Array.isArray(user.contentsTags) && user.contentsTags.length ? user.contentsTags : CONTENTS_TAGS.slice();
  user.openTags = Array.isArray(user.openTags) ? user.openTags : OPEN_TAGS.slice();
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  user.inventory = user.inventory && typeof user.inventory === "object" ? user.inventory : { misc: {}, equips: {} };
  user.army = user.army && typeof user.army === "object" ? user.army : { units: {}, ships: {}, operators: {}, decks: [] };
  user.tutorial = user.tutorial && typeof user.tutorial === "object"
    ? user.tutorial
    : { enabled: true, firstStageId: 11211, firstDungeonId: 1004 };
  return user;
}

function issueUserTokens(user, preferredAccessToken) {
  removeUserTokenIndexes(user);
  const envToken = nonEmpty(process.env.CS_LOGIN_ACCESS_TOKEN);
  const preferredToken = USE_STEAM_TOKEN_AS_ACCESS_TOKEN ? nonEmpty(preferredAccessToken) : "";
  const existingToken = nonEmpty(user.accessToken && user.accessToken.length >= 32 ? user.accessToken : "");
  user.accessToken = envToken || existingToken || preferredToken || makeAccessToken();
  user.reconnectKey = nonEmpty(user.reconnectKey) || makeToken("rck");
  user.lastTokenIssuedAt = new Date().toISOString();
  userDb.accessTokens[user.accessToken] = user.userUid;
  userDb.reconnectKeys[user.reconnectKey] = user.userUid;
}

function removeUserTokenIndexes(user) {
  if (user.accessToken) delete userDb.accessTokens[user.accessToken];
  if (user.reconnectKey) delete userDb.reconnectKeys[user.reconnectKey];
}

function findUserByAccessToken(token) {
  const userUid = token ? userDb.accessTokens[token] : "";
  return userUid && userDb.users[userUid] ? ensureUserDefaults(userDb.users[userUid]) : null;
}

function findUserByReconnectKey(reconnectKey) {
  const userUid = reconnectKey ? userDb.reconnectKeys[reconnectKey] : "";
  return userUid && userDb.users[userUid] ? ensureUserDefaults(userDb.users[userUid]) : null;
}

function createEphemeralUser() {
  return ensureUserDefaults({
    userUid: "1000000001",
    friendCode: "10000001",
    nickname: "LocalAdmin",
    accessToken: lastEffectiveAccessToken || "local-access-token",
    reconnectKey: "",
  });
}

function makeToken(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
}

function makeAccessToken() {
  return crypto.randomBytes(16).toString("hex");
}

function parsePacket(raw) {
  if (raw.readUInt32LE(0) !== HEAD_FENCE) throw new Error("invalid head fence");
  const totalLength = raw.readInt32LE(4);
  if (raw.length < totalLength) throw new Error("truncated packet");

  let offset = 8;
  const sequenceRaw = readVarLong(raw, offset);
  offset = sequenceRaw.offset;
  const packetIdRaw = readVarInt(raw, offset);
  offset = packetIdRaw.offset;
  const compressed = raw.readUInt8(offset) !== 0;
  offset += 1;
  const payloadSizeRaw = readSignedVarInt(raw, offset);
  offset = payloadSizeRaw.offset;

  const payloadStart = offset;
  const payloadEnd = payloadStart + payloadSizeRaw.value;
  const tailOffset = totalLength - 4;
  const tail = raw.readUInt32LE(tailOffset);
  if (tail !== TAIL_FENCE) throw new Error(`invalid tail fence 0x${tail.toString(16)}`);
  if (payloadEnd > tailOffset) throw new Error("payload overruns packet");

  return {
    raw,
    totalLength,
    sequence: zigZagDecode64(sequenceRaw.value),
    packetId: packetIdRaw.value,
    compressed,
    payloadSize: payloadSizeRaw.value,
    payload: raw.subarray(payloadStart, payloadEnd),
  };
}

function buildPlainPacket(sequence, packetId, payload) {
  return buildFramedPacket(sequence, packetId, payload, false);
}

function buildEncryptedPacket(sequence, packetId, payload) {
  const encrypted = Buffer.from(payload);
  encryptPayload(encrypted);
  return buildFramedPacket(sequence, packetId, encrypted, false);
}

function buildFramedPacket(sequence, packetId, payload, compressed) {
  const sequenceBytes = writeVarLong(sequence);
  const packetIdBytes = writeVarInt(packetId);
  const compressedBytes = Buffer.from([compressed ? 1 : 0]);
  const payloadSizeBytes = writeSignedVarInt(payload.length);
  const totalLength =
    4 +
    4 +
    sequenceBytes.length +
    packetIdBytes.length +
    compressedBytes.length +
    payloadSizeBytes.length +
    payload.length +
    4;

  const packet = Buffer.alloc(totalLength);
  let offset = 0;
  packet.writeUInt32LE(HEAD_FENCE, offset);
  offset += 4;
  packet.writeInt32LE(totalLength, offset);
  offset += 4;
  offset = copy(sequenceBytes, packet, offset);
  offset = copy(packetIdBytes, packet, offset);
  offset = copy(compressedBytes, packet, offset);
  offset = copy(payloadSizeBytes, packet, offset);
  offset = copy(payload, packet, offset);
  packet.writeUInt32LE(TAIL_FENCE, offset);
  return packet;
}

function decodeSteamLoginReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const protocolVersion = readSignedVarInt(decrypted, offset);
    offset = protocolVersion.offset;
    const deviceUid = readString(decrypted, offset);
    offset = deviceUid.offset;
    const accountId = readString(decrypted, offset);
    offset = accountId.offset;
    const accessToken = readString(decrypted, offset);
    offset = accessToken.offset;

    lastSteamAccessToken = accessToken.value || "";
    if (lastSteamAccessToken) lastEffectiveAccessToken = lastSteamAccessToken;

    console.log(
      `[STEAM_LOGIN_REQ] protocolVersion=${protocolVersion.value} accountId=${JSON.stringify(accountId.value)} tokenLen=${lastSteamAccessToken.length}`
    );
    return {
      protocolVersion: protocolVersion.value,
      deviceUid: deviceUid.value || "",
      accountId: accountId.value || "",
      accessToken: accessToken.value || "",
    };
  } catch (err) {
    console.log(`[STEAM_LOGIN_REQ] decode failed: ${err.message}`);
    return {
      protocolVersion: 0,
      deviceUid: "",
      accountId: "",
      accessToken: "",
    };
  }
}

function decodeJoinLobbyReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const protocolVersion = readSignedVarInt(decrypted, offset);
    offset = protocolVersion.offset;
    const accessToken = readString(decrypted, offset);
    console.log(
      `[JOIN_LOBBY_REQ] protocolVersion=${protocolVersion.value} tokenLen=${accessToken.value ? accessToken.value.length : 0}`
    );
    return {
      protocolVersion: protocolVersion.value,
      accessToken: accessToken.value || "",
    };
  } catch (err) {
    console.log(`[JOIN_LOBBY_REQ] decode failed: ${err.message}`);
    return {
      protocolVersion: 0,
      accessToken: "",
    };
  }
}

function loadCapturedTcpResponses(captureDir) {
  const manifestPath = path.join(captureDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return new Map();

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const responses = new Map();
    for (const [packetId, entry] of Object.entries(manifest)) {
      const payloadPath = path.join(captureDir, entry.payloadFile);
      if (!fs.existsSync(payloadPath)) continue;
      const rawPath = entry.rawFile ? path.join(captureDir, entry.rawFile) : "";
      responses.set(Number(packetId), {
        sequence: Number(entry.sequence || 0),
        compressed: entry.compressed === true,
        payload: fs.readFileSync(payloadPath),
        raw: rawPath && fs.existsSync(rawPath) ? fs.readFileSync(rawPath) : null,
      });
    }
    return responses;
  } catch (err) {
    console.log(`[capture-replay] load failed: ${err.message}`);
    return new Map();
  }
}

function buildCapturedTcpProfiles(responses) {
  return {
    contentsVersionAck: parseCapturedContentsVersionAck(responses.get(CONTENTS_VERSION_ACK)),
    loginAck: parseCapturedLoginAck(responses.get(LOGIN_ACK)),
  };
}

function parseCapturedContentsVersionAck(entry) {
  if (!entry) return null;
  try {
    const raw = decodeCapturedPayload(entry);
    let offset = 0;
    const errorCode = readSignedVarInt(raw, offset);
    offset = errorCode.offset;
    const contentsVersion = readString(raw, offset);
    offset = contentsVersion.offset;
    const contentsTag = readStringList(raw, offset);
    offset = contentsTag.offset;
    return {
      errorCode: errorCode.value,
      contentsVersion: contentsVersion.value || "",
      contentsTag: contentsTag.value,
      rawPayload: raw,
    };
  } catch (err) {
    console.log(`[capture-replay] failed to parse official ${CONTENTS_VERSION_ACK}: ${err.message}`);
    return null;
  }
}

function parseCapturedLoginAck(entry) {
  if (!entry) return null;
  try {
    const raw = decodeCapturedPayload(entry);
    let offset = 0;
    const errorCode = readSignedVarInt(raw, offset);
    offset = errorCode.offset;
    const accessToken = readString(raw, offset);
    offset = accessToken.offset;
    const gameServerIP = readString(raw, offset);
    offset = gameServerIP.offset;
    const gameServerPort = readSignedVarInt(raw, offset);
    offset = gameServerPort.offset;
    const contentsVersion = readString(raw, offset);
    offset = contentsVersion.offset;
    const contentsTag = readStringList(raw, offset);
    offset = contentsTag.offset;
    const openTag = readStringList(raw, offset);
    offset = openTag.offset;
    return {
      errorCode: errorCode.value,
      accessToken: accessToken.value || "",
      gameServerIP: gameServerIP.value || "",
      gameServerPort: gameServerPort.value || 0,
      contentsVersion: contentsVersion.value || "",
      contentsTag: contentsTag.value,
      openTag: openTag.value,
      rawPayload: raw,
    };
  } catch (err) {
    console.log(`[capture-replay] failed to parse official ${LOGIN_ACK}: ${err.message}`);
    return null;
  }
}

function decodeCapturedPayload(entry) {
  if (entry.compressed) return lz4StreamDecompress(entry.payload);
  return decryptCopy(entry.payload);
}

function lz4StreamDecompress(payload) {
  let offset = 0;
  const chunks = [];
  while (offset < payload.length) {
    const flags = readVarInt(payload, offset);
    offset = flags.offset;
    const outputLength = readVarInt(payload, offset);
    offset = outputLength.offset;
    const compressed = (flags.value & 1) !== 0;
    let inputLength = outputLength.value;
    if (compressed) {
      const rawInputLength = readVarInt(payload, offset);
      offset = rawInputLength.offset;
      inputLength = rawInputLength.value;
    }
    const block = payload.subarray(offset, offset + inputLength);
    offset += inputLength;
    chunks.push(compressed ? lz4BlockDecode(block, outputLength.value) : Buffer.from(block));
  }
  return Buffer.concat(chunks);
}

function lz4StreamWrapUncompressed(rawPayload) {
  return Buffer.concat([writeVarInt(0), writeVarInt(rawPayload.length), rawPayload]);
}

function lz4BlockDecode(input, outputLength) {
  const output = Buffer.alloc(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;

  while (inputOffset < input.length) {
    const token = input[inputOffset++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let value;
      do {
        value = input[inputOffset++];
        literalLength += value;
      } while (value === 255);
    }

    input.copy(output, outputOffset, inputOffset, inputOffset + literalLength);
    inputOffset += literalLength;
    outputOffset += literalLength;
    if (inputOffset >= input.length) break;

    const matchOffset = input[inputOffset] | (input[inputOffset + 1] << 8);
    inputOffset += 2;
    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let value;
      do {
        value = input[inputOffset++];
        matchLength += value;
      } while (value === 255);
    }
    matchLength += 4;

    for (let index = 0; index < matchLength; index += 1) {
      output[outputOffset + index] = output[outputOffset - matchOffset + index];
    }
    outputOffset += matchLength;
  }

  if (outputOffset !== outputLength) {
    throw new Error(`lz4 output length mismatch: expected ${outputLength}, decoded ${outputOffset}`);
  }
  return output;
}

function loadCapturedGameFlow(flowDir) {
  const manifestPath = path.join(flowDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const hydrate = (entry) => {
      const rawPath = path.join(flowDir, entry.rawFile);
      const payloadPath = path.join(flowDir, entry.payloadFile);
      return {
        ...entry,
        raw: fs.existsSync(rawPath) ? fs.readFileSync(rawPath) : null,
        payload: fs.existsSync(payloadPath) ? fs.readFileSync(payloadPath) : null,
        sequence: entry.sequence || entry.seq,
      };
    };
    const server = (manifest.server || []).map(hydrate);
    const client = (manifest.client || []).map(hydrate);
    return { server, client };
  } catch (err) {
    console.log(`[capture-game] load failed: ${err.message}`);
    return null;
  }
}

function buildCapturedCombatReplayEntries(flow) {
  if (!flow || !Array.isArray(flow.server)) return [];
  return flow.server
    .map((entry, index) => ({ entry, index: index + 1 }))
    .filter(
      ({ entry, index }) =>
        index >= OFFICIAL_COMBAT_REPLAY_START_INDEX &&
        entry &&
        entry.packetId === NPT_GAME_SYNC_DATA_PACK_NOT &&
        entry.raw &&
        entry.payload
    );
}

function loadCapturedFlowMirror(flowDir) {
  const manifestPath = path.join(flowDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const byPath = new Map();
    for (const entry of manifest) {
      if (!entry || entry.method !== "GET" || !entry.path || !entry.bodyFile) continue;
      byPath.set(entry.path, { ...entry, bodyPath: path.join(flowDir, entry.bodyFile) });
    }
    return { byPath };
  } catch (err) {
    console.log(`[mirror] manifest load failed: ${err.message}`);
    return null;
  }
}

function serveCapturedFlow(req, res, mirror) {
  const requestUrl = new URL(req.url || "/", MIRROR_PUBLIC_BASE_URL);
  const entry = mirror.byPath.get(requestUrl.pathname);
  if (!entry) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`No captured response for ${requestUrl.pathname}\n`);
    console.log(`[mirror] MISS ${requestUrl.pathname}`);
    return;
  }

  try {
    let body = fs.readFileSync(entry.bodyPath);
    const headers = responseHeaders(entry, body.length);
    if (REWRITE_CAPTURED_SERVER_INFO && requestUrl.pathname.endsWith("/ServerInfo_V2.json")) {
      body = rewriteServerInfo(body);
      headers["Content-Length"] = body.length;
    }
    res.writeHead(entry.statusCode || 200, headers);
    res.end(body);
    console.log(`[mirror] HIT ${requestUrl.pathname} ${body.length}b`);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`Failed to serve captured response: ${err.message}\n`);
  }
}

function responseHeaders(entry, bodyLength) {
  const headers = {};
  for (const [name, value] of Object.entries(entry.headers || {})) {
    const lower = name.toLowerCase();
    if (["content-encoding", "transfer-encoding", "connection", "content-length", "alt-svc"].includes(lower)) {
      continue;
    }
    headers[name] = value;
  }
  headers["Content-Length"] = bodyLength;
  headers["Cache-Control"] = "no-store";
  if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return headers;
}

function rewriteServerInfo(body) {
  const config = JSON.parse(body.toString("utf8"));
  if (config.server && config.server.Global) {
    config.server.Global.ip = GAME_SERVER_IP;
    config.server.Global.port = GAME_SERVER_PORT;
  }
  config.cdn = `${MIRROR_PUBLIC_BASE_URL}/patchfiles/`;
  return Buffer.from(JSON.stringify(config, null, 2), "utf8");
}

function parseTags(raw) {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseGameUnitGroups(raw) {
  return String(raw || "")
    .split(";")
    .map((group) =>
      group
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
    .filter((group) => group.length > 0);
}

function findDefaultCounterSideManagedDir() {
  const candidates = [
    path.join("C:", "Main", "Gaming", "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "Assembly-CSharp.dll"))) return candidate;
  }
  return "";
}

function findDefaultDotnetRuntime() {
  if (process.platform === "win32") {
    const x64Dotnet = path.join(process.env.ProgramFiles || "C:\\Program Files", "dotnet", "x64", "dotnet.exe");
    if (fs.existsSync(x64Dotnet)) return x64Dotnet;
  }
  return "dotnet";
}

function findDefaultGameplayTablesDir() {
  const candidates = [
    path.join(__dirname, "gameplay-tables"),
    path.join(__dirname, "gameplay-tables-decompiled"),
    path.join(__dirname, "gameplay-tables-json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "StreamingAssets"))) return candidate;
  }
  return "";
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function decryptCopy(payload) {
  const copy = Buffer.from(payload);
  encryptPayload(copy);
  return copy;
}

function encryptPayload(buffer) {
  let offset = 0;
  let maskIndex = 0;
  while (offset < buffer.length) {
    const mask = CRYPTO_MASKS[maskIndex];
    if (buffer.length - offset >= 8) {
      const value = buffer.readBigUInt64LE(offset) ^ mask;
      buffer.writeBigUInt64LE(value, offset);
      offset += 8;
    } else {
      const key = Number(mask & 0xffn);
      while (offset < buffer.length) {
        buffer[offset] ^= key;
        offset += 1;
      }
    }
    maskIndex = (maskIndex + 1) % CRYPTO_MASKS.length;
  }
}

function writeString(value) {
  if (value == null) return writeSignedVarInt(-1);
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.concat([writeSignedVarInt(bytes.length), bytes]);
}

function readString(buffer, offset) {
  const length = readSignedVarInt(buffer, offset);
  offset = length.offset;
  if (length.value === -1) return { value: "", offset };
  const value = buffer.subarray(offset, offset + length.value).toString("utf8");
  return { value, offset: offset + length.value };
}

function safeReadString(buffer, offset) {
  try {
    return readString(buffer, offset);
  } catch (_) {
    return { value: "", offset };
  }
}

function writeStringList(values) {
  return Buffer.concat([writeVarInt(values.length), ...values.map(writeString)]);
}

function readStringList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const item = readString(buffer, offset);
    offset = item.offset;
    values.push(item.value || "");
  }
  return { value: values, offset };
}

function writeObjectList(values) {
  return Buffer.concat([writeVarInt(values.length), ...values]);
}

function writeObjectMapLong(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, payload]) => [writeSignedVarLong(key), writeNullableObject(payload)]),
  ]);
}

function writeObjectMapInt(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, payload]) => [writeSignedVarInt(key), writeNullableObject(payload)]),
  ]);
}

function writeObjectMapShort(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, payload]) => [writeSignedVarInt(key), writeNullableObject(payload)]),
  ]);
}

function writeStringIntMap(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, value]) => [writeString(key), writeSignedVarInt(value)]),
  ]);
}

function writeIntList(values) {
  return Buffer.concat([writeVarInt(values.length), ...values.map(writeSignedVarInt)]);
}

function writeBoolList(values) {
  return Buffer.concat([writeVarInt(values.length), ...values.map(writeBool)]);
}

function writeNullableObject(payload) {
  return Buffer.concat([writeBool(true), payload]);
}

function writeNullObject() {
  return writeBool(false);
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
  buffer.writeBigInt64LE(BigInt(value), 0);
  return buffer;
}

function writeDoubleLE(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(Number(value), 0);
  return buffer;
}

function writeFloatLE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(Number(value), 0);
  return buffer;
}

function writeHalfFloat(value) {
  return writeVarInt(Math.max(0, Math.trunc(Number(value || 0) * 100)));
}

function floatToHalf(value) {
  const f = Number(value || 0);
  if (!Number.isFinite(f) || f === 0) return 0;
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = Math.max(-50000, Math.min(50000, f));
  const bits = intView[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | ((mantissa + 0x1000) >>> 13);
}

function dateTimeBinaryNow() {
  const ticks = BigInt(Date.now()) * 10000n + 621355968000000000n;
  return ticks | 0x4000000000000000n;
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  while (shift < 32) {
    const b = buffer.readUInt8(offset++);
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result >>> 0, offset };
    shift += 7;
  }
  throw new Error("malformed varint32");
}

function readVarLong(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  while (shift < 64n) {
    const b = buffer.readUInt8(offset++);
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, offset };
    shift += 7n;
  }
  throw new Error("malformed varint64");
}

function readSignedVarInt(buffer, offset) {
  const raw = readVarInt(buffer, offset);
  return { value: zigZagDecode32(raw.value), offset: raw.offset };
}

function safeReadSignedVarInt(buffer, offset) {
  try {
    return readSignedVarInt(buffer, offset);
  } catch (_) {
    return { value: 0, offset };
  }
}

function safeReadSignedVarLong(buffer, offset) {
  try {
    return readSignedVarLong(buffer, offset);
  } catch (_) {
    return { value: 0n, offset };
  }
}

function readSignedVarLong(buffer, offset) {
  const raw = readVarLong(buffer, offset);
  return { value: zigZagDecode64(raw.value), offset: raw.offset };
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
  return writeVarInt(zigZagEncode32(value));
}

function writeVarLong(value) {
  let current = zigZagEncode64(BigInt(value));
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

function zigZagEncode32(value) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function zigZagDecode32(value) {
  return (value >>> 1) ^ -(value & 1);
}

function zigZagEncode64(value) {
  return (value << 1n) ^ (value >> 63n);
}

function zigZagDecode64(value) {
  return (value >> 1n) ^ -(value & 1n);
}

function copy(source, target, offset) {
  source.copy(target, offset);
  return offset + source.length;
}

function printHex(buffer) {
  console.log(buffer.toString("hex").replace(/(.{2})/g, "$1 ").trim());
}
