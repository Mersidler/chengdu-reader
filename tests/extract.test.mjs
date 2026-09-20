/**
 * extract.js 集成测试：验证「克隆 → Readability → 空行清理」整链路。
 * 重点覆盖 baseURI 修复（否则阅读视图里图片/链接全裂）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Extract = require("../src/content/extract.js");

/** 造一个带 base 的页面，含相对路径图片与链接。 */
function page(html, url = "https://example.com/posts/2024/hello") {
  const dom = new JSDOM(`<!DOCTYPE html><html lang="zh-CN"><head><title>测试文章</title></head><body>${html}</body></html>`, {
    url,
  });
  return dom.window.document;
}

const ARTICLE_HTML = `
  <article>
    <h1>一篇足够长的测试文章标题</h1>
    <p>这是第一段正文内容，需要足够长才能通过 Readability 的字数阈值判定，
       所以这里多写一些没有实际意义的填充文字来凑够长度要求，确保提取能够成功。</p>
    <p></p>
    <p>&nbsp;</p>
    <p>\u200b\u200b\u200b</p>
    <p>这是第二段正文内容，同样需要一定的长度，以保证整篇文章被正确识别为正文主体，
       而不是被当成导航或侧边栏内容而丢弃掉，这里继续填充一些文字。</p>
    <div><div></div></div>
    <p><img src="/images/photo.png" alt="配图"></p>
    <p>这是第三段，其中包含一个<a href="/other/page">站内链接</a>，用于验证相对路径是否被正确转为绝对地址，
       这里也需要足够的文字量来支撑正文判定。</p>
    <p>\u200c\u200d</p>
    <p>这是最后一段内容了，用来收尾，同样要有一定长度以维持整篇文章的正文特征不被误判成噪音。</p>
  </article>
`;

/** 判定一个段落是否「视觉上为空」：无可见文字，且不含任何媒体/表格等有视觉含义的元素。 */
function isBlankParagraph(p) {
  const text = p.textContent.replace(/[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]/g, "");
  if (text) return false;
  return !p.querySelector("img,picture,video,audio,iframe,canvas,svg,table,hr,object,embed");
}

test("提取：成功解析完整文章", () => {
  const doc = page(ARTICLE_HTML);
  const result = Extract.extractArticle(doc, { force: true });

  assert.equal(result.ok, true, `提取失败：${result.reason}`);
  assert.ok(result.content, "应返回内容容器");
  assert.equal(result.lang, "zh-CN", "lang 应透传");
  assert.match(result.title, /测试文章/, `标题应取自文章，实际：${result.title}`);
});

test("提取：Readability 已删除普通空段落", () => {
  const doc = page(ARTICLE_HTML);
  const result = Extract.extractArticle(doc, { force: true });

  const emptyParas = [...result.content.querySelectorAll("p")].filter(isBlankParagraph);
  assert.equal(
    emptyParas.length, 0,
    `清理后不应残留空段落：${emptyParas.map((p) => p.outerHTML).join("")}`
  );
  // 含图片的段落必须还在
  assert.ok(result.content.querySelector("img"), "含图片的段落不能被当成空段落删除");
});

test("★ 提取：零宽字符空段落由我们的管线补救（Readability 的缺口）", () => {
  // 这是本扩展相对 Readability 原生输出的核心增量：
  // Readability 的判空正则 /^\s*$/ 不覆盖 \u200b 系列零宽字符，
  // 它会把这些段落原样留在正文里，渲染成空白行。
  const doc = page(`
    <article>
      <p>第一段正文内容，需要足够长度才能通过正文识别，这里多写一些填充文字凑够字数要求。</p>
      <p>\u200b\u200b\u200b</p>
      <p>第二段正文内容，同样需要一定长度以保证整篇文章被正确识别为正文主体而不是噪音。</p>
      <p>\u200c\u200d</p>
      <p>第三段内容，继续填充足够的文字量以维持正文特征，确保提取结果稳定可靠。</p>
    </article>
  `);

  // 先确认 Readability 确实漏掉了它（否则本用例就失去了意义）
  const Readability = require("../src/vendor/readability.js");
  const raw = new Readability(doc.cloneNode(true)).parse();
  assert.ok(raw && raw.content.includes("\u200b"), "前提：Readability 原生输出确实含零宽段落");

  // 我们的管线应把它们清掉
  const result = Extract.extractArticle(doc, { force: true });
  assert.equal(result.ok, true);
  assert.ok(!result.content.textContent.includes("\u200b"), "零宽字符应被清除");
  assert.ok(!result.content.textContent.includes("\u200c"), "零宽字符应被清除");
  assert.ok(result.cleanStats.removed >= 2, `应删除零宽空段落，实际 ${result.cleanStats.removed}`);
});

