/**
 * 空行清理管线单元测试。
 * 运行：npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

import { FIXTURES } from "./fixtures/fixtures.mjs";

const require = createRequire(import.meta.url);
const CleanBlank = require("../src/content/clean/clean-blank.js");

/** 把 fixture HTML 包进一个文档，返回根节点与文档。 */
function mount(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const root = dom.window.document.getElementById("root");
  assert.ok(root, "fixture 必须包含 #root");
  return { root, document: dom.window.document, dom };
}

/** 跑清理管线。 */
function clean(root, options) {
  return CleanBlank.cleanContent(root, options);
}

/** 取某个标签的元素数量。 */
function count(root, selector) {
  return root.querySelectorAll(selector).length;
}

/** 正文的可见字符（去掉所有空白与零宽字符），用于校验「没把内容吃掉」。 */
function visibleText(root) {
  return root.textContent
    .replace(/[\s\u200b\u200c\u200d\u2060\ufeff]+/g, "");
}

/** 结构指纹，用于幂等性比对。 */
function fingerprint(root) {
  return root.innerHTML.replace(/\s+/g, " ").trim();
}

// ============================================================ 删除空块

test("删除：各类空段落", () => {
  const { root } = mount(FIXTURES.classicEmptyParagraphs);
  const textBefore = visibleText(root);
  clean(root);

  assert.equal(count(root, "p"), 2, "只应剩下两段有内容的段落");
  assert.equal(root.querySelectorAll("p")[0].textContent.trim(), "第一段有内容。");
  assert.equal(root.querySelectorAll("p")[1].textContent.trim(), "第二段有内容。");
  assert.equal(visibleText(root), textBefore, "不应丢失任何可见文字");
});

test("删除：层层嵌套的空 div", () => {
  const { root } = mount(FIXTURES.nestedEmptyDivs);
  clean(root);

  assert.equal(count(root, "p"), 2, "只应剩下两段正文");
  assert.equal(visibleText(root), "正文一。正文二。");
  // 空壳 div 必须全部清掉，不只清最内层。
  assert.equal(count(root, "div"), 0, "嵌套空 div 应被完全清除");
});

test("删除：块级元素首尾的孤立 <br>", () => {
  const { root } = mount(`<div id="root"><p><br>正文<br></p></div>`);
  clean(root);
  assert.equal(count(root, "br"), 0, "首尾孤立 <br> 应被删除");
  assert.equal(root.textContent.trim(), "正文");
});

test("删除：空 li，但列表结构保留", () => {
  const { root } = mount(FIXTURES.lists);
  clean(root);

  assert.equal(count(root, "ul"), 1, "ul 结构必须保留");
  assert.equal(count(root, "ol"), 1, "ol 结构必须保留");
  assert.equal(count(root, "ul > li"), 2, "空的 li 应被删除");
  assert.equal(count(root, "ol > li"), 2, "被 <p>&nbsp;</p> 包住的空 li 也应删除");
  assert.equal(visibleText(root), "正文一。项目一项目二有序一有序二正文二。");
});

// ============================================================ 折叠 <br>

test("转换：连续 <br> 折叠到上限", () => {
  const { root } = mount(FIXTURES.brRuns);
  clean(root);

  const p = root.querySelectorAll("p")[1];
  assert.equal(p.querySelectorAll("br").length, 2, "4 个连续 <br> 应折叠为 2");
  assert.match(p.textContent, /行内换行/);
  assert.match(p.textContent, /后面还有字。/);
});

test("转换：maxBrRun 可配置", () => {
  const { root } = mount(`<div id="root"><p>a<br><br><br><br>b</p></div>`);
  clean(root, { maxBrRun: 1 });
  assert.equal(count(root, "br"), 1);
});

// ============================================================ 核心价值：零宽字符

test("★ 核心：零宽字符段落必须被删除（Readability 会漏掉它们）", () => {
  const { root } = mount(FIXTURES.zeroWidthParagraphs);
  const textBefore = visibleText(root);
  const stats = clean(root);

  assert.equal(count(root, "p"), 2, "只含零宽字符的段落全部应被删除");
  assert.equal(root.querySelectorAll("p")[0].textContent, "正文一。");
  assert.equal(root.querySelectorAll("p")[1].textContent, "正文二。");
  assert.equal(visibleText(root), textBefore, "不应误删真实文字");

  // 逐个确认四种零宽字符都能识别
  for (const ch of ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"]) {
    const m = mount(`<div id="root"><p>文字</p><p>${ch}</p></div>`);
    clean(m.root);
    assert.equal(count(m.root, "p"), 1, `零宽字符 U+${ch.codePointAt(0).toString(16)} 未被识别为空`);
  }
});

