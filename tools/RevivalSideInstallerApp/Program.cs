using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using Avalonia.Styling;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;

namespace RevivalSideInstaller;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    private static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<SetupApp>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}

internal sealed class SetupApp : Application
{
    public override void Initialize()
    {
        Styles.Add(new FluentTheme());
        RequestedThemeVariant = ThemeVariant.Dark;
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.MainWindow = new InstallerWindow();
        }
        base.OnFrameworkInitializationCompleted();
    }
}

internal sealed class InstallerWindow : Window
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private readonly string localPayloadRoot = Path.Combine(AppContext.BaseDirectory, "payload");
    private string payloadRoot = Path.Combine(AppContext.BaseDirectory, "payload");
    private readonly Bitmap? backgroundImage;
    private readonly string backgroundName;

    private readonly TextBox targetBox = new() { MinWidth = 360 };
    private readonly Button browseButton = new() { Content = "Browse", MinWidth = 96, Height = 36 };
    private readonly Button installButton = new() { Content = "Install", MinWidth = 150, Height = 46 };
    private readonly Button launchButton = new() { Content = "Launch", MinWidth = 108, Height = 38, IsEnabled = false };
    private readonly ProgressBar progress = new() { Height = 7, Minimum = 0, Maximum = 100, Value = 0 };
    private readonly TextBlock statusText = new() { Text = "Ready" };
    private readonly TextBlock architectureText = new();
    private readonly TextBlock payloadText = new();
    private readonly TextBlock gameplayText = new() { Text = "Not checked" };
    private readonly TextBox logBox = new()
    {
        AcceptsReturn = true,
        IsReadOnly = true,
        TextWrapping = TextWrapping.NoWrap,
    };

    public InstallerWindow()
    {
        (backgroundImage, backgroundName) = LoadRandomCutsceneBackground(Path.Combine(localPayloadRoot, "app"));
        Title = "RevivalSide Setup";
        Width = 940;
        Height = 620;
        MinWidth = 760;
        MinHeight = 520;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = Brushes.Black;

        targetBox.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevivalSide");
        architectureText.Text = GetWindowsRid();
        payloadText.Text = Directory.Exists(payloadRoot) ? "Detected" : "Missing";
        Content = BuildUi();
        BindEvents();

        AppendLog($"Detected: {GetWindowsRid()}");
        AppendLog($"Payload: {localPayloadRoot}");
        CheckPayloadSummary();
    }

    private Control BuildUi()
    {
        StyleControls();

        var root = new Grid();
        if (backgroundImage != null)
        {
            root.Children.Add(new Image { Source = backgroundImage, Stretch = Stretch.UniformToFill });
        }
        else
        {
            root.Children.Add(new Border { Background = DiagonalGradient(Color.FromRgb(12, 18, 30), Color.FromRgb(55, 38, 58)) });
        }
        root.Children.Add(new Border { Background = HorizontalGradient(Color.FromArgb(236, 5, 8, 14), Color.FromArgb(132, 5, 8, 14)) });
        root.Children.Add(new Border { Background = VerticalGradient(Color.FromArgb(0, 5, 8, 14), Color.FromArgb(236, 5, 8, 14)), VerticalAlignment = VerticalAlignment.Bottom, Height = 240 });

        var shell = new Grid
        {
            Margin = new Thickness(24, 20, 24, 24),
            MaxWidth = 980,
            HorizontalAlignment = HorizontalAlignment.Center,
            RowDefinitions = new RowDefinitions("Auto,*"),
        };
        shell.Children.Add(BuildHeader());

        var body = new Grid { Margin = new Thickness(0, 18, 0, 0) };
        Grid.SetRow(body, 1);
        body.Children.Add(BuildInstallCard());
        shell.Children.Add(body);
        root.Children.Add(shell);
        return root;
    }

    private Control BuildHeader()
    {
        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var brand = new StackPanel { Spacing = 3 };
        brand.Children.Add(new TextBlock
        {
            Text = "RevivalSide Setup",
            Foreground = Brushes.White,
            FontSize = 34,
            FontWeight = FontWeight.SemiBold,
            LineHeight = 40,
        });
        brand.Children.Add(new TextBlock
        {
            Text = "Install the launcher and local listener runtime",
            Foreground = Brush(232, 238, 246),
            FontSize = 15,
        });
        brand.Children.Add(new TextBlock
        {
            Text = string.IsNullOrWhiteSpace(backgroundName) ? "Story background unavailable" : $"Story background: {backgroundName}",
            Foreground = Brush(184, 196, 214),
            FontSize = 12,
            Margin = new Thickness(0, 4, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        header.Children.Add(brand);

        var status = new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(190, 10, 14, 22)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(128, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(18),
            Padding = new Thickness(16, 8),
            VerticalAlignment = VerticalAlignment.Top,
            Child = statusText,
        };
        statusText.FontSize = 14;
        statusText.FontWeight = FontWeight.SemiBold;
        statusText.Foreground = Brush(255, 218, 76);
        Grid.SetColumn(status, 1);
        header.Children.Add(status);
        return header;
    }

    private Control BuildInstallCard()
    {
        var card = Glass(new Thickness(22), new Thickness(0), Color.FromArgb(216, 9, 13, 21));
        var layout = new Grid
        {
            RowDefinitions = new RowDefinitions("Auto,Auto,Auto,Auto,Auto,*"),
        };

        var titleRow = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        titleRow.Children.Add(Eyebrow("Install"));
        var note = new TextBlock
        {
            Text = "Existing profiles and local settings are preserved.",
            Foreground = Brush(194, 206, 224),
            FontSize = 13,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        Grid.SetColumn(note, 1);
        titleRow.Children.Add(note);
        AddRow(layout, titleRow, 0);
        AddRow(layout, BuildPackageStrip(), 1);

        var pathRow = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("*,Auto"),
            Margin = new Thickness(0, 18, 0, 12),
        };
        pathRow.Children.Add(targetBox);
        browseButton.Margin = new Thickness(8, 0, 0, 0);
        Grid.SetColumn(browseButton, 1);
        pathRow.Children.Add(browseButton);
        AddRow(layout, pathRow, 2);

        var buttonRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 10,
            Margin = new Thickness(0, 0, 0, 14),
        };
        buttonRow.Children.Add(installButton);
        buttonRow.Children.Add(launchButton);
        AddRow(layout, buttonRow, 3);
        AddRow(layout, progress, 4);

        var logCard = Glass(new Thickness(12), new Thickness(0, 16, 0, 0), Color.FromArgb(170, 5, 8, 13));
        logCard.Child = Scrollable(logBox);
        AddRow(layout, logCard, 5);

        card.Child = layout;
        return card;
    }

    private Control BuildPackageStrip()
    {
        var strip = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("*,*,*"),
            ColumnSpacing = 10,
            Margin = new Thickness(0, 8, 0, 0),
        };
        var architecture = InfoChip("Architecture", architectureText);
        var payload = InfoChip("Payload", payloadText);
        var gameplay = InfoChip("Gameplay Data", gameplayText);
        strip.Children.Add(architecture);
        Grid.SetColumn(payload, 1);
        strip.Children.Add(payload);
        Grid.SetColumn(gameplay, 2);
        strip.Children.Add(gameplay);
        return strip;
    }

    private static Control InfoChip(string label, TextBlock value)
    {
        value.Foreground = Brush(235, 242, 248);
        value.FontSize = 14;
        value.FontWeight = FontWeight.SemiBold;
        value.TextWrapping = TextWrapping.NoWrap;
        value.TextTrimming = TextTrimming.CharacterEllipsis;

        var layout = new StackPanel { Spacing = 3 };
        layout.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Brush(166, 180, 200),
            FontSize = 11,
            FontWeight = FontWeight.Bold,
        });
        layout.Children.Add(value);

        return new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(126, 12, 17, 26)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(72, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(14, 10),
            MinHeight = 58,
            Child = layout,
        };
    }

    private void StyleControls()
    {
        StyleButton(browseButton);
        StyleButton(launchButton);
        StyleButton(installButton, primary: true);
        targetBox.Background = Brush(16, 21, 30);
        targetBox.Foreground = Brush(235, 242, 248);
        targetBox.BorderBrush = new SolidColorBrush(Color.FromArgb(126, 170, 186, 210));
        targetBox.FontSize = 14;
        targetBox.Height = 36;
        targetBox.VerticalContentAlignment = VerticalAlignment.Center;
        targetBox.TextWrapping = TextWrapping.NoWrap;

        logBox.Background = Brush(6, 9, 14);
        logBox.Foreground = Brush(218, 228, 240);
        logBox.FontFamily = "Cascadia Code, Consolas";
        logBox.FontSize = 12;
        logBox.BorderThickness = new Thickness(0);

        progress.Foreground = Brush(255, 218, 76);
        progress.Background = new SolidColorBrush(Color.FromArgb(120, 255, 255, 255));
    }

    private static void StyleButton(Button button, bool primary = false)
    {
        button.Background = primary ? Brush(255, 218, 76) : Brush(34, 42, 56);
        button.Foreground = primary ? Brush(18, 22, 28) : Brush(238, 243, 248);
        button.BorderBrush = primary ? Brush(255, 231, 132) : Brush(92, 106, 128);
        button.BorderThickness = new Thickness(1);
        button.CornerRadius = new CornerRadius(primary ? 12 : 5);
        button.Padding = primary ? new Thickness(24, 9) : new Thickness(16, 7);
        button.FontSize = primary ? 15 : 13;
        button.FontWeight = FontWeight.SemiBold;
        button.HorizontalContentAlignment = HorizontalAlignment.Center;
        button.VerticalContentAlignment = VerticalAlignment.Center;
    }

    private void BindEvents()
    {
        browseButton.Click += async (_, _) => await BrowseTargetAsync();
        installButton.Click += async (_, _) => await InstallAsync();
        launchButton.Click += (_, _) => LaunchInstalled();
    }

    private async Task BrowseTargetAsync()
    {
        var topLevel = GetTopLevel(this);
        if (topLevel == null) return;
        var folders = await topLevel.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "Choose RevivalSide install folder",
            AllowMultiple = false,
            SuggestedStartLocation = await GetSuggestedStartLocationAsync(topLevel),
        });
        var path = folders.FirstOrDefault()?.TryGetLocalPath();
        if (!string.IsNullOrWhiteSpace(path)) targetBox.Text = path;
    }

    private async Task<IStorageFolder?> GetSuggestedStartLocationAsync(TopLevel topLevel)
    {
        var target = targetBox.Text ?? "";
        var initial = Directory.Exists(target)
            ? target
            : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        try { return await topLevel.StorageProvider.TryGetFolderFromPathAsync(initial); }
        catch { return null; }
    }

    private async Task InstallAsync()
    {
        installButton.IsEnabled = false;
        launchButton.IsEnabled = false;
        browseButton.IsEnabled = false;
        progress.Value = 0;
        progress.IsIndeterminate = true;
        SetStatus("Installing");

        var target = NormalizeTargetPath(targetBox.Text ?? "");
        try
        {
            payloadRoot = await EnsurePayloadReadyAsync();
            await Task.Run(() => InstallCore(target));
            progress.IsIndeterminate = false;
            progress.Value = 100;
            launchButton.IsEnabled = true;
            SetStatus("Complete");
            AppendLog("Install complete.");
            LaunchInstalled(target);
        }
        catch (Exception ex)
        {
            progress.IsIndeterminate = false;
            progress.Value = 0;
            SetStatus("Error");
            AppendLog($"ERROR: {ex.Message}");
            await ShowMessageAsync("RevivalSide Setup", ex.Message);
        }
        finally
        {
            installButton.IsEnabled = true;
            browseButton.IsEnabled = true;
        }
    }

    private void InstallCore(string target)
    {
        var rid = GetWindowsRid();
        var appPayload = Path.Combine(payloadRoot, "app");
        var runtimePayload = Path.Combine(payloadRoot, "runtime-apps", rid);
        var nodePayload = Path.Combine(payloadRoot, "runtime-node", rid);

        SetStatus("Checking package");
        RequireDirectory(appPayload, "app payload");
        RequireDirectory(runtimePayload, $"runtime payload {rid}");
        RequireDirectory(nodePayload, $"Node runtime for {rid}");
        RequireFile(Path.Combine(nodePayload, "node.exe"), $"node.exe for {rid}");
        RequireFile(Path.Combine(nodePayload, "npm.cmd"), $"npm.cmd for {rid}");
        var payloadGameplayJsons = ValidateGameplayJsons(appPayload, "gameplay JSON payload");
        SetGameplayStatus($"{payloadGameplayJsons.FileCount:N0} files");
        AppendLog($"Gameplay JSON payload: {payloadGameplayJsons.FileCount:N0} files");

        SetStatus("Copying files");
        AppendLog($"Installing {rid} to {target}");
        Directory.CreateDirectory(target);

        CopyDirectory(appPayload, target, preserveUserData: true);
        CopyDirectory(runtimePayload, target, preserveUserData: false);
        CopyDirectory(nodePayload, Path.Combine(target, "runtime", "node"), preserveUserData: false);

        EnsureCleanUserDbSeed(target);
        var installedGameplayJsons = ValidateGameplayJsons(target, "installed gameplay JSONs");
        SetGameplayStatus($"{installedGameplayJsons.FileCount:N0} files");
        AppendLog($"Installed gameplay JSONs: {installedGameplayJsons.FileCount:N0} files");
        CreateDesktopShortcut(target);
    }

    private async Task<string> EnsurePayloadReadyAsync()
    {
        if (IsReleasePayloadReady(localPayloadRoot))
        {
            SetStatus("Using local payload");
            return localPayloadRoot;
        }

        var manifestUrl = ResolveReleaseManifestUrl();
        if (string.IsNullOrWhiteSpace(manifestUrl))
        {
            throw new InvalidOperationException("Payload folder is missing and this setup exe does not include a GitHub release manifest URL.");
        }

        return await DownloadReleasePayloadAsync(manifestUrl);
    }

    private async Task<string> DownloadReleasePayloadAsync(string manifestUrl)
    {
        SetStatus("Fetching manifest");
        progress.IsIndeterminate = true;
        payloadText.Text = "Downloading";
        AppendLog($"Release manifest: {manifestUrl}");

        using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(20) };
        using var manifestResponse = await client.GetAsync(manifestUrl);
        manifestResponse.EnsureSuccessStatusCode();
        var manifestJson = await manifestResponse.Content.ReadAsStringAsync();
        var manifest = JsonSerializer.Deserialize<ReleasePayloadManifest>(manifestJson, JsonOptions)
            ?? throw new InvalidOperationException("Release payload manifest was empty or invalid.");
        manifest.Validate();

        var payloadId = SanitizeFileName(string.IsNullOrWhiteSpace(manifest.PayloadId) ? manifest.ArchiveSha256[..16] : manifest.PayloadId);
        var cacheRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevivalSideSetup", "payload-cache", payloadId);
        var extractedPayloadRoot = Path.Combine(cacheRoot, "extract", "payload");
        if (IsReleasePayloadReady(extractedPayloadRoot))
        {
            SetStatus("Using cached payload");
            payloadText.Text = "Cached";
            AppendLog($"Payload cache: {extractedPayloadRoot}");
            return extractedPayloadRoot;
        }

        Directory.CreateDirectory(cacheRoot);
        var archivePath = Path.Combine(cacheRoot, manifest.ArchiveName);
        await DownloadPayloadChunksAsync(client, new Uri(manifestUrl), manifest, cacheRoot);
        if (ManifestUsesSingleArchiveAsset(manifest))
        {
            AppendLog($"Payload archive cached: {manifest.ArchiveName}");
        }
        else
        {
            await CombinePayloadArchiveAsync(manifest, cacheRoot, archivePath);
        }
        VerifyFileHash(archivePath, manifest.ArchiveSha256, "payload archive");

        SetStatus("Extracting payload");
        progress.IsIndeterminate = true;
        var extractRoot = Path.Combine(cacheRoot, "extract");
        if (Directory.Exists(extractRoot)) Directory.Delete(extractRoot, recursive: true);
        Directory.CreateDirectory(extractRoot);
        ZipFile.ExtractToDirectory(archivePath, extractRoot, overwriteFiles: true);
        if (!IsReleasePayloadReady(extractedPayloadRoot))
        {
            throw new InvalidOperationException("Downloaded payload archive did not contain a valid payload folder.");
        }

        payloadText.Text = "Downloaded";
        AppendLog($"Payload ready: {extractedPayloadRoot}");
        return extractedPayloadRoot;
    }

    private async Task DownloadPayloadChunksAsync(HttpClient client, Uri manifestUri, ReleasePayloadManifest manifest, string cacheRoot)
    {
        progress.IsIndeterminate = false;
        long downloadedBytes = 0;
        var totalBytes = manifest.Chunks.Sum(chunk => chunk.Size);
        for (var index = 0; index < manifest.Chunks.Count; index++)
        {
            var chunk = manifest.Chunks[index];
            var chunkPath = Path.Combine(cacheRoot, chunk.Name);
            if (File.Exists(chunkPath) && HashFile(chunkPath).Equals(chunk.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                downloadedBytes += chunk.Size;
                UpdateDownloadProgress(downloadedBytes, totalBytes);
                AppendLog($"Chunk cached: {chunk.Name}");
                continue;
            }

            SetStatus($"Downloading {index + 1}/{manifest.Chunks.Count}");
            var chunkUri = new Uri(manifestUri, chunk.Name);
            AppendLog($"Downloading {chunk.Name}");
            using var response = await client.GetAsync(chunkUri, HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode();
            await using var source = await response.Content.ReadAsStreamAsync();
            await using var destination = File.Open(chunkPath, FileMode.Create, FileAccess.Write, FileShare.None);
            var buffer = new byte[1024 * 1024];
            int read;
            while ((read = await source.ReadAsync(buffer)) > 0)
            {
                await destination.WriteAsync(buffer.AsMemory(0, read));
                downloadedBytes += read;
                UpdateDownloadProgress(downloadedBytes, totalBytes);
            }
            destination.Close();
            VerifyFileHash(chunkPath, chunk.Sha256, chunk.Name);
        }
    }

    private static bool ManifestUsesSingleArchiveAsset(ReleasePayloadManifest manifest)
    {
        return manifest.Chunks.Count == 1
            && manifest.Chunks[0].Name.Equals(manifest.ArchiveName, StringComparison.OrdinalIgnoreCase);
    }

    private async Task CombinePayloadArchiveAsync(ReleasePayloadManifest manifest, string cacheRoot, string archivePath)
    {
        SetStatus("Combining payload");
        await using var archive = File.Open(archivePath, FileMode.Create, FileAccess.Write, FileShare.None);
        foreach (var chunk in manifest.Chunks)
        {
            var chunkPath = Path.Combine(cacheRoot, chunk.Name);
            await using var source = File.OpenRead(chunkPath);
            await source.CopyToAsync(archive);
        }
    }

    private void UpdateDownloadProgress(long downloadedBytes, long totalBytes)
    {
        if (totalBytes <= 0) return;
        var percent = Math.Clamp((double)downloadedBytes / totalBytes * 100.0, 0, 100);
        Dispatcher.UIThread.Post(() => progress.Value = percent);
    }

    private void CheckPayloadSummary()
    {
        try
        {
            var status = ValidateGameplayJsons(Path.Combine(localPayloadRoot, "app"), "gameplay JSON payload");
            gameplayText.Text = $"{status.FileCount:N0} files";
            payloadText.Text = "Ready";
        }
        catch (Exception ex)
        {
            var releaseUrl = ResolveReleaseManifestUrl();
            payloadText.Text = string.IsNullOrWhiteSpace(releaseUrl) ? "Missing" : "Download";
            gameplayText.Text = string.IsNullOrWhiteSpace(releaseUrl) ? "Not ready" : "On install";
            AppendLog(string.IsNullOrWhiteSpace(releaseUrl) ? $"Payload check: {ex.Message}" : "Payload will download from GitHub release.");
        }
    }

    private void LaunchInstalled()
    {
        LaunchInstalled(NormalizeTargetPath(targetBox.Text ?? ""));
    }

    private void LaunchInstalled(string target)
    {
        var launcher = Path.Combine(target, "RevivalSideLauncher.exe");
        if (!File.Exists(launcher))
        {
            _ = ShowMessageAsync("RevivalSide Setup", "RevivalSideLauncher.exe was not found in the install folder.");
            return;
        }
        Process.Start(new ProcessStartInfo { FileName = launcher, WorkingDirectory = Path.GetDirectoryName(launcher), UseShellExecute = true });
    }

    private void CopyDirectory(string source, string destination, bool preserveUserData)
    {
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, directory);
            if (preserveUserData && ShouldSkipUserDataPath(relative, isDirectory: true)) continue;
            Directory.CreateDirectory(Path.Combine(destination, relative));
        }

        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, file);
            if (preserveUserData && ShouldSkipUserDataPath(relative, isDirectory: false) && File.Exists(Path.Combine(destination, relative))) continue;
            CopyFile(file, Path.Combine(destination, relative));
        }
    }

    private static bool ShouldSkipUserDataPath(string relativePath, bool isDirectory)
    {
        var normalized = relativePath.Replace('\\', '/').Trim('/');
        if (normalized.Length == 0) return false;
        if (isDirectory)
        {
            return normalized is "captures" or "exports" or "logs"
                || normalized.StartsWith("server-data/capture-extracts", StringComparison.OrdinalIgnoreCase)
                || normalized.StartsWith("server-data/users.backups", StringComparison.OrdinalIgnoreCase);
        }

        return normalized is "launcher-settings.json"
            or "server-data/users.json"
            or "server-data/server-time.json"
            || normalized.EndsWith(".pcap", StringComparison.OrdinalIgnoreCase)
            || normalized.EndsWith(".pcapng", StringComparison.OrdinalIgnoreCase);
    }

    private void EnsureCleanUserDbSeed(string target)
    {
        Directory.CreateDirectory(Path.Combine(target, "server-data"));
        var usersPath = Path.Combine(target, "server-data", "users.json");
        if (File.Exists(usersPath)) return;

        var starterPath = Path.Combine(target, "server-data", "starter-users.json");
        if (File.Exists(starterPath))
        {
            File.Copy(starterPath, usersPath, overwrite: false);
            AppendLog("Starter profile seed installed.");
            return;
        }

        File.WriteAllText(usersPath, "{\n  \"schemaVersion\": 1,\n  \"nextUserUid\": \"1000000001\",\n  \"nextFriendCode\": \"10000001\",\n  \"activeUserUid\": \"\",\n  \"users\": {}\n}\n", Encoding.UTF8);
    }

    private void CreateDesktopShortcut(string target)
    {
        try
        {
            var shortcutPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "RevivalSide Launcher.lnk");
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = Path.Combine(target, "RevivalSideLauncher.exe");
            shortcut.WorkingDirectory = target;
            shortcut.IconLocation = Path.Combine(target, "RevivalSideLauncher.exe");
            shortcut.Save();
            AppendLog($"Shortcut: {shortcutPath}");
        }
        catch (Exception ex)
        {
            AppendLog($"Shortcut skipped: {ex.Message}");
        }
    }

    private static void CopyFile(string source, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.Copy(source, destination, overwrite: true);
    }

    private static string NormalizeTargetPath(string value)
    {
        var target = string.IsNullOrWhiteSpace(value)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevivalSide")
            : value;
        return Path.GetFullPath(Environment.ExpandEnvironmentVariables(target.Trim().Trim('"')));
    }

    private string? ResolveReleaseManifestUrl()
    {
        var envUrl = Environment.GetEnvironmentVariable("REVIVALSIDE_RELEASE_MANIFEST_URL");
        if (!string.IsNullOrWhiteSpace(envUrl)) return envUrl.Trim();

        foreach (var fileName in new[] { "RevivalSideSetup.release.json", "release.json" })
        {
            var path = Path.Combine(AppContext.BaseDirectory, fileName);
            if (!File.Exists(path)) continue;
            try
            {
                var config = JsonSerializer.Deserialize<ReleaseInstallerConfig>(File.ReadAllText(path), JsonOptions);
                if (!string.IsNullOrWhiteSpace(config?.ManifestUrl)) return config.ManifestUrl.Trim();
            }
            catch (Exception ex)
            {
                AppendLog($"Release config ignored: {ex.Message}");
            }
        }

        return Assembly.GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => attribute.Key.Equals("RevivalSideReleaseManifestUrl", StringComparison.OrdinalIgnoreCase))
            ?.Value;
    }

    private static bool IsReleasePayloadReady(string root)
    {
        if (!Directory.Exists(root)) return false;
        if (!Directory.Exists(Path.Combine(root, "app"))) return false;
        if (!Directory.Exists(Path.Combine(root, "runtime-apps"))) return false;
        if (!Directory.Exists(Path.Combine(root, "runtime-node"))) return false;
        try
        {
            ValidateGameplayJsons(Path.Combine(root, "app"), "gameplay JSON payload");
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void VerifyFileHash(string path, string expectedSha256, string name)
    {
        var actual = HashFile(path);
        if (!actual.Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"{name} SHA256 mismatch. Expected {expectedSha256}, got {actual}.");
        }
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        var hash = SHA256.HashData(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string SanitizeFileName(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            builder.Append(invalid.Contains(character) ? '-' : character);
        }
        return builder.ToString();
    }

    private static string GetWindowsRid()
    {
        return RuntimeInformation.OSArchitecture switch
        {
            Architecture.Arm64 => "win-arm64",
            Architecture.X86 => "win-x86",
            _ => "win-x64",
        };
    }

    private static void RequireDirectory(string path, string name)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException($"{name} was not found: {path}");
    }

    private static void RequireFile(string path, string name)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"{name} was not found.", path);
    }

    private static GameplayJsonStatus ValidateGameplayJsons(string root, string name)
    {
        var directory = Path.Combine(root, "gameplay-jsons");
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException($"{name} was not found: {directory}");
        var assetbundles = Path.Combine(directory, "Assetbundles");
        var streamingAssets = Path.Combine(directory, "StreamingAssets");
        var defaults = Path.Combine(directory, "new-account-defaults.json");
        if (!Directory.Exists(assetbundles)) throw new DirectoryNotFoundException($"{name} is missing Assetbundles: {assetbundles}");
        if (!Directory.Exists(streamingAssets)) throw new DirectoryNotFoundException($"{name} is missing StreamingAssets: {streamingAssets}");
        if (!File.Exists(defaults)) throw new FileNotFoundException($"{name} is missing new-account-defaults.json.", defaults);

        var fileCount = 0;
        foreach (var _ in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories)) fileCount++;
        if (fileCount < 1000) throw new InvalidOperationException($"{name} looks incomplete: only {fileCount:N0} files were found at {directory}");
        return new GameplayJsonStatus(directory, fileCount);
    }

    private void SetStatus(string text)
    {
        Dispatcher.UIThread.Post(() => statusText.Text = text);
    }

    private void SetGameplayStatus(string text)
    {
        Dispatcher.UIThread.Post(() => gameplayText.Text = text);
    }

    private void AppendLog(string text)
    {
        Dispatcher.UIThread.Post(() =>
        {
            var next = $"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}";
            logBox.Text = (logBox.Text ?? "") + next;
            logBox.CaretIndex = logBox.Text.Length;
        });
    }

    private async Task ShowMessageAsync(string title, string message)
    {
        var ok = new Button { Content = "OK", MinWidth = 92, Height = 36 };
        StyleButton(ok, primary: true);
        var window = new Window
        {
            Title = title,
            Width = 460,
            Height = 220,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = Brush(12, 16, 23),
            Content = new Border
            {
                Padding = new Thickness(22),
                Child = new Grid
                {
                    RowDefinitions = new RowDefinitions("*,Auto"),
                    Children =
                    {
                        new TextBlock { Text = message, Foreground = Brush(236, 242, 248), TextWrapping = TextWrapping.Wrap, FontSize = 15 },
                        ok,
                    },
                },
            },
        };
        Grid.SetRow(ok, 1);
        ok.HorizontalAlignment = HorizontalAlignment.Right;
        ok.Click += (_, _) => window.Close();
        await window.ShowDialog(this);
    }

    private static Border Glass(Thickness padding, Thickness margin, Color? fill = null)
    {
        return new Border
        {
            Padding = padding,
            Margin = margin,
            CornerRadius = new CornerRadius(18),
            Background = new SolidColorBrush(fill ?? Color.FromArgb(204, 12, 16, 23)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(96, 255, 255, 255)),
            BorderThickness = new Thickness(1),
        };
    }

    private static TextBlock Eyebrow(string text) => new()
    {
        Text = text.ToUpperInvariant(),
        Foreground = Brush(255, 218, 87),
        FontSize = 15,
        FontWeight = FontWeight.Bold,
        Margin = new Thickness(0, 0, 0, 8),
    };

    private static ScrollViewer Scrollable(Control child) => new()
    {
        Content = child,
        VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
        HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
    };

    private static void AddRow(Grid grid, Control control, int row)
    {
        Grid.SetRow(control, row);
        grid.Children.Add(control);
    }

    private static (Bitmap? Image, string Name) LoadRandomCutsceneBackground(string appRoot)
    {
        var zipPath = Path.Combine(appRoot, "extracted-assets", "cutscene-bg-16x9.zip");
        if (File.Exists(zipPath))
        {
            try
            {
                using var zip = ZipFile.OpenRead(zipPath);
                var entries = zip.Entries.Where(entry => entry.Length > 100_000 && entry.FullName.EndsWith(".png", StringComparison.OrdinalIgnoreCase)).ToArray();
                if (entries.Length > 0)
                {
                    var entry = entries[Random.Shared.Next(entries.Length)];
                    using var stream = entry.Open();
                    using var memory = new MemoryStream();
                    stream.CopyTo(memory);
                    memory.Position = 0;
                    return (new Bitmap(memory), Path.GetFileNameWithoutExtension(entry.FullName));
                }
            }
            catch
            {
                // Fall through to folder lookup.
            }
        }

        var folder = Path.Combine(appRoot, "extracted-assets", "cutscene-bg-16x9");
        if (Directory.Exists(folder))
        {
            try
            {
                var files = Directory.EnumerateFiles(folder, "*.png", SearchOption.AllDirectories).ToArray();
                if (files.Length > 0)
                {
                    var file = files[Random.Shared.Next(files.Length)];
                    using var stream = File.OpenRead(file);
                    return (new Bitmap(stream), Path.GetFileNameWithoutExtension(file));
                }
            }
            catch
            {
                // Use fallback gradient.
            }
        }

        return (null, "");
    }

    private static IBrush Brush(byte r, byte g, byte b) => new SolidColorBrush(Color.FromRgb(r, g, b));
    private static IBrush DiagonalGradient(Color start, Color end) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(start, 0), new(end, 1) },
    };
    private static IBrush HorizontalGradient(Color left, Color right) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(1, 0, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(left, 0), new(right, 1) },
    };
    private static IBrush VerticalGradient(Color top, Color bottom) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(0, 1, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(top, 0), new(bottom, 1) },
    };
}

