/**
 * 快捷键配置与「唯一来源」守卫。
 *
 * 背景：曾出现两个真实问题——
 *   1. 切换快捷键在 manifest 的 commands **和** content script 的 keydown 里
 *      各注册了一次，一次按键被处理两遍 → 打开后立刻又关闭，看起来像快捷键失灵；
 *   2. 选了会被占用的组合（Alt+R 撞显卡驱动性能浮层、Ctrl+Shift+E 撞 DevTools
 *      网络监视器）。Firefox 对冲突是**静默忽略**的：快捷键定义成功、但回调永不触发。
 *      这种失败没有任何报错，只能靠检查配置本身来预防。
 *
 * 因此这里做静态校验：键位合法、来源唯一、且避开已知冲突。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const mainJs = readFileSync(join(ROOT, "src/content/main.js"), "utf8");
const backgroundJs = readFileSync(join(ROOT, "src/background.js"), "utf8");

/** Firefox commands API 允许的键名（见 MDN commands 文档）。 */
const ALLOWED_KEYS = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  ..."0123456789".split(""),
  ...["F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"],
  "Comma","Period","Home","End","PageUp","PageDown","Space","Insert","Delete",
  "Up","Down","Left","Right",
]);

/** 已知会被 Firefox / DevTools / 常见驱动占用的组合（实测踩过或查证过）。 */
const KNOWN_TAKEN = new Map([
  ["Alt+R", "显卡驱动（AMD Radeon Software 性能监控）全局热键，实测触发 FPS/GPU/CPU 浮层"],
  ["Ctrl+Shift+E", "Firefox DevTools「网络监视器」"],
  ["Ctrl+Shift+I", "Firefox DevTools 工具箱"],
  ["Ctrl+Shift+K", "Firefox DevTools Web 控制台"],
  ["Ctrl+Shift+C", "Firefox DevTools 元素选取"],
  ["Ctrl+Shift+M", "Firefox DevTools 响应式设计模式"],
  ["Ctrl+Shift+J", "Firefox 浏览器控制台"],
  ["Ctrl+Shift+Z", "Firefox DevTools 调试器"],
  ["Ctrl+Shift+D", "Firefox DevTools 分栏"],
]);

test("权限：必须声明 host_permissions（否则注入静默失败）", () => {
  // 这是实机踩过的最难排查的一个问题：
  // 只申请 activeTab 时，一次用户手势里连续调用 scripting.executeScript
  // 会抛出 `Missing host permission for the tab`。
  // 由于错误只进控制台，表现为「点图标/按快捷键毫无反应」，用户完全无从判断。
  //
  // 对照实验（同一份代码，仅改权限）：
  //   只有 activeTab → TOGGLE_FAIL: Missing host permission for the tab
  //   加上 host 权限 → 全链路通过（PROBE → INJECT → TOGGLE_OK）
  //
  // 因此这里断言必须存在 http/https 的 host 权限。
  // 若要收窄权限，请先在真实浏览器里验证「点击图标能成功进入阅读模式」再改。
  assert.ok(
    Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0,
    "缺少 host_permissions —— 仅靠 activeTab 会导致注入静默失败"
  );

  const hosts = manifest.host_permissions.join(" ");
  assert.match(hosts, /https?:/, `host_permissions 应包含 http/https：${hosts}`);

  // scripting 权限仍然需要
  assert.ok(
    manifest.permissions.includes("scripting"),
    "缺少 scripting 权限"
  );
});

test("权限：background 不得依赖 tab.url 做前置判断", () => {
  // tab.url 在缺少 tabs 权限或匹配 host 权限时不存在（MDN tabs.Tab）。
  // 曾写成 `const url = tab.url || ""; if (!/^https?:/.test(url)) return;`，
  // 导致 url 为 undefined 时直接静默返回。
  assert.ok(
    !/tab\.url\s*\|\|\s*""/.test(backgroundJs),
    "background 不应用 `tab.url || \"\"` 这类判断做前置拦截"
  );
});

