/**
 * 自动续页测试。
 *
 * 覆盖三类高风险行为：
 *   1. 「下一章」链接识别——识别不准会加载错页面，识别太宽会乱跳
 *   2. **死循环防护**——这是最危险的一类：若 A→B→A 互指，会无限加载直到卡死浏览器
 *   3. 中文站点编码——GBK 站点用 UTF-8 解码会得到整页乱码
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Extract = require("../src/content/extract.js");
const AutoNext = require("../src/content/auto-next.js");
const FetchPage = require("../src/shared/fetch-page.js");

/** 造一个文档。 */
function doc(html, url = "https://novel.example/book/1/2.html") {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, { url }).window.document;
}

// ============================================================ 链接识别

test("链接识别：中文「下一章」", () => {
  const d = doc(`<div class="bottem"><a href="/book/1/1.html">上一章</a><a href="/book/1/">目录</a><a href="/book/1/3.html">下一章</a></div>`);
  const r = Extract.findNextLink(d, d.baseURI);
  assert.ok(r, "应找到下一章");
  assert.equal(r.url, "https://novel.example/book/1/3.html");
});

test("链接识别：英文 Next Page / Next Chapter", () => {
  for (const text of ["Next Page", "Next Chapter", "Next", "next page"]) {
    const d = doc(`<nav><a href="/a/2.html">${text}</a></nav>`, "https://s.example/a/1.html");
    const r = Extract.findNextLink(d, d.baseURI);
    assert.ok(r, `应识别 ${text}`);
    assert.equal(r.url, "https://s.example/a/2.html");
  }
});

test("链接识别：class=next 但文本平淡的链接", () => {
  const d = doc(`<a class="page-next" href="/p/3">继续</a>`, "https://s.example/p/2");
  const r = Extract.findNextLink(d, d.baseURI);
  assert.ok(r, "class 含 next 应被识别");
});

test("链接识别：不把「上一章」误判为下一章", () => {
  const d = doc(`<div><a href="/book/1.html">上一章</a></div>`);
  assert.equal(Extract.findNextLink(d, d.baseURI), null, "上一章不应被当作下一章");
});

test("链接识别：排除目录/书架/推荐等导航链接", () => {
  for (const text of ["目录", "书架", "收藏", "推荐阅读", "排行榜", "首页", "登录", "返回顶部"]) {
    const d = doc(`<div class="nav"><a href="/x/${encodeURIComponent(text)}">${text}</a></div>`);
    assert.equal(
      Extract.findNextLink(d, d.baseURI), null,
      `「${text}」不应被识别为下一章`
    );
  }
});

test("链接识别：拒绝跨站链接（自动跳站风险太大）", () => {
  const d = doc(`<a href="https://evil.example/next">下一章</a>`);
  assert.equal(Extract.findNextLink(d, d.baseURI), null, "跨站链接必须拒绝");
});

test("链接识别：拒绝指向自身的链接", () => {
  const d = doc(`<a href="/book/1/2.html">下一章</a>`);
  assert.equal(Extract.findNextLink(d, d.baseURI), null, "指向自身应拒绝（否则立即死循环）");
});

test("链接识别：拒绝 javascript:/mailto:/锚点", () => {
  const cases = [
    `<a href="#">下一章</a>`,
    `<a href="javascript:void(0)">下一章</a>`,
    `<a href="mailto:x@y.com">下一章</a>`,
  ];
  for (const html of cases) {
    const d = doc(html);
    assert.equal(Extract.findNextLink(d, d.baseURI), null, `不应识别：${html}`);
  }
});

test("链接识别：正文里的长文本链接不算翻页", () => {
  const d = doc(`<p><a href="/other">这是一个很长很长的正文内链接不应该被当作翻页按钮</a></p>`);
  assert.equal(Extract.findNextLink(d, d.baseURI), null);
});

