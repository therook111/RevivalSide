const fs = require("fs");
const path = require("path");
const {
  expandTableRoots,
  parsePathList,
} = require("../modules/gameplay-jsons");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_ROOT = path.join(ROOT_DIR, "gameplay-jsons", "Assetbundles");
const OUTPUT_BASE = path.join(ROOT_DIR, "gameplay-jsons");
let SOURCE_ROOTS = [];

const UNIT_KEYS = [
  "m_UnitID",
  "m_UnitStrID",
  "m_NKM_UNIT_TYPE",
  "m_NKM_UNIT_STYLE_TYPE",
  "m_NKM_UNIT_ROLE_TYPE",
  "m_bMonster",
  "m_bContractable",
  "m_StarGradeMax",
  "m_NKM_UNIT_GRADE",
  "m_bAwaken",
  "m_BaseUnitID",
  "m_bProfileMainUnit",
  "m_SkillStrID1",
  "m_SkillStrID2",
  "m_SkillStrID3",
  "m_SkillStrID4",
  "m_SkillStrID5",
];

const SHOP_KEYS = [
  "IDX",
  "m_ProductID",
  "m_MarketID",
  "m_TabID",
  "m_TabSubIndex",
  "m_OrderList",
  "m_TabName",
  "m_ItemName",
  "m_Item_Desc",
  "m_Item_Desc_Popup",
  "m_TopBannerText",
  "m_CardPrefab",
  "m_CardImage",
  "m_TagImage",
  "m_ItemType",
  "m_ItemID",
  "m_Value",
  "m_FreeValue",
  "m_PaidValue",
  "m_PriceItemID",
  "m_Price",
  "m_PriceSteam",
  "m_PriceSteamKRW",
  "m_bEnabled",
  "m_bVisible",
  "m_bUnlockBanner",
  "m_HideWhenSoldOut",
  "m_QuantityLimitCond",
  "m_QuantityLimit",
  "m_LimitShowIndex",
  "m_ChainIndex",
  "m_OpenTag",
  "m_EventDateStrID",
  "m_DiscountDateStrID",
  "m_NewbieDate",
  "m_EventTime",
  "m_MailTitle",
  "m_MailDesc",
  "m_PurchaseEventType",
  "m_PurchaseEventID",
  "m_PurchaseEventValue",
  "m_BuffRewardID",
  "m_UnlockReqStrID",
  "m_DiscountRate",
  "m_ProfitRate",
  "m_refundMedalCount",
  "m_ReturningUserType",
  "m_InstantProductLimit",
  "m_Reddot",
  "m_Reddot_Allow",
  "m_Spoiler",
  "bPointExchangeSpecial",
  "m_paidAmountRequired",
  "m_UnlockReqType",
  "m_UnlockReqValue",
  "listContentsTagAllow",
  "listContentsTagIgnore",
];

const SHOP_TAB_KEYS = [
  "m_TabID",
  "m_TabSubIndex",
  "m_TabName",
  "m_ShopDisplay",
  "m_TabImageSelect",
  "m_TopBannerText",
  "m_ImgBGSelected",
  "m_ImgBGUnSelected",
  "m_SpecialColorCode",
  "m_PackageGroupID",
  "m_HideWhenSoldOut",
  "m_Visible",
  "m_MultiBuy",
  "m_DateStrID",
  "m_OpenTag",
  "m_TagImage",
  "m_bTabChain",
  "m_bBundlePurchase",
  "m_ResetDays",
  ...indexedKeys("m_ResourceTypeID", 5),
  "listContentsTagAllow",
  "listContentsTagIgnore",
];

const SHOP_CATEGORY_KEYS = [
  "m_ShopTabCategory",
  "m_TabCategoryName",
  "m_OrderList",
  "m_ThumbnailImg",
  "m_UseTabID",
  "m_UnusedResourceID",
  "listContentsTagAllow",
  "listContentsTagIgnore",
];

const SHOP_BANNER_KEYS = [
  "m_ContentsVersionStart",
  "m_ContentsVersionEnd",
  "IDX",
  "m_Enable",
  "m_ShopHome_BannerImage",
  "m_ShopHome_BannerPrefab",
  "m_TabID",
  "m_TabSubIndex",
  "m_DateStrID",
  "m_ProductID",
  "m_DisplayCond",
  "m_DisplayCondValue",
  "m_OpenTag",
  "listContentsTagAllow",
  "listContentsTagIgnore",
];

