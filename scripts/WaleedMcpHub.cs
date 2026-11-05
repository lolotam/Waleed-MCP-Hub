using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace WaleedMcpHub
{
    internal static class Launcher
    {
        [STAThread]
        private static int Main(string[] args)
        {
            bool selfTest = args.Length == 1 && args[0] == "--self-test";
            bool known =
                args.Length == 0
                || selfTest
                || (args.Length == 1 && args[0] == "--startup");
            if (!known) return 2;
            try
            {
                string root = AppDomain.CurrentDomain.BaseDirectory;
                string node = Path.Combine(root, "runtime", "node.exe");
                string script = Path.Combine(root, "scripts", "desktop.mjs");
                foreach (string file in new string[] { node, script, Path.Combine(root, "apps", "server", "dist", "main.js"), Path.Combine(root, "apps", "web", "dist", "index.html") })
                    if (!File.Exists(file)) throw new IOException("An application file is missing. Run Waleed-MCP-Hub-Setup.exe again.");
                if (selfTest) return RunSelfTest(root, node);
                Process child = StartNode(root, node, "\"" + script + "\" --attach");
                StringBuilder diagnostic = new StringBuilder();
                TrayContext tray = new TrayContext(root, node, script, child, diagnostic);
                BeginOutput(child, delegate(string line) { AppendDiagnostic(diagnostic, line); }, tray.OnChildOutput);
                Application.Run(tray);
                return tray.ChildExitCode;
            }
            catch (Exception error)
            {
                if (!selfTest) MessageBox.Show(error.Message, "Waleed MCP Hub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static int RunSelfTest(string root, string node)
        {
            using (Process process = StartNode(root, node, "--version"))
            {
                BeginOutput(process, null);
                process.WaitForExit();
                return process.ExitCode;
            }
        }

        internal static Process StartNode(string root, string node, string arguments)
        {
            ProcessStartInfo start = new ProcessStartInfo(node, arguments);
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardError = true;
            start.RedirectStandardOutput = true;
            // Connector subprocesses can find the shipped runtime without a
            // system Node installation or a machine-wide PATH change.
            start.EnvironmentVariables["PATH"] = Path.GetDirectoryName(node) + ";" + (Environment.GetEnvironmentVariable("PATH") ?? "");
            return Process.Start(start);
        }

        // Reading both streams keeps a chatty helper from blocking on a full
        // pipe; the error lines are the only ones the launcher shows.
        internal static void BeginOutput(Process process, Action<string> onError)
        {
            BeginOutput(process, onError, null);
        }

        internal static void BeginOutput(Process process, Action<string> onError, Action<string> onOutput)
        {
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (onOutput != null && e.Data != null) onOutput(e.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (onError != null && e.Data != null) onError(e.Data); };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        internal static void AppendDiagnostic(StringBuilder diagnostic, string line)
        {
            lock (diagnostic)
            {
                if (diagnostic.Length < 8192) diagnostic.Append(line).Append(Environment.NewLine);
            }
        }

        internal static string ReadDiagnostic(StringBuilder diagnostic)
        {
            lock (diagnostic) return diagnostic.ToString();
        }
    }

    // The startup entry of this launcher: a registry value under the current
    // user and a preference file that stays the source of truth.
    internal static class StartupEntry
    {
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string ValueName = "WaleedMcpHub";

        internal static string PreferencePath()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(Path.Combine(local, "WaleedMcpHub"), "launcher-settings.json");
        }

        internal static bool ReadPreference()
        {
            string path = PreferencePath();
            if (!File.Exists(path)) return true;
            string text = File.ReadAllText(path);
            int marker = text.IndexOf("startWithWindows", StringComparison.Ordinal);
            if (marker < 0) return true;
            int colon = text.IndexOf(':', marker);
            if (colon < 0) return true;
            string value = text.Substring(colon + 1).TrimStart();
            return !value.StartsWith("false", StringComparison.OrdinalIgnoreCase);
        }

        internal static void WritePreference(bool value)
        {
            string path = PreferencePath();
            string directory = Path.GetDirectoryName(path);
            if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
            string temporary = path + ".tmp";
            File.WriteAllText(temporary, "{\"startWithWindows\":" + (value ? "true" : "false") + "}");
            if (File.Exists(path)) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
        }

        internal static string ReadRunValue()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
            {
                if (key == null) return null;
                return key.GetValue(ValueName) as string;
            }
        }

        internal static void WriteRunValue(string data)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, true) ?? Registry.CurrentUser.CreateSubKey(RunKeyPath))
            {
                if (key == null) throw new IOException("The Windows startup registry key is not available.");
                key.SetValue(ValueName, data, RegistryValueKind.String);
            }
        }

        internal static void RemoveRunValue()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, true))
            {
                if (key != null) key.DeleteValue(ValueName, false);
            }
        }
    }

    // The tray icon lives as long as the desktop manager this launcher
    // started. Only the launcher that owns the per-user mutex shows it.
    internal sealed class TrayContext : ApplicationContext
    {
        internal const string TrayMutexName = @"Local\WaleedMcpHub.Tray";
        private const string BalloonText = "Waleed MCP Hub";
        private readonly string root;
        private readonly string node;
        private readonly string script;
        private readonly Process child;
        private readonly StringBuilder diagnostic;
        private readonly Control marshaller = new Control();
        private readonly IntPtr marshallerHandle;
        private readonly System.Windows.Forms.Timer mutexTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer reconcileTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer quitTimer = new System.Windows.Forms.Timer();
        private readonly List<string> pendingNotices = new List<string>();
        private Mutex trayMutex;
        private NotifyIcon tray;
        private Icon trayIcon;
        private ContextMenuStrip menu;
        private ToolStripMenuItem startupItem;
        private ToolStripMenuItem quitItem;
        private DateTime lastOpen = DateTime.MinValue;
        private bool quitting;
        private bool redundant;
        private int childExitCode = 1;

        internal TrayContext(string root, string node, string script, Process child, StringBuilder diagnostic)
        {
            this.root = root;
            this.node = node;
            this.script = script;
            this.child = child;
            this.diagnostic = diagnostic;
            // The hidden control owns the window handle that lets the
            // process-exit thread hand its work to the message loop.
            marshallerHandle = marshaller.Handle;
            child.Exited += delegate { OnChildExited(); };
            child.EnableRaisingEvents = true;
            mutexTimer.Interval = 2000;
            mutexTimer.Tick += delegate { TryShowTray(); };
            mutexTimer.Start();
            reconcileTimer.Interval = 10000;
            reconcileTimer.Tick += delegate { reconcileTimer.Stop(); ReconcileStartup(); };
            reconcileTimer.Start();
            quitTimer.Interval = 15000;
            quitTimer.Tick += delegate { OnQuitTimeout(); };
            ApplyStoredPreference();
            // The first attempt runs now; the timer only retries.
            TryShowTray();
        }

        internal int ChildExitCode { get { return childExitCode; } }

        // A missing preference file means the user never chose, so the hub
        // starts with Windows and the choice is written down.
        private void ApplyStoredPreference()
        {
            try
            {
                if (!File.Exists(StartupEntry.PreferencePath())) StartupEntry.WritePreference(true);
                if (!StartupEntry.ReadPreference()) StartupEntry.RemoveRunValue();
            }
            catch (Exception error)
            {
                ShowNotice("Could not apply the startup preference: " + error.Message);
            }
        }

        private void TryShowTray()
        {
            if (tray != null) return;
            if (!AcquireTrayMutex()) return;
            ShowTray();
        }

        // desktop.mjs --attach prints this line when it attached to a manager
        // of this installation that was already running.
        private const string ReusedLine = "wmh-desktop-reused";

        // A launcher that only reopened the window of a manager whose tray is
        // already shown has nothing to add, so it ends instead of staying
        // resident. A handoff from another installation never prints the line:
        // its child becomes the manager and this launcher keeps the tray.
        internal void OnChildOutput(string line)
        {
            if (line != ReusedLine) return;
            RunOnUiThread(delegate
            {
                if (tray != null || AcquireTrayMutex()) return;
                redundant = true;
                mutexTimer.Stop();
                try { child.Kill(); } catch (InvalidOperationException) { }
            });
        }

        private bool AcquireTrayMutex()
        {
            if (trayMutex != null) return true;
            bool createdNew;
            Mutex candidate = new Mutex(true, TrayMutexName, out createdNew);
            if (createdNew)
            {
                trayMutex = candidate;
                return true;
            }
            try
            {
                if (candidate.WaitOne(0))
                {
                    trayMutex = candidate;
                    return true;
                }
            }
            catch (AbandonedMutexException)
            {
                // The previous owner died with the mutex; this launcher takes it.
                trayMutex = candidate;
                return true;
            }
            candidate.Dispose();
            return false;
        }

        private void ShowTray()
        {
            menu = new ContextMenuStrip();
            ToolStripMenuItem openItem = new ToolStripMenuItem("Open Waleed MCP Hub");
            openItem.Click += delegate { OpenHub(); };
            // The default item of the menu, which a double click also runs.
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            startupItem = new ToolStripMenuItem("Start with Windows");
            startupItem.Click += delegate { ToggleStartup(); };
            quitItem = new ToolStripMenuItem("Quit");
            quitItem.Click += delegate { QuitHub(); };
            menu.Items.Add(openItem);
            menu.Items.Add(startupItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quitItem);
            tray = new NotifyIcon();
            tray.ContextMenuStrip = menu;
            tray.Text = BalloonText;
            try
            {
                trayIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            }
            catch (Exception)
            {
                trayIcon = SystemIcons.Application;
            }
            tray.Icon = trayIcon;
            // Click also fires for the right button that opens the menu, so
            // only a left click opens the hub.
            tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenHub(); };
            tray.DoubleClick += delegate { OpenHub(); };
            tray.Visible = true;
            UpdateStartupCheck();
            ShowPendingNotices();
        }

        private void ShowPendingNotices()
        {
            foreach (string message in pendingNotices)
            {
                if (tray != null) tray.ShowBalloonTip(5000, BalloonText, message, ToolTipIcon.Warning);
            }
            pendingNotices.Clear();
        }

        private void ShowNotice(string message)
        {
            if (tray == null)
            {
                pendingNotices.Add(message);
                return;
            }
            tray.ShowBalloonTip(5000, BalloonText, message, ToolTipIcon.Warning);
        }

        // A click and the double click of one gesture must not open the hub
        // twice, so the second gesture is ignored.
        private void OpenHub()
        {
            if ((DateTime.Now - lastOpen).TotalMilliseconds < 750) return;
            lastOpen = DateTime.Now;
            try
            {
                Process helper = Launcher.StartNode(root, node, "\"" + script + "\"");
                Launcher.BeginOutput(helper, null);
            }
            catch (Exception error)
            {
                ShowNotice("Could not open Waleed MCP Hub: " + error.Message);
            }
        }

        private void ToggleStartup()
        {
            bool target = startupItem == null || !startupItem.Checked;
            try
            {
                StartupEntry.WritePreference(target);
            }
            catch (Exception error)
            {
                ShowNotice("Could not save the startup preference: " + error.Message);
                UpdateStartupCheck();
                return;
            }
            try
            {
                if (target) StartupEntry.WriteRunValue(RunValueData());
                else StartupEntry.RemoveRunValue();
            }
            catch (Exception error)
            {
                ShowNotice("Could not update the Windows startup entry: " + error.Message);
            }
            UpdateStartupCheck();
        }

        private void UpdateStartupCheck()
        {
            if (startupItem == null) return;
            try
            {
                startupItem.Checked = StartupEntry.ReadRunValue() != null;
            }
            catch (Exception)
            {
                // The registry cannot be read; the last known state stays.
            }
        }

        private static string RunValueData()
        {
            return "\"" + Application.ExecutablePath + "\" --startup";
        }

        // The startup entry only points at this launcher once the manager has
        // stayed alive, so a broken installation cannot take over the start.
        private void ReconcileStartup()
        {
            if (child.HasExited) return;
            try
            {
                if (!StartupEntry.ReadPreference())
                {
                    StartupEntry.RemoveRunValue();
                    return;
                }
                string expected = RunValueData();
                if (StartupEntry.ReadRunValue() != expected) StartupEntry.WriteRunValue(expected);
            }
            catch (Exception error)
            {
                ShowNotice("Could not update the Windows startup entry: " + error.Message);
            }
        }

        private void QuitHub()
        {
            quitting = true;
            quitItem.Text = "Stopping\u2026";
            quitItem.Enabled = false;
            quitTimer.Start();
            try
            {
                Process helper = Launcher.StartNode(root, node, "\"" + script + "\" --quit");
                Launcher.BeginOutput(helper, null);
                Thread worker = new Thread(new ThreadStart(delegate { helper.WaitForExit(); OnQuitHelperExited(helper.ExitCode); }));
                worker.IsBackground = true;
                worker.Start();
            }
            catch (Exception)
            {
                ShowNotice("Could not reach the hub to stop it.");
                ResetQuitItem();
            }
        }

        private void OnQuitHelperExited(int code)
        {
            RunOnUiThread(delegate
            {
                // 0 means the manager is stopping, 3 that it was already gone
                // and 4 that it is busy; all keep waiting for it to end.
                if (code == 0 || code == 3 || code == 4) return;
                if (code == 5)
                    ShowNotice("This hub version cannot be stopped from the tray. Use Settings to stop the desktop manager.");
                else ShowNotice("Could not reach the hub to stop it.");
                quitTimer.Stop();
                ResetQuitItem();
            });
        }

        private void OnQuitTimeout()
        {
            quitTimer.Stop();
            ShowNotice("Waleed MCP Hub is still stopping. Choose Quit again to retry.");
            ResetQuitItem();
        }

        // Only an abandoned quit resets the item, so the launcher stops
        // treating a later manager exit as a requested one.
        private void ResetQuitItem()
        {
            quitting = false;
            quitTimer.Stop();
            if (quitItem == null) return;
            quitItem.Text = "Quit";
            quitItem.Enabled = true;
        }

        private void OnChildExited()
        {
            child.WaitForExit(5000);
            int code = child.ExitCode;
            RunOnUiThread(delegate { OnChildExit(code); });
        }

        private void OnChildExit(int code)
        {
            childExitCode = code;
            HideTray();
            // Exit code -1 (0xFFFFFFFF) indicates external process termination
            // (taskkill/shutdown); only alert on actual crashes (> 0). A manager
            // that ended while it was stopping did not fail to start.
            if (!quitting && !redundant && code != 0 && code != -1)
                MessageBox.Show("Waleed MCP Hub could not start.\n\n" + Launcher.ReadDiagnostic(diagnostic) + "\nSee %LOCALAPPDATA%\\WaleedMcpHub\\desktop.log for details.", BalloonText, MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitThread();
        }

        private void RunOnUiThread(Action action)
        {
            try
            {
                if (marshallerHandle != IntPtr.Zero) marshaller.BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // The message loop is already gone; there is nothing to update.
            }
        }

        private void HideTray()
        {
            mutexTimer.Stop();
            reconcileTimer.Stop();
            quitTimer.Stop();
            if (tray != null)
            {
                tray.Visible = false;
                tray.Dispose();
                tray = null;
            }
            if (trayIcon != null)
            {
                trayIcon.Dispose();
                trayIcon = null;
            }
            if (menu != null)
            {
                menu.Dispose();
                menu = null;
            }
            if (trayMutex != null)
            {
                try
                {
                    trayMutex.ReleaseMutex();
                }
                catch (ApplicationException)
                {
                    // Another thread owns the mutex; the process exit releases it.
                }
                trayMutex.Dispose();
                trayMutex = null;
            }
        }
    }
}
