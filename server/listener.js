const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { loadPacketHandlers } = require("./packetHandlerLoader");
const { createUserManager } = require("./userManager");
const ROOT_DIR = path.resolve(__dirname, "..");
const { findGameplayTableFile, readGameplayTableRecords } = require("../modules/gameplay-jsons");
const {
  createCombatHandler,
  buildCapturedRespawnUnitPools: buildCombatCapturedRespawnUnitPools,
} = require("../combat-handler");
const {
  isTutorialDungeonId,
  isTutorialStageId,
  mapIdForStageDungeon: tutorialMapIdForStageDungeon,
  stageIdForDungeonId: tutorialStageIdForDungeonId,
  TUTORIAL_STAGE_CHAIN,
} = require("../stages/tutorialStage");
const {
  MAIN_STORY_STAGE_CHAIN,
  getMainStoryStageByStageId,
  isMainStoryStageId,
  isMainStoryDungeonId,
  isMainStoryCutsceneDungeonId,
  mapIdForStageDungeon: mainStoryMapIdForStageDungeon,
  stageIdForDungeonId: mainStoryStageIdForDungeonId,
  ensureMainStoryState,
  recordMainStoryDungeonClearForUser,
  resetMainStoryPostTutorialProgress,
  getStoryOpenTags,
} = require("../stages/mainStoryStage");
const {
  COMMON_RESOURCE_ITEM_IDS,
  DEFAULT_LOCAL_SHOP_BALANCE,
  RESOURCE_ITEM_IDS,
  ensureInventory,
  getMiscItems,
  getSkinIds,
  removeDebugSeededCommonResources,
  seedShopCurrency,
  spendMiscItem,
  toBigInt,
} = require("../modules/inventory");
const {
  ensureArmy,
  getArmyShips,
  getArmyTrophies,
  getArmyUnits,
  getArmyOperators,
  getArmyDeckSets,
  ensureDefaultLineup,
  getArmyUnitByUid,
  getArmyOperatorByUid,
  addUnitExp,
  addOperatorExp,
} = require("../modules/unit");
const {
  buildUnitData: buildSerializedUnitData,
  buildOperatorData: buildSerializedOperatorData,
  buildContractStateData: buildSerializedContractStateData,
  buildContractBonusStateData: buildSerializedContractBonusStateData,
  buildEquipItemData: buildSerializedEquipItemData,
  buildDeckIndexData: buildSerializedDeckIndexData,
  buildDeckData: buildSerializedDeckData,
  buildRewardData: buildSerializedRewardData,
} = require("../modules/packet-codec");
const { getEquipItems } = require("../modules/equipment");
const {
  ensureAccountProgress,
  grantStageClearExp,
  completeMission: completeAccountMission,
  buildMissionDataEntries: buildAccountMissionDataEntries,
  getAchievePoint,
  recordMissionLogin,
  refreshMissionProgress,
  trackMissionEvent,
} = require("../modules/account-progression");
const { ensureOfficialNewAccountDefaults } = require("../modules/new-account");
const {
  createEmptyReward,
  mergeReward,
  grantRewardByType,
  grantRewardRecord,
} = require("../modules/reward");

loadDotEnv(path.join(ROOT_DIR, ".env"));
const {
  buildAttendanceData: buildSerializedAttendanceData,
  buildAttendanceIntervalDataList: buildSerializedAttendanceIntervalDataList,
} = require("../modules/attendance");
const { loadShopCatalog, buildSerializedRandomShopData } = require("../modules/shop");
const { getShopPurchaseHistories } = require("../modules/resource");
const {
  getContentUnlocksForDungeon,
  getEventDeckTemplet,
  getMissionTabTemplets,
  getMissionTempletsByTabId,
  getRewardGroupRecords,
  getPlayerTotalExpForLevel,
} = require("../modules/game-data");
const {
  getAllContractStates,
  getAllContractBonusStates,
  getAllCustomPickupContracts,
  buildCustomPickupContractData: buildSerializedCustomPickupContractData,
} = require("../modules/contract");
const lobbyCustomization = require("../modules/lobby");
const simulation = require("../modules/simulation");
const stamina = require("../modules/stamina");
const collection = require("../modules/collection");
const {
  buildSupportUnitData: buildPersistedSupportUnitData,
  ensureSupportUnit,
} = require("../modules/combat-roster");
const { createEventManager } = require("../modules/event-manager");

function envFlag(...keys) {
  return keys.some((key) => {
    const value = process.env[key];
    if (value == null) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  });
}

function envFlagDefault(defaultValue, ...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value == null) continue;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return Boolean(defaultValue);
}

function resolveNewAccountRosterMode() {
  const explicit = String(process.env.CS_NEW_ACCOUNT_ROSTER_MODE || "").trim().toLowerCase();
  if (["all", "debug-all"].includes(explicit)) return "all";
  if (["starter", "safe"].includes(explicit)) return "starter";
  if (["none", "off", "official", "0", "false"].includes(explicit)) return "none";

  const legacy = String(process.env.CS_SEED_NEW_ACCOUNT_ROSTER || "").trim().toLowerCase();
  if (["all", "debug-all"].includes(legacy)) return "all";
  if (["starter", "safe"].includes(legacy)) return "starter";
  return "none";
}

function resolveGuideMissionTabs() {
  try {
    const tabs = getMissionTabTemplets()
      .filter((tab) => {
        const openTag = String(tab && tab.m_OpenTag || "").toUpperCase();
        const missionTab = String(tab && tab.m_MissionTab || "").toUpperCase();
        return openTag.includes("COMBINE_GUIDE_MISSION") || missionTab === "COMBINE_GUIDE_MISSION" || missionTab === "GROWTH_COMPLETE";
      })
      .map((tab) => Number(tab && tab.m_TabID || 0))
      .filter((tabId) => Number.isInteger(tabId) && tabId > 0);
    return uniqueMissionTabs(tabs);
  } catch (_) {
    return [20001, 20002, 20003, 20004, 20005, 20006, 20007, 20008, 20009, 20010, 20011, 20012, 20013];
  }
}

function uniqueMissionTabs(tabIds) {
  return Array.from(
    new Set(
      (Array.isArray(tabIds) ? tabIds : [])
        .map((tabId) => Number(tabId || 0))
        .filter((tabId) => Number.isInteger(tabId) && tabId > 0)
    )
  );
}

const PORT = Number(process.env.CS_PORT || 22000);
const HTTP_MIRROR_PORT = Number(process.env.CS_HTTP_MIRROR_PORT || 8088);
const DEBUG_HEX = process.env.CS_DEBUG_HEX === "1";
const VERBOSE_CAPTURE_LOGS = process.env.CS_VERBOSE_CAPTURE === "1" || DEBUG_HEX;
const LOG_CONFIG_EACH_CONNECTION = process.env.CS_LOG_CONFIG_EACH_CONNECTION === "1";

const HEAD_FENCE = 0xaabbccdd;
const TAIL_FENCE = 0x11223344;
const DEFAULT_COMBAT_CONTROLS = Object.freeze({
  autoRespawnEnabled: false,
  gameSpeedType: 0,
  autoSkillType: 1,
});

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
const GAME_LOAD_COMPLETE_ACK = 808;
const GAME_START_NOT = 809;
const GAME_END_NOT = 811;
const GAME_PAUSE_ACK = 813;
const GAME_RESPAWN_ACK = 817;
const GAME_SHIP_SKILL_REQ = 818;
const GAME_SHIP_SKILL_ACK = 819;
const GAME_GIVEUP_REQ = 823;
const GAME_GIVEUP_ACK = 824;
const GAME_USE_UNIT_SKILL_REQ = 829;
const GAME_USE_UNIT_SKILL_ACK = 830;
const CUTSCENE_DUNGEON_START_REQ = 1200;
const CUTSCENE_DUNGEON_START_ACK = 1201;
const CUTSCENE_DUNGEON_CLEAR_REQ = 1202;
const CUTSCENE_DUNGEON_CLEAR_ACK = 1203;
const FRIEND_LIST_ACK = 401;
const GREETING_MESSAGE_ACK = 454;
const EMOTICON_DATA_REQ = 455;
const EMOTICON_DATA_ACK = 456;
const EQUIP_PRESET_LIST_ACK = 1039;
const FAVORITES_STAGE_ACK = 1244;
const POST_LIST_ACK = 1615;
const MISSION_UPDATE_NOT = 1619;
const MISSION_COMPLETE_REQ = 1620;
const MISSION_COMPLETE_ACK = 1621;
const DEFENCE_INFO_ACK = 3905;
const NPT_GAME_SYNC_DATA_PACK_NOT = 822;
const NGT_DUNGEON = 3;
const NGT_TUTORIAL = 7;
const NGS_FINISH = 4;
const NTT_A1 = 1;
const NTT_B1 = 3;

const CAPTURED_FLOW_DIR =
  process.env.CS_CAPTURED_FLOW_DIR || path.join(ROOT_DIR, "server-data", "captured-flows");
const CAPTURED_TCP_DIR =
  process.env.CS_CAPTURED_TCP_DIR || path.join(ROOT_DIR, "server-data", "captured-tcp");
const CAPTURED_GAME_FLOW_DIR =
  process.env.CS_CAPTURED_GAME_FLOW_DIR || path.join(ROOT_DIR, "server-data", "captured-game-flow");
const PACKET_HANDLER_DIR = process.env.CS_PACKET_HANDLER_DIR || path.join(ROOT_DIR, "packet-handlers");
const MODULE_HANDLER_ROOT = path.join(ROOT_DIR, "modules");
const UNIT_TABLE_PATH = process.env.CS_UNIT_TABLE_PATH || path.join(ROOT_DIR, "server-data", "units.json");
const DUNGEON_TABLE_PATH = process.env.CS_DUNGEON_TABLE_PATH || path.join(ROOT_DIR, "server-data", "dungeons.json");
const STAGE_TABLE_PATH =
  process.env.CS_STAGE_TABLE_PATH ||
  findGameplayTableFile("ab_script", "LUA_STAGE_TEMPLET.json", { rootDir: ROOT_DIR });
const MAP_TABLE_PATH =
  process.env.CS_MAP_TABLE_PATH ||
  findGameplayTableFile("ab_script", "LUA_MAP_TEMPLET.json", { rootDir: ROOT_DIR });
const USE_LOCAL_USER_DB = process.env.CS_USE_LOCAL_USER_DB !== "0";
const REPLAY_CAPTURED_CONTENTS_VERSION = process.env.CS_REPLAY_CAPTURED_CONTENTS_VERSION !== "0";
const REPLAY_CAPTURED_LOGIN_ACK = process.env.CS_REPLAY_CAPTURED_LOGIN_ACK !== "0";
const REPLAY_CAPTURED_GAME_FLOW = process.env.CS_REPLAY_CAPTURED_GAME_FLOW !== "0";
const REPLAY_CAPTURED_GAME_AUTO_ADVANCE = process.env.CS_REPLAY_CAPTURED_GAME_AUTO_ADVANCE === "1";
const REPLAY_CAPTURED_GAME_AUTO_ADVANCE_MS = 0;
const SYNTHETIC_SYNC_INTERVAL_MS = Number(process.env.CS_SYNTHETIC_SYNC_INTERVAL_MS || 200);
const BATTLE_SIMULATOR = process.env.CS_BATTLE_SIMULATOR === "1";
const DYNAMIC_BATTLE_MANAGER = process.env.CS_DYNAMIC_BATTLE_MANAGER !== "0";
const DYNAMIC_BATTLE_SYNC_INTERVAL_MS = Number(process.env.CS_DYNAMIC_BATTLE_SYNC_INTERVAL_MS || 33);
const MANAGED_HOST_TICK_INTERVAL_MS = Number(process.env.CS_MANAGED_HOST_TICK_INTERVAL_MS || 33);
const MANAGED_HOST_PRIME_FRAMES = Number(process.env.CS_MANAGED_HOST_PRIME_FRAMES || 1);
const DYNAMIC_BATTLE_GAME_UNIT_GROUPS = parseGameUnitGroups(process.env.CS_DYNAMIC_BATTLE_GAME_UNIT_GROUPS || "5,6;8,9;10,11;12,13");
const CSHARP_COMBAT_HOST = process.env.CS_CSHARP_COMBAT_HOST !== "0";
const CSHARP_COMBAT_HOST_PROJECT = process.env.CS_CSHARP_COMBAT_HOST_PROJECT || path.join(ROOT_DIR, "combat-host", "CombatHost.csproj");
const CSHARP_COMBAT_HOST_DLL = process.env.CS_CSHARP_COMBAT_HOST_DLL || "";
const CSHARP_COMBAT_HOST_TIMEOUT_MS = Number(process.env.CS_CSHARP_COMBAT_HOST_TIMEOUT_MS || 20000);
const CSHARP_COMBAT_HOST_DOTNET = process.env.CS_DOTNET_PATH || findDefaultDotnetRuntime();
const COUNTERSIDE_MANAGED_DIR = process.env.CS_COUNTERSIDE_MANAGED_DIR || findDefaultCounterSideManagedDir();
const GAMEPLAY_TABLES_DIR = process.env.CS_GAMEPLAY_TABLES_DIR || "";
const OFFICIAL_COMBAT_REPLAY = process.env.CS_OFFICIAL_COMBAT_REPLAY === "1";
const OFFICIAL_COMBAT_REPLAY_START_INDEX = Number(process.env.CS_OFFICIAL_COMBAT_REPLAY_START_INDEX || 64);
const OFFICIAL_COMBAT_REPLAY_INTERVAL_MS = Number(process.env.CS_OFFICIAL_COMBAT_REPLAY_INTERVAL_MS || 33);
const TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX = Number(process.env.CS_TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX || 98);
const ALLOW_SYNTHETIC_GAME_SYNC = process.env.CS_ALLOW_SYNTHETIC_GAME_SYNC === "1";
const REFRAME_CAPTURED_GAME_FLOW = process.env.CS_REFRAME_CAPTURED_GAME_FLOW === "1";
const SKIP_TUTORIAL_CUTSCENE = process.env.CS_SKIP_TUTORIAL_CUTSCENE === "1";
const SKIP_TUTORIAL_TO_WIN = process.env.CS_SKIP_TUTORIAL_TO_WIN === "1";
const RESET_LOCAL_PROGRESS_ON_LOGIN = process.env.CS_RESET_LOCAL_PROGRESS_ON_LOGIN === "1";
const RESET_TUTORIAL_PROGRESS_ON_LOGIN = process.env.CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN === "1";
const RESET_CAMPAIGN_PROGRESS_ON_LOGIN = envFlag("resetcampaignprogress", "RESETCAMPAIGNPROGRESS", "CS_RESET_CAMPAIGN_PROGRESS");
const CLEAR_ALL_MISSIONS_STATUS = envFlag(
  "clearAllMissionsStatus",
  "clearallmissionsstatus",
  "CLEARALLMISSIONSSTATUS",
  "CS_CLEAR_ALL_MISSIONS_STATUS",
  "CS_CLEAR_ALL_MISSION_STATUS"
);
const CLEAR_UNITS_LEVEL1 = envFlag("clearUnitsLevel1", "CLEARUNITSLEVEL1", "CS_CLEAR_UNITS_LEVEL1", "CS_CLEAR_UNITS_LEVEL_1");
const CLEAR_GEAR_UNENHANCED = envFlag("clearGearUnenhanced", "CLEARGEARUNENHANCED", "CS_CLEAR_GEAR_UNENHANCED");
const CLEAR_SHIPS_LEVEL1 = envFlag("clearShipsLevel1", "CLEARSHIPSLEVEL1", "CS_CLEAR_SHIPS_LEVEL1", "CS_CLEAR_SHIPS_LEVEL_1");
const CLEAR_OPERATORS_LEVEL1 = envFlag(
  "clearOperatorsLevel1",
  "CLEAROPERATORSLEVEL1",
  "CS_CLEAR_OPERATORS_LEVEL1",
  "CS_CLEAR_OPERATORS_LEVEL_1"
);
const LOCAL_JOIN_LOBBY_ACK_MODE = String(process.env.CS_USE_LOCAL_JOIN_LOBBY_ACK || "auto").trim().toLowerCase();
const USE_LOCAL_JOIN_LOBBY_ACK = LOCAL_JOIN_LOBBY_ACK_MODE === "1" || LOCAL_JOIN_LOBBY_ACK_MODE === "true";
const LOBBY_LOCAL_MISSION_DATA = envFlagDefault(true, "lobbyLocalMissionData", "LOBBYLOCALMISSIONDATA", "CS_LOBBY_LOCAL_MISSION_DATA");
const GUIDE_MISSION_TABS = Object.freeze(resolveGuideMissionTabs());
const SIMULATION_MISSION_TABS = [6, 7, 8];
const FAST_LOBBY_MISSION_TABS = uniqueMissionTabs([1, 2, 3, ...SIMULATION_MISSION_TABS, ...GUIDE_MISSION_TABS]);
const POST_TUTORIAL_MIN_USER_LEVEL = Math.max(2, Number(process.env.CS_POST_TUTORIAL_MIN_USER_LEVEL || 2) || 2);
const NEW_ACCOUNT_ROSTER_MODE = resolveNewAccountRosterMode();
const SEED_NEW_ACCOUNT_TROPHIES = process.env.CS_SEED_NEW_ACCOUNT_TROPHIES === "1";
const USE_STEAM_TOKEN_AS_ACCESS_TOKEN = process.env.CS_USE_STEAM_TOKEN_AS_ACCESS_TOKEN === "1";
const REWRITE_CAPTURED_SERVER_INFO = process.env.CS_REWRITE_CAPTURED_SERVER_INFO !== "0";
const MIRROR_PUBLIC_HOST = process.env.CS_HTTP_MIRROR_HOST || "127.0.0.1";
const MIRROR_PUBLIC_BASE_URL =
  process.env.CS_HTTP_MIRROR_BASE_URL || `http://${MIRROR_PUBLIC_HOST}:${HTTP_MIRROR_PORT}`;
const USER_DB_PATH = process.env.CS_USER_DB_PATH || path.join(ROOT_DIR, "server-data", "users.json");
const USER_MANAGER_ENABLED = process.env.CS_USER_MANAGER !== "0";
const USER_MANAGER_BASE_PATH = process.env.CS_USER_MANAGER_BASE_PATH || "/user-manager";
const USER_MANAGER_ALLOW_REMOTE = process.env.CS_USER_MANAGER_ALLOW_REMOTE === "1";

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
const TUTORIAL_SKIP_WIN_MISSION_IDS = Object.freeze([999, 100]);
const POST_TUTORIAL_GUIDE_MISSION_IDS = Object.freeze([340, 341, 345, 610]);
const POST_TUTORIAL_GUIDE_REQUIREMENT_STAGE_IDS = Object.freeze({
  340: 11665, // Daily / Simulation guide after NKM_MAIN_BATTLE_EP1_2_4_ACT_BOSS_A
  341: 11665, // Daily challenge follow-up in the same tutorial mission group
  345: 11242, // DailyAdd / Anti-air Simulation prompt after NKM_MAIN_BATTLE_EP1_4_2_HARD_BOSS_A
  610: 11245, // SupplyGuide / NKM_DUNGEON_EP1_ACT4_EPLIOGUE
});

const GAME_SERVER_IP = process.env.CS_GAME_SERVER_IP || "127.0.0.1";
const GAME_SERVER_PORT = Number(process.env.CS_GAME_SERVER_PORT || PORT);
const CONTENTS_VERSION = process.env.CS_CONTENTS_VERSION || "9.2.c";
const REQUIRED_CONTENTS_TAGS = Object.freeze(["TAG_COMMON_SHOP_TAB_SUPPLY", "SYSTEM_TRANSCENDENCE_LV120"]);
const REQUIRED_STORY_OPEN_TAGS = Object.freeze(getStoryOpenTags());
const CONTENTS_TAGS = mergeTags(
  parseTags(
    process.env.CS_CONTENTS_TAGS ||
      "GLOBAL,LANGUAGE_KOR,LANGUAGE_ENG,LANGUAGE_DEU,LANGUAGE_FRA,LANGUAGE_JPN,LANGUAGE_TRADITIONAL_CHN,VOICE_KOR,VOICE_JPN,CHECK_MAINTENANCE,MULTITASK_DOWNLOAD"
  ),
  REQUIRED_CONTENTS_TAGS
);
const OPEN_TAGS = mergeTags(parseTags(process.env.CS_OPEN_TAGS || ""), REQUIRED_STORY_OPEN_TAGS);
const eventManager = createEventManager({ rootDir: ROOT_DIR, env: process.env });
const EVENT_MANAGER_DIAGNOSTICS = envFlag("CS_EVENT_DIAGNOSTICS");
const EVENT_CONTENTS_TAGS_ENABLED = envFlag("CS_EVENT_EMIT_CONTENTS_TAGS", "CS_EVENT_CONTENTS_TAGS");
const EVENT_COUNTER_PASS_CONTENTS_TAGS_ENABLED = envFlagDefault(
  true,
  "CS_EVENT_EMIT_COUNTER_PASS_CONTENTS_TAGS",
  "CS_COUNTER_PASS_CONTENTS_TAGS"
);

const CRYPTO_MASKS = [
  14170986657190717782n,
  15546886188969944187n,
  15913139373130964729n,
  3486779174683840252n,
];

const capturedTcpResponses = loadCapturedTcpResponses(CAPTURED_TCP_DIR);
const capturedTcpProfiles = buildCapturedTcpProfiles(capturedTcpResponses);
const capturedGameTemplateFlow = loadCapturedGameFlow(CAPTURED_GAME_FLOW_DIR);
const capturedGameFlow = REPLAY_CAPTURED_GAME_FLOW ? capturedGameTemplateFlow : null;
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
const userManager = USER_MANAGER_ENABLED
  ? createUserManager({
      basePath: USER_MANAGER_BASE_PATH,
      allowRemote: USER_MANAGER_ALLOW_REMOTE,
      userDb,
      userDbPath: USER_DB_PATH,
      saveUserDb,
      ensureUserDefaults,
      makeAccessToken,
      makeToken,
    })
  : null;
const packetHandlers = loadPacketHandlers([PACKET_HANDLER_DIR, MODULE_HANDLER_ROOT], { rootDir: ROOT_DIR });
const joinLobbyAckPayloadCache = new Map();
const localProgressResetUsers = new Set();
let cachedDungeonCatalog = null;
let cachedStageCatalog = null;
let cachedMapIdByStrId = null;

if (process.env.CS_DUMP_JOIN_LOBBY_ACK_PAYLOAD) {
  const dumpUserUid = String(process.env.CS_DUMP_USER_UID || "");
  const user = ensureUserDefaults(
    (dumpUserUid && userDb.users[dumpUserUid]) ||
      Object.values(userDb.users)[0] || {
        userUid: "1000000001",
        friendCode: "10000001",
        nickname: "LocalAdmin",
        accessToken: "local-access-token",
        reconnectKey: "",
      }
  );
  const payload = buildMinimalJoinLobbyPayload(user);
  fs.writeFileSync(process.env.CS_DUMP_JOIN_LOBBY_ACK_PAYLOAD, payload);
  console.log(
    `[debug] wrote JOIN_LOBBY_ACK payload uid=${user.userUid || "(ephemeral)"} bytes=${payload.length} path=${process.env.CS_DUMP_JOIN_LOBBY_ACK_PAYLOAD}`
  );
  process.exit(0);
}

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
    MANAGED_HOST_TICK_INTERVAL_MS,
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

if (process.env.CS_DUMP_MERGED_JOIN_LOBBY_ACK_PAYLOAD) {
  const dumpUserUid = String(process.env.CS_DUMP_USER_UID || "");
  const user = ensureUserDefaults(
    (dumpUserUid && userDb.users[dumpUserUid]) ||
      Object.values(userDb.users)[0] || {
        userUid: "1000000001",
        friendCode: "10000001",
        nickname: "LocalAdmin",
        accessToken: "local-access-token",
        reconnectKey: "",
      }
  );
  const payload = buildJoinLobbyAckPayload(user);
  fs.writeFileSync(process.env.CS_DUMP_MERGED_JOIN_LOBBY_ACK_PAYLOAD, payload);
  console.log(
    `[debug] wrote merged JOIN_LOBBY_ACK payload uid=${user.userUid || "(ephemeral)"} bytes=${payload.length} path=${process.env.CS_DUMP_MERGED_JOIN_LOBBY_ACK_PAYLOAD}`
  );
  process.exit(0);
}

let lastSteamAccessToken = "";
let lastEffectiveAccessToken = "";
let lastAckContentsVersion = "";
let lastAckContentsTags = [];
let runtimeConfigPrinted = false;

startTcpServer();
startHttpMirror();