const SHOP_FEATURED_KEYS = [
  "m_PackageID",
  "m_PackageGroupID",
  "m_OrderList",
  "m_DisplayCond",
  "m_DisplayCondValue1",
  "m_DisplayCondValue2",
  "m_FeaturedImage",
  "m_ReddotRequired",
  "m_OpenTag",
  "m_DateStrID",
  "listContentsTagAllow",
  "listContentsTagIgnore",
];

const SHOP_RECOMMEND_KEYS = [
  "m_RecommendID",
  "m_ProductID",
  "m_OrderList",
  "m_OpenTag",
  "m_DateStrID",
  "listContentsTagAllow",
  "listContentsTagIgnore",
];

const MISC_ITEM_KEYS = [
  "m_ItemMiscID",
  "m_ItemMiscStrID",
  "m_ItemMiscType",
  "m_ItemMiscSubType",
  "m_RewardGroupID",
  "m_CustomRewardGroupID",
  "m_typeValue",
  "m_ItemMiscName",
  "m_ItemMiscDesc",
  "m_ExpireType",
  "m_ExpireTime",
];

const REWARD_KEYS = [
  "m_RewardGroupID",
  "m_CustomRewardGroupID",
  "m_RewardID",
  "m_RewardType",
  "m_RewardValue",
  "m_FreeValue",
  "m_PaidValue",
  "m_Quantity_Min",
  "m_FreeQuantity_Min",
  "m_PaidQuantity_Min",
  "m_Ratio",
  "m_RewardGroupStrID",
  "m_RewardStrID",
  "m_OrderList",
  "m_Order",
  "m_Index",
];
const REWARD_TEMPLET_KEYS = [
  "m_RewardGroupID",
  "m_CustomRewardGroupID",
  "m_DateStrID",
  "listContentsTagAllow",
  "listContentsTagIgnore",
  ...REWARD_KEYS.filter((key) => key !== "m_RewardGroupID" && key !== "m_CustomRewardGroupID"),
];

const ACQ_PACKAGE_KEYS = ["m_PackageID", ...indexedKeys("m_RewardType", 8), ...indexedKeys("m_RewardID", 8), ...indexedKeys("m_RewardValue", 8), ...indexedKeys("m_FreeValue", 8), ...indexedKeys("m_PaidValue", 8)];

const PIECE_KEYS = ["m_PieceID", "m_PieceGetUnitID", "m_PieceReq", "m_PieceReq_First"];

const CONTRACT_KEYS = [
  "m_ContractID",
  "m_UnitPoolID",
  "m_RandomGradeID",
  "m_FreeTryCnt",
  "m_FreeTryEventCnt",
  "m_ContractBonusCountGroupID",
  "ContractBonusCountGroupID",
  "m_ContractBounsItemReqireCount",
  "m_addUnitStrId",
  "m_addUnitRatio",
  "m_addUnitPickUp",
  "m_addUnitRatioUp",
  "m_ContractType",
  "m_ContractCategory",
  "m_OpenTag",
  "m_ContractGetUnitClose",
  "m_EventDateStart",
  "m_EventDateEnd",
  "m_expireDbData",
  "m_ClassifiedBtnBool",
  "m_ShortCutType",
  "m_ShortCut",
  "m_TotalLimit",
  "m_DailyLimit",
  "m_NKM_UNIT_TYPE",
  "m_resetFreeCount",
  "m_freeCountDays",
  "CollectionMergeID",
  "m_PickUnitLevel",
  "m_PickUnitLimits",
  "m_isMaxSkillLevelUnits",
  "m_triggeredContractTimeLimit",
  "m_ExtensionCondition",
  ...indexedKeys("m_SingleTryRequireItemID", 4),
  ...indexedKeys("m_SingleTryRequireItemValue", 4),
  ...indexedKeys("m_MultiTryRequireItemID", 4),
  ...indexedKeys("m_MultiTryRequireItemValue", 4),
  ...indexedKeys("m_ContractResultRewardType", 4),
  ...indexedKeys("m_ContractResultRewardID", 4),
  ...indexedKeys("m_ContractResultRewardValue", 4),
];

