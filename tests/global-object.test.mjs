/**
 * 全局对象差异的回归测试（★ 本项目最隐蔽的一个 bug）。
 *
 * ## 背景
 *
 * 实机验证时发现：脚本全部注入成功，但 main.js 报「依赖模块未加载」。
 * 诊断探针给出了决定性证据 —— 同一个 isolated world 里：
 *
 *   globalThis.Readability  → "function"   （模块确实挂上了）
 *   window.Readability      → "undefined"  （main.js 从 window 读 → 读不到）
 *
 * 根因：**Firefox content script 的 isolated world 里 `window !== globalThis`**。
 * 所有模块的 UMD 包装写 `root.X = mod`，root 取 globalThis；
 * 而 main.js 原先读 `window[name]`，于是全部 undefined。
 *
 * ## 为什么其他测试测不出
 *
 * jsdom 环境里 `window === globalThis`（同一个对象），
 * 因此即使代码用错了对象，测试也全部通过。
 *
 * ## 本文件的做法
 *
 * 用 Node 的 vm 模块构造一个 **`window !== globalThis`** 的沙箱，
 * 复现真实 Firefox 的环境差异，从而把这类 bug 挡在提交之前。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * content script 的加载顺序**从 background.js 解析**，避免与真实注入顺序漂移。
 * 新增模块后（如 auto-next.js），这里会自动跟随，无需手工同步。
 */