function startTcpServer() {
  const server = net.createServer((socket) => {
    // The Unity client reacts poorly to tiny TCP write stalls during load.
    // Send framed server packets immediately and batch deliberate bursts below.
    socket.setNoDelay(true);
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
    `[cfg] userManager=${userManager ? "on" : "off"} path=${
      userManager ? userManager.basePath : "(disabled)"
    } remote=${USER_MANAGER_ALLOW_REMOTE ? "on" : "off"}`
  );
  console.log(
    `[cfg] tcpReplay contents=${REPLAY_CAPTURED_CONTENTS_VERSION ? "on" : "off"} login=${
      REPLAY_CAPTURED_LOGIN_ACK ? "on" : "off"
    } packets=${[...capturedTcpResponses.keys()].join(",") || "(none)"}`
  );
  console.log(
    `[cfg] gameReplay=${REPLAY_CAPTURED_GAME_FLOW && capturedGameFlow ? "on" : "off"} packets=${
      capturedGameFlow ? capturedGameFlow.server.length : 0
    } templates=${
      capturedGameTemplateFlow ? capturedGameTemplateFlow.server.length : 0
    } autoAdvance=${REPLAY_CAPTURED_GAME_AUTO_ADVANCE ? `${REPLAY_CAPTURED_GAME_AUTO_ADVANCE_MS}ms` : "off"} reframe=${
      REFRAME_CAPTURED_GAME_FLOW ? "on" : "off"
    }`
  );
  console.log(`[cfg] contentsVersion=${CONTENTS_VERSION}`);
  console.log(`[cfg] contentsTags=${CONTENTS_TAGS.length}`);
  const eventSummary = eventManager.getSummary();
  console.log(
    `[cfg] eventManager=${eventSummary.enabled ? "on" : "off"} date=${
      eventSummary.dateInput || "(unset)"
    } profile=${eventSummary.profile} tableScan=${eventSummary.tableScan} tables=${eventSummary.tableCount} entries=${
      eventSummary.entryCount
    } active=${eventSummary.activeEntryCount} intervals=${eventSummary.activeIntervalCount} contentsTags=${
      eventSummary.activeContentsTagCount
    } emitContentsTags=${EVENT_CONTENTS_TAGS_ENABLED ? "on" : "off"} counterPasses=${
      eventSummary.activeCounterPassCount
    } counterPassContentsTags=${EVENT_COUNTER_PASS_CONTENTS_TAGS_ENABLED ? "on" : "off"} openTags=${eventSummary.activeOpenTagCount}`
  );
  if (EVENT_MANAGER_DIAGNOSTICS) {
    process.stdout.write(eventManager.formatDiagnostics(eventManager.config.eventDate, { limit: 12 }));
  }
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
  console.log(
    `[cfg] newAccountRosterMode=${NEW_ACCOUNT_ROSTER_MODE} trophies=${
      SEED_NEW_ACCOUNT_TROPHIES ? "on" : "off"
    }`
  );
  console.log(`[cfg] skipTutorialCutscene=${SKIP_TUTORIAL_CUTSCENE ? "on" : "off"}`);
  console.log(`[cfg] skipTutorialToWin=${SKIP_TUTORIAL_TO_WIN ? "on" : "off"}`);
  console.log(`[cfg] resetLocalProgressOnLogin=${RESET_LOCAL_PROGRESS_ON_LOGIN ? "on" : "off"}`);
  console.log(`[cfg] resetTutorialProgressOnLogin=${RESET_TUTORIAL_PROGRESS_ON_LOGIN ? "on" : "off"}`);
  console.log(`[cfg] resetCampaignProgressOnLogin=${RESET_CAMPAIGN_PROGRESS_ON_LOGIN ? "on" : "off"}`);
  console.log(`[cfg] clearAllMissionsStatus=${CLEAR_ALL_MISSIONS_STATUS ? "on" : "off"}`);
  console.log(
    `[cfg] cleanup clearUnitsLevel1=${CLEAR_UNITS_LEVEL1 ? "on" : "off"} clearGearUnenhanced=${
      CLEAR_GEAR_UNENHANCED ? "on" : "off"
    } clearShipsLevel1=${CLEAR_SHIPS_LEVEL1 ? "on" : "off"} clearOperatorsLevel1=${CLEAR_OPERATORS_LEVEL1 ? "on" : "off"}`
  );
  console.log(`[cfg] localJoinLobbyAck=${USE_LOCAL_JOIN_LOBBY_ACK ? "on" : LOCAL_JOIN_LOBBY_ACK_MODE === "0" || LOCAL_JOIN_LOBBY_ACK_MODE === "false" ? "off" : "auto"}`);
  console.log(`[cfg] lobbyLocalMissionData=${LOBBY_LOCAL_MISSION_DATA ? "on" : "off"}`);
  console.log(
    `[cfg] officialCombatReplay=${OFFICIAL_COMBAT_REPLAY ? "on" : "off"} packets=${
      capturedCombatReplayEntries.length
    } startIndex=${OFFICIAL_COMBAT_REPLAY_START_INDEX} interval=${OFFICIAL_COMBAT_REPLAY_INTERVAL_MS}ms`
  );
  console.log(`[cfg] battleSimulator=${BATTLE_SIMULATOR ? "on" : "off"} syncInterval=${SYNTHETIC_SYNC_INTERVAL_MS}ms`);
  console.log(
    `[cfg] dynamicBattleManager=${DYNAMIC_BATTLE_MANAGER ? "on" : "off"} syncInterval=${DYNAMIC_BATTLE_SYNC_INTERVAL_MS}ms managedTick=${MANAGED_HOST_TICK_INTERVAL_MS}ms managedPrimeFrames=${MANAGED_HOST_PRIME_FRAMES} spawnGroups=${DYNAMIC_BATTLE_GAME_UNIT_GROUPS.map((group) => group.join(",")).join(";")}`
  );
  console.log(
    `[cfg] csharpCombatHost=${CSHARP_COMBAT_HOST ? "on" : "off"} dotnet=${CSHARP_COMBAT_HOST_DOTNET} project=${CSHARP_COMBAT_HOST_PROJECT} managed=${
      COUNTERSIDE_MANAGED_DIR || "(none)"
    } tables=${GAMEPLAY_TABLES_DIR || "(none)"}`
  );
  console.log(`[cfg] verboseCaptureLogs=${VERBOSE_CAPTURE_LOGS ? "on" : "off"}`);
}

function startHttpMirror() {
  if (!capturedFlowMirror && !userManager) {
    console.log(`[mirror] disabled; no manifest at ${path.join(CAPTURED_FLOW_DIR, "manifest.json")}`);
    return;
  }

  http
    .createServer(async (req, res) => {
      try {
        if (userManager && (await userManager.handle(req, res))) return;
        if (serveEventManagerDiagnostics(req, res)) return;
        if (capturedFlowMirror) {
          serveCapturedFlow(req, res, capturedFlowMirror);
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("No captured HTTP mirror is configured.\n");
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end(`HTTP server error: ${err.message}\n`);
      }
    })
    .listen(HTTP_MIRROR_PORT, () => {
      if (capturedFlowMirror) {
        console.log(`[+] Captured HTTP mirror listening on ${MIRROR_PUBLIC_BASE_URL}`);
        console.log(`[+] Captured HTTP mirror fixtureDir=${CAPTURED_FLOW_DIR}`);
      } else {
        console.log(`[mirror] disabled; no manifest at ${path.join(CAPTURED_FLOW_DIR, "manifest.json")}`);
      }
      if (userManager) {
        console.log(`[+] User manager listening on ${MIRROR_PUBLIC_BASE_URL}${userManager.basePath}`);
      }
    });
}

function serveEventManagerDiagnostics(req, res) {
  const url = new URL(req.url || "/", MIRROR_PUBLIC_BASE_URL);
  if (url.pathname !== "/event-manager" && url.pathname !== "/event-manager/diagnostics") return false;

  const date = url.searchParams.get("date") || eventManager.config.dateInput || "";
  const limit = Number(url.searchParams.get("limit") || 50) || 50;
  const hasOverrides =
    url.searchParams.has("date") ||
    url.searchParams.has("scan") ||
    url.searchParams.has("roots") ||
    url.searchParams.has("manager") ||
    url.searchParams.has("packaged");
  const manager = hasOverrides ? createEventDiagnosticsManager(url, date) : eventManager;
  const diagnostics = manager.getDiagnostics(date || manager.config.eventDate, { limit });
  const format = String(url.searchParams.get("format") || "json").toLowerCase();

  if (format === "text") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(manager.formatDiagnostics(date || manager.config.eventDate, { limit }));
    return true;
  }

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(diagnostics, null, 2)}\n`);
  return true;
}

function createEventDiagnosticsManager(url, date) {
  const env = { ...process.env };
  if (date) env.CS_EVENT_DATE = date;
  if (url.searchParams.has("scan")) env.CS_EVENT_TABLE_SCAN = url.searchParams.get("scan") || "";
  if (url.searchParams.has("roots")) env.CS_EVENT_TABLE_ROOTS = url.searchParams.get("roots") || "";
  if (url.searchParams.has("manager")) env.CS_EVENT_MANAGER = url.searchParams.get("manager") || "";
  if (url.searchParams.get("packaged") === "1" || url.searchParams.get("packaged") === "true") {
    env.CS_EVENT_TABLE_ROOTS = "gameplay-jsons/Assetbundles";
  }
  return createEventManager({ rootDir: ROOT_DIR, env });
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
  const replay = socket && socket.session && socket.session.gameReplay;
  if (replay) replay.nextServerSequence = Math.max(Number(replay.nextServerSequence || 1), Number(sequence || 0) + 1);
}

function sendGameResponse(socket, packet, packetId, payload, label) {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (replay && replay.inGameFlow) {
    sendServerGamePacket(socket, packetId, payload || Buffer.alloc(0), label || `packet-${packetId}`);
    return;
  }
  const sequence = packet && typeof packet === "object" ? packet.sequence : Number(packet || 1);
  sendResponse(socket, sequence, packetId, () => buildEncryptedPacket(sequence, packetId, payload || Buffer.alloc(0)));
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
      GAME_LOAD_COMPLETE_ACK,
      GAME_START_NOT,
      GAME_END_NOT,
      GAME_PAUSE_ACK,
      GAME_RESPAWN_ACK,
      GAME_SHIP_SKILL_REQ,
      GAME_SHIP_SKILL_ACK,
      GAME_GIVEUP_REQ,
      GAME_GIVEUP_ACK,
      GAME_USE_UNIT_SKILL_REQ,
      GAME_USE_UNIT_SKILL_ACK,
      MISSION_COMPLETE_REQ,
      MISSION_COMPLETE_ACK,
      CUTSCENE_DUNGEON_START_ACK,
      CUTSCENE_DUNGEON_CLEAR_ACK,
      FRIEND_LIST_ACK,
      GREETING_MESSAGE_ACK,
      EMOTICON_DATA_REQ,
      EMOTICON_DATA_ACK,
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
      MANAGED_HOST_TICK_INTERVAL_MS,
      MANAGED_HOST_PRIME_FRAMES,
      DYNAMIC_BATTLE_GAME_UNIT_GROUPS,
      OFFICIAL_COMBAT_REPLAY,
      VERBOSE_CAPTURE_LOGS,
      SKIP_TUTORIAL_CUTSCENE,
      SKIP_TUTORIAL_TO_WIN,
      RESET_LOCAL_PROGRESS_ON_LOGIN,
      RESET_TUTORIAL_PROGRESS_ON_LOGIN,
      RESET_CAMPAIGN_PROGRESS_ON_LOGIN,
      CLEAR_ALL_MISSIONS_STATUS,
      CLEAR_UNITS_LEVEL1,
      CLEAR_GEAR_UNENHANCED,
      CLEAR_SHIPS_LEVEL1,
      CLEAR_OPERATORS_LEVEL1,
      USE_LOCAL_JOIN_LOBBY_ACK,
      LOCAL_JOIN_LOBBY_ACK_MODE,
      CONTENTS_VERSION,
      REQUIRED_CONTENTS_TAGS,
      CONTENTS_TAGS,
      EVENT_MANAGER_CONFIG: eventManager.config,
    },
    capturedTcpResponses,
    capturedTcpProfiles,
    capturedGameFlow,
    userDb,
    eventManager,
    setLastAckContents(version, tags) {
      lastAckContentsVersion = version || "";
      lastAckContentsTags = Array.isArray(tags) ? tags.slice() : [];
    },
    setLastEffectiveAccessToken(token) {
      lastEffectiveAccessToken = token || "";
    },
    sendResponse,
    sendGameResponse,
    sendCapturedGameThrough,
    sendCapturedGameExact,
    sendCapturedGameTemplateRange,
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
    handleDynamicBattlePause,
    handleDynamicBattleUnitSkill,
    handleDynamicBattleShipSkill,
    applyCombatControls,
    sendManagedOrImmediatePacket,
    sendManagedOrImmediatePackets,
    sendPendingGameStartSync,
    startOfficialCombatReplay,
    startSyntheticGameSync,
    scheduleCapturedGameAutoAdvance,
    logCapturedClientPacketMatch,
    maybeSendTutorialCutsceneClear,
    logGameLoadReq,
    decodeGameLoadReq,
    decodeGameRespawnReq,
    decodeGameUnitSkillReq,
    decodeGameShipSkillReq,
    buildGameLoadAck,
    getCapturedServerPayloadTemplate,
    buildRespawnAck,
    buildGameSync,
    buildGameSyncPackets,
    buildInitialBattleSync,
    buildInitialBattlePackets,
    ensureGameStartPackets,
    deployStageLineup,
    buildGameRespawnAckPayload,
    buildGamePauseAckPayload,
    buildDynamicGameEndNotPayload,
    stopGameSyncTimers,
    buildFramedPacket,
    buildEncryptedPacket,
    buildContentsVersionAck,
    buildCapturedLoginAck,
    buildCapturedReconnectAck,
    buildLoginAck,
    buildLoginLikePayload,
    buildJoinLobbyAckPayload,
    buildMinimalJoinLobbyPayload,
    hasTutorialProgress,
    shouldUseLocalJoinLobbyAck,
    ensureTutorialCompletionProgress,
    resetLocalProgressForUser,
    resetTutorialProgressForUser,
    resetCampaignProgressForUser,
    prepareTutorialLogin,
    skipStaleTutorialGameLoadReplay,
    decodeMissionCompleteReq,
    buildMissionCompleteAckPayload,
    recordMissionLogin,
    refreshMissionProgress,
    trackMissionEvent,
    refreshTimedStamina,
    sendStaminaChargeNotifications,
    buildEmoticonDataAckPayload,
    buildFriendListAckPayload,
    buildGreetingMessageAckPayload,
    buildFavoritesStageAckPayload,
    buildDefenceInfoAckPayload,
    recordMissionComplete,
    buildCutsceneDungeonStartAckPayload,
    buildCutsceneDungeonClearAckPayload,
    resolveCutsceneDungeonId,
    resolveCutsceneClearDungeonId,
    recordTutorialCutsceneClear,
    recordMainStoryDungeonClear,
    recordEpisode1DungeonClear: recordMainStoryDungeonClear,
    recordPersistentCutsceneView,
    recordGameplayUnlockClear,
    decodeSteamLoginReq,
    decodeJoinLobbyReq,
    getGenericStageForRequest,
    recordGenericDungeonClear,
    buildDungeonSkipAckPayload,
    sendStageClearMissionUpdate,
    repairPostTutorialGuideMissionsForSocket,
    readCutsceneDungeonReq,
    decryptCopy,
    safeReadString,
    safeReadSignedVarLong,
    writeSignedVarInt,
    writeSignedVarLong,
    writeInt64LE,
    dateTimeBinaryNow,
    dateTimeTicksNow,
    getEffectiveContentsTags,
    getRequiredContentsTags,
    getOrCreateUserForSteam,
    issueUserTokens,
    saveUserDb,
    findUserByAccessToken,
    findUserByReconnectKey,
    createEphemeralUser,
  };
}

function createGameReplayState() {
  return {
    inGameFlow: false,
    localJoinLobbyAckSent: false,
    bootLobbyTemplateSent: false,
    bootPostListTemplateSent: false,
    friendListCount: 0,
    pauseCount: 0,
    pendingPauseCount: 0,
    heartbeatCount: 0,
    loadCompleteReceived: false,
    pendingGameStartBootstrap: false,
    lastSceneId: 0,
    postTutorialGuideMissionCompleteAckSent: false,
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
    dynamicBattlePaused: false,
    dynamicBattleResultSent: false,
    gameSpeedType: null,
    autoSkillType: null,
    autoRespawnEnabled: null,
    battleSim: null,
    tutorialReplayPhase: "",
  };
}

function scheduleCapturedGameAutoAdvance(socket) {
  if (!REPLAY_CAPTURED_GAME_AUTO_ADVANCE) return;
  const replay = socket.session.gameReplay;
  if (replay.autoAdvanceTimer) {
    clearTimeout(replay.autoAdvanceTimer);
    replay.autoAdvanceTimer = null;
  }
  console.log("[capture-game:auto-advance] disabled; delayed packet replay has been removed");
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

function sendCapturedGameTemplateRange(socket, startIndex, endIndex, label) {
  if (!capturedGameTemplateFlow || !Array.isArray(capturedGameTemplateFlow.server)) return 0;
  const quietRange = !VERBOSE_CAPTURE_LOGS && endIndex > startIndex;
  let sentCount = 0;
  if (quietRange) {
    console.log(`[capture-game:${label}] SEND template range=${startIndex}-${endIndex}`);
  }
  withSocketPacketBurst(socket, () => {
    for (let index = startIndex; index <= endIndex; index += 1) {
      const entry = capturedGameTemplateFlow.server[index - 1];
      if (!entry || !entry.raw) {
        console.log(`[capture-game] missing template server packet index=${index} label=${label}`);
        continue;
      }
      sendCapturedGameEntry(socket, entry, index, label, { quiet: quietRange, forceReframe: true });
      sentCount += 1;
    }
  });
  if (quietRange) {
    console.log(`[capture-game:${label}] sent=${sentCount}`);
  }
  return sentCount;
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

function skipStaleTutorialGameLoadReplay(socket, label) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const user = socket && socket.session && socket.session.user;
  if (!replay || replay.dynamicGame || !hasTutorialCompletionMarker(user)) return false;
  if (replay.lastGameLoadReq && (isTutorialStageId(replay.lastGameLoadReq.stageID) || isTutorialDungeonId(replay.lastGameLoadReq.dungeonID))) {
    return false;
  }
  const next = capturedGameFlow && capturedGameFlow.server && capturedGameFlow.server[replay.nextServerIndex - 1];
  if (!next || next.packetId !== GAME_LOAD_ACK) return false;
  replay.nextServerIndex += 1;
  console.log(`[capture-game:${label || "tutorial"}] skipped stale tutorial GAME_LOAD_ACK because tutorial is complete`);
  return true;
}

function sendCapturedHeartbeatReply(socket, time, label) {
  const replay = socket.session.gameReplay;
  sendServerGamePacket(socket, HEART_BIT_ACK, writeSignedVarLong(time), label);

  if (DYNAMIC_BATTLE_MANAGER && replay.dynamicGame) {
    return;
  }

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
  withSocketPacketBurst(socket, () => {
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
  });
  if (quietRange) {
    console.log(`[capture-game:${label}] sent=${sentCount}`);
  }
}

function withSocketPacketBurst(socket, send) {
  const canCork = socket && typeof socket.cork === "function" && typeof socket.uncork === "function";
  if (canCork) socket.cork();
  try {
    return send();
  } finally {
    if (canCork) socket.uncork();
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
    (label === "synthetic-game-sync" ||
      label === "battle-sim-sync" ||
      label === "battle-manager-sync") &&
    !DEBUG_HEX;
  if (!quietSynthetic || replay.syntheticSyncCount % 20 === 1) {
    console.log(`[capture-game:${label}] SEND packetId=${packetId} sequence=${sequence} payloadSize=${parsed.payloadSize}`);
  }
  if (DEBUG_HEX) printHex(packet);
  replay.nextServerSequence = Math.max(replay.nextServerSequence, Number(sequence) + 1);
}

function refreshTimedStamina(user, options = {}) {
  return stamina.refreshTimedStamina(user, options);
}

function sendStaminaChargeNotifications(socket, label = "stamina-charge", options = {}) {
  const user = socket && socket.session && socket.session.user;
  if (!user) return false;
  const now = dateTimeBinaryNow();
  const result = stamina.refreshTimedStamina(user, {
    now,
    initializeMissing: false,
  });
  const updates =
    options.includeUnchanged === true
      ? stamina.getChargeItemNotifications(user, { now, itemIds: options.itemIds })
      : result.updates || [];
  if (updates.length === 0) return false;
  for (const update of updates) {
    sendServerGamePacket(socket, stamina.CHARGE_ITEM_NOT, stamina.buildChargeItemNotPayload(update), label);
  }
  if (result.changed && USE_LOCAL_USER_DB) saveUserDb();
  return true;
}

function sendManagedOrImmediatePackets(socket, packets) {
  const endIndex = (packets || []).findIndex((item) => item && item.packetId === GAME_END_NOT);
  const outbound = endIndex >= 0 ? packets.slice(0, endIndex + 1) : packets;
  withSocketPacketBurst(socket, () => {
    for (const item of outbound || []) {
      if (!item || !item.packetId || !item.payload) continue;
      sendManagedOrImmediatePacket(socket, item.packetId, item.payload, item.label || "managed-sync");
    }
  });
  if (endIndex >= 0) {
    const replay = socket.session && socket.session.gameReplay;
    if (replay) replay.dynamicBattleResultSent = true;
    maybeRecordDynamicBattleClear(socket);
    stopGameSyncTimers(socket);
  }
}

function sendManagedOrImmediatePacket(socket, packetId, payload, label) {
  sendServerGamePacket(socket, packetId, normalizeManagedCombatPayload(socket, packetId, payload, label), label);
}

function sendPendingGameStartSync(socket, label) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.pendingGameStartBootstrap || !replay.dynamicGame) return false;
  replay.pendingGameStartBootstrap = false;
  const queuedPackets = Array.isArray(replay.pendingGameStartPackets) ? replay.pendingGameStartPackets : [];
  replay.pendingGameStartPackets = [];
  const packets = ensureGameStartPackets(queuedPackets.length > 0 ? queuedPackets : buildInitialBattlePackets(replay), replay, socket).filter(Boolean);
  sendManagedOrImmediatePackets(
    socket,
    packets.map((item) => ({
      ...item,
      label:
        item.label ||
        (item.packetId === NPT_GAME_SYNC_DATA_PACK_NOT
          ? "managed-game-sync"
          : item.packetId === GAME_LOAD_COMPLETE_ACK
            ? "managed-load-complete"
            : item.packetId === GAME_START_NOT
              ? "managed-game-start"
              : "managed-game-start"),
    }))
  );
  replay.tutorialReplayPhase = "dynamic";
  if (replay.dynamicGame) replay.dynamicGame.initialUnitsSent = true;
  startDynamicBattleManager(socket, label);
  console.log(`[battle-manager:${label}] game scene sync started`);
  return true;
}

function normalizeManagedCombatPayload(socket, packetId, payload, label) {
  if (packetId !== GAME_END_NOT) return payload;
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame) return payload;

  // NKCGameServerLocal flushes a local-only GAME_END_NOT. The online flow
  // needs server-owned clear data so result screens, mission medals, and local
  // progress all agree after the battle ends.
  if (replay.dynamicGame.tutorial) {
    const tutorialEnd = buildTutorialGameEndNotPayload(replay, { user: socket.session && socket.session.user });
    recordTutorialDungeonClear(socket, replay);
    return tutorialEnd || payload;
  }

  const gameEnd = buildDynamicGameEndNotPayload(replay, {
    user: socket.session && socket.session.user,
    // The managed local-server GAME_END_NOT is not the authoritative online
    // result packet. Its first bool and mirrored battle state can remain false
    // even after the client reached the clear path, so the online PvE result is
    // authoritative unless an explicit give-up handler overrides it.
    fallbackWin: true,
    preferFallbackWin: true,
  });
  return gameEnd || payload;
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
    sendGamePacket(socket, packetId, payload, label, meta = {}) {
      if (packetId === GAME_END_NOT) {
        sendDynamicFinishStateSync(socket, null, "dynamic-finish-state");
      }
      sendManagedOrImmediatePacket(socket, packetId, payload, label);
    },
    onGameEndPacketSent(socket) {
      maybeRecordDynamicBattleClear(socket);
    },
    sendBattleResult(socket, finishedState) {
      const replay = socket && socket.session && socket.session.gameReplay;
      const payload = buildDynamicGameEndNotPayload(replay, {
        battleState: finishedState,
        fallbackWin: true,
        preferFallbackWin: true,
        user: socket && socket.session && socket.session.user,
      });
      if (!payload) return false;
      withSocketPacketBurst(socket, () => {
        sendDynamicFinishStateSync(socket, finishedState, "dynamic-finish-state");
        sendServerGamePacket(socket, GAME_END_NOT, payload, "dynamic-game-end");
      });
      maybeRecordDynamicBattleClear(socket, finishedState);
      return true;
    },
    stopTimers: stopGameSyncTimers,
  });
}

function sendDynamicFinishStateSync(socket, finishedState = null, label = "dynamic-finish-state") {
  const replay = socket && socket.session && socket.session.gameReplay;
  const payload = buildDynamicFinishStateSyncPayload(replay, finishedState);
  if (!payload) return false;
  sendServerGamePacket(socket, NPT_GAME_SYNC_DATA_PACK_NOT, payload, label);
  return true;
}

function buildDynamicFinishStateSyncPayload(replay, finishedState = null) {
  if (!replay || !replay.dynamicGame) return null;
  const battleState = finishedState || replay.battleState || replay.battleSim || {};
  const playTime = getBattlePlayTime(battleState);
  const absoluteGameTime = Math.max(
    playTime,
    Number(battleState.absoluteGameTime ?? battleState.AbsoluteGameTime ?? playTime) || playTime
  );
  const finishSync = {
    dynamicGame: replay.dynamicGame,
    gameTime: playTime,
    absoluteGameTime,
    remainGameTime: Math.max(0, Number(battleState.remainGameTime ?? battleState.RemainGameTime ?? 0) || 0),
    gameSpeedType: replay.dynamicGame.gameSpeedType ?? battleState.gameSpeedType ?? battleState.GameSpeedType,
    autoSkillType: replay.dynamicGame.autoSkillType ?? battleState.autoSkillType ?? battleState.AutoSkillType,
    gameStates: [
      {
        state: NGS_FINISH,
        winTeam: resolveBattleWin(battleState, { fallbackWin: true, preferFallbackWin: true }) ? NTT_A1 : NTT_B1,
        waveId: Number(
          (battleState.gameState && (battleState.gameState.waveId ?? battleState.gameState.waveID)) ??
            battleState.waveId ??
            battleState.WaveId ??
            1
        ),
      },
    ],
  };
  if (battleState.respawnCostA1 != null || battleState.RespawnCostA1 != null) {
    finishSync.respawnCostA1 = Number(battleState.respawnCostA1 ?? battleState.RespawnCostA1);
  }
  if (battleState.respawnCostB1 != null || battleState.RespawnCostB1 != null) {
    finishSync.respawnCostB1 = Number(battleState.respawnCostB1 ?? battleState.RespawnCostB1);
  }
  return combatHandler.buildGameSync(finishSync);
}

function applyCombatControls(socket, controls = {}, options = {}) {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!replay) return null;
  const dynamicGame = replay.dynamicGame && typeof replay.dynamicGame === "object" ? replay.dynamicGame : null;
  const battleState = replay.battleState && typeof replay.battleState === "object" ? replay.battleState : null;
  const battleSim = replay.battleSim && typeof replay.battleSim === "object" ? replay.battleSim : null;
  const applied = {};

  if (Object.prototype.hasOwnProperty.call(controls, "gameSpeedType")) {
    const gameSpeedType = clampCombatControlEnum(controls.gameSpeedType, 0, 5);
    replay.gameSpeedType = gameSpeedType;
    if (dynamicGame) dynamicGame.gameSpeedType = gameSpeedType;
    if (battleState) battleState.gameSpeedType = gameSpeedType;
    if (battleSim) battleSim.gameSpeedType = gameSpeedType;
    applied.gameSpeedType = gameSpeedType;
  }

  if (Object.prototype.hasOwnProperty.call(controls, "autoSkillType")) {
    const autoSkillType = clampCombatControlEnum(controls.autoSkillType, 0, 1);
    replay.autoSkillType = autoSkillType;
    if (dynamicGame) dynamicGame.autoSkillType = autoSkillType;
    if (battleState) battleState.autoSkillType = autoSkillType;
    if (battleSim) battleSim.autoSkillType = autoSkillType;
    applied.autoSkillType = autoSkillType;
  }

  if (Object.prototype.hasOwnProperty.call(controls, "autoRespawnEnabled")) {
    const autoRespawnEnabled = Boolean(controls.autoRespawnEnabled);
    replay.autoRespawnEnabled = autoRespawnEnabled;
    if (dynamicGame) dynamicGame.autoRespawnEnabled = autoRespawnEnabled;
    if (battleState) battleState.autoRespawnEnabled = autoRespawnEnabled;
    if (battleSim) battleSim.autoRespawnEnabled = autoRespawnEnabled;
    applied.autoRespawnEnabled = autoRespawnEnabled;
  }

  const user = socket && socket.session && socket.session.user;
  if (options.persist !== false && user && Object.keys(applied).length > 0 && saveUserCombatControls(user, applied) && USE_LOCAL_USER_DB) {
    saveUserDb();
  }
  return getReplayCombatControls(replay, user);
}

function clampCombatControlEnum(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric | 0));
}

function normalizeCombatControls(source = {}, fallback = DEFAULT_COMBAT_CONTROLS) {
  const controls = source && typeof source === "object" ? source : {};
  const base = fallback && typeof fallback === "object" ? fallback : DEFAULT_COMBAT_CONTROLS;
  return {
    autoRespawnEnabled: Object.prototype.hasOwnProperty.call(controls, "autoRespawnEnabled")
      ? Boolean(controls.autoRespawnEnabled)
      : Boolean(base.autoRespawnEnabled),
    gameSpeedType: Object.prototype.hasOwnProperty.call(controls, "gameSpeedType")
      ? clampCombatControlEnum(controls.gameSpeedType, 0, 5)
      : clampCombatControlEnum(base.gameSpeedType, 0, 5),
    autoSkillType: Object.prototype.hasOwnProperty.call(controls, "autoSkillType")
      ? clampCombatControlEnum(controls.autoSkillType, 0, 1)
      : clampCombatControlEnum(base.autoSkillType, 0, 1),
  };
}

function hasSavedCombatControls(user) {
  const controls = user && user.combatControls && typeof user.combatControls === "object" ? user.combatControls : null;
  if (!controls) return false;
  return ["autoRespawnEnabled", "gameSpeedType", "autoSkillType"].some((key) =>
    Object.prototype.hasOwnProperty.call(controls, key)
  );
}

function getSavedCombatControls(user) {
  const controls = user && user.combatControls && typeof user.combatControls === "object" ? user.combatControls : null;
  return normalizeCombatControls(controls, DEFAULT_COMBAT_CONTROLS);
}

function getReplayCombatControls(replay, user) {
  const source = {};
  if (replay && replay.autoRespawnEnabled != null) source.autoRespawnEnabled = replay.autoRespawnEnabled;
  if (replay && replay.gameSpeedType != null) source.gameSpeedType = replay.gameSpeedType;
  if (replay && replay.autoSkillType != null) source.autoSkillType = replay.autoSkillType;
  return normalizeCombatControls(source, getSavedCombatControls(user));
}

function saveUserCombatControls(user, partialControls) {
  if (!user || typeof user !== "object") return false;
  const current = getSavedCombatControls(user);
  const next = normalizeCombatControls(partialControls, current);
  const previous = user.combatControls && typeof user.combatControls === "object" ? user.combatControls : {};
  const changed =
    previous.autoRespawnEnabled !== next.autoRespawnEnabled ||
    previous.gameSpeedType !== next.gameSpeedType ||
    previous.autoSkillType !== next.autoSkillType;
  if (!changed && hasSavedCombatControls(user)) return false;
  user.combatControls = {
    ...previous,
    autoRespawnEnabled: next.autoRespawnEnabled,
    gameSpeedType: next.gameSpeedType,
    autoSkillType: next.autoSkillType,
    updatedAt: new Date().toISOString(),
  };
  return true;
}

function applySavedCombatControls(socket) {
  const user = socket && socket.session && socket.session.user;
  return applyCombatControls(socket, getSavedCombatControls(user), { persist: false });
}

function sendDynamicGameLoadAck(socket, req, stage) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !req) return false;
  const activeStage = stage || {};
  // Every tutorial phase is a new battle load on the same socket/session.
  // Reset per-battle gates here so heartbeats during phase 2+ loading cannot
  // start managed 822 sync before GAME_LOAD_COMPLETE_REQ (807) arrives.
  stopGameSyncTimers(socket);
  replay.loadCompleteReceived = false;
  replay.dynamicBattlePaused = false;
  replay.dynamicBattleResultSent = false;
  replay.tutorialClearRecorded = false;
  replay.stageClearLoot = null;
  replay.lastDynamicGameEndResult = null;
  replay.managedGameLoadAckPayload = null;
  replay.battleSim = null;
  const gameLoadAckTemplate = getCapturedServerPayloadTemplate(GAME_LOAD_ACK);
  const nativeTutorialLoad =
    activeStage.tutorial || isTutorialStageId(activeStage.stageId || req.stageID) || isTutorialDungeonId(activeStage.dungeonID || req.dungeonID);
  const usesEventDeck = Number(activeStage.eventDeckId || activeStage.EventDeckId || 0) > 0;
  // Stage data enters combat-handler here, then the listener wraps the resulting
  // state in a managed GAME_LOAD_ACK when possible. Tutorial battles no longer
  // seed the managed bridge from captured 804; the bridge builds NKMGameData
  // from the local tables so phase routing is not coupled to stale captures.
  combatHandler.startBattle({
    replay,
    req,
    stage: activeStage,
    gameLoadAckPayloadBase64: !nativeTutorialLoad && !usesEventDeck && gameLoadAckTemplate ? gameLoadAckTemplate.toString("base64") : "",
  });
  applySavedCombatControls(socket);
  const payload =
    replay.managedGameLoadAckPayload ||
    buildGameLoadAck({
      ...replay.dynamicGame,
      // Only the non-managed fallback still uses the old template patcher.
      // The normal tutorial path above asks the managed bridge to build 804
      // from local tables with no captured game-load body.
      patchStageFields: !replay.dynamicGame.tutorial || Number(replay.dynamicGame.stageID) !== 11211,
    });
  combatHandler.attachGameLoadUnitPools(replay, activeStage, payload);
  sendServerGamePacket(socket, GAME_LOAD_ACK, payload, replay.managedGameLoadAckPayload ? "managed-game-load" : "dynamic-game-load");
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
      sendManagedOrImmediatePackets(socket, packets);
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

function handleDynamicBattlePause(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  // 812 is part of the combat timeline. Forward it to NKCGameServerLocal so
  // tutorial prompt pauses affect client and server together. The Node pump
  // stays alive; it must not add a second transport-level pause on top.
  replay.dynamicBattlePaused = Boolean(req.isPause);
  const result = combatHandler.handlePause({ replay, req });
  if (result && result.handled) {
    sendManagedOrImmediatePackets(socket, result.packets);
  } else {
    sendServerGamePacket(socket, GAME_PAUSE_ACK, buildGamePauseAckPayload(req.isPause, req.isPauseEvent), "battle-manager-pause");
  }
  replay.pauseCount += 1;
  console.log(`[battle-manager] pause=${req.isPause ? 1 : 0} pauseEvent=${req.isPauseEvent ? 1 : 0} pump=alive`);
  if (replay.dynamicGame && !replay.dynamicBattleTimer) {
    startDynamicBattleManager(socket, "pause-resume");
  }
  return true;
}

function handleDynamicBattleUnitSkill(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  const result = combatHandler.handleUnitSkill({ replay, req });
  if (result && result.handled) {
    sendManagedOrImmediatePackets(socket, result.packets);
    console.log(
      `[combat-host] unit skill gameUnitUID=${req.gameUnitUID} packets=${(result.packets || []).length}`
    );
    return true;
  }
  sendServerGamePacket(
    socket,
    GAME_USE_UNIT_SKILL_ACK,
    buildGameUnitSkillAckPayload(req.gameUnitUID, 0, 0),
    "battle-manager-unit-skill"
  );
  return true;
}

function handleDynamicBattleShipSkill(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  const result = combatHandler.handleShipSkill({ replay, req });
  if (result && result.handled) {
    sendManagedOrImmediatePackets(socket, result.packets);
    console.log(
      `[combat-host] ship skill gameUnitUID=${req.gameUnitUID} shipSkillID=${req.shipSkillID} x=${req.skillPosX.toFixed(
        1
      )} packets=${(result.packets || []).length}`
    );
    return true;
  }
  sendServerGamePacket(
    socket,
    GAME_SHIP_SKILL_ACK,
    buildGameShipSkillAckPayload(req.gameUnitUID, req.shipSkillID, req.skillPosX, 0),
    "battle-manager-ship-skill"
  );
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
  if (!req || !isTutorialDungeonId(req.dungeonID)) return;
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

function resolveCutsceneDungeonId(socket, decodedDungeonId) {
  const decoded = Number(decodedDungeonId || 0);
  if (isMainStoryDungeonId(decoded) && !isTutorialDungeonId(decoded)) return decoded;
  const replay = socket && socket.session && socket.session.gameReplay;
  const requestedDungeonId = Number(replay && replay.lastGameLoadReq && replay.lastGameLoadReq.dungeonID);
  if (!decoded && isMainStoryDungeonId(requestedDungeonId) && !isTutorialDungeonId(requestedDungeonId)) return requestedDungeonId;
  if (!decoded && isTutorialDungeonId(requestedDungeonId)) return requestedDungeonId;
  const activeBattleFinished =
    replay &&
    (replay.tutorialClearRecorded ||
      replay.dynamicBattleResultSent ||
      (replay.battleState && (replay.battleState.finished || replay.battleState.Finished)));
  const user = socket && socket.session && socket.session.user;
  if (isTutorialDungeonId(decoded)) {
    if ((!replay || activeBattleFinished) && isTutorialDungeonCleared(user, decoded)) {
      return nextTutorialDungeonIdForUser(user);
    }
    return decoded;
  }
  const activeDungeonId = Number(replay && replay.dynamicGame && replay.dynamicGame.dungeonID);
  if (isMainStoryDungeonId(activeDungeonId) && !isTutorialDungeonId(activeDungeonId)) return activeDungeonId;
  if (isTutorialDungeonId(activeDungeonId) && !activeBattleFinished) return activeDungeonId;
  return nextTutorialDungeonIdForUser(user);
}

function resolveCutsceneClearDungeonId(socket, decodedDungeonId) {
  const decoded = Number(decodedDungeonId || 0);
  if (isMainStoryDungeonId(decoded) && !isTutorialDungeonId(decoded)) return decoded;
  if (isTutorialDungeonId(decoded)) return decoded;
  const replay = socket && socket.session && socket.session.gameReplay;
  const requestedDungeonId = Number(replay && replay.lastGameLoadReq && replay.lastGameLoadReq.dungeonID);
  if (!decoded && isMainStoryDungeonId(requestedDungeonId) && !isTutorialDungeonId(requestedDungeonId)) return requestedDungeonId;
  if (!decoded && isTutorialDungeonId(requestedDungeonId)) return requestedDungeonId;
  const activeDungeonId = Number(replay && replay.dynamicGame && replay.dynamicGame.dungeonID);
  if (isMainStoryDungeonId(activeDungeonId) && !isTutorialDungeonId(activeDungeonId)) return activeDungeonId;
  if (isTutorialDungeonId(activeDungeonId)) return activeDungeonId;
  return nextTutorialDungeonIdForUser(socket && socket.session && socket.session.user);
}

function nextTutorialDungeonIdForUser(user) {
  const tutorial = ensureTutorialState(user);
  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const phase = phases[tutorialPhaseKey(stage)];
    if (!phase || phase.completed !== true) return stage.dungeonID;
  }
  return TUTORIAL_STAGE_CHAIN[0].dungeonID;
}

function isTutorialDungeonCleared(user, dungeonId) {
  const stage = TUTORIAL_STAGE_CHAIN.find((candidate) => candidate.dungeonID === Number(dungeonId));
  if (!stage) return false;
  const tutorial = ensureTutorialState(user);
  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  const phase = phases[tutorialPhaseKey(stage)];
  return Boolean(phase && phase.completed === true);
}

function scrubTutorialEpisodeClearProgress(user) {
  if (!user || typeof user !== "object") return false;
  let changed = false;
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    if (Object.prototype.hasOwnProperty.call(user.dungeonClear, String(stage.dungeonID))) {
      delete user.dungeonClear[String(stage.dungeonID)];
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(user.stagePlayData, String(stage.stageId))) {
      delete user.stagePlayData[String(stage.stageId)];
      changed = true;
    }
    for (const containerName of ["mainStory", "episode1"]) {
      const container = user[containerName];
      if (!container || !container.stages || typeof container.stages !== "object") continue;
      const state = container.stages[String(stage.stageId)];
      if (!state) continue;
      if (state.completed || state.completedAt || state.bestClearTimeSec) {
        state.completed = false;
        state.completedAt = "";
        state.bestClearTimeSec = 0;
        changed = true;
      }
    }
  }
  if (user.mainStory && typeof user.mainStory === "object") {
    user.mainStory.completed = false;
  }
  if (user.episode1 && typeof user.episode1 === "object") {
    user.episode1.completed = false;
  }
  return changed;
}

function maybeRecordDynamicBattleClear(socket, overrideState = null) {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame || replay.dynamicGame.tutorial) return false;
  const lastEnd = replay.lastDynamicGameEndResult || null;
  const dynamicDungeonId = Number(replay.dynamicGame.dungeonID || 0);
  const dynamicStageId = Number(replay.dynamicGame.stageID || stageIdForDungeonId(dynamicDungeonId) || 0);
  const lastEndMatches =
    lastEnd &&
    Number(lastEnd.dungeonId || 0) === dynamicDungeonId &&
    Number(lastEnd.stageId || 0) === dynamicStageId;
  const battleState = overrideState || (lastEndMatches && lastEnd.battleState) || replay.battleState || replay.battleSim || {};
  const authoritativeWin = Boolean(lastEndMatches && lastEnd.win === true && !lastEnd.giveup);
  if (!authoritativeWin && !isBattleWin(battleState)) return false;
  return (
    recordMainStoryDungeonClear(socket, lastEndMatches ? lastEnd.dungeonId : undefined, battleState) ||
    recordGenericDungeonClear(socket, lastEndMatches ? lastEnd.dungeonId : undefined, battleState)
  );
}

function recordMainStoryDungeonClear(socket, dungeonId, battleState = null) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const resolvedDungeonId = Number(dungeonId || dynamicGame.dungeonID || 0);
  if (!resolvedDungeonId || !isMainStoryDungeonId(resolvedDungeonId) || isTutorialDungeonId(resolvedDungeonId)) return false;
  const resolvedStageId = stageIdForDungeonId(resolvedDungeonId);
  const user = socket && socket.session && socket.session.user;
  const saved = recordMainStoryDungeonClearForUser(user, resolvedDungeonId, resolvedStageId, battleState || (replay && replay.battleState) || {}, {
    save: USE_LOCAL_USER_DB ? saveUserDb : null,
    forceMissionSuccess: true,
  });
  if (saved) {
    const userExp = getDungeonUserExpReward(resolvedDungeonId);
    maybeGrantBattleStageClearLoot(replay, user, resolvedDungeonId, resolvedStageId, battleState);
    grantStageClearExp(user, resolvedStageId, resolvedDungeonId, userExp > 0 ? { exp: userExp } : undefined);
    recordGameplayUnlockClearForUser(user, resolvedDungeonId, resolvedStageId, { save: false });
    trackStageClearMissionProgress(user, resolvedDungeonId, resolvedStageId, battleState || (replay && replay.battleState) || {});
    sendStageClearMissionUpdate(socket, user);
    if (USE_LOCAL_USER_DB) saveUserDb();
    console.log(
      `[main-story-progress] clear uid=${user && user.userUid ? user.userUid : "(none)"} stageID=${resolvedStageId} dungeonID=${resolvedDungeonId}`
    );
  }
  return saved;
}

function recordGenericDungeonClear(socket, dungeonId, battleState = null) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const resolvedDungeonId = Number(dungeonId || dynamicGame.dungeonID || 0);
  if (!resolvedDungeonId || isTutorialDungeonId(resolvedDungeonId) || isMainStoryDungeonId(resolvedDungeonId)) return false;
  const resolvedStageId = Number(dynamicGame.stageID || stageIdForDungeonId(resolvedDungeonId) || 0);
  const user = socket && socket.session && socket.session.user;
  if (!user || typeof user !== "object") return false;
  const state = battleState || (replay && replay.battleState) || {};
  const missionResults = resolveDungeonMissionResults(resolvedDungeonId, {
    win: true,
    battleState: state,
    forceMissionSuccess: true,
  });
  if (state && typeof state === "object") {
    state.missionResult1 = missionResults.missionResult1;
    state.missionResult2 = missionResults.missionResult2;
    state.missionResults = { ...missionResults };
  }
  const userExp = getDungeonUserExpReward(resolvedDungeonId);
  maybeGrantBattleStageClearLoot(replay, user, resolvedDungeonId, resolvedStageId, state);
  grantStageClearExp(user, resolvedStageId, resolvedDungeonId, userExp > 0 ? { exp: userExp } : undefined);
  const saved = recordGenericDungeonClearForUser(user, resolvedDungeonId, resolvedStageId, state, {
    save: false,
    forceMissionSuccess: true,
  });
  if (saved) {
    recordGameplayUnlockClearForUser(user, resolvedDungeonId, resolvedStageId, { save: false });
    trackStageClearMissionProgress(user, resolvedDungeonId, resolvedStageId, state);
    sendStageClearMissionUpdate(socket, user);
    if (USE_LOCAL_USER_DB) saveUserDb();
    console.log(
      `[stage-progress] clear uid=${user && user.userUid ? user.userUid : "(none)"} stageID=${resolvedStageId} dungeonID=${resolvedDungeonId}`
    );
  }
  return saved;
}

function recordGenericDungeonClearForUser(user, dungeonId, stageId, battleState = {}, options = {}) {
  if (!user || typeof user !== "object") return false;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  if (!resolvedDungeonId && !resolvedStageId) return false;
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};

  const previousClear = user.dungeonClear[String(resolvedDungeonId)] || {};
  const previousStagePlay = user.stagePlayData[String(resolvedStageId)] || {};
  const bestClearTimeSec = Math.max(0, Math.round(Number((battleState && (battleState.gameTime || battleState.GameTime)) || 0)));
  const missionResults =
    battleState && battleState.missionResults && typeof battleState.missionResults === "object"
      ? battleState.missionResults
      : battleState || {};
  const forceMissionSuccess =
    options.forceMissionSuccess === true ||
    (battleState && (battleState.forceMissionSuccess === true || battleState.ForceMissionSuccess === true));
  const missionResult1 =
    previousClear.missionResult1 === true ||
    forceMissionSuccess ||
    missionResults.missionResult1 === true ||
    missionResults.MissionResult1 === true ||
    (missionResults.missionResult1 !== false && missionResults.MissionResult1 !== false);
  const missionResult2 =
    previousClear.missionResult2 === true ||
    forceMissionSuccess ||
    missionResults.missionResult2 === true ||
    missionResults.MissionResult2 === true ||
    (missionResults.missionResult2 !== false && missionResults.MissionResult2 !== false);
  const clearTimeCandidates = [Number(previousStagePlay.bestClearTimeSec || 0), bestClearTimeSec].filter((value) => value > 0);
  const bestRecordedClearTimeSec = clearTimeCandidates.length > 0 ? Math.min(...clearTimeCandidates) : bestClearTimeSec;

  user.dungeonClear[String(resolvedDungeonId)] = {
    dungeonId: resolvedDungeonId,
    stageId: resolvedStageId,
    missionResult1,
    missionResult2,
    clearedAt: previousClear.clearedAt || new Date().toISOString(),
  };
  if (resolvedStageId > 0) {
    user.stagePlayData[String(resolvedStageId)] = {
      stageId: resolvedStageId,
      playCount: Number(previousStagePlay.playCount || 0) + 1,
      totalPlayCount: Number(previousStagePlay.totalPlayCount || 0) + 1,
      bestClearTimeSec: bestRecordedClearTimeSec,
    };
    user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
    if (!user.unlockedStageIds.includes(resolvedStageId)) user.unlockedStageIds.push(resolvedStageId);
  }
  if (USE_LOCAL_USER_DB && options.save !== false) saveUserDb();
  return true;
}

function buildDungeonSkipAckPayload(socket, req = {}) {
  const user = socket && socket.session && socket.session.user;
  const dungeonId = Number(req.dungeonId || 0);
  const stage = getGenericStageForRequest({ dungeonID: dungeonId }) || getGenericStageForRequest({ stageID: stageIdForDungeonId(dungeonId), dungeonID: dungeonId });
  const stageId = Number((stage && stage.stageId) || stageIdForDungeonId(dungeonId) || 0);
  const skipCount = clamp(Number(req.skip || 1) || 1, 1, 99);
  const unitUids = Array.isArray(req.unitUids) ? req.unitUids : [];
  const rewardSets = [];
  const costItems = spendStageReqItemCost(user, stageId, { multiplier: skipCount });
  const battleState = {
    gameTime: 0,
    missionResult1: true,
    missionResult2: true,
    missionResults: { missionResult1: true, missionResult2: true },
    forceMissionSuccess: true,
  };

  for (let index = 0; index < skipCount; index += 1) {
    const fakeReplay = {
      dynamicGame: {
        dungeonID: dungeonId,
        stageID: stageId,
        playerDeck: {
          units: unitUids.map((unitUid, slotIndex) => ({ unitUid, slotIndex })),
        },
      },
      battleState,
    };
    const loot = grantStageClearLoot(user, dungeonId, stageId, { replay: fakeReplay });
    grantStageClearExp(user, stageId, dungeonId, loot.userExp > 0 ? { exp: loot.userExp } : undefined);
    if (isMainStoryDungeonId(dungeonId) && !isTutorialDungeonId(dungeonId)) {
      recordMainStoryDungeonClearForUser(user, dungeonId, stageId, battleState, {
        save: null,
        forceMissionSuccess: true,
      });
    } else {
      recordGenericDungeonClearForUser(user, dungeonId, stageId, battleState, {
        save: false,
        forceMissionSuccess: true,
      });
    }
    recordGameplayUnlockClearForUser(user, dungeonId, stageId, { save: false });
    trackStageClearMissionProgress(user, dungeonId, stageId, battleState);
    rewardSets.push(buildDungeonRewardSet(user, dungeonId, stageId, battleState, loot));
  }

  if (USE_LOCAL_USER_DB) saveUserDb();
  return Buffer.concat([
    writeSignedVarInt(0),
    stageId ? writeNullableObject(buildStagePlayData(stageId, battleState)) : writeNullObject(),
    writeObjectList(rewardSets.map((rewardSet) => writeNullableObject(rewardSet))),
    writeObjectList(costItems.map((item) => writeNullableObject(buildItemMiscData(item)))), // costItems
    writeObjectList([]), // updatedUnits
  ]);
}

function buildDungeonRewardSet(user, dungeonId, stageId, battleState = {}, loot = null) {
  const episodeCompleteData = buildMainStoryEpisodeCompleteDataForStage(user, stageId);
  return Buffer.concat([
    episodeCompleteData ? writeNullableObject(episodeCompleteData) : writeNullObject(),
    writeNullableObject(
      buildDungeonClearData(dungeonId, {
        win: true,
        battleState,
        missionResult1: true,
        missionResult2: true,
        reward: loot && loot.reward,
        unitExp: loot ? loot.unitExp : undefined,
      })
    ),
  ]);
}

function buildCutsceneDungeonStartAckPayload(dungeonId) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildStagePlayData(stageIdForDungeonId(dungeonId))),
  ]);
}

function buildTutorialGameEndNotPayload(replay, override = {}) {
  const dynamicGame = replay && replay.dynamicGame;
  if (!dynamicGame) return null;
  const dungeonId = Number(override.dungeonID || dynamicGame.dungeonID || 0);
  const stageId = Number(override.stageID || dynamicGame.stageID || stageIdForDungeonId(dungeonId));
  if (!isTutorialDungeonId(dungeonId) || !isTutorialStageId(stageId)) return null;
  const battleState = override.battleState || replay.battleState || {};
  const episodeCompleteData = buildMainStoryEpisodeCompleteDataForStage(override.user, stageId);
  return Buffer.concat([
    writeBool(true), // win
    writeBool(false), // giveup
    writeBool(false), // restart
    writeNullableObject(buildDungeonClearData(dungeonId)),
    writeNullableObject(buildPhaseClearData(stageId)), // phaseClearData
    episodeCompleteData ? writeNullableObject(episodeCompleteData) : writeNullObject(), // episodeCompleteData
    writeNullableObject(buildBattleDeckIndexData(replay)), // deckIndex
    writeNullObject(), // warfareSyncData
    writeNullObject(), // pvpResultData
    writeNullObject(), // diveSyncData
    writeNullableObject(buildRaidBossResultData()), // raidBossResultData
    writeNullObject(), // gameRecord
    writeObjectList([]), // updatedUnits
    writeObjectList([]), // costItemDataList
    writeNullableObject(buildStagePlayData(stageId, battleState)),
    writeNullableObject(buildShadowGameResultData()), // shadowGameResult
    writeNullableObject(buildFierceResultData()), // fierceResultData
    writeNullObject(), // phaseModeState
    writeSignedVarLong(0n), // killCountDelta
    writeNullObject(), // killCountData
    writeNullObject(), // trimModeState
    writeFloatLE(Number(battleState.gameTime || battleState.GameTime || 0)), // totalPlayTime
    writeNullObject(), // explore
    writeNullObject(), // exploreSquad
    writeSignedVarInt(0), // exploreEnhancePoint
  ]);
}

function buildDynamicGameEndNotPayload(replay, override = {}) {
  const dynamicGame = replay && replay.dynamicGame;
  if (!dynamicGame) return null;
  const battleState = override.battleState || replay.battleState || replay.battleSim || {};
  const dungeonId = Number(override.dungeonID || dynamicGame.dungeonID || 0);
  const stageId = Number(override.stageID || dynamicGame.stageID || stageIdForDungeonId(dungeonId));
  if (!dungeonId && !stageId) return null;
  const win = resolveBattleWin(battleState, override);
  const missionResults = resolveDungeonMissionResults(dungeonId, {
    win,
    battleState,
    forceMissionSuccess: win && override.forceMissionSuccess !== false,
  });
  if (battleState && typeof battleState === "object") {
    normalizeBattleResultState(battleState, win);
    battleState.missionResult1 = missionResults.missionResult1;
    battleState.missionResult2 = missionResults.missionResult2;
    battleState.missionResults = { ...missionResults };
  }
  if (replay && typeof replay === "object") {
    replay.lastDynamicGameEndResult = {
      win,
      giveup: Boolean(override.giveup || false),
      dungeonId,
      stageId,
      battleState,
    };
  }
  console.log(
    `[dynamic-game-end] result=${win ? "win" : "loss"} dungeonID=${dungeonId} stageID=${stageId} source=${
      override.preferFallbackWin ? "online-authoritative" : "battle-state"
    }`
  );
  const stageLoot = win ? getOrGrantStageClearLoot(replay, override.user, dungeonId, stageId) : null;
  const costItems = spendStageReqItemCostForReplay(replay, override.user, stageId);
  const episodeCompleteData = win ? buildMainStoryEpisodeCompleteDataForStage(override.user, stageId) : null;
  const playTime = getBattlePlayTime(battleState);
  return Buffer.concat([
    writeBool(win), // win
    writeBool(Boolean(override.giveup || false)), // giveup
    writeBool(Boolean(override.restart || false)), // restart
    dungeonId
      ? writeNullableObject(
          buildDungeonClearData(dungeonId, {
            win,
            battleState,
            ...missionResults,
            reward: stageLoot && stageLoot.reward,
            unitExp: stageLoot ? stageLoot.unitExp : undefined,
          })
        )
      : writeNullObject(),
    writeNullObject(), // phaseClearData
    episodeCompleteData ? writeNullableObject(episodeCompleteData) : writeNullObject(), // episodeCompleteData
    writeNullableObject(buildBattleDeckIndexData(replay)), // deckIndex
    writeNullObject(), // warfareSyncData
    writeNullObject(), // pvpResultData
    writeNullObject(), // diveSyncData
    writeNullableObject(buildRaidBossResultData()), // raidBossResultData
    writeNullObject(), // gameRecord
    writeObjectList([]), // updatedUnits
    writeObjectList(costItems.map((item) => writeNullableObject(buildItemMiscData(item)))), // costItemDataList
    stageId ? writeNullableObject(buildStagePlayData(stageId, { ...battleState, gameTime: playTime })) : writeNullObject(),
    writeNullableObject(buildShadowGameResultData()), // shadowGameResult
    writeNullableObject(buildFierceResultData()), // fierceResultData
    writeNullObject(), // phaseModeState
    writeSignedVarLong(0n), // killCountDelta
    writeNullObject(), // killCountData
    writeNullObject(), // trimModeState
    writeFloatLE(playTime), // totalPlayTime
    writeNullObject(), // explore
    writeNullObject(), // exploreSquad
    writeSignedVarInt(0), // exploreEnhancePoint
  ]);
}

function buildBattleDeckIndexData(replay) {
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const playerDeck = dynamicGame.playerDeck && typeof dynamicGame.playerDeck === "object" ? dynamicGame.playerDeck : {};
  return buildSerializedDeckIndexData({
    deckType: Number(playerDeck.deckType || dynamicGame.deckType || 0),
    index: Number(
      playerDeck.deckIndex != null ? playerDeck.deckIndex : playerDeck.index != null ? playerDeck.index : dynamicGame.deckIndex || 0
    ),
  });
}

function buildRaidBossResultData() {
  return Buffer.concat([writeFloatLE(0), writeFloatLE(0), writeFloatLE(0), writeFloatLE(0)]);
}

function buildShadowGameResultData() {
  return Buffer.concat([
    writeSignedVarInt(0), // palaceId
    writeNullableObject(buildPalaceDungeonData()),
    writeNullObject(), // rewardData
    writeBool(false), // newRecord
    writeSignedVarInt(0), // currentDungeonId
    writeSignedVarInt(0), // life
  ]);
}

function buildPalaceDungeonData() {
  return Buffer.concat([
    writeSignedVarInt(0), // dungeonId
    writeSignedVarInt(0), // recentTime
    writeSignedVarInt(0), // bestTime
  ]);
}

function buildFierceResultData() {
  return Buffer.concat([
    writeSignedVarInt(0), // hpPercent
    writeFloatLE(0), // restTime
    writeSignedVarInt(0), // accquirePoint
    writeSignedVarInt(0), // bestPoint
    writeNullObject(), // bestDeck
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
    if (data.tutorial || isTutorialStageId(data.stageID) || isTutorialDungeonId(data.dungeonID)) {
      replacements.push({ ...spans.gameType, payload: writeSignedVarInt(NGT_TUTORIAL) });
    } else if (data.stageID || data.dungeonID) {
      replacements.push({ ...spans.gameType, payload: writeSignedVarInt(NGT_DUNGEON) });
    }
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

function ensureGameStartPackets(packets = [], replay = null, socket = null) {
  const user = socket && socket.session && socket.session.user;
  const loadCompletePayload = buildGameLoadCompleteAckPayload(replay, user);
  const sourcePackets = (Array.isArray(packets) ? packets : []).map((packet) => {
    if (!packet || packet.packetId !== GAME_LOAD_COMPLETE_ACK) return packet;
    return {
      ...packet,
      payload: loadCompletePayload,
      label: packet.label || "dynamic-load-complete",
    };
  });
  const output = [];
  if (!sourcePackets.some((packet) => packet && packet.packetId === GAME_LOAD_COMPLETE_ACK)) {
    output.push({
      packetId: GAME_LOAD_COMPLETE_ACK,
      payload: loadCompletePayload,
      label: "dynamic-load-complete",
    });
  }
  if (!sourcePackets.some((packet) => packet && packet.packetId === GAME_START_NOT)) {
    output.push({
      packetId: GAME_START_NOT,
      payload: Buffer.alloc(0),
      label: "dynamic-game-start",
    });
  }
  return output.concat(sourcePackets);
}

function getCapturedServerPayloadTemplate(packetId) {
  if (!capturedGameTemplateFlow || !Array.isArray(capturedGameTemplateFlow.server)) return null;
  const entry = capturedGameTemplateFlow.server.find((item) => item && item.packetId === packetId && item.payload);
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
  const gameTypeSpan = { start: offset, end: gameType.offset };
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
    gameType: gameTypeSpan,
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
  const mainStoryMapId = mainStoryMapIdForStageDungeon(stageID, dungeonID);
  if (mainStoryMapId || isMainStoryStageId(stageID) || isMainStoryDungeonId(dungeonID)) return mainStoryMapId;
  const tutorialMapId = tutorialMapIdForStageDungeon(stageID, dungeonID);
  if (tutorialMapId || isTutorialStageId(stageID) || isTutorialDungeonId(dungeonID)) return tutorialMapId;
  const stage = getGenericStageForRequest({ stageID, dungeonID });
  return Number((stage && stage.mapID) || 0);
}

function buildGameRespawnAckPayload(unitUID, assistUnit) {
  return combatHandler.buildGameRespawnAckPayload(unitUID, assistUnit);
}

function buildGameUnitSkillAckPayload(gameUnitUID, skillStateID = 0, errorCode = 0) {
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(Number(gameUnitUID || 0)),
    Buffer.from([Number(skillStateID || 0) & 0xff]),
  ]);
}

function buildGameShipSkillAckPayload(gameUnitUID, shipSkillID, skillPosX, errorCode = 0) {
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(Number(gameUnitUID || 0)),
    writeSignedVarInt(Number(shipSkillID || 0)),
    writeFloatLE(Number(skillPosX || 0)),
  ]);
}

function buildGamePauseAckPayload(isPause, isPauseEvent) {
  return Buffer.concat([writeSignedVarInt(0), writeBool(Boolean(isPause)), writeBool(Boolean(isPauseEvent))]);
}

function buildGameLoadCompleteAckPayload(replay = null, user = null) {
  const runtimeData = replay && replay.dynamicGame ? buildGameRuntimeData(replay, getReplayCombatControls(replay, user), user) : null;
  return Buffer.concat([
    writeSignedVarInt(0), // errorCode
    writeBool(false), // isIntrude
    runtimeData ? writeNullableObject(runtimeData) : writeNullObject(), // gameRuntimeData
    writeSignedVarInt(0), // rewardMultiply
  ]);
}

function buildGameRuntimeData(replay, controls, user) {
  const dynamicGame = replay && replay.dynamicGame && typeof replay.dynamicGame === "object" ? replay.dynamicGame : {};
  const battleState = replay && replay.battleState && typeof replay.battleState === "object" ? replay.battleState : {};
  const gameState = battleState.gameState && typeof battleState.gameState === "object" ? battleState.gameState : {};
  const gameTime = finiteNumber(battleState.gameTime ?? replay.syntheticGameTime, 4);
  const remainGameTime = finiteNumber(battleState.remainGameTime ?? dynamicGame.remainGameTime, 180);
  const waveId = Math.max(0, Math.trunc(finiteNumber(gameState.waveId ?? gameState.waveID ?? battleState.waveId, 1)));
  const state = clampCombatControlEnum(gameState.state ?? battleState.gameStateType ?? 3, 0, 7);
  const respawnCostA1 = finiteNumber(battleState.respawnCostA1 ?? dynamicGame.respawnCostA1, 10);
  const respawnCostB1 = finiteNumber(battleState.respawnCostB1 ?? dynamicGame.respawnCostB1, 10);
  return Buffer.concat([
    writeFloatLE(gameTime),
    writeSignedVarInt(controls.gameSpeedType),
    writeFloatLE(0), // m_PrevWaveEndTime
    writeSignedVarInt(state), // NKM_GAME_STATE
    writeSignedVarInt(waveId),
    writeFloatLE(remainGameTime),
    writeFloatLE(0), // m_fShipDamage
    writeSignedVarInt(0), // NKM_TEAM_TYPE.NTT_INVALID
    writeBool(false), // m_bGameEnded
    writeBool(false), // m_bPause
    writeBool(false), // m_bGiveUp
    writeBool(false), // m_bRestart
    writeNullableObject(buildGameRuntimeTeamData(user && user.userUid, {
      autoRespawnEnabled: controls.autoRespawnEnabled,
      autoSkillType: controls.autoSkillType,
      respawnCost: respawnCostA1,
    })),
    writeNullableObject(buildGameRuntimeTeamData(0, {
      autoRespawnEnabled: false,
      autoSkillType: 0,
      respawnCost: respawnCostB1,
    })),
    writeObjectList([]), // m_lstPermanentDungeonEvent
  ]);
}

function buildGameRuntimeTeamData(userUid, options = {}) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(userUid || 0)),
    writeBool(Boolean(options.autoRespawnEnabled)),
    writeBool(false), // m_bAIDisable
    writeBool(false), // m_bGodMode
    writeFloatLE(finiteNumber(options.respawnCost, 10)),
    writeFloatLE(finiteNumber(options.respawnCostAssist, 0)),
    writeFloatLE(finiteNumber(options.usedRespawnCost, 0)),
    writeSignedVarInt(Math.max(0, Math.trunc(finiteNumber(options.respawnCount, 0)))),
    writeSignedVarInt(clampCombatControlEnum(options.autoSkillType, 0, 1)),
  ]);
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildStagePlayData(stageId, battleState = {}) {
  return Buffer.concat([
    writeSignedVarInt(stageId),
    writeSignedVarLong(1n),
    writeSignedVarLong(0n),
    writeSignedVarLong(0n),
    writeInt64LE(dateTimeBinaryNow()),
    writeSignedVarInt(Math.max(0, Math.round(Number(battleState.gameTime || battleState.GameTime || 0)))),
    writeSignedVarLong(1n),
  ]);
}

function stageIdForDungeonId(dungeonId) {
  return mainStoryStageIdForDungeonId(dungeonId) || tutorialStageIdForDungeonId(dungeonId) || findStageIdForDungeonId(dungeonId);
}

function loadDungeonCatalog() {
  if (cachedDungeonCatalog) return cachedDungeonCatalog;
  cachedDungeonCatalog = { byId: {}, byStrId: {} };
  if (DUNGEON_TABLE_PATH && fs.existsSync(DUNGEON_TABLE_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DUNGEON_TABLE_PATH, "utf8"));
      cachedDungeonCatalog = parsed && typeof parsed === "object" ? parsed : cachedDungeonCatalog;
      ensureDungeonCatalogIndexes(cachedDungeonCatalog);
      return cachedDungeonCatalog;
    } catch (err) {
      console.log(`[dungeon-table] failed to load ${DUNGEON_TABLE_PATH}: ${summarizeErrorLine(err)}`);
    }
  }
  cachedDungeonCatalog = buildDungeonCatalogFromGameplayJsons();
  return cachedDungeonCatalog;
}

function buildDungeonCatalogFromGameplayJsons() {
  const catalog = { byId: {}, byStrId: {} };
  const records = readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json", {
    rootDir: ROOT_DIR,
    logLabel: "dungeon-table",
  });
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const dungeonId = Number(record.m_DungeonID || 0);
    const dungeonStrId = String(record.m_DungeonStrID || "");
    if (Number.isInteger(dungeonId) && dungeonId > 0) catalog.byId[String(dungeonId)] = record;
    if (dungeonStrId) catalog.byStrId[dungeonStrId] = record;
  }
  if (records.length) catalog.count = Object.keys(catalog.byId).length;
  return catalog;
}

function ensureDungeonCatalogIndexes(catalog) {
  if (!catalog || typeof catalog !== "object") return;
  catalog.byId = catalog.byId && typeof catalog.byId === "object" ? catalog.byId : {};
  catalog.byStrId = catalog.byStrId && typeof catalog.byStrId === "object" ? catalog.byStrId : {};
  for (const row of Object.values(catalog.byId)) {
    const strId = String(row && row.m_DungeonStrID ? row.m_DungeonStrID : "");
    if (strId && !catalog.byStrId[strId]) catalog.byStrId[strId] = row;
  }
}

function getDungeonTableEntry(dungeonId) {
  const catalog = loadDungeonCatalog();
  const byId = catalog && catalog.byId && typeof catalog.byId === "object" ? catalog.byId : {};
  return byId[String(Number(dungeonId || 0))] || null;
}

function loadStageCatalog() {
  if (cachedStageCatalog) return cachedStageCatalog;
  cachedStageCatalog = { byId: {}, byBattleStrId: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(STAGE_TABLE_PATH, "utf8"));
    const records = Array.isArray(parsed && parsed.records) ? parsed.records : Array.isArray(parsed) ? parsed : [];
    const byId = {};
    const byBattleStrId = {};
    for (const record of records) {
      const stageId = Number(record && (record.m_StageID || record.StageID || record.stageId || 0));
      if (Number.isInteger(stageId) && stageId > 0) byId[String(stageId)] = record;
      const battleStrId = String((record && (record.m_StageBattleStrID || record.StageBattleStrID)) || "");
      if (battleStrId) {
        if (!byBattleStrId[battleStrId]) byBattleStrId[battleStrId] = [];
        byBattleStrId[battleStrId].push(record);
      }
    }
    cachedStageCatalog = { byId, byBattleStrId };
  } catch (err) {
    console.log(`[stage-table] failed to load ${STAGE_TABLE_PATH}: ${summarizeErrorLine(err)}`);
  }
  return cachedStageCatalog;
}

function getStageTableEntry(stageId) {
  const catalog = loadStageCatalog();
  const byId = catalog && catalog.byId && typeof catalog.byId === "object" ? catalog.byId : {};
  return byId[String(Number(stageId || 0))] || null;
}

function getStageTableEntriesForBattleStrId(battleStrId) {
  const catalog = loadStageCatalog();
  const byBattleStrId =
    catalog && catalog.byBattleStrId && typeof catalog.byBattleStrId === "object" ? catalog.byBattleStrId : {};
  return Array.isArray(byBattleStrId[String(battleStrId || "")]) ? byBattleStrId[String(battleStrId || "")] : [];
}

function getDungeonTableEntryByStrId(dungeonStrId) {
  const strId = String(dungeonStrId || "");
  if (!strId) return null;
  const catalog = loadDungeonCatalog();
  const byStrId = catalog && catalog.byStrId && typeof catalog.byStrId === "object" ? catalog.byStrId : {};
  return byStrId[strId] || null;
}

function findStageRowForDungeonId(dungeonId) {
  const dungeon = getDungeonTableEntry(dungeonId);
  const dungeonStrId = String(dungeon && dungeon.m_DungeonStrID ? dungeon.m_DungeonStrID : "");
  if (!dungeonStrId) return null;
  return chooseStageRow(getStageTableEntriesForBattleStrId(dungeonStrId));
}

function findStageIdForDungeonId(dungeonId) {
  const stage = findStageRowForDungeonId(dungeonId);
  return Number(stage && (stage.m_StageID || stage.StageID || stage.stageId || 0)) || 0;
}

function chooseStageRow(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return null;
  const normalRows = list.filter((row) => String(row.m_Difficulty || row.Difficulty || "NORMAL") === "NORMAL");
  const candidates = normalRows.length ? normalRows : list;
  return candidates
    .slice()
    .sort(
      (left, right) =>
        Number(left.m_ActID || left.ActID || 0) - Number(right.m_ActID || right.ActID || 0) ||
        Number(left.m_StageIndex || left.StageIndex || 0) - Number(right.m_StageIndex || right.StageIndex || 0) ||
        Number(left.m_StageID || left.StageID || 0) - Number(right.m_StageID || right.StageID || 0)
    )[0];
}

function getGenericStageForRequest(req = {}) {
  const requestedStageId = Number((req && req.stageID) || 0);
  const requestedDungeonId = Number((req && req.dungeonID) || 0);
  let stageRow = requestedStageId > 0 ? getStageTableEntry(requestedStageId) : null;
  let dungeon = null;

  if (stageRow && stageRow.m_StageBattleStrID) {
    dungeon = getDungeonTableEntryByStrId(stageRow.m_StageBattleStrID);
  }
  if (!dungeon && requestedDungeonId > 0) {
    dungeon = getDungeonTableEntry(requestedDungeonId);
  }
  if (!stageRow && dungeon) {
    stageRow = findStageRowForDungeonId(Number(dungeon.m_DungeonID || requestedDungeonId || 0));
  }
  if (!dungeon || !stageRow) return null;

  const stageId = Number(stageRow.m_StageID || stageRow.StageID || requestedStageId || 0);
  const dungeonID = Number(dungeon.m_DungeonID || requestedDungeonId || 0);
  if (!stageId || !dungeonID) return null;

  const dungeonType = String(dungeon.m_DungeonType || "");
  const cutsceneOnly = dungeonType === "NDT_CUTSCENE";
  const mapStrID = String(dungeon.m_DungeonMapStrID || "");
  return {
    stageId,
    stageStrID: String(stageRow.m_StageStrID || ""),
    dungeonID,
    dungeonStrID: String(dungeon.m_DungeonStrID || stageRow.m_StageBattleStrID || ""),
    mapID: cutsceneOnly ? 0 : mapIdForMapStrId(mapStrID),
    mapStrID,
    episodeId: Number(stageRow.m_EpisodeID || 0),
    actId: Number(stageRow.m_ActID || 0),
    stageIndex: Number(stageRow.m_StageIndex || 0),
    stageUINum: Number(stageRow.m_StageUINum || stageRow.m_StageIndex || 0),
    stageType: String(stageRow.m_StageType || ""),
    stageSubType: String(stageRow.m_StageSubType || ""),
    dungeonType,
    eventDeckId: cutsceneOnly ? 0 : resolveGenericEventDeckId(stageRow, dungeon),
    tutorial: false,
    cutsceneOnly,
    initialUnits: [],
    autoDeployUnits: [],
  };
}

function resolveGenericEventDeckId(stageRow, dungeon) {
  const explicit = Number(dungeon && dungeon.m_UseEventDeck);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const dungeonId = Number(dungeon && dungeon.m_DungeonID);
  if (dungeonId > 0 && getEventDeckTemplet(dungeonId)) return dungeonId;
  return 0;
}

function mapIdForMapStrId(mapStrId) {
  const strId = String(mapStrId || "");
  if (!strId) return 0;
  const map = loadMapIdByStrId();
  return Number(map.get(strId) || 0) || 0;
}

function loadMapIdByStrId() {
  if (cachedMapIdByStrId) return cachedMapIdByStrId;
  cachedMapIdByStrId = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(MAP_TABLE_PATH, "utf8"));
    const records = Array.isArray(parsed && parsed.records) ? parsed.records : Array.isArray(parsed) ? parsed : [];
    for (const record of records) {
      const mapStrId = String(record && record.m_MapStrID ? record.m_MapStrID : "");
      const mapId = Number(record && record.m_MapID);
      if (mapStrId && Number.isInteger(mapId) && mapId > 0) cachedMapIdByStrId.set(mapStrId, mapId);
    }
  } catch (err) {
    console.log(`[map-table] failed to load ${MAP_TABLE_PATH}: ${summarizeErrorLine(err)}`);
  }
  return cachedMapIdByStrId;
}

function getDungeonRewardGroupIds(dungeonEntry) {
  if (!dungeonEntry || typeof dungeonEntry !== "object") return [];
  return Object.keys(dungeonEntry)
    .filter((key) => /^m_RewardGroupID_\d+$/.test(key))
    .sort((left, right) => Number(left.match(/\d+$/)[0]) - Number(right.match(/\d+$/)[0]))
    .map((key) => Number(dungeonEntry[key] || 0))
    .filter((groupId) => Number.isInteger(groupId) && groupId > 0);
}

function getDungeonUnitExpReward(dungeonId) {
  const entry = getDungeonTableEntry(dungeonId);
  return Math.max(0, Number(entry && entry.m_RewardUnitEXP) || 0);
}

function getDungeonUserExpReward(dungeonId) {
  const entry = getDungeonTableEntry(dungeonId);
  return Math.max(0, Number(entry && entry.m_RewardUserEXP) || 0);
}

function getOrGrantStageClearLoot(replay, user, dungeonId, stageId) {
  const userUid = user && user.userUid ? String(toBigInt(user.userUid || 0)) : "";
  if (
    replay &&
    replay.stageClearLoot &&
    Number(replay.stageClearLoot.dungeonId) === Number(dungeonId) &&
    (!userUid || replay.stageClearLoot.userUid === userUid)
  ) {
    return replay.stageClearLoot;
  }

  const result = grantStageClearLoot(user, dungeonId, stageId, { replay });
  if (replay && typeof replay === "object") replay.stageClearLoot = result;
  return result;
}

function maybeGrantBattleStageClearLoot(replay, user, dungeonId, stageId, battleState = null) {
  if (!user || !replay || !replay.dynamicGame || replay.dynamicGame.tutorial) return null;
  if (Number(replay.dynamicGame.dungeonID || 0) !== Number(dungeonId || 0)) return null;
  const state = battleState || replay.battleState || replay.battleSim || {};
  if (!isBattleWin(state)) return null;
  return getOrGrantStageClearLoot(replay, user, dungeonId, stageId);
}

function grantStageClearLoot(user, dungeonId, stageId, options = {}) {
  const entry = getDungeonTableEntry(dungeonId);
  const reward = createEmptyReward();
  const unitExp = getDungeonUnitExpReward(dungeonId);
  const userExp = getDungeonUserExpReward(dungeonId);
  const firstClear = !(
    user &&
    user.dungeonClear &&
    typeof user.dungeonClear === "object" &&
    user.dungeonClear[String(Number(dungeonId || 0))]
  );
  const result = {
    userUid: user && user.userUid ? String(toBigInt(user.userUid || 0)) : "",
    dungeonId: Number(dungeonId || 0),
    stageId: Number(stageId || 0),
    reward,
    unitExp,
    userExp,
    rewardGroupIds: [],
    changed: false,
  };
  if (!entry || !user || typeof user !== "object") return result;

  const ctx = { dateTimeBinaryNow };
  const regDate = dateTimeBinaryNow();
  const creditAmount = pickDungeonRewardQuantity(user, `credit:${dungeonId}`, entry.m_RewardCredit_Min, entry.m_RewardCredit_Max);
  if (creditAmount > 0) {
    mergeReward(
      reward,
      grantRewardByType(ctx, user, "RT_MISC", RESOURCE_ITEM_IDS.CREDIT, creditAmount, creditAmount, 0, {
        regDate,
        expandPackages: false,
      })
    );
  }

  if (firstClear) {
    mergeReward(reward, grantStageFirstClearReward(ctx, user, stageId, { regDate }));
  }

  const mainReward = grantStageMainReward(ctx, user, stageId, { regDate });
  mergeReward(reward, mainReward.reward);

  const rewardGroupIds = getDungeonRewardGroupIds(entry);
  result.rewardGroupIds = rewardGroupIds;
  for (const groupId of rewardGroupIds) {
    const record = pickStageRewardRecord(getRewardGroupRecords(groupId), user, groupId);
    if (!record) continue;
    mergeReward(reward, grantRewardRecord(ctx, user, record, { regDate }));
  }

  reward.userExp = userExp;
  const combatExpResult = applyCombatExpToLocalRoster(user, options.replay, unitExp);
  const unitExpDataList = combatExpResult.unitExpDataList;
  if (unitExpDataList.length) reward.unitExpDataList = unitExpDataList;
  result.operatorExpApplied = combatExpResult.operatorExpApplied;
  result.changed = hasRewardPayload(reward) || combatExpResult.operatorExpApplied;
  if (result.changed && USE_LOCAL_USER_DB) saveUserDb();
  console.log(
    `[stage-loot] dungeonID=${dungeonId} stageID=${stageId} credits=${creditAmount} main=${
      mainReward.summary || "-"
    } groups=${rewardGroupIds.join(",") || "-"} misc=${
      reward.miscItems.length
    } units=${reward.units.length} operators=${reward.operators.length} equips=${reward.equips.length} unitExpTargets=${unitExpDataList.length}`
  );
  return result;
}

function grantStageFirstClearReward(ctx, user, stageId, options = {}) {
  const stage = getStageTableEntry(stageId);
  const rewardType = String(stage && (stage.m_FirstReward_Type || stage.FirstRewardType || ""));
  const rewardId = Number(stage && (stage.m_FirstReward_ID || stage.FirstRewardID || 0));
  const rewardQuantity = Math.max(0, Number(stage && (stage.m_FirstRewardQuantity || stage.FirstRewardQuantity || 0)) || 0);
  if (!rewardType || rewardType === "RT_NONE" || rewardId <= 0 || rewardQuantity <= 0) return createEmptyReward();
  return grantRewardByType(ctx, user, rewardType, rewardId, rewardQuantity, rewardQuantity, 0, {
    regDate: options.regDate,
    expandPackages: false,
  });
}

function grantStageMainReward(ctx, user, stageId, options = {}) {
  const stage = getStageTableEntry(stageId);
  const rewardType = String(stage && (stage.m_MainRewardType || stage.MainRewardType || ""));
  const rewardId = Number(stage && (stage.m_MainRewardID || stage.MainRewardID || 0));
  const minQuantity = Math.max(0, Number(stage && (stage.m_MainRewardMin || stage.MainRewardMin || 0)) || 0);
  const maxQuantity = Math.max(minQuantity, Number(stage && (stage.m_MainRewardMax || stage.MainRewardMax || minQuantity)) || minQuantity);
  if (!rewardType || rewardType === "RT_NONE" || rewardId <= 0 || maxQuantity <= 0) {
    return { reward: createEmptyReward(), summary: "" };
  }
  if (!stageMainRewardProbabilityPass(user, stageId, stage && (stage.m_MainRewardProbability || stage.MainRewardProbability))) {
    return { reward: createEmptyReward(), summary: "" };
  }
  const quantity = pickDungeonRewardQuantity(user, `stage-main:${stageId}:${rewardType}:${rewardId}`, minQuantity, maxQuantity);
  if (quantity <= 0) return { reward: createEmptyReward(), summary: "" };
  return {
    reward: grantRewardByType(ctx, user, rewardType, rewardId, quantity, quantity, 0, {
      regDate: options.regDate,
      expandPackages: false,
    }),
    summary: `${rewardType}:${rewardId}x${quantity}`,
  };
}

function stageMainRewardProbabilityPass(user, stageId, probability) {
  const chance = Math.max(0, Math.trunc(Number(probability == null ? 10000 : probability) || 0));
  if (chance >= 10000) return true;
  if (chance <= 0) return false;
  return nextStageRewardCursor(user, `stage-main-prob:${stageId}`) % 10000 < chance;
}

function hasRewardPayload(reward) {
  if (!reward || typeof reward !== "object") return false;
  if (Number(reward.userExp || 0) > 0) return true;
  return ["miscItems", "skinIds", "emoticonIds", "units", "operators", "equips", "unitExpDataList"].some(
    (key) => Array.isArray(reward[key]) && reward[key].length > 0
  );
}

function applyCombatExpToLocalRoster(user, replay, unitExp) {
  const exp = Math.max(0, Math.trunc(Number(unitExp || 0) || 0));
  if (!user || typeof user !== "object" || exp <= 0) return { unitExpDataList: [], operatorExpApplied: false };

  const unitUids = resolveCombatUnitExpTargets(replay);
  const unitExpDataList = [];
  for (const unitUid of unitUids) {
    const unit = getArmyUnitByUid(user, unitUid);
    if (!unit) continue;
    const updated = addUnitExp(user, unitUid, exp) || unit;
    if (!updated) continue;
    unitExpDataList.push({ unitUid, exp, bonusExp: 0, bonusRatio: 0 });
  }

  const operatorUid = resolveCombatOperatorExpTarget(replay);
  const operatorExpApplied = Boolean(operatorUid && getArmyOperatorByUid(user, operatorUid) && addOperatorExp(user, operatorUid, exp));
  return { unitExpDataList, operatorExpApplied };
}

function resolveCombatUnitExpTargets(replay) {
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const deckUnits = dynamicGame.playerDeck && Array.isArray(dynamicGame.playerDeck.units) ? dynamicGame.playerDeck.units : [];
  const fromDeck = deckUnits
    .map((unit) => unit && (unit.unitUid || unit.m_UnitUID || unit.sourceUnitUID))
    .filter(Boolean);
  const battleState = replay && replay.battleState ? replay.battleState : {};
  const fromBattleState = (Array.isArray(battleState.units) ? battleState.units : [])
    .map((unit) => unit && (unit.sourceUnitUID || unit.unitUID || unit.unitUid))
    .filter(Boolean);
  return uniquePositiveLongStrings(fromDeck.length ? fromDeck : fromBattleState);
}

function resolveCombatOperatorExpTarget(replay) {
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const operatorUid =
    dynamicGame.playerDeck &&
    (dynamicGame.playerDeck.operatorUid || dynamicGame.playerDeck.operatorUID || dynamicGame.playerDeck.operatorUIDString);
  const normalized = toBigInt(operatorUid || 0);
  return normalized > 0n ? normalized.toString() : "";
}

function uniquePositiveLongStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(toBigInt(value || 0)))
        .filter((value) => toBigInt(value) > 0n)
    )
  );
}

function pickStageRewardRecord(records, user, groupId) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return null;
  const totalWeight = list.reduce((sum, record) => sum + Math.max(0, Number(record.m_Ratio || 1)), 0);
  if (totalWeight <= 0) return list[0];

  let target = nextStageRewardCursor(user, `group:${groupId}`) % totalWeight;
  for (const record of list) {
    target -= Math.max(0, Number(record.m_Ratio || 1));
    if (target < 0) return record;
  }
  return list[0];
}

function pickDungeonRewardQuantity(user, key, minValue, maxValue) {
  const min = Math.max(0, Math.floor(Number(minValue || 0)));
  const max = Math.max(min, Math.floor(Number(maxValue || min)));
  if (max <= min) return min;
  const cursor = nextStageRewardCursor(user, key);
  return min + (cursor % (max - min + 1));
}

function nextStageRewardCursor(user, key) {
  if (!user || typeof user !== "object") return 0;
  user.localStageRewardCursors =
    user.localStageRewardCursors && typeof user.localStageRewardCursors === "object" ? user.localStageRewardCursors : {};
  const cursor = Math.max(0, Number(user.localStageRewardCursors[key] || 0) || 0);
  user.localStageRewardCursors[key] = cursor + 1;
  return cursor;
}

function getBattlePlayTime(battleState = {}) {
  return Math.max(
    0,
    Number(
      battleState.gameTime ??
        battleState.GameTime ??
        battleState.totalPlayTime ??
        battleState.TotalPlayTime ??
        battleState.clearTimeSec ??
        battleState.ClearTimeSec ??
        0
    ) || 0
  );
}

function resolveBattleWin(battleState = {}, options = {}) {
  if (typeof options.win === "boolean") return options.win;
  if (options.preferFallbackWin && typeof options.fallbackWin === "boolean") return options.fallbackWin;

  const inferredWin = inferBattleWinFromUnits(battleState);
  if (typeof inferredWin === "boolean") return inferredWin;

  const stateWin = resolveBattleWinTeam(battleState);
  if (typeof stateWin === "boolean") return stateWin;

  if (battleState && typeof battleState === "object") {
    if (battleState.win != null) return Boolean(battleState.win);
    if (battleState.Win != null) return Boolean(battleState.Win);
  }

  if (typeof options.fallbackWin === "boolean") return options.fallbackWin;
  return false;
}

function resolveBattleWinTeam(battleState = {}) {
  const candidates = [
    battleState && battleState.gameState && battleState.gameState.winTeam,
    battleState && battleState.GameState && battleState.GameState.WinTeam,
    battleState && battleState.gameState && battleState.gameState.WinTeam,
    battleState && battleState.GameState && battleState.GameState.winTeam,
    battleState && battleState.winTeam,
    battleState && battleState.WinTeam,
  ];
  const pendingStates = []
    .concat(Array.isArray(battleState.pendingGameStates) ? battleState.pendingGameStates : [])
    .concat(Array.isArray(battleState.PendingGameStates) ? battleState.PendingGameStates : []);
  for (let index = pendingStates.length - 1; index >= 0; index -= 1) {
    const pending = pendingStates[index] || {};
    candidates.push(pending.winTeam, pending.WinTeam);
  }

  for (const value of candidates) {
    const winTeam = Number(value || 0);
    if (!winTeam) continue;
    if (winTeam === 1 || winTeam === 2) return true;
    if (winTeam === 3) return false;
  }
  return null;
}

function inferBattleWinFromUnits(battleState = {}) {
  const units = Array.isArray(battleState.units)
    ? battleState.units
    : Array.isArray(battleState.Units)
      ? battleState.Units
      : [];
  if (!units.length) return null;
  const liveUnits = units.filter((unit) => {
    const hp = Number(unit && (unit.hp ?? unit.Hp ?? 0));
    const playState = Number(unit && (unit.playState ?? unit.PlayState ?? 1));
    return hp > 0 && playState !== 0 && playState !== 2;
  });
  const liveEnemies = liveUnits.filter((unit) => Number(unit.team ?? unit.Team ?? 0) !== 1);
  const livePlayers = liveUnits.filter((unit) => Number(unit.team ?? unit.Team ?? 0) === 1);
  if (liveEnemies.length === 0) return true;
  if (livePlayers.length === 0 && liveEnemies.length > 0) return false;
  return null;
}

function normalizeBattleResultState(battleState, win) {
  if (!battleState || typeof battleState !== "object") return;
  const resolvedWin = Boolean(win);
  const waveId = Number(
    (battleState.gameState && (battleState.gameState.waveId ?? battleState.gameState.WaveId)) ??
      (battleState.GameState && (battleState.GameState.WaveId ?? battleState.GameState.waveId)) ??
      1
  ) || 1;
  const winTeam = resolvedWin ? 1 : 3;
  battleState.finished = true;
  battleState.Finished = true;
  battleState.win = resolvedWin;
  battleState.Win = resolvedWin;
  battleState.gameState = { ...(battleState.gameState || {}), state: 4, winTeam, waveId };
  battleState.GameState = { ...(battleState.GameState || {}), State: 4, WinTeam: winTeam, WaveId: waveId };
  normalizePendingBattleGameStates(battleState.pendingGameStates, { state: 4, winTeam, waveId });
  normalizePendingBattleGameStates(battleState.PendingGameStates, { State: 4, WinTeam: winTeam, WaveId: waveId });
}

function normalizePendingBattleGameStates(states, finalState) {
  if (!Array.isArray(states)) return;
  const last = states.length > 0 ? states[states.length - 1] : null;
  if (last && typeof last === "object") {
    Object.assign(last, finalState);
    return;
  }
  states.push({ ...finalState });
}

function isBattleWin(battleState = {}) {
  return resolveBattleWin(battleState);
}

function resolveDungeonMissionResults(dungeonId, options = {}) {
  if (typeof options.missionResult1 === "boolean" || typeof options.missionResult2 === "boolean") {
    return {
      missionResult1: Boolean(options.missionResult1),
      missionResult2: Boolean(options.missionResult2),
    };
  }
  if (options.forceMissionSuccess) return { missionResult1: true, missionResult2: true };
  if (typeof options.win !== "boolean") {
    // Preserve legacy callers that only need a completed clear entry.
    return { missionResult1: true, missionResult2: true };
  }
  const win = Boolean(options.win);
  if (!win) return { missionResult1: false, missionResult2: false };
  const entry = getDungeonTableEntry(dungeonId);
  const battleState = options.battleState || {};
  return {
    missionResult1: evaluateDungeonMission(entry && entry.m_DGMissionType_1, entry && entry.m_DGMissionValue_1, battleState, win),
    missionResult2: evaluateDungeonMission(entry && entry.m_DGMissionType_2, entry && entry.m_DGMissionValue_2, battleState, win),
  };
}

function evaluateDungeonMission(type, value, battleState, win) {
  const missionType = String(type || "").trim();
  if (!missionType || missionType === "DGMT_NONE") return Boolean(win);
  if (!win) return false;
  const missionValue = Number(value || 0);
  switch (missionType) {
    case "DGMT_CLEAR":
      return true;
    case "DGMT_TIME":
      return missionValue <= 0 || getBattlePlayTime(battleState) <= missionValue;
    case "DGMT_COST": {
      const usedCost = Number(
        battleState.usedRespawnCostA1 ??
          battleState.UsedRespawnCostA1 ??
          battleState.usedRespawnCost ??
          battleState.UsedRespawnCost ??
          0
      );
      return missionValue <= 0 || usedCost <= missionValue;
    }
    case "DGMT_RESPAWN": {
      const deployCount = Number(battleState.deployCount ?? battleState.DeployCount ?? battleState.respawnCount ?? 0);
      return missionValue <= 0 || deployCount <= missionValue;
    }
    case "DGMT_SHIP_HP_DAMAGE": {
      const shipHpDamage = Number(battleState.shipHpDamagePercent ?? battleState.ShipHpDamagePercent ?? 0);
      return missionValue <= 0 || shipHpDamage <= missionValue;
    }
    default:
      // Deck-count and kill-count objectives need richer combat bookkeeping.
      // Gate them on win for now so the normal result screen works without
      // inventing false negatives for missions we do not yet track.
      return true;
  }
}

function buildDungeonClearData(dungeonId, options = {}) {
  const missionResults = resolveDungeonMissionResults(dungeonId, options);
  const rewardData = options.reward || options.rewardData || null;
  const unitExp = options.unitExp != null ? options.unitExp : 0;
  return Buffer.concat([
    writeSignedVarInt(dungeonId),
    writeBool(missionResults.missionResult1),
    writeBool(missionResults.missionResult2),
    writeNullObject(),
    writeBool(false),
    writeNullObject(),
    writeBoolList([]),
    writeNullableObject(rewardData ? buildSerializedRewardData(rewardData) : buildEmptyRewardData()),
    writeSignedVarInt(Math.max(0, Number(unitExp || 0) || 0)),
  ]);
}

function trackStageClearMissionProgress(user, dungeonId, stageId, battleState = {}) {
  if (!user || typeof user !== "object") return false;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  if (!resolvedDungeonId && !resolvedStageId) return false;
  const now = dateTimeBinaryNow();
  const details = {
    now,
    dungeonId: resolvedDungeonId,
    stageId: resolvedStageId,
    value: resolvedDungeonId || resolvedStageId,
  };
  let changed = false;
  const changedConditions = new Set();
  const track = (condition, amount, extraDetails = details) => {
    const tracked = trackMissionEvent(user, condition, amount, extraDetails);
    if (tracked) changedConditions.add(condition);
    changed = tracked || changed;
  };
  track("DUNGEON_CLEAR", 1);
  track("DUNGEON_CLEARED", 1);
  track("PHASE_CLEAR", 1);
  track("PHASE_CLEARED", 1);
  track("WARFARE_CLEAR", 1);
  track("WARFARE_CLEARED", 1);
  track("DAILY_DUNGEON_PLAY", 1);
  track("EC_SUPPLY_CLEAR", 1);
  track("EC_SUPPLY_CLEARED", 1);
  const missionResults = resolveDungeonMissionResults(resolvedDungeonId, {
    win: true,
    battleState,
    missionResult1: battleState && battleState.missionResult1,
    missionResult2: battleState && battleState.missionResult2,
  });
  if (missionResults.missionResult1 !== false && missionResults.missionResult2 !== false) {
    track("DUNGEON_CLEAR_PERFECT", 1);
    track("PHASE_CLEAR_PERFECT", 1);
    track("PHASE_CLEARED_PERFECT", 1);
    track("WARFARE_CLEAR_PERFECT", 1);
    track("WARFARE_CLEARED_PERFECT", 1);
  }
  const eterniumCost = getStageEterniumCost(resolvedStageId);
  if (eterniumCost > 0) {
    track("USE_ETERNIUM", eterniumCost, {
      ...details,
      itemId: RESOURCE_ITEM_IDS.ETERNIUM,
      resourceId: RESOURCE_ITEM_IDS.ETERNIUM,
    });
  }
  if (changed) refreshMissionProgress(user, { now, conditions: Array.from(changedConditions) });
  return changed;
}

function sendStageClearMissionUpdate(socket, user, options = {}) {
  sendMissionUpdateForTabs(socket, user, FAST_LOBBY_MISSION_TABS, {
    ...options,
    label: options.label || "stage-clear-mission-update",
  });
}

function repairPostTutorialGuideMissionsForSocket(socket, options = {}) {
  const user = socket && socket.session && socket.session.user;
  if (!user || typeof user !== "object") return 0;
  if (CLEAR_ALL_MISSIONS_STATUS) return 0;
  const repaired = repairPostTutorialGuideMissionCompletions(user);
  if (repaired > 0 && USE_LOCAL_USER_DB) saveUserDb();
  if (options.notify !== false) sendPostTutorialGuideMissionCompleteAck(socket, user, options);
  return repaired;
}

function sendPostTutorialGuideMissionCompleteAck(socket, user, options = {}) {
  if (!user || typeof user !== "object") return false;
  if (!socket || !socket.session || !socket.session.gameReplay) return false;
  const replay = socket.session.gameReplay;
  if (options.once !== false && replay.postTutorialGuideMissionCompleteAckSent) return false;
  let sent = false;
  for (const missionId of POST_TUTORIAL_GUIDE_MISSION_IDS) {
    const mission = findCompletedMissionById(user, missionId);
    if (!mission || !(mission.rewardClaimed === true || mission.isComplete === true || mission.claimedAt)) continue;
    sendServerGamePacket(
      socket,
      MISSION_COMPLETE_ACK,
      buildMissionCompleteAckPayload({ missionID: Number(missionId) }),
      options.label || "post-tutorial-guide-mission-complete"
    );
    sent = true;
  }
  if (sent) replay.postTutorialGuideMissionCompleteAckSent = true;
  return sent;
}

function sendMissionUpdateForTabs(socket, user, tabIds, options = {}) {
  if (!user || typeof user !== "object") return false;
  if (!socket || !socket.session || !socket.session.gameReplay) return false;
  const now = options.now || dateTimeBinaryNow();
  const seen = new Set();
  const missions = [];
  for (const tabId of uniqueMissionTabs(tabIds)) {
    for (const [, mission] of buildAccountMissionDataEntries(user, { tabId, now })) {
      const key = `${Number(mission && mission.groupId || 0)}:${Number(mission && mission.missionID || 0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      missions.push(mission);
    }
  }
  if (missions.length <= 0) return false;
  sendServerGamePacket(
    socket,
    MISSION_UPDATE_NOT,
    writeObjectList(missions.map((mission) => writeNullableObject(buildMissionData(Number(mission && mission.missionID || 0), mission)))),
    options.label || "mission-update"
  );
  return true;
}

