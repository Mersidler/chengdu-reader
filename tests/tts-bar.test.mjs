/**
 * 朗读播放条的 UI 交互测试。
 *
 * 这里守住的都是「用户会直接遇到、但很容易写错」的坑：
 *
 *   1. **API Key 必须真的存下来**——曾经只监听 `change` 事件，它只在失焦或
 *      回车时触发。用户粘贴完 key 直接点播放或关闭，key 就丢了，
 *      表现为「每次进来都要重新填」。
 *   2. **填完直接关闭不能丢 key**——防抖写盘的窗口内被移除，输入就没了，
 *      因此关闭路径必须先 flush。
 *   3. **回车要能提交**——且不能因为要阻止冒泡就把回车处理写坏。
 *   4. **阻止冒泡仍然生效**——输入框里的空格/方向键不能被页面截走。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TtsBar = require("../src/content/tts-bar.js");

/**
 * 测试用的假 API Key。
 *
 * **绝对不要在这里填真实 key。** 测试文件会进版本库，
 * 硬编码真实密钥等于把它公开发布（曾经犯过这个错：这里写的是真 key，
 * 上传前扫描才发现）。用形状相同的假值即可——测试只关心
 * 「值能否被原样保存/回填」，不关心它是否有效。
 */
const KEY = "sk-test-fake-key-for-unit-tests-only-0000";

/**
 * 造一个播放条实例。
 *
 * 注意：tts-bar.js 内部直接用**全局** `document` 创建元素
 * （它在 content script 里运行，这是合理写法），因此测试必须先把
 * jsdom 的 document 装到 globalThis 上，否则会 `ReferenceError: document is not defined`。
 * 这与 reader-view.test.mjs 的做法一致。
 */
function makeBar(prefsInit) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
  const doc = dom.window.document;
  const win = dom.window;

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Event = win.Event;
  globalThis.KeyboardEvent = win.KeyboardEvent;
  globalThis.MouseEvent = win.MouseEvent;

  const prefs = Object.assign(
    { ttsApiKey: "", ttsVoice: "茉莉", ttsRate: 1, ttsGranularity: "paragraph" },
    prefsInit || {}
  );
  const calls = { apiKey: [], submit: 0, toggle: 0, change: 0, close: 0 };

  const bar = TtsBar.create({
    prefs,
    onToggle: () => { calls.toggle++; },
    onChange: () => { calls.change++; },
    onApiKey: (k) => { calls.apiKey.push(k); },
    onSubmitKey: () => { calls.submit++; },
    onPrev: () => {},
    onNext: () => {},
    onClose: () => { calls.close++; },
  });
  doc.body.appendChild(bar.element);

  const input = bar.element.querySelector(".rd-tts-key");
  assert.ok(input, "播放条应含 API Key 输入框");

  return {
    dom, doc, win, prefs, bar, input, calls,
    fire: (el, type, init) => el.dispatchEvent(
      new win.Event(type, Object.assign({ bubbles: true }, init))
    ),
    press: (el, key) => el.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: key, bubbles: true, cancelable: true })
    ),
  };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ API Key 保存

test("★ API Key：粘贴触发 input 事件即保存（不依赖失焦）", async () => {
  const b = makeBar();
  b.calls.apiKey.length = 0;
  b.input.value = KEY;
  b.fire(b.input, "input");
  await tick(600);

  assert.ok(b.calls.apiKey.length > 0, "input 事件应触发 onApiKey（否则粘贴后不失焦就丢 key）");
  assert.equal(b.prefs.ttsApiKey, KEY, "prefs 应被更新为输入的 key");
});

test("★ API Key：change（失焦）也能保存", () => {
  const b = makeBar();
  b.calls.apiKey.length = 0;
  b.input.value = KEY;
  b.fire(b.input, "change");
  assert.ok(b.calls.apiKey.length > 0, "change 应触发 onApiKey");
  assert.equal(b.prefs.ttsApiKey, KEY);
});

test("★ API Key：blur 也能保存", () => {
  const b = makeBar();
  b.calls.apiKey.length = 0;
  b.input.value = KEY;
  b.fire(b.input, "blur");
  assert.ok(b.calls.apiKey.length > 0, "blur 应触发 onApiKey");
});