const CONTRACT_TAB_KEYS = [
  "m_ContractID",
  "m_bEnabled",
  "m_OpenTag",
  "m_bPickUp",
  "m_Order",
  "m_ContractStrID",
  "m_ContractName",
  "m_ContractDesc",
  "m_MainBannerFileName",
  "m_DateStrID",
  "m_ContractCategory",
  "m_ContractBannerName",
  "m_ContractBannerDesc",
  "m_BannerDescInterval",
  "m_Image",
  "m_OpenCond",
  "m_OpenCondValue",
  "m_MissionCountIgnore",
  "m_CheckReturningUser",
  "m_ReturningUserType",
  "m_requiredContractClearId",
  "m_requiredStageClearId",
  "m_triggerStageClearId",
  "m_triggerShopProductId",
  "m_bVisible",
  "m_Priority",
  "listContentsTagAllow",
  "listContentsTagIgnore",
];
const CONTRACT_CATEGORY_KEYS = ["m_CategoryID", "IDX", "m_Name", "m_Type", "listContentsTagAllow", "listContentsTagIgnore"];
const SELECTABLE_CONTRACT_KEYS = [
  "m_ContractID",
  "m_UnitPoolChangeCount",
  "m_SelectableUnitPoolId",
  "m_RequireItemID",
  "m_RequireItemValue",
  "listContentsTagAllow",
  "listContentsTagIgnore",
];
const CONTRACT_POOL_KEYS = ["m_UnitPoolStrId", "m_UnitPoolId", "m_UnitID", "m_UnitId", "m_UnitStrId", "m_Ratio", "m_PickupTarget", "m_CustomPickupTarget"];
const RANDOM_GRADE_KEYS = ["m_RandomGradeID", "m_RandomGradeStrID", "Rate_SSR", "Rate_Pick_SSR", "Rate_SR", "Rate_Pick_SR", "Rate_R", "Rate_Pick_R", "Rate_N", "Rate_Pick_N"];
const MISC_CONTRACT_KEYS = ["m_ContractID", "m_UnitPoolID", "m_UnitCount", "m_RandomGradeID", ...CONTRACT_KEYS];

const EQUIP_KEYS = [
  "m_ItemEquipID",
  "m_ItemEquipPosition",
  "m_StatGroupID",
  "m_StatGroupID_2",
  "m_SetGroup",
  "m_PotentialOptionGroupID",
];
const EQUIP_RANDOM_STAT_KEYS = ["m_StatGroupID", "m_StatType", "m_MinStatValue", "m_MaxStatValue", "m_Ratio"];
const EQUIP_SET_OPTION_KEYS = ["m_EquipSetID"];
const SKIN_KEYS = ["m_SkinID", "m_UnitID"];
const EMOTICON_KEYS = ["m_EmoticonID"];
const LIMITBREAK_SUBSTITUTE_KEYS = ["m_TargetLimitbreakLevel", "m_NKM_UNIT_STYLE_TYPE", "m_NKM_UNIT_GRADE", "m_ItemID", "m_ItemCount"];
const CONTENTS_UNLOCK_KEYS = ["IDX", "eContentsType", "m_eContentsType", "m_UnlockReqType", "m_UnlockReqValue", "m_ContentsType", "m_ContentsValue"];

const MISSION_TAB_KEYS = ["m_TabID", "m_MissionTab", "m_MissionType", "m_OpenTag", "m_Visible", "listContentsTagAllow", "listContentsTagIgnore"];
const MISSION_KEYS = [
  "m_MissionID",
  "m_OpenTag",
  "m_DateStrID",
  "m_MissionCounterGroupID",
  "m_GroupId",
  "m_MissionTabId",
  "m_MissionTab",
  "m_MissionCond",
  "m_Times",
  "m_ResetInterval",
  "m_ForceClearStage",
  "m_Enabled",
  "m_MissionValue",
  "m_MissionValue1",
  "m_MissionValue2",
  "m_MissionRequire",
  ...indexedKeys("m_RewardType", 5),
  ...indexedKeys("m_RewardID", 5),
  ...indexedKeys("m_RewardValue", 5),
];