function getStageEterniumCost(stageId) {
  const stage = getStageTableEntry(stageId);
  const reqItemId = Number(stage && (stage.m_StageReqItemID || stage.StageReqItemID || 0));
  if (reqItemId !== RESOURCE_ITEM_IDS.ETERNIUM) return 0;
  return Math.max(0, Number(stage && (stage.m_StageReqItemCount || stage.StageReqItemCount || 0)) || 0);
}

function getStageReqItemCost(stageId) {
  const stage = getStageTableEntry(stageId);
  const itemId = Number(stage && (stage.m_StageReqItemID || stage.StageReqItemID || 0));
  const count = Math.max(0, Number(stage && (stage.m_StageReqItemCount || stage.StageReqItemCount || 0)) || 0);
  if (!Number.isInteger(itemId) || itemId <= 0 || count <= 0) return null;
  return { itemId, count };
}

function spendStageReqItemCost(user, stageId, options = {}) {
  if (!user || typeof user !== "object") return [];
  const cost = getStageReqItemCost(stageId);
  if (!cost) return [];
  const multiplier = Math.max(1, Number(options.multiplier || 1) || 1);
  const totalCount = cost.count * multiplier;
  stamina.refreshTimedStamina(user, {
    now: dateTimeBinaryNow(),
    itemIds: [cost.itemId],
    initializeMissing: true,
  });
  const updated = spendMiscItem(user, cost.itemId, totalCount, { regDate: dateTimeBinaryNow() });
  return updated ? [updated] : [];
}

