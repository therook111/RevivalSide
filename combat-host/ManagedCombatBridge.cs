using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;

namespace RevivalSide.CombatHost;

// Reflection bridge into the installed CounterSide Managed assemblies.
//
// The Node listener still owns sockets and packet order. This bridge owns the
// real in-process NKCGameServerLocal instance when the installed client DLLs are
// available, and drains the packets that the local server enqueues for the
// Unity client path.
internal static class ManagedCombatBridge
{
    private const int GameLoadAck = 804;
    private const int GameLoadCompleteAck = 808;
    private const int GameEnd = 811;
    private const int GamePauseAck = 813;
    private const int GameRespawnAck = 817;
    private const int GameShipSkillAck = 819;
    private const int GameSync = 822;
    private const int GameUseUnitSkillAck = 830;
    private const int JoinLobbyAck = 205;
    private const float ManagedFrameDelta = 0.033333335f;
    private const int ManagedMaxCatchUpFrames = 3;
    private const int ManagedActionPrimeFrames = 1;
    private const int QuietGameSyncPayloadBytes = 64;

    private static readonly Dictionary<string, ManagedCombatSession> Sessions = new();
    private static readonly string[] LocalJoinLobbyFields =
    [
        "errorCode",
        "friendCode",
        "lobbyData",
        "gameData",
        "warfareGameData",
        "utcTime",
        "utcOffset",
        "lastCreditSupplyTakeTime",
        "lastEterniumSupplyTakeTime",
        "pvpPointChargeTime",
        "contractState",
        "contractBonusState",
        "selectableContractState",
        "stagePlayDataList",
        "reconnectKey",
        "backGroundInfo",
        "unlockedStageIds",
        "phaseClearDataList",
        "phaseModeState",
        "completedUnitMissions",
        "rewardEnableUnitMissions",
        "userProfileData",
        "lastPlayInfo",
        "customPickupContracts"
    ];
    private static readonly string[] LocalJoinLobbyUserDataFields =
    [
        "m_UserUID",
        "m_FriendCode",
        "m_UserNickName",
        "m_UserLevel",
        "m_lUserLevelEXP",
        "m_eAuthLevel",
        "m_NKMUserDateData",
        "m_InventoryData",
        "m_ArmyData",
        "m_UserOption",
        "m_dicNKMDungeonClearData",
        "m_dicNKMWarfareClearData",
        "m_MissionData",
        "m_ShopData",
        "m_dicNKMCounterCaseData",
        "m_dicEpisodeCompleteData",
        "m_companyBuffDataList",
        "backGroundInfo",
        "m_JukeboxData"
    ];

    private static void CopyField(ManagedRuntime runtime, object source, object target, string fieldName)
    {
        runtime.SetField(target, fieldName, runtime.GetField(source, fieldName));
    }

    private static void MergeJoinLobbyUserData(ManagedRuntime runtime, object localPacket, object officialPacket)
    {
        var localUserData = runtime.GetField(localPacket, "userData");
        if (localUserData == null) return;

        var officialUserData = runtime.GetField(officialPacket, "userData");
        if (officialUserData == null)
        {
            runtime.SetField(officialPacket, "userData", localUserData);
            return;
        }

        foreach (var fieldName in LocalJoinLobbyUserDataFields)
        {
            CopyField(runtime, localUserData, officialUserData, fieldName);
        }
    }

    private static void MergeIntervalData(ManagedRuntime runtime, object localPacket, object officialPacket)
    {
        var localIntervalData = runtime.GetField(localPacket, "intervalData");
        if (localIntervalData == null) return;

        var officialIntervalData = runtime.GetField(officialPacket, "intervalData");
        if (officialIntervalData == null)
        {
            runtime.SetField(officialPacket, "intervalData", localIntervalData);
            return;
        }

        if (officialIntervalData is not IList officialList || localIntervalData is not IEnumerable localEnumerable)
        {
            runtime.SetField(officialPacket, "intervalData", localIntervalData);
            return;
        }

        var indexByStrKey = new Dictionary<string, int>(StringComparer.Ordinal);
        var usedKeys = new HashSet<int>();
        for (var index = 0; index < officialList.Count; index += 1)
        {
            var item = officialList[index];
            var strKey = Convert.ToString(item == null ? null : runtime.GetField(item, "strKey"), CultureInfo.InvariantCulture);
            if (!string.IsNullOrWhiteSpace(strKey) && !indexByStrKey.ContainsKey(strKey))
            {
                indexByStrKey[strKey] = index;
            }

            if (TryGetIntField(runtime, item, "key", out var officialKey))
            {
                usedKeys.Add(officialKey);
            }
        }

        var nextSyntheticKey = 2_000_000_000;
        foreach (var localItem in localEnumerable)
        {
            var strKey = Convert.ToString(runtime.GetField(localItem, "strKey"), CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(strKey)) continue;
            if (indexByStrKey.TryGetValue(strKey, out var existingIndex))
            {
                if (!IsFallbackIntervalTiming(runtime, localItem))
                {
                    CopyIntervalTiming(runtime, localItem, officialList[existingIndex]);
                }
                continue;
            }

            if (!TryGetIntField(runtime, localItem, "key", out var localKey) || usedKeys.Contains(localKey))
            {
                while (usedKeys.Contains(nextSyntheticKey)) nextSyntheticKey -= 1;
                localKey = nextSyntheticKey;
                runtime.SetField(localItem, "key", localKey);
                nextSyntheticKey -= 1;
            }

            usedKeys.Add(localKey);
            indexByStrKey[strKey] = officialList.Count;
            officialList.Add(localItem);
        }
    }

    private static void DeactivateIntervalsByStrKey(
        ManagedRuntime runtime,
        object packet,
        IEnumerable<string>? strKeys,
        IEnumerable<string>? preserveStrKeys,
        bool filterInactiveEventIntervals)
    {
        var removeKeys = new HashSet<string>(
            (strKeys ?? Array.Empty<string>())
                .Where(key => !string.IsNullOrWhiteSpace(key))
                .Select(key => key.Trim()),
            StringComparer.OrdinalIgnoreCase);
        var preserveKeys = new HashSet<string>(
            (preserveStrKeys ?? Array.Empty<string>())
                .Where(key => !string.IsNullOrWhiteSpace(key))
                .Select(key => key.Trim()),
            StringComparer.OrdinalIgnoreCase);
        if (removeKeys.Count == 0 && !filterInactiveEventIntervals) return;

        var intervalData = runtime.GetField(packet, "intervalData");
        if (intervalData is not IList list) return;

        for (var index = list.Count - 1; index >= 0; index -= 1)
        {
            var item = list[index];
            var strKey = Convert.ToString(item == null ? null : runtime.GetField(item, "strKey"), CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(strKey) || preserveKeys.Contains(strKey)) continue;
            if (removeKeys.Contains(strKey) || (filterInactiveEventIntervals && IsEventManagedIntervalKey(strKey)))
            {
                DeactivateIntervalTiming(runtime, item);
            }
        }
    }

