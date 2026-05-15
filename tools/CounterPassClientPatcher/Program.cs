using Mono.Cecil;
using Mono.Cecil.Cil;

LoadDotEnv(ResolveEnvFile(args));

var managedDir = ResolveManagedDir(args);
var assemblyPath = Path.Combine(managedDir, "Assembly-CSharp.dll");
if (!File.Exists(assemblyPath))
{
    Console.Error.WriteLine($"Assembly-CSharp.dll was not found in {managedDir}");
    return 2;
}

var backupPath = assemblyPath + ".revivalside-counterpass.bak";
var options = PatchOptions.Parse(args);

if (options.Status)
{
    return PrintStatus(assemblyPath, backupPath);
}

if (options.Restore)
{
    return RestoreBackup(assemblyPath, backupPath, requireBackup: true);
}

if (options.DisabledByEnv)
{
    Console.WriteLine("[counter-pass-patch] disabled by CS_PATCH_COUNTER_PASS_CLIENT=0");
    return RestoreBackup(assemblyPath, backupPath, requireBackup: false);
}

if (options.RestoreFirst)
{
    var prepared = PrepareOriginalAssembly(assemblyPath, backupPath);
    if (prepared != 0) return prepared;
}
else if (!File.Exists(backupPath))
{
    File.Copy(assemblyPath, backupPath);
    Console.WriteLine($"[counter-pass-patch] backup={backupPath}");
}

var resolver = new DefaultAssemblyResolver();
resolver.AddSearchDirectory(managedDir);
resolver.AddSearchDirectory(Path.GetDirectoryName(typeof(Program).Assembly.Location)!);

var reader = new ReaderParameters
{
    AssemblyResolver = resolver,
    ReadWrite = true,
    InMemory = true,
};

using var module = ModuleDefinition.ReadModule(assemblyPath, reader);
var patches = new List<string>();
if (options.ApplyContentUnlock && PatchCounterPassUnlock(module)) patches.Add("content-unlock");
if (options.ApplyEventPassTimeGate && PatchEventPassTimeGate(module)) patches.Add("event-pass-time-gate");
if (options.ApplyEventPassTempletFallback && PatchEventPassTempletFallback(module)) patches.Add("event-pass-templet-fallback");
if (options.ApplyLobbyEventPassSelfActivation && PatchLobbyEventPassSelfActivation(module)) patches.Add("lobby-event-pass-self-activation");
if (options.ApplyLobbyCounterPassFallbackRegistration && PatchLobbyCounterPassFallbackRegistration(module)) patches.Add("lobby-counter-pass-fallback-registration");
if (options.ApplyLobbyEventPassLayout && PatchLobbyEventPassLayout(module)) patches.Add("lobby-event-pass-layout");
var changed = patches.Count > 0;
if (!changed)
{
    Console.WriteLine("[counter-pass-patch] already patched");
    return 0;
}

module.Write(assemblyPath);
Console.WriteLine($"[counter-pass-patch] patched={assemblyPath} patches={string.Join(",", patches)}");
return 0;

static int PrepareOriginalAssembly(string assemblyPath, string backupPath)
{
    if (File.Exists(backupPath))
    {
        File.Copy(backupPath, assemblyPath, overwrite: true);
        Console.WriteLine($"[counter-pass-patch] restored={assemblyPath} backup={backupPath}");
        return 0;
    }

    File.Copy(assemblyPath, backupPath);
    Console.WriteLine($"[counter-pass-patch] backup={backupPath}");
    return 0;
}

static int RestoreBackup(string assemblyPath, string backupPath, bool requireBackup)
{
    if (!File.Exists(backupPath))
    {
        if (!requireBackup)
        {
            Console.WriteLine("[counter-pass-patch] no backup found; leaving current Assembly-CSharp.dll unchanged");
            return 0;
        }

        Console.Error.WriteLine($"[counter-pass-patch] backup not found: {backupPath}");
        Console.Error.WriteLine("[counter-pass-patch] Verify the game files in Steam to restore a clean Assembly-CSharp.dll.");
        return 2;
    }

    File.Copy(backupPath, assemblyPath, overwrite: true);
    Console.WriteLine($"[counter-pass-patch] restored={assemblyPath} backup={backupPath}");
    return 0;
}

static int PrintStatus(string assemblyPath, string backupPath)
{
    var resolver = new DefaultAssemblyResolver();
    var managedDir = Path.GetDirectoryName(assemblyPath)!;
    resolver.AddSearchDirectory(managedDir);
    resolver.AddSearchDirectory(Path.GetDirectoryName(typeof(Program).Assembly.Location)!);

    using var module = ModuleDefinition.ReadModule(assemblyPath, new ReaderParameters
    {
        AssemblyResolver = resolver,
        InMemory = true,
    });

    Console.WriteLine($"[counter-pass-patch] assembly={assemblyPath}");
    Console.WriteLine($"[counter-pass-patch] backup={(File.Exists(backupPath) ? backupPath : "(missing)")}");
    Console.WriteLine($"[counter-pass-patch] env CS_PATCH_COUNTER_PASS_CLIENT={Environment.GetEnvironmentVariable("CS_PATCH_COUNTER_PASS_CLIENT") ?? "(unset)"}");
    Console.WriteLine($"[counter-pass-patch] content-unlock={HasCounterPassUnlockPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] event-pass-time-gate={HasEventPassTimeGatePatch(module)}");
    Console.WriteLine($"[counter-pass-patch] event-pass-templet-fallback={HasEventPassTempletFallbackPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] lobby-event-pass-self-activation={HasLobbyEventPassSelfActivationPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] lobby-counter-pass-fallback-registration={HasLobbyCounterPassFallbackRegistrationPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] lobby-event-pass-layout={HasLobbyEventPassLayoutPatch(module)}");
    return 0;
}