function spendStageReqItemCostForReplay(replay, user, stageId) {
  if (!replay || !user) return [];
  const dynamicGame = replay.dynamicGame && typeof replay.dynamicGame === "object" ? replay.dynamicGame : {};
  const key = `${Number(stageId || 0)}:${String(dynamicGame.gameUID || dynamicGame.gameUid || "")}`;
  replay.spentStageReqItemCosts = replay.spentStageReqItemCosts && typeof replay.spentStageReqItemCosts === "object" ? replay.spentStageReqItemCosts : {};
  if (replay.spentStageReqItemCosts[key]) return [];
  const costItems = spendStageReqItemCost(user, stageId);
  replay.spentStageReqItemCosts[key] = true;
  return costItems;
}

function buildPhaseClearData(stageId, options = {}) {
  const missionResult1 =
    typeof options.missionResult1 === "boolean"
      ? options.missionResult1
      : options.forceMissionSuccess
        ? true
        : options.win === false
          ? false
          : true;
  const missionResult2 =
    typeof options.missionResult2 === "boolean"
      ? options.missionResult2
      : options.forceMissionSuccess
        ? true
        : options.win === false
          ? false
          : true;
  return Buffer.concat([
    writeSignedVarInt(Number(stageId || 0)),
    writeBool(missionResult1), // missionResult1
    writeBool(missionResult2), // missionResult2
    writeNullableObject(buildEmptyRewardData()), // missionReward
    writeBool(false), // missionRewardResult
    writeNullableObject(buildEmptyRewardData()), // oneTimeRewards
    writeBoolList([]), // onetimeRewardResults
    writeNullableObject(buildEmptyRewardData()), // rewardData
  ]);
}

