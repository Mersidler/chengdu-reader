/**
 * 真机验证收集器。
 *
 * 为什么需要它：headless Firefox 的 --screenshot 在本机失败（GFX1 错误），
 * 而 Firefox 的远程调试端口走的是 WebDriver BiDi（不是 CDP），
 * 从 Node 侧读取页面结果不方便。最可靠的办法是让验证页把结果
 * **主动 POST 回来**，服务器落盘，我们再读文件。
 *
 * 路由：
 *   GET  /verify-tts.html          验证页
 *   GET  /sample-tts.mp3           真实 TTS 音频样本
 *   POST /result                   验证结果（JSON body）
 *   GET  /result                   读取已收到的结果
 *
 * 用法：node tests/devtools/verify-collector.cjs [port]
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.argv[2] || 8901);
const HERE = __dirname;
const OUT = path.join(HERE, "verify-result.json");

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // 结果回传
  if (url === "/result" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        fs.writeFileSync(OUT, body, "utf8");
        console.log("收到验证结果，已写入 " + OUT);
      } catch (e) {
        console.log("写结果失败: " + e.message);
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }

  if (url === "/result") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(fs.readFileSync(OUT, "utf8"));
    } catch (_) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no result yet");
    }
    return;
  }

  // 静态文件
  const map = {
    "/verify-tts.html": path.join(HERE, "verify-tts.html"),
    "/sample-tts.mp3": path.join(HERE, "sample-tts.mp3"),
  };
  const file = map[url];
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("missing file: " + file);
      return;
    }
    const type = file.endsWith(".mp3") ? "audio/mpeg" : "text/html; charset=utf-8";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("验证收集器: http://127.0.0.1:" + PORT + "/verify-tts.html");
});