test("★ API Key：flushKey 立即提交（供关闭路径调用）", () => {
  const b = makeBar();
  b.calls.apiKey.length = 0;
  b.input.value = KEY;
  b.bar.flushKey();
  assert.ok(b.calls.apiKey.length > 0, "flushKey 应同步提交");
  assert.equal(b.prefs.ttsApiKey, KEY);
});

test("★ API Key：输入后未失焦就被移除（关闭阅读模式）也不丢", async () => {
  // 这是「每次都要重新填」最典型的场景：
  // 用户粘贴 key → 直接关掉阅读模式，change/blur 都不会派发。
  const b = makeBar();
  b.calls.apiKey.length = 0;
  b.input.value = KEY;
  b.fire(b.input, "input");
  b.bar.flushKey();     // main.js 的 teardownTts 会先调用它
  b.input.remove();     // 模拟播放条被摘掉
  await tick(600);
  assert.equal(b.prefs.ttsApiKey, KEY, "关闭路径 flush 后 key 必须保住");
});

test("API Key：已有值时输入框回填（不要求重填）", () => {
  const b = makeBar({ ttsApiKey: KEY });
  assert.equal(b.input.value, KEY, "打开播放条时应回填已保存的 key");
});

test("API Key：未填写时标记为缺失（界面可见提示）", () => {
  const b = makeBar({ ttsApiKey: "" });
  b.bar.refresh({ state: "idle" });
  assert.equal(b.input.dataset.missing, "true", "未填 key 应标记缺失，让用户知道该填什么");
});

test("API Key：已填写时不标记缺失", () => {
  const b = makeBar({ ttsApiKey: KEY });
  b.bar.refresh({ state: "idle" });
  assert.equal(b.input.dataset.missing, "false");
});

test("API Key：值未变化时不重复提交（避免无谓写盘）", () => {
  const b = makeBar({ ttsApiKey: KEY });
  b.calls.apiKey.length = 0;
  b.input.value = KEY;
  b.fire(b.input, "change");
  assert.equal(b.calls.apiKey.length, 0, "值没变不应重复触发 onApiKey");
});

test("API Key：首尾空白被去掉", () => {
  const b = makeBar();
  b.input.value = "  " + KEY + "  ";
  b.fire(b.input, "change");
  assert.equal(b.prefs.ttsApiKey, KEY, "应去掉首尾空白");
});

// ============================================================ 回车提交

test("★ 回车：提交并请求开始播放", () => {
  const b = makeBar();
  b.calls.apiKey.length = 0;
  b.calls.submit = 0;
  b.input.value = KEY;
  b.press(b.input, "Enter");

  assert.ok(b.calls.apiKey.length > 0, "回车应先保存 key");
  assert.equal(b.calls.submit, 1, "回车应触发 onSubmitKey（填完就能直接开播）");
});

test("★ 回车：不会冒泡到页面（避免触发页面的快捷键）", () => {
  const b = makeBar();
  let bubbled = false;
  b.doc.body.addEventListener("keydown", () => { bubbled = true; });
  b.press(b.input, "Enter");
  assert.equal(bubbled, false, "输入框的回车不应冒泡到页面");
});

test("★ 普通按键：只阻止冒泡，不误触发提交", () => {
  const b = makeBar();
  b.calls.submit = 0;
  let bubbled = false;
  b.doc.body.addEventListener("keydown", () => { bubbled = true; });

  for (const k of [" ", "ArrowLeft", "a", "Escape"]) {
    b.press(b.input, k);
  }
  assert.equal(b.calls.submit, 0, "只有回车才应触发提交");
  assert.equal(bubbled, false, "输入框内的按键都不应冒泡到页面（否则打字会被页面截走）");
});

test("★ 回车与 stopPropagation 共存（曾因注册成两个监听而失效）", () => {
  // 曾经的写法：一个监听只做 stopPropagation，另一个监听处理 Enter。
  // 实测确认那样回车永远不触发。现在合并成一个监听，本测试守住这个行为。
  const b = makeBar();
  b.calls.submit = 0;
  b.input.value = KEY;
  b.press(b.input, "Enter");
  assert.equal(b.calls.submit, 1, "合并后的监听必须同时完成阻止冒泡与回车处理");
});