static string? ResolveEnvFile(string[] args)
{
    for (var index = 0; index < args.Length; index += 1)
    {
        if (args[index] is "--env-file")
        {
            if (index + 1 >= args.Length) throw new ArgumentException($"{args[index]} requires a path.");
            return Path.GetFullPath(args[index + 1]);
        }
    }

    var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
    while (directory != null)
    {
        var candidate = Path.Combine(directory.FullName, ".env");
        if (File.Exists(candidate)) return candidate;
        directory = directory.Parent;
    }
    return null;
}

static void LoadDotEnv(string? filePath)
{
    try
    {
        if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath)) return;
        foreach (var rawLine in File.ReadAllLines(filePath))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
            if (line.StartsWith("export ", StringComparison.Ordinal)) line = line["export ".Length..].Trim();
            var equals = line.IndexOf('=');
            if (equals <= 0) continue;
            var key = line[..equals].Trim();
            if (!IsValidEnvKey(key) || Environment.GetEnvironmentVariable(key) != null) continue;
            var value = line[(equals + 1)..].Trim();
            if (value.Length >= 2 && (value[0] == '"' || value[0] == '\'') && value[^1] == value[0])
            {
                value = value[1..^1];
            }
            else
            {
                var comment = value.IndexOf(" #", StringComparison.Ordinal);
                if (comment >= 0) value = value[..comment].TrimEnd();
            }
            Environment.SetEnvironmentVariable(key, value);
        }
    }
    catch (Exception err)
    {
        Console.WriteLine($"[env] failed to load {filePath}: {err.Message}");
    }
}

static bool IsValidEnvKey(string key)
{
    if (string.IsNullOrWhiteSpace(key)) return false;
    if (!char.IsLetter(key[0]) && key[0] != '_') return false;
    return key.All(ch => char.IsLetterOrDigit(ch) || ch == '_');
}