function episodeCompleteKey(episodeId, difficulty = 0) {
  return (BigInt(Number(episodeId || 0)) << 32n) | BigInt(Number(difficulty || 0) >>> 0);
}

function buildEpisodeCompleteData(episodeId, difficulty, completeCount, rewardFlags = []) {
  const flags = Array.isArray(rewardFlags) ? rewardFlags : [];
  return Buffer.concat([
    writeSignedVarInt(Number(episodeId || 0)),
    writeSignedVarInt(Number(difficulty || 0)),
    writeSignedVarInt(Math.max(0, Number(completeCount || 0) || 0)),
    writeBoolList([Boolean(flags[0]), Boolean(flags[1]), Boolean(flags[2])]),
  ]);
}

function mainStoryStageMedalValue(stage) {
  if (!stage) return 0;
  if (stage.cutsceneOnly) return 0;
  return stage.tutorial ? 1 : 3;
}

function getMainStoryCompletedStageStates(user, extraStageIds = []) {
  if (!user || typeof user !== "object") return [];
  const mainStory = ensureMainStoryState(user);
  const states = mainStory && mainStory.stages && typeof mainStory.stages === "object" ? mainStory.stages : {};
  const forcedStageIds = new Set(
    (Array.isArray(extraStageIds) ? extraStageIds : [extraStageIds])
      .map(Number)
      .filter((stageId) => Number.isInteger(stageId) && stageId > 0)
  );
  return MAIN_STORY_STAGE_CHAIN.map((stage) => {
    const stageId = Number(stage.stageId || 0);
    const state = states[String(stageId)] || {};
    if (state.completed !== true && !forcedStageIds.has(stageId)) return null;
    return {
      ...stage,
      ...state,
      stageId,
      dungeonID: Number(stage.dungeonID || state.dungeonId || 0),
      bestClearTimeSec: Number(state.bestClearTimeSec || 0),
    };
  }).filter(Boolean);
}

function getMainStoryEpisodeCompleteMedalCount(user, episodeId, extraStageIds = []) {
  return getMainStoryCompletedStageStates(user, extraStageIds).reduce(
    (total, stage) => (Number(stage.episodeId || 0) === Number(episodeId || 0) ? total + mainStoryStageMedalValue(stage) : total),
    0
  );
}

function buildMainStoryEpisodeCompleteData(user, episodeId, extraStageIds = []) {
  const completeCount = getMainStoryEpisodeCompleteMedalCount(user, episodeId, extraStageIds);
  if (completeCount <= 0) return null;
  return buildEpisodeCompleteData(episodeId, 0, completeCount, collection.getEpisodeRewardFlags(user, episodeId, 0));
}

function buildMainStoryEpisodeCompleteDataForStage(user, stageId) {
  const stage = getMainStoryStageByStageId(stageId);
  if (!stage) return null;
  return buildMainStoryEpisodeCompleteData(user, stage.episodeId, [stage.stageId]);
}

function recordTutorialDungeonClear(socket, replay) {
  if (!socket || !socket.session || !replay || replay.tutorialClearRecorded) return;
  const dynamicGame = replay.dynamicGame || {};
  const dungeonId = Number(dynamicGame.dungeonID || 0);
  const stageId = Number(dynamicGame.stageID || stageIdForDungeonId(dungeonId));
  if (!isTutorialDungeonId(dungeonId) || !isTutorialStageId(stageId)) return;
  if (recordTutorialDungeonClearForUser(socket.session.user, dungeonId, stageId, replay.battleState)) {
    replay.tutorialClearRecorded = true;
  }
}

function recordGameplayUnlockClear(socket, dungeonId, stageId = 0) {
  const user = socket && socket.session && socket.session.user;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  const changed = recordGameplayUnlockClearForUser(user, resolvedDungeonId, resolvedStageId);
  if (changed) {
    console.log(
      `[unlock-progress] uid=${user && user.userUid ? user.userUid : "(none)"} stageID=${resolvedStageId} dungeonID=${resolvedDungeonId}`
    );
  }
  return changed;
}

function recordPersistentCutsceneView(socket, dungeonId, stageId = 0) {
  const user = socket && socket.session && socket.session.user;
  return recordPersistentCutsceneViewForUser(user, dungeonId, stageId);
}

function recordTutorialCutsceneClear(socket, dungeonId) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const battleFinished =
    replay &&
    (replay.tutorialClearRecorded ||
      replay.dynamicBattleResultSent ||
      (replay.battleState && (replay.battleState.finished || replay.battleState.Finished)));
  const activeDungeonId = Number(replay && replay.dynamicGame && replay.dynamicGame.dungeonID);
  const decodedDungeonId = Number(dungeonId || 0);
  const resolvedDungeonId = isTutorialDungeonId(activeDungeonId) ? activeDungeonId : decodedDungeonId;
  const stageId = stageIdForDungeonId(resolvedDungeonId);
  if (!isTutorialDungeonId(resolvedDungeonId) || !isTutorialStageId(stageId)) return false;
  if (!battleFinished && !isTutorialDungeonId(activeDungeonId)) return false;
  return recordTutorialDungeonClearForUser(
    socket && socket.session && socket.session.user,
    resolvedDungeonId,
    stageId,
    replay && replay.battleState
  );
}

function tutorialPhaseKey(stage) {
  return String(stage && (stage.dungeonID || stage.dungeonId || stage.stageId || ""));
}

function ensureTutorialState(user) {
  if (!user) return null;
  user.tutorial = user.tutorial && typeof user.tutorial === "object" ? user.tutorial : {};
  ensureTutorialNicknameMissionMarker(user);
  user.tutorial.enabled = user.tutorial.enabled !== false;
  user.tutorial.firstStageId = Number(user.tutorial.firstStageId || TUTORIAL_STAGE_CHAIN[0].stageId);
  user.tutorial.firstDungeonId = Number(user.tutorial.firstDungeonId || TUTORIAL_STAGE_CHAIN[0].dungeonID);
  const existingPhases = user.tutorial.phases && typeof user.tutorial.phases === "object" ? user.tutorial.phases : null;
  const dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  const stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const persistedComplete = hasPersistedTutorialCompletion(user);
  const phases = {};
  for (let index = 0; index < TUTORIAL_STAGE_CHAIN.length; index += 1) {
    const stage = TUTORIAL_STAGE_CHAIN[index];
    const key = tutorialPhaseKey(stage);
    const existing = existingPhases && typeof existingPhases[key] === "object" ? existingPhases[key] : {};
    const clear = dungeonClear[String(stage.dungeonID)];
    const play = stagePlayData[String(stage.stageId)];
    const completed = persistedComplete || user.tutorial.completed === true || existing.completed === true || Boolean(!existingPhases && clear);
    phases[key] = {
      phase: index + 1,
      stageId: stage.stageId,
      dungeonId: stage.dungeonID,
      stageStrID: stage.stageStrID,
      dungeonStrID: stage.dungeonStrID,
      completed,
      completedAt: existing.completedAt || (clear && clear.clearedAt) || "",
      bestClearTimeSec: Number(existing.bestClearTimeSec || (play && play.bestClearTimeSec) || 0),
    };
  }
  user.tutorial.phases = phases;
  if (Object.values(phases).every((phase) => phase.completed)) {
    user.tutorial.completed = true;
    user.tutorial.completedAt = user.tutorial.completedAt || new Date().toISOString();
  } else if (user.tutorial.completed !== true) {
    user.tutorial.completed = false;
  }
  const nextStage = nextTutorialStageForUser(user);
  user.tutorial.nextStageId = nextStage ? nextStage.stageId : 0;
  user.tutorial.nextDungeonId = nextStage ? nextStage.dungeonID : 0;
  return user.tutorial;
}

function ensureTutorialNicknameMissionMarker(user) {
  if (!user || !user.tutorial || user.tutorial.nicknameChanged !== true) return false;
  user.completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  if (user.completedMissions["999"]) return false;
  user.completedMissions["999"] = {
    tabId: 1,
    groupId: 999,
    missionID: 999,
    times: 1,
    lastUpdateDate: String(dateTimeBinaryNow()),
    isComplete: true,
    rewardReady: true,
    completedAt: user.tutorial.nicknameChangedAt || new Date().toISOString(),
  };
  return true;
}

function nextTutorialStageForUser(user) {
  const tutorial = user && user.tutorial && typeof user.tutorial === "object" ? user.tutorial : {};
  const phases = tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const phase = phases[tutorialPhaseKey(stage)];
    if (!phase || phase.completed !== true) return stage;
  }
  return null;
}

function isTutorialComplete(user) {
  const tutorial = ensureTutorialState(user);
  return Boolean(tutorial && tutorial.completed === true);
}

function hasPersistedTutorialCompletion(user) {
  if (!user || typeof user !== "object") return false;
  const tutorial = user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  if (user.loginFlow === "post-tutorial" || (tutorial && tutorial.loginMode === "post-tutorial")) return true;
  if (tutorial && tutorial.completed === true) return true;

  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : null;
  if (
    phases &&
    TUTORIAL_STAGE_CHAIN.every((stage) => {
      const phase = phases[tutorialPhaseKey(stage)];
      return Boolean(phase && phase.completed === true);
    })
  ) {
    return true;
  }

  const dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  return TUTORIAL_STAGE_CHAIN.every((stage) => {
    const clear = dungeonClear[String(stage.dungeonID)];
    return Boolean(clear && clear.cleared !== false);
  });
}

function unlockNextTutorialStageForUser(user) {
  if (!user) return false;
  const tutorial = ensureTutorialState(user);
  const nextStage = nextTutorialStageForUser(user);
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  const unlockStageId = nextStage ? nextStage.stageId : TUTORIAL_STAGE_CHAIN[TUTORIAL_STAGE_CHAIN.length - 1].stageId;
  if (!user.unlockedStageIds.includes(unlockStageId)) user.unlockedStageIds.push(unlockStageId);
  tutorial.nextStageId = nextStage ? nextStage.stageId : 0;
  tutorial.nextDungeonId = nextStage ? nextStage.dungeonID : 0;
  return true;
}

function resetLocalProgressForUser(user, options = {}) {
  if (!user || typeof user !== "object") return false;
  if (!options.force && hasPersistedTutorialCompletion(user)) {
    ensureTutorialState(user);
    return false;
  }
  user.dungeonClear = {};
  user.stagePlayData = {};
  user.completedMissions = {};
  user.unlockedStageIds = [];
  user.mainStory = {};
  user.episode1 = {};
  resetTutorialProgressForUser(user, { save: false, force: options.force === true });
  ensureMainStoryState(user);
  if (USE_LOCAL_USER_DB && options.save !== false) saveUserDb();
  return true;
}

function resetCampaignProgressForUser(user, options = {}) {
  if (!user || typeof user !== "object") return false;
  const changed = resetMainStoryPostTutorialProgress(user);
  if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
  return changed;
}

function resetTutorialProgressForUser(user, options = {}) {
  if (!user || typeof user !== "object") return false;
  if (!options.force && hasPersistedTutorialCompletion(user)) {
    ensureTutorialState(user);
    return false;
  }
  let changed = scrubTutorialEpisodeClearProgress(user);
  user.tutorial = {
    enabled: true,
    firstStageId: TUTORIAL_STAGE_CHAIN[0].stageId,
    firstDungeonId: TUTORIAL_STAGE_CHAIN[0].dungeonID,
    completed: false,
    completedAt: "",
    nextStageId: TUTORIAL_STAGE_CHAIN[0].stageId,
    nextDungeonId: TUTORIAL_STAGE_CHAIN[0].dungeonID,
    phases: {},
  };
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    user.tutorial.phases[tutorialPhaseKey(stage)] = {
      phase: TUTORIAL_STAGE_CHAIN.indexOf(stage) + 1,
      stageId: stage.stageId,
      dungeonId: stage.dungeonID,
      stageStrID: stage.stageStrID,
      dungeonStrID: stage.dungeonStrID,
      completed: false,
      completedAt: "",
      bestClearTimeSec: 0,
    };
  }
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  const tutorialStageIds = new Set(TUTORIAL_STAGE_CHAIN.map((stage) => Number(stage.stageId)));
  const nextUnlocked = user.unlockedStageIds.filter((stageId) => !tutorialStageIds.has(Number(stageId)));
  if (!nextUnlocked.includes(TUTORIAL_STAGE_CHAIN[0].stageId)) nextUnlocked.push(TUTORIAL_STAGE_CHAIN[0].stageId);
  if (nextUnlocked.length !== user.unlockedStageIds.length || nextUnlocked.some((stageId, index) => stageId !== user.unlockedStageIds[index])) {
    user.unlockedStageIds = nextUnlocked;
    changed = true;
  }
  if (user.completedMissions && typeof user.completedMissions === "object") {
    for (const missionId of TUTORIAL_SKIP_WIN_MISSION_IDS) {
      if (Object.prototype.hasOwnProperty.call(user.completedMissions, String(missionId))) {
        delete user.completedMissions[String(missionId)];
        changed = true;
      }
    }
  }
  changed = true;
  if (USE_LOCAL_USER_DB && options.save !== false) saveUserDb();
  return changed;
}

function maybeResetCampaignProgressOnLogin(user, resetKey) {
  if (!RESET_CAMPAIGN_PROGRESS_ON_LOGIN || !user) return false;
  const userKey = String(resetKey || user.userUid || user.steamLoginKey || user.steamAccountId || "ephemeral");
  const campaignResetKey = `campaign:${userKey}`;
  if (localProgressResetUsers.has(campaignResetKey)) return false;
  const changed = resetCampaignProgressForUser(user, { save: false });
  localProgressResetUsers.add(campaignResetKey);
  console.log(
    `[campaign-progress] uid=${user.userUid || "(ephemeral)"} reset post-tutorial progress${changed ? "" : " (already clean)"}`
  );
  return changed;
}

function prepareTutorialLogin(user) {
  if (!user) return false;
  const resetKey = String(user.userUid || user.steamLoginKey || user.steamAccountId || "ephemeral");
  ensureTutorialState(user);
  maybeResetCampaignProgressOnLogin(user, resetKey);
  if (hasPersistedTutorialCompletion(user) || isTutorialComplete(user)) {
    return preparePostTutorialLogin(user, resetKey);
  }

  const alreadyReset = localProgressResetUsers.has(resetKey);
  if (RESET_LOCAL_PROGRESS_ON_LOGIN && !alreadyReset) {
    resetLocalProgressForUser(user, { save: false });
    localProgressResetUsers.add(resetKey);
    console.log(`[tutorial-login] uid=${user.userUid || "(ephemeral)"} reset local stage/mission progress`);
  } else if (RESET_TUTORIAL_PROGRESS_ON_LOGIN && !alreadyReset) {
    resetTutorialProgressForUser(user, { save: false });
    localProgressResetUsers.add(resetKey);
    console.log(`[tutorial-login] uid=${user.userUid || "(ephemeral)"} reset local tutorial progress`);
  } else {
    ensureTutorialState(user);
  }
  if (!isTutorialComplete(user)) {
    unlockNextTutorialStageForUser(user);
  } else {
    ensureTutorialState(user);
  }
  console.log(
    `[tutorial-login] uid=${user.userUid || "(ephemeral)"} completed=${user.tutorial.completed ? 1 : 0} nextStage=${
      user.tutorial.nextStageId || 0
    } nextDungeon=${user.tutorial.nextDungeonId || 0}`
  );
  return true;
}

function preparePostTutorialLogin(user, resetKey = "") {
  const tutorial = ensureTutorialState(user);
  ensureTutorialCompletionProgress(user, {}, { force: true });
  tutorial.loginMode = "post-tutorial";
  tutorial.nextStageId = 0;
  tutorial.nextDungeonId = 0;
  ensurePostTutorialUserLevel(user);
  user.loginFlow = "post-tutorial";
  if (resetKey) localProgressResetUsers.add(resetKey);
  ensureMainStoryState(user);
  const repairedTutorialMissions = CLEAR_ALL_MISSIONS_STATUS
    ? 0
    : repairStageGatedTutorialMissionCompletions(user) + repairPostTutorialGuideMissionCompletions(user);
  if (repairedTutorialMissions > 0 && USE_LOCAL_USER_DB) saveUserDb();
  console.log(
    `[post-tutorial-login] uid=${user.userUid || "(ephemeral)"} completed=1 nextStage=0 nextDungeon=0${
      repairedTutorialMissions > 0 ? ` repairedTutorialMissions=${repairedTutorialMissions}` : ""
    }`
  );
  return true;
}

