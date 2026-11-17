// Stands in for nano-studio-cut.exe in verify/cut-rust-launch.mjs (compiled there with the .NET Framework's csc.exe,
// which every Windows has). It writes <CUT_STUB_DIR>\<pid>.json with its arguments, working folder and the CUT_*
// variables it was given, then stays CUT_STUB_MS (8000) and exits with CUT_STUB_EXIT (0).
using System;
using System.IO;
using System.Text;
using System.Threading;

static class Stub {
  static string Q(string s) {
    if (s == null) return "null";
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < ' ') b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static int Main(string[] args) {
    var dir = Environment.GetEnvironmentVariable("CUT_STUB_DIR");
    var names = new[] { "CUT_HOME", "CUT_SIDECAR_DIR", "CUT_CLAUDE_PATH", "CUT_STUDIO_SETTINGS", "CUT_STUDIO_APP", "CUT_STUDIO_VERSION", "PYIDE_CUT_JS" };
    var json = new StringBuilder("{\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id);
    json.Append(",\"cwd\":").Append(Q(Environment.CurrentDirectory)).Append(",\"args\":[");
    for (int i = 0; i < args.Length; i++) json.Append(i > 0 ? "," : "").Append(Q(args[i]));
    json.Append("],\"env\":{");
    for (int i = 0; i < names.Length; i++) json.Append(i > 0 ? "," : "").Append(Q(names[i])).Append(':').Append(Q(Environment.GetEnvironmentVariable(names[i])));
    json.Append("}}");
    if (!string.IsNullOrEmpty(dir)) {
      var file = Path.Combine(dir, System.Diagnostics.Process.GetCurrentProcess().Id + ".json");
      File.WriteAllText(file + ".tmp", json.ToString(), new UTF8Encoding(false));
      File.Move(file + ".tmp", file);
    }
    int ms, code;
    Thread.Sleep(int.TryParse(Environment.GetEnvironmentVariable("CUT_STUB_MS"), out ms) ? ms : 8000);
    return int.TryParse(Environment.GetEnvironmentVariable("CUT_STUB_EXIT"), out code) ? code : 0;
  }
}
