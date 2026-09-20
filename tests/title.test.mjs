/**
 * 标题处理测试。
 *
 * 背景（实机截图发现）：Readability 会把 <title> 文本作为 article.title，
 * 而正文通常自带 <h1>/<h2>。两者同时显示会出现「标题重复」，且 <title>
 * 还带着「｜站点名」后缀。真实测试页上就出现了：
 *   大标题「测试文章：城市里的树｜澄读测试页」 + 正文里又一个「城市里的树」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Extract = require("../src/content/extract.js");

function page(html, url = "https://example.com/a") {
  return new JSDOM(`<!DOCTYPE html><html lang="zh-CN"><head><title>文章标题｜示例站点</title></head><body>${html}</body></html>`, { url }).window.document;
}

const PAD = "这是填充正文内容，需要足够长度才能通过 Readability 的字数阈值判定，所以继续写一些无意义的文字来凑够长度。";

// ============================================================ cleanTitle

test("标题清理：去掉「｜站点名」后缀", () => {
  assert.equal(Extract.cleanTitle("城市里的树｜示例站点"), "城市里的树");
  assert.equal(Extract.cleanTitle("城市里的树 | 示例站点"), "城市里的树");
  assert.equal(Extract.cleanTitle("城市里的树 - 示例站点"), "城市里的树");
  assert.equal(Extract.cleanTitle("城市里的树 — 示例站点"), "城市里的树");
  assert.equal(Extract.cleanTitle("城市里的树·示例站点"), "城市里的树");
});

test("标题清理：已知站点名时精确裁剪", () => {
  assert.equal(Extract.cleanTitle("城市里的树 - 示例站点", "示例站点"), "城市里的树");
  assert.equal(Extract.cleanTitle("城市里的树｜示例站点", "示例站点"), "城市里的树");
});

test("标题清理：取最长片段作为文章标题", () => {
  // 站点名通常短，主体标题通常长
  assert.equal(Extract.cleanTitle("短名｜这是一个相当长的文章标题"), "这是一个相当长的文章标题");
});

test("标题清理：无分隔符时原样保留", () => {
  assert.equal(Extract.cleanTitle("城市里的树"), "城市里的树");
  assert.equal(Extract.cleanTitle("A Study of Trees"), "A Study of Trees");
});

test("标题清理：内容为空时的健壮性", () => {
  assert.equal(Extract.cleanTitle(""), "");
  assert.equal(Extract.cleanTitle(null), "");
  assert.equal(Extract.cleanTitle(undefined), "");
  assert.equal(Extract.cleanTitle("   "), "");
});

test("标题清理：分隔符属于标题本身时不误删", () => {
  // 只有分隔符、裁完为空 → 保留原样
  assert.equal(Extract.cleanTitle("｜"), "｜");
});

// ============================================================ 开篇标题识别

test("开篇标题：识别并摘除正文开头的标题元素", () => {
  const doc = page(`<div id="c"><h1>城市里的树</h1><p>${PAD}</p></div>`);
  const c = doc.getElementById("c");
  const h = Extract.takeLeadingHeading(c);

  assert.ok(h, "应识别出开篇标题");
  assert.equal(h.textContent.trim(), "城市里的树");
  assert.equal(c.querySelector("h1"), null, "标题元素应被从原位置摘除");
});

test("开篇标题：标题前已有正文时不当作文章标题", () => {
  const doc = page(`<div id="c"><p>${PAD}</p><h2>某个小节标题</h2><p>${PAD}</p></div>`);
  const c = doc.getElementById("c");
  const h = Extract.takeLeadingHeading(c);

  assert.equal(h, null, "正文中段的小节标题不应被当成文章标题");
  assert.ok(c.querySelector("h2"), "小节标题不应被摘除");
});

test("开篇标题：无标题时返回 null", () => {
  const doc = page(`<div id="c"><p>${PAD}</p></div>`);
  assert.equal(Extract.takeLeadingHeading(doc.getElementById("c")), null);
});

test("开篇标题：跳过空标题元素", () => {
  const doc = page(`<div id="c"><h1>  </h1><h2>真正的标题</h2><p>${PAD}</p></div>`);
  const h = Extract.takeLeadingHeading(doc.getElementById("c"));
  assert.ok(h, "应跳过空标题");
  assert.equal(h.textContent.trim(), "真正的标题");
});

test("scanBefore：区分「命中目标」与「目标前有文字」", () => {
  const doc = page(`<div id="c"><h1>标题</h1><p>${PAD}</p></div>`);
  const c = doc.getElementById("c");

  // 开篇 h1：命中目标，且它前面没有文字
  const before = Extract.scanBefore(c, c.querySelector("h1"), 40);
  assert.equal(before.reached, true, "应标记为命中目标");
  assert.equal(before.hasTextBefore, false, "标题前不应有文字");

  // 后面的 p：目标前面有标题文字（但只有 2 字，低于阈值 40，不算「实质文本」）
  const pShort = Extract.scanBefore(c, c.querySelector("p"), 40);
  assert.equal(pShort.reached, true);
  assert.equal(pShort.hasTextBefore, false, "2 字低于阈值，不算实质文本");

  // 阈值降到 1 时，同样的前导文字就算数了
  const pTight = Extract.scanBefore(c, c.querySelector("p"), 1);
  assert.equal(pTight.hasTextBefore, true, "阈值 1 时应检测到前导文字");
});

test("scanBefore：目标前有长段落时判定为「非开篇」", () => {
  const doc = page(`<div id="c"><p>${PAD}</p><h2>小节</h2></div>`);
  const c = doc.getElementById("c");

  const r = Extract.scanBefore(c, c.querySelector("h2"), 40);
  assert.equal(r.hasTextBefore, true, "前面已有长段落，不应算作开篇标题");
});

test("scanBefore：目标不存在时不误判", () => {
  const doc = page(`<div id="c"><p>${PAD}</p></div>`);
  const c = doc.getElementById("c");
  const orphan = doc.createElement("h1");
  orphan.textContent = "游离标题";

  const r = Extract.scanBefore(c, orphan, 40);
  assert.equal(r.reached, false);
  assert.equal(r.hasTextBefore, true, "扫完整棵树都没命中，且遇到了文字");
});

// ============================================================ 端到端

test("端到端：标题取自正文标题，不重复、不带站点名", () => {
  const doc = page(`
    <article>
      <h1>城市里的树</h1>
      <p>${PAD}</p>
      <p>${PAD}</p>
    </article>
  `);
  const r = Extract.extractArticle(doc, { force: true });

  assert.equal(r.ok, true);
  assert.equal(r.title, "城市里的树", "标题应取自正文标题，而非 <title>");
  assert.ok(r.heading, "应返回标题元素");
  assert.equal(r.content.querySelector("h1"), null, "正文里的标题应已被摘除，避免重复显示");
});

test("端到端：无正文标题时回退到清理过的 <title>", () => {
  const doc = page(`<article><p>${PAD}</p><p>${PAD}</p></article>`);
  const r = Extract.extractArticle(doc, { force: true });

  assert.equal(r.ok, true);
  assert.equal(r.title, "文章标题", "应回退到 <title> 并去掉站点名后缀");
  assert.equal(r.heading, null);
});

test("端到端：正文标题与 <title> 一致时不重复", () => {
  const doc = page(`<article><h2>城市里的树</h2><p>${PAD}</p><p>${PAD}</p></article>`);
  const r = Extract.extractArticle(doc, { force: true });

  assert.equal(r.title, "城市里的树");
  assert.equal(
    r.content.textContent.includes("城市里的树"), false,
    "正文里不应再出现一份标题"
  );
});
