using System.Text.Json;

namespace RevivalSide.CombatHost;

public sealed class HostRequest
{
    public string Command { get; set; } = "";
    public HostOptions? Options { get; set; }
    public JsonElement Data { get; set; }
}

public sealed class HostOptions
{
    public string ManagedDir { get; set; } = "";
    public string GameplayTablesDir { get; set; } = "";
    public double SyncIntervalSeconds { get; set; } = 0.25;
    public int DefaultUnitDamage { get; set; } = 10;
    public int DefaultUnitAttackRange { get; set; } = 130;
    public int DefaultUnitMoveSpeed { get; set; } = 55;
    public double DefaultUnitAttackCooldown { get; set; } = 1.2;
    public int StaticUnitDamage { get; set; } = 8;
    public int StaticUnitAttackRange { get; set; } = 180;
    public double StaticUnitAttackCooldown { get; set; } = 1.6;
    public int DefaultDeployedUnitHp { get; set; } = 1989;
}

public sealed class HostResponse
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string? Summary { get; set; }
    public string? PacketType { get; set; }
    public int? SerializedPayloadSize { get; set; }
    public DynamicGameState? DynamicGame { get; set; }
    public BattleState? BattleState { get; set; }
    public BattleSimState? BattleSim { get; set; }
    public string? PayloadBase64 { get; set; }
    public List<HostPacket>? Packets { get; set; }
    public HostDeployResult? Deployed { get; set; }
    public HostResult? Result { get; set; }
    public List<IntervalExportRow>? Intervals { get; set; }
    public OfficialProfileSnapshot? OfficialProfile { get; set; }
    public string? TableJson { get; set; }
}

public sealed class HostPacket
{
    public int PacketId { get; set; }
    public string Label { get; set; } = "";
    public string PayloadBase64 { get; set; } = "";
    public bool? BattleWin { get; set; }
    public int? BattleWinTeam { get; set; }
    public double? BattlePlayTime { get; set; }
    public int? FiercePoint { get; set; }
    public int? FiercePenaltyPoint { get; set; }
    public List<BattleUnitRecord>? BattleRecords { get; set; }
}

public sealed class HostDeployResult
{
    public bool Handled { get; set; }
    public string Mode { get; set; } = "";
    public UnitState? Unit { get; set; }
    public List<UnitState>? Spawned { get; set; }
}

public sealed class HostResult
{
    public bool Finished { get; set; }
    public bool Win { get; set; }
    public double GameTime { get; set; }
}

public sealed class PacketValidationData
{
    public int PacketId { get; set; }
    public string PayloadBase64 { get; set; } = "";
}

public sealed class IntervalExportRow
{
    public int Key { get; set; }
    public string StrKey { get; set; } = "";
    public string StartDate { get; set; } = "";
    public string EndDate { get; set; } = "";
    public int RepeatStartDate { get; set; }
    public int RepeatEndDate { get; set; }
}

public sealed class JoinLobbyMergeData
{
    public string OfficialPayloadBase64 { get; set; } = "";
    public string LocalPayloadBase64 { get; set; } = "";
    public bool CopyIntervalData { get; set; }
    public bool ReplaceIntervalData { get; set; }
    public List<string> ExcludeIntervalStrKeys { get; set; } = new();
    public List<string> PreserveIntervalStrKeys { get; set; } = new();
    public List<string> MergeIntervalStrKeys { get; set; } = new();
    public bool FilterInactiveEventIntervals { get; set; }
    public bool PreserveOfficialContractData { get; set; }
    public bool OverlayLocalContractData { get; set; }
}

public sealed class JoinLobbyNormalizeData
{
    public string LocalPayloadBase64 { get; set; } = "";
}

public sealed class GameplayTableExportData
{
    public string Directory { get; set; } = "";
    public string FileName { get; set; } = "";
    public string RootName { get; set; } = "";
}

public sealed class OfficialProfileSnapshot
{
    public string UserUid { get; set; } = "";
    public string FriendCode { get; set; } = "";
    public string Nickname { get; set; } = "";
    public int Level { get; set; } = 1;
    public string Exp { get; set; } = "0";
    public int AuthLevel { get; set; } = 1;
    public string FriendIntro { get; set; } = "";
    public int MainUnitId { get; set; }
    public int MainUnitSkinId { get; set; }
    public int MainUnitTacticLevel { get; set; }
    public int FrameId { get; set; }
    public int SelfiFrameId { get; set; }
    public int TitleId { get; set; }
    public List<int> UnlockedStageIds { get; set; } = new();
    public List<OfficialProfileEmblem> ProfileEmblems { get; set; } = new();
    public OfficialInventorySnapshot Inventory { get; set; } = new();
    public OfficialArmySnapshot Army { get; set; } = new();
    public Dictionary<string, OfficialStagePlaySnapshot> StagePlayData { get; set; } = new();
    public Dictionary<string, OfficialDungeonClearSnapshot> DungeonClear { get; set; } = new();
    public Dictionary<string, object?> OfficialSnapshot { get; set; } = new();
    public Dictionary<string, object> OfficialImport { get; set; } = new();
}

public sealed class OfficialInventorySnapshot
{
    public Dictionary<string, OfficialMiscItemSnapshot> Misc { get; set; } = new();
    public Dictionary<string, OfficialEquipItemSnapshot> Equips { get; set; } = new();
    public List<int> Skins { get; set; } = new();
}

