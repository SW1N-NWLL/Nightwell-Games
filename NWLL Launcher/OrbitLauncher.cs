using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Net.Http;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class OrbitLauncher
{
    private const string Url = "https://launcher.nightwell.fun";
    private const string AppVersion = "1.0.4";
    private const string UpdateManifestUrl = "https://launcher.nightwell.fun/updates/latest.json";
    private const string MutexName = "Local\\OrbitLauncherDesktopApp";
    private const string PipeName = "OrbitLauncherDesktopAuth";
    private static readonly HttpClient UpdateClient = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 3 && String.Equals(args[0], "--apply-update", StringComparison.Ordinal))
        {
            ApplyUpdate(args[1], args[2]);
            return;
        }
        string callback = args.Length > 0 && args[0].StartsWith("orbitlauncher://auth", StringComparison.OrdinalIgnoreCase) ? args[0] : null;
        bool created;
        using (Mutex mutex = new Mutex(true, MutexName, out created))
        {
            if (!created)
            {
                if (callback != null) ForwardCallback(callback);
                return;
            }

            RegisterProtocol();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            LauncherForm form = new LauncherForm(callback);
            Thread pipeThread = new Thread(form.ListenForCallbacks);
            pipeThread.IsBackground = true;
            pipeThread.Start();
            Application.Run(form);
        }
    }

    private static void ApplyUpdate(string stagedPath, string originalProcessId)
    {
        string targetPath = Application.ExecutablePath;
        string backupPath = targetPath + ".update-backup";
        string replacementPath = targetPath + ".new";
        try
        {
            int processId;
            if (!Int32.TryParse(originalProcessId, out processId)) throw new InvalidOperationException("Не удалось определить запущенный лаунчер.");
            try
            {
                Process original = Process.GetProcessById(processId);
                if (!original.WaitForExit(60000)) throw new TimeoutException("Лаунчер не закрылся за 60 секунд.");
            }
            catch (ArgumentException) { }

            File.Copy(stagedPath, replacementPath, true);
            if (File.Exists(backupPath)) File.Delete(backupPath);
            File.Move(targetPath, backupPath);
            try
            {
                File.Move(replacementPath, targetPath);
                Process.Start(new ProcessStartInfo(targetPath) { UseShellExecute = true });
                Thread.Sleep(2500);
                Process[] running = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(targetPath));
                if (running.Length == 0) throw new InvalidOperationException("Новая версия не запустилась.");
                File.Delete(backupPath);
                foreach (Process process in running) process.Dispose();
                try { File.Delete(stagedPath); } catch { }
            }
            catch
            {
                if (File.Exists(targetPath)) File.Delete(targetPath);
                if (File.Exists(backupPath)) File.Move(backupPath, targetPath);
                throw;
            }
        }
        catch (Exception ex)
        {
            try
            {
                if (!File.Exists(targetPath) && File.Exists(backupPath)) File.Move(backupPath, targetPath);
                if (File.Exists(replacementPath)) File.Delete(replacementPath);
            }
            catch { }
            MessageBox.Show("Не удалось установить обновление. Текущая версия сохранена.\n\n" + ex.Message,
                "Orbit Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            try { Process.Start(new ProcessStartInfo(targetPath) { UseShellExecute = true }); } catch { }
        }
    }

    private static void RegisterProtocol()
    {
        string exe = "\"" + Application.ExecutablePath + "\" \"%1\"";
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey("Software\\Classes\\orbitlauncher"))
        {
            key.SetValue("", "URL:Orbit Launcher Authentication");
            key.SetValue("URL Protocol", "");
            using (RegistryKey command = key.CreateSubKey("shell\\open\\command")) command.SetValue("", exe);
        }
    }

    private static void ForwardCallback(string callback)
    {
        try
        {
            using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
            {
                pipe.Connect(5000);
                byte[] data = Encoding.UTF8.GetBytes(callback + "\n");
                pipe.Write(data, 0, data.Length);
                pipe.Flush();
            }
        }
        catch { }
    }

    private sealed class LauncherForm : Form
    {
        private readonly WebView2 browser = new WebView2();
        private readonly Label updateStatus = new Label();
        private readonly Button updateButton = new Button();
        private readonly Panel updateBar = new Panel();
        private readonly System.Windows.Forms.Timer reconnectTimer = new System.Windows.Forms.Timer();
        private string initialCallback;
        private bool browserReady;
        private bool showingOfflinePage;
        private bool reconnectCheckInProgress;
        private string stagedUpdatePath;
        private string availableVersion;

        public LauncherForm(string callback)
        {
            initialCallback = callback;
            Text = "Orbit Launcher";
            Width = 1280;
            Height = 820;
            MinimumSize = new System.Drawing.Size(800, 560);
            StartPosition = FormStartPosition.CenterScreen;
            browser.Dock = DockStyle.Fill;
            updateBar.Dock = DockStyle.Top;
            updateBar.Height = 38;
            updateBar.Padding = new Padding(12, 3, 8, 3);
            updateBar.BackColor = System.Drawing.Color.FromArgb(30, 25, 40);
            updateStatus.Dock = DockStyle.Fill;
            updateStatus.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
            updateStatus.ForeColor = System.Drawing.Color.Gainsboro;
            updateStatus.Text = "Orbit Launcher • версия " + AppVersion;
            updateButton.Dock = DockStyle.Right;
            updateButton.Width = 190;
            updateButton.Text = "Проверить обновления";
            updateButton.Click += async delegate { await CheckForUpdatesAsync(true); };
            updateBar.Controls.Add(updateStatus);
            updateBar.Controls.Add(updateButton);
            reconnectTimer.Interval = 4000;
            reconnectTimer.Tick += async delegate { await TryReconnectAsync(); };
            Controls.Add(browser);
            Controls.Add(updateBar);
            updateBar.BringToFront();
            Shown += async delegate { await InitializeBrowser(); await CheckForUpdatesAsync(false); };
        }

        private async Task CheckForUpdatesAsync(bool showResult)
        {
            updateButton.Enabled = false;
            updateButton.Text = "Проверяю…";
            try
            {
                string json = await UpdateClient.GetStringAsync(UpdateManifestUrl);
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                var manifest = serializer.Deserialize<Dictionary<string, object>>(json);
                object versionValue, urlValue, hashValue, notesValue;
                if (manifest == null || !manifest.TryGetValue("version", out versionValue) ||
                    !manifest.TryGetValue("downloadUrl", out urlValue) || !manifest.TryGetValue("sha256", out hashValue))
                    throw new InvalidDataException("В манифесте обновления не хватает обязательных полей.");

                Version latest, current;
                string version = Convert.ToString(versionValue);
                string downloadUrl = Convert.ToString(urlValue);
                string expectedHash = Convert.ToString(hashValue);
                if (!Version.TryParse(version, out latest) || !Version.TryParse(AppVersion, out current))
                    throw new InvalidDataException("В манифесте указана некорректная версия.");
                if (latest <= current)
                {
                    availableVersion = null;
                    updateStatus.Text = "Orbit Launcher • версия " + AppVersion + " — установлена последняя версия";
                    updateButton.Text = "Проверить обновления";
                    if (showResult) MessageBox.Show("У вас установлена последняя версия Orbit Launcher.", "Orbit Launcher", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                Uri downloadUri;
                if (!Uri.TryCreate(downloadUrl, UriKind.Absolute, out downloadUri) || downloadUri.Scheme != Uri.UriSchemeHttps ||
                    !downloadUri.Host.Equals("launcher.nightwell.fun", StringComparison.OrdinalIgnoreCase) ||
                    expectedHash == null || expectedHash.Length != 64 || !IsHex(expectedHash))
                    throw new InvalidDataException("Проверьте HTTPS-ссылку и SHA-256 в latest.json.");

                availableVersion = version;
                string notes = manifest.TryGetValue("releaseNotes", out notesValue) ? Convert.ToString(notesValue) : null;
                updateStatus.Text = "Доступно обновление " + version + (String.IsNullOrWhiteSpace(notes) ? String.Empty : " • " + notes);
                updateButton.Text = "Обновить до " + version;
                if (showResult && MessageBox.Show("Доступна версия " + version + ".\n\n" + (notes ?? "") + "\n\nСкачать и установить сейчас?",
                    "Обновление Orbit Launcher", MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                    await DownloadAndInstallUpdateAsync(downloadUri, version, expectedHash);
            }
            catch (Exception ex)
            {
                updateStatus.Text = "Не удалось проверить обновления";
                updateButton.Text = "Повторить проверку";
                if (showResult) MessageBox.Show("Не удалось проверить обновления.\n\n" + ex.Message, "Orbit Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally { updateButton.Enabled = true; }
        }

        private async Task DownloadAndInstallUpdateAsync(Uri downloadUri, string version, string expectedHash)
        {
            updateButton.Enabled = false;
            updateButton.Text = "Скачиваю…";
            string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Orbit Launcher", "Updates");
            string staged = Path.Combine(directory, "OrbitLauncher-" + version + ".exe");
            string partial = staged + ".download";
            try
            {
                Directory.CreateDirectory(directory);
                using (HttpResponseMessage response = await UpdateClient.GetAsync(downloadUri, HttpCompletionOption.ResponseHeadersRead))
                {
                    response.EnsureSuccessStatusCode();
                    if (response.Content.Headers.ContentType != null && response.Content.Headers.ContentType.MediaType == "text/html")
                        throw new InvalidDataException("Сервер вернул веб-страницу вместо файла обновления.");
                    using (Stream input = await response.Content.ReadAsStreamAsync())
                    using (FileStream output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None))
                        await input.CopyToAsync(output);
                }
                using (SHA256 sha = SHA256.Create())
                using (FileStream file = File.OpenRead(partial))
                {
                    string actual = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", String.Empty);
                    if (!actual.Equals(expectedHash, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("SHA-256 файла обновления не совпадает с манифестом.");
                }
                File.Delete(staged);
                File.Move(partial, staged);
                stagedUpdatePath = staged;
                string arguments = "--apply-update \"" + staged + "\" " + Process.GetCurrentProcess().Id;
                Process.Start(new ProcessStartInfo(Application.ExecutablePath, arguments) { UseShellExecute = true });
                Close();
            }
            catch (Exception ex)
            {
                try { if (File.Exists(partial)) File.Delete(partial); } catch { }
                updateStatus.Text = "Не удалось скачать обновление";
                updateButton.Text = "Повторить";
                updateButton.Enabled = true;
                MessageBox.Show("Не удалось скачать обновление.\n\n" + ex.Message, "Orbit Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static bool IsHex(string value)
        {
            foreach (char c in value) if (!Uri.IsHexDigit(c)) return false;
            return true;
        }

        private async Task InitializeBrowser()
        {
            try
            {
                await browser.EnsureCoreWebView2Async();
                browser.CoreWebView2.NavigationStarting += OnNavigationStarting;
                browser.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
                browser.CoreWebView2.Settings.IsWebMessageEnabled = true;
                browser.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                browserReady = true;
                if (initialCallback != null) NavigateToExchange(initialCallback);
                else browser.CoreWebView2.Navigate(Url);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Не удалось запустить встроенное окно лаунчера. Установи Microsoft Edge WebView2 Runtime и попробуй снова.\n\n" + ex.Message,
                    "Orbit Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (showingOfflinePage) return;
            if (!e.IsSuccess)
            {
                showingOfflinePage = true;
                updateBar.Visible = false;
                browser.CoreWebView2.NavigateToString(OfflineHtml);
                reconnectTimer.Start();
            }
            else initialCallback = null;
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Uri source;
            if (!Uri.TryCreate(e.Source, UriKind.Absolute, out source) ||
                source.Scheme != Uri.UriSchemeHttps || !source.Host.Equals("launcher.nightwell.fun", StringComparison.OrdinalIgnoreCase)) return;
            string message;
            try { message = e.TryGetWebMessageAsString(); } catch { return; }
            if (message == "offline") updateBar.Visible = false;
            else if (message == "online") updateBar.Visible = true;
            else
            {
                try
                {
                    Dictionary<string, object> payload = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(message);
                    object type;
                    if (payload != null && payload.TryGetValue("type", out type) && Convert.ToString(type) == "install-package")
                        InstallPackageAsync(payload);
                }
                catch { }
            }
        }

        private async void InstallPackageAsync(Dictionary<string, object> payload)
        {
            string partial = null;
            try
            {
                object urlValue, hashValue, extensionValue, argsValue;
                if (!payload.TryGetValue("url", out urlValue) || !payload.TryGetValue("sha256", out hashValue) ||
                    !payload.TryGetValue("extension", out extensionValue) || !payload.TryGetValue("silentArgs", out argsValue))
                    throw new InvalidDataException("В карточке установщика не хватает данных.");
                Uri packageUri;
                if (!Uri.TryCreate(new Uri(Url + "/"), Convert.ToString(urlValue), out packageUri) ||
                    packageUri.Scheme != Uri.UriSchemeHttps || !packageUri.Host.Equals("launcher.nightwell.fun", StringComparison.OrdinalIgnoreCase) ||
                    !packageUri.AbsolutePath.StartsWith("/installers/", StringComparison.Ordinal))
                    throw new InvalidDataException("Разрешены только установщики с launcher.nightwell.fun.");

                string extension = Convert.ToString(extensionValue).ToLowerInvariant();
                if (extension != "exe" && extension != "msi") throw new InvalidDataException("Поддерживаются только EXE и MSI установщики.");
                string expectedHash = Convert.ToString(hashValue).ToUpperInvariant();
                if (expectedHash.Length != 64) throw new InvalidDataException("Некорректная контрольная сумма установщика.");
                foreach (char c in expectedHash) if (!Uri.IsHexDigit(c)) throw new InvalidDataException("Некорректная контрольная сумма установщика.");
                string silentArgs = Convert.ToString(argsValue) ?? String.Empty;
                if (extension == "exe" && String.IsNullOrWhiteSpace(silentArgs))
                    throw new InvalidDataException("Для тихой установки EXE укажите параметры в файле .install.json.");
                if (silentArgs.Length > 512) throw new InvalidDataException("Слишком длинная команда тихой установки.");

                string fileName = Uri.UnescapeDataString(packageUri.AbsolutePath.Substring("/installers/".Length));
                if (String.IsNullOrWhiteSpace(fileName) || Path.GetFileName(fileName) != fileName ||
                    !Path.GetExtension(fileName).Equals("." + extension, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Некорректное имя файла установщика.");

                string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Orbit Launcher", "Installers");
                Directory.CreateDirectory(directory);
                string staged = Path.Combine(directory, fileName);
                partial = staged + ".download";
                PostInstallerStatus("Скачиваем " + fileName + "…");
                using (HttpResponseMessage response = await UpdateClient.GetAsync(packageUri, HttpCompletionOption.ResponseHeadersRead))
                {
                    response.EnsureSuccessStatusCode();
                    if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value > 2147483648L)
                        throw new InvalidDataException("Установщик больше допустимого размера 2 ГБ.");
                    using (Stream input = await response.Content.ReadAsStreamAsync())
                    using (FileStream output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
                        await input.CopyToAsync(output);
                }
                string actualHash;
                using (SHA256 sha = SHA256.Create())
                using (FileStream input = File.OpenRead(partial))
                    actualHash = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", String.Empty);
                if (!actualHash.Equals(expectedHash, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Контрольная сумма не совпала. Установщик не будет запущен.");

                if (File.Exists(staged)) File.Delete(staged);
                File.Move(partial, staged);
                partial = null;
                ProcessStartInfo startInfo;
                if (extension == "msi")
                    startInfo = new ProcessStartInfo("msiexec.exe", "/i \"" + staged + "\" /qn /norestart");
                else
                    startInfo = new ProcessStartInfo(staged, silentArgs);
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process process = Process.Start(startInfo))
                {
                    if (process == null) throw new InvalidOperationException("Не удалось запустить тихую установку.");
                    PostInstallerStatus("Устанавливаем " + fileName + "…");
                    await Task.Run(delegate { process.WaitForExit(); return process.ExitCode; });
                    if (process.ExitCode != 0 && process.ExitCode != 3010 && process.ExitCode != 1641)
                        throw new InvalidOperationException("Установщик завершился с кодом " + process.ExitCode + ". Проверьте, что параметры тихой установки указаны правильно.");
                }
                PostInstallerStatus("Установка завершена: " + fileName);
            }
            catch (Exception ex)
            {
                PostInstallerStatus("Не удалось установить приложение: " + ex.Message);
            }
            finally
            {
                try { if (partial != null && File.Exists(partial)) File.Delete(partial); } catch { }
            }
        }

        private void PostInstallerStatus(string message)
        {
            if (!browserReady || browser.CoreWebView2 == null || IsDisposed) return;
            string detail = new JavaScriptSerializer().Serialize(message);
            browser.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new CustomEvent('orbit-install-status',{detail:" + detail + "}));");
        }

        private async Task TryReconnectAsync()
        {
            if (!showingOfflinePage || reconnectCheckInProgress) return;
            reconnectCheckInProgress = true;
            try
            {
                using (CancellationTokenSource timeout = new CancellationTokenSource(5000))
                using (HttpResponseMessage response = await UpdateClient.GetAsync(Url + "/api/me?network-check=" + DateTime.UtcNow.Ticks, timeout.Token))
                {
                    if (!response.IsSuccessStatusCode) return;
                }

                showingOfflinePage = false;
                reconnectTimer.Stop();
                updateBar.Visible = true;
                string callback = initialCallback;
                initialCallback = null;
                if (!String.IsNullOrEmpty(callback)) NavigateToExchange(callback);
                else browser.CoreWebView2.Navigate(Url);
            }
            catch { }
            finally { reconnectCheckInProgress = false; }
        }

        private const string OfflineHtml = @"<!doctype html><html lang='ru'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:grid;place-items:center;background:radial-gradient(ellipse at 50% 42%,#211a32,#111116 48%,#090a0d);color:#f0eef5;font:14px 'Segoe UI',sans-serif;text-align:center}.card{width:min(440px,calc(100% - 40px));padding:42px 32px 38px;border:1px solid #ffffff1a;border-radius:24px;background:linear-gradient(145deg,#ffffff0c,#ffffff04);box-shadow:inset 0 1px 0 #ffffff12,0 26px 80px #0008}.icon{display:grid;place-items:center;width:76px;height:76px;margin:0 auto 22px;border:1px solid #a986ff38;border-radius:25px;color:#c0a8ff;background:#a986ff14}.icon svg{width:42px;height:42px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.brand{color:#ae94ff;font-weight:800;font-size:10px;letter-spacing:2.4px}h1{margin:12px 0 10px;font-size:27px;line-height:1.2}p{max-width:330px;margin:0 auto;color:#a6a3ae;font-size:13px;line-height:1.65}.progress{width:min(210px,80%);height:3px;margin:29px auto 0;overflow:hidden;border-radius:99px;background:#ffffff12}.progress i{display:block;width:38%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#815aff,#c5a8ff);box-shadow:0 0 14px #a986ff88;animation:move 1.5s ease-in-out infinite}@keyframes move{from{transform:translateX(-110%)}to{transform:translateX(270%)}}
</style></head><body><main class='card'><div class='icon'><svg viewBox='0 0 48 48'><path d='M7 18.5a26 26 0 0 1 34 0M13 25a17 17 0 0 1 22 0M19.5 31.5a8 8 0 0 1 9 0M24 38h.01M8 8l32 32'/></svg></div><div class='brand'>ORBIT</div><h1>Нет подключения к интернету</h1><p>Проверяем соединение. Лаунчер загрузится автоматически, когда сеть восстановится.</p><div class='progress'><i></i></div></main></body></html>";

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            Uri target;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target)) return;
            if (target.Scheme == "https" && target.Host.Equals("launcher.nightwell.fun", StringComparison.OrdinalIgnoreCase) &&
                (target.AbsolutePath == "/auth/google" || target.AbsolutePath == "/auth/discord"))
            {
                e.Cancel = true;
                string external = target.GetLeftPart(UriPartial.Path) + "?desktop=1";
                if (!String.IsNullOrEmpty(target.Query) && target.Query != "?") external += "&" + target.Query.TrimStart('?');
                Process.Start(new ProcessStartInfo(external) { UseShellExecute = true });
            }
            else if (target.Scheme == "orbitlauncher")
            {
                e.Cancel = true;
                NavigateToExchange(e.Uri);
            }
            else if (target.Scheme != "https" && target.Scheme != "http" && target.Scheme != "about")
            {
                e.Cancel = true;
            }
        }

        public void ListenForCallbacks()
        {
            while (!IsDisposed)
            {
                try
                {
                    using (NamedPipeServerStream pipe = new NamedPipeServerStream(PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.None))
                    {
                        pipe.WaitForConnection();
                        using (StreamReader reader = new StreamReader(pipe, Encoding.UTF8))
                        {
                            string callback = reader.ReadLine();
                            if (!String.IsNullOrEmpty(callback))
                                BeginInvoke(new Action(delegate { NavigateToExchange(callback); }));
                        }
                    }
                }
                catch (ObjectDisposedException) { return; }
                catch (InvalidOperationException) { return; }
                catch { Thread.Sleep(250); }
            }
        }

        private void NavigateToExchange(string callback)
        {
            if (!browserReady) { initialCallback = callback; return; }
            Uri uri;
            if (!Uri.TryCreate(callback, UriKind.Absolute, out uri) || uri.Scheme != "orbitlauncher") return;
            string ticket = System.Web.HttpUtility.ParseQueryString(uri.Query).Get("ticket");
            if (String.IsNullOrEmpty(ticket)) return;
            initialCallback = callback;
            browser.CoreWebView2.Navigate(Url + "/auth/desktop/exchange?ticket=" + Uri.EscapeDataString(ticket));
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }
    }
}