test("链接识别：多候选时优先「下一章」而非普通 next 链接", () => {
  const d = doc(`
    <aside><a href="/promo" class="next">Next Article</a></aside>
    <div class="bottem"><a href="/book/1/3.html">下一章</a></div>
  `);
  const r = Extract.findNextLink(d, d.baseURI);
  assert.ok(r);
  assert.equal(r.url, "https://novel.example/book/1/3.html", "应选中真正的下一章");
});

test("链接识别：无任何翻页链接时返回 null", () => {
  const d = doc(`<p>正文</p><a href="/about">关于</a>`);
  assert.equal(Extract.findNextLink(d, d.baseURI), null);
});

// ============================================================ 死循环防护（最关键）

test("★ 防死循环：A→B→A 互指时必须在重复 URL 处停止", async () => {
  // 这是最危险的场景：两个页面互指，若无去重会无限加载
  const pages = {
    "https://s.example/1": `<a href="https://s.example/2">下一章</a>`,
    "https://s.example/2": `<a href="https://s.example/1">下一章</a>`,
  };

  let fetchCount = 0;
  const appended = [];

  const ctrl = AutoNext.createAutoNext({
    fetchPage: async (url) => {
      fetchCount++;
      if (fetchCount > 10) throw new Error("检测到无限循环！fetch 次数超过 10");
      return { ok: true, html: pages[url] || "", finalUrl: url };
    },
    parseArticle: (html, url) => ({
      ok: true,
      content: { textContent: `正文-${url}` },
      nextLink: /href="([^"]+)"/.exec(html)
        ? { url: /href="([^"]+)"/.exec(html)[1], text: "下一章" }
        : null,
    }),
    appendArticle: (a) => appended.push(a),
  });

  ctrl.setCurrentUrl("https://s.example/1");
  ctrl.reset({
    ok: true,
    content: { textContent: "首屏正文" },
    nextLink: { url: "https://s.example/2", text: "下一章" },
  });

  // 连续触发多次
  for (let i = 0; i < 6; i++) {
    await ctrl.maybeLoadNext();
  }

  const state = ctrl.getState();
  assert.ok(fetchCount <= 2, `最多只应抓取 2 次（1→2 后回到 1 就停），实际 ${fetchCount}`);
  assert.equal(state.stopped, true, "应已停止");
  assert.ok(appended.length <= 1, `最多追加 1 页，实际 ${appended.length}`);
});

test("★ 防死循环：内容重复（不同 URL 同一内容）也应停止", async () => {
  // 有些站点用不同 URL 指向同一内容（如 ?page=2 与 ?page=2&x=1）
  let fetchCount = 0;
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async (url) => {
      fetchCount++;
      return { ok: true, html: "<p>完全相同的正文内容</p>", finalUrl: url };
    },
    parseArticle: () => ({
      ok: true,
      content: { textContent: "完全相同的正文内容" },   // 每次都一样
      nextLink: { url: `https://s.example/next-${fetchCount}` },
    }),
    appendArticle: () => {},
  });

  ctrl.setCurrentUrl("https://s.example/start");
  ctrl.reset({
    ok: true,
    content: { textContent: "首屏正文" },
    nextLink: { url: "https://s.example/a" },
  });

  for (let i = 0; i < 5; i++) await ctrl.maybeLoadNext();

  const state = ctrl.getState();
  assert.ok(fetchCount <= 2, `内容重复应尽早停止，实际抓取 ${fetchCount} 次`);
  assert.equal(state.stopped, true);
});