static bool PatchCounterPassUnlock(ModuleDefinition module)
{
    var contentType = module.Types.FirstOrDefault(type => type.FullName == "NKM.Templet.ContentsType")
        ?? throw new InvalidOperationException("NKM.Templet.ContentsType was not found.");
    var counterPassField = contentType.Fields.FirstOrDefault(field => field.Name == "COUNTER_PASS")
        ?? throw new InvalidOperationException("ContentsType.COUNTER_PASS was not found.");
    var counterPassValue = Convert.ToInt32(counterPassField.Constant);

    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.NKCContentManager")
        ?? throw new InvalidOperationException("NKC.NKCContentManager was not found.");
    var method = type.Methods.FirstOrDefault(item =>
        item.Name == "IsContentsUnlocked"
        && item.HasBody
        && item.Parameters.Count >= 1
        && item.ReturnType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException("NKCContentManager.IsContentsUnlocked was not found.");

    if (HasCounterPassEarlyReturn(method, counterPassValue)) return false;

    var il = method.Body.GetILProcessor();
    var first = method.Body.Instructions.First();
    var continueInstruction = il.Create(OpCodes.Nop);
    il.InsertBefore(first, continueInstruction);
    il.InsertBefore(continueInstruction, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(continueInstruction, CreateLoadInt(il, counterPassValue));
    il.InsertBefore(continueInstruction, il.Create(OpCodes.Bne_Un_S, continueInstruction));
    il.InsertBefore(continueInstruction, il.Create(OpCodes.Ldc_I4_1));
    il.InsertBefore(continueInstruction, il.Create(OpCodes.Ret));
    return true;
}

static bool HasCounterPassEarlyReturn(MethodDefinition method, int counterPassValue)
{
    var instructions = method.Body.Instructions;
    for (var index = 0; index + 4 < Math.Min(instructions.Count, 12); index += 1)
    {
        if (instructions[index].OpCode != OpCodes.Ldarg_0) continue;
        if (!IsLoadInt(instructions[index + 1], counterPassValue)) continue;
        if (instructions[index + 2].OpCode.Code != Code.Bne_Un_S && instructions[index + 2].OpCode.Code != Code.Bne_Un) continue;
        if (instructions[index + 3].OpCode.Code != Code.Ldc_I4_1) continue;
        if (instructions[index + 4].OpCode.Code != Code.Ret) continue;
        return true;
    }
    return false;
}

static bool HasCounterPassUnlockPatch(ModuleDefinition module)
{
    var contentType = module.Types.FirstOrDefault(type => type.FullName == "NKM.Templet.ContentsType");
    var counterPassField = contentType?.Fields.FirstOrDefault(field => field.Name == "COUNTER_PASS");
    if (counterPassField?.Constant == null) return false;

    var counterPassValue = Convert.ToInt32(counterPassField.Constant);
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.NKCContentManager");
    var method = type?.Methods.FirstOrDefault(item =>
        item.Name == "IsContentsUnlocked"
        && item.HasBody
        && item.Parameters.Count >= 1
        && item.ReturnType.MetadataType == MetadataType.Boolean);
    return method != null && HasCounterPassEarlyReturn(method, counterPassValue);
}

static bool PatchEventPassTimeGate(ModuleDefinition module)
{
    var eventPassType = module.Types.FirstOrDefault(type => type.FullName == "NKC.UI.NKCUIEventPass")
        ?? throw new InvalidOperationException("NKC.UI.NKCUIEventPass was not found.");
    var method = eventPassType.Methods.FirstOrDefault(item =>
        item.Name == "IsEventTime"
        && item.HasBody
        && item.Parameters.Count == 1
        && item.ReturnType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException("NKCUIEventPass.IsEventTime was not found.");

    var scenManagerType = module.Types.FirstOrDefault(type => type.FullName == "NKC.NKCScenManager")
        ?? throw new InvalidOperationException("NKC.NKCScenManager was not found.");
    var getScenManager = scenManagerType.Methods.FirstOrDefault(item => item.Name == "GetScenManager" && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCScenManager.GetScenManager was not found.");
    var getEventPassDataManager = scenManagerType.Methods.FirstOrDefault(item => item.Name == "GetEventPassDataManager" && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCScenManager.GetEventPassDataManager was not found.");

    var dataManagerType = module.Types.FirstOrDefault(type => type.FullName == "NKC.NKCEventPassDataManager")
        ?? throw new InvalidOperationException("NKC.NKCEventPassDataManager was not found.");
    var getEventPassId = dataManagerType.Methods.FirstOrDefault(item => item.Name == "get_EventPassId" && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCEventPassDataManager.EventPassId getter was not found.");

    if (IsSimplifiedEventPassTimeGate(method, getEventPassId)) return false;

    method.Body.Instructions.Clear();
    method.Body.ExceptionHandlers.Clear();
    method.Body.Variables.Clear();
    method.Body.InitLocals = false;

    var il = method.Body.GetILProcessor();
    var hasManager = il.Create(OpCodes.Nop);
    il.Append(il.Create(OpCodes.Call, module.ImportReference(getScenManager)));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getEventPassDataManager)));
    il.Append(il.Create(OpCodes.Dup));
    il.Append(il.Create(OpCodes.Brtrue_S, hasManager));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(hasManager);
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getEventPassId)));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Cgt));
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool HasEventPassTimeGatePatch(ModuleDefinition module)
{
    var eventPassType = module.Types.FirstOrDefault(type => type.FullName == "NKC.UI.NKCUIEventPass");
    var method = eventPassType?.Methods.FirstOrDefault(item =>
        item.Name == "IsEventTime"
        && item.HasBody
        && item.Parameters.Count == 1
        && item.ReturnType.MetadataType == MetadataType.Boolean);
    if (method == null) return false;

    return method.Body.Instructions.Count <= 16
        && method.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
            && methodReference.Name == "get_EventPassId")
        && method.Body.Instructions.Any(instruction => instruction.OpCode.Code == Code.Cgt);
}

static bool PatchEventPassTempletFallback(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKM.EventPass.NKMEventPassTemplet")
        ?? throw new InvalidOperationException("NKM.EventPass.NKMEventPassTemplet was not found.");
    var method = type.Methods.FirstOrDefault(item =>
        item.Name == "Find"
        && item.HasBody
        && item.Parameters.Count == 1
        && item.Parameters[0].ParameterType.MetadataType == MetadataType.Int32)
        ?? throw new InvalidOperationException("NKMEventPassTemplet.Find was not found.");
    var fallbackMethod = type.Methods.FirstOrDefault(item =>
        item.Name == "GetPervTemplet"
        && item.Parameters.Count == 1
        && item.Parameters[0].ParameterType.MetadataType == MetadataType.Int32)
        ?? throw new InvalidOperationException("NKMEventPassTemplet.GetPervTemplet was not found.");

    if (method.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference && methodReference.Name == "GetPervTemplet"))
    {
        return false;
    }

    var findReference = method.Body.Instructions
        .Select(instruction => instruction.Operand as MethodReference)
        .FirstOrDefault(methodReference => methodReference != null && methodReference.Name == "Find")
        ?? throw new InvalidOperationException("NKMTempletContainer<NKMEventPassTemplet>.Find call was not found.");

    method.Body.Instructions.Clear();
    method.Body.ExceptionHandlers.Clear();
    method.Body.Variables.Clear();
    method.Body.InitLocals = false;

    var il = method.Body.GetILProcessor();
    var returnInstruction = il.Create(OpCodes.Ret);
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(findReference)));
    il.Append(il.Create(OpCodes.Dup));
    il.Append(il.Create(OpCodes.Brtrue_S, returnInstruction));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ldc_I4, int.MaxValue));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(fallbackMethod)));
    il.Append(returnInstruction);
    return true;
}

