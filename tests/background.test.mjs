/**
 * background.js 的注入逻辑测试。
 *
 * 这是此前测试覆盖的空白区：之前所有验证都是直接在页面里 evaluate 扩展脚本，
 * **绕过了 background 的注入流程**，因此「点图标没反应」这类问题完全测不出来。
 *
 * 这里用 Node + mock 的 browser API 加载真实的 background.js，
 * 模拟 action 点击与 commands 触发，断言注入行为符合预期。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BG_SOURCE = readFileSync(join(ROOT, "src/background.js"), "utf8");

/** 从 background.js 解析出模块数（唯一事实来源），避免新增模块后测试失效。 */
const MODULE_COUNT = (() => {
  const m = /const CONTENT_SCRIPTS = \[([\s\S]*?)\];/.exec(BG_SOURCE);
  if (!m) throw new Error("无法从 background.js 解析 CONTENT_SCRIPTS");
  return [...m[1].matchAll(/"([^"]+)"/g)].length;
})();

/**
 * 造一个 mock 的 browser 环境并加载 background.js。
 *
 * @param {object} opts
 * @param {object} opts.tab        传给 onClicked / query 的 tab 对象
 * @param {Function} [opts.executeScript] 自定义 executeScript 行为（默认成功）
 * @param {object} [opts.queryResult] tabs.query 返回的数组
 */