function loadOrderFromBackground() {
  const bg = readFileSync(join(ROOT, "src/background.js"), "utf8");
  const match = /const CONTENT_SCRIPTS = \[([\s\S]*?)\];/.exec(bg);
  assert.ok(match, "应能从 background.js 解析出 CONTENT_SCRIPTS");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const LOAD_ORDER = loadOrderFromBackground();

/**
 * 一段足够长的正文，确保通过 isLikelyReaderable 的 MIN_CONTENT_LENGTH(120) 判定。
 * 注意：中文字符在 JS 里按 code unit 计数，样本太短会被直接拒绝——
 * 这曾经让我误判成代码 bug，实际是测试数据不足。
 */
const ARTICLE = `
  <article>
    <h1>城市里的树</h1>
    <p>每天早晨我都要走过一条种着法国梧桐的街道。那些树是上世纪五十年代栽下的，如今树干粗得需要两个人才能合抱，夏天的时候树冠在头顶连成一片，把整条街罩在阴凉里，行人走在下面几乎晒不到太阳。</p>
    <p>园林部门的人说，这些树是这座城市最老的居民。它们比街上任何一栋楼都年长，见过这条街从煤渣路变成柏油路，见过马车、自行车、公交车和电动车轮番驶过，也见过路边的店铺开了又关。</p>
    <p>我常常想，一棵树是怎么看待一条街的。它没有眼睛，却对光极其敏感；春天第一缕暖意，它比谁都先知道，也总是比路过的行人更早觉察到季节的转换。</p>
    <p></p>
    <p>&nbsp;</p>
  </article>
`;

/**
 * 构造一个「window !== globalThis」的沙箱，模拟 Firefox content script 的
 * isolated world，然后按顺序把脚本作为普通脚本执行。
 *
 * @param {boolean} separateWindow true = 复现 Firefox（window 与 globalThis 分离）
 */
function loadInSandbox(separateWindow) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${ARTICLE}</body></html>`, {
    url: "https://example.com/post",
    pretendToBeVisual: true,
  });

  const errors = [];

  // 沙箱本身作为 globalThis
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout,
    clearTimeout,
    Promise,
    Object,
    Array,
    JSON,
    Error,
    TypeError,
    String,
    Number,
    Boolean,
    Math,
    Date,
    RegExp,
    Map,
    Set,
    Symbol,
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    scrollTo: () => {},
    addEventListener() {},
    removeEventListener() {},
    // prefs.js 需要的浏览器 API 垫片
    browser: {
      storage: {
        local: { get: async () => ({}), set: async () => {} },
      },
      // 自动续页会通过 runtime.sendMessage 请求 background 抓取；
      // 本测试不涉及翻页，只需一个不抛错的桩。
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          if (typeof cb === "function") cb({ ok: false, reason: "stub" });
        },
      },
    },
    // main.js 的自动续页会用 location.href 作为来源 URL
    location: { href: "https://example.com/post" },
  };
  sandbox.globalThis = sandbox;

  // 关键：让 window 成为「另一个对象」，复现 Firefox 的差异。
  // 两者共享 DOM API，但不是同一个对象。
  if (separateWindow) {
    sandbox.window = Object.assign({}, {
      // window 上也有一些 DOM API（真实环境两者都能访问 DOM）
      document: dom.window.document,
      DOMParser: dom.window.DOMParser,
      addEventListener() {},
      removeEventListener() {},
      scrollTo: () => {},
      requestAnimationFrame: (cb) => setTimeout(cb, 0),
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
  } else {
    sandbox.window = sandbox;
  }

  vm.createContext(sandbox);

  for (const rel of LOAD_ORDER) {
    const code = readFileSync(join(ROOT, rel), "utf8");
    try {
      vm.runInContext(code, sandbox, { filename: rel });
    } catch (err) {
      errors.push(`${rel}: ${err.message}`);
    }
  }

  return { sandbox, dom, errors };
}

test("★ window !== globalThis 时，模块必须挂在 globalThis 上且被正确定位", () => {
  const { sandbox, errors } = loadInSandbox(true);

  assert.deepEqual(errors, [], `脚本执行不应报错：${errors.join("; ")}`);

  // 前提确认：沙箱里 window 与 globalThis 确实是不同对象（复现了 Firefox）
  assert.notEqual(
    sandbox.window, sandbox.globalThis,
    "本测试必须构造 window !== globalThis 的环境，否则测不出问题"
  );

  // 模块应挂在 globalThis 上（UMD 的 root 取 globalThis）
  for (const name of [
    "Readability", "CleanDomUtils", "CleanBlank", "ReaderExtract",
    "ReaderPrefs", "ReaderStyles", "ReaderToolbar", "ReaderView",
  ]) {
    assert.notEqual(
      sandbox[name], undefined,
      `${name} 应挂在 globalThis 上`
    );
  }

  // 关键断言：main.js 必须能跨越 window/globalThis 差异找到模块，
  // 并在 globalThis 上暴露 __reader（而不是在 window 上）。
  assert.notEqual(
    sandbox.__reader, undefined,
    "main.js 应在 globalThis 上暴露 __reader —— 这正是曾经的 bug：它读 window 找模块、写 window 暴露接口"
  );
  assert.equal(typeof sandbox.__reader.toggle, "function");
  assert.equal(
    sandbox.__readerLoadError, undefined,
    `不应有加载错误，实际：${sandbox.__readerLoadError}`
  );
});

test("★ window !== globalThis 时，toggle 仍能正常打开阅读模式", async () => {
  const { sandbox } = loadInSandbox(true);

  const opened = await sandbox.__reader.toggle(true);
  assert.equal(opened, true, "应成功打开");
  assert.equal(sandbox.__reader.isOpen(), true);

  const host = sandbox.document.getElementById("chengdu-reader-host");
  assert.ok(host, "应挂载阅读视图宿主");

  const content = host.shadowRoot.querySelector(".rd-content");
  assert.match(content.textContent, /法国梧桐/, "正文应渲染");

  await sandbox.__reader.toggle(false);
  assert.equal(sandbox.__reader.isOpen(), false, "应能正常关闭");
});

test("对照：window === globalThis 时同样正常（不引入回归）", () => {
  const { sandbox, errors } = loadInSandbox(false);

  assert.deepEqual(errors, []);
  assert.equal(sandbox.window, sandbox.globalThis, "本用例两者应为同一对象");
  assert.notEqual(sandbox.__reader, undefined, "应正常暴露 __reader");
  assert.equal(typeof sandbox.__reader.toggle, "function");
});

test("★ background 的读取路径必须兼容 window 与 globalThis 分离", () => {
  // background.js 通过 executeScript({func}) 访问页面里的 __reader。
  // 那段 func 也运行在同一个 isolated world，因此同样可能遇到
  // 「__reader 在 globalThis 上、而代码读的是 window」的问题。
  const bg = readFileSync(join(ROOT, "src/background.js"), "utf8");

  // 检测那段 func：应同时考虑 globalThis 与 window
  assert.match(
    bg, /globalThis/,
    "background 的注入函数应使用 globalThis（content script 里 window !== globalThis）"
  );

  // 不应再出现「只读 window.__reader」的写法
  const onlyWindowReader = /window\.__reader\s*&&/.test(bg) && !/globalThis[\s\S]{0,200}__reader/.test(bg);
  assert.ok(
    !onlyWindowReader,
    "background 不应只从 window 读取 __reader —— 实测该对象挂在 globalThis 上"
  );
});

test("★ 所有模块的 UMD 包装必须写入同一个全局对象", () => {
  // 若某个模块写 window、另一个写 globalThis，就会出现「部分模块找不到」，
  // 这种半失效最难排查。这里统一校验：都用 globalThis。
  //
  // 只检查真正的 UMD 模块（形如 `})(rootExpr, factory)`），
  // main.js / readability.js 不是 UMD，不在此列。
  let checked = 0;

  for (const rel of LOAD_ORDER) {
    const code = readFileSync(join(ROOT, rel), "utf8");

    // UMD 特征：文件尾部的 `})(...root表达式...)`
    const hasUmdTail = /\}\)\([^)]*(globalThis|this)[^)]*\)/.test(code);
    if (!hasUmdTail) continue;   // 非 UMD 模块

    checked++;
    const usesGlobalThis = /typeof globalThis !== "undefined"\s*\?\s*globalThis/.test(code);
    assert.ok(
      usesGlobalThis,
      `${rel} 的 UMD 包装应以 globalThis 为 root，避免与读取方不一致`
    );
  }

  assert.ok(checked >= 6, `应至少检查 6 个 UMD 模块，实际 ${checked}`);
});
