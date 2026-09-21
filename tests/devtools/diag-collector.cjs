/** 诊断收集器：服务 diag-audio.html + sample-tts.mp3，接收 /result。 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const PORT = Number(process.argv[2] || 8902);
const HERE = __dirname;
const OUT = path.join(HERE, "diag-result.json");

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/result" && req.method === "POST") {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => { fs.writeFileSync(OUT, b); console.log("收到结果"); res.writeHead(204); res.end(); });
    return;
  }
  const map = {
    "/diag-audio.html": path.join(HERE, "diag-audio.html"),
    "/sample-tts.mp3": path.join(HERE, "sample-tts.mp3"),
  };
  const f = map[url];
  if (!f) { res.writeHead(404); res.end("nf"); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end("miss"); return; }
    res.writeHead(200, { "Content-Type": f.endsWith(".mp3") ? "audio/mpeg" : "text/html; charset=utf-8" });
    res.end(d);
  });
}).listen(PORT, "127.0.0.1", () => console.log("diag collector: http://127.0.0.1:" + PORT + "/diag-audio.html"));
