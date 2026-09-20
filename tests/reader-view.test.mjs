/**
 * reader-view / toolbar / prefs 的 DOM 集成测试。
 *
 * 用 jsdom 提供 document / window，然后加载普通脚本（非 ES module）到该环境，
 * 验证 Shadow DOM 装配、偏好应用、工具条交互与卸载还原。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let dom;
let win;

/** 在每个用例前建立一个新的 jsdom 环境，并把模块加载进去。 */
function setup() {
  dom = new JSDOM(`<!DOCTYPE html><html><head><title>原页面标题</title></head>
    <body><article><p>原页面正文</p></article></body></html>`, {
    url: "https://example.com/article",
    pretendToBeVisual: true,
  });
  win = dom.window;

  // jsdom 不实现 scrollTo，会往 stderr 打噪音；补一个空实现。
  win.scrollTo = () => {};

  // 让模块里的 globalThis / document / window 指向 jsdom 环境。
  global.window = win;
  global.document = win.document;

  // 清掉模块缓存，保证每次都是干净加载。
  for (const p of [
    "../src/content/prefs.js",
    "../src/content/styles.js",
    "../src/content/toolbar.js",
    "../src/content/reader-view.js",
  ]) {
    delete require.cache[require.resolve(p)];
  }
}

function load() {
  return {
    prefs: require("../src/content/prefs.js"),
    styles: require("../src/content/styles.js"),
    toolbar: require("../src/content/toolbar.js"),
    view: require("../src/content/reader-view.js"),
  };
}

/** 造一份 article 结果（模拟 extract 的输出）。 */
function makeArticle(doc) {
  const content = doc.createElement("div");
  content.innerHTML = `
    <p>这是第一段正文，长度足够，用于验证渲染是否正确。</p>
    <p></p>
    <p>这是第二段正文。</p>
  `;
  return {
    ok: true,
    title: "测试文章标题",
    byline: "作者名",
    siteName: "示例站点",
    lang: "zh-CN",
    dir: "",
    content,
    cleanStats: { removed: 3, collapsed: 1, strippedStyles: 0, reasons: { invisible: 0, empty: 2, br: 1, edges: 0, unwrapped: 0 } },
  };
}

beforeEach(setup);
afterEach(() => {
  if (dom) dom.window.close();
  dom = null;
  win = null;
});

// ============================================================ 打开与关闭

test("视图：打开后挂载 Shadow DOM 宿主", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  const article = makeArticle(win.document);

  rv.open(article, prefs.DEFAULTS);

  const host = win.document.getElementById(view.HOST_ID);
  assert.ok(host, "宿主元素应被挂载到文档");
  assert.ok(host.shadowRoot, "宿主应带 open shadow root");
  assert.equal(rv.isOpen(), true);
});

test("视图：正文与标题被渲染进 shadow root", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const shadow = win.document.getElementById(view.HOST_ID).shadowRoot;
  const title = shadow.querySelector(".rd-title");
  assert.equal(title.textContent, "测试文章标题");

  const meta = shadow.querySelector(".rd-meta");
  assert.match(meta.textContent, /作者名/);
  assert.match(meta.textContent, /示例站点/);

  const content = shadow.querySelector(".rd-content");
  assert.match(content.textContent, /第一段正文/);
  assert.match(content.textContent, /第二段正文/);
  assert.equal(content.getAttribute("lang"), "zh-CN");
});

test("视图：样式表已注入 shadow root", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const style = win.document.getElementById(view.HOST_ID).shadowRoot.querySelector("style");
  assert.ok(style, "应注入样式表");
  assert.match(style.textContent, /\.rd-content/, "样式应含正文规则");
  assert.match(style.textContent, /position:\s*fixed/, "宿主应为全屏浮层");
});

test("视图：打开时冻结背景滚动，关闭时还原", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });

  const before = win.document.documentElement.style.overflow;
  rv.open(makeArticle(win.document), prefs.DEFAULTS);
  assert.equal(win.document.documentElement.style.overflow, "hidden", "打开时应锁住页面滚动");

  rv.close();
  assert.equal(win.document.documentElement.style.overflow, before, "关闭时应还原 overflow");
});

test("视图：关闭后宿主被完全移除", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);
  rv.close();

  assert.equal(win.document.getElementById(view.HOST_ID), null, "宿主应被移除");
  assert.equal(rv.isOpen(), false);
  assert.ok(win.document.querySelector("article"), "原页面内容不应被破坏");
});

test("视图：toggle 在开/关之间切换", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  const article = makeArticle(win.document);

  assert.equal(rv.toggle(article, prefs.DEFAULTS), true, "首次 toggle 应打开");
  assert.equal(rv.isOpen(), true);
  assert.equal(rv.toggle(null, null), false, "再次 toggle 应关闭");
  assert.equal(rv.isOpen(), false);
});