function repairStageGatedTutorialMissionCompletions(user) {
  if (!user || typeof user !== "object" || !hasPersistedTutorialCompletion(user)) return 0;
  let repaired = 0;
  for (const row of getMissionTempletsByTabId(1)) {
    if (!row || String(row.m_MissionCond || "").toUpperCase() !== "TUTORIAL") continue;
    if (missionRowHasReward(row)) continue;
    const missionId = Number(row.m_MissionID || 0);
    const forceStageId = Number(row.m_ForceClearStage || 0);
    if (!missionId || !forceStageId || !isTutorialRepairStageCleared(user, forceStageId)) continue;
    const existing = findCompletedMissionById(user, missionId);
    if (existing && (existing.rewardClaimed === true || existing.isComplete === true || existing.claimedAt)) continue;
    if (
      markMissionCompleteForUser(user, missionId, {
        tabId: Number(row.m_MissionTabId || 1) || 1,
        groupId: Number(row.m_MissionCounterGroupID || row.m_GroupId || missionId) || missionId,
        times: Math.max(1, Number(row.m_Times || 0) || 1),
        rewardClaimed: true,
        rewardReady: true,
        save: false,
      })
    ) {
      repaired += 1;
    }
  }
  return repaired;
}

function repairPostTutorialGuideMissionCompletions(user) {
  if (!user || typeof user !== "object") return 0;
  let repaired = 0;
  const wanted = new Set(POST_TUTORIAL_GUIDE_MISSION_IDS);
  for (const row of getMissionTempletsByTabId(1)) {
    if (!row || String(row.m_MissionCond || "").toUpperCase() !== "TUTORIAL") continue;
    const missionId = Number(row.m_MissionID || 0);
    if (!wanted.has(missionId) || missionRowHasReward(row)) continue;
    if (!shouldPersistPostTutorialGuideMission(user, missionId)) continue;
    const existing = findCompletedMissionById(user, missionId);
    if (existing && (existing.rewardClaimed === true || existing.isComplete === true || existing.claimedAt)) continue;
    if (
      markMissionCompleteForUser(user, missionId, {
        tabId: Number(row.m_MissionTabId || 1) || 1,
        groupId: Number(row.m_MissionCounterGroupID || row.m_GroupId || missionId) || missionId,
        times: Math.max(1, Number(row.m_Times || 0) || 1),
        rewardClaimed: true,
        rewardReady: true,
        save: false,
      })
    ) {
      repaired += 1;
    }
  }
  return repaired;
}

function shouldPersistPostTutorialGuideMission(user, missionId) {
  if (hasPersistedTutorialCompletion(user)) return true;
  const stageId = Number(POST_TUTORIAL_GUIDE_REQUIREMENT_STAGE_IDS[Number(missionId)] || 0);
  if (!stageId) return false;
  if (isTutorialRepairStageCleared(user, stageId)) return true;

  const stage = getMainStoryStageByStageId(stageId);
  const dungeonId = Number(stage && stage.dungeonID || 0);
  const dungeonClear = user && user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  const clear = dungeonId ? dungeonClear[String(dungeonId)] : null;
  return Boolean(clear && clear.cleared !== false);
}

function missionRowHasReward(row) {
  for (let index = 1; index <= 5; index += 1) {
    if (row && row[`m_RewardType_${index}`] && Number(row[`m_RewardID_${index}`] || 0) > 0) return true;
  }
  return false;
}

function findCompletedMissionById(user, missionId) {
  const completedMissions =
    user && user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  const direct = completedMissions[String(missionId)];
  if (direct) return direct;
  return Object.values(completedMissions).find((mission) => Number(mission && mission.missionID) === Number(missionId)) || null;
}

function isTutorialRepairStageCleared(user, stageId) {
  const numericStageId = Number(stageId || 0);
  if (!numericStageId) return false;
  const stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  if (stagePlayData[String(numericStageId)]) return true;
  for (const containerName of ["mainStory", "episode1"]) {
    const container = user[containerName];
    const state = container && container.stages && typeof container.stages === "object" ? container.stages[String(numericStageId)] : null;
    if (state && state.completed === true) return true;
  }
  const tutorialStage = TUTORIAL_STAGE_CHAIN.find((stage) => Number(stage.stageId || 0) === numericStageId);
  if (tutorialStage) {
    const tutorial = user.tutorial && typeof user.tutorial === "object" ? user.tutorial : {};
    const phases = tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
    const phase = phases[tutorialPhaseKey(tutorialStage)] || phases[String(tutorialStage.stageId)];
    return Boolean(phase && phase.completed === true);
  }
  return false;
}

function recordTutorialDungeonClearForUser(user, dungeonId, stageId, battleState = {}, options = {}) {
  if (!user) return false;
  const stageMeta = TUTORIAL_STAGE_CHAIN.find((stage) => stage.dungeonID === Number(dungeonId) || stage.stageId === Number(stageId));
  if (!stageMeta) return false;
  const tutorial = ensureTutorialState(user);
  let changed = scrubTutorialEpisodeClearProgress(user);
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  const bestClearTimeSec = Math.max(0, Math.round(Number((battleState && battleState.gameTime) || 0)));
  const phase = tutorial.phases[tutorialPhaseKey(stageMeta)];
  const firstStageClear = !phase || phase.completed !== true;
  if (phase) {
    if (phase.completed !== true || !phase.completedAt || Number(phase.bestClearTimeSec || 0) !== bestClearTimeSec) {
      changed = true;
    }
    phase.completed = true;
    phase.completedAt = phase.completedAt || new Date().toISOString();
    phase.bestClearTimeSec = bestClearTimeSec;
  }
  if (!user.unlockedStageIds.includes(stageMeta.stageId)) {
    user.unlockedStageIds.push(stageMeta.stageId);
    changed = true;
  }
  const nextStage = nextTutorialStageForUser(user);
  if (nextStage && !user.unlockedStageIds.includes(nextStage.stageId)) {
    user.unlockedStageIds.push(nextStage.stageId);
    changed = true;
  }
  const finalTutorialStage = TUTORIAL_STAGE_CHAIN[TUTORIAL_STAGE_CHAIN.length - 1];
  if (stageMeta.dungeonID === finalTutorialStage.dungeonID || stageMeta.stageId === finalTutorialStage.stageId) {
    for (const tutorialStage of TUTORIAL_STAGE_CHAIN) {
      const candidate = tutorial.phases[tutorialPhaseKey(tutorialStage)];
      if (!candidate) continue;
      if (candidate.completed !== true || !candidate.completedAt) changed = true;
      candidate.completed = true;
      candidate.completedAt = candidate.completedAt || new Date().toISOString();
      if (!Number(candidate.bestClearTimeSec || 0)) candidate.bestClearTimeSec = bestClearTimeSec;
      if (!user.unlockedStageIds.includes(tutorialStage.stageId)) {
        user.unlockedStageIds.push(tutorialStage.stageId);
        changed = true;
      }
    }
  }
  if (Object.values(tutorial.phases || {}).every((candidate) => candidate && candidate.completed === true)) {
    if (!tutorial.completed || !tutorial.completedAt || tutorial.nextStageId !== 0 || tutorial.nextDungeonId !== 0) changed = true;
    tutorial.completed = true;
    tutorial.completedAt = tutorial.completedAt || new Date().toISOString();
    tutorial.nextStageId = 0;
    tutorial.nextDungeonId = 0;
    tutorial.loginMode = "post-tutorial";
    user.loginFlow = "post-tutorial";
    if (ensurePostTutorialUserLevel(user)) changed = true;
  } else {
    const nextStageId = nextStage ? nextStage.stageId : 0;
    const nextDungeonId = nextStage ? nextStage.dungeonID : 0;
    if (tutorial.nextStageId !== nextStageId || tutorial.nextDungeonId !== nextDungeonId) changed = true;
    tutorial.nextStageId = nextStageId;
    tutorial.nextDungeonId = nextDungeonId;
  }
  if (firstStageClear) {
    grantStageClearExp(user, stageMeta.stageId, stageMeta.dungeonID);
    trackStageClearMissionProgress(user, stageMeta.dungeonID, stageMeta.stageId, battleState);
    changed = true;
  }
  if (recordGameplayUnlockClearForUser(user, stageMeta.dungeonID, stageMeta.stageId, { save: false })) changed = true;
  ensureMainStoryState(user);
  if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
  return true;
}

function recordGameplayUnlockClearForUser(user, dungeonId, stageId = 0, options = {}) {
  if (!user || typeof user !== "object") return false;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  if (!resolvedDungeonId && !resolvedStageId) return false;
  let changed = false;
  const now = new Date().toISOString();
  user.clearConditions = user.clearConditions && typeof user.clearConditions === "object" ? user.clearConditions : {};
  user.clearConditions.dungeons =
    user.clearConditions.dungeons && typeof user.clearConditions.dungeons === "object" ? user.clearConditions.dungeons : {};
  user.clearConditions.stages =
    user.clearConditions.stages && typeof user.clearConditions.stages === "object" ? user.clearConditions.stages : {};

  if (resolvedDungeonId) {
    const key = String(resolvedDungeonId);
    const existing = user.clearConditions.dungeons[key] || {};
    if (!existing.cleared || Number(existing.stageId || 0) !== resolvedStageId) changed = true;
    user.clearConditions.dungeons[key] = {
      dungeonId: resolvedDungeonId,
      stageId: resolvedStageId,
      cleared: true,
      firstClearedAt: existing.firstClearedAt || now,
      lastClearedAt: now,
    };
  }

  if (resolvedStageId) {
    const key = String(resolvedStageId);
    const existing = user.clearConditions.stages[key] || {};
    if (!existing.cleared || Number(existing.dungeonId || 0) !== resolvedDungeonId) changed = true;
    user.clearConditions.stages[key] = {
      stageId: resolvedStageId,
      dungeonId: resolvedDungeonId,
      cleared: true,
      firstClearedAt: existing.firstClearedAt || now,
      lastClearedAt: now,
    };
  }

  const unlocks = getContentUnlocksForDungeon(resolvedDungeonId);
  if (unlocks.length) {
    user.gameplayUnlocks = user.gameplayUnlocks && typeof user.gameplayUnlocks === "object" ? user.gameplayUnlocks : {};
    user.gameplayUnlocks.byKey =
      user.gameplayUnlocks.byKey && typeof user.gameplayUnlocks.byKey === "object" ? user.gameplayUnlocks.byKey : {};
    user.gameplayUnlocks.byDungeon =
      user.gameplayUnlocks.byDungeon && typeof user.gameplayUnlocks.byDungeon === "object" ? user.gameplayUnlocks.byDungeon : {};
    const dungeonUnlockKeys = new Set(Array.isArray(user.gameplayUnlocks.byDungeon[String(resolvedDungeonId)])
      ? user.gameplayUnlocks.byDungeon[String(resolvedDungeonId)]
      : []);
    for (const unlock of unlocks) {
      const type = String(unlock.eContentsType || "");
      const contentsValue = Number(unlock.m_ContentsValue || 0);
      const key = `${type}:${contentsValue}`;
      const existing = user.gameplayUnlocks.byKey[key] || {};
      if (!existing.unlocked) changed = true;
      user.gameplayUnlocks.byKey[key] = {
        key,
        type,
        contentsValue,
        unlockIndex: Number(unlock.IDX || 0) || 0,
        reqType: String(unlock.m_UnlockReqType || ""),
        reqValue: resolvedDungeonId,
        stageId: resolvedStageId,
        unlocked: true,
        firstUnlockedAt: existing.firstUnlockedAt || now,
        lastUnlockedAt: now,
      };
      if (!dungeonUnlockKeys.has(key)) {
        dungeonUnlockKeys.add(key);
        changed = true;
      }
    }
    user.gameplayUnlocks.byDungeon[String(resolvedDungeonId)] = Array.from(dungeonUnlockKeys).sort();
  }

  if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
  return changed;
}

function recordPersistentCutsceneViewForUser(user, dungeonId, stageId = 0, options = {}) {
  if (!user || typeof user !== "object") return false;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  if (!shouldPersistCutsceneView(resolvedDungeonId, resolvedStageId)) return false;
  user.persistentCutsceneViews =
    user.persistentCutsceneViews && typeof user.persistentCutsceneViews === "object" ? user.persistentCutsceneViews : {};
  const key = String(resolvedDungeonId || resolvedStageId);
  const existing = user.persistentCutsceneViews[key] || {};
  const now = new Date().toISOString();
  user.persistentCutsceneViews[key] = {
    dungeonId: resolvedDungeonId,
    stageId: resolvedStageId,
    viewed: true,
    persistent: true,
    firstViewedAt: existing.firstViewedAt || now,
    lastViewedAt: now,
  };
  const changed = !existing.viewed;
  if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
  return changed;
}

function repairDungeonClearDataFromProgress(user) {
  if (!user || typeof user !== "object") return 0;
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  let repaired = 0;

  const addClear = (dungeonId, source = {}) => {
    if (source && source.cleared === false) return;
    const resolvedDungeonId = Number(dungeonId || source.dungeonId || source.dungeonID || source.m_DungeonID || 0);
    if (!Number.isInteger(resolvedDungeonId) || resolvedDungeonId <= 0) return;
    const resolvedStageId = Number(
      source.stageId || source.stageID || source.m_StageID || stageIdForDungeonId(resolvedDungeonId) || 0
    );
    const key = String(resolvedDungeonId);
    const existing = user.dungeonClear[key] && typeof user.dungeonClear[key] === "object" ? user.dungeonClear[key] : {};
    const nextStageId = resolvedStageId || Number(existing.stageId || 0);
    const next = {
      ...existing,
      dungeonId: resolvedDungeonId,
      stageId: nextStageId,
      missionResult1: existing.missionResult1 === true || source.missionResult1 !== false,
      missionResult2: existing.missionResult2 === true || source.missionResult2 !== false,
      clearedAt:
        existing.clearedAt ||
        source.clearedAt ||
        source.completedAt ||
        source.firstClearedAt ||
        source.firstViewedAt ||
        new Date().toISOString(),
    };
    const changed =
      user.dungeonClear[key] !== next &&
      (!user.dungeonClear[key] ||
        Number(existing.dungeonId || key) !== resolvedDungeonId ||
        Number(existing.stageId || 0) !== Number(next.stageId || 0) ||
        existing.missionResult1 !== next.missionResult1 ||
        existing.missionResult2 !== next.missionResult2 ||
        !existing.clearedAt);
    user.dungeonClear[key] = next;
    if (nextStageId > 0) {
      if (!user.unlockedStageIds.includes(nextStageId)) {
        user.unlockedStageIds.push(nextStageId);
        repaired += 1;
      }
      const stageKey = String(nextStageId);
      if (!user.stagePlayData[stageKey] && source.recordStagePlay !== false) {
        user.stagePlayData[stageKey] = {
          stageId: nextStageId,
          playCount: Math.max(1, Number(source.playCount || 0)),
          totalPlayCount: Math.max(1, Number(source.totalPlayCount || source.playCount || 0)),
          bestClearTimeSec: Number(source.bestClearTimeSec || 0),
        };
        repaired += 1;
      }
    }
    if (changed) repaired += 1;
  };

  for (const [key, clear] of Object.entries(user.dungeonClear)) {
    addClear(Number((clear && clear.dungeonId) || key), { ...clear, recordStagePlay: false });
  }
  const clearConditions = user.clearConditions && typeof user.clearConditions === "object" ? user.clearConditions : {};
  const clearDungeons =
    clearConditions.dungeons && typeof clearConditions.dungeons === "object" ? clearConditions.dungeons : {};
  for (const [key, clear] of Object.entries(clearDungeons)) {
    addClear(Number((clear && clear.dungeonId) || key), clear);
  }
  const clearStages = clearConditions.stages && typeof clearConditions.stages === "object" ? clearConditions.stages : {};
  for (const [key, clear] of Object.entries(clearStages)) {
    const stageId = Number((clear && clear.stageId) || key);
    addClear(resolveDungeonIdForStageProgress(stageId, clear), { ...clear, stageId });
  }
  for (const [key, play] of Object.entries(user.stagePlayData)) {
    const stageId = Number((play && play.stageId) || key);
    addClear(resolveDungeonIdForStageProgress(stageId, play), { ...play, stageId, recordStagePlay: false });
  }
  const gameplayUnlocks = user.gameplayUnlocks && typeof user.gameplayUnlocks === "object" ? user.gameplayUnlocks : {};
  const gameplayByDungeon =
    gameplayUnlocks.byDungeon && typeof gameplayUnlocks.byDungeon === "object" ? gameplayUnlocks.byDungeon : {};
  for (const dungeonId of Object.keys(gameplayByDungeon)) addClear(Number(dungeonId), { recordStagePlay: false });
  const cutsceneViews =
    user.persistentCutsceneViews && typeof user.persistentCutsceneViews === "object" ? user.persistentCutsceneViews : {};
  for (const [key, view] of Object.entries(cutsceneViews)) {
    if (!view || view.viewed === false) continue;
    const stageId = Number(view.stageId || 0);
    const dungeonId = Number(view.dungeonId || 0) || Number(key) || resolveDungeonIdForStageProgress(stageId, view);
    addClear(dungeonId, { ...view, stageId });
  }
  return repaired;
}

function resolveDungeonIdForStageProgress(stageId, source = {}) {
  const explicit = Number(source && (source.dungeonId || source.dungeonID || source.m_DungeonID));
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const numericStageId = Number(stageId || 0);
  if (!Number.isInteger(numericStageId) || numericStageId <= 0) return 0;
  const mainStoryStage = getMainStoryStageByStageId(numericStageId);
  if (mainStoryStage && Number(mainStoryStage.dungeonID) > 0) return Number(mainStoryStage.dungeonID);
  const tutorialStage = TUTORIAL_STAGE_CHAIN.find((stage) => Number(stage.stageId) === numericStageId);
  if (tutorialStage && Number(tutorialStage.dungeonID) > 0) return Number(tutorialStage.dungeonID);
  const genericStage = getGenericStageForRequest({ stageID: numericStageId });
  return Number(genericStage && genericStage.dungeonID) || 0;
}

function shouldPersistCutsceneView(dungeonId, stageId) {
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || 0);
  const mainStoryStage = getMainStoryStageByStageId(resolvedStageId);
  return (
    isTutorialDungeonId(resolvedDungeonId) ||
    isTutorialStageId(resolvedStageId) ||
    isMainStoryCutsceneDungeonId(resolvedDungeonId) ||
    Boolean(mainStoryStage && mainStoryStage.cutsceneOnly)
  );
}

function hasTutorialCompletionMarker(user) {
  return hasPersistedTutorialCompletion(user) || isTutorialComplete(user);
}

function ensureTutorialCompletionProgress(user, battleState = {}, options = {}) {
  if (!user) return false;
  if (!options.force && !hasTutorialCompletionMarker(user)) return false;
  const tutorial = ensureTutorialState(user);
  let changed = scrubTutorialEpisodeClearProgress(user);
  const rawGameTime = Number((battleState && battleState.gameTime) || (battleState && battleState.GameTime) || 0);
  const hasBattleTime = Number.isFinite(rawGameTime) && rawGameTime > 0;
  const bestClearTimeSec = Math.max(0, Math.round(rawGameTime));
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const phase = tutorial.phases[tutorialPhaseKey(stage)];
    if (!phase) continue;
    const nextBestClearTimeSec = hasBattleTime ? bestClearTimeSec : Number(phase.bestClearTimeSec || 0);
    if (phase.completed !== true || !phase.completedAt || Number(phase.bestClearTimeSec || 0) !== nextBestClearTimeSec) {
      changed = true;
    }
    phase.completed = true;
    phase.completedAt = phase.completedAt || new Date().toISOString();
    phase.bestClearTimeSec = nextBestClearTimeSec;
    if (recordGameplayUnlockClearForUser(user, stage.dungeonID, stage.stageId, { save: false })) changed = true;
  }
  if (!tutorial.completed || !tutorial.completedAt || tutorial.nextStageId !== 0 || tutorial.nextDungeonId !== 0) {
    tutorial.completed = true;
    tutorial.completedAt = tutorial.completedAt || new Date().toISOString();
    tutorial.nextStageId = 0;
    tutorial.nextDungeonId = 0;
    changed = true;
  }
  if (ensurePostTutorialUserLevel(user)) changed = true;
  if (changed) {
    console.log(
      `[tutorial-progress] repaired tutorial-only completion uid=${user.userUid || "(ephemeral)"} phases=${TUTORIAL_STAGE_CHAIN.map(
        (stage) => stage.stageId
      ).join(",")}`
    );
    if (USE_LOCAL_USER_DB) saveUserDb();
  }
  return changed;
}

function ensurePostTutorialUserLevel(user) {
  if (!user || typeof user !== "object") return false;
  const beforeLevel = Math.max(1, Number(user.level || 1) || 1);
  const beforeExp = String(user.exp == null ? "0" : user.exp);
  const beforeTotalExp = String(user.totalExp == null ? "0" : user.totalExp);
  if (beforeLevel < POST_TUTORIAL_MIN_USER_LEVEL) {
    user.level = POST_TUTORIAL_MIN_USER_LEVEL;
    user.exp = "0";
    user.totalExp = getMinimumTotalExpForUserLevel(POST_TUTORIAL_MIN_USER_LEVEL).toString();
  }
  ensureAccountProgress(user);
  return (
    beforeLevel !== Number(user.level || 1) ||
    beforeExp !== String(user.exp == null ? "0" : user.exp) ||
    beforeTotalExp !== String(user.totalExp == null ? "0" : user.totalExp)
  );
}

function getMinimumTotalExpForUserLevel(level) {
  const targetLevel = Math.max(1, Number(level || 1) || 1);
  const tableTotal = Number(getPlayerTotalExpForLevel(targetLevel) || 0);
  if (tableTotal > 0 || targetLevel <= 1) return BigInt(Math.max(0, tableTotal));
  return BigInt((targetLevel - 1) * 100);
}

function getJoinLobbyUserLevel(user) {
  if (!user || typeof user !== "object") return 1;
  if (hasPersistedTutorialCompletion(user)) {
    ensurePostTutorialUserLevel(user);
  } else {
    ensureAccountProgress(user);
  }
  return Math.max(1, Number(user.level || 1) || 1);
}

function recordMissionComplete(socket, req) {
  const user = socket && socket.session && socket.session.user;
  if (!user || !req || !req.missionID) return null;
  const result = completeAccountMission(user, req, { now: dateTimeBinaryNow() });
  console.log(
    `[mission] complete uid=${user.userUid} missionID=${req.missionID} tabId=${req.tabId} groupId=${req.groupId} exp=${
      result && result.reward ? result.reward.userExp : 0
    } achievePoint=${result && result.reward ? result.reward.achievePoint : "0"}`
  );
  if (result && result.changed && USE_LOCAL_USER_DB) saveUserDb();
  return result;
}

function markMissionCompleteForUser(user, missionId, options = {}) {
  if (!user) return false;
  const numericMissionId = Number(missionId || 0);
  if (!Number.isInteger(numericMissionId) || numericMissionId <= 0) return false;
  user.completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  const existing = user.completedMissions[String(numericMissionId)] || {};
  const tabId = Number(options.tabId || existing.tabId || 1);
  const groupId = Number(options.groupId || existing.groupId || numericMissionId);
  user.completedMissions[String(numericMissionId)] = {
    tabId,
    groupId,
    missionID: numericMissionId,
    times: Number(options.times || existing.times || 1),
    lastUpdateDate: String(options.lastUpdateDate || existing.lastUpdateDate || dateTimeBinaryNow()),
    isComplete: options.rewardClaimed === true,
    rewardReady: options.rewardReady !== false,
    rewardClaimed: options.rewardClaimed === true,
    completedAt: existing.completedAt || new Date().toISOString(),
    claimedAt: options.rewardClaimed === true ? existing.claimedAt || new Date().toISOString() : existing.claimedAt || "",
  };
  if (USE_LOCAL_USER_DB && options.save !== false) saveUserDb();
  return true;
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

function buildAdditionalRewardData() {
  return Buffer.concat([writeSignedVarLong(0n), writeSignedVarLong(0n), writeSignedVarLong(0n)]);
}

function decodeMissionCompleteReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const tabId = readSignedVarInt(decrypted, offset);
    offset = tabId.offset;
    const groupId = readSignedVarInt(decrypted, offset);
    offset = groupId.offset;
    const missionID = readSignedVarInt(decrypted, offset);
    return {
      tabId: tabId.value,
      groupId: groupId.value,
      missionID: missionID.value,
    };
  } catch (err) {
    console.log(`[MISSION_COMPLETE_REQ] decode failed: ${err.message}`);
    return { tabId: 1, groupId: 0, missionID: 0 };
  }
}

function buildMissionCompleteAckPayload(req) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number((req && req.missionID) || 0)),
    writeNullableObject(buildSerializedRewardData({})),
    writeNullableObject(buildAdditionalRewardData()),
  ]);
}

function buildEmoticonDataAckPayload() {
  const emptyPresetData = Buffer.concat([
    writeIntList([]), // animationList
    writeIntList([]), // textList
  ]);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(emptyPresetData),
    writeIntList([]), // collections
    writeObjectList([]), // emoticonDatas
  ]);
}

function buildFriendListAckPayload(friendListType = 0) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number(friendListType || 0)),
    writeObjectList([]),
  ]);
}

function buildGreetingMessageAckPayload(message = "") {
  return Buffer.concat([writeSignedVarInt(0), writeString(message || "")]);
}

function buildFavoritesStageAckPayload() {
  return Buffer.concat([writeSignedVarInt(0), writeObjectMapInt([])]);
}

function buildDefenceInfoAckPayload() {
  return Buffer.concat([
    writeSignedVarInt(0), // errorCode
    writeSignedVarInt(0), // defenceTempletId
    writeSignedVarInt(0), // bestScore
    writeBool(false), // m_MissionResult1
    writeBool(false), // m_MissionResult2
    writeSignedVarInt(0), // rank
    writeSignedVarInt(0), // rankPercent
    writeBool(false), // canReceiveRankReward
    writeNullableObject(Buffer.concat([
      writeNullableObject(buildCommonProfileData(null, 0n, 0n, "")),
      writeSignedVarInt(0),
      writeNullableObject(buildGuildSimpleData()),
    ])), // topRankProfile
    writeIntList([]), // scoreRewardIds
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
    let eventDeckData = null;
    if (hasEventDeckData) {
      const parsedEventDeck = readNkmEventDeckData(decrypted, offset);
      eventDeckData = parsedEventDeck.value;
      offset = parsedEventDeck.offset;
    }
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
      eventDeckData,
      rewardMultiply: rewardMultiply.value,
    };
  } catch (_) {
    return null;
  }
}

function readNkmEventDeckData(buffer, offset) {
  const shipUid = readSignedVarLong(buffer, offset);
  offset = shipUid.offset;
  const unitMap = readIntLongMap(buffer, offset);
  offset = unitMap.offset;
  const operatorUid = readSignedVarLong(buffer, offset);
  offset = operatorUid.offset;
  const leaderIndex = readSignedVarInt(buffer, offset);
  offset = leaderIndex.offset;
  return {
    value: {
      shipUid: shipUid.value,
      units: unitMap.value,
      operatorUid: operatorUid.value,
      leaderIndex: leaderIndex.value,
    },
    offset,
  };
}

function readIntLongMap(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const entries = {};
  for (let index = 0; index < count.value; index += 1) {
    const key = readSignedVarInt(buffer, offset);
    offset = key.offset;
    const value = readSignedVarLong(buffer, offset);
    offset = value.offset;
    entries[key.value] = value.value;
  }
  return { value: entries, offset };
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

function decodeGameUnitSkillReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    const gameUnitUID = readSignedVarInt(decrypted, 0);
    return {
      gameUnitUID: gameUnitUID.value,
      decodedBytes: gameUnitUID.offset,
    };
  } catch (err) {
    console.log(`[GAME_USE_UNIT_SKILL_REQ] decode failed: ${err.message}`);
    return null;
  }
}

function decodeGameShipSkillReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const gameUnitUID = readSignedVarInt(decrypted, offset);
    offset = gameUnitUID.offset;
    const shipSkillID = readSignedVarInt(decrypted, offset);
    offset = shipSkillID.offset;
    const skillPosX = decrypted.readFloatLE(offset);
    offset += 4;
    return {
      gameUnitUID: gameUnitUID.value,
      shipSkillID: shipSkillID.value,
      skillPosX,
      decodedBytes: offset,
    };
  } catch (err) {
    console.log(`[GAME_SHIP_SKILL_REQ] decode failed: ${err.message}`);
    return null;
  }
}