test("★ 核心：零宽字符与嵌套结构混合", () => {
  const { root } = mount(FIXTURES.zeroWidthMixed);
  clean(root);

  assert.equal(count(root, "p"), 2, "零宽内容不应留下任何空段落");
  assert.equal(visibleText(root), "正文一。正文二。");
  assert.equal(count(root, "div"), 0, "只含零宽字符的 div 应被删除");
});

test("统计：零宽字符段落的删除原因归类为 empty", () => {
  const { root } = mount(FIXTURES.zeroWidthParagraphs);
  const stats = clean(root);
  assert.ok(stats.reasons.empty >= 6, `应识别出至少 6 个零宽空段落，实际 ${stats.reasons.empty}`);
});

// ============================================================ 内联样式

test("剥离：内联垂直 margin/padding", () => {
  const { root } = mount(FIXTURES.inlineVerticalSpacing);
  clean(root);

  // 断言最终声明：不能残留任何垂直方向的空壳声明。
  for (const el of root.querySelectorAll("[style]")) {
    const style = el.getAttribute("style");
    assert.ok(
      !/margin-(top|bottom)\s*:/.test(style),
      `不应残留垂直 margin 声明：${style}`
    );
  }

  // 纯 margin 撑起来的空 div 必须被删除（不是留个空壳）。
  assert.equal(root.querySelectorAll("div").length, 0, "空 div 应被删除");
  assert.match(root.textContent, /正文四/, "div 内的文字必须保留（容器被拆掉、内容留下）");

  // 四个方向都是 0 的简写属于 no-op，整条声明应被丢弃。
  const p3 = [...root.querySelectorAll("p")].find((p) => p.textContent.includes("正文三"));
  assert.equal(
    p3.getAttribute("style"), null,
    "margin: 80px 0 20px 0 的垂直与水平分量全为零，应整条丢弃"
  );

  assert.equal(visibleText(root), "正文一。正文二。正文三。正文四。");
});

test("保留：margin/padding 的非零水平分量", () => {
  const { root } = mount(
    `<div id="root"><p style="margin: 40px 16px; padding: 50px 24px;">正文</p></div>`
  );
  clean(root);

  const style = root.querySelector("p").getAttribute("style") || "";
  assert.match(style, /margin-left:\s*16px/, "水平 margin 应保留（上下已归零）");
  assert.match(style, /margin-right:\s*16px/, "水平 margin 应保留（上下已归零）");
  assert.match(style, /padding-left:\s*24px/, "水平 padding 应保留（上下已归零）");
  assert.match(style, /padding-right:\s*24px/, "水平 padding 应保留（上下已归零）");
});

test("保留：maxBrRun 之外的 disallowed 简写（auto/%）保持原样", () => {
  const { root } = mount(`<div id="root"><p style="margin: 0 auto;">正文</p></div>`);
  clean(root);
  const style = root.querySelector("p").getAttribute("style") || "";
  assert.match(style, /auto/, "含 auto 的简写无法静态解析，应原样保留（居中不能丢）");
});

test("剥离：!important 的垂直 margin 也要能识别", () => {
  const { root } = mount(`<div id="root"><p style="margin-top: 50px !important;">正文</p></div>`);
  clean(root);
  const style = root.querySelector("p").getAttribute("style") || "";
  assert.ok(!/margin-top/.test(style), `!important 的垂直 margin 应被识别并移除：${style}`);
});

test("不破坏：style 值内的分号与括号", () => {
  const { root } = mount(
    `<div id="root"><p style="background-image: url(data:image/svg+xml;base64,AA==); margin-top: 9px;">正文</p></div>`
  );
  clean(root);
  const style = root.querySelector("p").getAttribute("style") || "";
  assert.match(style, /url\(data:image\/svg\+xml;base64,AA==\)/, "url() 内的分号不能被当作声明分隔符");
  assert.ok(!/margin-top/.test(style), "同一条 style 里的垂直 margin 仍应被移除");
});