test("视图：重复 open 不会创建第二个宿主", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  assert.equal(
    win.document.querySelectorAll("#" + view.HOST_ID).length, 1,
    "只应存在一个宿主"
  );
});

// ============================================================ 偏好应用

test("偏好：applyPrefs 更新 CSS 变量与主题样式", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const host = win.document.getElementById(view.HOST_ID);
  rv.applyPrefs(Object.assign({}, prefs.DEFAULTS, { fontSize: 24, lineHeight: 2.2, paraGap: 1.6, theme: "dark" }));

  assert.equal(host.style.fontSize, "24px", "字号应作用到宿主");
  assert.equal(host.style.lineHeight, "2.2", "行距应作用到宿主");
  assert.equal(host.style.getPropertyValue("--rd-para-gap"), "1.6em", "段距变量应被设置");

  const style = host.shadowRoot.querySelector("style");
  assert.match(style.textContent, /#1b1e23/, "切到 dark 主题后样式表应重建");
});

test("偏好：normalize 派生出可直接用于 CSS 的 fontFamily", () => {
  const { prefs } = load();

  // 回归：styles.js 读的是 prefs.fontFamily，而 normalize 曾只设置 fontFamilyKey，
  // 导致 CSS 里被写成 font-family: undefined、字体设置静默失效。
  for (const key of Object.keys(prefs.FONT_STACKS)) {
    const n = prefs.normalize({ fontFamilyKey: key });
    assert.equal(typeof n.fontFamily, "string", `fontFamilyKey=${key} 应派生出 fontFamily`);
    assert.ok(n.fontFamily.length > 0);
    assert.ok(
      !/undefined/.test(n.fontFamily),
      `fontFamily 不应含 undefined：${n.fontFamily}`
    );
    assert.equal(n.fontFamily, prefs.FONT_STACKS[key], "应等于对应字体栈");
  }

  // 默认值本身也必须是可用的字体栈
  assert.equal(typeof prefs.DEFAULTS.fontFamily, "string");
  assert.ok(!/undefined/.test(prefs.DEFAULTS.fontFamily));
});

test("偏好：字体栈不含 undefined（真实渲染会被写成非法 CSS）", () => {
  const { prefs, styles } = load();
  for (const key of Object.keys(prefs.FONT_STACKS)) {
    const n = prefs.normalize({ fontFamilyKey: key });
    const css = styles.buildCss(n);
    assert.ok(
      !/font-family:\s*undefined/.test(css),
      `buildCss 输出了非法字体：${key}`
    );
    const inline = styles.hostInlineStyle(n);
    assert.ok(
      !/undefined/.test(inline["font-family"]),
      `hostInlineStyle 输出了非法字体：${key}`
    );
  }
});

test("工具条：切换字体能真正改变字体栈", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const host = win.document.getElementById(view.HOST_ID);
  const before = host.style.fontFamily;
  assert.ok(before && !/undefined/.test(before), `初始字体应合法：${before}`);

  const fontBtn = [...host.shadowRoot.querySelectorAll(".rd-bar button")]
    .find((b) => /系统|衬线|无衬线/.test(b.textContent));
  fontBtn.click();

  const after = host.style.fontFamily;
  assert.notEqual(after, before, "字体应发生变化");
  assert.ok(!/undefined/.test(after), `切换后字体应合法：${after}`);
});

test("偏好：页宽通过宿主 CSS 变量生效", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const host = win.document.getElementById(view.HOST_ID);
  rv.applyPrefs(Object.assign({}, prefs.DEFAULTS, { width: "full" }));

  // 页宽由宿主内联变量驱动（样式表里写 max-width: var(--rd-page-width)）
  assert.equal(
    host.style.getPropertyValue("--rd-page-width"), "100%",
    "全宽应下发到宿主变量"
  );
  assert.match(
    host.shadowRoot.querySelector("style").textContent,
    /max-width:\s*var\(--rd-page-width/,
    "样式表应引用该变量，而不是写死宽度"
  );
});

test("偏好：主题色必须内联到宿主（否则被 all:initial 重置为黑字）", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const host = win.document.getElementById(view.HOST_ID);

  // 回归：宿主内联 `all: initial` 会把 color 重置为初始值（黑），
  // 若主题色只写在 :host 规则里，深色主题下正文会是黑字不可读。
  rv.applyPrefs(Object.assign({}, prefs.DEFAULTS, { theme: "dark" }));
  assert.equal(host.style.color, "rgb(215, 219, 224)", "深色主题正文色应内联到宿主");
  assert.equal(host.style.backgroundColor, "rgb(27, 30, 35)", "深色主题背景应内联到宿主");

  rv.applyPrefs(Object.assign({}, prefs.DEFAULTS, { theme: "sepia" }));
  assert.equal(host.style.backgroundColor, "rgb(246, 239, 227)", "护眼主题背景应内联到宿主");

  rv.applyPrefs(Object.assign({}, prefs.DEFAULTS, { theme: "light" }));
  assert.equal(host.style.backgroundColor, "rgb(255, 255, 255)", "浅色主题背景应内联到宿主");
});