test("★ 防死循环：达到 MAX_PAGES 上限后停止", async () => {
  let n = 0;
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async (url) => {
      n++;
      return { ok: true, html: "<p>x</p>", finalUrl: url };
    },
    parseArticle: () => ({
      ok: true,
      // 每次内容都不同，避免被内容去重拦下；URL 也一直变，避免被 URL 去重拦下
      content: { textContent: `独特的正文内容-${n}-${Math.random()}` },
      nextLink: { url: `https://s.example/p${n}` },
    }),
    appendArticle: () => {},
  });

  ctrl.setCurrentUrl("https://s.example/start");
  ctrl.reset({
    ok: true,
    content: { textContent: "首屏" },
    nextLink: { url: "https://s.example/p0" },
  });

  // 触发远超上限的次数
  for (let i = 0; i < AutoNext.MAX_PAGES + 20; i++) await ctrl.maybeLoadNext();

  const state = ctrl.getState();
  assert.ok(
    state.loadedCount <= AutoNext.MAX_PAGES,
    `加载页数不应超过上限 ${AutoNext.MAX_PAGES}，实际 ${state.loadedCount}`
  );
  assert.equal(state.stopped, true, "达上限后应停止");
});

// ============================================================ 并发与失败

test("★ 并发防护：同一时刻只允许一次加载", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;

  const ctrl = AutoNext.createAutoNext({
    fetchPage: async (url) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return { ok: true, html: "<p>x</p>", finalUrl: url };
    },
    parseArticle: () => ({
      ok: true,
      content: { textContent: `正文-${Math.random()}` },
      nextLink: { url: `https://s.example/${Math.random()}` },
    }),
    appendArticle: () => {},
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/a" } });

  // 模拟滚动事件连续触发
  await Promise.all([
    ctrl.maybeLoadNext(),
    ctrl.maybeLoadNext(),
    ctrl.maybeLoadNext(),
    ctrl.maybeLoadNext(),
  ]);

  assert.equal(maxConcurrent, 1, `不应并发抓取，实际最大并发 ${maxConcurrent}`);
});

test("失败熔断：连续失败后进入冷却，而不是永久停止", async () => {
  // 设计变更说明：最初实现是「连续失败 2 次即永久停止」。
  // 但实测遇到小说站的反爬限流——同一站点同一时刻，
  // 有的 URL 返回 200、有的返回 403。永久停止会让用户彻底用不了自动翻页。
  // 因此改为「暂停 + 冷却」：冷却期内不尝试，到期后自动恢复。
  let attempts = 0;
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => {
      attempts++;
      return { ok: false, reason: "network-error" };
    },
    parseArticle: () => ({ ok: true, content: { textContent: "x" }, nextLink: { url: "https://s.example/n" } }),
    appendArticle: () => {},
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/a" } });

  for (let i = 0; i < 10; i++) await ctrl.maybeLoadNext();

  assert.equal(
    attempts, AutoNext.MAX_CONSECUTIVE_FAILURES,
    `应在连续失败 ${AutoNext.MAX_CONSECUTIVE_FAILURES} 次后暂停，实际尝试 ${attempts} 次`
  );

  const state = ctrl.getState();
  assert.equal(state.coolingDown, true, "应处于冷却期");
  assert.ok(state.cooldownRemainingMs > 0, "冷却剩余时间应为正");
  assert.equal(state.stopped, false, "★ 不应永久停止（这是本次修复的重点）");
});

test("★ 403 时若禁用降级，按普通失败计数并冷却", async () => {
  // 设计说明：早期实现让 403 单独走「不计入熔断」的路径。
  // 但现在 403 会优先降级为导航；只有在显式禁用降级时才会走到计数逻辑。
  // 此时按普通失败处理更简单一致，也便于测试覆盖。
  let attempts = 0;
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => { attempts++; return { ok: false, reason: "http-error", status: 403 }; },
    parseArticle: () => ({ ok: false }),
    appendArticle: () => {},
    allowNavigate: false,
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/a" } });

  await ctrl.maybeLoadNext();
  assert.equal(attempts, 1, "第一次应尝试");
  assert.equal(ctrl.getState().failures, 1, "禁用降级时应计入失败");
  assert.equal(ctrl.getState().stopped, false, "不应停止");

  // 打满阈值后进入冷却
  for (let i = 0; i < AutoNext.MAX_CONSECUTIVE_FAILURES; i++) await ctrl.maybeLoadNext();
  assert.equal(ctrl.getState().coolingDown, true, "连续失败应进入冷却");
  assert.equal(ctrl.getState().stopped, false, "不应永久停止");
});