const EVENT_PASS_KEYS = [
  "EventPassID",
  "OpenTag",
  "m_OpenTag",
  "EventPassStartDate",
  "EventPassEndDate",
  "EventPassTitleStrID",
  "EventPassType",
  "EventPassMainRewardType",
  "EventPassMainReward",
  "CorePassStrID",
  "CorePassDescStrID",
  "CorePassPriceType",
  "CorePassPriceID",
  "CorePassPriceCount",
  "CorePassPlusStrID",
  "CorePassPlusDescStrID",
  "CorePassPlusPriceType",
  "CorePassPlusPriceID",
  "CorePassPlusPriceCount",
  "CorePassPlusExp",
  "PassMaxLevel",
  "PassLevelUpExp",
  "PassLevelUpMiscID",
  "PassLevelUpMiscCount",
  "PassRewardGroupID",
  "DailyMissionGroupID",
  "DailyMissionMaxSlot",
  "DailyMissionClearCount",
  "DailyMissionClearRewardExp",
  "WeeklyMissionGroupID",
  "WeeklyMissionMaxSlot",
  "WeeklyMissionClearCount",
  "WeeklyMissionClearRewardExp",
  "CorePassDiscountPercent",
  "m_DateStrID",
  "m_RemainEventPassID",
  "m_ShortCutType",
  "m_ShortCut",
  "listContentsTagAllow",
  "listContentsTagIgnore",
];

const EVENT_PASS_MISSION_GROUP_KEYS = [
  "MissionGroupID",
  "GroupEnum",
  "EventMissionWeek",
  "RandomGroupEnum",
  "MissionSlotIndex",
  "MissionID",
];

const EVENT_PASS_REWARD_KEYS = [
  "PassRewardGroupID",
  "PassLevel",
  "NormalRewardItemType",
  "NormalRewardItemID",
  "NormalRewardItemCount",
  "CoreRewardItemType",
  "CoreRewardItemID",
  "CoreRewardItemCount",
];

const ATTENDANCE_TAB_KEYS = [
  "IDX",
  "m_TabID",
  "m_RewardGroup",
  "m_MaxAttCount",
  "m_EventType",
  "m_DateStrID",
  "m_OpenTag",
  "m_LimitDayCount",
];
const ATTENDANCE_REWARD_KEYS = ["m_RewardGroup", "m_LoginDate", "m_RewardType", "m_RewardID", "m_RewardValue"];

const COLLECTION_UNIT_MISSION_KEYS = ["Unit_Grade", "MissionID", "StepID", "Mission_Condition", "Mission_Value", "m_RewardType", "m_RewardID", "m_RewardValue"];
const COLLECTION_TEAMUP_KEYS = ["m_TeamID", "m_UnitID", "m_RewardCriteria", "m_RewardType", "m_RewardID", "m_RewardValue"];
const COLLECTION_MISC_KEYS = ["ID", "CollectionItemID", "MiscType", "CollectionItemType", "CollectionRewardType", "CollectionRewardID", "CollectionRewardValue", "DefaultCollection"];

const EPISODE_KEYS = [
  "m_EpisodeID",
  "m_Difficulty",
  "m_EPCategory",
  "GroupID",
  "m_EpisodeStrID",
  "m_OpenTag",
  "m_CollectionOpenTag",
  "m_SortIndex",
  "m_CompleteRate_1",
  "m_CompleteRate_2",
  "m_CompleteRate_3",
  ...indexedKeys("m_RewardType", 3),
  ...indexedKeys("m_RewardID", 3),
  ...indexedKeys("m_RewardValue", 3),
];
const STAGE_KEYS = [
  "m_StageID",
  "m_StageStrID",
  "m_StageBattleStrID",
  "m_EpisodeID",
  "m_Difficulty",
  "m_OpenTag",
  "m_ActID",
  "m_StageIndex",
  "m_StageUINum",
  "m_StageType",
  "m_StageSubType",
  "m_UnlockReqType",
  "m_UnlockReqValue",
  "m_StageReqItemID",
  "m_StageReqItemCount",
];
const MAP_KEYS = ["m_MapID", "m_MapStrID"];
const DUNGEON_KEYS = [
  "m_DungeonID",
  "m_DungeonStrID",
  "m_DungeonMapStrID",
  "m_DungeonType",
  "m_RewardUserEXP",
  "m_RewardUnitEXP",
  "m_RewardCredit_Min",
  "m_RewardCredit_Max",
  ...indexedKeys("m_RewardGroupID", 5),
];

