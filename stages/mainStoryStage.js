const fs = require("fs");
const path = require("path");
const { TUTORIAL_STAGE_CHAIN } = require("./tutorialStage");

const ROOT_DIR = path.resolve(__dirname, "..");
const TABLE_ROOTS = Object.freeze([
  path.join(ROOT_DIR, "gameplay-tables-json", "Assetbundles"),
  path.join(ROOT_DIR, "gameplay-tables-json", "StreamingAssets"),
]);

const DEFAULT_MAIN_STORY_RUNTIME = Object.freeze({
  gameUnitUIDIndex: 30,
  initialGameTime: 4,
  initialRemainGameTime: 180,
  respawnCostA1: 10,
  respawnCostB1: 10,
  gameState: Object.freeze({
    state: 3,
    winTeam: 0,
    waveId: 1,
  }),
  teamA: Object.freeze({
    units: Object.freeze([]),
  }),
  teamB: Object.freeze({
    units: Object.freeze([]),
  }),
  deployableGameUnitUIDGroups: Object.freeze([
    Object.freeze([5, 6]),
    Object.freeze([8, 9]),
    Object.freeze([10, 11]),
    Object.freeze([12, 13]),
    Object.freeze([14, 15]),
    Object.freeze([16, 17]),
    Object.freeze([18, 19]),
    Object.freeze([20, 21]),
  ]),
  autoDeployUnits: Object.freeze([]),
});

const MAINSTREAM_EPISODE_CATEGORY = "EC_MAINSTREAM";
const SUBSTREAM_EPISODE_CATEGORIES = Object.freeze([
  "EC_COUNTERCASE",
  "EC_SEASONAL",
  "EC_SIDESTORY",
  "EC_SIDESTORY_OMEN",
]);
const STORY_EPISODE_CATEGORIES = Object.freeze([MAINSTREAM_EPISODE_CATEGORY, ...SUBSTREAM_EPISODE_CATEGORIES]);
const STORY_EPISODE_CATEGORY_SET = new Set(STORY_EPISODE_CATEGORIES);
const SUBSTREAM_EPISODE_CATEGORY_SET = new Set(SUBSTREAM_EPISODE_CATEGORIES);
const SUBSTREAM_GROUP_IDS = new Set([12001, 12002, 12003, 12004]);
const STORY_CATEGORY_SORT = Object.freeze({
  EC_MAINSTREAM: 0,
  EC_SIDESTORY: 1,
  EC_SIDESTORY_OMEN: 2,
  EC_SEASONAL: 3,
  EC_COUNTERCASE: 4,
});

function readTable(relativePath) {
  for (const root of TABLE_ROOTS) {
    const fullPath = path.join(root, ...relativePath);
    try {
      if (!fs.existsSync(fullPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.records)) return parsed.records;
      return [];
    } catch (err) {
      console.log(`[main-story] failed to load ${fullPath}: ${err.message}`);
      return [];
    }
  }
  return [];
}

function parseMainStoryEpisodeNumber(value) {
  const text = String(value || "");
  const match = /(?:MAINSTREAM_)?EP[_\s-]*(\d+)(?:[_\s-]*(\d+))?/i.exec(text);
  if (!match) return 0;
  const major = Number(match[1] || 0);
  const minor = match[2] != null ? Number(match[2]) : 0;
  if (!Number.isFinite(major) || major <= 0) return 0;
  return minor > 0 ? major + minor / 10 : major;
}

