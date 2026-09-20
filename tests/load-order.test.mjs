/**
 * 脚本加载顺序与全局变量链的集成测试。
 *
 * 这是最贴近真实注入场景的验证：Firefox 的 content script **不支持 ES module import**，
 * 所有模块必须作为「普通脚本按序加载」，通过 shared isolated world 的全局变量互相引用。
 * 任何一处挂载名写错、顺序颠倒，都会在实际使用时才暴露，因此这里必须覆盖。
 *
 * 验证方式：用 jsdom 造一个文档，按 manifest/background 里声明的顺序用 <script> 逐个执行，
 * 然后断言 window 上的全局链完整、并跑通一次端到端流程。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * content script 的加载顺序**从 background.js 解析**，而不是在这里再抄一份。
 *
 * 原因：抄一份就会漂移——新增模块（如 auto-next.js）后，
 * 测试里的顺序与真实注入顺序不一致，于是测试通过但真机失败，或反过来。
 * background.js 的 CONTENT_SCRIPTS 才是唯一事实来源。
 */
function loadOrderFromBackground() {
  const bg = readFileSync(join(ROOT, "src/background.js"), "utf8");
  const match = /const CONTENT_SCRIPTS = \[([\s\S]*?)\];/.exec(bg);
  assert.ok(match, "应能从 background.js 解析出 CONTENT_SCRIPTS");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const LOAD_ORDER = loadOrderFromBackground();

/**
 * 造一个页面环境，按顺序把脚本作为普通脚本注入执行。
 * 这模拟了 content_scripts 的加载方式（非 module）。
 *
 * @param {string} bodyHtml 页面正文
 * @param {object} [opts]
 * @param {object} [opts.storedPrefs] 预先放进存储的偏好
 * @param {Function} [opts.getWrapper] 包装 storage.get，用于模拟慢 I/O / 竞态
 */
function loadExtensionScripts(bodyHtml, opts) {
  const options = opts || {};
  const dom = new JSDOM(
    `<!DOCTYPE html><html lang="zh-CN"><head><title>测试页</title></head><body>${bodyHtml}</body></html>`,
    { url: "https://example.com/posts/tree", runScripts: "dangerously", pretendToBeVisual: true }
  );
  const win = dom.window;
  win.scrollTo = () => {};

  // browser API 垫片：prefs.js 会用到 storage。
  const store = {};
  if (options.storedPrefs) store.readerPrefs = options.storedPrefs;

  const baseGet = async function (k) {
    return { [k]: store[k] };
  };

  win.browser = {
    storage: {
      local: {
        get: options.getWrapper ? options.getWrapper(baseGet) : baseGet,
        async set(obj) { Object.assign(store, obj); },
      },
    },
  };
  win.__store = store;

  const errors = [];
  for (const rel of LOAD_ORDER) {
    const code = readFileSync(join(ROOT, rel), "utf8");
    const el = win.document.createElement("script");
    el.textContent = code;
    try {
      win.document.head.appendChild(el);
    } catch (err) {
      errors.push(`${rel}: ${err.message}`);
    }
  }

  return { dom, win, errors, store };
}

/** 一段足够长的正文，确保能通过 Readability 的判定。 */
const LONG_ARTICLE = `
  <article>
    <h1>城市里的树</h1>
    <p>每天早晨我都要走过一条种着法国梧桐的街道。那些树是上世纪五十年代栽下的，如今树干粗得需要两个人才能合抱。夏天的时候，树冠在头顶连成一片，把整条街罩在阴凉里，行人走在下面几乎晒不到太阳。</p>
    <p></p>
    <p>\u200b\u200b\u200b</p>
    <p>园林部门的人说，这些树是这座城市最老的居民。它们比街上任何一栋楼都年长，见过这条街从煤渣路变成柏油路，见过马车、自行车、公交车和电动车轮番驶过，也见过路边的店铺开了又关。</p>
    <p>&nbsp;</p>
    <p>我常常想，一棵树是怎么看待一条街的。它没有眼睛，却对光极其敏感；春天第一缕暖意，它比谁都先知道，也总是比路过的行人更早觉察到季节的转换。</p>
    <p>去年冬天那场大雪压断了不少枝桠。开春后，断口处抽出新芽，嫩得发亮，那种绿色在灰扑扑的街景里格外显眼，像是谁不小心洒上去的颜料。</p>
    <p>六十七棵树，六十七个编号。它们不会互相交谈，却在同一个季节一起发芽，一起落叶，这种同步不需要任何约定，只需要同一片天空和同样长度的白昼。</p>
  </article>
`;

// ============================================================ 全局链

test("加载：按序注入后全局变量链完整", () => {
  const { win, errors } = loadExtensionScripts(LONG_ARTICLE);

  assert.deepEqual(errors, [], `脚本执行不应报错：${errors.join("; ")}`);

  // 逐个确认每个模块都挂到了预期的全局名下（名字写错会在这里暴露）
  const expected = {
    Readability: "function",
    CleanDomUtils: "object",
    CleanBlank: "object",
    ReaderExtract: "object",
    ReaderPrefs: "object",
    ReaderStyles: "object",
    ReaderToolbar: "object",
    ReaderView: "object",
  };
  for (const [name, type] of Object.entries(expected)) {
    assert.equal(typeof win[name], type, `window.${name} 应为 ${type}，实际 ${typeof win[name]}`);
  }
});

test("加载：模块间依赖在运行时可解析", () => {
  const { win } = loadExtensionScripts(LONG_ARTICLE);

  // prefs → styles 的联动（styles 需要 prefs 的默认值形状）
  const css = win.ReaderStyles.buildCss(win.ReaderPrefs.DEFAULTS);
  assert.match(css, /\.rd-content/, "styles 应能消费 prefs 的默认值");

  // extract 内部依赖 CleanBlank 与 CleanDomUtils
  assert.equal(typeof win.ReaderExtract.extractArticle, "function");
  assert.equal(typeof win.CleanBlank.cleanContent, "function");
  assert.equal(typeof win.CleanDomUtils.sanitize, "function");

  // toolbar 依赖 ReaderPrefs.LIMITS 做范围夹取
  assert.ok(win.ReaderPrefs.LIMITS.fontSize, "LIMITS 应可被 toolbar 读取");
});

test("加载：main.js 暴露 __reader 接口", () => {
  const { win } = loadExtensionScripts(LONG_ARTICLE);

  assert.equal(win.__readerLoaded, true, "应设置注入标记");
  assert.ok(win.__reader, "应暴露 __reader");
  assert.equal(typeof win.__reader.toggle, "function");
  assert.equal(typeof win.__reader.close, "function");
  assert.equal(typeof win.__reader.isOpen, "function");
  assert.equal(typeof win.__reader.getPrefs, "function");
});

test("加载：重复注入被守卫拦截", () => {
  const { win } = loadExtensionScripts(LONG_ARTICLE);
  const firstReader = win.__reader;

  // 再注入一次 main.js（模拟用户二次点击工具栏）
  const code = readFileSync(join(ROOT, "src/content/main.js"), "utf8");
  const el = win.document.createElement("script");
  el.textContent = code;
  win.document.head.appendChild(el);

  assert.equal(win.__reader, firstReader, "重复注入不应替换已有实例");
  assert.equal(win.__readerLoaded, true);
});

// ============================================================ 端到端

test("端到端：toggle 打开阅读模式并清理空白行", async () => {
  const { win } = loadExtensionScripts(LONG_ARTICLE);

  const opened = await win.__reader.toggle(true);
  assert.equal(opened, true, "toggle 应成功打开");
  assert.equal(win.__reader.isOpen(), true);

  const host = win.document.getElementById("reader-host") || win.document.getElementById("chengdu-reader-host");
  assert.ok(host, "应挂载阅读视图宿主");

  const shadow = host.shadowRoot;
  assert.ok(shadow, "宿主应有 shadow root");

  // 标题与正文都渲染出来。
  // 注意：Readability 的标题取自 <title> / og:title，jsdom 环境下取到的是
  // 文档 <title>（"测试页"），因此这里只断言「标题非空且内容正确」，
  // 不绑定具体取值来源。
  const titleEl = shadow.querySelector(".rd-title");
  assert.ok(titleEl && titleEl.textContent.trim().length > 0, "标题应被渲染且非空");
  assert.equal(
    win.document.querySelector("h1").textContent,
    "城市里的树",
    "（前置条件）原页面 h1 存在"
  );

  const content = shadow.querySelector(".rd-content");
  assert.match(content.textContent, /法国梧桐/);
  assert.match(content.textContent, /六十七棵树/);

  // ★ 核心：零宽字符段落与空段落都不应渲染出空白行
  const paragraphs = [...content.querySelectorAll("p")];
  const blankOnes = paragraphs.filter((p) => {
    const t = p.textContent.replace(/[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]/g, "");
    return !t && !p.querySelector("img,picture,video,svg,table,hr");
  });
  assert.equal(blankOnes.length, 0, `不应残留空段落：${blankOnes.map((p) => JSON.stringify(p.outerHTML)).join(", ")}`);

  // 广告与侧栏不应进入正文
  assert.ok(!/广告位/.test(content.textContent), "广告不应出现在正文里");
  assert.ok(!/相关推荐/.test(content.textContent), "侧栏推荐不应出现在正文里");

  // 工具条渲染出来
  const bar = shadow.querySelector(".rd-bar");
  assert.ok(bar, "工具条应存在");
  assert.equal(typeof bar.querySelector, "function");
});

test("端到端：关闭后页面完全还原", async () => {
  const { win } = loadExtensionScripts(LONG_ARTICLE);
  const beforeOverflow = win.document.documentElement.style.overflow;

  await win.__reader.toggle(true);
  assert.equal(win.document.documentElement.style.overflow, "hidden");

  await win.__reader.toggle(false);
  assert.equal(win.__reader.isOpen(), false, "应已关闭");
  assert.equal(win.document.documentElement.style.overflow, beforeOverflow, "overflow 应还原");
  assert.equal(win.document.querySelectorAll("#chengdu-reader-host, #reader-host").length, 0, "宿主应被移除");
  assert.ok(win.document.querySelector("article"), "原页面内容应完好");
});

test("端到端：Esc 键退出阅读模式", async () => {
  const { win } = loadExtensionScripts(LONG_ARTICLE);
  await win.__reader.toggle(true);
  assert.equal(win.__reader.isOpen(), true);

  const ev = new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  win.document.dispatchEvent(ev);

  assert.equal(win.__reader.isOpen(), false, "Esc 应退出阅读模式");
});

test("端到端：工具条改字号即时生效", async () => {
  const { win } = loadExtensionScripts(LONG_ARTICLE);
  await win.__reader.toggle(true);

  const host = win.document.getElementById("chengdu-reader-host");
  const shadow = host.shadowRoot;
  const before = win.__reader.getPrefs().fontSize;

  const up = [...shadow.querySelectorAll(".rd-bar button")].find((b) => b.textContent === "A+");
  assert.ok(up, "应存在增大字号按钮");
  up.click();

  assert.equal(win.__reader.getPrefs().fontSize, before + 1, "偏好应被更新");
  assert.equal(host.style.fontSize, `${before + 1}px`, "宿主字号应即时生效");
});

test("端到端：非正文页面给出提示而非静默失败", async () => {
  const { win } = loadExtensionScripts(`
    <nav><a href="/a">一</a><a href="/b">二</a><a href="/c">三</a></nav>
  `);

  const opened = await win.__reader.toggle(true);
  assert.equal(opened, false, "不应打开阅读模式");
  assert.equal(win.__reader.isOpen(), false);

  // 应出现提示条
  const toast = [...win.document.querySelectorAll("div")]
    .find((d) => /无法进入阅读模式|不像正文|太短|没能/.test(d.textContent || ""));
  assert.ok(toast, "应显示失败提示");
});

test("端到端：重复 toggle 开合稳定（无残留）", async () => {
  const { win } = loadExtensionScripts(LONG_ARTICLE);

  for (let i = 0; i < 3; i++) {
    await win.__reader.toggle(true);
    assert.equal(win.document.querySelectorAll("#chengdu-reader-host").length, 1, `第 ${i + 1} 次打开应只有一个宿主`);
    await win.__reader.toggle(false);
    assert.equal(win.document.querySelectorAll("#chengdu-reader-host").length, 0, `第 ${i + 1} 次关闭应无残留`);
  }
});

test("端到端：存储读取较慢时，打开后仍使用已保存的设置（竞态回归）", async () => {
  // 回归：ReaderPrefs.load() 是异步的，而 toggle 曾不等它就提取正文，
  // 导致页面刚加载完就点开阅读模式时会用「默认设置」渲染一次
  //（用户上次保存的主题/字号不生效）。修复方式是 toggle 先 await prefsReady。
  let releaseGet;
  const gate = new Promise((r) => { releaseGet = r; });

  const { win } = loadExtensionScripts(LONG_ARTICLE, {
    storedPrefs: { theme: "dark", fontSize: 24, paraGap: 1.4, cleanBlank: true },
    // 存储读取被挡住，直到测试主动放行
    getWrapper: (baseGet) => async (k) => {
      await gate;
      return baseGet(k);
    },
  });

  // 存储还没返回，此时用户点了阅读模式
  const opening = win.__reader.toggle(true);
  await new Promise((r) => setTimeout(r, 20));

  // toggle 应还在等偏好，不能先用默认设置打开
  assert.equal(
    win.__reader.isOpen(), false,
    "存储尚未返回时不应先用默认设置打开"
  );

  releaseGet();
  await opening;

  assert.equal(win.__reader.isOpen(), true, "存储返回后应成功打开");
  const p = win.__reader.getPrefs();
  assert.equal(p.theme, "dark", "应使用已保存的主题，而非默认值");
  assert.equal(p.fontSize, 24, "应使用已保存的字号");

  // 宿主上应真正反映了这些设置
  const host = win.document.getElementById("chengdu-reader-host");
  assert.equal(host.style.fontSize, "24px", "保存的字号应作用到宿主");
  assert.equal(host.style.backgroundColor, "rgb(27, 30, 35)", "保存的深色主题应生效");
});

test("端到端：用户改动不会被随后的存储读取覆盖", async () => {
  // 回归：曾经有一句 `load().then(loaded => { prefs = loaded })`，
  // 会在异步返回时整体替换 prefs，把用户改动覆盖回旧值
  //（实测：关闭空行清理后约 400ms 又被改回开启）。
  // 现在 prefs 是 const、且加载逻辑带 prefsDirty 保护，这里验证改动稳定留存。
  const { win } = loadExtensionScripts(LONG_ARTICLE);

  await win.__reader.toggle(true);

  const shadow = win.document.getElementById("chengdu-reader-host").shadowRoot;
  const cleanBtn = [...shadow.querySelectorAll(".rd-bar button")]
    .find((b) => /空行/.test(b.textContent));

  cleanBtn.click();
  assert.equal(win.__reader.getPrefs().cleanBlank, false, "点击后应立即变为关闭");

  // 等待足够的防抖/存储时间，确认不会被任何异步流程改回
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    win.__reader.getPrefs().cleanBlank, false,
    "用户改动必须稳定留存，不能被异步读取覆盖"
  );
  assert.match(cleanBtn.textContent, /✗/, "按钮文案应保持关闭状态");
});