test("冷却期内不抓取，冷却到期后恢复", async () => {
  let attempts = 0;
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async (url) => {
      attempts++;
      // 先失败触发冷却，之后成功
      if (attempts <= AutoNext.MAX_CONSECUTIVE_FAILURES) {
        return { ok: false, reason: "network-error" };
      }
      return { ok: true, html: "<p>x</p>", finalUrl: url };
    },
    parseArticle: () => ({
      ok: true,
      content: { textContent: `内容-${Math.random()}` },
      nextLink: { url: `https://s.example/${Math.random()}` },
    }),
    appendArticle: () => {},
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/a" } });

  // 打到冷却
  for (let i = 0; i < AutoNext.MAX_CONSECUTIVE_FAILURES; i++) await ctrl.maybeLoadNext();
  assert.equal(ctrl.getState().coolingDown, true, "应进入冷却");

  const before = attempts;
  await ctrl.maybeLoadNext();
  assert.equal(attempts, before, "冷却期内不应抓取");
});

test("失败后成功应重置失败计数", async () => {
  let call = 0;
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async (url) => {
      call++;
      if (call === 1) return { ok: false, reason: "network-error" };
      return { ok: true, html: "<p>x</p>", finalUrl: url };
    },
    parseArticle: () => ({
      ok: true,
      content: { textContent: `内容-${Math.random()}` },
      nextLink: { url: `https://s.example/${Math.random()}` },
    }),
    appendArticle: () => {},
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/a" } });

  await ctrl.maybeLoadNext();   // 失败
  assert.equal(ctrl.getState().failures, 1);
  await ctrl.maybeLoadNext();   // 成功
  assert.equal(ctrl.getState().failures, 0, "成功后应重置失败计数");
  assert.equal(ctrl.getState().stopped, false, "不应因单次失败就停止");
});

test("开关：关闭后不再加载，重新开启可继续", async () => {
  let fetches = 0;
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async (url) => {
      fetches++;
      return { ok: true, html: "<p>x</p>", finalUrl: url };
    },
    parseArticle: () => ({
      ok: true,
      content: { textContent: `内容-${Math.random()}` },
      nextLink: { url: `https://s.example/${Math.random()}` },
    }),
    appendArticle: () => {},
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/a" } });

  ctrl.setEnabled(false);
  await ctrl.maybeLoadNext();
  assert.equal(fetches, 0, "关闭时不应抓取");

  ctrl.setEnabled(true);
  await ctrl.maybeLoadNext();
  assert.equal(fetches, 1, "重新开启后应可继续");
});

test("首屏无下一章链接时直接标记为末尾", () => {
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => ({ ok: false, reason: "x" }),
    parseArticle: () => ({ ok: false }),
    appendArticle: () => {},
  });

  ctrl.reset({ ok: true, content: { textContent: "只有一页" }, nextLink: null });
  const s = ctrl.getState();
  assert.equal(s.stopped, true);
  assert.equal(s.hasNext, false);
  assert.equal(s.status.state, "end");
});

test("抓取失败时状态提示是可读文案", async () => {
  const statuses = [];
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => ({ ok: false, reason: "timeout" }),
    parseArticle: () => ({ ok: false }),
    appendArticle: () => {},
    onStatus: (s) => statuses.push(s),
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/a" } });
  await ctrl.maybeLoadNext();

  const errStatus = statuses.find((s) => s.state === "error");
  assert.ok(errStatus, "应有错误状态");
  assert.match(errStatus.message, /超时/, `错误文案应可读：${errStatus.message}`);
});

test("URL 规范化：忽略 hash 以正确去重", () => {
  assert.equal(
    AutoNext.normalizeUrl("https://a.example/x#top"),
    AutoNext.normalizeUrl("https://a.example/x#bottom"),
    "仅 hash 不同应视为同一 URL"
  );
  assert.notEqual(
    AutoNext.normalizeUrl("https://a.example/x"),
    AutoNext.normalizeUrl("https://a.example/y")
  );
});

