/**
 * 安全净化测试。
 *
 * 背景：Readability **不会**剥离 `on*` 内联事件属性，而阅读视图直接挂在页面 DOM 上。
 * 实测确认 `<img src=x onerror=...>` 会原样进入阅读视图并真实执行。
 * 因此净化是必需步骤，且必须独立于「空行清理」开关。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DomUtils = require("../src/content/clean/dom-utils.js");
const CleanBlank = require("../src/content/clean/clean-blank.js");
const Extract = require("../src/content/extract.js");

/** 构造一棵 DOM 容器。 */
function mount(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="root">${html}</div></body></html>`, {
    url: "https://evil.example/page",
  });
  return dom.window.document.getElementById("root");
}

/** 断言 HTML 中不含任何可执行内容。 */
function assertClean(root, label) {
  const html = root.innerHTML;
  const lowered = html.toLowerCase();

  assert.ok(!/\son[a-z]+\s*=/.test(lowered), `${label}：残留内联事件属性 → ${html}`);
  assert.ok(!/javascript:/i.test(lowered), `${label}：残留 javascript: 协议 → ${html}`);
  assert.ok(!/<script/i.test(lowered), `${label}：残留 <script> → ${html}`);
  assert.ok(!/<iframe/i.test(lowered), `${label}：残留 <iframe> → ${html}`);
  assert.ok(!/<object/i.test(lowered), `${label}：残留 <object> → ${html}`);
  assert.ok(!/<embed/i.test(lowered), `${label}：残留 <embed> → ${html}`);
  assert.ok(!/<base/i.test(lowered), `${label}：残留 <base> → ${html}`);
}

// ============================================================ 标签净化

test("净化：移除 script / iframe / object / embed / base", () => {
  const root = mount(`
    <p>正文</p>
    <script>window.x=1</script>
    <iframe src="https://evil.example/frame"></iframe>
    <object data="evil.swf"></object>
    <embed src="evil.swf">
    <base href="https://evil.example/">
    <p>结尾</p>
  `);
  const stats = DomUtils.sanitize(root);

  assertClean(root, "标签净化");
  assert.ok(stats.tags >= 5, `应移除至少 5 个危险标签，实际 ${stats.tags}`);
  assert.match(root.textContent, /正文/);
  assert.match(root.textContent, /结尾/);
});

test("净化：svg 内的 script 被移除但 svg 本身保留", () => {
  const root = mount(`
    <p>正文</p>
    <svg viewBox="0 0 10 10"><script>window.x=1</script><circle cx="5" cy="5" r="4"/></svg>
  `);
  DomUtils.sanitize(root);

  assert.equal(root.querySelectorAll("script").length, 0, "svg 内的 script 必须被移除");
  assert.equal(root.querySelectorAll("svg").length, 1, "svg 本身是视觉内容，应保留");
  assert.equal(root.querySelectorAll("circle").length, 1, "svg 内部图形应保留");
});

test("净化：<noscript> 内的内容不会变成可执行标签", () => {
  const root = mount(`<p>正文</p><noscript><img src="x" onerror="window.x=1"></noscript>`);
  DomUtils.sanitize(root);
  assertClean(root, "noscript");
});

// ============================================================ 属性净化

test("净化：移除所有 on* 内联事件处理器", () => {
  const root = mount(`
    <p onclick="x()" onmouseover="y()">正文</p>
    <img src="https://evil.example/a.png" onerror="z()" onload="w()">
    <a href="https://example.com" onfocus="f()">链接</a>
  `);
  const stats = DomUtils.sanitize(root);

  assertClean(root, "事件属性净化");
  assert.equal(stats.attrs, 5, `应移除 5 个事件属性，实际 ${stats.attrs}`);
  // 非事件属性必须完好
  assert.equal(root.querySelector("img").getAttribute("src"), "https://evil.example/a.png");
  assert.equal(root.querySelector("a").getAttribute("href"), "https://example.com");
});

test("净化：移除 javascript: / vbscript: 协议链接", () => {
  const root = mount(`
    <a href="javascript:alert(1)">一</a>
    <a href="JavaScript:alert(2)">二</a>
    <a href="  javascript:alert(3)">三</a>
    <a href="java&#9;script:alert(4)">四</a>
    <a href="vbscript:msgbox(1)">五</a>
    <a href="data:text/html,<script>alert(1)</script>">六</a>
    <a href="https://example.com/ok">正常链接</a>
  `);
  const stats = DomUtils.sanitize(root);

  assertClean(root, "协议净化");
  assert.ok(stats.urls >= 6, `应移除至少 6 个危险 URL，实际 ${stats.urls}`);

  const links = [...root.querySelectorAll("a")];
  const survivingHrefs = links.map((a) => a.getAttribute("href")).filter(Boolean);
  assert.deepEqual(survivingHrefs, ["https://example.com/ok"], `只有正常链接应保留：${survivingHrefs}`);
});

test("净化：移除 srcdoc 内联文档", () => {
  const root = mount(`<div><iframe srcdoc="<script>alert(1)</script>"></iframe></div>`);
  DomUtils.sanitize(root);
  assertClean(root, "srcdoc");
});

test("净化：_top / _parent 的 target 被改写为 _blank", () => {
  const root = mount(`
    <a href="https://a.example" target="_top">一</a>
    <a href="https://b.example" target="_parent">二</a>
    <a href="https://c.example" target="_blank">三</a>
  `);
  DomUtils.sanitize(root);

  const targets = [...root.querySelectorAll("a")].map((a) => a.getAttribute("target"));
  assert.deepEqual(targets, ["_blank", "_blank", "_blank"], "顶层导航目标应被改写");
});

test("净化：isEventHandlerAttr 判定", () => {
  assert.equal(DomUtils.isEventHandlerAttr("onclick"), true);
  assert.equal(DomUtils.isEventHandlerAttr("onerror"), true);
  assert.equal(DomUtils.isEventHandlerAttr("on"), true);
  assert.equal(DomUtils.isEventHandlerAttr("once"), true, "以 on 开头即视为事件属性（保守）");
  assert.equal(DomUtils.isEventHandlerAttr("href"), false);
  assert.equal(DomUtils.isEventHandlerAttr("src"), false);
  assert.equal(DomUtils.isEventHandlerAttr("align"), false, "align 不以 on 开头");
});

test("净化：isDangerousUrl 判定（含控制字符绕过）", () => {
  assert.equal(DomUtils.isDangerousUrl("javascript:alert(1)"), true);
  assert.equal(DomUtils.isDangerousUrl(" JAVASCRIPT:alert(1)"), true);
  assert.equal(DomUtils.isDangerousUrl("java\tscript:alert(1)"), true, "制表符绕过必须被识别");
  assert.equal(DomUtils.isDangerousUrl("java\nscript:alert(1)"), true, "换行绕过必须被识别");
  assert.equal(DomUtils.isDangerousUrl("data:text/html,<b>"), true);
  assert.equal(DomUtils.isDangerousUrl("https://example.com"), false);
  assert.equal(DomUtils.isDangerousUrl("/relative/path"), false);
  assert.equal(DomUtils.isDangerousUrl("#anchor"), false);
  assert.equal(DomUtils.isDangerousUrl(""), false);
  assert.equal(DomUtils.isDangerousUrl("data:image/png;base64,AAA"), false, "图片 data URL 应放行");
});

// ============================================================ 不误伤

test("净化：正常内容与图片完全不受影响", () => {
  const root = mount(`
    <h2>标题</h2>
    <p>正文段落。</p>
    <img src="https://example.com/photo.jpg" alt="照片" width="800">
    <a href="https://example.com/next">下一页</a>
    <pre><code>const a = 1;</code></pre>
    <table><tbody><tr><td>单元格</td></tr></tbody></table>
    <textarea>表单文本</textarea>
  `);
  const before = root.innerHTML;
  const stats = DomUtils.sanitize(root);

  assert.equal(root.innerHTML, before, "正常内容不应被改动");
  assert.equal(stats.tags + stats.attrs + stats.urls, 0, "不应有任何清理动作");
});

test("净化：textarea 与表单控件被保留", () => {
  const root = mount(`<textarea>内容</textarea><input value="x"><button>按钮</button>`);
  DomUtils.sanitize(root);
  assert.ok(root.querySelector("textarea"), "textarea 有内容意义，不应被删");
  assert.ok(root.querySelector("input"), "input 不能执行代码，不应被删");
  assert.ok(root.querySelector("button"), "button 不应被删");
});

test("净化：data:image 图片 src 被放行", () => {
  const root = mount(`<img src="data:image/png;base64,iVBORw0KGgo=">`);
  DomUtils.sanitize(root);
  assert.match(root.querySelector("img").getAttribute("src"), /^data:image\/png/, "data:image 应保留");
});

// ============================================================ 管线集成

test("管线：cleanContent 默认执行净化", () => {
  const root = mount(`<p>正文</p><img src="x" onerror="window.x=1"><script>y</script>`);
  const stats = CleanBlank.cleanContent(root);

  assertClean(root, "管线净化");
  assert.ok(stats.reasons.unsafe > 0, `应记录净化数量，实际 ${JSON.stringify(stats.reasons)}`);
  assert.ok(stats.sanitized, "应返回净化明细");
});

test("管线：净化计数计入 removed 不变式", () => {
  const root = mount(`<p>正文</p><script>x</script><img src="a" onerror="b">`);
  const stats = CleanBlank.cleanContent(root);
  const r = stats.reasons;
  assert.equal(
    stats.removed, r.invisible + r.br + r.empty + r.edges + r.unsafe,
    "removed 必须等于各项之和（含 unsafe）"
  );
});

test("管线：sanitize=false 可关闭净化（供调试）", () => {
  const root = mount(`<p>正文</p><img src="x" onerror="window.x=1">`);
  CleanBlank.cleanContent(root, { sanitize: false });
  assert.match(root.innerHTML, /onerror/, "关闭净化后事件属性应保留（仅调试用）");
});

test("★ 提取：净化独立于空行清理开关（关闭清理也必须净化）", () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><article>
    <h1>标题</h1>
    <p>这是填充正文内容，需要足够长度才能通过 Readability 的字数阈值判定，所以继续写一些无意义的文字来凑数。</p>
    <img src="/a.png" onerror="window.xss=1" onclick="window.xss2=1">
    <p>这是第二段填充正文内容，同样需要足够长度以保证整篇文章被正确识别为正文主体而不是噪音。</p>
    <p>这是第三段内容，继续填充足够的文字量以维持正文特征，确保提取结果稳定可靠。</p>
  </article></body></html>`, { url: "https://evil.example/a" });

  // 关闭空行清理
  const result = Extract.extractArticle(dom.window.document, { force: true, cleanBlank: false });
  assert.equal(result.ok, true);
  assert.equal(result.cleanStats, null, "清理已关闭");

  // 但净化必须仍然生效
  assertClean(result.content, "关闭清理时的净化");
  assert.ok(result.sanitizeStats, "应返回净化统计");
  assert.ok(
    result.sanitizeStats.attrs > 0,
    `应至少移除一个事件属性，实际 ${JSON.stringify(result.sanitizeStats)}`
  );
});

test("★ 提取：完整攻击页面被彻底净化", () => {
  const pad = "<p>这是填充正文内容，需要足够长度才能通过 Readability 的字数阈值判定，所以继续写一些无意义的文字来凑数。</p>";
  const dom = new JSDOM(`<!DOCTYPE html><html><body><article>
    <h1>攻击测试</h1>
    ${pad}
    <img src="/a.png" onerror="window.x1=1">
    <p><a href="javascript:alert(1)">恶意链接</a></p>
    <p><iframe src="https://evil.example/"></iframe></p>
    <p><noscript><img src="/b.png" onerror="window.x2=1"></noscript></p>
    <p><svg><script>window.x3=1</script><circle r="3"/></svg></p>
    ${pad}
  </article></body></html>`, { url: "https://evil.example/a" });

  const result = Extract.extractArticle(dom.window.document, { force: true });
  assert.equal(result.ok, true);
  assertClean(result.content, "完整攻击页面");
  // 正文文字应保留；svg 内的 <script> 必须已被清除
  assert.match(result.content.textContent, /填充正文内容/);
  assert.equal(result.content.querySelectorAll("script").length, 0, "svg 内的 script 必须清掉");
});