    private static void DeactivateIntervalTiming(ManagedRuntime runtime, object? target)
    {
        if (target == null) return;
        runtime.SetField(target, "startDate", new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        runtime.SetField(target, "endDate", new DateTime(2000, 1, 2, 0, 0, 0, DateTimeKind.Utc));
        runtime.SetField(target, "repeatStartDate", 0);
        runtime.SetField(target, "repeatEndDate", 0);
    }

    private static bool IsEventManagedIntervalKey(string strKey)
    {
        var key = strKey.Trim();
        return key.StartsWith("DATE_COMMON_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_COMMON_EPISODE_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_COMMON_MISSION_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_COMMON_SHOP_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLBOAL_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_FIRST_CONTRACT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_CUSTOM_PICKUP_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_PICUP_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_PICKUP_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("SHOP_CASH_PACKAGE_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("SHOP_TAB_PACKAGE_", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("_EVENT_PASS_", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsFallbackIntervalTiming(ManagedRuntime runtime, object? target)
    {
        if (!TryGetDateTimeField(runtime, target, "startDate", out var startDate)) return false;
        if (!TryGetDateTimeField(runtime, target, "endDate", out var endDate)) return false;
        return IsUtcMidnightDate(startDate, 2000, 1, 1) && IsUtcMidnightDate(endDate, 2000, 1, 2);
    }

    private static bool TryGetDateTimeField(ManagedRuntime runtime, object? target, string fieldName, out DateTime value)
    {
        value = default;
        if (target == null) return false;
        var rawValue = runtime.GetField(target, fieldName);
        if (rawValue == null) return false;
        if (rawValue is DateTime dateTime)
        {
            value = dateTime;
            return true;
        }

        try
        {
            value = Convert.ToDateTime(rawValue, CultureInfo.InvariantCulture);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsUtcMidnightDate(DateTime value, int year, int month, int day)
    {
        return value.Year == year &&
            value.Month == month &&
            value.Day == day &&
            value.Hour == 0 &&
            value.Minute == 0 &&
            value.Second == 0;
    }

    private static bool TryGetIntField(ManagedRuntime runtime, object? target, string fieldName, out int value)
    {
        value = 0;
        if (target == null) return false;
        var rawValue = runtime.GetField(target, fieldName);
        if (rawValue == null) return false;
        try
        {
            value = Convert.ToInt32(rawValue, CultureInfo.InvariantCulture);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void CopyIntervalTiming(ManagedRuntime runtime, object source, object? target)
    {
        if (target == null) return;
        CopyField(runtime, source, target, "startDate");
        CopyField(runtime, source, target, "endDate");
        CopyField(runtime, source, target, "repeatStartDate");
        CopyField(runtime, source, target, "repeatEndDate");
    }

    private static void EnsureUniqueIntervalKeys(ManagedRuntime runtime, object packet)
    {
        var intervalData = runtime.GetField(packet, "intervalData");
        if (intervalData is not IEnumerable enumerable) return;

        var usedKeys = new HashSet<int>();
        var nextSyntheticKey = 2_000_000_000;
        foreach (var item in enumerable)
        {
            if (!TryGetIntField(runtime, item, "key", out var key) || key == 0 || usedKeys.Contains(key))
            {
                while (usedKeys.Contains(nextSyntheticKey)) nextSyntheticKey -= 1;
                key = nextSyntheticKey;
                runtime.SetField(item, "key", key);
                nextSyntheticKey -= 1;
            }

            usedKeys.Add(key);
        }
    }

    public static bool TryWarmup(HostOptions options, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables();
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            return false;
        }
    }

    public static bool TryValidatePacket(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId, payload);
            var serialized = runtime.SerializePacket(packet, data.PacketId, "validate");
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = Convert.FromBase64String(serialized.PayloadBase64).Length
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryInspectGameLoadAck(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables();
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? GameLoadAck : data.PacketId, payload);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = runtime.DescribeGameLoadAck(packet)
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryInspectGameSync(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables();
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? GameSync : data.PacketId, payload);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = runtime.DescribeGameSync(packet)
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryInspectGameLoadCompleteAck(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables();
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? GameLoadCompleteAck : data.PacketId, payload);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = runtime.DescribeGameLoadCompleteAck(packet)
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryInspectJoinLobbyAck(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? JoinLobbyAck : data.PacketId, payload);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = runtime.DescribeJoinLobbyAck(packet)
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryMergeJoinLobbyAck(
        HostOptions options,
        JoinLobbyMergeData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var official = runtime.DeserializePacket(JoinLobbyAck, Convert.FromBase64String(data.OfficialPayloadBase64 ?? ""));
            var local = runtime.DeserializePacket(JoinLobbyAck, Convert.FromBase64String(data.LocalPayloadBase64 ?? ""));

            foreach (var fieldName in LocalJoinLobbyFields)
            {
                CopyField(runtime, local, official, fieldName);
            }
            if (data.ReplaceIntervalData)
            {
                CopyField(runtime, local, official, "intervalData");
            }
            else if (data.CopyIntervalData)
            {
                DeactivateIntervalsByStrKey(
                    runtime,
                    official,
                    data.ExcludeIntervalStrKeys,
                    data.PreserveIntervalStrKeys,
                    data.FilterInactiveEventIntervals);
                MergeIntervalData(runtime, local, official);
            }
            EnsureUniqueIntervalKeys(runtime, official);
            MergeJoinLobbyUserData(runtime, local, official);

            var serialized = runtime.SerializePacket(official, JoinLobbyAck, "merged-join-lobby");
            response = new HostResponse
            {
                Ok = true,
                PacketType = official.GetType().FullName,
                PayloadBase64 = serialized.PayloadBase64,
                SerializedPayloadSize = Convert.FromBase64String(serialized.PayloadBase64).Length
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryNormalizeJoinLobbyAck(
        HostOptions options,
        JoinLobbyNormalizeData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var local = runtime.DeserializePacket(JoinLobbyAck, Convert.FromBase64String(data.LocalPayloadBase64 ?? ""));
            var normalized = runtime.Create("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK");
            runtime.SetField(normalized, "userData", runtime.Create("NKM.NKMUserData"));

            foreach (var fieldName in LocalJoinLobbyFields)
            {
                CopyField(runtime, local, normalized, fieldName);
            }
            CopyField(runtime, local, normalized, "intervalData");
            EnsureUniqueIntervalKeys(runtime, normalized);
            MergeJoinLobbyUserData(runtime, local, normalized);

            var serialized = runtime.SerializePacket(normalized, JoinLobbyAck, "normalized-join-lobby");
            response = new HostResponse
            {
                Ok = true,
                PacketType = normalized.GetType().FullName,
                PayloadBase64 = serialized.PayloadBase64,
                SerializedPayloadSize = Convert.FromBase64String(serialized.PayloadBase64).Length
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryStart(
        HostOptions options,
        StartBattleData data,
        DynamicGameState dynamicGame,
        out HostPacket? gameLoadAck,
        out string? error)
    {
        gameLoadAck = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables();
            object? gameData = null;
            if (!string.IsNullOrWhiteSpace(data.GameLoadAckPayloadBase64))
            {
                var gameLoadAckTemplate = runtime.DeserializePacket(GameLoadAck, Convert.FromBase64String(data.GameLoadAckPayloadBase64));
                gameData = runtime.GetField(gameLoadAckTemplate, "gameData");
            }
            else
            {
                gameData = runtime.BuildGameData(data, dynamicGame);
            }
            if (gameData == null)
            {
                error = "managed GAME_LOAD_ACK contained null gameData";
                return false;
            }

            var server = runtime.Create("NKC.NKCGameServerLocal");
            runtime.Invoke(server, "EndGame");
            runtime.Invoke(server, "Init");
            runtime.SetField(gameData, "m_GameUID", dynamicGame.GameUID);
            if (dynamicGame.DungeonID > 0)
            {
                runtime.SetField(gameData, "m_DungeonID", dynamicGame.DungeonID);
            }
            if (dynamicGame.MapID > 0)
            {
                runtime.SetField(gameData, "m_MapID", dynamicGame.MapID);
            }
            runtime.ApplyTutorialGameType(gameData, dynamicGame.DungeonID);
            var eventDeckId = data.Stage?.EventDeckId ?? dynamicGame.DungeonID;
            var usesEventDeck = ShouldApplyEventDeck(dynamicGame.StageID, dynamicGame.DungeonID, eventDeckId);
            var usesTutorialEventDeck = ShouldApplyTutorialEventDeckTeamA(dynamicGame.StageID, dynamicGame.DungeonID, eventDeckId);
            if (usesEventDeck)
            {
                runtime.ApplyEventDeckTeamA(gameData, eventDeckId);
                runtime.ApplyPlayerDeckFreeSlotsTeamA(
                    gameData,
                    data.Stage?.PlayerDeck,
                    data.Stage?.EventDeckFreeUnitSlots,
                    data.Stage?.EventDeckFreeShipSlot == true,
                    eventDeckId);
            }
            else if (usesTutorialEventDeck)
            {
                runtime.ApplyTutorialEventDeckTeamA(gameData, eventDeckId);
            }
            runtime.PrepareGameDataForLocalServer(gameData);
            runtime.ApplyTutorialGameType(gameData, dynamicGame.DungeonID);
            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            if (!runtime.TryApplyDungeonGameTeamData(gameData, runtimeData, out error))
            {
                return false;
            }
            runtime.ApplyPlayerIdentityRuntimeData(runtimeData, data.Stage?.PlayerDeck);
            runtime.PrepareGameDataForLocalServer(gameData);
            if (!usesEventDeck && !usesTutorialEventDeck)
            {
                runtime.ApplyPlayerDeckTeamA(gameData, data.Stage?.PlayerDeck, dynamicGame.StageID, dynamicGame.DungeonID);
            }
            runtime.RefreshTutorialTeamADeck(gameData, dynamicGame.StageID, dynamicGame.DungeonID);
            runtime.ApplyPlayerIdentityTeamA(gameData, data.Stage?.PlayerDeck);
            runtime.ApplyTutorialGameType(gameData, dynamicGame.DungeonID);
            runtime.Invoke(server, "SetGameData", gameData);
            if (runtimeData != null)
            {
                runtime.ApplyPlayerIdentityRuntimeData(runtimeData, data.Stage?.PlayerDeck);
                runtime.Invoke(server, "SetGameRuntimeData", runtimeData);
            }
            runtime.SuppressPlayerDynamicRespawns(server, gameData);
            runtime.ApplyPlayerIdentityTeamA(gameData, data.Stage?.PlayerDeck);
            runtime.ClearTeamAUnitOwnersForGameLoadAck(gameData, data.Stage?.PlayerDeck);
            runtime.ApplyTutorialGameType(gameData, dynamicGame.DungeonID);
            // The Unity client builds its unit pool from GAME_LOAD_ACK. Send the
            // same gameData that NKCGameServerLocal just mutated so runtime
            // gameUnitUIDs resolve to the same unit/team on both sides.
            gameLoadAck = runtime.BuildGameLoadAck(gameData);
            var setupPackets = runtime.DrainClientPackets($"managed-setup-{dynamicGame.GameUID}");

            var sessionId = dynamicGame.GameUID.ToString(CultureInfo.InvariantCulture);
            Sessions[sessionId] = new ManagedCombatSession(sessionId, runtime, server, setupPackets);
            dynamicGame.ManagedSessionId = sessionId;
            dynamicGame.ManagedCombat = true;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            return false;
        }
    }

    private static bool ShouldApplyEventDeck(int stageId, int dungeonId, int eventDeckId)
    {
        if (eventDeckId <= 0) return false;
        // Tutorial loads are now built from local tables in BuildGameData.
        // Keep normal event-deck rebuilding out of tutorial so the specialized
        // tutorial hydrator can own Team A consistently.
        return !IsTutorialStage(stageId) && !IsTutorialDungeon(dungeonId);
    }

    private static bool ShouldApplyTutorialEventDeckTeamA(int stageId, int dungeonId, int eventDeckId)
    {
        if (eventDeckId < 1004 || eventDeckId > 1007) return false;
        return IsTutorialStage(stageId) || IsTutorialDungeon(dungeonId);
    }

    private static bool IsTutorialStage(int stageId)
    {
        return stageId is 11211 or 11212 or 11213 or 11214;
    }

    private static bool IsTutorialDungeon(int dungeonId)
    {
        return dungeonId is 1004 or 1005 or 1006 or 1007;
    }

    public static bool TryBuildInitialSync(
        DynamicGameState? dynamicGame,
        BattleState? battleState,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(dynamicGame, out var session, out error))
        {
            return false;
        }

        try
        {
            var packets = new List<HostPacket>();
            session.ApplyRuntimeControls(dynamicGame);
            if (!session.Started)
            {
                packets.Add(session.BuildLoadCompleteAck());
                session.Start();
                packets.AddRange(session.DrainQueuedPackets("managed-game-start"));
                packets.AddRange(session.DrainSetupPackets());
            }

            // Tutorial phases carry dungeon events and UI triggers in the sync
            // stream. Drain only one local-server frame here so phase 2+ scripts
            // see the same steady cadence they get during the battle loop.
            packets.AddRange(session.UpdateAndDrain(ManagedFrameDelta, 1));
            var sync = LastPayload(packets, GameSync);
            response = new HostResponse
            {
                Ok = true,
                BattleState = battleState,
                Packets = packets,
                PayloadBase64 = sync
            };
            return sync != null || packets.Count > 0;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryHandleDeploy(
        DeployCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        if (data.Req == null)
        {
            error = "deploy request required";
            return false;
        }

        try
        {
            session.ApplyRuntimeControls(data.DynamicGame);
            session.EnsureStarted();
            var packets = session.HandleDeploy(data.Req);
            response = new HostResponse
            {
                Ok = true,
                DynamicGame = data.DynamicGame,
                BattleState = data.BattleState,
                Packets = packets,
                Deployed = new HostDeployResult
                {
                    Handled = true,
                    Mode = "managed-local-server"
                }
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryHandlePause(
        PauseCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        if (data.Req == null)
        {
            error = "pause request required";
            return false;
        }

        try
        {
            session.EnsureStarted();
            var packets = session.HandlePause(data.Req);
            response = new HostResponse
            {
                Ok = true,
                DynamicGame = data.DynamicGame,
                BattleState = data.BattleState,
                Packets = packets
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryHandleUnitSkill(
        UnitSkillCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        if (data.Req == null)
        {
            error = "unit skill request required";
            return false;
        }

        try
        {
            session.EnsureStarted();
            var packets = session.HandleUnitSkill(data.Req);
            response = new HostResponse
            {
                Ok = true,
                DynamicGame = data.DynamicGame,
                BattleState = data.BattleState,
                Packets = packets
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryHandleShipSkill(
        ShipSkillCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        if (data.Req == null)
        {
            error = "ship skill request required";
            return false;
        }

        try
        {
            session.EnsureStarted();
            var packets = session.HandleShipSkill(data.Req);
            response = new HostResponse
            {
                Ok = true,
                DynamicGame = data.DynamicGame,
                BattleState = data.BattleState,
                Packets = packets
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryBuildSync(
        SyncCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        try
        {
            session.ApplyRuntimeControls(data.DynamicGame);
            session.EnsureStarted();
            // Keep managed sync frame-based, but do not let reflection/packet
            // serialization stalls make the server simulation run slower than
            // the client. If the listener falls behind, catch up with a small
            // number of normal 33 ms frames and drain after each frame so
            // tutorial events and damage packets stay in their original order.
            var requestedDelta = (float)Math.Max(data.Delta ?? ManagedFrameDelta, 0.001);
            var frames = Math.Clamp((int)Math.Ceiling(requestedDelta / ManagedFrameDelta), 1, ManagedMaxCatchUpFrames);
            var delta = Math.Min(requestedDelta, ManagedFrameDelta * frames);
            var packets = session.UpdateAndDrain(delta, frames);
            var sync = LastPayload(packets, GameSync);

            response = new HostResponse
            {
                Ok = true,
                BattleState = data.BattleState,
                Packets = packets,
                PayloadBase64 = sync
            };
            // NKCGameServerLocal does not emit a GAME_SYNC every host tick. An
            // empty drain means "no client packet this frame", not a combat-host
            // failure; the Node listener will simply skip sending for that tick.
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    private static string? LastPayload(IEnumerable<HostPacket> packets, int packetId)
    {
        return packets.LastOrDefault(packet => packet.PacketId == packetId)?.PayloadBase64;
    }

    private static bool TryGetSession(DynamicGameState? dynamicGame, out ManagedCombatSession session, out string? error)
    {
        session = null!;
        error = null;
        if (dynamicGame == null || !dynamicGame.ManagedCombat || string.IsNullOrWhiteSpace(dynamicGame.ManagedSessionId))
        {
            return false;
        }

        if (Sessions.TryGetValue(dynamicGame.ManagedSessionId, out session!))
        {
            return true;
        }

        error = $"managed combat session not found: {dynamicGame.ManagedSessionId}";
        return false;
    }

    private sealed class ManagedCombatSession
    {
        private readonly string sessionId;
        private readonly ManagedRuntime runtime;
        private readonly object server;
        private readonly List<HostPacket> setupPackets;
        private bool finishStateFlushedWithGameEnd;

        public ManagedCombatSession(string sessionId, ManagedRuntime runtime, object server, List<HostPacket> setupPackets)
        {
            this.sessionId = sessionId;
            this.runtime = runtime;
            this.server = server;
            this.setupPackets = setupPackets;
        }

        public bool Started { get; private set; }

        public void ApplyRuntimeControls(DynamicGameState? dynamicGame)
        {
            if (dynamicGame == null) return;
            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            if (runtimeData == null) return;

            if (dynamicGame.GameSpeedType.HasValue)
            {
                runtime.SetField(runtimeData, "m_NKM_GAME_SPEED_TYPE", ClampControlEnum(dynamicGame.GameSpeedType.Value, 0, 5));
            }

            var runtimeTeamA = runtime.GetField(runtimeData, "m_NKMGameRuntimeTeamDataA");
            if (runtimeTeamA == null) return;
            if (dynamicGame.AutoSkillType.HasValue)
            {
                runtime.SetField(runtimeTeamA, "m_NKM_GAME_AUTO_SKILL_TYPE", ClampControlEnum(dynamicGame.AutoSkillType.Value, 0, 1));
            }
            if (dynamicGame.AutoRespawnEnabled.HasValue)
            {
                runtime.SetField(runtimeTeamA, "m_bAutoRespawn", dynamicGame.AutoRespawnEnabled.Value);
            }
        }

        private static int ClampControlEnum(int value, int min, int max)
        {
            return Math.Max(min, Math.Min(max, value));
        }

        public HostPacket BuildLoadCompleteAck()
        {
            var packet = runtime.Create("ClientPacket.Game.NKMPacket_GAME_LOAD_COMPLETE_ACK");
            runtime.SetField(packet, "gameRuntimeData", runtime.Invoke(server, "GetGameRuntimeData"));
            runtime.SetField(packet, "rewardMultiply", 1);
            return runtime.SerializePacket(packet, GameLoadCompleteAck, "managed-load-complete");
        }

        public void Start()
        {
            if (Started) return;
            runtime.Invoke(server, "StartGame", false);
            Started = true;
        }

        public List<HostPacket> DrainSetupPackets()
        {
            if (setupPackets.Count == 0) return [];
            var output = setupPackets.ToList();
            setupPackets.Clear();
            return output;
        }

        public List<HostPacket> DrainQueuedPackets(string label)
        {
            return runtime.DrainClientPackets(label);
        }

        public void EnsureStarted()
        {
            if (!Started)
            {
                Start();
            }
        }

        public List<HostPacket> HandleDeploy(RespawnReq req)
        {
            var request = runtime.Create("ClientPacket.Game.NKMPacket_GAME_RESPAWN_REQ");
            var requestedUnitUid = ParseLong(req.UnitUID);
            runtime.SetField(request, "unitUID", requestedUnitUid);
            runtime.SetField(request, "assistUnit", req.AssistUnit);
            runtime.SetField(request, "respawnPosX", (float)req.RespawnPosX);
            runtime.SetField(request, "gameTime", (float)req.GameTime);

            var respawnUnitUid = requestedUnitUid;
            var method = runtime.GetMethod(
                server.GetType(),
                "OnRecv",
                runtime.GetType("ClientPacket.Game.NKMPacket_GAME_RESPAWN_REQ"),
                typeof(long).MakeByRefType());
            var args = new object[] { request, respawnUnitUid };
            var errorCode = method.Invoke(server, args);
            respawnUnitUid = Convert.ToInt64(args[1], CultureInfo.InvariantCulture);
            if (respawnUnitUid <= 0) respawnUnitUid = requestedUnitUid;

            var ack = runtime.Create("ClientPacket.Game.NKMPacket_GAME_RESPAWN_ACK");
            runtime.SetField(ack, "errorCode", errorCode);
            runtime.SetField(ack, "unitUID", respawnUnitUid);
            runtime.SetField(ack, "assistUnit", req.AssistUnit);

            var packets = new List<HostPacket>
            {
                runtime.SerializePacket(ack, GameRespawnAck, "managed-respawn")
            };
            // Run one frame after the command so the ACK is not held behind a
            // hidden warm-up loop. The regular 33ms battle pump carries follow-up
            // movement/attack syncs.
            packets.AddRange(UpdateAndDrainUntilResponsive(ManagedActionPrimeFrames));
            return packets;
        }

        public List<HostPacket> HandlePause(PauseReq req)
        {
            var request = runtime.Create("ClientPacket.Game.NKMPacket_GAME_PAUSE_REQ");
            runtime.SetField(request, "isPause", req.IsPause);
            runtime.SetField(request, "isPauseEvent", req.IsPauseEvent);

            var method = runtime.GetMethod(server.GetType(), "OnRecv", runtime.GetType("ClientPacket.Game.NKMPacket_GAME_PAUSE_REQ"));
            var errorCode = method.Invoke(server, [request]);

            var ack = runtime.Create("ClientPacket.Game.NKMPacket_GAME_PAUSE_ACK");
            runtime.SetField(ack, "errorCode", errorCode);
            runtime.SetField(ack, "isPause", req.IsPause);
            runtime.SetField(ack, "isPauseEvent", req.IsPauseEvent);

            return [runtime.SerializePacket(ack, GamePauseAck, "managed-pause")];
        }

        public List<HostPacket> HandleUnitSkill(UnitSkillReq req)
        {
            var request = runtime.Create("ClientPacket.Game.NKMPacket_GAME_USE_UNIT_SKILL_REQ");
            runtime.SetField(request, "gameUnitUID", req.GameUnitUID);

            var teamType = runtime.GetType("NKM.NKM_TEAM_TYPE");
            var userDataType = runtime.GetType("NKM.NKMUserData");
            var method = runtime.GetMethod(
                server.GetType(),
                "OnRecv",
                runtime.GetType("ClientPacket.Game.NKMPacket_GAME_USE_UNIT_SKILL_REQ"),
                teamType,
                typeof(byte).MakeByRefType(),
                userDataType);
            var skillStateId = (byte)0;
            var args = new object?[] { request, Enum.ToObject(teamType, 1), skillStateId, null };
            var errorCode = method.Invoke(server, args);
            skillStateId = Convert.ToByte(args[2], CultureInfo.InvariantCulture);

            var ack = runtime.Create("ClientPacket.Game.NKMPacket_GAME_USE_UNIT_SKILL_ACK");
            runtime.SetField(ack, "errorCode", errorCode);
            runtime.SetField(ack, "gameUnitUID", req.GameUnitUID);
            runtime.SetField(ack, "skillStateID", (sbyte)skillStateId);

            var packets = new List<HostPacket>
            {
                runtime.SerializePacket(ack, GameUseUnitSkillAck, "managed-unit-skill")
            };
            packets.AddRange(UpdateAndDrainUntilResponsive(ManagedActionPrimeFrames));
            return packets;
        }

        public List<HostPacket> HandleShipSkill(ShipSkillReq req)
        {
            var request = runtime.Create("ClientPacket.Game.NKMPacket_GAME_SHIP_SKILL_REQ");
            runtime.SetField(request, "gameUnitUID", req.GameUnitUID);
            runtime.SetField(request, "shipSkillID", req.ShipSkillID);
            runtime.SetField(request, "skillPosX", req.SkillPosX);

            var ack = runtime.Create("ClientPacket.Game.NKMPacket_GAME_SHIP_SKILL_ACK");
            runtime.SetField(ack, "gameUnitUID", req.GameUnitUID);
            runtime.SetField(ack, "shipSkillID", req.ShipSkillID);
            runtime.SetField(ack, "skillPosX", req.SkillPosX);

            var method = runtime.GetMethod(
                server.GetType(),
                "OnRecv",
                runtime.GetType("ClientPacket.Game.NKMPacket_GAME_SHIP_SKILL_REQ"),
                runtime.GetType("ClientPacket.Game.NKMPacket_GAME_SHIP_SKILL_ACK"));
            var errorCode = method.Invoke(server, [request, ack]);
            runtime.SetField(ack, "errorCode", errorCode);

            var packets = new List<HostPacket>
            {
                runtime.SerializePacket(ack, GameShipSkillAck, "managed-ship-skill")
            };
            packets.AddRange(UpdateAndDrainUntilResponsive(ManagedActionPrimeFrames));
            return packets;
        }

        private List<HostPacket> UpdateAndDrainUntilResponsive(int maxFrames)
        {
            var result = new List<HostPacket>();
            HostPacket? lastQuietSync = null;
            var frames = Math.Max(1, maxFrames);
            for (var index = 0; index < frames; index += 1)
            {
                var packets = UpdateAndDrain(ManagedFrameDelta, 1);
                foreach (var packet in packets)
                {
                    if (IsQuietGameSync(packet))
                    {
                        lastQuietSync = packet;
                        continue;
                    }

                    result.Add(packet);
                }

                if (result.Any(packet => packet.PacketId == GameSync))
                {
                    return result;
                }
            }

            if (!result.Any(packet => packet.PacketId == GameSync) && lastQuietSync != null)
            {
                result.Add(lastQuietSync);
            }

            return result;
        }

        private static bool IsQuietGameSync(HostPacket packet)
        {
            if (packet.PacketId != GameSync || string.IsNullOrWhiteSpace(packet.PayloadBase64)) return false;
            try
            {
                return Convert.FromBase64String(packet.PayloadBase64).Length <= QuietGameSyncPayloadBytes;
            }
            catch
            {
                return false;
            }
        }

        public List<HostPacket> UpdateAndDrain(float delta, int frames = 1)
        {
            var frameCount = Math.Max(1, frames);
            var frameDelta = delta / frameCount;
            var output = new List<HostPacket>();
            for (var index = 0; index < frameCount; index += 1)
            {
                runtime.Invoke(server, "Update", ScaleFrameDeltaForRuntimeSpeed(frameDelta));
                var framePackets = runtime.DrainClientPackets($"managed-session-{sessionId}");
                if (!finishStateFlushedWithGameEnd && framePackets.Any(packet => packet.PacketId == GameEnd))
                {
                    finishStateFlushedWithGameEnd = true;
                    output.AddRange(FlushFinishStateSync());
                }
                output.AddRange(framePackets);
            }
            return output;
        }

        private float ScaleFrameDeltaForRuntimeSpeed(float frameDelta)
        {
            try
            {
                var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
                var speedType = Convert.ToInt32(runtime.GetField(runtimeData!, "m_NKM_GAME_SPEED_TYPE") ?? 0, CultureInfo.InvariantCulture);
                return frameDelta * SpeedScaleForType(speedType);
            }
            catch
            {
                return frameDelta;
            }
        }

        private static float SpeedScaleForType(int speedType)
        {
            return speedType switch
            {
                0 => 1.1f,
                1 => 1.5f,
                2 => 2.2f,
                3 => 0.6f,
                4 => 11f,
                5 => 80f,
                _ => 1f
            };
        }

        private List<HostPacket> FlushFinishStateSync()
        {
            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            if (runtimeData == null) return [];

            var gameStateType = runtime.GetType("NKM.NKM_GAME_STATE");
            var teamType = runtime.GetType("NKM.NKM_TEAM_TYPE");
            var finishState = Enum.Parse(gameStateType, "NGS_FINISH");
            var winTeam = runtime.GetField(runtimeData, "m_WinTeam") ?? Enum.Parse(teamType, "NTT_A1");
            var waveId = Convert.ToInt32(runtime.GetField(runtimeData, "m_WaveID") ?? 0, CultureInfo.InvariantCulture);

            // GAME_END_NOT carries result data, but the client plays victory and
            // outro from NGS_FINISH. Make that state sync precede 811 in the same
            // burst so the result packet cannot strand the client in NGS_PLAY.
            runtime.GetMethod(server.GetType(), "SyncGameStateChange", gameStateType, teamType, typeof(int)).Invoke(server, [finishState, winTeam, waveId]);
            runtime.GetMethod(server.GetType(), "ForceSyncDataPackFlushThisFrame").Invoke(server, []);
            runtime.GetMethod(server.GetType(), "SyncDataPackFlush").Invoke(server, []);
            return runtime.DrainClientPackets($"managed-finish-state-{sessionId}");
        }
    }

    private sealed class ManagedRuntime
    {
        private static readonly object Gate = new();
        private static ManagedRuntime? current;
        private static string currentRuntimeKey = "";

        private readonly Assembly assembly;
        private readonly string managedDir;
        private readonly IReadOnlyList<string> nativeSearchDirs;
        private readonly object packetController;
        private readonly Type serializableType;
        private readonly MethodInfo packetCreate;
        private readonly MethodInfo packetGetId;
        private readonly MethodInfo packetReaderGetWithoutNullBit;
        private readonly ConstructorInfo packetReaderCtor;
        private readonly MethodInfo packetWriterToBufferWithoutNullBit;
        private readonly MethodInfo zeroCopyCalcTotalSize;
        private readonly MethodInfo zeroCopyGetView;
        private readonly FieldInfo messageQueueField;
        private readonly FieldInfo messageEventField;
        private readonly FieldInfo messageIdField;
        private readonly FieldInfo messageParamField;
        private bool clientTablesInitialized;
        private bool eventDeckTablesInitialized;

        private ManagedRuntime(string managedDir, string gameplayTablesDir)
        {
            this.managedDir = managedDir;
            AppDomain.CurrentDomain.AssemblyResolve += (_, args) => ResolveManagedAssembly(managedDir, args);
            ManagedLuaFileLoader.Configure(gameplayTablesDir);
            assembly = Assembly.LoadFrom(ManagedAssemblyPatcher.GetAssemblyPath(managedDir, gameplayTablesDir));
            nativeSearchDirs = BuildNativeSearchDirs(managedDir);
            PrimeNativeSearchPath(nativeSearchDirs);
            NativeLibrary.SetDllImportResolver(assembly, ResolveNativeLibrary);
            serializableType = GetType("Cs.Protocol.ISerializable");

            var packetControllerType = GetType("Cs.Protocol.PacketController");
            packetController = packetControllerType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
            packetControllerType.GetMethod("Initialize", BindingFlags.Public | BindingFlags.Instance)!.Invoke(packetController, null);
            packetCreate = packetControllerType.GetMethod("Create", BindingFlags.Public | BindingFlags.Instance, null, [typeof(ushort)], null)!;
            packetGetId = packetControllerType.GetMethod("GetId", BindingFlags.Public | BindingFlags.Instance, null, [serializableType], null)!;

            var packetReaderType = GetType("Cs.Protocol.PacketReader");
            packetReaderCtor = packetReaderType.GetConstructor([typeof(byte[])])!;
            packetReaderGetWithoutNullBit = packetReaderType.GetMethod("GetWithoutNullBit", BindingFlags.Public | BindingFlags.Instance, null, [serializableType], null)!;

            var packetWriterType = GetType("Cs.Protocol.PacketWriter");
            packetWriterToBufferWithoutNullBit = packetWriterType.GetMethod(
                "ToBufferWithoutNullBit",
                BindingFlags.Public | BindingFlags.Static,
                null,
                [serializableType],
                null)!;

            var zeroCopyType = GetType("Cs.Engine.Network.Buffer.ZeroCopyBuffer");
            zeroCopyCalcTotalSize = zeroCopyType.GetMethod("CalcTotalSize", BindingFlags.Public | BindingFlags.Instance)!;
            zeroCopyGetView = zeroCopyType.GetMethod("GetView", BindingFlags.NonPublic | BindingFlags.Instance)!;

            var messageType = GetType("NKC.NKCMessage");
            messageQueueField = messageType.GetField("m_linklistNKMMessageData", BindingFlags.NonPublic | BindingFlags.Static)!;
            var messageDataType = GetType("NKC.NKCMessageData");
            messageEventField = messageDataType.GetField("m_NKC_EVENT_MESSAGE", BindingFlags.Public | BindingFlags.Instance)!;
            messageIdField = messageDataType.GetField("m_MsgID2", BindingFlags.Public | BindingFlags.Instance)!;
            messageParamField = messageDataType.GetField("m_Param1", BindingFlags.Public | BindingFlags.Instance)!;
        }

        public static ManagedRuntime? TryLoad(string managedDir, string gameplayTablesDir, out string? error)
        {
            error = null;
            try
            {
                var fullPath = Path.GetFullPath(managedDir);
                var tablesPath = string.IsNullOrWhiteSpace(gameplayTablesDir) ? "" : Path.GetFullPath(gameplayTablesDir);
                var assemblyPath = Path.Combine(fullPath, "Assembly-CSharp.dll");
                if (!File.Exists(assemblyPath))
                {
                    error = $"missing Assembly-CSharp.dll in {fullPath}";
                    return null;
                }

                lock (Gate)
                {
                    var runtimeKey = fullPath + "|" + tablesPath;
                    if (current != null && string.Equals(currentRuntimeKey, runtimeKey, StringComparison.OrdinalIgnoreCase))
                    {
                        return current;
                    }

                    current = new ManagedRuntime(fullPath, tablesPath);
                    currentRuntimeKey = runtimeKey;
                    return current;
                }
            }
            catch (Exception ex)
            {
                error = ex.ToString();
                return null;
            }
        }

        public object Create(string typeName) => Activator.CreateInstance(GetType(typeName))!;

        public void InitializeClientTables()
        {
            if (clientTablesInitialized) return;
            var nkcMainType = GetType("NKC.NKCMain");
            nkcMainType.GetMethod("NKCInit", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null);
            LoadOptionalStaticTable("NKM.NKMTacticUpdateTemplet", "LoadFromLua");
            clientTablesInitialized = true;
        }

        private void LoadOptionalStaticTable(string typeName, string methodName)
        {
            try
            {
                GetType(typeName)
                    .GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static, null, Type.EmptyTypes, null)
                    ?.Invoke(null, null);
            }
            catch
            {
                // Optional combat support tables should not block startup; the
                // managed bridge can still fall back if a table is unavailable.
            }
        }

        public void PrepareGameDataForLocalServer(object gameData)
        {
            // Captured GAME_LOAD_ACK payloads already contain gameUnitUID lists
            // because they were built by the official server. NKCGameServerLocal
            // expects raw deck/team data and assigns those runtime IDs itself.
            SetField(gameData, "m_GameUnitUIDIndex", (short)0);
            foreach (var teamField in new[] { "m_NKMGameTeamDataA", "m_NKMGameTeamDataB" })
            {
                var team = GetField(gameData, teamField);
                if (team != null)
                {
                    ClearTeamRuntimeUnitIds(team);
                }
            }
        }

        public void ApplyTutorialGameType(object gameData, int dungeonId)
        {
            // Captured 804 starts as a tutorial payload. Pin the type each time
            // NKCGameServerLocal mutates gameData so normal Episode 1 stages do
            // not inherit tutorial result flow.
            var gameTypeName = IsTutorialDungeon(dungeonId) ? "NGT_TUTORIAL" : "NGT_DUNGEON";
            SetField(gameData, "m_NKM_GAME_TYPE", Enum.Parse(GetType("NKM.NKM_GAME_TYPE"), gameTypeName));
        }

        private static bool IsTutorialDungeon(int dungeonId)
        {
            return dungeonId is 1004 or 1005 or 1006 or 1007;
        }

        public void ApplyTutorialEventDeckTeamA(object gameData, int eventDeckId)
        {
            // Later tutorial phases use event decks 1005..1007. The regular
            // MakeEventDeckShipData path can fail when local ship level-break
            // tables are incomplete, so hydrate Team A with the event-deck NPC
            // units directly and keep/replace the ship only when that is safe.
            if (eventDeckId < 1004 || eventDeckId > 1007) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;

            var dungeonManagerType = GetType("NKM.NKMDungeonManager");
            var eventDeckTemplet = GetEventDeckTemplet(dungeonManagerType, eventDeckId);
            if (eventDeckTemplet == null) return;

            ApplyEventDeckShip(teamA, dungeonManagerType, eventDeckTemplet);
            ApplyEventDeckUnits(teamA, dungeonManagerType, eventDeckTemplet);
            RefreshTeamDeck(gameData, teamA, resetDeck: true);
        }

        public void RefreshTutorialTeamADeck(object gameData, int stageId, int dungeonId)
        {
            if (!IsTutorialDungeon(dungeonId) && stageId is not (11211 or 11212 or 11213 or 11214)) return;
            if (stageId == 11211 || dungeonId == 1004) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;
            RefreshTeamDeck(gameData, teamA, resetDeck: true);
        }

        public void ApplyEventDeckTeamA(object gameData, int eventDeckId)
        {
            if (eventDeckId <= 0) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;

            var dungeonManagerType = GetType("NKM.NKMDungeonManager");
            var eventDeckTemplet = GetEventDeckTemplet(dungeonManagerType, eventDeckId);
            if (eventDeckTemplet == null) return;

            ApplyEventDeckShip(teamA, dungeonManagerType, eventDeckTemplet);
            ApplyEventDeckUnits(teamA, dungeonManagerType, eventDeckTemplet);
            RefreshTeamDeck(gameData, teamA, resetDeck: true);
        }

        public void ApplyPlayerDeckTeamA(object gameData, PlayerDeckData? playerDeck, int stageId, int dungeonId)
        {
            if (playerDeck == null || playerDeck.Units.Count == 0) return;
            if (IsTutorialDungeon(dungeonId) || stageId is 11211 or 11212 or 11213 or 11214) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;

            var userUid = ParseLong(playerDeck.UserUid);
            SetField(teamA, "m_eNKM_TEAM_TYPE", Enum.Parse(GetType("NKM.NKM_TEAM_TYPE"), "NTT_A1"));
            SetField(teamA, "m_user_uid", userUid);
            SetField(teamA, "m_UserLevel", Math.Max(1, playerDeck.UserLevel));
            SetField(teamA, "m_UserNickname", playerDeck.Nickname ?? "");

            if (playerDeck.ShipUnitId > 0)
            {
                var shipUid = ParseLong(playerDeck.ShipUid);
                if (shipUid <= 0) shipUid = userUid > 0 ? userUid + 1 : 1;
                SetField(teamA, "m_MainShip", CreateBasicUnit(
                    playerDeck.ShipUnitId,
                    shipUid,
                    Math.Max(1, playerDeck.ShipLevel),
                    playerDeck.ShipSkinId,
                    0,
                    0,
                    userUid,
                    null,
                    null));
            }

            ClearCollectionField(teamA, "m_listUnitData");
            ClearCollectionField(teamA, "m_listAssistUnitData");
            ClearCollectionField(teamA, "m_listEvevtUnitData");
            ClearCollectionField(teamA, "m_listOperatorUnitData");
            ClearCollectionField(teamA, "m_listDynamicRespawnUnitData");
            ClearCollectionField(teamA, "m_ItemEquipData");

            var unitList = GetField(teamA, "m_listUnitData");
            long firstUnitUid = 0;
            foreach (var unitData in playerDeck.Units.OrderBy(unit => unit.SlotIndex))
            {
                var unitUid = ParseLong(unitData.UnitUid);
                if (unitData.UnitId <= 0 || unitUid <= 0) continue;
                var unit = CreateBasicUnit(
                    unitData.UnitId,
                    unitUid,
                    Math.Max(1, unitData.Level),
                    unitData.SkinId,
                    unitData.TacticLevel,
                    unitData.LimitBreakLevel,
                    userUid,
                    unitData.SkillLevels,
                    unitData.EquipItemUids.Select(ParseLong));
                AddCollectionItem(unitList, unit);
                if (firstUnitUid <= 0) firstUnitUid = unitUid;
            }

            var leaderUid = ParseLong(playerDeck.LeaderUnitUid);
            if (leaderUid <= 0) leaderUid = firstUnitUid;
            if (leaderUid > 0) SetField(teamA, "m_LeaderUnitUID", leaderUid);

            RefreshTeamDeck(gameData, teamA, resetDeck: true);
        }

        public void ApplyPlayerDeckFreeSlotsTeamA(
            object gameData,
            PlayerDeckData? playerDeck,
            IEnumerable<int>? freeSlots,
            bool usePlayerShip,
            int eventDeckId = 0)
        {
            var slotSet = freeSlots?
                .Where(slot => slot >= 0 && slot < 8)
                .Distinct()
                .Order()
                .ToList();
            if (playerDeck == null || playerDeck.Units.Count == 0 || slotSet == null || slotSet.Count == 0) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;

            var userUid = ParseLong(playerDeck.UserUid);
            SetField(teamA, "m_eNKM_TEAM_TYPE", Enum.Parse(GetType("NKM.NKM_TEAM_TYPE"), "NTT_A1"));
            SetField(teamA, "m_user_uid", userUid);
            SetField(teamA, "m_UserLevel", Math.Max(1, playerDeck.UserLevel));
            SetField(teamA, "m_UserNickname", playerDeck.Nickname ?? "");

            if (usePlayerShip && playerDeck.ShipUnitId > 0)
            {
                var shipUid = ParseLong(playerDeck.ShipUid);
                if (shipUid <= 0) shipUid = userUid > 0 ? userUid + 1 : 1;
                SetField(teamA, "m_MainShip", CreateBasicUnit(
                    playerDeck.ShipUnitId,
                    shipUid,
                    Math.Max(1, playerDeck.ShipLevel),
                    playerDeck.ShipSkinId,
                    0,
                    0,
                    userUid,
                    null,
                    null));
            }

            var unitList = GetField(teamA, "m_listUnitData");
            if (unitList == null) return;
            var eventDeckSlotPositions = GetEventDeckGeneratedUnitPositions(eventDeckId);

            var usedPlayerUnitUids = new HashSet<long>();
            if (unitList is IEnumerable existingUnits)
            {
                foreach (var existingUnit in existingUnits)
                {
                    if (existingUnit == null) continue;
                    var unitUid = Convert.ToInt64(GetField(existingUnit, "m_UnitUID") ?? 0, CultureInfo.InvariantCulture);
                    if (unitUid > 0) usedPlayerUnitUids.Add(unitUid);
                }
            }

            var orderedPlayerUnits = playerDeck.Units.OrderBy(unit => unit.SlotIndex).ToList();
            long firstAddedUnitUid = 0;
            foreach (var slotIndex in slotSet)
            {
                var unitData = orderedPlayerUnits.FirstOrDefault(unit => unit.SlotIndex == slotIndex && IsUsable(unit));
                if (unitData == null) continue;

                var unitUid = ParseLong(unitData.UnitUid);
                var unit = CreateBasicUnit(
                    unitData.UnitId,
                    unitUid,
                    Math.Max(1, unitData.Level),
                    unitData.SkinId,
                    unitData.TacticLevel,
                    unitData.LimitBreakLevel,
                    userUid,
                    unitData.SkillLevels,
                    unitData.EquipItemUids.Select(ParseLong));
                if (!eventDeckSlotPositions.TryGetValue(slotIndex, out var existingUnitIndex) ||
                    !TrySetCollectionItem(unitList, existingUnitIndex, unit))
                {
                    AddCollectionItem(unitList, unit);
                }
                usedPlayerUnitUids.Add(unitUid);
                if (firstAddedUnitUid <= 0) firstAddedUnitUid = unitUid;
            }

            var leaderUid = Convert.ToInt64(GetField(teamA, "m_LeaderUnitUID") ?? 0, CultureInfo.InvariantCulture);
            if (leaderUid <= 0)
            {
                var playerLeaderUid = ParseLong(playerDeck.LeaderUnitUid);
                SetField(teamA, "m_LeaderUnitUID", playerLeaderUid > 0 ? playerLeaderUid : firstAddedUnitUid);
            }

            RefreshTeamDeck(gameData, teamA, resetDeck: true);

            bool IsUsable(PlayerUnitData unitData)
            {
                var unitUid = ParseLong(unitData.UnitUid);
                return unitData.UnitId > 0 && unitUid > 0 && !usedPlayerUnitUids.Contains(unitUid);
            }
        }

        private Dictionary<int, int> GetEventDeckGeneratedUnitPositions(int eventDeckId)
        {
            var positions = new Dictionary<int, int>();
            if (eventDeckId <= 0) return positions;

            var dungeonManagerType = GetType("NKM.NKMDungeonManager");
            var eventDeckTemplet = GetEventDeckTemplet(dungeonManagerType, eventDeckId);
            if (eventDeckTemplet == null) return positions;

            var getUnitSlot = eventDeckTemplet.GetType().GetMethod(
                "GetUnitSlot",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                [typeof(int)],
                null);
            if (getUnitSlot == null) return positions;

            var generatedIndex = 0;
            for (var slotIndex = 0; slotIndex < 8; slotIndex++)
            {
                var slot = getUnitSlot.Invoke(eventDeckTemplet, [slotIndex]);
                if (slot == null) continue;
                var slotType = GetField(slot, "m_eType")?.ToString() ?? "";
                if (!EventDeckSlotCreatesPresetUnit(slotType)) continue;
                positions[slotIndex] = generatedIndex;
                generatedIndex++;
            }
            return positions;
        }

        private static bool EventDeckSlotCreatesPresetUnit(string slotType)
        {
            return slotType is "ST_GUEST" or "ST_NPC" or "ST_RANDOM";
        }

        private static bool TrySetCollectionItem(object collection, int index, object value)
        {
            if (index < 0) return false;
            if (collection is IList list)
            {
                if (index >= list.Count) return false;
                list[index] = value;
                return true;
            }

            var countProperty = collection.GetType().GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
            var count = Convert.ToInt32(countProperty?.GetValue(collection) ?? 0, CultureInfo.InvariantCulture);
            if (index >= count) return false;

            var itemProperty = collection.GetType().GetProperty("Item", BindingFlags.Public | BindingFlags.Instance);
            if (itemProperty == null) return false;
            itemProperty.SetValue(collection, value, [index]);
            return true;
        }

        public void ApplyPlayerIdentityTeamA(object gameData, PlayerDeckData? playerDeck)
        {
            if (playerDeck == null) return;
            var userUid = ParseLong(playerDeck.UserUid);
            if (userUid <= 0) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;

            SetField(teamA, "m_eNKM_TEAM_TYPE", Enum.Parse(GetType("NKM.NKM_TEAM_TYPE"), "NTT_A1"));
            SetField(teamA, "m_user_uid", userUid);
            SetField(teamA, "m_UserLevel", Math.Max(1, playerDeck.UserLevel));
            SetField(teamA, "m_UserNickname", playerDeck.Nickname ?? "");
        }

        public void ApplyPlayerIdentityRuntimeData(object? runtimeData, PlayerDeckData? playerDeck)
        {
            if (runtimeData == null || playerDeck == null) return;
            var userUid = ParseLong(playerDeck.UserUid);
            if (userUid <= 0) return;

            SetField(runtimeData, "m_NKM_GAME_SPEED_TYPE", 0);
            var runtimeTeamA = GetField(runtimeData, "m_NKMGameRuntimeTeamDataA");
            if (runtimeTeamA == null) return;
            SetField(runtimeTeamA, "m_UserUID", userUid);
            SetField(runtimeTeamA, "m_bAutoRespawn", false);
            SetField(runtimeTeamA, "m_NKM_GAME_AUTO_SKILL_TYPE", 1);
        }

        public void ClearTeamAUnitOwnersForGameLoadAck(object gameData, PlayerDeckData? playerDeck)
        {
            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;

            var playerUnitUids = GetPlayerDeckUnitUids(playerDeck);
            ClearUnitOwner(GetField(teamA, "m_MainShip"), playerUnitUids);
            foreach (var listField in new[] { "m_listUnitData", "m_listAssistUnitData", "m_listEvevtUnitData", "m_listEnvUnitData", "m_listOperatorUnitData" })
            {
                if (GetField(teamA, listField) is not IEnumerable units) continue;
                foreach (var unit in units)
                {
                    ClearUnitOwner(unit, playerUnitUids);
                }
            }
        }

        private static HashSet<long> GetPlayerDeckUnitUids(PlayerDeckData? playerDeck)
        {
            var unitUids = new HashSet<long>();
            if (playerDeck == null) return unitUids;

            foreach (var unit in playerDeck.Units)
            {
                var unitUid = ParseLong(unit.UnitUid);
                if (unitUid > 0) unitUids.Add(unitUid);
            }

            var shipUid = ParseLong(playerDeck.ShipUid);
            if (shipUid > 0) unitUids.Add(shipUid);

            var operatorUid = ParseLong(playerDeck.OperatorUid);
            if (operatorUid > 0) unitUids.Add(operatorUid);

            return unitUids;
        }

        private void ClearUnitOwner(object? unitData, HashSet<long> preservedUnitUids)
        {
            if (unitData == null) return;
            var unitUid = Convert.ToInt64(GetField(unitData, "m_UnitUID") ?? 0, CultureInfo.InvariantCulture);
            if (unitUid > 0 && preservedUnitUids.Contains(unitUid)) return;
            SetField(unitData, "m_UserUID", 0L);
        }

        public object BuildGameData(StartBattleData data, DynamicGameState dynamicGame)
        {
            var gameData = Create("NKM.NKMGameData");
            SetField(gameData, "m_GameUID", dynamicGame.GameUID);
            SetField(gameData, "m_GameUnitUIDIndex", (short)0);
            SetField(gameData, "m_bLocal", false);
            SetField(gameData, "m_DungeonID", dynamicGame.DungeonID);
            SetField(gameData, "m_MapID", dynamicGame.MapID);
            SetField(gameData, "m_TeamASupply", (byte)2);
            SetField(gameData, "m_bBossDungeon", false);
            ApplyTutorialGameType(gameData, dynamicGame.DungeonID);

            var eventDeckId = data.Stage?.EventDeckId ?? dynamicGame.DungeonID;
            if (ShouldApplyTutorialEventDeckTeamA(dynamicGame.StageID, dynamicGame.DungeonID, eventDeckId))
            {
                ApplyTutorialEventDeckTeamA(gameData, eventDeckId);
            }
            else if (ShouldApplyEventDeck(dynamicGame.StageID, dynamicGame.DungeonID, eventDeckId))
            {
                ApplyEventDeckTeamA(gameData, eventDeckId);
                ApplyPlayerDeckFreeSlotsTeamA(
                    gameData,
                    data.Stage?.PlayerDeck,
                    data.Stage?.EventDeckFreeUnitSlots,
                    data.Stage?.EventDeckFreeShipSlot == true,
                    eventDeckId);
            }
            else
            {
                ApplyPlayerDeckTeamA(gameData, data.Stage?.PlayerDeck, dynamicGame.StageID, dynamicGame.DungeonID);
            }

            return gameData;
        }

        private object? GetEventDeckTemplet(Type dungeonManagerType, int eventDeckId)
        {
            EnsureEventDeckTablesLoaded(dungeonManagerType);
            var getEventDeck = dungeonManagerType.GetMethod(
                "GetEventDeckTemplet",
                BindingFlags.Public | BindingFlags.Static,
                null,
                [typeof(int)],
                null);
            return getEventDeck?.Invoke(null, [eventDeckId]);
        }

        private void EnsureEventDeckTablesLoaded(Type dungeonManagerType)
        {
            if (eventDeckTablesInitialized) return;
            dungeonManagerType
                .GetMethod("LoadFromLUA_EventDeckInfo", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null)
                ?.Invoke(null, null);
            eventDeckTablesInitialized = true;
        }

        private void ApplyEventDeckShip(object teamA, Type dungeonManagerType, object eventDeckTemplet)
        {
            object? shipSlot = null;
            int unitId = 0;
            int level = 1;
            int skinId = 0;
            int tacticLevel = 0;
            long npcUid = 0;
            try
            {
                shipSlot = GetField(eventDeckTemplet, "ShipSlot");
                if (shipSlot == null) return;

                unitId = Convert.ToInt32(GetField(shipSlot, "m_ID") ?? 0, CultureInfo.InvariantCulture);
                if (unitId <= 0) return;

                level = Convert.ToInt32(GetField(shipSlot, "m_Level") ?? 1, CultureInfo.InvariantCulture);
                skinId = Convert.ToInt32(GetField(shipSlot, "m_SkinID") ?? 0, CultureInfo.InvariantCulture);
                tacticLevel = Convert.ToInt32(GetField(shipSlot, "m_TacticLevel") ?? 0, CultureInfo.InvariantCulture);
                npcUid = Convert.ToInt64(
                    GetType("NKM.NpcUid").GetMethod("Get", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null),
                    CultureInfo.InvariantCulture);

                var makeUnitDataFromId = dungeonManagerType.GetMethod(
                    "MakeUnitDataFromID",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    [typeof(int), typeof(long), typeof(int), typeof(int), typeof(int), typeof(int), typeof(int), typeof(int)],
                    null);
                var ship = makeUnitDataFromId?.Invoke(null, [unitId, npcUid, level, -1, skinId, tacticLevel, -1, -1])
                    ?? CreateBasicTutorialUnit(unitId, npcUid, level, skinId, tacticLevel);
                if (ship != null)
                {
                    SetField(teamA, "m_MainShip", ship);
                }
            }
            catch
            {
                if (unitId <= 0 || npcUid <= 0) return;
                // If local ship limit-break tables are incomplete, build just
                // the serialized unit shell the client needs for game load.
                var ship = CreateBasicTutorialUnit(unitId, npcUid, level, skinId, tacticLevel);
                SetField(teamA, "m_MainShip", ship);
            }
        }

        private object CreateBasicTutorialUnit(int unitId, long unitUid, int level, int skinId, int tacticLevel)
        {
            return CreateBasicUnit(unitId, unitUid, level, skinId, tacticLevel, 0, 0, null, null);
        }

        private object CreateBasicUnit(
            int unitId,
            long unitUid,
            int level,
            int skinId,
            int tacticLevel,
            int limitBreakLevel,
            long userUid,
            IEnumerable<int>? skillLevels,
            IEnumerable<long>? equipItemUids)
        {
            var unit = Create("NKM.NKMUnitData");
            if (userUid > 0) SetField(unit, "m_UserUID", userUid);
            SetField(unit, "m_UnitID", unitId);
            SetField(unit, "m_UnitUID", unitUid);
            SetField(unit, "m_UnitLevel", level);
            SetField(unit, "m_SkinID", skinId);
            SetField(unit, "m_LimitBreakLevel", Math.Max(0, limitBreakLevel));
            SetField(unit, "m_bLock", false);
            SetField(unit, "tacticLevel", tacticLevel);
            FindMethodByName(unit.GetType(), "FillSkillLevelByUnitID")?.Invoke(unit, [unitId]);

            if (skillLevels != null)
            {
                var skills = skillLevels.Take(5).Select(value => Math.Max(0, value)).ToArray();
                if (skills.Length < 5) skills = skills.Concat(Enumerable.Repeat(1, 5 - skills.Length)).ToArray();
                SetField(unit, "m_aUnitSkillLevel", skills);
            }

            if (equipItemUids != null)
            {
                // Combat stat hydration dereferences every UID in m_EquipItemList
                // through NKMGameTeamData.m_ItemEquipData. Until the local deck
                // bridge serializes full NKMEquipItemData objects, keep these
                // slots empty so maxed/equipped units do not hand managed combat
                // dangling equipment references.
                SetField(unit, "m_EquipItemList", Enumerable.Repeat(0L, 4).ToArray());
            }
            return unit;
        }

        private void ApplyEventDeckUnits(object teamA, Type dungeonManagerType, object eventDeckTemplet)
        {
            var armyData = Create("NKM.NKMArmyData");
            var eventDeckData = Create("NKM.NKMEventDeckData");
            var inventoryData = Create("NKM.NKMInventoryData");
            var teamType = GetType("NKM.NKM_TEAM_TYPE");
            var teamA1 = Enum.Parse(teamType, "NTT_A1");

            var makeUnits = dungeonManagerType.GetMethod(
                "MakeEventDeckUnitDataList",
                BindingFlags.Public | BindingFlags.Static,
                null,
                [
                    GetType("NKM.NKMArmyData"),
                    eventDeckTemplet.GetType(),
                    GetType("NKM.NKMDeckCondition"),
                    eventDeckData.GetType(),
                    inventoryData.GetType(),
                    teamType,
                    typeof(bool)
                ],
                null);
            var gameUnitDataList = makeUnits?.Invoke(null, [armyData, eventDeckTemplet, null, eventDeckData, inventoryData, teamA1, false]);
            var unitList = GetField(teamA, "m_listUnitData");
            unitList?.GetType().GetMethod("Clear", BindingFlags.Public | BindingFlags.Instance)?.Invoke(unitList, null);

            long firstUnitUid = 0;
            if (gameUnitDataList is IEnumerable units)
            {
                var add = unitList?.GetType().GetMethod("Add", BindingFlags.Public | BindingFlags.Instance);
                foreach (var gameUnitData in units)
                {
                    var unit = GetField(gameUnitData, "unit");
                    if (unit == null) continue;
                    add?.Invoke(unitList, [unit]);
                    if (firstUnitUid == 0)
                    {
                        firstUnitUid = Convert.ToInt64(GetField(unit, "m_UnitUID"), CultureInfo.InvariantCulture);
                    }
                }
            }

            if (firstUnitUid > 0)
            {
                SetField(teamA, "m_LeaderUnitUID", firstUnitUid);
            }
        }

        private void RefreshTeamDeck(object gameData, object teamData, bool resetDeck)
        {
            EnsureLeaderUnitUid(teamData);
            if (resetDeck)
            {
                var deckData = GetField(teamData, "m_DeckData");
                deckData?.GetType()
                    .GetMethod("Init", BindingFlags.Public | BindingFlags.Instance)
                    ?.Invoke(deckData, null);
            }

            var shuffle = gameData.GetType().GetMethod(
                "DoNotShuffleDeck",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                [teamData.GetType()],
                null);
            shuffle?.Invoke(gameData, [teamData]);

            try
            {
                gameData.GetType()
                    .GetMethod("InitRespawnLimitCount", BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null)
                    ?.Invoke(gameData, null);
            }
            catch
            {
                // Respawn limits are optional per-unit bookkeeping. If a locally
                // synthesized roster entry cannot resolve that table, keep the
                // GAME_LOAD_ACK usable instead of falling back to a stale capture.
            }
        }

        private void EnsureLeaderUnitUid(object teamData)
        {
            var leader = Convert.ToInt64(GetField(teamData, "m_LeaderUnitUID") ?? 0, CultureInfo.InvariantCulture);
            if (leader > 0) return;

            var firstUnitUid = GetFirstUnitUid(teamData);
            if (firstUnitUid > 0)
            {
                SetField(teamData, "m_LeaderUnitUID", firstUnitUid);
            }
        }

        private long GetFirstUnitUid(object teamData)
        {
            if (GetField(teamData, "m_listUnitData") is not IEnumerable units) return 0;
            foreach (var unit in units)
            {
                if (unit == null) continue;
                var unitUid = Convert.ToInt64(GetField(unit, "m_UnitUID") ?? 0, CultureInfo.InvariantCulture);
                if (unitUid > 0) return unitUid;
            }
            return 0;
        }

        public void SuppressPlayerDynamicRespawns(object server, object gameData)
        {
            // Player deck units can carry unit-template summon pools. In the
            // online tutorial those server-side dynamic spawns are not useful
            // for our local bridge and can materialize extra units at the
            // player's deploy position. Keep dungeon/team-B event waves intact.
            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA != null)
            {
                ClearCollectionField(teamA, "m_listDynamicRespawnUnitData");
            }

            ClearPlayerUnitDynamicRespawnPools(server, "m_dicNKMUnitPool");
            ClearPlayerUnitDynamicRespawnPools(server, "m_dicNKMUnit");
        }

        public bool TryApplyDungeonGameTeamData(object gameData, object? runtimeData, out string? error)
        {
            error = null;
            if (runtimeData == null)
            {
                error = "missing NKMGameRuntimeData";
                return false;
            }

            try
            {
                var dungeonId = Convert.ToInt32(GetField(gameData, "m_DungeonID"), CultureInfo.InvariantCulture);
                if (dungeonId <= 0)
                {
                    return true;
                }

                var dungeonManagerType = GetType("NKM.NKMDungeonManager");
                var method = dungeonManagerType.GetMethod(
                    "MakeGameTeamData",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    [gameData.GetType(), runtimeData.GetType()],
                    null);
                if (method == null)
                {
                    error = "NKMDungeonManager.MakeGameTeamData not found";
                    return false;
                }

                var ok = Convert.ToBoolean(method.Invoke(null, [gameData, runtimeData]), CultureInfo.InvariantCulture);
                if (!ok)
                {
                    error = $"NKMDungeonManager.MakeGameTeamData returned false for dungeonID={dungeonId}";
                }
                return ok;
            }
            catch (Exception ex)
            {
                error = ex.ToString();
                return false;
            }
        }

        private void ClearTeamRuntimeUnitIds(object teamData)
        {
            ClearUnitRuntimeIds(GetField(teamData, "m_MainShip"));
            foreach (var listField in new[]
            {
                "m_listUnitData",
                "m_listAssistUnitData",
                "m_listEvevtUnitData",
                "m_listEnvUnitData",
                "m_listOperatorUnitData"
            })
            {
                if (GetField(teamData, listField) is not IEnumerable units) continue;
                foreach (var unit in units)
                {
                    ClearUnitRuntimeIds(unit);
                }
            }
        }

        private void ClearUnitRuntimeIds(object? unitData)
        {
            if (unitData == null) return;
            ClearCollectionField(unitData, "m_listGameUnitUID");
            ClearCollectionField(unitData, "m_listNearTargetRange");
        }

        private void ClearCollectionField(object target, string fieldName)
        {
            var collection = GetField(target, fieldName);
            collection?.GetType().GetMethod("Clear", BindingFlags.Public | BindingFlags.Instance)?.Invoke(collection, null);
        }

        private static void AddCollectionItem(object? collection, object item)
        {
            collection?.GetType().GetMethod("Add", BindingFlags.Public | BindingFlags.Instance)?.Invoke(collection, [item]);
        }

        private static long ParseLong(string? value)
        {
            return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
        }

        private void ClearPlayerUnitDynamicRespawnPools(object server, string unitDictionaryFieldName)
        {
            if (GetField(server, unitDictionaryFieldName) is not IDictionary units) return;

            foreach (DictionaryEntry entry in units)
            {
                var unit = entry.Value;
                if (unit == null || !IsPlayerTeamUnit(unit)) continue;
                ClearCollectionField(unit, "m_dicDynamicRespawnPool");
                ClearCollectionField(unit, "m_dicUnitChangeRespawnPool");
            }
        }

        private static bool IsPlayerTeamUnit(object unit)
        {
            var method = unit.GetType().GetMethod("IsATeam", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            return method != null && Convert.ToBoolean(method.Invoke(unit, null), CultureInfo.InvariantCulture);
        }

        public Type GetType(string typeName)
        {
            return assembly.GetType(typeName, throwOnError: true)!;
        }

        public MethodInfo GetMethod(Type owner, string name, params Type[] parameterTypes)
        {
            var method = FindMethod(owner, name, parameterTypes);
            if (method == null)
            {
                throw new MissingMethodException(owner.FullName, name);
            }
            return method;
        }

        public object? Invoke(object target, string methodName, params object?[] args)
        {
            var parameterTypes = args.Select(arg => arg?.GetType() ?? typeof(object)).ToArray();
            var method = FindMethod(target.GetType(), methodName, parameterTypes) ?? FindMethodByName(target.GetType(), methodName);
            if (method == null)
            {
                throw new MissingMethodException(target.GetType().FullName, methodName);
            }
            return method.Invoke(target, args);
        }

        public object DeserializePacket(int packetId, byte[] payload)
        {
            var packet = packetCreate.Invoke(packetController, [Convert.ToUInt16(packetId)])!;
            var reader = packetReaderCtor.Invoke([payload]);
            try
            {
                packetReaderGetWithoutNullBit.Invoke(reader, [packet]);
                return packet;
            }
            finally
            {
                (reader as IDisposable)?.Dispose();
            }
        }

        public HostPacket SerializePacket(object packet, int fallbackPacketId, string label)
        {
            var id = Convert.ToInt32(packetGetId.Invoke(packetController, [packet]), CultureInfo.InvariantCulture);
            if (id <= 0 || id == ushort.MaxValue) id = fallbackPacketId;
            var zeroCopy = packetWriterToBufferWithoutNullBit.Invoke(null, [packet])!;
            var base64 = ZeroCopyToBase64(zeroCopy);
            return new HostPacket
            {
                PacketId = id,
                Label = label,
                PayloadBase64 = base64
            };
        }

        public HostPacket BuildGameLoadAck(object gameData)
        {
            var packet = Create("ClientPacket.Game.NKMPacket_GAME_LOAD_ACK");
            SetField(packet, "errorCode", 0);
            SetField(packet, "gameData", gameData);
            return SerializePacket(packet, GameLoadAck, "managed-game-load");
        }

        public string DescribeGameLoadAck(object packet)
        {
            var gameData = GetField(packet, "gameData");
            if (gameData == null) return "gameData=null";

            var lines = new List<string>
            {
                $"errorCode={GetField(packet, "errorCode")}",
                $"gameUID={GetField(gameData, "m_GameUID")} gameUnitUIDIndex={GetField(gameData, "m_GameUnitUIDIndex")} local={GetField(gameData, "m_bLocal")}",
                $"gameType={GetField(gameData, "m_NKM_GAME_TYPE")} dungeonID={GetField(gameData, "m_DungeonID")} mapID={GetField(gameData, "m_MapID")} teamASupply={GetField(gameData, "m_TeamASupply")} doubleCostTime={GetField(gameData, "m_fDoubleCostTime")}",
                $"teamA={DescribeTeam(GetField(gameData, "m_NKMGameTeamDataA"))}",
                $"teamB={DescribeTeam(GetField(gameData, "m_NKMGameTeamDataB"))}"
            };
            return string.Join(Environment.NewLine, lines);
        }

        public string DescribeGameSync(object packet)
        {
            var pack = GetField(packet, "gameSyncDataPack");
            var syncItems = pack == null ? null : GetField(pack, "m_listGameSyncData");
            var lines = new List<string>
            {
                $"packetGameTime={GetField(packet, "gameTime")} absolute={GetField(packet, "absoluteGameTime")} simulation={GetField(packet, "simulationGame")}",
                $"baseCount={CountCollection(syncItems)}"
            };

            if (syncItems is IEnumerable enumerable)
            {
                var index = 0;
                foreach (var syncBase in enumerable.Cast<object>())
                {
                    lines.Add($"base[{index}] {DescribeSyncBase(syncBase)}");
                    index += 1;
                    if (index >= 8) break;
                }
            }

            return string.Join(Environment.NewLine, lines);
        }

        public string DescribeGameLoadCompleteAck(object packet)
        {
            var runtimeData = GetField(packet, "gameRuntimeData");
            return string.Join(Environment.NewLine, new[]
            {
                $"errorCode={GetField(packet, "errorCode")} isIntrude={GetField(packet, "isIntrude")} rewardMultiply={GetField(packet, "rewardMultiply")}",
                DescribeRuntimeData(runtimeData)
            });
        }

        public string DescribeJoinLobbyAck(object packet)
        {
            var lines = new List<string>
            {
                $"packet={packet.GetType().FullName}",
                $"errorCode={GetField(packet, "errorCode")} friendCode={GetField(packet, "friendCode")} reconnectKey={GetField(packet, "reconnectKey")}",
                $"topLevel={DescribeObjectFields(packet, "userData")}",
                $"userData={DescribeObjectFields(GetField(packet, "userData"))}"
            };

            var userData = GetField(packet, "userData");
            if (userData != null)
            {
                lines.Add($"inventory={DescribeObjectFields(GetField(userData, "m_InventoryData"))}");
                lines.Add($"army={DescribeObjectFields(GetField(userData, "m_ArmyData"))}");
                lines.Add($"mission={DescribeObjectFields(GetField(userData, "m_MissionData"))}");
                lines.Add($"shop={DescribeObjectFields(GetField(userData, "m_ShopData"))}");
            }

            lines.Add($"intervalSample={DescribeIntervals(GetField(packet, "intervalData"), 16)}");
            return string.Join(Environment.NewLine, lines);
        }

        private string DescribeRuntimeData(object? runtimeData)
        {
            if (runtimeData == null) return "runtime=null";
            return string.Join(" ", new[]
            {
                $"runtimeGameTime={GetField(runtimeData, "m_GameTime")}",
                $"state={GetField(runtimeData, "m_NKM_GAME_STATE")}",
                $"wave={GetField(runtimeData, "m_WaveID")}",
                $"remain={GetField(runtimeData, "m_fRemainGameTime")}",
                $"win={GetField(runtimeData, "m_WinTeam")}",
                $"ended={GetField(runtimeData, "m_bGameEnded")}",
                $"teamA={DescribeRuntimeTeam(GetField(runtimeData, "m_NKMGameRuntimeTeamDataA"))}",
                $"teamB={DescribeRuntimeTeam(GetField(runtimeData, "m_NKMGameRuntimeTeamDataB"))}",
                $"events={CountCollection(GetField(runtimeData, "m_lstPermanentDungeonEvent"))}"
            });
        }

        private string DescribeRuntimeTeam(object? team)
        {
            if (team == null) return "null";
            return $"user={GetField(team, "m_UserUID")} cost={GetField(team, "m_fRespawnCost")} assist={GetField(team, "m_fRespawnCostAssist")} used={GetField(team, "m_fUsedRespawnCost")} count={GetField(team, "m_respawn_count")} auto={GetField(team, "m_NKM_GAME_AUTO_SKILL_TYPE")} aiDisable={GetField(team, "m_bAIDisable")}";
        }

        private string DescribeSyncBase(object? syncBase)
        {
            if (syncBase == null) return "null";
            return string.Join(" ", new[]
            {
                $"gameTime={GetField(syncBase, "m_fGameTime")}",
                $"remain={GetField(syncBase, "m_fRemainGameTime")}",
                $"costA={GetField(syncBase, "m_fRespawnCostA1")}",
                $"costB={GetField(syncBase, "m_fRespawnCostB1")}",
                $"speed={GetField(syncBase, "m_NKM_GAME_SPEED_TYPE")}",
                $"autoA={GetField(syncBase, "m_NKM_GAME_AUTO_SKILL_TYPE_A")}",
                $"units={DescribeSyncUnits(GetField(syncBase, "m_NKMGameSyncData_Unit"))}",
                $"simple={DescribeSimpleSyncUnits(GetField(syncBase, "m_NKMGameSyncDataSimple_Unit"))}",
                $"deck={DescribeDeckSyncs(GetField(syncBase, "m_NKMGameSyncData_Deck"))}",
                $"state={DescribeGameStateSyncs(GetField(syncBase, "m_NKMGameSyncData_GameState"))}",
                $"events={CountCollection(GetField(syncBase, "m_NKMGameSyncData_DungeonEvent"))}",
                $"die={CountCollection(GetField(syncBase, "m_NKMGameSyncData_DieUnit"))}",
                $"shipSkill={CountCollection(GetField(syncBase, "m_NKMGameSyncData_ShipSkill"))}"
            });
        }

        private string DescribeSyncUnits(object? units)
        {
            if (units is not IEnumerable enumerable) return "0[]";
            var values = new List<string>();
            foreach (var item in enumerable.Cast<object>().Take(12))
            {
                var unitSync = GetField(item, "m_NKMGameUnitSyncData");
                if (unitSync == null)
                {
                    values.Add("null");
                    continue;
                }

                values.Add(string.Join(":",
                    Convert.ToString(GetField(unitSync, "m_GameUnitUID"), CultureInfo.InvariantCulture),
                    Convert.ToString(GetField(unitSync, "m_NKM_UNIT_PLAY_STATE"), CultureInfo.InvariantCulture),
                    Convert.ToString(GetField(unitSync, "m_bRespawnThisFrame"), CultureInfo.InvariantCulture),
                    Convert.ToString(GetField(unitSync, "m_PosX"), CultureInfo.InvariantCulture),
                    Convert.ToString(GetField(unitSync, "m_StateID"), CultureInfo.InvariantCulture)));
            }
            return $"{CountCollection(units)}[{string.Join(",", values)}]";
        }

        private string DescribeSimpleSyncUnits(object? units)
        {
            if (units is not IEnumerable enumerable) return "0[]";
            var values = enumerable
                .Cast<object>()
                .Take(12)
                .Select(item => Convert.ToString(GetField(item, "m_GameUnitUID"), CultureInfo.InvariantCulture))
                .ToList();
            return $"{CountCollection(units)}[{string.Join(",", values)}]";
        }

        private string DescribeDeckSyncs(object? deckSyncs)
        {
            if (deckSyncs is not IEnumerable enumerable) return "0[]";
            var values = enumerable.Cast<object>().Take(12).Select(item => string.Join(":",
                Convert.ToString(GetField(item, "m_NKM_TEAM_TYPE"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_UnitDeckIndex"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_UnitDeckUID"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_NextDeckUnitUID"), CultureInfo.InvariantCulture))).ToList();
            return $"{CountCollection(deckSyncs)}[{string.Join(",", values)}]";
        }

        private string DescribeGameStateSyncs(object? gameStates)
        {
            if (gameStates is not IEnumerable enumerable) return "0[]";
            var values = enumerable.Cast<object>().Take(12).Select(item => string.Join(":",
                Convert.ToString(GetField(item, "m_NKM_GAME_STATE"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_WinTeam"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_WaveID"), CultureInfo.InvariantCulture))).ToList();
            return $"{CountCollection(gameStates)}[{string.Join(",", values)}]";
        }

        private string DescribeTeam(object? team)
        {
            if (team == null) return "null";

            return string.Join(" ", new[]
            {
                $"type={GetField(team, "m_eNKM_TEAM_TYPE")}",
                $"user={GetField(team, "m_user_uid")}",
                $"leader={GetField(team, "m_LeaderUnitUID")}",
                $"ship={DescribeUnit(GetField(team, "m_MainShip"))}",
                $"units={DescribeUnitList(GetField(team, "m_listUnitData"))}",
                $"events={DescribeUnitList(GetField(team, "m_listEvevtUnitData"))}",
                $"dynamic={CountCollection(GetField(team, "m_listDynamicRespawnUnitData"))}",
                $"env={CountCollection(GetField(team, "m_listEnvUnitData"))}",
                $"deck={DescribeDeck(GetField(team, "m_DeckData"))}"
            });
        }

        private string DescribeDeck(object? deck)
        {
            if (deck == null) return "null";
            try
            {
                var count = Convert.ToInt32(FindMethodByName(deck.GetType(), "GetListUnitDeckCount")?.Invoke(deck, null) ?? 0, CultureInfo.InvariantCulture);
                var values = new List<string>();
                var get = FindMethodByName(deck.GetType(), "GetListUnitDeck");
                for (var index = 0; index < count; index += 1)
                {
                    values.Add(Convert.ToInt64(get?.Invoke(deck, [index]) ?? 0L, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                }

                var used = Convert.ToInt32(FindMethodByName(deck.GetType(), "GetListUnitDeckUsedCount")?.Invoke(deck, null) ?? 0, CultureInfo.InvariantCulture);
                var tomb = Convert.ToInt32(FindMethodByName(deck.GetType(), "GetListUnitDeckTombCount")?.Invoke(deck, null) ?? 0, CultureInfo.InvariantCulture);
                return $"[{string.Join(",", values)}] used={used} tomb={tomb}";
            }
            catch (Exception ex)
            {
                return $"error:{ex.GetType().Name}";
            }
        }

        private string DescribeUnit(object? unit)
        {
            if (unit == null) return "null";
            return $"{GetField(unit, "m_UnitID")}:{GetField(unit, "m_UnitUID")} user={GetField(unit, "m_UserUID")} lv={GetField(unit, "m_UnitLevel")} gameUIDs=[{DescribeScalarList(GetField(unit, "m_listGameUnitUID"))}]";
        }

        private string DescribeUnitList(object? units)
        {
            if (units is not IEnumerable enumerable) return "0[]";
            var values = enumerable.Cast<object>().Take(12).Select(DescribeUnit).ToList();
            return $"{CountCollection(units)}[{string.Join(";", values)}]";
        }

        private static string DescribeScalarList(object? values)
        {
            if (values is not IEnumerable enumerable) return "";
            return string.Join(",", enumerable.Cast<object>().Take(12).Select(value => Convert.ToString(value, CultureInfo.InvariantCulture)));
        }

        private static int CountCollection(object? collection)
        {
            if (collection == null) return 0;
            if (collection is ICollection nonGeneric) return nonGeneric.Count;
            var countProperty = collection.GetType().GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
            if (countProperty != null)
            {
                return Convert.ToInt32(countProperty.GetValue(collection), CultureInfo.InvariantCulture);
            }
            return collection is IEnumerable enumerable ? enumerable.Cast<object>().Count() : 0;
        }

        private string DescribeObjectFields(object? target, params string[] excludeFields)
        {
            if (target == null) return "null";
            var exclude = new HashSet<string>(excludeFields ?? [], StringComparer.Ordinal);
            var fields = GetAllInstanceFields(target.GetType())
                .Where(field => !exclude.Contains(field.Name))
                .Select(field => $"{field.Name}={SummarizeValue(field.GetValue(target))}");
            return string.Join(" ", fields);
        }

        private static IEnumerable<FieldInfo> GetAllInstanceFields(Type type)
        {
            for (var current = type; current != null && current != typeof(object); current = current.BaseType)
            {
                foreach (var field in current.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                {
                    yield return field;
                }
            }
        }

        private static string SummarizeValue(object? value)
        {
            if (value == null) return "null";
            if (value is string text) return text.Length > 40 ? $"\"{text[..40]}...\"({text.Length})" : $"\"{text}\"";
            if (value is DateTime date) return date.ToString("O", CultureInfo.InvariantCulture);
            if (value is bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal || value.GetType().IsEnum)
            {
                return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            }
            if (value is IDictionary dictionary) return $"{value.GetType().Name}[{dictionary.Count}]";
            if (value is ICollection collection) return $"{value.GetType().Name}[{collection.Count}]";
            if (value is IEnumerable enumerable) return $"{value.GetType().Name}[{enumerable.Cast<object>().Count()}]";
            return value.GetType().Name;
        }

        private string DescribeIntervals(object? intervalData, int limit)
        {
            if (intervalData is not IEnumerable enumerable) return "0[]";
            var intervals = enumerable.Cast<object>().ToList();
            var values = intervals.Take(Math.Max(0, limit)).Select(interval =>
                $"{GetField(interval, "strKey")}:{GetField(interval, "startDate")}->{GetField(interval, "endDate")}");
            var strKeys = intervals
                .Select(interval => Convert.ToString(GetField(interval, "strKey"), CultureInfo.InvariantCulture) ?? "")
                .Where(strKey => !string.IsNullOrWhiteSpace(strKey))
                .ToList();
            var duplicateStrKeySummary = strKeys
                .GroupBy(strKey => strKey, StringComparer.Ordinal)
                .Where(group => group.Count() > 1)
                .Take(12)
                .Select(group => $"{group.Key}x{group.Count()}");
            var duplicateKeySummary = intervals
                .Select(interval => new
                {
                    Key = Convert.ToString(GetField(interval, "key"), CultureInfo.InvariantCulture) ?? "",
                    StrKey = Convert.ToString(GetField(interval, "strKey"), CultureInfo.InvariantCulture) ?? ""
                })
                .Where(interval => !string.IsNullOrWhiteSpace(interval.Key))
                .GroupBy(interval => interval.Key, StringComparer.Ordinal)
                .Where(group => group.Count() > 1)
                .Take(12)
                .Select(group => $"{group.Key}x{group.Count()}:{string.Join("/", group.Take(4).Select(interval => interval.StrKey))}");
            var probes = new[]
            {
                "DATE_COMMON_EPISODE_EVENT_ADMIN",
                "DATE_COMMON_EPISODE_EVENT_ADMIN_02",
                "DATE_COMMON_MISSION_EVENT_XMAS",
                "DATE_COMMON_EPISODE_EVENT_SHADE_01",
                "DATE_COMMON_EPISODE_EVENT_SUMMER2021_01"
            };
            var probeSummary = probes.Select(probe => $"{probe}={strKeys.Contains(probe)}");
            var focusedMatches = strKeys
                .Where(strKey =>
                    strKey.Contains("EPISODE_EVENT_ADMIN", StringComparison.Ordinal) ||
                    strKey.Contains("MISSION_EVENT_XMAS", StringComparison.Ordinal) ||
                    strKey.Contains("EPISODE_EVENT_SHADE", StringComparison.Ordinal) ||
                    strKey.Contains("EPISODE_EVENT_SUMMER2021", StringComparison.Ordinal))
                .Take(20);
            return $"{intervals.Count}[{string.Join(", ", values)}] duplicateKeys=[{string.Join(", ", duplicateKeySummary)}] duplicateStrKeys=[{string.Join(", ", duplicateStrKeySummary)}] probes=[{string.Join(", ", probeSummary)}] focused=[{string.Join(", ", focusedMatches)}]";
        }

        private string ZeroCopyToBase64(object zeroCopy)
        {
            var totalSize = Convert.ToInt32(zeroCopyCalcTotalSize.Invoke(zeroCopy, null), CultureInfo.InvariantCulture);
            if (totalSize <= 0) return "";

            var output = new byte[totalSize];
            var offset = 0;
            foreach (var segment in (IEnumerable)zeroCopyGetView.Invoke(zeroCopy, null)!)
            {
                var segmentType = segment.GetType();
                var data = (byte[])segmentType.GetProperty("Data", BindingFlags.Public | BindingFlags.Instance)!.GetValue(segment)!;
                var length = Convert.ToInt32(segmentType.GetProperty("Offset", BindingFlags.Public | BindingFlags.Instance)!.GetValue(segment), CultureInfo.InvariantCulture);
                Buffer.BlockCopy(data, 0, output, offset, length);
                offset += length;
            }

            return Convert.ToBase64String(output);
        }

        public List<HostPacket> DrainClientPackets(string label)
        {
            var output = new List<HostPacket>();
            var queue = messageQueueField.GetValue(null);
            if (queue == null) return output;

            foreach (var message in ((IEnumerable)queue).Cast<object>().ToList())
            {
                var eventName = messageEventField.GetValue(message)?.ToString() ?? "";
                if (!string.Equals(eventName, "NEM_NKCPACKET_SEND_TO_CLIENT", StringComparison.Ordinal))
                {
                    continue;
                }

                var packet = messageParamField.GetValue(message);
                if (packet == null) continue;
                var packetId = Convert.ToInt32(messageIdField.GetValue(message), CultureInfo.InvariantCulture);
                output.Add(SerializePacket(packet, packetId, label));
            }

            ClearClientQueue();
            return output;
        }

        public void ClearClientQueue()
        {
            var queue = messageQueueField.GetValue(null);
            queue?.GetType().GetMethod("Clear", BindingFlags.Public | BindingFlags.Instance)?.Invoke(queue, null);
        }

        public object? GetField(object target, string fieldName)
        {
            return FindField(target.GetType(), fieldName)?.GetValue(target);
        }

        public void SetField(object target, string fieldName, object? value)
        {
            var field = FindField(target.GetType(), fieldName)
                ?? throw new MissingFieldException(target.GetType().FullName, fieldName);
            field.SetValue(target, ConvertForField(value, field.FieldType));
        }

        private static FieldInfo? FindField(Type type, string fieldName)
        {
            for (var current = type; current != null; current = current.BaseType)
            {
                var field = current.GetField(fieldName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (field != null) return field;
            }

            return null;
        }

        private static MethodInfo? FindMethod(Type type, string methodName, params Type[] parameterTypes)
        {
            for (var current = type; current != null; current = current.BaseType)
            {
                var method = current.GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null, parameterTypes, null);
                if (method != null) return method;
            }

            return null;
        }

        private static MethodInfo? FindMethodByName(Type type, string methodName)
        {
            for (var current = type; current != null; current = current.BaseType)
            {
                var method = current
                    .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    .FirstOrDefault(candidate => string.Equals(candidate.Name, methodName, StringComparison.Ordinal));
                if (method != null) return method;
            }

            return null;
        }

        private static object? ConvertForField(object? value, Type fieldType)
        {
            if (value == null) return null;
            var targetType = Nullable.GetUnderlyingType(fieldType) ?? fieldType;
            if (targetType.IsEnum)
            {
                return value.GetType().IsEnum ? value : Enum.ToObject(targetType, value);
            }
            if (targetType == typeof(float)) return Convert.ToSingle(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(double)) return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(sbyte)) return Convert.ToSByte(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(short)) return Convert.ToInt16(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(int)) return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(long)) return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(bool)) return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
            return value;
        }

        private static Assembly? ResolveManagedAssembly(string managedDir, ResolveEventArgs args)
        {
            var simpleName = new AssemblyName(args.Name).Name;
            if (string.IsNullOrWhiteSpace(simpleName))
            {
                return null;
            }

            var alreadyLoaded = AppDomain.CurrentDomain.GetAssemblies()
                .FirstOrDefault(asm => string.Equals(asm.GetName().Name, simpleName, StringComparison.OrdinalIgnoreCase));
            if (alreadyLoaded != null)
            {
                return alreadyLoaded;
            }

            var candidate = Path.Combine(managedDir, simpleName + ".dll");
            if (!File.Exists(candidate))
            {
                return null;
            }

            return Assembly.LoadFrom(candidate);
        }

        private IntPtr ResolveNativeLibrary(string libraryName, Assembly sourceAssembly, DllImportSearchPath? searchPath)
        {
            var fileNames = NativeLibraryFileNames(libraryName);
            foreach (var directory in nativeSearchDirs)
            {
                foreach (var fileName in fileNames)
                {
                    var candidate = Path.Combine(directory, fileName);
                    if (File.Exists(candidate) && NativeLibrary.TryLoad(candidate, out var handle))
                    {
                        return handle;
                    }
                }
            }

            return IntPtr.Zero;
        }

        private static IReadOnlyList<string> BuildNativeSearchDirs(string managedDir)
        {
            var dataDir = Directory.GetParent(managedDir)?.FullName ?? managedDir;
            var gameDir = Directory.GetParent(dataDir)?.FullName ?? dataDir;
            return new[]
            {
                managedDir,
                Path.Combine(dataDir, "Plugins", "x86_64"),
                Path.Combine(dataDir, "Plugins"),
                dataDir,
                gameDir
            }.Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }

        private static IEnumerable<string> NativeLibraryFileNames(string libraryName)
        {
            yield return libraryName;
            if (!libraryName.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            {
                yield return libraryName + ".dll";
            }
        }

        private static void PrimeNativeSearchPath(IEnumerable<string> nativeSearchDirs)
        {
            foreach (var directory in nativeSearchDirs)
            {
                if (File.Exists(Path.Combine(directory, "lua54.dll")))
                {
                    SetDllDirectory(directory);
                    break;
                }
            }
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool SetDllDirectory(string lpPathName);
    }

    private static long ParseLong(string? value)
    {
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }
}