// ============================================================ 编码处理

test("★ 编码：从 HTTP 头识别 charset", () => {
  assert.equal(FetchPage.charsetFromHeader("text/html; charset=gbk"), "gbk");
  assert.equal(FetchPage.charsetFromHeader('text/html; charset="GB2312"'), "gb2312");
  assert.equal(FetchPage.charsetFromHeader("text/html"), null);
});

test("★ 编码：从 HTML meta 嗅探 charset", () => {
  const enc = (s) => new TextEncoder().encode(s);

  assert.equal(
    FetchPage.charsetFromHtml(enc('<html><head><meta charset="gbk">')),
    "gbk"
  );
  assert.equal(
    FetchPage.charsetFromHtml(enc('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">')),
    "gb2312"
  );
  assert.equal(FetchPage.charsetFromHtml(enc("<html><body>无声明</body>")), null);
});

test("★ 编码：GBK 字节用 GBK 解码，中文不乱码", () => {
  // 「中文测试」的 GBK 字节
  const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
  const decoded = FetchPage.decodeBytes(gbkBytes, "gbk");
  assert.equal(decoded, "中文测试", `GBK 解码应正确，实际：${decoded}`);
});

test("★ 编码：用 UTF-8 解码 GBK 字节会乱码（说明为何必须嗅探）", () => {
  const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
  const wrong = FetchPage.decodeBytes(gbkBytes, "utf-8");
  assert.notEqual(wrong, "中文测试", "用错编码确实会得到错误结果");
  assert.ok(
    FetchPage.looksMisdecoded(wrong) || /\uFFFD/.test(wrong),
    "错误解码应能被 looksMisdecoded 识别为可疑"
  );
});

test("编码：别名规范化", () => {
  assert.equal(FetchPage.normalizeCharset("GB2312"), "gbk");
  assert.equal(FetchPage.normalizeCharset("gb-2312"), "gbk");
  assert.equal(FetchPage.normalizeCharset("UTF8"), "utf-8");
  assert.equal(FetchPage.normalizeCharset(""), null);
  assert.equal(FetchPage.normalizeCharset(null), null);
});

test("编码：非法/未知编码名不抛错，回退可用", () => {
  const bytes = new TextEncoder().encode("hello");
  const out = FetchPage.decodeBytes(bytes, "完全不是编码名");
  assert.equal(out, "hello", "未知编码应回退并正常解码");
});

test("编码：looksMisdecoded 判断替换字符密度", () => {
  assert.equal(FetchPage.looksMisdecoded("正常的中文内容"), false);
  assert.equal(FetchPage.looksMisdecoded("\uFFFD".repeat(50)), true);
});

test("抓取：非法 URL 直接拒绝，不发起请求", async () => {
  for (const bad of ["", "not-a-url", "ftp://x.com/a", "javascript:alert(1)", null]) {
    const r = await FetchPage.fetchPage(bad);
    assert.equal(r.ok, false, `非法 URL 应被拒绝：${bad}`);
    assert.equal(r.reason, "bad-url");
  }
});

// ============================================================ 导航降级（Cloudflare 场景）

test("★ 抓取被 Cloudflare 拦截（403）时降级为真实导航", async () => {
  // 背景：实测启用 Cloudflare 的站点会对扩展请求返回 403
  // （响应头 Cf-Mitigated: challenge），且携带完整 cookie 的
  // credentials:include 同样被拒 —— CF 校验的是浏览器环境指纹。
  // 唯一可行路径是真实浏览器导航（等同于用户手点链接）。
  const navigated = [];
  const statuses = [];

  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => ({ ok: false, reason: "http-error", status: 403 }),
    parseArticle: () => ({ ok: false }),
    appendArticle: () => {},
    navigateTo: (url) => navigated.push(url),
    onStatus: (s) => statuses.push(s),
  });

  ctrl.reset({
    ok: true,
    content: { textContent: "首屏" },
    nextLink: { url: "https://cf.example/ch2" },
  });

  await ctrl.maybeLoadNext();
  // navigateTo 是延迟执行的，等一下
  await new Promise((r) => setTimeout(r, 500));

  assert.deepEqual(navigated, ["https://cf.example/ch2"], "应降级为导航到下一页");
  const last = statuses.at(-1);
  assert.match(last.message, /跳转|验证/, `应提示正在跳转：${last.message}`);
});