static bool HasEventPassTempletFallbackPatch(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKM.EventPass.NKMEventPassTemplet");
    var method = type?.Methods.FirstOrDefault(item =>
        item.Name == "Find"
        && item.HasBody
        && item.Parameters.Count == 1
        && item.Parameters[0].ParameterType.MetadataType == MetadataType.Int32);
    return method?.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == "GetPervTemplet") == true;
}

static bool PatchLobbyEventPassSelfActivation(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass")
        ?? throw new InvalidOperationException("NKC.UI.Lobby.NKCUILobbyMenuEventPass was not found.");
    var method = type.Methods.FirstOrDefault(item => item.Name == "CheckButtonEnable" && item.HasBody && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.CheckButtonEnable was not found.");

    var instructions = method.Body.Instructions;
    var setGameobjectActive = instructions
        .Select(instruction => instruction.Operand as MethodReference)
        .FirstOrDefault(methodReference =>
            methodReference != null
            && methodReference.DeclaringType.FullName == "NKC.NKCUtil"
            && methodReference.Name == "SetGameobjectActive"
            && methodReference.Parameters.Count == 2
            && methodReference.Parameters[0].ParameterType.FullName == "UnityEngine.GameObject"
            && methodReference.Parameters[1].ParameterType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException("NKCUtil.SetGameobjectActive(GameObject,bool) was not found in CheckButtonEnable.");

    var getGameObject = FindMethodReference(module, "UnityEngine.Component", "get_gameObject", 0)
        ?? throw new InvalidOperationException("UnityEngine.Component.get_gameObject was not found.");

    if (instructions.Any(IsGetGameObjectCall)) return false;

    var storeFlag = instructions.FirstOrDefault(instruction => instruction.OpCode.Code is Code.Stloc_0 or Code.Stloc_S or Code.Stloc)
        ?? throw new InvalidOperationException("CheckButtonEnable flag store was not found.");
    var afterStore = storeFlag.Next ?? throw new InvalidOperationException("CheckButtonEnable flag store has no following instruction.");

    var il = method.Body.GetILProcessor();
    il.InsertBefore(afterStore, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(afterStore, il.Create(OpCodes.Call, module.ImportReference(getGameObject)));
    il.InsertBefore(afterStore, il.Create(OpCodes.Ldloc_0));
    il.InsertBefore(afterStore, il.Create(OpCodes.Call, module.ImportReference(setGameobjectActive)));
    return true;

    static bool IsGetGameObjectCall(Instruction instruction)
    {
        return instruction.Operand is MethodReference methodReference
            && methodReference.DeclaringType.FullName == "UnityEngine.Component"
            && methodReference.Name == "get_gameObject";
    }
}

static bool HasLobbyEventPassSelfActivationPatch(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass");
    var method = type?.Methods.FirstOrDefault(item => item.Name == "CheckButtonEnable" && item.HasBody && item.Parameters.Count == 0);
    return method?.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.DeclaringType.FullName == "UnityEngine.Component"
        && methodReference.Name == "get_gameObject") == true;
}

static bool PatchLobbyEventPassLayout(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass")
        ?? throw new InvalidOperationException("NKC.UI.Lobby.NKCUILobbyMenuEventPass was not found.");
    var method = type.Methods.FirstOrDefault(item => item.Name == "CheckButtonEnable" && item.HasBody && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.CheckButtonEnable was not found.");
    var helper = EnsureLobbyEventPassLayoutMethod(module, type);
    if (method.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == helper.Name
        && methodReference.DeclaringType.FullName == type.FullName)) return false;

    var storeFlag = method.Body.Instructions.FirstOrDefault(instruction => instruction.OpCode.Code is Code.Stloc_0 or Code.Stloc_S or Code.Stloc)
        ?? throw new InvalidOperationException("CheckButtonEnable flag store was not found.");
    var afterStore = storeFlag.Next ?? throw new InvalidOperationException("CheckButtonEnable flag store has no following instruction.");
    var il = method.Body.GetILProcessor();
    il.InsertBefore(afterStore, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(afterStore, il.Create(OpCodes.Call, module.ImportReference(helper)));
    return true;
}

static bool HasLobbyEventPassLayoutPatch(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass");
    if (type == null) return false;
    var helper = type.Methods.FirstOrDefault(method => method.Name == "RevivalSideLayoutCounterPassMenu");
    if (helper == null) return false;
    var method = type.Methods.FirstOrDefault(item => item.Name == "CheckButtonEnable" && item.HasBody && item.Parameters.Count == 0);
    return method?.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == helper.Name
        && methodReference.DeclaringType.FullName == type.FullName) == true;
}

static MethodDefinition EnsureLobbyEventPassLayoutMethod(ModuleDefinition module, TypeDefinition eventPassType)
{
    const string methodName = "RevivalSideLayoutCounterPassMenu";
    var existing = eventPassType.Methods.FirstOrDefault(method => method.Name == methodName);
    if (existing != null) return existing;

    var contentTypeField = FindInheritedFieldReference(module, eventPassType, "m_ContentsType");
    var counterPassValue = FindEnumConstant(module, "NKM.Templet.ContentsType", "COUNTER_PASS");
    var getComponent = FindMethodReference(module, "UnityEngine.Component", "GetComponent", 0)
        ?? throw new InvalidOperationException("UnityEngine.Component.GetComponent<T>() was not found.");
    var setAnchorMin = FindMethodReference(module, "UnityEngine.RectTransform", "set_anchorMin", 1)
        ?? throw new InvalidOperationException("RectTransform.set_anchorMin was not found.");
    var setAnchorMax = FindMethodReference(module, "UnityEngine.RectTransform", "set_anchorMax", 1)
        ?? throw new InvalidOperationException("RectTransform.set_anchorMax was not found.");
    var setPivot = FindMethodReference(module, "UnityEngine.RectTransform", "set_pivot", 1)
        ?? throw new InvalidOperationException("RectTransform.set_pivot was not found.");
    var setAnchoredPosition = FindMethodReference(module, "UnityEngine.RectTransform", "set_anchoredPosition", 1)
        ?? throw new InvalidOperationException("RectTransform.set_anchoredPosition was not found.");
    var setLocalScale = FindMethodReference(module, "UnityEngine.Transform", "set_localScale", 1)
        ?? throw new InvalidOperationException("Transform.set_localScale was not found.");
    var setAsLastSibling = FindMethodReference(module, "UnityEngine.Transform", "SetAsLastSibling", 0)
        ?? throw new InvalidOperationException("Transform.SetAsLastSibling was not found.");
    var vector2Ctor = FindConstructorReference(module, "UnityEngine.Vector2", 2)
        ?? throw new InvalidOperationException("Vector2(float,float) constructor was not found.");
    var vector3Ctor = FindConstructorReference(module, "UnityEngine.Vector3", 3)
        ?? throw new InvalidOperationException("Vector3(float,float,float) constructor was not found.");
    var rectTransformType = module.ImportReference(setAnchorMin.DeclaringType);
    var getRectTransform = new GenericInstanceMethod(module.ImportReference(getComponent is GenericInstanceMethod genericMethod
        ? genericMethod.ElementMethod
        : getComponent));
    getRectTransform.GenericArguments.Add(rectTransformType);

    var method = new MethodDefinition(
        methodName,
        MethodAttributes.Private | MethodAttributes.HideBySig,
        module.TypeSystem.Void);
    method.Body.InitLocals = true;
    var rectTransform = new VariableDefinition(rectTransformType);
    method.Body.Variables.Add(rectTransform);

    var il = method.Body.GetILProcessor();
    var layoutStart = il.Create(OpCodes.Nop);
    var ret = il.Create(OpCodes.Ret);

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, contentTypeField));
    il.Append(CreateLoadInt(il, counterPassValue));
    il.Append(il.Create(OpCodes.Beq, layoutStart));
    il.Append(il.Create(OpCodes.Ret));

    il.Append(layoutStart);
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Call, getRectTransform));
    il.Append(il.Create(OpCodes.Stloc, rectTransform));
    var afterNullCheck = il.Create(OpCodes.Nop);
    il.Append(il.Create(OpCodes.Ldloc, rectTransform));
    il.Append(il.Create(OpCodes.Brtrue, afterNullCheck));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(afterNullCheck);

    EmitRectTransformVector2Call(il, rectTransform, setAnchorMin, vector2Ctor, 1f, 1f);
    EmitRectTransformVector2Call(il, rectTransform, setAnchorMax, vector2Ctor, 1f, 1f);
    EmitRectTransformVector2Call(il, rectTransform, setPivot, vector2Ctor, 1f, 1f);
    EmitRectTransformVector2Call(il, rectTransform, setAnchoredPosition, vector2Ctor, -815f, -735f);
    EmitRectTransformVector3Call(il, rectTransform, setLocalScale, vector3Ctor, 0.58f, 0.58f, 1f);
    il.Append(il.Create(OpCodes.Ldloc, rectTransform));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(setAsLastSibling)));
    il.Append(ret);

    eventPassType.Methods.Add(method);
    return method;

    static void EmitRectTransformVector2Call(
        ILProcessor il,
        VariableDefinition rectTransform,
        MethodReference setter,
        MethodReference vector2Ctor,
        float x,
        float y)
    {
        il.Append(il.Create(OpCodes.Ldloc, rectTransform));
        il.Append(il.Create(OpCodes.Ldc_R4, x));
        il.Append(il.Create(OpCodes.Ldc_R4, y));
        il.Append(il.Create(OpCodes.Newobj, vector2Ctor));
        il.Append(il.Create(OpCodes.Callvirt, setter));
    }

    static void EmitRectTransformVector3Call(
        ILProcessor il,
        VariableDefinition rectTransform,
        MethodReference setter,
        MethodReference vector3Ctor,
        float x,
        float y,
        float z)
    {
        il.Append(il.Create(OpCodes.Ldloc, rectTransform));
        il.Append(il.Create(OpCodes.Ldc_R4, x));
        il.Append(il.Create(OpCodes.Ldc_R4, y));
        il.Append(il.Create(OpCodes.Ldc_R4, z));
        il.Append(il.Create(OpCodes.Newobj, vector3Ctor));
        il.Append(il.Create(OpCodes.Callvirt, setter));
    }
}