const TABLES = [
  {
    directory: "ab_script_item_templet",
    fileName: "LUA_ITEM_MISC_TEMPLET.json",
    keys: MISC_ITEM_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_RANDOM_ITEM_BOX.json",
    keys: REWARD_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_CUSTOM_PACKAGE_ITEM_BOX.json",
    keys: REWARD_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_ACQ_PACKAGE_TEMPLET.json",
    keys: ACQ_PACKAGE_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_REWARD_TEMPLET_CL.json",
    keys: REWARD_TEMPLET_KEYS,
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_TEMPLET_BASE.json",
    keys: UNIT_KEYS,
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_TEMPLET_BASE2.json",
    keys: UNIT_KEYS,
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_TEMPLET_BASE_SD.json",
    keys: UNIT_KEYS,
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_TEMPLET_BASE_OPR.json",
    keys: UNIT_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_COLLECTION_UNIT_TEMPLET.json",
    keys: ["Idx", ...UNIT_KEYS, "m_UnitIntro"],
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_SKILL_TEMPLET.json",
    keys: ["m_UnitSkillID", "m_Level", "m_UnitSkillStrID"],
  },
  {
    directory: "ab_script_item_templet",
    fileName: "LUA_PIECE_TEMPLET.json",
    keys: PIECE_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_CONTRACT.json",
    keys: CONTRACT_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SELECTABLE_CONTRACT.json",
    keys: SELECTABLE_CONTRACT_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_CONTRACT_TAB_TABLE.json",
    keys: CONTRACT_TAB_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_CONTRACT_CATEGORY.json",
    keys: CONTRACT_CATEGORY_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_CONTRACT_UNIT_POOL.json",
    keys: CONTRACT_POOL_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SELECTABLE_CONTRACT_UNIT_POOL.json",
    keys: CONTRACT_POOL_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_CONTRACT_CUSTOM_PICKUP.json",
    keys: [
      "customPickupId",
      "m_UnitPoolID",
      "maxSelectTargetCount",
      "m_MaxSelectTargetCount",
      "m_ContractBounsItemReqireCount",
      "m_ContractType",
      "ContractBonusCountGroupID",
      "m_ContractBonusCountGroupID",
      "m_RandomGradeID",
      "m_ContractCategory",
      "m_OpenTag",
      "m_addUnitStrId",
      "m_addUnitRatio",
      ...indexedKeys("m_SingleTryRequireItemID", 4),
      ...indexedKeys("m_SingleTryRequireItemValue", 4),
      ...indexedKeys("m_MultiTryRequireItemID", 4),
      ...indexedKeys("m_MultiTryRequireItemValue", 4),
      ...indexedKeys("m_ContractResultRewardType", 4),
      ...indexedKeys("m_ContractResultRewardID", 4),
      ...indexedKeys("m_ContractResultRewardValue", 4),
    ],
  },
  {
    directory: "ab_script",
    fileName: "LUA_RANDOM_GRADE_TABLE.json",
    keys: RANDOM_GRADE_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_MISC_CONTRACT.json",
    keys: MISC_CONTRACT_KEYS,
  },
  {
    directory: "ab_script_item_templet",
    fileName: "LUA_ITEM_EQUIP_TEMPLET.json",
    keys: EQUIP_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_ITEM_EQUIP_RANDOM_STAT.json",
    keys: EQUIP_RANDOM_STAT_KEYS,
  },
  {
    directory: "ab_script_item_templet",
    fileName: "LUA_ITEM_EQUIP_SET_OPTION.json",
    keys: EQUIP_SET_OPTION_KEYS,
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_EXP_TABLE.json",
    keys: ["m_iLevel", "m_iExpRequired", "m_iExpCumulated"],
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_OPERATOR_EXP_TEMPLET.json",
    keys: ["m_iLevel", "m_NKM_UNIT_GRADE", "m_iExpRequiredOpr", "m_iExpCumulatedOpr"],
  },
  {
    directory: "ab_script",
    fileName: "LUA_PLAYER_EXP_TABLE.json",
    keys: ["m_iLevel", "m_lExpRequired", "m_lExpCumulated", "m_RechargeEternium", "m_Eternium_MaxCap_Level"],
  },
  {
    directory: "ab_script",
    fileName: "LUA_LIMITBREAK_INFO.json",
    keys: ["m_iLBRank", "m_iMaxLevel"],
  },
  {
    directory: "ab_script",
    fileName: "LUA_SKIN_TEMPLET.json",
    keys: SKIN_KEYS,
  },
  {
    directory: "ab_script_item_templet",
    fileName: "LUA_ITEM_EMOTICON_TEMPLET.json",
    keys: EMOTICON_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_LIMITBREAK_SUBSTITUTE_ITEM.json",
    keys: LIMITBREAK_SUBSTITUTE_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_CONTENTS_UNLOCK_TEMPLET.json",
    transform: trimContentsUnlockRecord,
  },
  {
    directory: "ab_script",
    fileName: "LUA_MISSION_TAB_TEMPLET.json",
    keys: MISSION_TAB_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_MISSION_TEMPLET.json",
    keys: MISSION_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_EVENTDECK_TEMPLET.json",
    transform: trimEventDeckRecord,
  },
  {
    directory: "ab_script",
    fileName: "LUA_EVENT_PASS_TEMPLET.json",
    keys: EVENT_PASS_KEYS,
    transform: trimEventPassRecord,
  },
  {
    directory: "ab_script",
    fileName: "LUA_EVENT_PASS_MISSION_GROUP_TEMPLET.json",
    keys: EVENT_PASS_MISSION_GROUP_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_EVENT_PASS_REWARD_TEMPLET.json",
    keys: EVENT_PASS_REWARD_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_ATTENDANCE_TAB_TEMPLET.json",
    keys: ATTENDANCE_TAB_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_ATTENDANCE_REWARD_TEMPLET.json",
    keys: ATTENDANCE_REWARD_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_PVP_CONST.json",
    includeRoot: true,
    rootKeys: [
      "AsyncTicketChargeInterval",
      "AsyncTicketChargeCount",
      "AsyncTicketMaxCount",
      "ChargePointRefreshIntervalTicks",
      "ChargePointCount",
      "ChargePointMax",
      "ChargePointMaxCountForPractice",
    ],
  },
  {
    directory: "ab_script",
    fileName: "LUA_UNIT_MISSION_TEMPLET.json",
    keys: COLLECTION_UNIT_MISSION_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_COLLECTION_TEAMUP_TEMPLET.json",
    keys: COLLECTION_TEAMUP_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_COLLECTION_V2_MISC.json",
    keys: COLLECTION_MISC_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_EPISODE_TEMPLET_V2.json",
    keys: EPISODE_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_STAGE_TEMPLET.json",
    keys: STAGE_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_MAP_TEMPLET.json",
    keys: MAP_KEYS,
  },
  {
    directory: "ab_script_dungeon_templet",
    fileName: "LUA_DUNGEON_TEMPLET_BASE.json",
    keys: DUNGEON_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_TAB_TEMPLET_01.json",
    keys: SHOP_TAB_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_TAB_TEMPLET_02.json",
    keys: SHOP_TAB_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_CATEGORY_TEMPLET_01.json",
    keys: SHOP_CATEGORY_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_CATEGORY_TEMPLET_02.json",
    keys: SHOP_CATEGORY_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_TAB_CUSTOM_TEMPLET.json",
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_BANNER_TEMPLET.json",
    keys: SHOP_BANNER_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_FEATURED_TEMPLET.json",
    keys: SHOP_FEATURED_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_RECOMMEND_TEMPLET.json",
    keys: SHOP_RECOMMEND_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_TEMPLET_01.json",
    keys: SHOP_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_SHOP_TEMPLET_02.json",
    keys: SHOP_KEYS,
  },
];