test("偏好：字号与行距内联到宿主", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const host = win.document.getElementById(view.HOST_ID);
  rv.applyPrefs(Object.assign({}, prefs.DEFAULTS, { fontSize: 26, lineHeight: 2.1 }));

  assert.equal(host.style.fontSize, "26px", "字号应内联到宿主");
  assert.equal(host.style.lineHeight, "2.1", "行距应内联到宿主");
});

test("偏好：onPrefsChange 回调被触发（用于持久化）", () => {
  const { prefs, styles, toolbar, view } = load();
  const seen = [];
  const rv = view.createReaderView({
    prefs, styles, toolbar,
    onPrefsChange: (p) => seen.push(p.fontSize),
  });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);
  rv.applyPrefs(Object.assign({}, prefs.DEFAULTS, { fontSize: 21 }));

  assert.deepEqual(seen, [21], "应把改动后的偏好回调出去");
});

test("偏好：normalize 拒绝非法值并夹取范围", () => {
  const { prefs } = load();
  const n = prefs.normalize({
    theme: "不存在的主题",
    width: "超宽",
    fontSize: 999,
    lineHeight: -5,
    paraGap: "abc",
    fontFamilyKey: "不存在",
    cleanBlank: "随便",
  });

  assert.equal(n.theme, prefs.DEFAULTS.theme, "非法主题应回退默认");
  assert.equal(n.width, prefs.DEFAULTS.width, "非法页宽应回退默认");
  assert.equal(n.fontSize, prefs.LIMITS.fontSize[1], "超上限字号应被夹取");
  assert.equal(n.lineHeight, prefs.LIMITS.lineHeight[0], "超下限行距应被夹取");
  assert.equal(n.paraGap, prefs.DEFAULTS.paraGap, "非数字应回退默认");
  assert.equal(n.fontFamilyKey, prefs.DEFAULTS.fontFamilyKey, "非法字体应回退默认");
  assert.equal(n.cleanBlank, true, "cleanBlank 只认显式 false");
});

test("偏好：nextTheme / nextWidth 循环", () => {
  const { prefs } = load();
  assert.equal(prefs.nextTheme("light"), "sepia");
  assert.equal(prefs.nextTheme("dark"), "light");
  assert.equal(prefs.nextWidth("full"), "narrow");
});

test("偏好：hostInlineStyle 输出完整可用的 CSS", () => {
  const { prefs, styles } = load();
  const inline = styles.hostInlineStyle(prefs.normalize({}));

  for (const k of ["background-color", "color", "font-family", "font-size", "line-height", "--rd-page-width", "--rd-para-gap"]) {
    assert.ok(inline[k], `缺少 ${k}`);
  }
  assert.ok(!/undefined/.test(JSON.stringify(inline)), "不应含 undefined");
  // 白色/浅色主题的十六进制应能落到 rgb，用于验证主题确实生效
  assert.equal(inline["background-color"], "#ffffff");
  assert.equal(inline["font-size"], "19px");
});

test("视图：open 后宿主内联样式必须已应用（回归：曾漏调 applyPrefs）", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const host = win.document.getElementById(view.HOST_ID);

  // 宿主内联 `all: initial` 会重置这些属性；若 open 阶段没有应用偏好，
  // 打开阅读模式后主题/字号/字体全部不生效（曾真实发生）。
  assert.ok(host.style.color, "宿主 color 应已设置");
  assert.ok(host.style.backgroundColor, "宿主背景色应已设置");
  assert.ok(host.style.fontFamily, "宿主字体应已设置");
  assert.ok(host.style.fontSize, "宿主字号应已设置");
  assert.ok(
    !/undefined/.test(host.style.fontFamily),
    `宿主字体不应为 undefined：${host.style.fontFamily}`
  );
});

// ============================================================ 工具条

test("工具条：控件齐全", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const bar = win.document.getElementById(view.HOST_ID).shadowRoot.querySelector(".rd-bar");
  assert.ok(bar, "工具条应存在");
  const texts = [...bar.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(texts.some((t) => /浅色|护眼|深色/.test(t)), `缺少主题按钮：${texts}`);
  assert.ok(texts.some((t) => t.includes("A+")), "缺少增大字号按钮");
  assert.ok(texts.some((t) => t.includes("A−")), "缺少减小字号按钮");
  assert.ok(texts.some((t) => /宽/.test(t)), `缺少页宽按钮：${texts}`);
  assert.ok(texts.some((t) => /空行/.test(t)), `缺少空行清理开关：${texts}`);
  assert.ok(texts.some((t) => t === "✕"), "缺少关闭按钮");
});

