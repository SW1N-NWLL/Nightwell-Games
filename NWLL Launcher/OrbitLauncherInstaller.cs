using System;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class OrbitLauncherInstaller
{
    private const string AppName = "Orbit Launcher";
    private static readonly string InstallFolder = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);
    private static readonly string[] Files = {
        "OrbitLauncher.exe",
        "Microsoft.Web.WebView2.Core.dll",
        "Microsoft.Web.WebView2.WinForms.dll",
        "WebView2Loader.dll",
        "OrbitLauncherUninstaller.exe"
    };

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new InstallerForm());
    }

    private sealed class InstallerForm : Form
    {
        private readonly CheckBox desktopShortcut = new CheckBox();
        private readonly Button installButton = new Button();
        private readonly Label status = new Label();

        public InstallerForm()
        {
            Text = "Установка Orbit Launcher";
            Width = 470;
            Height = 245;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            Label title = new Label { Left = 24, Top = 22, Width = 410, Height = 34, Text = "Установить Orbit Launcher 1.0.12", Font = new System.Drawing.Font("Segoe UI", 16, System.Drawing.FontStyle.Bold) };
            Label location = new Label { Left = 26, Top = 75, Width = 410, Height = 38, Text = "Приложение будет установлено в:\n" + InstallFolder };
            desktopShortcut.SetBounds(26, 125, 400, 24);
            desktopShortcut.Text = "Создать ярлык на рабочем столе";
            desktopShortcut.Checked = true;
            installButton.SetBounds(300, 165, 130, 34);
            installButton.Text = "Установить";
            installButton.Click += Install;
            status.SetBounds(26, 170, 260, 30);
            Controls.AddRange(new Control[] { title, location, desktopShortcut, installButton, status });
        }

        private void Install(object sender, EventArgs e)
        {
            installButton.Enabled = false;
            status.Text = "Установка…";
            try
            {
                Directory.CreateDirectory(InstallFolder);
                foreach (string file in Files) Extract(file);
                RegisterProtocol();
                CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", AppName + ".lnk"));
                if (desktopShortcut.Checked)
                    CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"));
                RegisterUninstall();
                status.Text = "Готово";
                DialogResult result = MessageBox.Show("Orbit Launcher установлен.", AppName, MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
                if (result == DialogResult.OK)
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(InstallFolder, "OrbitLauncher.exe")) { UseShellExecute = true });
                Close();
            }
            catch (Exception ex)
            {
                installButton.Enabled = true;
                status.Text = "Не удалось установить";
                MessageBox.Show("Ошибка установки:\n\n" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void Extract(string file)
        {
            using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(file))
            {
                if (source == null) throw new InvalidOperationException("В установщике отсутствует файл " + file);
                using (FileStream destination = File.Create(Path.Combine(InstallFolder, file))) source.CopyTo(destination);
            }
        }

        private static void RegisterProtocol()
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey("Software\\Classes\\orbitlauncher"))
            {
                key.SetValue("", "URL:Orbit Launcher Authentication");
                key.SetValue("URL Protocol", "");
                using (RegistryKey command = key.CreateSubKey("shell\\open\\command"))
                    command.SetValue("", "\"" + Path.Combine(InstallFolder, "OrbitLauncher.exe") + "\" \"%1\"");
            }
        }

        private static void RegisterUninstall()
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OrbitLauncher"))
            {
                key.SetValue("DisplayName", AppName);
                key.SetValue("DisplayVersion", "1.0.12");
                key.SetValue("Publisher", "Orbit");
                key.SetValue("InstallLocation", InstallFolder);
                key.SetValue("UninstallString", "\"" + Path.Combine(InstallFolder, "OrbitLauncherUninstaller.exe") + "\"");
            }
        }

        private static void CreateShortcut(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) throw new InvalidOperationException("Не удалось создать ярлык Windows.");
            dynamic shell = Activator.CreateInstance(shellType);
            dynamic shortcut = shell.CreateShortcut(path);
            shortcut.TargetPath = Path.Combine(InstallFolder, "OrbitLauncher.exe");
            shortcut.WorkingDirectory = InstallFolder;
            shortcut.Description = AppName;
            shortcut.IconLocation = Path.Combine(InstallFolder, "OrbitLauncher.exe") + ",0";
            shortcut.Save();
        }
    }
}
