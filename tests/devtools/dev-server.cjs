/**
 * 统一测试服务器：同时服务**扩展源码**与**多章节小说站**。
 *
 * 为什么必须同一个源：
 *   浏览器里跨端口 fetch 会受 CORS 限制（8898 → 8899 会被拒），
 *   而扩展脚本需要从同源取源码才能用 <script> 注入到页面。
 *   这个限制本身也印证了「抓取必须走 background」的设计。
 *
 * 路由：
 *   /src/...            扩展源码（原样返回，text/javascript）
 *   /book/1/            章节目录
 *   /book/1/chN.html    章节页（声明 GBK，用于验证编码嗅探路径）
 *   /dirty.html         单页脏页面（沿用既有的手工验证样本）
 *
 * 用法：node tests/devtools/dev-server.cjs [port]
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.argv[2] || 8899);
const ROOT = path.join(__dirname, "..", "..");
const TOTAL_CHAPTERS = 5;

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
};

// ---------------------------------------------------------------- 小说站内容

function chapterBody(n) {
  return [
    `第 ${n} 章　山道上的雨`,
    `陈休背起行囊，沿着山道往上走。雨丝斜斜地打在脸上，凉意顺着领口钻进来。他抬头看了看天色，灰蒙蒙的一片，看不出要停的意思。`,
    ``,
    `这条山路他走过许多回。春天的时候两旁开满野花，夏天有浓密的树荫，秋天落叶铺满石阶。只有冬天最难看，光秃秃的枝丫伸向天空，像无数只枯瘦的手。`,
    `&nbsp;`,
    `​​​`,
    `"再走半个时辰就到了。"陈休自言自语，加快了脚步。他记得前面有座废弃的山神庙，可以避一避雨。`,
    `庙里果然干燥。他放下行囊，靠着斑驳的墙坐下，从怀里摸出干粮啃了两口。`,
    ``,
    `雨声渐渐密了。屋顶有几处漏，水滴落在青石板上，发出清脆的声响。陈休听着这声音，忽然想起很多年前的一个下午。`,
    `那时候他还小，跟着师父走这条山路。师父走得很慢，一边走一边给他讲山里的草木虫鱼。`,
    `"万物有灵。"师父说，"你敬它三分，它便让你三分。"`,
    `陈休当时不懂，现在似乎懂了一点。`,
    ``,
    `雨停的时候已经是傍晚。他走出庙门，看见西边的云裂开一道口子，金光斜斜地洒下来，把湿漉漉的山道照得发亮。`,
    `他深吸一口气，继续往上走。雨后的空气里有泥土和青草的味道，让人觉得活着是件不错的事。`,
  ];
}

function chapterHtml(n) {
  const hasPrev = n > 1;
  const hasNext = n < TOTAL_CHAPTERS;

  const nav = [
    hasPrev
      ? `<a href="/book/1/ch${n - 1}.html">上一章</a>`
      : `<a href="/book/1/">目录</a>`,
    `<a href="/book/1/">目录</a>`,
    hasNext
      ? `<a href="/book/1/ch${n + 1}.html">下一章</a>`
      : `<span>已是最后一章</span>`,
  ].join("　");

  const body = chapterBody(n)
    .map((line) => {
      if (line === "") return "<p></p>";
      if (line === "&nbsp;") return "<p>&nbsp;</p>";
      if (line === "​​​") return "<p>​​​</p>";
      if (line.startsWith("第 ")) return `<h2>${line}</h2>`;
      return `<p>${line}</p>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>第 ${n} 章　山道上的雨 - 测试小说站</title>
<style>
  body { font-family: sans-serif; margin: 0; background: #f0f0f0; }
  .header { background: #fff; padding: 10px 20px; border-bottom: 1px solid #ddd; }
  .content { max-width: 800px; margin: 20px auto; background: #fff; padding: 24px 32px; }
  .content p { margin: 30px 0; line-height: 1.9; font-size: 17px; }
  .bottem { max-width: 800px; margin: 20px auto; padding: 16px; background: #fff; text-align: center; }
  .bottem a { margin: 0 10px; color: #06c; }
  .footer { text-align: center; color: #999; font-size: 12px; padding: 30px; }
  .ad { background: #fffbe6; border: 1px solid #ffe58f; padding: 12px; max-width: 800px; margin: 20px auto; }
</style>
</head>
<body>
<div class="header"><a href="/book/1/">测试小说站</a> · 第 ${n} 章</div>
<div class="content">
${body}
</div>
<div class="bottem">${nav}</div>
<div class="ad">这里是广告，阅读模式应当去掉它。</div>
<div class="footer">本站内容仅供自动续页功能测试使用</div>
</body>
</html>`;
}

// ---------------------------------------------------------------- 服务器

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);

  // 章节目录
  if (url === "/book/1" || url === "/book/1/") {
    const links = Array.from(
      { length: TOTAL_CHAPTERS },
      (_, i) => `<li><a href="/book/1/ch${i + 1}.html">第 ${i + 1} 章　山道上的雨</a></li>`
    ).join("\n");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>目录</title></head><body><h1>山道上的雨</h1><ul>${links}</ul></body></html>`);
    return;
  }

  // 章节页
  const m = /^\/book\/1\/ch(\d+)\.html$/.exec(url);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > TOTAL_CHAPTERS) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("chapter not found");
      return;
    }
    // 加一点延迟，模拟真实网络，便于观察「加载中」状态
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(chapterHtml(n));
    }, 120);
    return;
  }

  // 扩展源码 / 静态文件
  if (url === "/" ) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>测试入口</title></head><body>
<h1>澄读 测试服务器</h1>
<ul>
  <li><a href="/book/1/ch1.html">多章节小说（自动续页测试，共 ${TOTAL_CHAPTERS} 章）</a></li>
  <li><a href="/tests/devtools/dirty-page.html">脏页面（空行清理测试）</a></li>
</ul></body></html>`);
    return;
  }

  const filePath = path.join(ROOT, url);
  // 防目录穿越
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found: " + url);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`测试服务器: http://127.0.0.1:${PORT}/`);
  console.log(`  · 小说（${TOTAL_CHAPTERS} 章）: http://127.0.0.1:${PORT}/book/1/ch1.html`);
  console.log(`  · 脏页面: http://127.0.0.1:${PORT}/tests/devtools/dirty-page.html`);
  console.log(`  · 扩展源码: /src/... （同源，便于注入验证）`);
});