function logGameLoadReq(payload) {
  try {
    const req = decodeGameLoadReq(payload);
    if (!req) throw new Error("decode returned null");
    const eventDeckUnits = req.eventDeckData
      ? Object.entries(req.eventDeckData.units || {})
          .filter(([, uid]) => toBigInt(uid || 0) > 0n)
          .map(([slot, uid]) => `${slot}:${uid}`)
          .join(",")
      : "";
    console.log(
      `[GAME_LOAD_REQ] isDev=${req.isDev ? 1 : 0} deck=${req.selectDeckIndex} stageID=${req.stageID} diveStageID=${
        req.diveStageID
      } dungeonID=${req.dungeonID} palaceID=${req.palaceID} fierceBossId=${req.fierceBossId} exploreID=${
        req.exploreID
      } supportingUserUid=${req.supportingUserUid} eventDeck=${req.hasEventDeckData ? 1 : 0} rewardMultiply=${
        req.rewardMultiply
      }${eventDeckUnits ? ` eventDeckUnits=${eventDeckUnits}` : ""}`
    );
  } catch (err) {
    console.log(`[GAME_LOAD_REQ] decode failed: ${err.message}`);
  }
}

function buildContentsVersionAck(sequence, baseTags = CONTENTS_TAGS, version = CONTENTS_VERSION) {
  const tags = getEffectiveContentsTags(baseTags);
  const payload = Buffer.concat([
    writeSignedVarInt(0),
    writeString(version || CONTENTS_VERSION),
    writeStringList(tags),
    writeInt64LE(dateTimeBinaryNow()),
    writeInt64LE(0n),
  ]);

  console.log(`[CONTENTS_VERSION_ACK event-contents-tags] version=${version || CONTENTS_VERSION} tags=${tags.length}`);
  return buildEncryptedPacket(sequence, CONTENTS_VERSION_ACK, payload);
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
  const contentsTag = getEffectiveContentsTags(template.contentsTag);
  const openTag = getEffectiveOpenTags(template.openTag);

  const rawPayload = buildLoginAckRaw({
    errorCode: template.errorCode,
    accessToken: token,
    gameServerIP: GAME_SERVER_IP,
    gameServerPort: GAME_SERVER_PORT,
    contentsVersion: template.contentsVersion,
    contentsTag,
    openTag,
  });

  const compressedPayload = lz4StreamWrapUncompressed(rawPayload);
  console.log(
    `[${label} official-template] version=${template.contentsVersion} tags=${contentsTag.length} openTags=${openTag.length} tokenLen=${token.length} gameServer=${GAME_SERVER_IP}:${GAME_SERVER_PORT} payloadSize=${compressedPayload.length}`
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
  const baseTags = user && user.contentsTags && user.contentsTags.length
    ? user.contentsTags
    : lastAckContentsTags.length
      ? lastAckContentsTags
      : CONTENTS_TAGS;
  const tags = getEffectiveContentsTags(baseTags);
  const openTags = getEffectiveOpenTags(user && user.openTags ? user.openTags : OPEN_TAGS);

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

function getActiveEventState() {
  return eventManager.getActiveEventState();
}

function getEventContentsTagsForContentsVersion() {
  const state = getActiveEventState();
  return mergeTags(
    EVENT_CONTENTS_TAGS_ENABLED ? state.contentsTags : [],
    EVENT_COUNTER_PASS_CONTENTS_TAGS_ENABLED ? state.counterPassContentsTags : []
  );
}

function getEffectiveContentsTags(baseTags) {
  const eventTags = getEventContentsTagsForContentsVersion();
  return mergeTags(baseTags, REQUIRED_CONTENTS_TAGS, eventTags);
}

function stripInactiveEventContentsTags(baseTags, activeEventTags) {
  if (!eventManager || !eventManager.config || !eventManager.config.enabled) return Array.isArray(baseTags) ? baseTags : [];
  if (!eventManager.getKnownContentsTags) return Array.isArray(baseTags) ? baseTags : [];
  const knownTags = new Set(eventManager.getKnownContentsTags().map((tag) => String(tag || "").toUpperCase()));
  if (!knownTags.size) return Array.isArray(baseTags) ? baseTags : [];
  const activeTags = new Set((Array.isArray(activeEventTags) ? activeEventTags : []).map((tag) => String(tag || "").toUpperCase()));
  return (Array.isArray(baseTags) ? baseTags : []).filter((tag) => {
    const key = String(tag || "").toUpperCase();
    return !knownTags.has(key) || activeTags.has(key);
  });
}

function getEffectiveOpenTags(baseTags) {
  return mergeTags(baseTags, REQUIRED_STORY_OPEN_TAGS, getActiveEventState().openTags);
}

function getRequiredContentsTags() {
  return mergeTags(REQUIRED_CONTENTS_TAGS, getEventContentsTagsForContentsVersion());
}

function buildEventIntervalDataList() {
  const state = getActiveEventState();
  return state.enabled ? state.intervalData : [];
}

function buildJoinLobbyIntervalDataList(user) {
  const byStrKey = new Map();
  for (const interval of buildEventIntervalDataList()) {
    const strKey = String((interval && interval.strKey) || "");
    if (!strKey) continue;
    byStrKey.set(strKey, buildIntervalData(interval));
  }
  for (const payload of buildSerializedAttendanceIntervalDataList(user)) {
    const strKey = readIntervalDataStrKey(payload) || `__attendance_${byStrKey.size}`;
    byStrKey.set(strKey, payload);
  }
  return Array.from(byStrKey.values());
}

function getInactiveEventIntervalStrKeys(activeIntervalPayloads = []) {
  if (!eventManager || !eventManager.config || !eventManager.config.enabled) return [];
  if (!eventManager.getKnownIntervalStrKeys) return [];
  const activeKeys = new Set(getIntervalPayloadStrKeys(activeIntervalPayloads).map((key) => key.toUpperCase()));
  return eventManager
    .getKnownIntervalStrKeys()
    .filter((key) => {
      const text = String(key || "");
      return text && !activeKeys.has(text.toUpperCase());
    });
}

function getIntervalPayloadStrKeys(intervalPayloads = []) {
  return (Array.isArray(intervalPayloads) ? intervalPayloads : [])
    .map(readIntervalDataStrKey)
    .filter(Boolean);
}

function buildIntervalData(interval) {
  const data = interval || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.key || 0) || 0),
    writeString(data.strKey || ""),
    writeInt64LE(dateTimeBinaryForDate(data.startDate)),
    writeInt64LE(dateTimeBinaryForDate(data.endDate)),
    writeSignedVarInt(Number(data.repeatStartDate || 0) || 0),
    writeSignedVarInt(Number(data.repeatEndDate || 0) || 0),
  ]);
}

function readIntervalDataStrKey(payload) {
  try {
    let offset = readSignedVarInt(payload, 0).offset;
    return readString(payload, offset).value || "";
  } catch (_) {
    return "";
  }
}

function buildMinimalJoinLobbyPayload(user) {
  const scrubbedTutorialClears = scrubTutorialEpisodeClearProgress(user);
  if (scrubbedTutorialClears && USE_LOCAL_USER_DB) saveUserDb();
  ensureMainStoryState(user);
  ensureDefaultLineup(user);
  ensureDefaultLineup(user, { deckType: 3, index: 0 });
  const intervalData = buildJoinLobbyIntervalDataList(user);
  const lobbyNow = dateTimeBinaryNow();
  const refreshedStamina = stamina.refreshTimedStamina(user, {
    now: lobbyNow,
    initializeMissing: true,
  });
  if (refreshedStamina.changed && USE_LOCAL_USER_DB) saveUserDb();
  const now = writeInt64LE(lobbyNow);
  const lastEterniumSupplyTakeTime = writeInt64LE(
    stamina.getChargeItemLastUpdateDate(user, stamina.ITEM_IDS.ETERNIUM, lobbyNow)
  );
  const pvpPointChargeTime = writeInt64LE(
    stamina.getChargeItemLastUpdateDate(user, stamina.ITEM_IDS.PVP_CHARGE_POINT, lobbyNow)
  );
  const userUid = BigInt(user.userUid || "1000000001");
  const friendCode = BigInt(user.friendCode || "10000001");
  const nickname = user.nickname || "LocalAdmin";
  const miscCount = getMiscItems(user).length;
  const unitCount = getArmyUnits(user).length;
  const shipCount = getArmyShips(user).length;
  const operatorCount = getArmyOperators(user).length;

  console.log(
    `[JOIN_LOBBY_ACK fallback] uid=${userUid} friendCode=${friendCode} nickname=${JSON.stringify(
      nickname
    )} level=${user.level || 1} reconnectKey=${JSON.stringify(
      user.reconnectKey || ""
    )} inventoryMisc=${miscCount} units=${unitCount} ships=${shipCount} operators=${operatorCount}`
  );

  return Buffer.concat([
    writeSignedVarInt(0), // errorCode
    writeSignedVarLong(friendCode),
    writeNullableObject(buildMinimalUserData(user, userUid, friendCode, nickname)),
    writeNullObject(), // lobbyData
    writeNullObject(), // gameData
    writeNullableObject(buildWarfareGameData()), // warfareGameData
    now, // utcTime
    writeInt64LE(0n), // utcOffset
    now, // lastCreditSupplyTakeTime
    lastEterniumSupplyTakeTime,
    writeDoubleLE(0),
    writeObjectList([]), // shopChainTabNestResetList
    writeNullableObject(buildPvpBanResultData()), // pvpBanResult
    writeNullableObject(buildPvpStateData()), // asyncPvpState
    writeNullableObject(buildPvpStateData()), // leaguePvpState
    pvpPointChargeTime,
    writeBool(false), // rankPvpOpen
    writeBool(false), // leaguePvpOpen
    writeObjectList([]), // ReturningUserStates
    writeObjectList(getAllContractStates(user).map((state) => writeNullableObject(buildSerializedContractStateData(state)))), // contractState
    writeObjectList(getAllContractBonusStates(user).map((state) => writeNullableObject(buildSerializedContractBonusStateData(state)))), // contractBonusState
    writeNullableObject(buildSelectableContractStateData()), // selectableContractState
    writeObjectList(buildStagePlayDataList(user)), // stagePlayDataList
    writeNullableObject(buildEventInfoData()), // eventInfo
    writeString(user.reconnectKey || ""),
    writeNullableObject(buildZlongUserData()), // zlongUserData
    writeNullableObject(buildBackgroundInfoData(user)), // backGroundInfo
    writeNullableObject(buildPrivateGuildData()), // privateGuildData
    now, // blockMuteEndDate
    writeBool(false), // marketReviewCompletion
    writeBool(false), // fierceDailyRewardReceived
    writeNullableObject(buildGuildDungeonRewardInfoData()), // guildDungeonRewardInfo
    writeNullableObject(buildEquipTuningCandidateData()), // equipTuningCandidate
    writeNullObject(), // leaguePvpRoomData
    writeObjectList([]), // leaguePvpHistories
    writeObjectList([]), // privatePvpHistories
    writeNullObject(), // officeState
    writeNullObject(), // kakaoMissionData
    writeIntList(user.unlockedStageIds || []),
    writeObjectList(buildPhaseClearDataList(user)), // phaseClearDataList
    writeNullObject(), // phaseModeState
    writeObjectList([]), // serverKillCountDataList
    writeObjectList([]), // killCountDataList
    writeObjectList(collection.buildCompletedUnitMissionPayloads(user).map(writeNullableObject)), // completedUnitMissions
    writeObjectList(collection.buildRewardEnableUnitMissionPayloads(user).map(writeNullableObject)), // rewardEnableUnitMissions
    writeNullableObject(buildPvpCastingVoteData()), // pvpCastingVoteData
    writeObjectList(intervalData.map(writeNullableObject)), // intervalData
    writeObjectList([]), // consumerPackages
    writeNullObject(), // npcPvpData
    writeNullableObject(buildTrimIntervalData()), // trimIntervalData
    writeObjectList([]), // trimClearList
    writeNullableObject(buildShipModuleCandidateData()), // shipSlotCandidate
    writeNullObject(), // trimModeState
    writeBool(false), // enableAccountLink
    writeNullableObject(buildEventCollectionInfoData()), // eventCollectionInfo
    writeNullableObject(buildUserProfileData(user, userUid, friendCode, nickname)), // userProfileData
    writeNullableObject(buildShortCutInfoData()), // lastPlayInfo
    writeNullableObject(buildPvpStateData()), // eventPvpState
    writeObjectList(getAllCustomPickupContracts(user).map((contract) => writeNullableObject(buildSerializedCustomPickupContractData(contract)))), // customPickupContracts
    writeNullableObject(buildPotentialOptionCandidateData()), // potentialOptionCandidate
    writeNullableObject(buildPvpCastingVoteData()), // pvpDraftVoteData
    writeNullableObject(buildSupportUnitData(user)), // supportUnitProfileData
    writeBool(false), // hasRemainReward
  ]);
}

function buildJoinLobbyAckPayload(user) {
  const localPayload = buildMinimalJoinLobbyPayload(user);
  const officialPayload = getCapturedServerPayloadTemplate(JOIN_LOBBY_ACK);
  const localIntervalData = buildJoinLobbyIntervalDataList(user);
  const hasGeneratedLobbyIntervals = localIntervalData.length > 0;
  const activeIntervalStrKeys = getIntervalPayloadStrKeys(localIntervalData);
  const inactiveEventIntervalStrKeys = getInactiveEventIntervalStrKeys(localIntervalData);
  if (officialPayload && Buffer.isBuffer(officialPayload)) {
    const cacheKey = [
      user && user.userUid ? String(user.userUid) : "ephemeral",
      sha1Buffer(officialPayload),
      sha1Buffer(localPayload),
    ].join(":");
    const cached = joinLobbyAckPayloadCache.get(cacheKey);
    if (cached) return cached;

    const merged = combatHandler.mergeJoinLobbyAck
      ? combatHandler.mergeJoinLobbyAck(officialPayload, localPayload, {
          copyIntervalData: hasGeneratedLobbyIntervals,
          replaceIntervalData: false,
          excludeIntervalStrKeys: inactiveEventIntervalStrKeys,
          preserveIntervalStrKeys: activeIntervalStrKeys,
          filterInactiveEventIntervals: eventManager.config.enabled,
        })
      : { ok: false, error: "combat handler merge unavailable" };
    if (merged.ok && Buffer.isBuffer(merged.payload)) {
      rememberJoinLobbyAckPayload(cacheKey, merged.payload);
      console.log(
        `[JOIN_LOBBY_ACK merge] official=${officialPayload.length} local=${localPayload.length} merged=${merged.payload.length}`
      );
      return merged.payload;
    }

    console.log(
      `[JOIN_LOBBY_ACK merge] failed; using captured official ACK without local overlay: ${summarizeErrorLine(
        merged.error
      )}`
    );
    return officialPayload;
  }

  if (!REPLAY_CAPTURED_GAME_FLOW) {
    const cacheKey = [
      user && user.userUid ? String(user.userUid) : "ephemeral",
      "normalized",
      sha1Buffer(localPayload),
    ].join(":");
    const cached = joinLobbyAckPayloadCache.get(cacheKey);
    if (cached) return cached;
    const normalized = combatHandler.normalizeJoinLobbyAck
      ? combatHandler.normalizeJoinLobbyAck(localPayload)
      : { ok: false, error: "combat handler normalize unavailable" };
    if (normalized.ok && Buffer.isBuffer(normalized.payload)) {
      rememberJoinLobbyAckPayload(cacheKey, normalized.payload);
      console.log(
        `[JOIN_LOBBY_ACK normalize] local=${localPayload.length} normalized=${normalized.payload.length}`
      );
      return normalized.payload;
    }
    console.log(
      `[JOIN_LOBBY_ACK normalize] failed; using pure local ACK: ${summarizeErrorLine(
        normalized.error
      )}`
    );
    return localPayload;
  }
  return localPayload;
}

function rememberJoinLobbyAckPayload(cacheKey, payload) {
  if (joinLobbyAckPayloadCache.size >= 16) {
    const oldestKey = joinLobbyAckPayloadCache.keys().next().value;
    if (oldestKey) joinLobbyAckPayloadCache.delete(oldestKey);
  }
  joinLobbyAckPayloadCache.set(cacheKey, payload);
}

function sha1Buffer(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 16);
}

function summarizeErrorLine(error) {
  return String(error || "unknown error")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0] || "unknown error";
}

function hasTutorialProgress(user) {
  const tutorial = ensureTutorialState(user) || {};
  const completedMissions =
    user && user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  if (tutorial.completed || Object.values(tutorial.phases || {}).some((phase) => phase && phase.completed)) return true;
  if (completedMissions["999"]) return true;
  return false;
}

function shouldUseLocalJoinLobbyAck(user) {
  if (USE_LOCAL_JOIN_LOBBY_ACK) return true;
  if (LOCAL_JOIN_LOBBY_ACK_MODE === "0" || LOCAL_JOIN_LOBBY_ACK_MODE === "false" || LOCAL_JOIN_LOBBY_ACK_MODE === "off") {
    return false;
  }
  return hasLocalAccountState(user);
}

function hasLocalAccountState(user) {
  if (!user || typeof user !== "object") return false;
  const inventory = user.inventory && typeof user.inventory === "object" ? user.inventory : {};
  const army = user.army && typeof user.army === "object" ? user.army : {};
  const completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  const contractStates = user.contractStates && typeof user.contractStates === "object" ? user.contractStates : {};
  const dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  const stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const persistentCutsceneViews =
    user.persistentCutsceneViews && typeof user.persistentCutsceneViews === "object" ? user.persistentCutsceneViews : {};
  const support = user.support && typeof user.support === "object" ? user.support : {};
  if (Array.isArray(user.unlockedStageIds) && user.unlockedStageIds.length > 0) return true;
  if (user.mainStory && typeof user.mainStory === "object") return true;
  if (user.episode1 && typeof user.episode1 === "object") return true;
  if (inventory.localTouchedAt) return true;
  if (Object.keys(inventory.equips || {}).length > 0) return true;
  if (Array.isArray(inventory.skins) && inventory.skins.length > 0) return true;
  if (Object.keys(army.units || {}).length > 0) return true;
  if (Object.keys(army.ships || {}).length > 0) return true;
  if (Object.keys(army.trophies || {}).length > 0) return true;
  if (Object.keys(army.operators || {}).length > 0) return true;
  if (Object.keys(army.deckSets || {}).length > 0) return true;
  if (Object.keys(completedMissions).length > 0) return true;
  if (Object.keys(contractStates).length > 0) return true;
  if (Object.keys(dungeonClear).length > 0) return true;
  if (Object.keys(stagePlayData).length > 0) return true;
  if (Object.keys(persistentCutsceneViews).length > 0) return true;
  if (Object.keys(support).length > 0) return true;
  if (hasSavedCombatControls(user)) return true;
  if (lobbyCustomization.hasLobbyCustomization(user)) return true;
  if (simulation.hasSimulationState(user)) return true;
  if (stamina.hasStaminaState(user)) return true;
  if (collection.hasCollectionState(user)) return true;
  return Boolean(user.nickname && user.nickname !== "LocalAdmin");
}

function getCompletedTutorialStageStates(user) {
  const tutorial = ensureTutorialState(user);
  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  return TUTORIAL_STAGE_CHAIN.map((stage) => {
    const phase = phases[tutorialPhaseKey(stage)] || phases[String(stage.stageId)];
    if (!phase || phase.completed !== true) return null;
    return {
      ...stage,
      dungeonId: stage.dungeonID,
      completed: true,
      completedAt: phase.completedAt || tutorial.completedAt || "",
      bestClearTimeSec: Number(phase.bestClearTimeSec || 0),
      missionResult1: true,
      missionResult2: true,
    };
  }).filter(Boolean);
}

function buildDungeonClearEntries(user) {
  repairDungeonClearDataFromProgress(user);
  const dungeonClear = user && user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  const entries = new Map();
  const addDungeonClearEntry = (dungeonId, options = {}) => {
    const normalizedDungeonId = Number(dungeonId);
    if (!Number.isFinite(normalizedDungeonId) || normalizedDungeonId <= 0) return;
    entries.set(normalizedDungeonId, buildDungeonClearData(normalizedDungeonId, options));
  };
  for (const [key, clear] of Object.entries(dungeonClear)) {
    const dungeonId = Number((clear && clear.dungeonId) || key);
    addDungeonClearEntry(dungeonId, {
      missionResult1: !clear || clear.missionResult1 !== false,
      missionResult2: !clear || clear.missionResult2 !== false,
    });
  }
  for (const stage of getCompletedTutorialStageStates(user)) {
    const dungeonId = Number(stage.dungeonID || stage.dungeonId || 0);
    addDungeonClearEntry(dungeonId, {
      missionResult1: stage.missionResult1 !== false,
      missionResult2: stage.missionResult2 !== false,
    });
  }
  for (const stage of getMainStoryCompletedStageStates(user)) {
    const dungeonId = Number(stage.dungeonID || stage.dungeonId || 0);
    addDungeonClearEntry(dungeonId, {
      missionResult1: stage.missionResult1 !== false,
      missionResult2: stage.missionResult2 !== false,
    });
  }
  return Array.from(entries.entries());
}

function buildStagePlayDataList(user) {
  const stagePlayData = user && user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const entries = new Map();
  for (const [key, data] of Object.entries(stagePlayData)) {
    const stageId = Number((data && data.stageId) || key);
    if (Number.isFinite(stageId) && stageId > 0) {
      entries.set(stageId, writeNullableObject(buildStagePlayData(stageId, { gameTime: Number((data && data.bestClearTimeSec) || 0) })));
    }
  }
  for (const stage of getCompletedTutorialStageStates(user)) {
    const stageId = Number(stage.stageId || 0);
    if (Number.isFinite(stageId) && stageId > 0) {
      entries.set(stageId, writeNullableObject(buildStagePlayData(stageId, { gameTime: Number(stage.bestClearTimeSec || 0) })));
    }
  }
  for (const stage of getMainStoryCompletedStageStates(user)) {
    const stageId = Number(stage.stageId || 0);
    if (Number.isFinite(stageId) && stageId > 0) {
      entries.set(stageId, writeNullableObject(buildStagePlayData(stageId, { gameTime: Number(stage.bestClearTimeSec || 0) })));
    }
  }
  return Array.from(entries.values());
}

function buildPhaseClearDataList(user) {
  const stages = new Map();
  for (const stage of getCompletedTutorialStageStates(user)) stages.set(Number(stage.stageId || 0), stage);
  for (const stage of getMainStoryCompletedStageStates(user)) stages.set(Number(stage.stageId || 0), stage);
  return Array.from(stages.values())
    .filter((stage) => Number(stage.stageId || 0) > 0 && !stage.cutsceneOnly)
    .map((stage) =>
      writeNullableObject(
        buildPhaseClearData(stage.stageId, {
          missionResult1: stage.missionResult1 !== false,
          missionResult2: stage.missionResult2 !== false,
        })
      )
    );
}

function buildEpisodeCompleteEntries(user) {
  const entries = [];
  const episodeIds = new Set(getMainStoryCompletedStageStates(user).map((stage) => Number(stage.episodeId || 0)).filter((id) => id > 0));
  for (const episodeId of Array.from(episodeIds).sort((a, b) => a - b)) {
    const episodeCompleteData = buildMainStoryEpisodeCompleteData(user, episodeId);
    if (episodeCompleteData) entries.push([episodeCompleteKey(episodeId, 0), episodeCompleteData]);
  }
  return entries;
}

function buildMinimalUserData(user, userUid, friendCode, nickname) {
  const userLevel = getJoinLobbyUserLevel(user);
  const userLevelExp = Number(user && user.exp ? user.exp : 0) || 0;
  const now = dateTimeBinaryNow();
  return Buffer.concat([
    writeSignedVarLong(userUid),
    writeSignedVarLong(friendCode),
    writeString(nickname),
    writeSignedVarInt(userLevel),
    writeSignedVarInt(userLevelExp), // level exp
    writeSignedVarInt(1), // NORMAL_USER
    writeNullableObject(Buffer.concat([writeInt64LE(now), writeInt64LE(now), writeInt64LE(0n)])), // NKMUserDateData
    writeNullableObject(buildMinimalInventoryData(user)),
    writeNullableObject(buildMinimalArmyData(user)),
    writeNullableObject(buildMinimalUserOption(user)),
    writeObjectMapInt(buildDungeonClearEntries(user)), // m_dicNKMDungeonClearData
    writeNullableObject(buildWorldMapData()), // m_WorldmapData
    writeObjectMapInt([]), // m_dicNKMWarfareClearData
    writeNullableObject(buildMinimalShopData(user)),
    writeNullableObject(buildMinimalMissionData(user)),
    writeObjectMapInt(simulation.buildCounterCaseDataEntries(user)), // m_dicNKMCounterCaseData
    writeNullableObject(buildCraftData()), // m_CraftData
    writeObjectMapLong(buildEpisodeCompleteEntries(user)), // m_dicEpisodeCompleteData
    writeNullableObject(buildPvpStateData()), // m_PvpData
    writeNullObject(), // m_SyncPvpHistory
    writeNullObject(), // m_AsyncPvpHistory
    writeNullObject(), // m_EventPvpHistory
    writeNullObject(), // m_DiveGameData
    writeObjectList([]), // m_DiveClearData
    writeObjectList([]), // m_DiveHistoryData
    writeNullableObject(buildAttendanceData(user)), // m_AttendanceData
    writeSignedVarInt(0), // UserState
    writeObjectList([]), // m_companyBuffDataList
    writeNullableObject(buildShadowPalaceData()), // m_ShadowPalace
    writeNullableObject(buildBackgroundInfoData(user)), // backGroundInfo
    writeNullObject(), // m_RecallHistoryData
    writeNullObject(), // m_BirthDayData
    writeNullableObject(buildJukeboxData(user)), // m_JukeboxData
  ]);
}

function buildMinimalInventoryData(user) {
  const equipEntries = buildInventoryEquipEntries(user);
  return Buffer.concat([
    writeSignedVarInt(Math.max(300, equipEntries.length + 100)), // m_MaxItemEqipCount
    writeObjectMapInt(buildInventoryMiscEntries(user)), // m_ItemMiscData
    writeObjectMapLong(equipEntries), // m_ItemEquipData
    writeIntList(getSkinIds(user)), // m_ItemSkinData
    writeObjectMapInt(collection.buildMiscCollectionEntries(user)), // m_dicMiscCollectionData
  ]);
}

function buildInventoryMiscEntries(user) {
  return getMiscItems(user).map((item) => [item.itemId, buildItemMiscData(item)]);
}

function buildInventoryEquipEntries(user) {
  return getEquipItems(user).map((equip) => [equip.equipUid, buildSerializedEquipItemData(equip)]);
}

function buildItemMiscData(item) {
  return Buffer.concat([
    writeSignedVarInt(Number(item.itemId) || 0),
    writeSignedVarLong(toBigInt(item.countFree || 0)),
    writeSignedVarLong(toBigInt(item.countPaid || 0)),
    writeSignedVarInt(Number(item.bonusRatio || 0)),
    writeInt64LE(toBigInt(item.regDate || 0)),
  ]);
}

function buildMinimalArmyData(user) {
  const units = getArmyUnits(user);
  const ships = getArmyShips(user);
  const trophies = getArmyTrophies(user);
  const operators = getArmyOperators(user);
  return Buffer.concat([
    writeSignedVarInt(Math.max(300, units.length + 100)), // m_MaxUnitCount
    writeSignedVarInt(Math.max(200, ships.length + 50)), // m_MaxShipCount
    writeSignedVarInt(Math.max(100, operators.length + 50)), // m_MaxOperatorCount
    writeSignedVarInt(Math.max(100, trophies.length + 50)), // m_MaxTrophyCount
    buildDefaultDeckSetArray(user), // deckSets
    writeObjectMapLong(ships.map((unit) => [unit.unitUid, buildSerializedUnitData(unit)])), // ships
    writeObjectMapLong(units.map((unit) => [unit.unitUid, buildSerializedUnitData(unit)])), // units
    writeObjectMapLong(operators.map((operator) => [operator.uid || operator.operatorUid, buildSerializedOperatorData(operator)])), // operators
    writeObjectMapLong(trophies.map((unit) => [unit.unitUid, buildSerializedUnitData(unit)])), // trophies
    writeIntList(collection.buildIllustratedUnitIds(user)), // m_illustrateUnit
    writeObjectMapInt(collection.buildTeamCollectionEntries(user)), // team collection
  ]);
}

function buildDefaultDeckSetArray(user) {
  const deckSets = getArmyDeckSets(user);
  return writeObjectList(deckSets.map((deckSet) => writeNullableObject(buildDeckSetData(deckSet.deckType, deckSet.decks))));
}

function buildDeckSetData(deckType, decks = []) {
  return Buffer.concat([
    writeSignedVarInt(deckType),
    writeObjectList((Array.isArray(decks) ? decks : []).map((deck) => writeNullableObject(buildSerializedDeckData(deck)))),
  ]);
}