static bool PatchLobbyCounterPassFallbackRegistration(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyV2")
        ?? throw new InvalidOperationException("NKC.UI.Lobby.NKCUILobbyV2 was not found.");
    var init = type.Methods.FirstOrDefault(item => item.Name == "Init" && item.HasBody && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCUILobbyV2.Init was not found.");
    var resolver = EnsureCounterPassMenuResolver(module, type);
    if (init.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == resolver.Name
        && methodReference.DeclaringType.FullName == type.FullName)) return false;

    var uiEventPassField = type.Fields.FirstOrDefault(field => field.Name == "m_UIEventPass")
        ?? throw new InvalidOperationException("NKCUILobbyV2.m_UIEventPass was not found.");

    var il = init.Body.GetILProcessor();
    var first = init.Body.Instructions.First();
    var skip = il.Create(OpCodes.Nop);
    il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(first, il.Create(OpCodes.Ldfld, module.ImportReference(uiEventPassField)));
    il.InsertBefore(first, il.Create(OpCodes.Brtrue, skip));
    il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(first, il.Create(OpCodes.Call, module.ImportReference(resolver)));
    il.InsertBefore(first, il.Create(OpCodes.Stfld, module.ImportReference(uiEventPassField)));
    il.InsertBefore(first, skip);
    return true;
}