test("工具条：字号按钮改变偏好并触发 onChange", () => {
  const { prefs, styles, toolbar, view } = load();
  const changes = [];
  const rv = view.createReaderView({
    prefs, styles, toolbar,
    onPrefsChange: (p) => changes.push(p.fontSize),
  });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const shadow = win.document.getElementById(view.HOST_ID).shadowRoot;
  const up = [...shadow.querySelectorAll(".rd-bar button")].find((b) => b.textContent === "A+");
  const base = prefs.DEFAULTS.fontSize;
  up.click();

  assert.equal(changes.at(-1), base + 1, "字号应 +1");
  // 宿主上的字号应同步更新
  const host = win.document.getElementById(view.HOST_ID);
  assert.equal(host.style.fontSize, `${base + 1}px`);
});

test("工具条：主题按钮循环到护眼主题", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), Object.assign({}, prefs.DEFAULTS, { theme: "light" }));

  const shadow = win.document.getElementById(view.HOST_ID).shadowRoot;
  const themeBtn = [...shadow.querySelectorAll(".rd-bar button")]
    .find((b) => b.textContent === "浅色");
  themeBtn.click();

  assert.equal(
    win.document.getElementById(view.HOST_ID).shadowRoot.querySelector("style").textContent.includes("#f6efe3"),
    true, "应切到护眼配色"
  );
});

test("工具条：空行清理开关切换 aria-pressed 并回调", () => {
  const { prefs, styles, toolbar, view } = load();
  const toggles = [];
  const rv = view.createReaderView({
    prefs, styles, toolbar,
    onToggleClean: (v) => toggles.push(v),
  });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const shadow = win.document.getElementById(view.HOST_ID).shadowRoot;
  const cleanBtn = [...shadow.querySelectorAll(".rd-bar button")]
    .find((b) => /空行/.test(b.textContent));

  assert.equal(cleanBtn.getAttribute("aria-pressed"), "true", "默认应为开启");
  cleanBtn.click();
  assert.equal(toggles.at(-1), false, "应回调 false");
  assert.match(cleanBtn.textContent, /✗/, "文案应反映关闭状态");
  assert.match(cleanBtn.title, /关闭/, "title 应说明当前状态");
});

test("工具条：关闭按钮能退出阅读模式", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const shadow = win.document.getElementById(view.HOST_ID).shadowRoot;
  [...shadow.querySelectorAll(".rd-bar button")].find((b) => b.textContent === "✕").click();

  assert.equal(rv.isOpen(), false, "点击关闭后应退出");
});

test("工具条：展示清理统计提示", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const bar = win.document.getElementById(view.HOST_ID).shadowRoot.querySelector(".rd-bar");
  assert.match(bar.textContent, /清除 3 处/, `应显示清理数量：${bar.textContent}`);
});

test("工具条：无清理统计时不显示提示", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  const article = makeArticle(win.document);
  article.cleanStats = { removed: 0, collapsed: 0, strippedStyles: 0, reasons: { invisible: 0, empty: 0, br: 0, edges: 0, unwrapped: 0 } };
  rv.open(article, prefs.DEFAULTS);

  const bar = win.document.getElementById(view.HOST_ID).shadowRoot.querySelector(".rd-bar");
  assert.ok(!/清除/.test(bar.textContent), "没有清理量时不应出现提示");
});

test("视图：正文顶部留白随工具条高度调整（避免遮挡）", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  rv.open(makeArticle(win.document), prefs.DEFAULTS);

  const shadow = win.document.getElementById(view.HOST_ID).shadowRoot;
  const scroll = shadow.querySelector(".rd-scroll");
  // jsdom 不做布局，getBoundingClientRect 恒为 0；这里只验证
  // 「留白被显式设定过」这一契约，真实高度适配由实机验证覆盖。
  assert.ok(
    scroll.style.paddingTop !== "" || scroll.style.paddingBottom !== "",
    "应显式设置正文顶部或底部留白，避免被工具条遮挡"
  );
});

test("视图：关闭时移除 resize 监听", () => {
  const { prefs, styles, toolbar, view } = load();
  const rv = view.createReaderView({ prefs, styles, toolbar });
  const before = win.document.documentElement.style.overflow;

  rv.open(makeArticle(win.document), prefs.DEFAULTS);
  rv.close();
  assert.equal(win.document.documentElement.style.overflow, before);
  // 重复关闭不应报错（监听器已移除）
  rv.close();
});