function buildWarfareGameData() {
  return Buffer.concat([
    writeSignedVarInt(0), // NKM_WARFARE_GAME_STATE.NWGS_STOP
    writeSignedVarInt(0), // warfareTempletID
    writeObjectList([]), // warfareTileDataList
    writeNullableObject(buildWarfareTeamData()),
    writeNullableObject(buildWarfareTeamData()),
    writeBool(false), // isTurnA
    writeSignedVarInt(0), // turnCount
    writeSignedVarInt(0), // firstAttackCount
    writeSignedVarInt(0), // battleAllyUid
    writeSignedVarInt(0), // battleMonsterUid
    writeBool(false), // isWinTeamA
    writeSignedVarLong(0n), // expireTimeTick
    writeSignedVarInt(0), // holdCount
    writeSignedVarInt(0), // containerCount
    writeByte(0), // flagshipDeckIndex
    writeByte(0), // alliesKillCount
    writeByte(0), // enemiesKillCount
    writeByte(0), // targetKillCount
    writeByte(0), // assistCount
    writeByte(0), // supplyUseCount
    writeNullableObject(buildWarfareSupporterListData()),
    writeSignedVarInt(0), // rewardMultiply
  ]);
}

function buildWarfareTeamData() {
  return Buffer.concat([writeSignedVarInt(0), writeObjectMapInt([])]);
}

function buildWarfareSupporterListData() {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(null, 0n, 0n, "")),
    writeNullObject(), // deckData
    writeInt64LE(0n), // lastLoginDate
    writeInt64LE(0n), // lastUsedDate
    writeString(""),
    writeNullableObject(buildGuildSimpleData()),
  ]);
}

function buildPvpBanResultData() {
  return Buffer.concat([
    writeObjectMapInt([]), // unitBanList
    writeObjectMapInt([]), // shipBanList
    writeObjectMapInt([]), // operatorBanList
    writeObjectMapInt([]), // unitUpList
    writeObjectMapInt([]), // unitCastingBanList
    writeObjectMapInt([]), // shipCastingBanList
    writeObjectMapInt([]), // operatorCastingBanList
    writeObjectMapInt([]), // unitFinalBanList
    writeObjectMapInt([]), // shipFinalBanList
    writeObjectMapInt([]), // operatorFinalBanList
    writeNullableObject(buildPvpSeasonBanResultData()),
    writeNullableObject(buildPvpBanOptionStateData()),
  ]);
}

function buildPvpSeasonBanResultData() {
  return Buffer.concat([writeIntList([]), writeIntList([]), writeIntList([])]);
}

function buildPvpBanOptionStateData() {
  return Buffer.concat([writeBool(false), writeBool(false), writeBool(false)]);
}

function buildWorldMapData() {
  return Buffer.concat([writeObjectMapInt([]), writeInt64LE(0n)]);
}

function buildCraftData() {
  return Buffer.concat([
    writeObjectMapInt([]), // m_dicMoldItem
    writeVarInt(0), // m_dicSlot keyed by byte
  ]);
}

function buildPvpStateData() {
  return Buffer.concat(Array.from({ length: 13 }, () => writeSignedVarInt(0)));
}

function buildAttendanceData(user) {
  return buildSerializedAttendanceData(user);
}

function buildShadowPalaceData() {
  return Buffer.concat([
    writeSignedVarInt(0), // currentPalaceId
    writeSignedVarInt(0), // life
    writeObjectList([]), // palaceDataList
    writeSignedVarInt(1), // rewardMultiply
  ]);
}

function buildJukeboxData(user) {
  return lobbyCustomization.buildJukeboxData(user);
}

function buildZlongUserData() {
  return writeString("");
}

function buildBackgroundInfoData(user) {
  return lobbyCustomization.buildBackgroundInfoData(user);
}

function buildTrimIntervalData() {
  return Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0), writeSignedVarInt(0)]);
}

function buildSelectableContractStateData() {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeIntList([]),
    writeSignedVarInt(0),
    writeBool(false),
  ]);
}

function buildEventInfoData() {
  return writeObjectList([]);
}

function buildShortCutInfoData() {
  return Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0)]);
}

function buildPrivateGuildData() {
  return Buffer.concat([
    writeSignedVarLong(0n),
    writeSignedVarInt(0),
    writeInt64LE(0n),
    writeInt64LE(0n),
  ]);
}

function buildGuildDungeonRewardInfoData() {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeObjectList([
      writeNullableObject(buildGuildDungeonSeasonRewardData(0)),
      writeNullableObject(buildGuildDungeonSeasonRewardData(1)),
    ]),
    writeBool(false),
  ]);
}

function buildGuildDungeonSeasonRewardData(category) {
  return Buffer.concat([writeSignedVarInt(category), writeSignedVarInt(0), writeSignedVarInt(0)]);
}

function buildEquipTuningCandidateData() {
  return Buffer.concat([
    writeSignedVarLong(0n),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
  ]);
}

function buildPotentialOptionCandidateData() {
  return Buffer.concat([
    writeSignedVarLong(0n),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
  ]);
}

function buildPvpCastingVoteData() {
  return Buffer.concat([writeIntList([]), writeIntList([]), writeIntList([])]);
}

function buildShipModuleCandidateData() {
  return Buffer.concat([writeSignedVarLong(0n), writeSignedVarInt(0), writeNullObject()]);
}

function buildEventCollectionInfoData() {
  return Buffer.concat([writeSignedVarInt(0), writeIntList([])]);
}

function buildUserProfileData(user, userUid, friendCode, nickname) {
  ensureAccountProgress(user);
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user, userUid, friendCode, nickname)),
    writeString(String((user && user.friendIntro) || "")),
    writeNullableObject(buildPvpProfileData()),
    writeNullableObject(buildPvpProfileData()),
    writeNullableObject(buildPvpProfileData()),
    writeNullObject(), // profileDeck
    writeNullObject(), // leagueDeck
    writeNullableObject(buildAsyncDeckData()),
    writeObjectList(((user && user.profileEmblems) || []).map((emblem) => writeNullableObject(buildProfileEmblemData(emblem)))), // emblems
    writeSignedVarInt(Number((user && (user.selfiFrameId || user.frameId)) || 0)),
    writeNullableObject(buildGuildSimpleData()),
    writeBool(false),
    writeSignedVarInt(0),
  ]);
}

function buildCommonProfileData(user, userUid, friendCode, nickname) {
  ensureAccountProgress(user);
  const mainUnitId = Number(user && user.mainUnitId) || 0;
  return Buffer.concat([
    writeSignedVarLong(userUid || 0n),
    writeSignedVarLong(friendCode || 0n),
    writeString(nickname || ""),
    writeSignedVarInt(getJoinLobbyUserLevel(user)),
    writeSignedVarInt(mainUnitId),
    writeSignedVarInt(Number((user && user.mainUnitSkinId) || 0)),
    writeSignedVarInt(Number((user && (user.frameId || user.selfiFrameId)) || 0)),
    writeSignedVarInt(Number((user && user.mainUnitTacticLevel) || 0)),
    writeSignedVarInt(Number((user && user.titleId) || 0)),
  ]);
}

function buildProfileEmblemData(emblem = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(emblem.id || 0) || 0),
    writeSignedVarLong(toBigInt(emblem.count || 0)),
  ]);
}

function buildPvpProfileData() {
  return Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0), writeSignedVarInt(0)]);
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

function buildGuildSimpleData() {
  return Buffer.concat([writeSignedVarLong(0n), writeString(""), writeSignedVarLong(0n)]);
}

function buildSupportUnitData(user) {
  const supportUnit = ensureSupportUnit(user);
  if (supportUnit) return buildPersistedSupportUnitData(user, supportUnit);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user && user.userUid ? user.userUid : 0)),
    writeNullableObject(buildAsyncUnitEquipData()),
    writeSignedVarLong(0n),
  ]);
}

function buildAsyncUnitEquipData() {
  return Buffer.concat([writeNullableObject(buildAsyncUnitData()), writeObjectList([])]);
}

function buildMinimalUserOption(user) {
  const controls = getSavedCombatControls(user);
  return Buffer.concat([
    writeBool(controls.autoRespawnEnabled), // m_bAutoRespawn
    writeSignedVarInt(1), // ActionCameraType.All
    writeBool(true), // m_bTrackCamera
    writeBool(true), // m_bViewSkillCutIn
    writeBool(false), // m_bAutoWarfare
    writeBool(true), // m_bAutoWarfareRepair
    writeBool(false), // m_bPlayCutscene
    writeBool(false), // m_bAutoDive
    writeSignedVarInt(controls.gameSpeedType), // speed
    writeSignedVarInt(controls.autoSkillType), // auto skill off (NKM_GAME_AUTO_SKILL_TYPE.NGST_OFF_HYPER)
    writeBool(true), // auto sync friend deck
    writeSignedVarInt(0), // default pvp auto respawn
    writeSignedVarInt(0), // private pvp invitation
  ]);
}

function buildMinimalShopData(user) {
  return Buffer.concat([
    writeObjectMapInt(buildShopPurchaseHistoryEntries(user)), // histories
    writeNullableObject(buildSerializedRandomShopData(user)), // randomShop
    writeObjectMapInt([]), // subscriptions
  ]);
}

function buildShopPurchaseHistoryEntries(user) {
  return getShopPurchaseHistories(user).map((history) => [history.shopId, buildShopPurchaseHistoryData(history)]);
}

function buildShopPurchaseHistoryData(history) {
  return Buffer.concat([
    writeSignedVarInt(Number(history.shopId) || 0),
    writeSignedVarInt(Number(history.purchaseCount) || 0),
    writeSignedVarInt(Number(history.purchaseTotalCount) || 0),
    writeSignedVarLong(toBigInt(history.nextResetDate || 0)),
  ]);
}

function buildMinimalMissionData(user) {
  const repairedTutorialMissions = CLEAR_ALL_MISSIONS_STATUS ? 0 : repairPostTutorialGuideMissionCompletions(user);
  if (repairedTutorialMissions > 0 && USE_LOCAL_USER_DB) saveUserDb();
  const missionEntries = LOBBY_LOCAL_MISSION_DATA
    ? buildSerializedMissionDataEntries(user, { now: Date.now(), fastLobby: true })
    : [];
  return Buffer.concat([
    writeObjectMapInt([]), // dicRefreshInfo
    writeObjectMapInt(missionEntries), // dicMissions
    writeSignedVarLong(getAchievePoint(user)), // achievePoint
  ]);
}

function buildSerializedMissionDataEntries(user, options = {}) {
  const entries = options.fastLobby
    ? buildFastLobbyMissionDataEntries(user, options)
    : buildAccountMissionDataEntries(user, options);
  return entries.map(([groupId, mission]) => [
    Number(groupId || (mission && mission.groupId) || (mission && mission.missionID) || 0),
    buildMissionData(Number(mission && mission.missionID) || 0, mission),
  ]);
}

function buildFastLobbyMissionDataEntries(user, options = {}) {
  const result = new Map();
  for (const [groupId, mission] of buildPersistedLobbyMissionEntries(user)) {
    result.set(Number(groupId), [Number(groupId), mission]);
  }
  for (const tabId of FAST_LOBBY_MISSION_TABS) {
    for (const [groupId, mission] of buildAccountMissionDataEntries(user, { ...options, fastLobby: false, tabId })) {
      result.set(Number(groupId), [Number(groupId), mission]);
    }
  }
  return Array.from(result.values()).sort((a, b) => Number(a[0]) - Number(b[0]));
}

function buildPersistedLobbyMissionEntries(user) {
  const completedMissions =
    user && user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  const result = new Map();
  for (const [key, mission] of Object.entries(completedMissions)) {
    const snapshot = normalizePersistedMissionSnapshot(key, mission);
    if (!snapshot || shouldSkipPersistedLobbyMission(snapshot)) continue;
    const groupId = Number(snapshot.groupId || snapshot.missionID || 0);
    if (!Number.isInteger(groupId) || groupId <= 0) continue;
    const existing = result.get(groupId);
    if (!existing || shouldPreferMissionSnapshot(snapshot, existing)) result.set(groupId, snapshot);
  }
  return Array.from(result.entries());
}

function normalizePersistedMissionSnapshot(key, mission) {
  if (!mission || typeof mission !== "object") return null;
  const numericKey = Number(String(key || "").split(":")[0]);
  const missionID = Number(mission.missionID || mission.missionId || mission.id || numericKey || 0);
  const groupId = Number(mission.groupId || mission.group_id || mission.missionGroupId || missionID || 0);
  if (!Number.isInteger(missionID) || missionID <= 0 || !Number.isInteger(groupId) || groupId <= 0) return null;
  const claimed = mission.rewardClaimed === true || mission.isComplete === true || Boolean(mission.claimedAt);
  return {
    ...mission,
    tabId: Number(mission.tabId || 1) || 1,
    groupId,
    missionID,
    times: Math.max(0, Number(mission.times || mission.targetTimes || (claimed ? 1 : 0)) || 0),
    targetTimes: Math.max(1, Number(mission.targetTimes || mission.times || 1) || 1),
    rewardReady: mission.rewardReady === true || claimed,
    isComplete: claimed || mission.isComplete === true,
    rewardClaimed: claimed,
    lastUpdateDate: mission.lastUpdateDate || dateTimeTicksNow(),
  };
}

function shouldSkipPersistedLobbyMission(mission) {
  const tabId = Number(mission && mission.tabId || 0);
  return tabId === 2 || tabId === 3;
}

function shouldPreferMissionSnapshot(candidate, existing) {
  const candidateMissionId = Number(candidate && candidate.missionID || 0);
  const existingMissionId = Number(existing && existing.missionID || 0);
  if (candidateMissionId !== existingMissionId) return candidateMissionId > existingMissionId;
  const candidateClaimed = candidate && candidate.rewardClaimed === true ? 1 : 0;
  const existingClaimed = existing && existing.rewardClaimed === true ? 1 : 0;
  if (candidateClaimed !== existingClaimed) return candidateClaimed > existingClaimed;
  return Number(candidate && candidate.times || 0) > Number(existing && existing.times || 0);
}

function buildMissionData(missionId, mission = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(mission.tabId || 1)),
    writeSignedVarInt(missionId),
    writeSignedVarInt(Number(mission.groupId || missionId)),
    writeSignedVarLong(BigInt(Math.max(0, Number(mission.times || 0)))),
    writeSignedVarLong(coerceDateTimeTicks(mission.lastUpdateDate)),
    writeBool(mission.rewardClaimed === true || mission.isComplete === true || Boolean(mission.claimedAt)),
  ]);
}

function coerceDateTimeTicks(value) {
  try {
    if (value == null || value === "") return dateTimeTicksNow();
    const parsed = BigInt(String(value));
    return parsed > 9000000000000000n ? parsed & 0x3fffffffffffffffn : parsed;
  } catch (_) {
    return dateTimeTicksNow();
  }
}

function dateTimeTicksNow() {
  return dateTimeTicksForDate(getServerNowDate());
}

function getServerNowDate() {
  const eventDate = eventManager && eventManager.config && eventManager.config.enabled ? eventManager.config.eventDate : null;
  return eventDate instanceof Date && !Number.isNaN(eventDate.getTime()) ? eventDate : new Date();
}

function dateTimeTicksForDate(date) {
  const source = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return BigInt(source.getTime()) * 10000n + 621355968000000000n;
}

function dateTimeBinaryForDate(date) {
  return dateTimeTicksForDate(date) | 0x4000000000000000n;
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
    if (!filePath || !fs.existsSync(filePath)) return loadGameplayUnitStatsFromGameplayJsons(result);
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
    console.log(`[gameplay-jsons] unit stats load failed: ${err.message}`);
  }
  return result.loaded ? result : loadGameplayUnitStatsFromGameplayJsons(result);
}

function loadGameplayUnitStatsFromGameplayJsons(result = { byId: new Map(), byStrId: new Map(), loaded: false }) {
  const unitsByStrId = new Map();
  for (const fileName of [
    "LUA_UNIT_TEMPLET_BASE.json",
    "LUA_UNIT_TEMPLET_BASE2.json",
    "LUA_UNIT_TEMPLET_BASE_SD.json",
    "LUA_UNIT_TEMPLET_BASE_OPR.json",
  ]) {
    for (const record of readGameplayTableRecords("ab_script_unit_data", fileName, { rootDir: ROOT_DIR, logLabel: "gameplay-jsons" })) {
      const unitStrId = String(record && record.m_UnitStrID ? record.m_UnitStrID : "");
      if (unitStrId && !unitsByStrId.has(unitStrId)) unitsByStrId.set(unitStrId, record);
    }
  }

  for (const fileName of [
    "LUA_UNIT_STAT_TEMPLET.json",
    "LUA_UNIT_STAT_TEMPLET2.json",
    "LUA_UNIT_STAT_TEMPLET_SD.json",
    "LUA_UNIT_STAT_TEMPLET_OPR.json",
  ]) {
    for (const statRecord of readGameplayTableRecords("ab_script_unit_data", fileName, { rootDir: ROOT_DIR, logLabel: "gameplay-jsons" })) {
      const unitStrId = String(statRecord && statRecord.m_UnitStrID ? statRecord.m_UnitStrID : "");
      if (!unitStrId || result.byStrId.has(unitStrId)) continue;
      const unitRecord = unitsByStrId.get(unitStrId) || {};
      const stats = extractGameplayUnitStats({ ...unitRecord, _stat: statRecord });
      if (!stats) continue;
      if (stats.unitID != null) result.byId.set(String(stats.unitID), stats);
      if (stats.unitStrID) result.byStrId.set(stats.unitStrID, stats);
    }
  }

  result.loaded = result.byId.size > 0 || result.byStrId.size > 0;
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
  db.activeUserUid = nonEmpty(db.activeUserUid);
  db.users = db.users && typeof db.users === "object" ? db.users : {};
  db.usersBySteamAccountId = {};
  db.accessTokens = db.accessTokens && typeof db.accessTokens === "object" ? db.accessTokens : {};
  db.reconnectKeys = db.reconnectKeys && typeof db.reconnectKeys === "object" ? db.reconnectKeys : {};

  for (const user of Object.values(db.users)) {
    indexSteamLoginUser(db, user);
    if (user.accessToken) db.accessTokens[user.accessToken] = user.userUid;
    if (user.reconnectKey) db.reconnectKeys[user.reconnectKey] = user.userUid;
  }
  if (db.activeUserUid && !db.users[db.activeUserUid]) db.activeUserUid = "";
  return db;
}

function saveUserDb() {
  fs.mkdirSync(path.dirname(USER_DB_PATH), { recursive: true });
  const tmpPath = `${USER_DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(userDb, jsonUserDbReplacer, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, USER_DB_PATH);
}

function jsonUserDbReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function getOrCreateUserForSteam(loginReq) {
  const steamAccountId = resolveSteamLoginKey(loginReq);
  const activeUser = getActiveUserForLogin();
  if (activeUser) {
    attachSteamLoginIdentity(activeUser, loginReq, steamAccountId);
    activeUser.lastLoginAt = new Date().toISOString();
    return ensureUserDefaults(activeUser);
  }

  const existingUid = findExistingUserUidForSteamLogin(loginReq, steamAccountId);
  if (existingUid && userDb.users[existingUid]) {
    const user = userDb.users[existingUid];
    attachSteamLoginIdentity(user, loginReq, steamAccountId);
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
    steamLoginKey: steamAccountId,
    steamStableId: extractStableSteamId(loginReq),
    steamLoginTicketHash: hashLoginTicket(loginReq.accessToken),
    deviceUid: loginReq.deviceUid || "",
    nickname: process.env.CS_DEFAULT_NICKNAME || "LocalAdmin",
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  });
  const bootstrap = ensureOfficialNewAccountDefaults(user, {
    rosterMode: NEW_ACCOUNT_ROSTER_MODE,
    includeTrophies: SEED_NEW_ACCOUNT_TROPHIES,
  });
  ensureUserDefaults(user);
  if (bootstrap.changed) {
    console.log(
      `[user-db] new-account-defaults uid=${userUid} units=${bootstrap.units} ships=${bootstrap.ships} operators=${bootstrap.operators} trophies=${bootstrap.trophies}`
    );
  }

  userDb.users[userUid] = user;
  indexSteamLoginUser(userDb, user);
  return user;
}

function getActiveUserForLogin() {
  const activeUid = nonEmpty(userDb.activeUserUid);
  return activeUid && userDb.users[activeUid] ? userDb.users[activeUid] : null;
}

function findExistingUserUidForSteamLogin(loginReq, steamAccountId) {
  const keys = [steamAccountId, nonEmpty(loginReq.accountId)];
  for (const key of keys) {
    const userUid = key ? userDb.usersBySteamAccountId[key] : "";
    if (userUid && userDb.users[userUid]) return userUid;
  }

  const stableSteamId = extractStableSteamId(loginReq);
  if (stableSteamId) {
    const user = chooseNewestUser(
      Object.values(userDb.users).filter((entry) => entry && entry.steamStableId === stableSteamId)
    );
    if (user) return user.userUid;
  }

  const deviceUid = nonEmpty(loginReq.deviceUid);
  if (deviceUid) {
    const user = chooseNewestUser(
      Object.values(userDb.users).filter((entry) => entry && entry.deviceUid === deviceUid)
    );
    if (user) return user.userUid;
  }

  return "";
}

function attachSteamLoginIdentity(user, loginReq, steamAccountId) {
  const previousKeys = [user.steamAccountId, user.steamLoginKey].filter(Boolean);
  for (const key of previousKeys) {
    if (userDb.usersBySteamAccountId[key] === user.userUid && key !== steamAccountId) {
      delete userDb.usersBySteamAccountId[key];
    }
  }
  user.steamAccountId = steamAccountId;
  user.steamLoginKey = steamAccountId;
  user.steamStableId = extractStableSteamId(loginReq) || user.steamStableId || "";
  user.steamLoginTicketHash = hashLoginTicket(loginReq.accessToken) || user.steamLoginTicketHash || "";
  user.deviceUid = loginReq.deviceUid || user.deviceUid || "";
  indexSteamLoginUser(userDb, user);
}

function indexSteamLoginUser(db, user) {
  if (!db || !user || !user.userUid) return;
  for (const key of [user.steamAccountId, user.steamLoginKey]) {
    if (key) db.usersBySteamAccountId[key] = user.userUid;
  }
}

function resolveSteamLoginKey(loginReq) {
  const forcedIdentity = nonEmpty(process.env.CS_LOCAL_USER_IDENTITY_KEY || process.env.CS_LOCAL_USER_IDENTITY);
  if (forcedIdentity) return `local:${forcedIdentity}`;

  const stableSteamId = extractStableSteamId(loginReq);
  if (stableSteamId) return `steam:${stableSteamId}`;

  const deviceUid = nonEmpty(loginReq && loginReq.deviceUid);
  if (deviceUid) return `device:${deviceUid}`;

  const accountId = nonEmpty(loginReq && loginReq.accountId);
  if (accountId && accountId.length <= 96) return `account:${accountId}`;
  return accountId ? `ticket:${hashLoginTicket(accountId)}` : "local:default";
}

function extractStableSteamId(loginReq) {
  const accountId = nonEmpty(loginReq && loginReq.accountId);
  return /^\d{8,20}$/.test(accountId) ? accountId : "";
}

function hashLoginTicket(value) {
  const text = nonEmpty(value);
  return text ? crypto.createHash("sha1").update(text).digest("hex") : "";
}

function chooseNewestUser(users) {
  const validUsers = (Array.isArray(users) ? users : []).filter((user) => user && user.userUid);
  validUsers.sort((a, b) => compareUserRecency(b, a));
  return validUsers[0] || null;
}

function compareUserRecency(a, b) {
  const timeDelta = userRecencyMs(a) - userRecencyMs(b);
  if (timeDelta !== 0) return timeDelta;
  return Number(BigInt(a.userUid || 0) - BigInt(b.userUid || 0));
}

function userRecencyMs(user) {
  return (
    Date.parse(user.lastLoginAt || "") ||
    Date.parse(user.lastJoinAt || "") ||
    Date.parse(user.createdAt || "") ||
    0
  );
}

function ensureUserDefaults(user) {
  user.level = Number(user.level || 1);
  user.exp = String(user.exp || "0");
  ensureAccountProgress(user);
  user.authLevel = Number(user.authLevel || 1);
  user.contentsVersion = user.contentsVersion || CONTENTS_VERSION;
  user.contentsTags = mergeTags(
    Array.isArray(user.contentsTags) && user.contentsTags.length ? user.contentsTags : CONTENTS_TAGS,
    REQUIRED_CONTENTS_TAGS
  );
  user.openTags = mergeTags(Array.isArray(user.openTags) && user.openTags.length ? user.openTags : OPEN_TAGS, REQUIRED_STORY_OPEN_TAGS);
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  ensureInventory(user);
  ensureLocalShopInventory(user);
  ensureArmy(user);
  ensureDefaultLineup(user);
  ensureDefaultLineup(user, { deckType: 3, index: 0 });
  user.tutorial = user.tutorial && typeof user.tutorial === "object"
    ? user.tutorial
    : { enabled: true, firstStageId: 11211, firstDungeonId: 1004 };
  ensureTutorialState(user);
  scrubTutorialEpisodeClearProgress(user);
  ensureMainStoryState(user);
  const repairedDungeonClears = repairDungeonClearDataFromProgress(user);
  if (repairedDungeonClears > 0) {
    console.log(
      `[unlock-progress] repaired dungeon clear unlock data uid=${user.userUid || "(ephemeral)"} entries=${repairedDungeonClears}`
    );
  }
  if (!CLEAR_ALL_MISSIONS_STATUS) repairPostTutorialGuideMissionCompletions(user);
  return user;
}

function ensureLocalShopInventory(user) {
  try {
    const catalog = loadShopCatalog();
    const seedCoreCurrencies = process.env.CS_LOCAL_SHOP_SEED_CORE_CURRENCIES === "1";
    const commonResourceIds = new Set(COMMON_RESOURCE_ITEM_IDS.map((id) => Number(id)));
    const seedBalance = toBigInt(
      process.env.CS_LOCAL_SHOP_BALANCE || process.env.CS_LOCAL_SHOP_CURRENCY_BALANCE,
      DEFAULT_LOCAL_SHOP_BALANCE
    );
    const seedItemIds = seedCoreCurrencies
      ? catalog.priceItemIds || []
      : (catalog.priceItemIds || []).filter((itemId) => !commonResourceIds.has(Number(itemId)));
    seedShopCurrency(user, seedItemIds, {
      balance: seedBalance,
      regDate: dateTimeBinaryNow(),
      seedMissingOnly: true,
      includeCommonResources: seedCoreCurrencies,
    });
    if (
      !seedCoreCurrencies &&
      process.env.CS_REPAIR_LOCAL_SHOP_CORE_CURRENCY_SEED !== "0" &&
      !(user.inventory && user.inventory.coreCurrencySeedRepairedV1)
    ) {
      const repaired = removeDebugSeededCommonResources(user, { balance: seedBalance });
      if (repaired.length > 0) {
        user.inventory.coreCurrencySeedRepairedV1 = new Date().toISOString();
        console.log(
          `[inventory] removed debug seed from core currencies uid=${user.userUid || "(ephemeral)"} items=${repaired
            .map((item) => `${item.itemId}:${item.previousFree}->${item.nextFree}`)
            .join(",")}`
        );
        if (USE_LOCAL_USER_DB) saveUserDb();
      }
    }
  } catch (err) {
    console.log(`[inventory] failed to seed shop currencies: ${err.message}`);
  }
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
    const accessToken = readString(decrypted, offset);
    offset = accessToken.offset;
    const accountId = readString(decrypted, offset);
    offset = accountId.offset;

    lastSteamAccessToken = accessToken.value || "";
    if (lastSteamAccessToken) lastEffectiveAccessToken = lastSteamAccessToken;

    console.log(
      `[STEAM_LOGIN_REQ] protocolVersion=${protocolVersion.value} accountId=${JSON.stringify(accountId.value)} steamTicketLen=${lastSteamAccessToken.length}`
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

function mergeTags(...groups) {
  return Array.from(
    new Set(
      groups
        .flatMap((group) => (Array.isArray(group) ? group : parseTags(String(group || ""))))
        .map((tag) => String(tag || "").trim())
        .filter(Boolean)
    )
  );
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

function loadDotEnv(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice("export ".length).trim();
      const equals = line.indexOf("=");
      if (equals <= 0) continue;
      const key = line.slice(0, equals).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] != null) continue;
      let value = line.slice(equals + 1).trim();
      const quote = value[0];
      if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "");
      }
      process.env[key] = value;
    }
  } catch (err) {
    console.log(`[env] failed to load ${filePath}: ${err.message}`);
  }
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
  return dateTimeBinaryForDate(getServerNowDate());
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