test("提取：相对路径必须转为绝对地址（baseURI 修复）", () => {
  const doc = page(ARTICLE_HTML);
  const result = Extract.extractArticle(doc);
  assert.equal(result.ok, true);

  const img = result.content.querySelector("img");
  assert.ok(img, "图片应保留");
  assert.equal(
    img.getAttribute("src"), "https://example.com/images/photo.png",
    "相对图片路径必须被转成绝对地址，否则阅读视图里图片会裂"
  );

  const link = result.content.querySelector("a[href]");
  assert.equal(
    link.getAttribute("href"), "https://example.com/other/page",
    "相对链接必须被转成绝对地址"
  );
});

test("提取：不污染原文档（必须先克隆）", () => {
  const doc = page(ARTICLE_HTML);
  const before = doc.body.innerHTML;
  const beforeTitle = doc.title;

  Extract.extractArticle(doc);

  assert.equal(doc.body.innerHTML, before, "原文档的 DOM 必须保持原样");
  assert.equal(doc.title, beforeTitle, "原文档 title 不应被改动");
  assert.ok(doc.querySelector("p"), "原页面的元素不应被移走");
});

test("提取：空行清理已生效（零宽空段落被删除）", () => {
  const doc = page(ARTICLE_HTML);
  const result = Extract.extractArticle(doc, { force: true });

  assert.ok(result.cleanStats, "应返回清理统计");
  assert.ok(
    result.cleanStats.removed > 0,
    `零宽空段落应被删除，统计：${JSON.stringify(result.cleanStats)}`
  );

  // 提取结果里不应再有只含空白的 <p>
  const emptyParas = [...result.content.querySelectorAll("p")].filter(isBlankParagraph);
  assert.equal(emptyParas.length, 0, `清理后不应残留空段落：${emptyParas.map((p) => p.outerHTML).join("")}`);
});

test("提取：cleanBlank=false 时跳过清理", () => {
  const doc = page(ARTICLE_HTML);
  const result = Extract.extractArticle(doc, { cleanBlank: false, force: true });
  assert.equal(result.ok, true);
  assert.equal(result.cleanStats, null, "关闭清理时不应有统计");
});

test("提取：不可读页面（导航页）被拒绝", () => {
  const doc = page(`
    <nav>
      <a href="/a">链接一</a><a href="/b">链接二</a><a href="/c">链接三</a>
      <a href="/d">链接四</a><a href="/e">链接五</a><a href="/f">链接六</a>
    </nav>
  `);
  const result = Extract.extractArticle(doc);
  assert.equal(result.ok, false);
  assert.ok(["not-readerable", "too-short", "empty-article"].includes(result.reason), `意外的原因：${result.reason}`);
});

test("提取：内容过短被拒绝", () => {
  const doc = page(`<p>太短。</p>`);
  const result = Extract.extractArticle(doc);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-readerable");
});

test("提取：force 可跳过可读性判定", () => {
  const doc = page(`<div><p>短内容也可以强行提取。</p></div>`);
  const result = Extract.extractArticle(doc, { force: true });
  // force 只跳过前置判定；Readability 自身仍可能判定过短。
  assert.ok(result.ok === true || result.reason === "too-short" || result.reason === "empty-article");
});

test("提取：缺少 Readability 时优雅失败", () => {
  const doc = page(ARTICLE_HTML);
  // 注入一个非函数，模拟构造函数缺失
  const result = Extract.extractArticle(doc, { Readability: undefined, force: true });
  // 环境里能 require 到 vendor 版本，所以这里应成功；仅断言不抛异常。
  assert.ok(typeof result.ok === "boolean");
});

test("提取：isLikelyReaderable 对正常文章返回 true", () => {
  const doc = page(ARTICLE_HTML);
  assert.equal(Extract.isLikelyReaderable(doc), true);
});

test("提取：isLikelyReaderable 对短文本返回 false", () => {
  const doc = page(`<p>短。</p>`);
  assert.equal(Extract.isLikelyReaderable(doc), false);
});

test("提取：cloneDocumentSafely 保留 baseURI", () => {
  const doc = page(`<p>内容</p>`, "https://example.com/a/b");
  const clone = Extract.cloneDocumentSafely(doc);
  assert.equal(clone.baseURI, "https://example.com/a/b");
  assert.notEqual(clone, doc, "必须是副本");
});