static bool HasLobbyCounterPassFallbackRegistrationPatch(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyV2");
    if (type == null) return false;
    var resolver = type.Methods.FirstOrDefault(method => method.Name == "RevivalSideResolveCounterPassMenu");
    if (resolver == null) return false;
    var init = type.Methods.FirstOrDefault(item => item.Name == "Init" && item.HasBody && item.Parameters.Count == 0);
    return init?.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == resolver.Name
        && methodReference.DeclaringType.FullName == type.FullName) == true;
}

static MethodDefinition EnsureCounterPassMenuResolver(ModuleDefinition module, TypeDefinition lobbyType)
{
    const string methodName = "RevivalSideResolveCounterPassMenu";
    var existing = lobbyType.Methods.FirstOrDefault(method => method.Name == methodName);
    if (existing != null) return existing;

    var eventPassType = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass")
        ?? throw new InvalidOperationException("NKC.UI.Lobby.NKCUILobbyMenuEventPass was not found.");
    var objRootField = eventPassType.Fields.FirstOrDefault(field => field.Name == "m_objRoot")
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.m_objRoot was not found.");
    var objEmptyField = eventPassType.Fields.FirstOrDefault(field => field.Name == "m_objEmpty")
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.m_objEmpty was not found.");
    var buttonField = eventPassType.Fields.FirstOrDefault(field => field.Name == "m_csbtnMenu")
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.m_csbtnMenu was not found.");
    var getComponentsInChildren = FindMethodReference(module, "UnityEngine.Component", "GetComponentsInChildren", 1)
        ?? throw new InvalidOperationException("UnityEngine.Component.GetComponentsInChildren<T>(bool) was not found.");
    var getEventPassComponents = new GenericInstanceMethod(module.ImportReference(getComponentsInChildren is GenericInstanceMethod genericMethod
        ? genericMethod.ElementMethod
        : getComponentsInChildren));
    getEventPassComponents.GenericArguments.Add(module.ImportReference(eventPassType));

    var method = new MethodDefinition(
        methodName,
        MethodAttributes.Private | MethodAttributes.HideBySig,
        module.ImportReference(eventPassType));
    method.Body.InitLocals = true;
    var arrayType = new ArrayType(module.ImportReference(eventPassType));
    var menus = new VariableDefinition(arrayType);
    var index = new VariableDefinition(module.TypeSystem.Int32);
    var candidate = new VariableDefinition(module.ImportReference(eventPassType));
    method.Body.Variables.Add(menus);
    method.Body.Variables.Add(index);
    method.Body.Variables.Add(candidate);

    var il = method.Body.GetILProcessor();
    var menusOk = il.Create(OpCodes.Nop);
    var loopCheck = il.Create(OpCodes.Nop);
    var loopStart = il.Create(OpCodes.Nop);
    var increment = il.Create(OpCodes.Nop);

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Call, getEventPassComponents));
    il.Append(il.Create(OpCodes.Stloc, menus));
    il.Append(il.Create(OpCodes.Ldloc, menus));
    il.Append(il.Create(OpCodes.Brtrue, menusOk));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(menusOk);
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Stloc, index));
    il.Append(il.Create(OpCodes.Br, loopCheck));
    il.Append(loopStart);
    il.Append(il.Create(OpCodes.Ldloc, menus));
    il.Append(il.Create(OpCodes.Ldloc, index));
    il.Append(il.Create(OpCodes.Ldelem_Ref));
    il.Append(il.Create(OpCodes.Stloc, candidate));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Brfalse, increment));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(objRootField)));
    il.Append(il.Create(OpCodes.Brfalse, increment));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(objEmptyField)));
    il.Append(il.Create(OpCodes.Brfalse, increment));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(buttonField)));
    il.Append(il.Create(OpCodes.Brfalse, increment));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(increment);
    il.Append(il.Create(OpCodes.Ldloc, index));
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Add));
    il.Append(il.Create(OpCodes.Stloc, index));
    il.Append(loopCheck);
    il.Append(il.Create(OpCodes.Ldloc, index));
    il.Append(il.Create(OpCodes.Ldloc, menus));
    il.Append(il.Create(OpCodes.Ldlen));
    il.Append(il.Create(OpCodes.Conv_I4));
    il.Append(il.Create(OpCodes.Blt, loopStart));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Ret));

    lobbyType.Methods.Add(method);
    return method;
}

