using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace WaleedMcpHub
{
    static class Program
    {
#if HUB_STARTUP_TEST
        const string RunKey = @"Software\WaleedMcpHub\StartupTest";
#else
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
#endif
        const string ValueName = "WaleedMcpHub";
        static string StartupCommand()
        {
            string file = Path.GetFullPath(Application.ExecutablePath);
            if (Path.GetFileName(file) != "WaleedMcpHub.exe" || file.StartsWith(@"\\") || file.IndexOfAny(new char[] { '"', '\r', '\n' }) >= 0) throw new InvalidOperationException();
            return "\"" + file + "\" --background";
        }
        static string StartupState(RegistryKey key)
        {
            if (key == null || Array.IndexOf(key.GetValueNames(), ValueName) < 0) return "disabled";
            if (key.GetValueKind(ValueName) != RegistryValueKind.String) return "conflict";
            return String.Equals(key.GetValue(ValueName, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string, StartupCommand(), StringComparison.OrdinalIgnoreCase) ? "enabled" : "conflict";
        }
        static int Startup(string command)
        {
            if (command != "--startup-query" && command != "--startup-enable-from-enabled" && command != "--startup-enable-from-disabled" && command != "--startup-disable-from-enabled" && command != "--startup-disable-from-disabled") return 2;
            string sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
            using (Mutex mutex = new Mutex(false, @"Local\WaleedMcpHubStartup-" + sid))
            {
                bool owned = false;
                try
                {
                    try { owned = mutex.WaitOne(5000); } catch (AbandonedMutexException) { owned = true; }
                    if (!owned) return 2;
                    string state;
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey, false)) state = StartupState(key);
                    if (command != "--startup-query")
                    {
                        string expected = command.EndsWith("from-enabled", StringComparison.Ordinal) ? "enabled" : "disabled";
                        if (state != expected || state == "conflict") return 2;
                        bool enable = command.StartsWith("--startup-enable-", StringComparison.Ordinal);
                        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey))
                        {
                            // Recheck while holding the same-user mutex. Never overwrite
                            // or remove another installation's command or unrelated value.
                            if (StartupState(key) != expected) return 2;
                            if (enable) key.SetValue(ValueName, StartupCommand(), RegistryValueKind.String);
                            else if (state == "enabled") key.DeleteValue(ValueName, false);
                            state = StartupState(key);
                        }
                    }
                    Console.WriteLine("{\"available\":true,\"state\":\"" + state + "\",\"enabled\":" + (state == "enabled" ? "true" : "false") + "}");
                    return 0;
                }
                finally { if (owned) mutex.ReleaseMutex(); }
            }
        }
        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                if (args.Length == 1 && args[0].StartsWith("--startup-", StringComparison.Ordinal)) return Startup(args[0]);
                if (args.Length == 1 && args[0] == "--tray-self-test")
                {
                    int opened = 0, checkedHealth = 0, exited = 0;
                    using (NotifyIcon icon = new NotifyIcon())
                    using (ContextMenuStrip menu = TrayContext.CreateMenu(delegate { opened++; }, delegate { checkedHealth++; }, delegate { exited++; }))
                    {
                        icon.ContextMenuStrip = menu; icon.Icon = SystemIcons.Application;
                        menu.Items[0].PerformClick(); menu.Items[1].PerformClick(); menu.Items[3].PerformClick();
                        if (opened != 1 || checkedHealth != 1 || exited != 1 || icon.Visible) return 2;
                        Console.WriteLine("wmh-tray-v1:Open Waleed MCP Hub|Check Health|Exit"); return 0;
                    }
                }
                bool background = args.Length == 1 && args[0] == "--background";
                if (args.Length != 0 && !background) return 2;
                string root = AppDomain.CurrentDomain.BaseDirectory;
                string node = Path.Combine(root, "runtime", "node.exe");
                if (!File.Exists(node)) node = @"E:\Dev\Tools_and_Utilities\nodejs24\node.exe";
                string script = Path.Combine(root, "scripts", "desktop.mjs");
                if (!File.Exists(node) || !File.Exists(script)) throw new InvalidOperationException();
                Application.EnableVisualStyles();
                using (Process process = new Process())
                {
                    process.StartInfo = new ProcessStartInfo { FileName = node, Arguments = "\"" + script + "\"" + (background ? " --background" : ""), WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                    if (!process.Start()) throw new InvalidOperationException();
                    using (TrayContext context = new TrayContext(process)) Application.Run(context);
                    return process.HasExited ? process.ExitCode : 1;
                }
            }
            catch
            {
                if (args.Length == 0 || (args.Length == 1 && args[0] == "--background")) MessageBox.Show("The Hub launcher could not start. Rebuild the desktop package and inspect the local runtime. No startup entry was changed.", "Waleed MCP Hub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
    sealed class TrayContext : ApplicationContext
    {
        readonly Process process;
        readonly Control dispatch = new Control();
        readonly NotifyIcon icon = new NotifyIcon();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly Dictionary<int, DateTime> browsers = new Dictionary<int, DateTime>();
        bool keepRunning = true, sawWindow = false, exiting = false;
        DateTime lastWindow = DateTime.UtcNow;
        delegate bool EnumCallback(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
        public static ContextMenuStrip CreateMenu(Action open, Action health, Action exit)
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Open Waleed MCP Hub", null, delegate { open(); });
            menu.Items.Add("Check Health", null, delegate { health(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Exit", null, delegate { exit(); }); return menu;
        }
        public TrayContext(Process child)
        {
            process = child; dispatch.CreateControl();
            icon.Text = "Waleed MCP Hub"; icon.Icon = SystemIcons.Application;
            icon.ContextMenuStrip = CreateMenu(delegate { Send("open"); }, delegate { Send("health"); }, Exit);
            icon.DoubleClick += delegate { Send("open"); };
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Post(delegate { Message(e.Data); }); };
            // The hidden launcher never reflects raw backend/provider diagnostics.
            process.ErrorDataReceived += delegate { };
            process.Exited += delegate { Post(delegate { icon.Visible = false; ExitThread(); }); };
            process.EnableRaisingEvents = true;
            process.BeginOutputReadLine(); process.BeginErrorReadLine();
            timer.Interval = 500; timer.Tick += delegate { CheckWindows(); }; timer.Start();
            if (process.HasExited) Post(delegate { ExitThread(); });
        }
        void Post(Action action) { try { dispatch.BeginInvoke(action); } catch (InvalidOperationException) { } }
        void Send(string command)
        {
            if (exiting || process.HasExited) return;
            if (command == "open") lastWindow = DateTime.UtcNow.AddSeconds(8);
            try { process.StandardInput.WriteLine(command); process.StandardInput.Flush(); } catch (IOException) { }
        }
        void Exit() { if (exiting) return; Send("exit"); exiting = true; icon.Text = "Waleed MCP Hub - stopping"; }
        void Message(string message)
        {
            if (message == "wmh-desktop-owner-v1") icon.Visible = true;
            if (message == "wmh-keep-tray:1") keepRunning = true;
            if (message == "wmh-keep-tray:0") keepRunning = false;
            const string prefix = "wmh-edge-pid:";
            int pid;
            if (message.StartsWith(prefix, StringComparison.Ordinal) && Int32.TryParse(message.Substring(prefix.Length), out pid) && browsers.Count < 32)
            {
                try { using (Process browser = Process.GetProcessById(pid)) if (browser.ProcessName == "msedge") browsers[pid] = browser.StartTime.ToUniversalTime(); } catch { }
            }
        }
        void CheckWindows()
        {
            if (process.HasExited) { icon.Visible = false; ExitThread(); return; }
            HashSet<int> live = new HashSet<int>();
            foreach (KeyValuePair<int, DateTime> entry in browsers)
            {
                try { using (Process browser = Process.GetProcessById(entry.Key)) if (!browser.HasExited && browser.StartTime.ToUniversalTime() == entry.Value) live.Add(entry.Key); } catch { }
            }
            List<int> stale = new List<int>(); foreach (int pid in browsers.Keys) if (!live.Contains(pid)) stale.Add(pid); foreach (int pid in stale) browsers.Remove(pid);
            bool visible = false;
            EnumWindows(delegate(IntPtr window, IntPtr parameter) {
                uint pid; GetWindowThreadProcessId(window, out pid);
                if (live.Contains((int)pid) && IsWindowVisible(window)) { StringBuilder name = new StringBuilder(128); GetClassName(window, name, name.Capacity); if (name.ToString() == "Chrome_WidgetWin_1") visible = true; }
                return true;
            }, IntPtr.Zero);
            if (visible) { sawWindow = true; lastWindow = DateTime.UtcNow; }
            // Never treat Edge's short-lived handoff process as a closed app.
            // If no owned window was observed, keep the tray and require Exit.
            if (!keepRunning && sawWindow && !visible && (DateTime.UtcNow - lastWindow).TotalSeconds > 2) Exit();
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { timer.Stop(); timer.Dispose(); icon.Visible = false; icon.ContextMenuStrip.Dispose(); icon.Dispose(); dispatch.Dispose(); }
            base.Dispose(disposing);
        }
    }
}