test("★ 403 时若不允许导航，则冷却而非永久停止", async () => {
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => ({ ok: false, reason: "http-error", status: 403 }),
    parseArticle: () => ({ ok: false }),
    appendArticle: () => {},
    allowNavigate: false,   // 禁用降级
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://x.example/a" } });
  await ctrl.maybeLoadNext();

  const s = ctrl.getState();
  assert.equal(s.stopped, false, "不应永久停止");
  assert.equal(s.failures, 1, "禁用降级后应计入失败次数");
});

test("★ 403 禁用降级时，连续失败进入冷却", async () => {
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => ({ ok: false, reason: "http-error", status: 403 }),
    parseArticle: () => ({ ok: false }),
    appendArticle: () => {},
    allowNavigate: false,
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://x.example/a" } });
  for (let i = 0; i < AutoNext.MAX_CONSECUTIVE_FAILURES; i++) await ctrl.maybeLoadNext();

  const s = ctrl.getState();
  assert.equal(s.coolingDown, true, "应进入冷却");
  assert.equal(s.stopped, false, "不应永久停止");
});

test("导航降级：429（限流）同样触发", async () => {
  const navigated = [];
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => ({ ok: false, reason: "http-error", status: 429 }),
    parseArticle: () => ({ ok: false }),
    appendArticle: () => {},
    navigateTo: (url) => navigated.push(url),
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://x.example/a" } });
  await ctrl.maybeLoadNext();
  await new Promise((r) => setTimeout(r, 500));

  assert.deepEqual(navigated, ["https://x.example/a"], "429 也应降级导航");
});

test("导航降级：网络错误也降级为导航（CORP 场景无状态码）", async () => {
  // 重要：站点返回 `Cross-Origin-Resource-Policy: same-origin` 时，
  // 扩展发出的跨源请求会在 CORP 检查阶段被终止，**连服务器都到不了**，
  // 因此没有 HTTP 状态码，只有「网络错误」。
  // 若只对 403/429 降级，这类站点就会永远卡在「网络错误 + 冷却」而不跳转。
  const navigated = [];
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => ({ ok: false, reason: "network-error" }),
    parseArticle: () => ({ ok: false }),
    appendArticle: () => {},
    navigateTo: (url) => navigated.push(url),
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://x.example/a" } });
  await ctrl.maybeLoadNext();
  await new Promise((r) => setTimeout(r, 500));

  assert.deepEqual(navigated, ["https://x.example/a"], "网络错误也应降级为导航");
});

test("导航降级：禁用降级时网络错误走冷却", async () => {
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async () => ({ ok: false, reason: "network-error" }),
    parseArticle: () => ({ ok: false }),
    appendArticle: () => {},
    allowNavigate: false,
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://x.example/a" } });
  for (let i = 0; i < AutoNext.MAX_CONSECUTIVE_FAILURES; i++) await ctrl.maybeLoadNext();

  const s = ctrl.getState();
  assert.equal(s.coolingDown, true, "应进入冷却");
  assert.equal(s.stopped, false, "不应永久停止");
});