function main() {
  SOURCE_ROOTS = resolveSourceRoots();
  if (!SOURCE_ROOTS.some((root) => fs.existsSync(root))) {
    throw new Error(`Missing source gameplay JSON root: ${SOURCE_ROOTS.join(" or ")}`);
  }

  const copied = copyCompleteTableTree();

  writeNewAccountDefaults();
  console.log(`[gameplay-jsons] copied ${copied} JSON tables to ${OUTPUT_BASE}`);
}

function copyCompleteTableTree() {
  let copied = 0;
  for (const rootName of ["Assetbundles", "StreamingAssets"]) {
    fs.rmSync(path.join(OUTPUT_BASE, rootName), { recursive: true, force: true });
  }
  for (const sourceRoot of SOURCE_ROOTS) {
    if (!fs.existsSync(sourceRoot)) continue;
    const rootName = path.basename(sourceRoot);
    const targetRoot = path.join(OUTPUT_BASE, rootName);
    for (const sourcePath of findJsonFiles(sourceRoot)) {
      const relativePath = path.relative(sourceRoot, sourcePath);
      const targetPath = path.join(targetRoot, relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
      copied += 1;
    }
  }
  return copied;
}

function resolveSourceRoots() {
  const explicitRoots = parsePathList(process.env.CS_GAMEPLAY_BUILD_SOURCE_ROOTS || process.env.CS_GAMEPLAY_TABLE_JSON_ROOTS || "");
  if (explicitRoots.length) return expandTableRoots(explicitRoots, ROOT_DIR);

  return [
    path.join(ROOT_DIR, "gameplay-tables-json", "Assetbundles"),
    path.join(ROOT_DIR, "gameplay-tables-json", "StreamingAssets"),
  ].filter((root) => fs.existsSync(root));
}

function findJsonFiles(root) {
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && /\.json$/i.test(entry.name)) {
        result.push(fullPath);
      }
    }
  }
  return result.sort();
}