static FieldReference FindInheritedFieldReference(ModuleDefinition module, TypeDefinition type, string fieldName)
{
    TypeDefinition? current = type;
    while (current != null)
    {
        var field = current.Fields.FirstOrDefault(item => item.Name == fieldName);
        if (field != null) return module.ImportReference(field);
        current = current.BaseType?.Resolve();
    }

    throw new InvalidOperationException($"{type.FullName}.{fieldName} was not found.");
}

static int FindEnumConstant(ModuleDefinition module, string typeFullName, string fieldName)
{
    var type = FindTypeDefinition(module, typeFullName)
        ?? throw new InvalidOperationException($"{typeFullName} was not found.");
    var field = type.Fields.FirstOrDefault(item => item.Name == fieldName)
        ?? throw new InvalidOperationException($"{typeFullName}.{fieldName} was not found.");
    if (field.Constant == null) throw new InvalidOperationException($"{typeFullName}.{fieldName} has no constant value.");
    return Convert.ToInt32(field.Constant);
}

static TypeDefinition? FindTypeDefinition(ModuleDefinition module, string typeFullName)
{
    foreach (var type in module.Types)
    {
        var found = FindTypeDefinitionInType(type, typeFullName);
        if (found != null) return found;
    }
    return null;
}

static TypeDefinition? FindTypeDefinitionInType(TypeDefinition type, string typeFullName)
{
    if (type.FullName == typeFullName) return type;
    foreach (var nestedType in type.NestedTypes)
    {
        var found = FindTypeDefinitionInType(nestedType, typeFullName);
        if (found != null) return found;
    }
    return null;
}

static MethodReference? FindMethodReference(ModuleDefinition module, string declaringTypeFullName, string methodName, int parameterCount)
{
    foreach (var type in module.Types)
    {
        var found = FindMethodReferenceInType(type, declaringTypeFullName, methodName, parameterCount);
        if (found != null) return found;
    }
    return null;
}

static MethodReference? FindMethodReferenceInType(TypeDefinition type, string declaringTypeFullName, string methodName, int parameterCount)
{
    foreach (var method in type.Methods)
    {
        if (!method.HasBody) continue;
        foreach (var instruction in method.Body.Instructions)
        {
            if (instruction.Operand is MethodReference methodReference
                && methodReference.DeclaringType.FullName == declaringTypeFullName
                && methodReference.Name == methodName
                && methodReference.Parameters.Count == parameterCount)
            {
                return methodReference;
            }
        }
    }
    foreach (var nestedType in type.NestedTypes)
    {
        var found = FindMethodReferenceInType(nestedType, declaringTypeFullName, methodName, parameterCount);
        if (found != null) return found;
    }
    return null;
}

static MethodReference? FindConstructorReference(ModuleDefinition module, string declaringTypeFullName, int parameterCount)
{
    foreach (var type in module.Types)
    {
        var found = FindConstructorReferenceInType(type, declaringTypeFullName, parameterCount);
        if (found != null) return found;
    }
    return null;
}

static MethodReference? FindConstructorReferenceInType(TypeDefinition type, string declaringTypeFullName, int parameterCount)
{
    foreach (var method in type.Methods)
    {
        if (!method.HasBody) continue;
        foreach (var instruction in method.Body.Instructions)
        {
            if (instruction.Operand is MethodReference methodReference
                && methodReference.DeclaringType.FullName == declaringTypeFullName
                && methodReference.Name == ".ctor"
                && methodReference.Parameters.Count == parameterCount)
            {
                return methodReference;
            }
        }
    }
    foreach (var nestedType in type.NestedTypes)
    {
        var found = FindConstructorReferenceInType(nestedType, declaringTypeFullName, parameterCount);
        if (found != null) return found;
    }
    return null;
}

static bool IsSimplifiedEventPassTimeGate(MethodDefinition method, MethodReference eventPassIdGetter)
{
    var instructions = method.Body.Instructions;
    return instructions.Count <= 16
        && instructions.Any(instruction => instruction.Operand is MethodReference methodReference && methodReference.Name == eventPassIdGetter.Name)
        && instructions.Any(instruction => instruction.OpCode.Code == Code.Cgt);
}

static Instruction CreateLoadInt(ILProcessor il, int value)
{
    return value switch
    {
        -1 => il.Create(OpCodes.Ldc_I4_M1),
        0 => il.Create(OpCodes.Ldc_I4_0),
        1 => il.Create(OpCodes.Ldc_I4_1),
        2 => il.Create(OpCodes.Ldc_I4_2),
        3 => il.Create(OpCodes.Ldc_I4_3),
        4 => il.Create(OpCodes.Ldc_I4_4),
        5 => il.Create(OpCodes.Ldc_I4_5),
        6 => il.Create(OpCodes.Ldc_I4_6),
        7 => il.Create(OpCodes.Ldc_I4_7),
        8 => il.Create(OpCodes.Ldc_I4_8),
        >= sbyte.MinValue and <= sbyte.MaxValue => il.Create(OpCodes.Ldc_I4_S, (sbyte)value),
        _ => il.Create(OpCodes.Ldc_I4, value),
    };
}

