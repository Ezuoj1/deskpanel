// 抓图标的兜底工具：Windows 的 ExtractAssociatedIcon 能拿到 Electron getFileIcon 拿不到的图标
// （典型例子：F:\douyin\douyin.exe，Electron 只给通用白纸，系统能给真 Logo）。
// 用法：IconGrab.exe <源文件> <输出.png>
// 退出码：0 成功，2 这个文件没有图标，1 出错。
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

class IconGrab
{
    static int Main(string[] args)
    {
        if (args.Length < 2) { Console.WriteLine("usage: IconGrab.exe <src> <out.png>"); return 1; }
        string src = args[0];
        string outPath = args[1];
        try
        {
            if (!File.Exists(src)) { Console.WriteLine("missing: " + src); return 2; }
            using (Icon ico = Icon.ExtractAssociatedIcon(src))
            {
                if (ico == null) { Console.WriteLine("no icon"); return 2; }
                using (Bitmap bmp = ico.ToBitmap())
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(outPath));
                    bmp.Save(outPath, ImageFormat.Png);
                }
                Console.WriteLine("ok " + ico.Width + "x" + ico.Height);
                return 0;
            }
        }
        catch (Exception e)
        {
            Console.WriteLine("fail " + e.Message);
            return 1;
        }
    }
}