test("导航降级：成功抓取时不应触发导航", async () => {
  const navigated = [];
  const ctrl = AutoNext.createAutoNext({
    fetchPage: async (url) => ({ ok: true, html: "<p>x</p>", finalUrl: url }),
    parseArticle: () => ({
      ok: true,
      content: { textContent: `内容-${Math.random()}` },
      nextLink: null,
    }),
    appendArticle: () => {},
    navigateTo: (url) => navigated.push(url),
  });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://x.example/a" } });
  await ctrl.maybeLoadNext();
  await new Promise((r) => setTimeout(r, 400));

  assert.deepEqual(navigated, [], "能抓取时不该跳页");
});

// ============================================================ 预加载

/** 造一个可复用的控制器：记录 fetch 次数，内容各不相同。 */
function makePrefetchCtrl(opts) {
  const options = opts || {};
  const fetches = [];
  const appended = [];
  let seq = 0;

  const ctrl = AutoNext.createAutoNext({
    fetchPage: async (url) => {
      fetches.push(url);
      if (options.failOn && options.failOn(url)) {
        return { ok: false, reason: "http-error", status: 403 };
      }
      // 加一点延迟，模拟真实网络
      await new Promise((r) => setTimeout(r, options.latency || 10));
      return { ok: true, html: `<p>${url}</p>`, finalUrl: url };
    },
    parseArticle: (html, url) => {
      seq++;
      return {
        ok: true,
        // 每个 URL 的内容都不同，避免被内容去重拦下
        content: { textContent: `正文-${url}-${seq}` },
        // 注意：下一章 URL 必须与当前页**真正不同**。
        // 若写成 `${url}#next`，normalizeUrl 会剥掉 hash 后判定为同一页，
        // 被去重机制拦下（那是正确行为，但会让测试失去意义）。
        nextLink: options.noNext ? null : { url: `${url}-next` },
      };
    },
    appendArticle: (a) => appended.push(a),
    navigateTo: options.navigateTo,
    // 测试里让预加载立即发生，不依赖真实计时（浏览器里默认 1200ms 空闲延迟）
    prefetchDelayMs: 0,
  });

  return { ctrl, fetches, appended };
}

test("★ 预加载：reset 后会自动预取下一章（读到底零等待）", async () => {
  const { ctrl, fetches } = makePrefetchCtrl();

  ctrl.reset({
    ok: true,
    content: { textContent: "首屏" },
    nextLink: { url: "https://s.example/ch2" },
  });

  // 等待预加载完成
  await new Promise((r) => setTimeout(r, 300));

  assert.deepEqual(fetches, ["https://s.example/ch2"], "应在后台预取下一章");
  const s = ctrl.getState();
  assert.equal(s.prefetchReady, true, "应标记为已预加载");
  assert.equal(s.prefetchUrl, "https://s.example/ch2");
  assert.equal(s.loadedCount, 0, "预加载不应增加已加载页数（还没插入）");
});

test("★ 预加载：命中缓存时不再发起网络请求（这是消除顿挫的关键）", async () => {
  const { ctrl, fetches, appended } = makePrefetchCtrl();

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/ch2" } });
  await new Promise((r) => setTimeout(r, 300));

  const fetchesBefore = fetches.length;
  assert.equal(fetchesBefore, 1, "预加载应已抓取一次");

  // 用户读到底 → 应直接用缓存，不再抓取
  const r = await ctrl.maybeLoadNext();

  assert.equal(r.loaded, true, "应成功插入");
  assert.equal(fetches.length, fetchesBefore, "★ 命中缓存时不应再发起网络请求");
  assert.equal(appended.length, 1, "应追加了一章");
});

test("预加载：插入后会自动为「再下一章」预取，保持领先一章", async () => {
  const { ctrl, fetches } = makePrefetchCtrl();

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/ch2" } });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(fetches, ["https://s.example/ch2"], "先预取 ch2");

  await ctrl.maybeLoadNext();          // 用缓存插入 ch2
  await new Promise((r) => setTimeout(r, 300));   // 等「再下一章」的预加载

  // 插入后应立即为下一章（ch2 的 nextLink，即 ch2-next）预取，
  // 这样用户读到 ch2 末尾时同样是零等待 —— 始终领先一章。
  assert.equal(fetches.length, 2, `插入后应触发下一次预取，实际：${fetches.join(", ")}`);
  assert.ok(
    fetches[1].includes("ch2-next"),
    `应为「再下一章」预取，实际：${fetches.join(", ")}`
  );
  assert.equal(ctrl.getState().prefetchReady, true, "应已备好下一章");
});