test("剥离：内联 font-size / color（公众号粘贴场景）", () => {
  const { root } = mount(FIXTURES.richTextPaste);
  clean(root);

  for (const el of root.querySelectorAll("[style]")) {
    assert.equal(el.style.fontSize, "", "font-size 应被剥离以便排版设置接管");
    assert.equal(el.style.color, "", "color 应被剥离以便主题接管");
  }
  assert.equal(count(root, "p"), 2, "夹在中间的空 <p> 应被删除");
  assert.equal(visibleText(root), "正文一。正文二。");
});

test("保留：小内边距不动（阈值以下）", () => {
  const { root } = mount(`<div id="root"><p style="padding: 8px 12px;">正文</p></div>`);
  clean(root);
  assert.equal(root.querySelector("p").style.padding, "8px 12px", "小内边距不应被剥离");
});

test("简写解析：取出水平分量", () => {
  const h = CleanBlank.shorthandHorizontal;
  assert.deepEqual(h("60px 0"), { left: "0", right: "0" });
  assert.deepEqual(h("60px 12px"), { left: "12px", right: "12px" });
  assert.deepEqual(h("10px"), { left: 0, right: 0 }, "单值即垂直值");
  assert.deepEqual(h("10px 20px 30px 40px"), { left: "20px", right: "40px" });
  assert.deepEqual(h("10px 20px 30px"), { left: "20px", right: "20px" });
  assert.equal(h("0 auto"), null, "含 auto 不应被改写");
  assert.equal(h("10%"), null, "含 % 不应被改写");

  // 幂等关键：改写后的 longhand 形式不可能再被当成简写解析。
  const { root } = mount(
    `<div id="root"><p style="margin: 40px 16px 80px 24px;">正文</p></div>`
  );
  clean(root);
  const style = root.querySelector("p").getAttribute("style");
  assert.equal(style, "margin-left: 16px; margin-right: 24px");
});

// ============================================================ 不误伤（关键）

test("保留：图片 / 视频 / svg / hr / 装饰背景", () => {
  const { root } = mount(FIXTURES.mustKeep);
  clean(root);

  assert.equal(count(root, "img"), 2, "img 必须保留（含 picture 内的）");
  assert.equal(count(root, "hr"), 1, "hr 分隔线必须保留");
  assert.equal(count(root, "video"), 1, "video 必须保留");
  assert.equal(count(root, "svg"), 1, "svg 必须保留");
  assert.equal(
    root.querySelectorAll('[style*="background-image"]').length, 1,
    "带背景图的装饰块必须保留"
  );
  assert.equal(
    root.querySelectorAll('[style*="border-top"]').length, 1,
    "带可见边框的块必须保留"
  );
  // 但纯空段落仍要删掉
  assert.equal(count(root, "p"), 6, "空 <p> 应删、含媒体的 <p> 应留");
});

test("保留：孤立的 hr 不会被当作空块删除", () => {
  const { root } = mount(`<div id="root"><p>上</p><hr><p>下</p></div>`);
  clean(root);
  assert.equal(count(root, "hr"), 1, "hr 是作者的刻意分隔，必须保留");

  // 首尾位置的 hr 同样要保留（回归：曾被 trimEdges 误删）
  const r2 = mount(`<div id="root"><hr><p>正文</p><hr></div>`);
  clean(r2.root);
  assert.equal(count(r2.root, "hr"), 2, "首尾的 hr 也必须保留");
});

test("必须不动：pre / code / textarea 的空白", () => {
  const { root } = mount(FIXTURES.whitespaceSignificant);
  const preBefore = root.querySelector("pre").textContent;
  const codeBefore = root.querySelector("code").textContent;
  clean(root);

  assert.equal(root.querySelector("pre").textContent, preBefore, "pre 内空白必须原样保留");
  assert.equal(root.querySelector("code").textContent, codeBefore, "code 内空白必须原样保留");
  assert.ok(root.querySelector("textarea"), "textarea 必须保留");
  assert.match(root.querySelector("pre").textContent, /\n {6}return 1;/);
});

test("必须不动：表格的空单元格", () => {
  const { root } = mount(FIXTURES.tableStructure);
  clean(root);

  assert.equal(count(root, "table"), 1);
  assert.equal(count(root, "td"), 4, "空 <td> 是合法布局，一个都不能删");
  assert.equal(count(root, "th"), 2);
  assert.equal(count(root, "tr"), 3, "表格行必须完整保留");
});