function normalizeTagList(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

const EPISODE_ROWS = readTable(["ab_script", "luac", "LUA_EPISODE_TEMPLET_V2.json"]);
const STAGE_ROWS = readTable(["ab_script", "luac", "LUA_STAGE_TEMPLET.json"]);
const DUNGEON_ROWS = readTable(["ab_script_dungeon_templet", "luac", "LUA_DUNGEON_TEMPLET_BASE.json"]);
const MAP_ROWS = readTable(["ab_script", "luac", "LUA_MAP_TEMPLET.json"]);
const EVENT_DECK_ROWS = readTable(["ab_script", "luac", "LUA_EVENTDECK_TEMPLET.json"]);

const MAIN_STORY_EPISODE_BY_ID = new Map();
for (const row of EPISODE_ROWS) {
  if (!row || row.m_Difficulty !== "NORMAL") continue;
  const episodeCategory = String(row.m_EPCategory || "");
  const groupId = Number(row.GroupID || 0);
  if (!STORY_EPISODE_CATEGORY_SET.has(episodeCategory)) continue;
  const isMainstream = episodeCategory === MAINSTREAM_EPISODE_CATEGORY;
  const isSubstream = SUBSTREAM_EPISODE_CATEGORY_SET.has(episodeCategory) || SUBSTREAM_GROUP_IDS.has(groupId);
  if (!isMainstream && !isSubstream) continue;
  const episodeNumber = isMainstream
    ? parseMainStoryEpisodeNumber(row.m_EpisodeStrID || row.m_OpenTag)
    : Number(row.m_SortIndex || row.m_EpisodeID || 0);
  if (isMainstream && (episodeNumber <= 0 || episodeNumber > 15)) continue;
  MAIN_STORY_EPISODE_BY_ID.set(Number(row.m_EpisodeID), {
    episodeId: Number(row.m_EpisodeID),
    episodeNumber,
    episodeStrID: String(row.m_EpisodeStrID || ""),
    episodeCategory,
    groupId,
    sortIndex: Number(row.m_SortIndex || 0),
    openTag: String(row.m_OpenTag || ""),
    collectionOpenTag: String(row.m_CollectionOpenTag || ""),
    isMainstream,
    isSubstream,
  });
}

const DUNGEON_BY_STR_ID = new Map();
for (const row of DUNGEON_ROWS) {
  if (row && row.m_DungeonStrID) DUNGEON_BY_STR_ID.set(String(row.m_DungeonStrID), row);
}

const MAP_ID_BY_STR_ID = new Map();
for (const row of MAP_ROWS) {
  if (row && row.m_MapStrID) MAP_ID_BY_STR_ID.set(String(row.m_MapStrID), Number(row.m_MapID || 0));
}

const EVENT_DECK_BY_ID = new Map();
const EVENT_DECK_ID_BY_NAME = new Map();
for (const row of EVENT_DECK_ROWS) {
  if (!row) continue;
  const id = Number(row.ID || 0);
  if (id > 0) EVENT_DECK_BY_ID.set(id, row);
  if (row.NAME && id > 0) EVENT_DECK_ID_BY_NAME.set(String(row.NAME), id);
}

const TUTORIAL_STAGE_BY_STAGE_ID = new Map(TUTORIAL_STAGE_CHAIN.map((stage) => [Number(stage.stageId), stage]));

function resolveEventDeckId(stageRow, dungeonRow) {
  const dungeonId = Number(dungeonRow && dungeonRow.m_DungeonID);
  if (dungeonId > 0 && EVENT_DECK_BY_ID.has(dungeonId)) return dungeonId;
  const stageBattleStrID = String((stageRow && stageRow.m_StageBattleStrID) || (dungeonRow && dungeonRow.m_DungeonStrID) || "");
  return EVENT_DECK_ID_BY_NAME.get(stageBattleStrID) || 0;
}

function buildStageFromTable(stageRow) {
  const stageId = Number(stageRow && stageRow.m_StageID);
  const episode = MAIN_STORY_EPISODE_BY_ID.get(Number(stageRow && stageRow.m_EpisodeID));
  if (!stageId || !episode) return null;
  const dungeon = DUNGEON_BY_STR_ID.get(String(stageRow.m_StageBattleStrID || "")) || null;
  const dungeonID = Number(dungeon && dungeon.m_DungeonID);
  if (!dungeonID) return null;
  const mapStrID = String((dungeon && dungeon.m_DungeonMapStrID) || "");
  const cutsceneOnly = String(dungeon && dungeon.m_DungeonType) === "NDT_CUTSCENE";
  const tutorial = String(stageRow.m_StageSubType || "") === "SST_TUTORIAL";
  const tutorialRuntime = TUTORIAL_STAGE_BY_STAGE_ID.get(stageId);
  const base = tutorialRuntime
    ? {
        ...tutorialRuntime,
      }
    : {
        ...DEFAULT_MAIN_STORY_RUNTIME,
        teamA: { units: [] },
        teamB: { units: [] },
      };

  return Object.freeze({
    ...base,
    episodeId: episode.episodeId,
    episodeNumber: episode.episodeNumber,
    episodeStrID: episode.episodeStrID,
    episodeCategory: episode.episodeCategory,
    episodeGroupId: episode.groupId,
    episodeSortIndex: episode.sortIndex,
    openTag: String(stageRow.m_OpenTag || episode.openTag || ""),
    collectionOpenTag: episode.collectionOpenTag,
    stageId,
    stageStrID: String(stageRow.m_StageStrID || ""),
    dungeonID,
    dungeonStrID: String((dungeon && dungeon.m_DungeonStrID) || stageRow.m_StageBattleStrID || ""),
    mapID: cutsceneOnly ? 0 : MAP_ID_BY_STR_ID.get(mapStrID) || 0,
    mapStrID,
    actId: Number(stageRow.m_ActID || 0),
    stageIndex: Number(stageRow.m_StageIndex || 0),
    stageUINum: Number(stageRow.m_StageUINum || stageRow.m_StageIndex || 0),
    stageType: String(stageRow.m_StageType || ""),
    stageSubType: String(stageRow.m_StageSubType || ""),
    unlockReqType: String(stageRow.m_UnlockReqType || ""),
    unlockReqValue: Number(stageRow.m_UnlockReqValue || 0),
    dungeonType: String((dungeon && dungeon.m_DungeonType) || ""),
    eventDeckId: cutsceneOnly ? 0 : resolveEventDeckId(stageRow, dungeon),
    isMainstreamStory: Boolean(episode.isMainstream),
    isSubstreamStory: Boolean(episode.isSubstream),
    tutorial,
    cutsceneOnly,
  });
}

function compareMainStoryStages(a, b) {
  return (
    Number(STORY_CATEGORY_SORT[a.episodeCategory] ?? 99) - Number(STORY_CATEGORY_SORT[b.episodeCategory] ?? 99) ||
    Number(a.episodeSortIndex || a.episodeNumber || 0) - Number(b.episodeSortIndex || b.episodeNumber || 0) ||
    Number(a.episodeNumber || 0) - Number(b.episodeNumber || 0) ||
    Number(a.episodeId || 0) - Number(b.episodeId || 0) ||
    Number(a.actId || 0) - Number(b.actId || 0) ||
    Number(a.stageIndex || 0) - Number(b.stageIndex || 0) ||
    Number(a.stageId || 0) - Number(b.stageId || 0)
  );
}

function buildMainStoryStageChain() {
  const stages = [];
  const seenStageIds = new Set();
  for (const row of STAGE_ROWS) {
    if (!row || row.m_Difficulty !== "NORMAL") continue;
    const episode = MAIN_STORY_EPISODE_BY_ID.get(Number(row.m_EpisodeID));
    if (!episode) continue;
    if (episode.isMainstream && !String(row.m_StageStrID || "").startsWith("STAGE_MAINSTREAM_")) continue;
    const stage = buildStageFromTable(row);
    if (!stage || seenStageIds.has(stage.stageId)) continue;
    seenStageIds.add(stage.stageId);
    stages.push(stage);
  }
  stages.sort(compareMainStoryStages);
  return Object.freeze(stages);
}

const MAIN_STORY_STAGE_CHAIN = buildMainStoryStageChain();
const MAINSTREAM_STAGE_CHAIN = Object.freeze(MAIN_STORY_STAGE_CHAIN.filter((stage) => stage.isMainstreamStory));
const SUBSTREAM_STAGE_CHAIN = Object.freeze(MAIN_STORY_STAGE_CHAIN.filter((stage) => stage.isSubstreamStory));
const EPISODE1_STAGE_CHAIN = Object.freeze(MAIN_STORY_STAGE_CHAIN.filter((stage) => Number(stage.episodeId) === 2));
const MAIN_STORY_STAGE_BY_STAGE_ID = new Map(MAIN_STORY_STAGE_CHAIN.map((stage) => [stage.stageId, stage]));
const MAIN_STORY_STAGE_BY_DUNGEON_ID = new Map(MAIN_STORY_STAGE_CHAIN.map((stage) => [stage.dungeonID, stage]));
const EPISODE1_STAGE_BY_STAGE_ID = new Map(EPISODE1_STAGE_CHAIN.map((stage) => [stage.stageId, stage]));
const EPISODE1_STAGE_BY_DUNGEON_ID = new Map(EPISODE1_STAGE_CHAIN.map((stage) => [stage.dungeonID, stage]));

function buildStoryOpenTags() {
  const tags = new Set();
  for (const episode of MAIN_STORY_EPISODE_BY_ID.values()) {
    if (!episode.isSubstream) continue;
    for (const tag of normalizeTagList(episode.openTag, episode.collectionOpenTag)) tags.add(tag);
  }
  for (const stage of MAIN_STORY_STAGE_CHAIN) {
    if (!stage.isSubstreamStory) continue;
    for (const tag of normalizeTagList(stage.openTag, stage.collectionOpenTag)) tags.add(tag);
  }
  return Object.freeze(Array.from(tags).sort());
}

const STORY_OPEN_TAGS = buildStoryOpenTags();

function cloneUnit(unit, team) {
  return {
    ...unit,
    team,
    maxHp: unit.hp,
    targetUID: 0,
    subTargetUID: 0,
    speedX: 0,
    speedY: 0,
    speedZ: 0,
    savedPosX: unit.x,
  };
}

function cloneStage(stage) {
  if (!stage) return null;
  return {
    ...DEFAULT_MAIN_STORY_RUNTIME,
    ...stage,
    gameState: { ...(stage.gameState || DEFAULT_MAIN_STORY_RUNTIME.gameState) },
    teamA: {
      units: (stage.teamA && stage.teamA.units ? stage.teamA.units : []).map((unit) => ({ ...unit })),
    },
    teamB: {
      units: (stage.teamB && stage.teamB.units ? stage.teamB.units : []).map((unit) => ({ ...unit })),
    },
    deployableGameUnitUIDGroups: (stage.deployableGameUnitUIDGroups || DEFAULT_MAIN_STORY_RUNTIME.deployableGameUnitUIDGroups).map((group) =>
      group.slice()
    ),
    autoDeployUnits: (stage.autoDeployUnits || []).map((unit) => ({
      ...unit,
      gameUnitUIDs: unit.gameUnitUIDs.slice(),
    })),
    initialUnits: [
      ...(stage.teamA && stage.teamA.units ? stage.teamA.units : []).map((unit) => cloneUnit(unit, 1)),
      ...(stage.teamB && stage.teamB.units ? stage.teamB.units : []).map((unit) => cloneUnit(unit, 3)),
    ],
  };
}

function getMainStoryStageByStageId(stageId) {
  const stage = MAIN_STORY_STAGE_BY_STAGE_ID.get(Number(stageId));
  return stage ? cloneStage(stage) : null;
}

function getMainStoryStageByDungeonId(dungeonId) {
  const stage = MAIN_STORY_STAGE_BY_DUNGEON_ID.get(Number(dungeonId));
  return stage ? cloneStage(stage) : null;
}

function getMainStoryStageForRequest(req) {
  if (!req) return null;
  return getMainStoryStageByStageId(req.stageID) || getMainStoryStageByDungeonId(req.dungeonID);
}

function getEpisode1StageByStageId(stageId) {
  const stage = EPISODE1_STAGE_BY_STAGE_ID.get(Number(stageId));
  return stage ? cloneStage(stage) : null;
}

function getEpisode1StageByDungeonId(dungeonId) {
  const stage = EPISODE1_STAGE_BY_DUNGEON_ID.get(Number(dungeonId));
  return stage ? cloneStage(stage) : null;
}

function getEpisode1StageForRequest(req) {
  if (!req) return null;
  return getEpisode1StageByStageId(req.stageID) || getEpisode1StageByDungeonId(req.dungeonID);
}

function isMainStoryStageId(stageId) {
  return MAIN_STORY_STAGE_BY_STAGE_ID.has(Number(stageId));
}

function isMainStoryDungeonId(dungeonId) {
  return MAIN_STORY_STAGE_BY_DUNGEON_ID.has(Number(dungeonId));
}

function isMainStoryCutsceneDungeonId(dungeonId) {
  const stage = MAIN_STORY_STAGE_BY_DUNGEON_ID.get(Number(dungeonId));
  return Boolean(stage && stage.cutsceneOnly);
}

function isEpisode1StageId(stageId) {
  return EPISODE1_STAGE_BY_STAGE_ID.has(Number(stageId));
}

function isEpisode1DungeonId(dungeonId) {
  return EPISODE1_STAGE_BY_DUNGEON_ID.has(Number(dungeonId));
}

function isEpisode1CutsceneDungeonId(dungeonId) {
  const stage = EPISODE1_STAGE_BY_DUNGEON_ID.get(Number(dungeonId));
  return Boolean(stage && stage.cutsceneOnly);
}

function mapIdForStageDungeon(stageId, dungeonId) {
  const stage = MAIN_STORY_STAGE_BY_STAGE_ID.get(Number(stageId)) || MAIN_STORY_STAGE_BY_DUNGEON_ID.get(Number(dungeonId));
  return stage && Number(stage.mapID) > 0 ? stage.mapID : 0;
}

function stageIdForDungeonId(dungeonId) {
  const stage = MAIN_STORY_STAGE_BY_DUNGEON_ID.get(Number(dungeonId));
  return stage ? stage.stageId : 0;
}

function tutorialPhaseKey(stage) {
  return String(stage && (stage.dungeonID || stage.dungeonId || stage.stageId || ""));
}

function getTutorialPhaseForStage(user, stage) {
  const tutorial = user && user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : null;
  if (!phases) return null;
  return phases[tutorialPhaseKey(stage)] || phases[String(stage.stageId)] || null;
}

function isTutorialCompleteForMainStory(user) {
  const tutorial = user && user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  if (!tutorial || tutorial.enabled === false) return true;
  if (tutorial.completed === true) return true;
  const phases = tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : null;
  if (!phases) return false;
  return TUTORIAL_STAGE_CHAIN.every((stage) => {
    const phase = phases[tutorialPhaseKey(stage)] || phases[String(stage.stageId)];
    return phase && phase.completed === true;
  });
}

function isDungeonClearedForStory(user, dungeonId) {
  const numericDungeonId = Number(dungeonId || 0);
  if (!numericDungeonId) return false;
  const dungeonClear = user && user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  if (dungeonClear[String(numericDungeonId)]) return true;
  const stage = MAIN_STORY_STAGE_BY_DUNGEON_ID.get(numericDungeonId);
  if (!stage) return false;
  const state =
    user &&
    user.mainStory &&
    user.mainStory.stages &&
    typeof user.mainStory.stages === "object" &&
    user.mainStory.stages[String(stage.stageId)];
  return Boolean(state && state.completed === true);
}

function isStageClearedForStory(user, stageId) {
  const numericStageId = Number(stageId || 0);
  if (!numericStageId) return false;
  const stagePlayData = user && user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  if (stagePlayData[String(numericStageId)]) return true;
  const state =
    user &&
    user.mainStory &&
    user.mainStory.stages &&
    typeof user.mainStory.stages === "object" &&
    user.mainStory.stages[String(numericStageId)];
  return Boolean(state && state.completed === true);
}

function isStoryStageRequirementSatisfied(user, stage) {
  if (!stage) return false;
  switch (stage.unlockReqType) {
    case "":
    case "SURT_ALWAYS_UNLOCKED":
      return true;
    case "SURT_PLAYER_LEVEL":
      return Number(user && (user.level || user.m_UserLevel || 1)) >= Number(stage.unlockReqValue || 0);
    case "SURT_CLEAR_DUNGEON":
    case "SURT_CLEAR_DUNGEON_START_DATETIME":
      return isDungeonClearedForStory(user, stage.unlockReqValue);
    case "SURT_CLEAR_PHASE":
      return isStageClearedForStory(user, stage.unlockReqValue);
    case "SURT_ALWAYS_LOCKED":
    case "SURT_ALWAYS_HIDDEN":
      return false;
    default:
      return false;
  }
}

function ensureMainStoryContainers(user) {
  user.mainStory = user.mainStory && typeof user.mainStory === "object" ? user.mainStory : {};
  user.mainStory.stages =
    user.mainStory.stages && typeof user.mainStory.stages === "object" ? user.mainStory.stages : {};
  if (user.episode1 && user.episode1.stages && typeof user.episode1.stages === "object") {
    for (const [stageId, state] of Object.entries(user.episode1.stages)) {
      if (!MAIN_STORY_STAGE_BY_STAGE_ID.has(Number(stageId))) continue;
      if (!user.mainStory.stages[stageId]) user.mainStory.stages[stageId] = { ...state };
    }
  }
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
}

function syncEpisode1CompatState(user) {
  user.episode1 = user.episode1 && typeof user.episode1 === "object" ? user.episode1 : {};
  user.episode1.stages = {};
  for (const stage of EPISODE1_STAGE_CHAIN) {
    const state = user.mainStory.stages[String(stage.stageId)];
    if (state) user.episode1.stages[String(stage.stageId)] = { ...state };
  }
  user.episode1.unlocked = true;
  user.episode1.completed = EPISODE1_STAGE_CHAIN.every((stage) => {
    const state = user.episode1.stages[String(stage.stageId)];
    return state && state.completed === true;
  });
}

function repairRewardedMainStoryClears(user) {
  const cursors =
    user && user.localStageRewardCursors && typeof user.localStageRewardCursors === "object" ? user.localStageRewardCursors : {};
  for (const stage of MAIN_STORY_STAGE_CHAIN) {
    if (!stage || stage.tutorial) continue;
    const dungeonKey = String(stage.dungeonID);
    const stageKey = String(stage.stageId);
    const previousClear = user.dungeonClear[dungeonKey] || null;
    const previousPlay = user.stagePlayData[stageKey] || null;
    const existing = user.mainStory.stages[stageKey] || {};
    const rewardClearCount = Math.max(0, Math.trunc(Number(cursors[`credit:${stage.dungeonID}`] || 0) || 0));
    if (!previousClear && !previousPlay && existing.completed !== true && rewardClearCount <= 0) continue;

    const completedAt = existing.completedAt || new Date().toISOString();
    user.dungeonClear[dungeonKey] = {
      ...(previousClear || {}),
      dungeonId: stage.dungeonID,
      stageId: stage.stageId,
      missionResult1: true,
      missionResult2: true,
      clearedAt: completedAt,
    };

    if (!previousPlay && existing.completed !== true && rewardClearCount <= 0) continue;
    user.stagePlayData[stageKey] = {
      ...(previousPlay || {}),
      stageId: Number((previousPlay && previousPlay.stageId) || stage.stageId),
      playCount: Math.max(1, Number((previousPlay && previousPlay.playCount) || 0), rewardClearCount),
      totalPlayCount: Math.max(1, Number((previousPlay && previousPlay.totalPlayCount) || 0), rewardClearCount),
      bestClearTimeSec: Number((previousPlay && previousPlay.bestClearTimeSec) || existing.bestClearTimeSec || 0),
    };
  }
}

function backfillCompletedMainStoryStageState(user, stage, state) {
  const dungeonKey = String(stage.dungeonID);
  const stageKey = String(stage.stageId);
  const previousClear = user.dungeonClear[dungeonKey] || {};
  const completedAt = previousClear.clearedAt || state.completedAt || new Date().toISOString();
  user.dungeonClear[dungeonKey] = {
    ...previousClear,
    dungeonId: Number(previousClear.dungeonId || stage.dungeonID),
    stageId: Number(previousClear.stageId || stage.stageId),
    missionResult1: previousClear.missionResult1 === true || state.missionResult1 !== false,
    missionResult2: previousClear.missionResult2 === true || state.missionResult2 !== false,
    clearedAt: completedAt,
  };

  const previousPlay = user.stagePlayData[stageKey] || {};
  const playCount = Math.max(1, Number(previousPlay.playCount || 0));
  user.stagePlayData[stageKey] = {
    ...previousPlay,
    stageId: Number(previousPlay.stageId || stage.stageId),
    playCount,
    totalPlayCount: Math.max(playCount, Number(previousPlay.totalPlayCount || 0), 1),
    bestClearTimeSec: Number(previousPlay.bestClearTimeSec || state.bestClearTimeSec || 0),
  };
}

function ensureMainStoryState(user) {
  if (!user || typeof user !== "object") return null;
  ensureMainStoryContainers(user);
  const existingUnlocked = new Set(user.unlockedStageIds.map(Number).filter((id) => Number.isInteger(id) && id > 0));
  const unlocked = new Set([...existingUnlocked].filter((id) => !MAIN_STORY_STAGE_BY_STAGE_ID.has(id)));
  repairRewardedMainStoryClears(user);
  const dungeonClear = user.dungeonClear;
  const stagePlayData = user.stagePlayData;
  const tutorialComplete = isTutorialCompleteForMainStory(user);
  let previousTutorialPhaseComplete = true;
  let nextMainStoryStageUnlocked = tutorialComplete;

  for (const stage of MAIN_STORY_STAGE_CHAIN) {
    const existing = user.mainStory.stages[String(stage.stageId)] || {};
    const clear = dungeonClear[String(stage.dungeonID)];
    const play = stagePlayData[String(stage.stageId)];
    const phase = stage.tutorial ? getTutorialPhaseForStage(user, stage) : null;
    const tutorialPhaseComplete = Boolean(tutorialComplete || (phase && phase.completed === true));
    const completed = stage.tutorial
      ? tutorialPhaseComplete || Boolean(clear)
      : Boolean(clear) || Boolean(play) || existing.completed === true;
    const hasLocalProgress = Boolean(clear) || Boolean(play) || completed;
    const stageUnlocked = stage.tutorial
      ? previousTutorialPhaseComplete || completed
      : stage.isMainstreamStory
        ? nextMainStoryStageUnlocked || hasLocalProgress
        : hasLocalProgress || isStoryStageRequirementSatisfied(user, stage);

    if (stageUnlocked) unlocked.add(stage.stageId);
    if (stage.tutorial) previousTutorialPhaseComplete = completed;
    else if (stage.isMainstreamStory) nextMainStoryStageUnlocked = completed;

    const stageState = {
      episodeId: stage.episodeId,
      episodeNumber: stage.episodeNumber,
      episodeStrID: stage.episodeStrID,
      episodeCategory: stage.episodeCategory,
      episodeGroupId: stage.episodeGroupId,
      actId: stage.actId,
      stageIndex: stage.stageIndex,
      stageId: stage.stageId,
      dungeonId: stage.dungeonID,
      stageStrID: stage.stageStrID,
      dungeonStrID: stage.dungeonStrID,
      mapID: stage.mapID,
      cutsceneOnly: Boolean(stage.cutsceneOnly),
      substream: Boolean(stage.isSubstreamStory),
      unlocked: stageUnlocked,
      completed,
      completedAt: completed ? existing.completedAt || (clear && clear.clearedAt) || "" : "",
      bestClearTimeSec: completed ? Number(existing.bestClearTimeSec || (play && play.bestClearTimeSec) || 0) : 0,
      missionResult1: completed ? (clear ? clear.missionResult1 !== false : existing.missionResult1 !== false) : false,
      missionResult2: completed ? (clear ? clear.missionResult2 !== false : existing.missionResult2 !== false) : false,
    };
    user.mainStory.stages[String(stage.stageId)] = stageState;
    if (completed) backfillCompletedMainStoryStageState(user, stage, stageState);
  }

  user.unlockedStageIds = Array.from(unlocked).sort((a, b) => a - b);
  user.mainStory.unlocked = true;
  user.mainStory.completed = MAINSTREAM_STAGE_CHAIN.every((stage) => {
    const state = user.mainStory.stages[String(stage.stageId)];
    return state && state.completed === true;
  });
  syncEpisode1CompatState(user);
  return user.mainStory;
}

function recordMainStoryDungeonClearForUser(user, dungeonId, stageId, battleState = {}, options = {}) {
  if (!user) return false;
  const stage = getMainStoryStageByDungeonId(dungeonId) || getMainStoryStageByStageId(stageId);
  if (!stage) return false;
  if (stage.tutorial) return false;
  ensureMainStoryState(user);
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const resolvedStageId = Number(stage.stageId || stageId || 0);
  const resolvedDungeonId = Number(stage.dungeonID || dungeonId || 0);
  const bestClearTimeSec = Math.max(0, Math.round(Number((battleState && (battleState.gameTime || battleState.GameTime)) || 0)));
  const previousClear = user.dungeonClear[String(resolvedDungeonId)] || {};
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
  const previousStagePlay = user.stagePlayData[String(resolvedStageId)] || {};
  const clearTimeCandidates = [Number(previousStagePlay.bestClearTimeSec || 0), bestClearTimeSec].filter((value) => value > 0);
  const bestRecordedClearTimeSec = clearTimeCandidates.length > 0 ? Math.min(...clearTimeCandidates) : bestClearTimeSec;

  user.dungeonClear[String(resolvedDungeonId)] = {
    dungeonId: resolvedDungeonId,
    stageId: resolvedStageId,
    missionResult1,
    missionResult2,
    clearedAt: previousClear.clearedAt || new Date().toISOString(),
  };
  user.stagePlayData[String(resolvedStageId)] = {
    stageId: resolvedStageId,
    playCount: Number(previousStagePlay.playCount || 0) + 1,
    totalPlayCount: Number(previousStagePlay.totalPlayCount || 0) + 1,
    bestClearTimeSec: bestRecordedClearTimeSec,
  };
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  if (!user.unlockedStageIds.includes(resolvedStageId)) user.unlockedStageIds.push(resolvedStageId);
  const state = user.mainStory.stages[String(resolvedStageId)];
  if (state) {
    state.completed = true;
    state.completedAt = state.completedAt || new Date().toISOString();
    state.bestClearTimeSec = bestRecordedClearTimeSec;
    state.missionResult1 = state.missionResult1 === true || missionResult1;
    state.missionResult2 = state.missionResult2 === true || missionResult2;
  }
  ensureMainStoryState(user);
  if (typeof options.save === "function") options.save();
  return true;
}

function resetMainStoryPostTutorialProgress(user) {
  if (!user || typeof user !== "object") return false;
  const postTutorialStages = MAIN_STORY_STAGE_CHAIN.filter((stage) => stage && !stage.tutorial);
  const postTutorialStageIds = new Set(postTutorialStages.map((stage) => Number(stage.stageId)));
  const postTutorialDungeonIds = new Set(postTutorialStages.map((stage) => Number(stage.dungeonID)));
  let changed = false;

  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};

  for (const stage of postTutorialStages) {
    const dungeonKey = String(stage.dungeonID);
    const stageKey = String(stage.stageId);
    if (Object.prototype.hasOwnProperty.call(user.dungeonClear, dungeonKey)) {
      delete user.dungeonClear[dungeonKey];
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(user.stagePlayData, stageKey)) {
      delete user.stagePlayData[stageKey];
      changed = true;
    }
  }

  if (Array.isArray(user.unlockedStageIds)) {
    const nextUnlocked = user.unlockedStageIds.filter((stageId) => !postTutorialStageIds.has(Number(stageId)));
    if (
      nextUnlocked.length !== user.unlockedStageIds.length ||
      nextUnlocked.some((stageId, index) => stageId !== user.unlockedStageIds[index])
    ) {
      user.unlockedStageIds = nextUnlocked;
      changed = true;
    }
  } else {
    user.unlockedStageIds = [];
  }

  for (const containerName of ["mainStory", "episode1"]) {
    const container = user[containerName] && typeof user[containerName] === "object" ? user[containerName] : null;
    if (!container) continue;
    container.stages = container.stages && typeof container.stages === "object" ? container.stages : {};
    for (const stage of postTutorialStages) {
      const stageKey = String(stage.stageId);
      if (Object.prototype.hasOwnProperty.call(container.stages, stageKey)) {
        delete container.stages[stageKey];
        changed = true;
      }
    }
    if (container.completed) changed = true;
    container.completed = false;
  }

  if (user.localStageRewardCursors && typeof user.localStageRewardCursors === "object") {
    for (const stage of postTutorialStages) {
      const cursorKey = `credit:${stage.dungeonID}`;
      if (Object.prototype.hasOwnProperty.call(user.localStageRewardCursors, cursorKey)) {
        delete user.localStageRewardCursors[cursorKey];
        changed = true;
      }
    }
  }

  if (user.clearConditions && typeof user.clearConditions === "object") {
    const clearDungeons =
      user.clearConditions.dungeons && typeof user.clearConditions.dungeons === "object"
        ? user.clearConditions.dungeons
        : null;
    const clearStages =
      user.clearConditions.stages && typeof user.clearConditions.stages === "object" ? user.clearConditions.stages : null;
    if (clearDungeons) {
      for (const dungeonId of postTutorialDungeonIds) {
        const key = String(dungeonId);
        if (Object.prototype.hasOwnProperty.call(clearDungeons, key)) {
          delete clearDungeons[key];
          changed = true;
        }
      }
    }
    if (clearStages) {
      for (const stageId of postTutorialStageIds) {
        const key = String(stageId);
        if (Object.prototype.hasOwnProperty.call(clearStages, key)) {
          delete clearStages[key];
          changed = true;
        }
      }
    }
  }

  if (user.gameplayUnlocks && typeof user.gameplayUnlocks === "object") {
    const removedUnlockKeys = new Set();
    const byDungeon =
      user.gameplayUnlocks.byDungeon && typeof user.gameplayUnlocks.byDungeon === "object"
        ? user.gameplayUnlocks.byDungeon
        : null;
    const byKey =
      user.gameplayUnlocks.byKey && typeof user.gameplayUnlocks.byKey === "object" ? user.gameplayUnlocks.byKey : null;
    if (byDungeon) {
      for (const dungeonId of postTutorialDungeonIds) {
        const key = String(dungeonId);
        const unlockKeys = Array.isArray(byDungeon[key]) ? byDungeon[key] : [];
        for (const unlockKey of unlockKeys) removedUnlockKeys.add(String(unlockKey));
        if (Object.prototype.hasOwnProperty.call(byDungeon, key)) {
          delete byDungeon[key];
          changed = true;
        }
      }
    }
    if (byKey) {
      for (const [key, unlock] of Object.entries(byKey)) {
        const stageId = Number(unlock && unlock.stageId);
        const reqValue = Number(unlock && unlock.reqValue);
        if (removedUnlockKeys.has(String(key)) || postTutorialStageIds.has(stageId) || postTutorialDungeonIds.has(reqValue)) {
          delete byKey[key];
          changed = true;
        }
      }
    }
  }

  if (user.persistentCutsceneViews && typeof user.persistentCutsceneViews === "object") {
    for (const [key, view] of Object.entries(user.persistentCutsceneViews)) {
      const dungeonId = Number((view && view.dungeonId) || key);
      const stageId = Number((view && view.stageId) || key);
      if (postTutorialDungeonIds.has(dungeonId) || postTutorialStageIds.has(stageId)) {
        delete user.persistentCutsceneViews[key];
        changed = true;
      }
    }
  }

  ensureMainStoryState(user);
  return changed;
}