internal sealed class ReleaseInstallerConfig
{
    public string ManifestUrl { get; set; } = "";
}

internal sealed class ReleasePayloadManifest
{
    public int SchemaVersion { get; set; } = 1;
    public string PayloadId { get; set; } = "";
    public string ArchiveName { get; set; } = "RevivalSidePayload.zip";
    public long ArchiveSize { get; set; }
    public string ArchiveSha256 { get; set; } = "";
    public List<ReleasePayloadChunk> Chunks { get; set; } = [];

    public void Validate()
    {
        if (SchemaVersion != 1) throw new InvalidOperationException($"Unsupported payload manifest schema version: {SchemaVersion}.");
        if (string.IsNullOrWhiteSpace(ArchiveName)) throw new InvalidOperationException("Payload manifest is missing archiveName.");
        if (string.IsNullOrWhiteSpace(ArchiveSha256) || ArchiveSha256.Length < 16) throw new InvalidOperationException("Payload manifest is missing archiveSha256.");
        if (ArchiveSize <= 0) throw new InvalidOperationException("Payload manifest archiveSize must be positive.");
        if (Chunks.Count == 0) throw new InvalidOperationException("Payload manifest has no chunks.");
        foreach (var chunk in Chunks) chunk.Validate();
    }
}

internal sealed class ReleasePayloadChunk
{
    public string Name { get; set; } = "";
    public long Size { get; set; }
    public string Sha256 { get; set; } = "";

    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(Name)) throw new InvalidOperationException("Payload manifest contains a chunk without a name.");
        if (Name.Contains('/') || Name.Contains('\\')) throw new InvalidOperationException($"Payload chunk name must not contain a path: {Name}");
        if (Size <= 0) throw new InvalidOperationException($"Payload chunk {Name} has an invalid size.");
        if (string.IsNullOrWhiteSpace(Sha256) || Sha256.Length < 16) throw new InvalidOperationException($"Payload chunk {Name} is missing sha256.");
    }
}

internal sealed record GameplayJsonStatus(string Path, int FileCount);