test("保留：锚点元素（否则文内跳转会断）", () => {
  const { root } = mount(FIXTURES.anchorTargets);
  clean(root);

  assert.equal(count(root, "a#section-2"), 1, "带 id 的锚点必须保留");
  assert.equal(count(root, 'a[name="legacy-anchor"]'), 1, "带 name 的旧式锚点必须保留");
});

test("清理：注释与残留 script/style/noscript/aria-hidden", () => {
  const { root } = mount(FIXTURES.invisibleJunk);
  clean(root);

  assert.equal(count(root, "script"), 0);
  assert.equal(count(root, "style"), 0);
  assert.equal(count(root, "noscript"), 0);
  assert.equal(root.querySelectorAll("[aria-hidden]").length, 0);
  assert.ok(!root.innerHTML.includes("这是注释"), "注释节点应被清除");
  assert.equal(visibleText(root), "正文一。正文二。", "装饰性文字不应出现在正文里");
});

// ============================================================ 首尾留白

test("裁边：文章首尾的空块", () => {
  const { root } = mount(FIXTURES.edgeWhitespace);
  clean(root);

  assert.equal(count(root, "p"), 1);
  assert.equal(root.firstElementChild.localName, "p");
  assert.equal(root.textContent.trim(), "唯一一段正文。");
  assert.equal(visibleText(root), "唯一一段正文。");
});

// ============================================================ 幂等性（硬性）

test("幂等：跑两遍 == 跑一遍", () => {
  const names = Object.keys(FIXTURES);
  for (const name of names) {
    const a = mount(FIXTURES[name]);
    const b = mount(FIXTURES[name]);
    clean(a.root);
    clean(b.root);
    clean(b.root);   // 第二遍
    assert.equal(
      fingerprint(b.root), fingerprint(a.root),
      `fixture "${name}" 不满足幂等性`
    );
  }
});

test("幂等：三遍亦稳定", () => {
  const { root } = mount(FIXTURES.classicEmptyParagraphs);
  clean(root);
  const once = fingerprint(root);
  clean(root);
  clean(root);
  assert.equal(fingerprint(root), once);
});

// ============================================================ 边界与开关

test("开关：enabled=false 时不做任何改动", () => {
  const { root } = mount(FIXTURES.classicEmptyParagraphs);
  const before = fingerprint(root);
  const stats = clean(root, { enabled: false });
  assert.equal(fingerprint(root), before, "关闭时 DOM 必须保持不变");
  assert.equal(stats.removed, 0);
});

test("边界：空根节点不报错", () => {
  const { root } = mount(`<div id="root"></div>`);
  const stats = clean(root);
  assert.equal(stats.removed, 0);
});

test("边界：纯文本根节点不报错", () => {
  const { root } = mount(`<div id="root">只有文字</div>`);
  clean(root);
  assert.equal(root.textContent, "只有文字");
});

test("边界：统计字段齐备且数值合理", () => {
  const { root } = mount(FIXTURES.classicEmptyParagraphs);
  const stats = clean(root);
  assert.equal(typeof stats.removed, "number");
  assert.equal(typeof stats.collapsed, "number");
  assert.equal(typeof stats.strippedStyles, "number");
  assert.ok(stats.removed >= 7, `至少应删除 7 个空段落，实际 ${stats.removed}`);

  // 不变式：removed 必须等于各类删除原因之和（便于排查与回归）。
  const r = stats.reasons;
  assert.equal(
    stats.removed, r.invisible + r.br + r.empty + r.edges,
    "removed 应等于各删除原因之和"
  );
  assert.equal(stats.collapsed, r.br, "collapsed 应等于折叠的 <br> 数量");
});

test("不误伤：不能把 <p>文字</p> 误判为空", () => {
  const { root } = mount(`<div id="root"><p>文字</p><p> 文字 </p><p>&nbsp;文字&nbsp;</p></div>`);
  clean(root);
  assert.equal(count(root, "p"), 3, "含可见文字的段落一个都不能删");
});

test("不误伤：空白字符归一但文字顺序不变", () => {
  const { root } = mount(`<div id="root"><p>甲\u00a0\u00a0\u00a0乙</p></div>`);
  clean(root);
  assert.equal(root.textContent.trim(), "甲 乙", "nbsp 应归一为单个空格");
});