test("预加载：不重复抓取同一目标", async () => {
  const { ctrl, fetches } = makePrefetchCtrl();

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/ch2" } });
  await new Promise((r) => setTimeout(r, 250));
  const n1 = fetches.length;

  // 反复触发预加载
  await ctrl.prefetch();
  await ctrl.prefetch();
  await ctrl.prefetch();

  assert.equal(fetches.length, n1, "已有缓存时不应重复抓取");
});

test("预加载：失败时静默（不打扰阅读，也不影响后续正常加载）", async () => {
  const statuses = [];
  const { ctrl, fetches } = makePrefetchCtrl({ failOn: () => true });

  // 包一层捕获状态
  const origReset = ctrl.reset;
  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/ch2" } });
  await new Promise((r) => setTimeout(r, 300));

  const s = ctrl.getState();
  assert.equal(s.prefetchReady, false, "失败时不应有缓存");
  assert.equal(s.stopped, false, "★ 预加载失败不应导致停止");
  assert.equal(s.status.state, "idle", "★ 预加载失败不应弹错误提示（静默）");
  assert.ok(fetches.length >= 1, "确实尝试过抓取");
});

test("预加载：nextLink 变化后旧缓存失效", async () => {
  const { ctrl, fetches } = makePrefetchCtrl();

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/ch2" } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ctrl.getState().prefetchUrl, "https://s.example/ch2");

  // 模拟链接变化（例如页面内跳转导致 nextLink 更新）
  ctrl.clearPrefetch();
  assert.equal(ctrl.getState().prefetchReady, false, "清空后不应再有缓存");
});

test("预加载：开关关闭时不预取", async () => {
  const { ctrl, fetches } = makePrefetchCtrl();

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/ch2" } });
  ctrl.setEnabled(false);
  await ctrl.prefetch();
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(fetches.length, 0, "关闭时不应预取");
});

test("预加载：无下一章时不预取", async () => {
  const { ctrl, fetches } = makePrefetchCtrl({ noNext: true });

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: null });
  await ctrl.prefetch();
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(fetches.length, 0, "没有下一章时不应抓取");
  assert.equal(ctrl.getState().stopped, true, "应标记为已到末尾");
});

test("预加载：stop() 会取消排程并清空缓存", async () => {
  const { ctrl, fetches } = makePrefetchCtrl();

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/ch2" } });
  ctrl.stop();
  await new Promise((r) => setTimeout(r, 300));

  const s = ctrl.getState();
  assert.equal(s.prefetchReady, false, "停止后应无缓存");
});

test("预加载：缓存命中时不显示「正在加载」状态", async () => {
  const statuses = [];
  const { ctrl } = makePrefetchCtrl();

  ctrl.reset({ ok: true, content: { textContent: "首屏" }, nextLink: { url: "https://s.example/ch2" } });
  await new Promise((r) => setTimeout(r, 300));

  await ctrl.maybeLoadNext();
  // 命中缓存路径不应设置 loading 状态
  const s = ctrl.getState();
  assert.equal(s.loading, false, "缓存命中后不应残留 loading 状态");
});

// ============================================================ 内容指纹

test("指纹：忽略空白与零宽字符", () => {
  const a = AutoNext.contentFingerprint("中文  内容\n\n测试");
  const b = AutoNext.contentFingerprint("中文内容测试");
  assert.equal(a, b, "空白差异不应影响指纹");
});

test("指纹：不同内容指纹不同", () => {
  assert.notEqual(
    AutoNext.contentFingerprint("第一章内容"),
    AutoNext.contentFingerprint("第二章内容")
  );
});
