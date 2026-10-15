// Streamify SMTC bridge helper.
//
// Electron cannot reach Windows' SystemMediaTransportControls (navigator
// mediaSession is never bridged), and native node addons can't compile against
// Electron 36 headers (C++20 vs /ZW C++/CX). So this standalone .NET helper
// registers the SMTC session instead.
//
// GetForCurrentView() fails in a console process ("Invalid window handle").
// The documented path is ISystemMediaTransportControlsInterop::GetForWindow
// with a hidden top-level window OWNED BY THIS PROCESS — Electron's window is
// rejected with E_ACCESSDENIED, and the session's source identity comes from
// this process's AUMID (claimed below), not from the hwnd.
//
// STA discipline: the STA thread owns the SMTC objects and must pump messages
// (ButtonPressed events dispatch via the pump). Blocking it on the pipe, or
// touching WinRT from ConfigureAwait(false) continuations, yields "Cannot
// access a disposed object" on the thumbnail and a wedged status. The pipe
// reader runs on its own thread and feeds a queue; Main pumps and drains.
//
// Invocation: StreamifySmtcHelper.exe <pipeName> [--verbose]
// Pipe protocol (JSON lines both directions):
//   -> { "type": "publish", "song": {title,artist,album,coverUrl},
//        "state": {isPlaying,hasNext,hasPrevious,position,duration} }
//   -> { "type": "clear" }
//   -> { "type": "position", "seconds": n, "duration": n }
//   -> { "type": "ping" }
//   <- { "type": "registered" }
//   <- { "type": "button", "button": "play"|"pause"|"stop"|"next"|"previous" }
//   <- { "type": "pong" }
using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using Windows.Graphics.Imaging;
using Windows.Media;
using Windows.Storage.Streams;

namespace Streamify.Smtc
{
    public static class Program
    {
        private static SystemMediaTransportControls _controls;
        private static StreamWriter _writer;
        private static bool _verbose;
        private static double _lastDuration;
        private static volatile bool readerDone;

        [STAThread]
        public static int Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.Error.WriteLine("usage: StreamifySmtcHelper.exe <pipeName> [--verbose]");
                return 2;
            }
            _verbose = Array.Exists(args, a => a == "--verbose");

            // The SMTC session reports SourceAppUserModelId from the process
            // that creates it (this one), so claim the app's AUMID here —
            // without it the overlay shows the helper's raw exe identity.
            try { SetCurrentProcessExplicitAppUserModelID("com.streamify.desktop"); } catch { }

            // Hidden top-level window to own the SMTC session. Must be owned by
            // THIS process: GetForWindow returns E_ACCESSDENIED for a window
            // belonging to another process (e.g. the Electron main window).
            var hwnd = HiddenWindow.Create("Streamify");
            if (hwnd == IntPtr.Zero)
            {
                Console.Error.WriteLine("window: GetLastError");
                return 1;
            }

            try
            {
                _controls = GetForWindow(hwnd);
                _controls.IsEnabled = true;
                _controls.IsPlayEnabled = true;
                _controls.IsPauseEnabled = true;
                _controls.IsStopEnabled = true;
                _controls.IsNextEnabled = true;
                _controls.IsPreviousEnabled = true;
                _controls.PlaybackStatus = MediaPlaybackStatus.Closed;

                _controls.ButtonPressed += (sender, e) =>
                {
                    // Send the raw enum and let the app map Stop → whatever it
                    // wants; a hard-coded mapping here duplicates policy.
                    string button = e.Button switch
                    {
                        SystemMediaTransportControlsButton.Play => "play",
                        SystemMediaTransportControlsButton.Pause => "pause",
                        SystemMediaTransportControlsButton.Stop => "stop",
                        SystemMediaTransportControlsButton.Next => "next",
                        SystemMediaTransportControlsButton.Previous => "previous",
                        _ => null,
                    };
                    if (button != null) WriteLine(new { type = "button", button });
                };

                if (_verbose) Console.WriteLine("registered");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("register: " + ex.Message);
                return 1;
            }

            // Node (Electron main) creates and listens on the pipe; this helper
            // is the CLIENT — creating a server on the same name fails with
            // ERROR_ACCESS_DENIED since the name is already owned.
            using var pipe = new NamedPipeClientStream(
                ".", args[0], PipeDirection.InOut, PipeOptions.Asynchronous);
            pipe.Connect(15000);
            if (_verbose) Console.WriteLine("connected");

            _writer = new StreamWriter(pipe) { AutoFlush = true };
            WriteLine(new { type = "registered" });

            // Dedicated reader thread so we never block the STA message pump.
            // FIFO queue: read as fast as the pipe drains, apply on the STA
            // thread during the pump below. No locking beyond the simple queue.
            var incoming = new ConcurrentQueue<string>();
            var reader = new StreamReader(pipe);
            var readerThread = new Thread(() =>
            {
                string line;
                while ((line = reader.ReadLine()) != null) incoming.Enqueue(line);
                readerDone = true;
            });
            readerThread.IsBackground = true;
            readerThread.Start();