function loadBackground(opts) {
  const options = opts || {};
  const calls = { executeScript: [], query: [] };
  const badge = [];

  let actionListener = null;
  let commandListener = null;

  const executeScript =
    options.executeScript ||
    defaultExecuteScript(options.alreadyInjected === true, calls);

/**
 * 默认的 executeScript 行为，模拟真实语义：
 *   - func 形式：模拟页面内的 tryToggle，返回 {state} 结构
 *   - files 形式：注入成功 —— 且注入**之后**页面就拥有 __reader 了
 *
 * 最后这点很关键：注入成功后，后续的 tryToggle 必须返回 ok，
 * 否则会误判成「注入后仍未找到 __reader」。用一个可变状态模拟这个副作用。
 *
 * @param {boolean} alreadyInjected 页面初始是否已注入 __reader
 */
function defaultExecuteScript(alreadyInjected, calls) {
  let injected = alreadyInjected === true;
  return async (details) => {
    calls.executeScript.push(details);

    if (typeof details.func === "function") {
      return [
        {
          frameId: 0,
          result: injected ? { state: "ok", result: true } : { state: "not-injected" },
        },
      ];
    }

    // files 形式 = 真正注入，产生副作用：页面从此拥有 __reader
    injected = true;
    return [{ frameId: 0, result: undefined }];
  };
}

  const browserMock = {
    action: {
      onClicked: { addListener: (fn) => { actionListener = fn; } },
      setBadgeText: (o) => badge.push(["text", o]),
      setBadgeBackgroundColor: (o) => badge.push(["color", o]),
      setTitle: (o) => badge.push(["title", o]),
    },
    commands: {
      onCommand: { addListener: (fn) => { commandListener = fn; } },
      update: async () => {},
      getAll: async () => [],
    },
    scripting: { executeScript },
    tabs: {
      query: async (q) => {
        calls.query.push(q);
        return options.queryResult || [options.tab].filter(Boolean);
      },
    },
    runtime: { getManifest: () => ({ version: "0.1.0" }) },
  };

  const sandbox = {
    browser: browserMock,
    chrome: undefined,
    console: { debug() {}, warn() {}, log() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BG_SOURCE, sandbox, { filename: "background.js" });

  return {
    calls,
    badge,
    clickAction: (tab) => actionListener(tab),
    fireCommand: (cmd) => commandListener(cmd),
  };
}

// ============================================================ 正常路径

test("点击图标：未注入时应注入整包并打开阅读模式", async () => {
  const tab = { id: 7, url: "https://example.com/post" };
  const bg = loadBackground({ tab, alreadyInjected: false });

  await bg.clickAction(tab);
  await new Promise((r) => setTimeout(r, 20));

  // 新流程：试切换 → 逐文件注入（9 个文件）→ 切换
  const injectedFiles = bg.calls.executeScript.filter((c) => c.files);
  assert.equal(
    injectedFiles.length, MODULE_COUNT,
    `应逐个注入 9 个模块文件，实际 ${injectedFiles.length}`
  );
  assert.ok(
    injectedFiles.every((c) => c.files.length === 1),
    "每个文件单独注入（便于把失败归因到具体文件）"
  );

  const injectedPaths = injectedFiles.map((c) => c.files[0]);
  assert.equal(injectedPaths[0], "src/vendor/readability.js", "readability 必须最先");
  assert.equal(
    injectedPaths.at(-1), "src/content/main.js",
    "main.js 必须最后（负责装配）"
  );
  assert.ok(injectedPaths.length >= MODULE_COUNT, `模块数应 >= ${MODULE_COUNT}，实际 ${injectedPaths.length}`);

  // 注入后的那次切换应强制打开（force=true）
  const toggleCalls = bg.calls.executeScript.filter((c) => typeof c.func === "function");
  assert.equal(toggleCalls[0].args[0], null, "首次尝试不强制（用于判断是否已注入）");
  assert.equal(toggleCalls.at(-1).args[0], true, "注入后应强制打开");
});

test("点击图标：已注入时只需一次调用，不重复注入", async () => {
  const tab = { id: 7, url: "https://example.com/post" };
  const bg = loadBackground({ tab, alreadyInjected: true });

  await bg.clickAction(tab);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(
    bg.calls.executeScript.filter((c) => c.files).length, 0,
    "已注入时不应再次注入"
  );
  assert.equal(
    bg.calls.executeScript.length, 1,
    "已注入时只应有一次 executeScript 调用"
  );
});

test("快捷键：commands.onCommand 应触发同一套注入流程", async () => {
  const tab = { id: 9, url: "https://example.com/post" };
  const bg = loadBackground({ tab, queryResult: [tab], alreadyInjected: false });

  await bg.fireCommand("toggle-reader");
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(bg.calls.query.length, 1, "应查询当前活动标签页");
  assert.equal(
    bg.calls.executeScript.filter((c) => c.files).length, MODULE_COUNT,
    "应逐个注入 9 个模块"
  );
});

test("快捷键：非本扩展的命令应被忽略", async () => {
  const tab = { id: 9, url: "https://example.com/post" };
  const bg = loadBackground({ tab, queryResult: [tab] });

  await bg.fireCommand("some-other-command");
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(bg.calls.executeScript.length, 0, "无关命令不应触发任何注入");
});

// ============================================================ 关键：tab.url 缺失

test("★ tab.url 缺失（无 tabs 权限）时仍必须尝试注入", async () => {
  // 回归：仅申请 activeTab 时，tab.url 可能是 undefined。
  // 旧实现在这里 `tab.url || ""` → 正则不匹配 → 直接 return，
  // 表现为「点图标完全没反应」。注入不应依赖 tab.url。
  const tab = { id: 11 };   // 故意不给 url
  const bg = loadBackground({ tab, alreadyInjected: false });

  await bg.clickAction(tab);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(
    bg.calls.executeScript.filter((c) => c.files).length, MODULE_COUNT,
    "即使拿不到 tab.url，也必须尝试注入（不能静默返回）"
  );
  // 成功路径会调用 clearBadge 清空角标（setBadgeText 传空字符串），
  // 这是正常的；关键是**不能**出现失败标记（"!" 或 "×"）。
  const failBadges = bg.badge.filter(
    ([, o]) => o.text === "!" || o.text === "×"
  );
  assert.equal(
    failBadges.length, 0,
    `不应显示失败角标，实际角标序列：${JSON.stringify(bg.badge)}`
  );
});

test("★ 受限页面（about:）注入失败时应给出可见反馈，而非静默", async () => {
  const tab = { id: 13, url: "about:config" };
  const bg = loadBackground({
    tab,
    executeScript: async (details) => {
      bg.calls.executeScript.push(details);
      throw new Error("Missing host permission for the tab");
    },
  });

  await bg.clickAction(tab);
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(
    bg.badge.length > 0,
    "注入失败时必须让用户看到反馈（如角标），不能什么都不做"
  );
});

test("首次点击失败后，第二次点击仍应可重试", async () => {
  let attempt = 0;
  const tab = { id: 17, url: "https://example.com/post" };
  const bg = loadBackground({
    tab,
    executeScript: async (details) => {
      bg.calls.executeScript.push(details);
      if (typeof details.func === "function") return [{ result: { state: "not-injected" } }];
      attempt++;
      if (attempt === 1) throw new Error("transient failure");
      return [{ result: undefined }];
    },
  });

  await bg.clickAction(tab);
  await new Promise((r) => setTimeout(r, 10));
  await bg.clickAction(tab);
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(attempt >= 2, "第二次点击应重新尝试注入，而不是被永久卡住");
});

// ============================================================ 边界

test("无 tab 或无 id 时应安全返回", async () => {
  const bg = loadBackground({ tab: null });
  await bg.clickAction(undefined);
  await bg.clickAction({});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bg.calls.executeScript.length, 0, "不应有副作用");
});

test("注入的模块清单与文件系统一致", () => {
  const bg = loadBackground({ tab: { id: 1 } });
  // 从源码里取出 CONTENT_SCRIPTS 声明的路径
  const match = /const CONTENT_SCRIPTS = \[([\s\S]*?)\];/.exec(BG_SOURCE);
  assert.ok(match, "应能解析出 CONTENT_SCRIPTS");
  const paths = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= MODULE_COUNT, `模块数应 >= ${MODULE_COUNT}，实际 ${paths.length}`);

  for (const p of paths) {
    assert.ok(
      readFileSync(join(ROOT, p), "utf8").length > 0,
      `注入清单里的文件不存在或为空：${p}`
    );
  }

  // 顺序约束：依赖在前，装配在后
  assert.ok(
    paths.indexOf("src/content/clean/dom-utils.js") < paths.indexOf("src/content/clean/clean-blank.js"),
    "dom-utils 必须在 clean-blank 之前"
  );
  assert.ok(
    paths.indexOf("src/content/reader-view.js") < paths.indexOf("src/content/main.js"),
    "reader-view 必须在 main 之前"
  );
});
