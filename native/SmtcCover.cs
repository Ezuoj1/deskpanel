// SMTC 封面小工具：读取“当前播放媒体”的缩略图并存成文件。
// 只调用微软官方接口（GlobalSystemMediaTransportControlsSessionManager），
// 不注入进程、不联网、不碰播放器。
//
// 用法：  SmtcCover.exe <输出文件路径>
// 输出：  ok <字节数> | nothumb | nosession | busy | fail <消息>
//
// 说明：这里刻意不用 System.Runtime.WindowsRuntime（本机没有 SDK 的联合元数据，
// 编译会对不上 "Windows" 契约程序集），改成手写轮询 IAsyncOperation.Status + GetResults。
using System;
using System.IO;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

internal static class SmtcCover
{
  private static T Wait<T>(IAsyncOperation<T> op)
  {
    if (op == null) return default(T);
    int guard = 0;
    while (op.Status == AsyncStatus.Started && guard++ < 500)
    {
      Thread.Sleep(10);
    }
    if (op.Status != AsyncStatus.Completed) return default(T);
    return op.GetResults();
  }

  private static int Main(string[] args)
  {
    string outFile = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "deskpanel-cover.img");
    try
    {
      var manager = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
      if (manager == null) { Console.WriteLine("nosession"); return 2; }
      var session = manager.GetCurrentSession();
      if (session == null)
      {
        var all = manager.GetSessions();
        if (all != null && all.Count > 0) session = all[0];
      }
      if (session == null) { Console.WriteLine("nosession"); return 2; }

      var props = Wait(session.TryGetMediaPropertiesAsync());
      if (props == null || props.Thumbnail == null) { Console.WriteLine("nothumb"); return 3; }

      IRandomAccessStreamWithContentType ras = Wait(props.Thumbnail.OpenReadAsync());
      if (ras == null) { Console.WriteLine("nothumb"); return 3; }

      IInputStream input = ras.GetInputStreamAt(0);
      var reader = new DataReader(input);
      uint size = (uint)ras.Size;
      if (size == 0 || size > 8 * 1024 * 1024) { Console.WriteLine("nothumb"); return 3; }

      uint loaded = 0;
      int guard = 0;
      while (loaded < size && guard++ < 200)
      {
        uint part = Wait(reader.LoadAsync(size - loaded));
        if (part == 0) break;
        loaded += part;
      }
      if (loaded == 0) { Console.WriteLine("nothumb"); return 3; }

      byte[] bytes = new byte[loaded];
      reader.ReadBytes(bytes);
      reader.Dispose();

      string dir = Path.GetDirectoryName(outFile);
      if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
      string tmp = outFile + ".tmp";
      File.WriteAllBytes(tmp, bytes);
      if (File.Exists(outFile)) File.Delete(outFile);
      File.Move(tmp, outFile);

      Console.WriteLine("ok " + bytes.Length);
      return 0;
    }
    catch (Exception ex)
    {
      Console.WriteLine("fail " + ex.GetType().Name + ": " + ex.Message.Replace("\r", " ").Replace("\n", " "));
      return 1;
    }
  }
}