test("快捷键：manifest 中定义了 toggle-reader 命令", () => {
  assert.ok(manifest.commands, "缺少 commands 段");
  assert.ok(manifest.commands["toggle-reader"], "缺少 toggle-reader 命令");
  assert.ok(
    manifest.commands["toggle-reader"].description,
    "命令必须有 description"
  );
});

test("快捷键：组合形式符合 Firefox commands 规范", () => {
  const key = manifest.commands["toggle-reader"].suggested_key.default;

  // 规范：2~3 个键，形如 Modifier[+Modifier]+Key
  const parts = key.split("+");
  assert.ok(
    parts.length === 2 || parts.length === 3,
    `快捷键应为 2~3 个键，实际：${key}`
  );

  const MODIFIERS = new Set(["Ctrl", "Alt", "Command", "MacCtrl", "Shift"]);
  const mainModifier = parts[0];
  assert.ok(
    ["Ctrl", "Alt", "Command", "MacCtrl"].includes(mainModifier),
    `第一个键必须为主修饰键，实际：${mainModifier}`
  );

  const keyName = parts[parts.length - 1];
  assert.ok(
    ALLOWED_KEYS.has(keyName),
    `键名不在 Firefox 允许列表内：${keyName}`
  );

  // 次要修饰键不能与主修饰键重复
  for (const m of parts.slice(0, -1)) {
    assert.ok(MODIFIERS.has(m), `非法修饰键：${m}`);
  }
  if (parts.length === 3) {
    assert.notEqual(parts[0], parts[1], "两个修饰键不能相同");
  }
});

test("快捷键：避开已知冲突组合", () => {
  const key = manifest.commands["toggle-reader"].suggested_key.default;
  const conflict = KNOWN_TAKEN.get(key);
  assert.equal(
    conflict, undefined,
    `快捷键 ${key} 与已知占用冲突：${conflict}。` +
      `Firefox 对冲突是静默忽略的，请换一个组合。`
  );
});

test("快捷键：切换逻辑只有一个来源（禁止重复注册）", () => {
  // content script 里不应再监听切换快捷键。
  // 若这里出现 altKey/ctrlKey 判断，就会与 commands 双重触发。
  assert.ok(
    !/e\.(altKey|ctrlKey|metaKey)/.test(mainJs),
    "content script 不应自行监听切换快捷键：会与 manifest 的 commands 双重触发，" +
      "表现为「打开后立刻关闭」。切换逻辑只保留 commands 一个来源。"
  );

  // 切换必须由 commands 驱动
  assert.match(
    backgroundJs, /commands\.onCommand/,
    "background 应通过 commands.onCommand 接收快捷键"
  );
});

test("快捷键：Esc 退出仍由 content script 处理", () => {
  // Esc 与切换快捷键不同：Esc 不冲突，且需要即时响应（关掉浮层），
  // 由 content script 监听最直接。
  assert.match(mainJs, /e\.key === "Escape"/, "content script 应处理 Esc 退出");
});

test("快捷键：UI 文案与 manifest 保持一致", () => {
  const key = manifest.commands["toggle-reader"].suggested_key.default;

  // 工具栏 tooltip 必须与实际快捷键一致，否则会误导用户
  assert.ok(
    manifest.action.default_title.includes(key),
    `工具栏提示应写明当前快捷键 ${key}，实际：${manifest.action.default_title}`
  );

  // README 也要同步
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(
    readme.includes(key),
    `README 应说明当前快捷键 ${key}`
  );
  assert.ok(
    !readme.includes("Alt+R"),
    "README 不应再残留已被占用的 Alt+R"
  );
});

test("快捷键：aria/tooltip 不应残留旧键位", () => {
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "src/content/main.js": mainJs,
  };
  for (const [name, content] of Object.entries(files)) {
    // Alt+R 已被证实会撞显卡驱动，任何残留都会误导
    const stale = /Alt\s*\+\s*R(?![a-zA-Z])/.test(content);
    assert.ok(!stale, `${name} 残留已废弃的 Alt+R`);
  }
});