// ============================================================ 控件基本行为

test("播放按钮：点击触发 onToggle", () => {
  const b = makeBar();
  const btn = b.bar.element.querySelector(".rd-tts-toggle");
  assert.ok(btn, "应有播放按钮");
  btn.dispatchEvent(new b.win.MouseEvent("click", { bubbles: true }));
  assert.equal(b.calls.toggle, 1);
});

test("关闭按钮：点击触发 onClose", () => {
  const b = makeBar();
  const btn = b.bar.element.querySelector(".rd-tts-close");
  btn.dispatchEvent(new b.win.MouseEvent("click", { bubbles: true }));
  assert.equal(b.calls.close, 1);
});

test("语速：加减按钮在档位内步进且不越界", () => {
  const b = makeBar({ ttsRate: 1 });
  const btns = Array.from(b.bar.element.querySelectorAll("button"));
  // 语速按钮的 title 是固定的，用它定位
  const down = btns.find((x) => x.title === "减慢语速");
  const up = btns.find((x) => x.title === "加快语速");
  assert.ok(down && up, "应有语速加减按钮");

  const start = b.prefs.ttsRate;
  up.dispatchEvent(new b.win.MouseEvent("click", { bubbles: true }));
  assert.ok(b.prefs.ttsRate > start, "加号应提高语速");

  // 连续减到最小，不应低于下限
  for (let i = 0; i < 20; i++) {
    down.dispatchEvent(new b.win.MouseEvent("click", { bubbles: true }));
  }
  assert.ok(
    b.prefs.ttsRate >= Math.min.apply(null, TtsBar.RATES),
    `语速不应低于最小值 ${Math.min.apply(null, TtsBar.RATES)}，实际 ${b.prefs.ttsRate}`
  );
});

test("粒度：切换会写回偏好", () => {
  const b = makeBar({ ttsGranularity: "paragraph" });
  const sel = Array.from(b.bar.element.querySelectorAll(".rd-tts-select"))
    .find((s) => s.title && s.title.indexOf("粒度") >= 0);
  assert.ok(sel, "应有粒度选择器");
  sel.value = "page";
  b.fire(sel, "change");
  assert.equal(b.prefs.ttsGranularity, "page");
});

test("音色：选项覆盖全部 9 个音色", () => {
  const b = makeBar();
  const sel = Array.from(b.bar.element.querySelectorAll(".rd-tts-select"))
    .find((s) => s.title && s.title.indexOf("音色") >= 0);
  assert.ok(sel, "应有音色选择器");
  assert.equal(
    sel.options.length, TtsBar.VOICES.length,
    `音色选项数应等于 VOICES 数量（${TtsBar.VOICES.length}）`
  );
});

test("refresh：显示章节与进度", () => {
  const b = makeBar();
  b.bar.refresh({
    state: "playing", cueIndex: 2, cueCount: 10, playedCount: 2,
    chapterTitle: "第二章 开端", reachedEnd: false,
  });
  const info = b.bar.element.querySelector(".rd-tts-info");
  assert.ok(info.textContent.indexOf("第二章 开端") >= 0, "应显示章节标题");
  assert.ok(info.textContent.indexOf("3/10") >= 0, `应显示进度，实际「${info.textContent}」`);
});

test("refresh：未开始时禁用上下条按钮", () => {
  const b = makeBar();
  b.bar.refresh({ state: "idle", cueIndex: -1, cueCount: 0, playedCount: 0 });
  const btns = Array.from(b.bar.element.querySelectorAll("button"));
  const prev = btns.find((x) => x.title === "上一段");
  const next = btns.find((x) => x.title === "下一段");
  assert.equal(prev.disabled, true, "未开始时应禁用上一段");
  assert.equal(next.disabled, true, "未开始时应禁用下一段");
});

test("setMessage：显示提示文案（错误要让用户看得见）", () => {
  const b = makeBar();
  b.bar.setMessage("请先填写 MiMo API Key");
  const info = b.bar.element.querySelector(".rd-tts-info");
  assert.equal(info.textContent, "请先填写 MiMo API Key");
});