module.exports = {
  MAIN_STORY_STAGE_CHAIN,
  MAINSTREAM_STAGE_CHAIN,
  SUBSTREAM_STAGE_CHAIN,
  MAIN_STORY_EPISODE_BY_ID,
  STORY_OPEN_TAGS,
  getMainStoryStageByStageId,
  getMainStoryStageByDungeonId,
  getMainStoryStageForRequest,
  isMainStoryStageId,
  isMainStoryDungeonId,
  isMainStoryCutsceneDungeonId,
  mapIdForStageDungeon,
  stageIdForDungeonId,
  ensureMainStoryState,
  recordMainStoryDungeonClearForUser,
  resetMainStoryPostTutorialProgress,
  getStoryOpenTags: () => STORY_OPEN_TAGS.slice(),

  EPISODE1_STAGE_CHAIN,
  getEpisode1StageByStageId,
  getEpisode1StageByDungeonId,
  getEpisode1StageForRequest,
  isEpisode1StageId,
  isEpisode1DungeonId,
  isEpisode1CutsceneDungeonId,
  ensureEpisode1State: ensureMainStoryState,
  recordEpisode1DungeonClearForUser: recordMainStoryDungeonClearForUser,
  resetEpisode1PostTutorialProgress: resetMainStoryPostTutorialProgress,
};