function readTable(directory, fileName) {
  const filePath = sourcePath(directory, fileName);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeTable(directory, fileName, data) {
  const outputPath = path.join(OUTPUT_ROOT, directory, "luac", fileName);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function sourcePath(directory, fileName) {
  const candidates = SOURCE_ROOTS.map((root) => path.join(root, directory, "luac", fileName));
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function indexedKeys(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index + 1}`);
}

function transformRecord(record, table) {
  if (table.transform) return table.transform(record);
  if (Array.isArray(table.keys)) return pick(record, table.keys);
  return record && typeof record === "object" ? { ...record } : record;
}

function pick(record, keys) {
  const result = {};
  for (const key of keys) {
    if (record && record[key] !== undefined) result[key] = record[key];
  }
  return result;
}

function trimEventDeckRecord(record) {
  const result = pick(record, ["ID", "NAME", "SLOT_TYPE_SHIP", "SLOT_UNIT_ID_SHIP", "SLOT_UNIT_LEVEL_SHIP"]);
  for (let slot = 1; slot <= 16; slot += 1) {
    for (const key of [`SLOT_TYPE_UNIT_${slot}`, `SLOT_UNIT_ID_${slot}`, `SLOT_UNIT_LEVEL_${slot}`]) {
      if (record && record[key] !== undefined) result[key] = record[key];
    }
  }
  return result;
}

function trimEventPassRecord(record) {
  const result = pick(record, EVENT_PASS_KEYS);
  if (result.m_OpenTag === undefined && result.OpenTag !== undefined) result.m_OpenTag = result.OpenTag;
  return result;
}

function trimContentsUnlockRecord(record) {
  const result = pick(record, CONTENTS_UNLOCK_KEYS);
  const contentsType = String(result.eContentsType || result.m_eContentsType || result.m_ContentsType || "").trim();
  if (contentsType === "COUNTER_PASS") {
    result.m_UnlockReqType = "SURT_ALWAYS_UNLOCKED";
    result.m_UnlockReqValue = 0;
  }
  return result;
}

function writeNewAccountDefaults() {
  const outputPath = path.join(ROOT_DIR, "gameplay-jsons", "new-account-defaults.json");
  const data = {
    source: [
      "Assembly-CSharp/NKM/NKMUserData.cs",
      "Assembly-CSharp/NKM/NKMArmyData.cs",
      "Assembly-CSharp/NKM/NKMUserOption.cs",
      "Assembly-CSharp/ClientPacket/Common/NKMUserProfileData.cs",
      "Assembly-CSharp/ClientPacket/Common/NKMCommonProfile.cs",
    ],
    user: {
      level: 1,
      exp: "0",
      totalExp: "0",
      authLevel: 1,
    },
    army: {
      maxUnitCount: 200,
      maxShipCount: 10,
      maxOperatorCount: 10,
      maxTrophyCount: 2000,
    },
    profile: {
      friendIntro: "",
      mainUnitId: 0,
      mainUnitSkinId: 0,
      mainUnitTacticLevel: 0,
      frameId: 0,
      selfiFrameId: 0,
      titleId: 0,
      emblems: [],
      hasOffice: false,
      privatePvpInvitation: 0,
    },
    roster: {
      units: [],
      ships: [],
      operators: [],
    },
    userOption: {
      autoRespawn: false,
      actionCameraType: 1,
      trackCamera: true,
      viewSkillCutIn: true,
      autoWarfare: false,
      autoWarfareRepair: true,
      playCutscene: false,
      autoDive: false,
      speedType: 0,
      autoSkillType: 1,
      autoSyncFriendDeck: true,
      defaultPvpAutoRespawn: 0,
      privatePvpInvitation: 0,
    },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

main();
