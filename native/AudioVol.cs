// Core Audio 的极简封装：只干两件事——读某个进程的会话音量、改它。
// 用 Windows 自带的 WASAPI 接口，不注入、不 Hook、不碰播放器进程，
// 就是系统「音量合成器」里那根滑杆的同一套 API。
using System;
using System.Runtime.InteropServices;

namespace DeskPanelAudio
{
  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumerator { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator
  {
    int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out object devices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice
  {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    int OpenPropertyStore(int stgmAccess, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionManager2
  {
    int GetAudioSessionControl(ref Guid audioSessionGuid, int streamFlags, out IAudioSessionControl sessionControl);
    int GetSimpleAudioVolume(ref Guid audioSessionGuid, int streamFlags, out ISimpleAudioVolume audioVolume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    int RegisterSessionNotification(IntPtr notify);
    int UnregisterSessionNotification(IntPtr notify);
    int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notify);
    int UnregisterDuckNotification(IntPtr notify);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionEnumerator
  {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl session);
  }

  [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl
  {
    int GetState(out int state);
    int GetDisplayName(out IntPtr name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    int GetIconPath(out IntPtr path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    int GetGroupingParam(out Guid groupingParam);
    int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
  }

  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl2
  {
    int GetState(out int state);
    int GetDisplayName(out IntPtr name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    int GetIconPath(out IntPtr path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    int GetGroupingParam(out Guid groupingParam);
    int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
    int GetSessionIdentifier(out IntPtr retVal);
    int GetSessionInstanceIdentifier(out IntPtr retVal);
    int GetProcessId(out uint processId);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
  }

  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ISimpleAudioVolume
  {
    int SetMasterVolume(float level, ref Guid eventContext);
    int GetMasterVolume(out float level);
    int SetMute(bool mute, ref Guid eventContext);
    int GetMute(out bool mute);
  }

  public static class Api
  {
    static readonly Guid IID_SessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    const int CLSCTX_ALL = 23;

    static IAudioSessionManager2 Manager()
    {
      IMMDevice dev;
      int hr = ((IMMDeviceEnumerator)new MMDeviceEnumerator())
        .GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out dev);
      if (hr != 0) throw new Exception("GetDefaultAudioEndpoint hr=0x" + hr.ToString("X"));
      object obj;
      Guid iid = IID_SessionManager2;
      hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out obj);
      if (hr != 0) throw new Exception("Activate(SessionManager2) hr=0x" + hr.ToString("X"));
      return (IAudioSessionManager2)obj;
    }

    static bool NameMatches(uint pid, string procName)
    {
      try
      {
        string n = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
        return string.Equals(n, procName, StringComparison.OrdinalIgnoreCase);
      }
      catch (Exception) { return false; }
    }

    static ISimpleAudioVolume Find(string procName)
    {
      IAudioSessionManager2 mgr = Manager();
      IAudioSessionEnumerator en;
      if (mgr.GetSessionEnumerator(out en) != 0) return null;
      int count;
      en.GetCount(out count);
      for (int i = 0; i < count; i++)
      {
        IAudioSessionControl ctl;
        if (en.GetSession(i, out ctl) != 0) continue;
        IAudioSessionControl2 c2 = ctl as IAudioSessionControl2;
        if (c2 == null) continue;
        uint pid;
        if (c2.GetProcessId(out pid) != 0) continue;
        if (!NameMatches(pid, procName)) continue;
        ISimpleAudioVolume sv = ctl as ISimpleAudioVolume;
        if (sv != null) return sv;
      }
      return null;
    }

    // 音量 0..1；进程没有音频会话（还没出声）时返回 -1
    public static float GetVolume(string procName)
    {
      ISimpleAudioVolume sv = Find(procName);
      if (sv == null) return -1f;
      float v;
      if (sv.GetMasterVolume(out v) != 0) return -1f;
      return v;
    }

    // 返回 true 表示真的写进去了
    public static bool SetVolume(string procName, float level)
    {
      ISimpleAudioVolume sv = Find(procName);
      if (sv == null) return false;
      if (level < 0f) level = 0f;
      if (level > 1f) level = 1f;
      Guid ctx = Guid.Empty;
      return sv.SetMasterVolume(level, ref ctx) == 0;
    }

    public static bool GetMute(string procName)
    {
      ISimpleAudioVolume sv = Find(procName);
      if (sv == null) return false;
      bool m;
      sv.GetMute(out m);
      return m;
    }

    public static bool SetMute(string procName, bool mute)
    {
      ISimpleAudioVolume sv = Find(procName);
      if (sv == null) return false;
      Guid ctx = Guid.Empty;
      return sv.SetMute(mute, ref ctx) == 0;
    }
  }
}