static bool IsLoadInt(Instruction instruction, int value)
{
    return instruction.OpCode.Code switch
    {
        Code.Ldc_I4_M1 => value == -1,
        Code.Ldc_I4_0 => value == 0,
        Code.Ldc_I4_1 => value == 1,
        Code.Ldc_I4_2 => value == 2,
        Code.Ldc_I4_3 => value == 3,
        Code.Ldc_I4_4 => value == 4,
        Code.Ldc_I4_5 => value == 5,
        Code.Ldc_I4_6 => value == 6,
        Code.Ldc_I4_7 => value == 7,
        Code.Ldc_I4_8 => value == 8,
        Code.Ldc_I4_S => Convert.ToInt32(instruction.Operand) == value,
        Code.Ldc_I4 => Convert.ToInt32(instruction.Operand) == value,
        _ => false,
    };
}

static string ResolveManagedDir(string[] args)
{
    for (var index = 0; index < args.Length; index += 1)
    {
        if (args[index] is "--managed" or "--managed-dir")
        {
            if (index + 1 >= args.Length) throw new ArgumentException($"{args[index]} requires a path.");
            return Path.GetFullPath(args[index + 1]);
        }
    }

    foreach (var value in new[]
    {
        Environment.GetEnvironmentVariable("CS_COUNTERSIDE_MANAGED_DIR"),
        Environment.GetEnvironmentVariable("COUNTERSIDE_MANAGED_DIR"),
    })
    {
        if (!string.IsNullOrWhiteSpace(value)) return Path.GetFullPath(value);
    }

    foreach (var candidate in new[]
    {
        Path.Combine("C:", "Main", "Gaming", "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
    })
    {
        if (File.Exists(Path.Combine(candidate, "Assembly-CSharp.dll"))) return candidate;
    }

    throw new DirectoryNotFoundException("Could not locate CounterSide Data\\Managed. Pass --managed <path>.");
}

sealed record PatchOptions(
    bool Restore,
    bool RestoreFirst,
    bool Status,
    bool DisabledByEnv,
    bool ApplyContentUnlock,
    bool ApplyEventPassTimeGate,
    bool ApplyEventPassTempletFallback,
    bool ApplyLobbyEventPassSelfActivation,
    bool ApplyLobbyCounterPassFallbackRegistration,
    bool ApplyLobbyEventPassLayout)
{
    public static PatchOptions Parse(string[] args)
    {
        var restore = HasArg(args, "--restore");
        var status = HasArg(args, "--status");
        var envSwitch = HasArg(args, "--env-switch") || HasArg(args, "--from-env");
        var envPatchEnabled = ReadEnvFlag("CS_PATCH_COUNTER_PASS_CLIENT", "CS_COUNTER_PASS_CLIENT_PATCH");
        var legacyAll = HasArg(args, "--legacy-all") || HasArg(args, "--all");
        var disabledByEnv = !restore && !status && envSwitch && envPatchEnabled != true;
        var envDrivenCounterPassPatch = envSwitch && envPatchEnabled == true;
        return new PatchOptions(
            Restore: restore,
            RestoreFirst: !disabledByEnv && !restore && !status && (envSwitch || HasArg(args, "--restore-first") || HasArg(args, "--fresh")),
            Status: status,
            DisabledByEnv: disabledByEnv,
            ApplyContentUnlock: !HasArg(args, "--no-content-unlock"),
            ApplyEventPassTimeGate: !HasArg(args, "--no-time-gate"),
            ApplyEventPassTempletFallback: legacyAll || HasArg(args, "--include-template-fallback"),
            ApplyLobbyEventPassSelfActivation: envDrivenCounterPassPatch || legacyAll || HasArg(args, "--include-lobby-self-activation"),
            ApplyLobbyCounterPassFallbackRegistration: envDrivenCounterPassPatch || legacyAll || HasArg(args, "--include-lobby-fallback"),
            ApplyLobbyEventPassLayout: HasArg(args, "--include-lobby-layout") && !HasArg(args, "--no-lobby-layout"));
    }

    private static bool HasArg(string[] args, string name)
    {
        return args.Any(arg => string.Equals(arg, name, StringComparison.OrdinalIgnoreCase));
    }

    private static bool? ReadEnvFlag(params string[] keys)
    {
        foreach (var key in keys)
        {
            var value = Environment.GetEnvironmentVariable(key);
            if (string.IsNullOrWhiteSpace(value)) continue;
            var normalized = value.Trim().ToLowerInvariant();
            if (normalized is "1" or "true" or "yes" or "on" or "patch" or "enabled") return true;
            if (normalized is "0" or "false" or "no" or "off" or "restore" or "disabled") return false;
        }
        return null;
    }
}