public sealed class OfficialArmySnapshot
{
    public Dictionary<string, OfficialUnitSnapshot> Units { get; set; } = new();
    public Dictionary<string, OfficialUnitSnapshot> Ships { get; set; } = new();
    public Dictionary<string, OfficialUnitSnapshot> Trophies { get; set; } = new();
    public Dictionary<string, OfficialOperatorSnapshot> Operators { get; set; } = new();
    public Dictionary<string, List<OfficialDeckSnapshot>> DeckSets { get; set; } = new();
}

public sealed class OfficialMiscItemSnapshot
{
    public int ItemId { get; set; }
    public string CountFree { get; set; } = "0";
    public string CountPaid { get; set; } = "0";
    public int BonusRatio { get; set; }
    public string RegDate { get; set; } = "0";
}

public sealed class OfficialEquipItemSnapshot
{
    public string EquipUid { get; set; } = "0";
    public int ItemEquipId { get; set; }
    public int EnchantLevel { get; set; }
    public int EnchantExp { get; set; }
    public List<OfficialEquipStatSnapshot> Stats { get; set; } = new();
    public string OwnerUnitUid { get; set; } = "-1";
    public bool Locked { get; set; }
    public int Precision { get; set; }
    public int Precision2 { get; set; }
    public int SetOptionId { get; set; }
    public int ImprintUnitId { get; set; }
    public List<OfficialPotentialOptionSnapshot> PotentialOptions { get; set; } = new();
}

public sealed class OfficialEquipStatSnapshot
{
    public string Type { get; set; } = "NST_RANDOM";
    public float Value { get; set; }
    public float LevelValue { get; set; }
}

public sealed class OfficialPotentialOptionSnapshot
{
    public int OptionKey { get; set; }
    public string StatType { get; set; } = "NST_RANDOM";
    public List<OfficialPotentialSocketSnapshot?> Sockets { get; set; } = new();
    public int PrecisionChangeCount { get; set; }
}

public sealed class OfficialPotentialSocketSnapshot
{
    public float StatValue { get; set; }
    public int Precision { get; set; }
}

public sealed class OfficialUnitSnapshot
{
    public string UnitUid { get; set; } = "0";
    public string UserUid { get; set; } = "0";
    public int UnitId { get; set; }
    public int Level { get; set; } = 1;
    public int Exp { get; set; }
    public int SkinId { get; set; }
    public float Injury { get; set; }
    public int LimitBreakLevel { get; set; }
    public bool Locked { get; set; }
    public bool SummonUnit { get; set; }
    public List<int> StatExp { get; set; } = new();
    public List<int> SkillLevels { get; set; } = new();
    public List<string> EquipItemUids { get; set; } = new();
    public int Loyalty { get; set; }
    public bool IsPermanentContract { get; set; }
    public bool IsSeized { get; set; }
    public bool FromContract { get; set; }
    public int OfficeRoomId { get; set; }
    public string RegDate { get; set; } = "0";
    public int OfficeGrade { get; set; }
    public string OfficeGaugeStartTime { get; set; } = "0";
    public string DungeonRespawnUnitTempletUid { get; set; } = "0";
    public bool IsFavorite { get; set; }
    public List<OfficialShipCommandModuleSnapshot> ShipCommandModules { get; set; } = new();
    public int TacticLevel { get; set; }
    public int ReactorLevel { get; set; }
}

public sealed class OfficialShipCommandModuleSnapshot
{
    public List<OfficialShipCommandSlotSnapshot> Slots { get; set; } = new();
}

public sealed class OfficialShipCommandSlotSnapshot
{
    public List<int> TargetStyleType { get; set; } = new();
    public List<int> TargetRoleType { get; set; } = new();
    public string StatType { get; set; } = "NST_RANDOM";
    public float StatValue { get; set; }
    public bool IsLock { get; set; }
}

public sealed class OfficialOperatorSnapshot
{
    public string Uid { get; set; } = "0";
    public int Id { get; set; }
    public int Level { get; set; } = 1;
    public int Exp { get; set; }
    public bool Locked { get; set; }
    public OfficialOperatorSkillSnapshot MainSkill { get; set; } = new();
    public OfficialOperatorSkillSnapshot SubSkill { get; set; } = new();
    public bool FromContract { get; set; }
}

public sealed class OfficialOperatorSkillSnapshot
{
    public int Id { get; set; }
    public int Level { get; set; } = 1;
    public int Exp { get; set; }
}

public sealed class OfficialDeckSnapshot
{
    public int DeckType { get; set; }
    public string Name { get; set; } = "";
    public string ShipUid { get; set; } = "0";
    public string OperatorUid { get; set; } = "0";
    public List<string> UnitUids { get; set; } = new();
    public int LeaderIndex { get; set; } = -1;
    public int State { get; set; }
}

public sealed class OfficialProfileEmblem
{
    public int Id { get; set; }
    public string Count { get; set; } = "0";
}

public sealed class OfficialStagePlaySnapshot
{
    public int StageId { get; set; }
    public string PlayCount { get; set; } = "0";
    public string RestoreCount { get; set; } = "0";
    public string BestKillCount { get; set; } = "0";
    public string NextResetDate { get; set; } = "0";
    public int BestClearTimeSec { get; set; }
    public string TotalPlayCount { get; set; } = "0";
}

public sealed class OfficialDungeonClearSnapshot
{
    public int DungeonId { get; set; }
    public bool MissionResult1 { get; set; }
    public bool MissionResult2 { get; set; }
    public bool MissionRewardResult { get; set; }
    public List<bool> OnetimeRewardResults { get; set; } = new();
    public int UnitExp { get; set; }
}