            while (true)
            {
                while (incoming.TryDequeue(out var line))
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(line);
                        var root = doc.RootElement;
                        var type = root.TryGetProperty("type", out var t) ? t.GetString() : "";
                        switch (type)
                        {
                            case "publish": Publish(root); break;
                            case "clear":
                                _controls.DisplayUpdater.ClearAll();
                                _controls.PlaybackStatus = MediaPlaybackStatus.Closed;
                                break;
                            case "position":
                                if (root.TryGetProperty("seconds", out var sec))
                                {
                                    // Duration rides along on the publish that set
                                    // the track; the renderer only ticks seconds.
                                    double d = root.TryGetProperty("duration", out var dur)
                                        ? dur.GetDouble() : 0;
                                    UpdateTimeline(sec.GetDouble(), d > 0 ? d : _lastDuration);
                                }
                                break;
                            case "ping": WriteLine(new { type = "pong" }); break;
                        }
                    }
                    catch (Exception ex)
                    {
                        if (_verbose) Console.Error.WriteLine("line: " + ex.Message);
                    }
                }
                PumpOnce();
                if (readerDone && incoming.IsEmpty) break; // pipe closed
            }

            try
            {
                _controls.DisplayUpdater.ClearAll();
                _controls.IsEnabled = false;
            }
            catch { }
            return 0;
        }

        private static void WriteLine(object message)
        {
            try { _writer?.WriteLine(JsonSerializer.Serialize(message)); } catch { }
        }

        // SMTC ButtonPressed events land on this thread's window-message queue,
        // so the pump must run or OS media keys do nothing. PeekMessage with
        // PM_REMOVE drains everything pending; the sleep keeps CPU flat while
        // still reacting to a keypress within ~10ms.
        private static void PumpOnce()
        {
            while (PeekMessage(out var msg, IntPtr.Zero, 0, 0, 1))
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            Thread.Sleep(10);
        }

        private struct MSG
        {
            public IntPtr hwnd; public uint message; public IntPtr wParam;
            public IntPtr lParam; public uint time; public int ptX; public int ptY;
        }

        [DllImport("user32.dll")]
        private static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
        [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG m);
        [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG m);

        private static void Publish(JsonElement root)
        {
            var song = root.TryGetProperty("song", out var s) && s.ValueKind == JsonValueKind.Object
                ? (JsonElement?)s : null;
            var state = root.TryGetProperty("state", out var st) && st.ValueKind == JsonValueKind.Object
                ? (JsonElement?)st : null;

            var updater = _controls.DisplayUpdater;
            if (song == null || song is not JsonElement songEl)
            {
                updater.ClearAll();
                _controls.PlaybackStatus = MediaPlaybackStatus.Closed;
                return;
            }

            updater.Type = MediaPlaybackType.Music;
            updater.MusicProperties.Title = GetStr(songEl, "title") ?? "Streamify";
            updater.MusicProperties.Artist = GetStr(songEl, "artist") ?? "Unknown Artist";
            updater.MusicProperties.AlbumTitle = GetStr(songEl, "album") ?? "";
            updater.AppMediaId = "com.streamify.desktop";

            if (state is JsonElement st2 && st2.TryGetProperty("duration", out var dv))
            {
                var seconds = dv.GetDouble();
                if (seconds > 0) _lastDuration = seconds;
            }

            // Cover art: hand the shell the URL and let it fetch. Downloading
            // here buys nothing — the SMTC renderers (volume flyout, lock
            // screen) resolve CreateFromUri themselves, and an
            // InMemoryRandomAccessStream has to be built and disposed by the
            // same STA thread that owns the updater, which the pipe reader
            // thread is not.
            string cover = GetStr(songEl, "coverUrl");
            if (!string.IsNullOrEmpty(cover) && Uri.TryCreate(cover, UriKind.Absolute, out var art))
            {
                updater.Thumbnail = RandomAccessStreamReference.CreateFromUri(art);
            }

            updater.Update();
            ApplyState(state);
        }

        private static void ApplyState(JsonElement? state)
        {
            bool playing = state is JsonElement p && p.TryGetProperty("isPlaying", out var pv) && pv.GetBoolean();
            bool hasNext = state is JsonElement n && n.TryGetProperty("hasNext", out var nv) && nv.GetBoolean();
            bool hasPrev = state is JsonElement q && q.TryGetProperty("hasPrevious", out var qv) && qv.GetBoolean();

            _controls.IsNextEnabled = hasNext;
            _controls.IsPreviousEnabled = hasPrev;
            _controls.PlaybackStatus = playing ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused;
        }

        private static void UpdateTimeline(double position, double duration)
        {
            if (double.IsNaN(position) || double.IsNaN(duration) || duration <= 0) return;
            var timeline = new SystemMediaTransportControlsTimelineProperties
            {
                StartTime = TimeSpan.Zero,
                EndTime = TimeSpan.FromSeconds(duration),
                MinSeekTime = TimeSpan.Zero,
                MaxSeekTime = TimeSpan.FromSeconds(duration),
                Position = TimeSpan.FromSeconds(Math.Min(position, duration)),
            };
            _controls.UpdateTimelineProperties(timeline);
        }

        private static string GetStr(JsonElement obj, string key) =>
            obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        // ---- SMTC interop ---------------------------------------------------
        // WinRT classes are NOT registered under HKCR\CLSID — Type.GetTypeFromCLSID
        // always throws REGDB_E_CLASSNOTREG for them. The documented activation is
        // RoGetActivationFactory(className, interopIID), then the factory's
        // GetForWindow at vtable slot 6 (IUnknown 0-2 + IInspectable 3-5).
        // The call is done through a hand-rolled delegate, not ComImport: .NET 8
        // refuses to marshal IInspectable-derived ComImport interfaces.
        // IIDs verified: interop from SDK SystemMediaTransportControlsInterop.h
        // MIDL_INTERFACE; controls from guid_of<ISystemMediaTransportControls>.

        private const string IidInterop = "DDB0472D-C911-4A1F-86D9-DC3D71A95F5A";
        private const string IidControls = "99FA3FF4-1742-42A6-902E-087D41F965EC";

        [DllImport("combase.dll", CharSet = CharSet.Unicode)]
        private static extern int RoGetActivationFactory(
            IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

        [DllImport("combase.dll", CharSet = CharSet.Unicode)]
        private static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

        [DllImport("combase.dll")]
        private static extern int WindowsDeleteString(IntPtr hstring);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetForWindowDelegate(
            IntPtr self, IntPtr appWindow, ref Guid riid, out IntPtr mediaTransportControl);

        private static SystemMediaTransportControls GetForWindow(IntPtr hwnd)
        {
            const string className = "Windows.Media.SystemMediaTransportControls";
            if (WindowsCreateString(className, className.Length, out IntPtr hs) != 0)
                throw new InvalidOperationException("WindowsCreateString failed");
            try
            {
                var iidInterop = new Guid(IidInterop);
                int hr = RoGetActivationFactory(hs, ref iidInterop, out IntPtr factory);
                if (hr != 0) throw new InvalidOperationException("RoGetActivationFactory 0x" + hr.ToString("X8"));

                // vtable: slot 6 is GetForWindow (3 IUnknown + 3 IInspectable).
                IntPtr vtbl = Marshal.ReadIntPtr(factory);
                IntPtr slot = Marshal.ReadIntPtr(vtbl, 6 * IntPtr.Size);
                var getForWindow = Marshal.GetDelegateForFunctionPointer<GetForWindowDelegate>(slot);

                var iidControls = new Guid(IidControls);
                hr = getForWindow(factory, hwnd, ref iidControls, out IntPtr ptr);
                if (hr != 0) throw new InvalidOperationException("GetForWindow 0x" + hr.ToString("X8"));

                // Wrap the raw interface pointer in the projected WinRT type.
                return ABI.Windows.Media.SystemMediaTransportControls.FromAbi(ptr);
            }
            finally
            {
                WindowsDeleteString(hs);
            }
        }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SetCurrentProcessExplicitAppUserModelID(string AppID);
    }

    // Minimal hidden Win32 window: SMTC requires a real HWND owned by this
    // process, and a message-only window (HWND_MESSAGE) is rejected.
    internal static class HiddenWindow
    {
        private delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        private static WndProc _proc; // rooted; never GC'd

        public static IntPtr Create(string title)
        {
            var instance = GetModuleHandle(null);
            _proc = WndProcDefault;

            var className = "StreamifySmtcHidden";
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)Marshal.SizeOf<WNDCLASSEXW>(),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_proc),
                hInstance = instance,
                lpszClassName = className,
            };
            if (RegisterClassExW(ref wc) == 0) return IntPtr.Zero;

            return CreateWindowExW(0, className, title, 0, 0, 0, 0, 0,
                IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        }

        private static IntPtr WndProcDefault(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
            => DefWindowProcW(hWnd, msg, wParam, lParam);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WNDCLASSEXW
        {
            public uint cbSize;
            public uint style;
            public IntPtr lpfnWndProc;
            public int cbClsExtra;
            public int cbWndExtra;
            public IntPtr hInstance;
            public IntPtr hIcon;
            public IntPtr hCursor;
            public IntPtr hbrBackground;
            public string lpszMenuName;
            public string lpszClassName;
            public IntPtr hIconSm;
        }

        [DllImport("user32.dll")] private static extern ushort RegisterClassExW(ref WNDCLASSEXW lpwcx);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName,
            uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
        [DllImport("user32.dll")] private static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    }
}
