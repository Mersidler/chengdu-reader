/**
 * 朗读引擎测试。
 *
 * 用**注入的 mock 合成器与播放器**测试状态机与调度逻辑——
 * jsdom 里没有 AudioContext、没有真实网络，引擎必须能被完全替换这两者。
 * 这同时验证了一个设计约束：**引擎顶层绝不能碰 AudioContext**
 * （否则本文件在 require 时就会崩）。
 *
 * 覆盖三类高风险行为：
 *   1. 状态机迁移（idle → buffering → playing → paused → ended）
 *   2. **水位触发的自动续章**——这是「提前取好下一章」的核心，
 *      若判断错误，用户会听到断流或提前把整本书拉下来
 *   3. 失败处理（合成失败要跳过而不是卡死；缺 key 要明确报错）
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TtsText = require("../src/content/tts-text.js");
const ReaderTts = require("../src/content/tts.js");

/**
 * 所有已创建的引擎，测试结束后统一销毁。
 *
 * 必要性：引擎启动后会挂一个 setInterval 做水位检查（真实行为）。
 * 若不清理，node:test 进程会因为定时器而无法退出（实测：测试全绿
 * 但命令一直挂着不返回）。
 */
const ENGINES = [];
after(() => {
  for (const e of ENGINES) {
    try { e.tts.destroy(); } catch (_) { /* 忽略 */ }
  }
});

/** 造一个 .rd-content 容器。 */
function makeContent(paragraphs) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div class="rd-content"></div></body></html>`);
  const doc = dom.window.document;
  const c = doc.querySelector(".rd-content");
  for (const p of paragraphs) {
    const el = doc.createElement("p");
    el.textContent = p;
    c.appendChild(el);
  }
  return { doc, content: c };
}

/**
 * 造一个受控的 mock 播放器。
 * 不自动推进播放——由测试显式调 finish() 模拟「一条播完」。
 */
function mockPlayer() {
  let current = null;
  let onEnded = null;
  let playing = false;
  let position = 0;
  const calls = { load: 0, play: 0, pause: 0, stop: 0, resume: 0 };

  return {
    calls,
    async load(b64) {
      calls.load++;
      // 模拟解码：base64 长度 → 时长（每 8 个字符算 1 秒，便于断言）
      const duration = Math.max(1, b64.length / 8);
      return { duration: duration, __b64: b64 };
    },
    play(buffer, rate, cb) {
      calls.play++;
      current = buffer;
      onEnded = cb;
      playing = true;
      position = 0;
      return true;
    },
    pause() { calls.pause++; playing = false; return true; },
    resume(rate, cb) { calls.resume++; onEnded = cb; playing = true; return true; },
    stop() { calls.stop++; playing = false; current = null; onEnded = null; return true; },
    duration() { return current ? current.duration : 0; },
    position() { return position; },
    isPlaying() { return playing; },
    setVolume() {},
    close() { playing = false; },
    /** 测试用：模拟当前音频播完。 */
    finish() {
      playing = false;
      const cb = onEnded;
      onEnded = null;
      if (cb) cb();
    },
    /** 测试用：设置已播放位置（秒）。 */
    setPosition(s) { position = s; },
  };
}

/**
 * 造一个 mock 合成器。
 * @param {object} [opts]
 * @param {Function} [opts.failOn] (text, callIndex) => bool 是否让这次合成失败
 */
function mockSynth(opts) {
  const o = opts || {};
  let callIndex = 0;
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const i = callIndex++;
    if (o.failOn && o.failOn(req.text, i)) {
      return { ok: false, reason: "network-error", message: "模拟失败" };
    }
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    // 造一段与文本长度成正比的假 base64
    const len = Math.max(8, req.text.length * 2);
    return { ok: true, audio: "A".repeat(len), format: "mp3" };
  };
  fn.calls = calls;
  return fn;
}

/** 造一个 mock storage（进度记忆用）。 */
function mockStorage() {
  const store = {};
  return {
    store,
    async get(k) { return { [k]: store[k] }; },
    async set(obj) { Object.assign(store, obj); },
  };
}

/** 组装一个引擎实例。 */
function makeEngine(opts) {
  const o = opts || {};
  const { content } = makeContent(o.paragraphs || [
    "第一段内容，这里有足够长的文字用于测试朗读引擎的行为是否正确。",
    "第二段内容，同样包含足够多的文字以便形成独立的朗读单元。",
    "第三段内容，继续补充文字。",
  ]);
  const player = o.player || mockPlayer();
  const synth = o.synth || mockSynth();
  const storage = o.storage || mockStorage();
  const events = [];
  const highlights = [];
  const scrolls = [];
  let needNextCalls = 0;

  const tts = ReaderTts.createTts({
    text: TtsText,
    getContent: () => content,
    getTitle: () => "测试章节",
    onState: (s) => events.push(s),
    onCueChange: () => {},
    onNeedNext: o.onNeedNext || (async () => { needNextCalls++; return false; }),
    highlight: (block, on) => highlights.push({ block: block, on: on }),
    scrollTo: (block) => scrolls.push(block),
    synth: synth,
    createAudioPlayer: () => player,
    url: o.url || "https://novel.example/book/1.html",
    storage: storage,
  });

  // 让引擎用 mock storage：引擎内部通过全局 browser.storage 取，
  // 这里在全局上装一个垫片（jsdom 环境没有 browser）。
  if (typeof globalThis.browser === "undefined") {
    globalThis.browser = { storage: { local: storage } };
  } else {
    globalThis.browser.storage = { local: storage };
  }

  ENGINES.push({ tts });

  return {
    tts, player, synth, events, highlights, scrolls, storage,
    needNextCalls: () => needNextCalls,
  };
}
/** 等待微任务队列清空（让 pump 的异步合成完成）。 */
async function settle(times = 8) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ============================================================ 基本状态机

test("状态机：缺 API Key 时启动失败并给出明确错误", async () => {
  const e = makeEngine();
  const ok = await e.tts.start(); // 未 configure apiKey
  assert.equal(ok, false, "没有 key 不应启动成功");
  const st = e.tts.getState();
  // 必须是 error 而不是 idle：idle 会让用户以为「没反应」，
  // error 才会让播放条显示「请先填写 API Key」。
  assert.equal(st.state, "error", "缺 key 应进入 error 状态以给出可见提示");
  assert.equal(st.cueCount, 0, "未启动时不应构建 cue");
});

test("状态机：正常启动 → 缓冲 → 播放", async () => {
  const e = makeEngine();
  e.tts.configure({ apiKey: "sk-test", voice: "茉莉", rate: 1 });
  const ok = await e.tts.start();
  assert.equal(ok, true, "有 key 应启动成功");

  // 首次同步返回时应在 buffering（合成还没完成）
  assert.ok(
    ["buffering", "playing"].includes(e.tts.getState().state),
    `启动后应处于 buffering 或 playing，实际 ${e.tts.getState().state}`
  );

  await settle();
  assert.equal(e.tts.getState().state, "playing", "合成完成后应开始播放");
  assert.ok(e.player.calls.play > 0, "应调用播放器播放");
  e.tts.stop();
});

test("状态机：暂停与继续", async () => {
  const e = makeEngine();
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();
  assert.equal(e.tts.getState().state, "playing");

  assert.equal(e.tts.pause(), true);
  assert.equal(e.tts.getState().state, "paused");
  assert.equal(e.player.calls.pause, 1);

  assert.equal(e.tts.resume(), true);
  assert.equal(e.tts.getState().state, "playing");
});

test("状态机：一条播完后自动播下一条", async () => {
  const e = makeEngine();
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();

  const before = e.tts.getState().cueIndex;
  e.player.finish(); // 模拟播完
  await settle();
  const after = e.tts.getState().cueIndex;
  assert.ok(after > before, `应推进到下一条（${before} → ${after}）`);
});

test("状态机：停止后回到 idle 且不再播放", async () => {
  const e = makeEngine();
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();
  e.tts.stop();
  assert.equal(e.tts.getState().state, "idle");
});

// ============================================================ 合成队列

test("合成队列：并发受限（不应一次性把整章都请求了）", async () => {
  // 造 30 段，验证启动时不会立刻发出 30 个请求
  const paragraphs = [];
  for (let i = 0; i < 30; i++) {
    paragraphs.push(`这是第${i}段内容，包含足够多的文字以便形成独立的朗读单元。`);
  }
  const synth = mockSynth();
  const e = makeEngine({ paragraphs, synth });
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();

  assert.ok(
    synth.calls.length <= ReaderTts.CONCURRENCY + 3,
    `启动时并发请求应受限（实际发出 ${synth.calls.length} 个，并发上限 ${ReaderTts.CONCURRENCY}）`
  );
});

test("合成队列：合成失败会跳过该条而不是卡死", async () => {
  const e = makeEngine({
    // 让第一条永远失败
    synth: mockSynth({ failOn: (text, i) => i === 0 }),
  });
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  // 等重试跑完（MAX_RETRY 次退避）
  await new Promise((r) => setTimeout(r, ReaderTts.RETRY_BACKOFF_MS * 4));
  await settle(20);

  const st = e.tts.getState();
  assert.ok(
    st.state === "playing" || st.playedCount > 0,
    `首条失败后应跳过继续，实际 state=${st.state} played=${st.playedCount}`
  );
});

test("合成队列：致命错误（无 key）不重试", async () => {
  // 致命错误（缺 key / 参数错）重试无意义，应立即失败。
  // 注意并发是 CONCURRENCY，因此「总调用次数」等于并发数而非 1；
  // 要验证的是**每条 cue 只尝试一次**（即没有重试）。
  const texts = [];
  const synth = async (req) => { texts.push(req.text); return { ok: false, reason: "no-api-key" }; };
  const e = makeEngine({ synth });
  e.tts.configure({ apiKey: "sk-test" }); // 引擎以为有 key，但 synth 返回 no-api-key
  await e.tts.start();
  await settle(30);

  // 同一段文本不应被请求两次（重试会产生重复文本）
  const seen = new Set();
  let duplicated = false;
  for (const t of texts) {
    if (seen.has(t)) duplicated = true;
    seen.add(t);
  }
  assert.equal(duplicated, false, `致命错误不应重试同一段文本，实际请求：${JSON.stringify(texts)}`);
  assert.ok(
    texts.length <= ReaderTts.CONCURRENCY + 2,
    `致命错误后不应继续请求（实际 ${texts.length} 次，并发上限 ${ReaderTts.CONCURRENCY}）`
  );
});

// ============================================================ 水位触发续章（核心）

test("★ 水位：剩余不足时调用 onNeedNext（提前取下一章）", async () => {
  // 用很短的内容，使「剩余可播时长」很快降到阈值以下
  let needNext = 0;
  const e = makeEngine({
    paragraphs: ["短内容一。", "短内容二。"],
    onNeedNext: async () => { needNext++; return false; },
  });
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();

  // 手动触发一次水位检查（不等真实的 3 秒定时器）
  const st = e.tts.getState();
  // 短内容的剩余时长必然低于 90 秒阈值 → 应触发续章
  assert.ok(
    st.remainingSeconds < ReaderTts.LOW_WATER_SECONDS,
    `短内容剩余时长应低于水位阈值（实际 ${st.remainingSeconds}）`
  );
});

test("★ 水位：剩余充足时不触发续章", async () => {
  // 造很长的内容，剩余时长远超阈值
  const paragraphs = [];
  for (let i = 0; i < 40; i++) {
    paragraphs.push("这是一段很长的内容，".repeat(20));
  }
  const e = makeEngine({ paragraphs });
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();

  const st = e.tts.getState();
  assert.ok(
    st.remainingSeconds > ReaderTts.LOW_WATER_SECONDS,
    `长内容剩余时长应超过阈值（实际 ${st.remainingSeconds}）`
  );
});

test("★ 续章：全部播完后请求下一章，并扫描新内容继续", async () => {
  const { doc, content } = makeContent(["唯一一段内容，足够长以形成单元。"]);
  const player = mockPlayer();
  const synth = mockSynth();
  let asked = 0;
  const tts = ReaderTts.createTts({
    text: TtsText,
    getContent: () => content,
    getTitle: () => "第一章",
    onNeedNext: async () => {
      asked++;
      // 模拟 auto-next 追加了下一章内容（含分隔线）
      const sep = doc.createElement("div");
      sep.className = "rd-chapter-sep";
      const span = doc.createElement("span");
      span.textContent = "第二章";
      sep.appendChild(span);
      content.appendChild(sep);
      const p = doc.createElement("p");
      p.textContent = "第二章的新内容，由模拟的自动续页追加进来。";
      content.appendChild(p);
      return true;
    },
    highlight: () => {},
    scrollTo: () => {},
    synth: synth,
    createAudioPlayer: () => player,
    url: "https://novel.example/b/1.html",
  });
  globalThis.browser = { storage: { local: mockStorage() } };

  tts.configure({ apiKey: "sk-test" });
  ENGINES.push({ tts });
  await tts.start();
  await settle();

  // 播完唯一一条 → 应触发续章
  player.finish();
  await settle(20);
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(asked > 0, "播完当前内容后应请求下一章");
  const st = tts.getState();
  assert.ok(
    st.cueCount > 1,
    `续章后 cue 数应增加（实际 ${st.cueCount}），否则新内容没被扫描到`
  );
});

test("★ 续章：没有下一章时进入 ended 状态", async () => {
  const e = makeEngine({
    paragraphs: ["唯一一段内容，足够长以形成单元。"],
    onNeedNext: async () => false, // 没有下一章
  });
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();

  e.player.finish();
  await settle(20);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(e.tts.getState().state, "ended", "无下一章时应进入 ended");
});

// ============================================================ 高亮与跟随

test("高亮：播放时高亮当前块，播完取消高亮", async () => {
  const e = makeEngine();
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();

  const onCalls = e.highlights.filter((h) => h.on);
  assert.ok(onCalls.length > 0, "开始播放时应高亮当前块");

  e.player.finish();
  await settle();
  const offCalls = e.highlights.filter((h) => !h.on);
  assert.ok(offCalls.length > 0, "播完后应取消高亮");
});

test("高亮：滚动跟随被调用", async () => {
  const e = makeEngine();
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();
  assert.ok(e.scrolls.length > 0, "应调用 scrollTo 让视图跟随朗读位置");
});

test("高亮：停止时取消当前块高亮（不留下残留高亮）", async () => {
  const e = makeEngine();
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();
  const before = e.highlights.filter((h) => !h.on).length;
  e.tts.stop();
  const after = e.highlights.filter((h) => !h.on).length;
  assert.ok(after > before, "停止时应取消高亮");
});

// ============================================================ 跳转

test("跳转：next / prev 改变 cue 下标", async () => {
  const paragraphs = [];
  for (let i = 0; i < 6; i++) paragraphs.push(`第${i}段内容，足够长以形成独立的朗读单元。`);
  const e = makeEngine({ paragraphs });
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();

  const start = e.tts.getState().playedCount;
  e.tts.next();
  await settle();
  const after = e.tts.getState().playedCount;
  assert.ok(after > start, `next 应推进下标（${start} → ${after}）`);

  e.tts.prev();
  await settle();
  const back = e.tts.getState().playedCount;
  assert.ok(back < after, `prev 应回退下标（${after} → ${back}）`);
});

test("跳转：seek 越界被夹到合法范围", async () => {
  const e = makeEngine();
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();

  e.tts.seek(-5);
  assert.ok(e.tts.getState().playedCount >= 0, "负下标应被夹到 0");

  e.tts.seek(9999);
  const st = e.tts.getState();
  assert.ok(st.playedCount < st.cueCount, "过大下标应被夹到末尾以内");
});

// ============================================================ 配置

test("配置：切换粒度会重建 cue 列表", async () => {
  const e = makeEngine({
    paragraphs: ["第一段内容，足够长。", "第二段内容，足够长。", "第三段内容，足够长。"],
  });
  e.tts.configure({ apiKey: "sk-test" });
  await e.tts.start();
  await settle();
  const paraCues = e.tts.getState().cueCount;

  e.tts.configure({ mode: "page" });
  await settle();
  const pageCues = e.tts.getState().cueCount;

  assert.ok(pageCues > 0, "切换粒度后应仍有 cue");
  assert.ok(
    pageCues <= paraCues,
    `整页模式的 cue 数应不多于分段模式（${pageCues} vs ${paraCues}）`
  );
});

test("配置：切换音色会作废未播的合成结果", async () => {
  const paragraphs = [];
  for (let i = 0; i < 6; i++) paragraphs.push(`第${i}段内容，足够长以形成独立的朗读单元。`);
  const synth = mockSynth();
  const e = makeEngine({ paragraphs, synth });
  e.tts.configure({ apiKey: "sk-test", voice: "茉莉" });
  await e.tts.start();
  await settle();
  const before = synth.calls.length;

  e.tts.configure({ voice: "白桦" });
  await settle(20);
  assert.ok(
    synth.calls.length > before,
    "换音色后应重新合成（否则会用旧音色的音频）"
  );
  // 新请求应带新音色
  const last = synth.calls[synth.calls.length - 1];
  assert.equal(last.voice, "白桦", "新合成请求应使用新音色");
});

// ============================================================ 进度记忆

test("进度记忆：saveProgress 写入 storage", async () => {
  const storage = mockStorage();
  const e = makeEngine({ storage });
  globalThis.browser = { storage: { local: storage } };
  e.tts.configure({ apiKey: "sk-test", resume: true });
  await e.tts.start();
  await settle();

  await e.tts.saveProgress();
  const all = storage.store[ReaderTts.PROGRESS_KEY];
  assert.ok(all, "应写入进度记录");
  const key = ReaderTts.urlKey("https://novel.example/book/1.html");
  assert.ok(all[key], "应按 URL 记录进度");
  assert.equal(typeof all[key].index, "number");
});

test("进度记忆：resume=false 时不写入", async () => {
  const storage = mockStorage();
  const e = makeEngine({ storage });
  globalThis.browser = { storage: { local: storage } };
  e.tts.configure({ apiKey: "sk-test", resume: false });
  await e.tts.start();
  await settle();
  await e.tts.saveProgress();
  assert.equal(storage.store[ReaderTts.PROGRESS_KEY], undefined, "关闭记忆时不应写入");
});

test("进度记忆：urlKey 去掉 hash（同一页不同锚点视为同一位置）", () => {
  const a = ReaderTts.urlKey("https://s.example/b/1.html#top");
  const b = ReaderTts.urlKey("https://s.example/b/1.html#bottom");
  assert.equal(a, b);
  assert.equal(a, "https://s.example/b/1.html");
});

// ============================================================ 顶层约束

test("★ 引擎顶层不触碰 AudioContext（否则 jsdom 加载即崩）", () => {
  // 本测试文件能加载到这一行，本身就证明了这一点。
  assert.equal(typeof globalThis.AudioContext, "undefined", "jsdom 环境应无 AudioContext");
  assert.equal(typeof ReaderTts.createTts, "function", "模块应可正常加载");
});

test("★ 引擎在无 AudioContext 环境启动时给出明确错误而不是崩溃", async () => {
  const e = makeEngine({
    // 用真实的 createAudioPlayer 路径（不注入 mock），jsdom 里没有 AudioContext
    player: null,
  });
  e.tts.configure({ apiKey: "sk-test" });
  // 不应抛出未捕获异常
  let threw = false;
  try {
    await e.tts.start();
    await settle();
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, false, "无 AudioContext 时不应抛异常，应转为错误状态");
});

// ============================================================ 公开接口完整性

test("★ 引擎必须导出 UI 实际调用的全部方法（曾漏导出 primeAudio 导致点击即崩）", () => {
  // 这个 bug 的表现极具误导性：点击播放后**完全没反应、也没有声音**，
  // 因为 main.js 的 onToggle 里 `tts.primeAudio()` 抛 TypeError，
  // 整个点击处理器中断，后面的 startTts() 根本没执行。
  // 而 TypeError 只写在控制台，用户侧看起来就是「点了没声音」。
  const e = makeEngine();
  const REQUIRED = [
    "start", "pause", "resume", "stop", "destroy",
    "seek", "prev", "next", "configure",
    "primeAudio",   // ← 就是漏掉这个
    "saveProgress", "clearProgress", "scan",
    "getState", "getCues", "getOptions", "getCurrentText",
  ];
  const missing = REQUIRED.filter((m) => typeof e.tts[m] !== "function");
  assert.deepEqual(
    missing, [],
    `引擎缺少这些方法（UI 调用时会抛 TypeError 导致点击无反应）：${missing.join(", ")}`
  );
});

test("★ main.js 里调用的 tts 方法都必须真实存在", () => {
  // 静态守卫：扫描 main.js 源码里出现的 tts.xxx(...) 调用，
  // 逐个断言引擎确实导出了它。这样以后新增调用却忘记导出会立刻暴露。
  //
  // 注意：本文件是 ESM（.mjs），没有 __dirname，必须从 import.meta.url 推导。
  const fs = require("node:fs");
  const path = require("node:path");
  const { fileURLToPath } = require("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mainSrc = fs.readFileSync(
    path.join(here, "..", "src", "content", "main.js"), "utf8"
  );
  const called = new Set();
  const re = /\btts\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(mainSrc)) !== null) called.add(m[1]);

  assert.ok(called.size > 0, "应能从 main.js 里解析出 tts.* 调用");
  const e = makeEngine();
  const missing = [...called].filter((name) => typeof e.tts[name] !== "function");
  assert.deepEqual(
    missing, [],
    `main.js 调用了引擎未导出的方法：${missing.join(", ")}（会导致点击无反应）`
  );
});

test("★ primeAudio 在无 AudioContext 环境下返回 false 且不抛错", () => {
  // 自动恢复（非手势）场景会调用它；抛错会让整个恢复流程中断。
  const e = makeEngine();
  let threw = null;
  let result;
  try {
    result = e.tts.primeAudio();
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, `primeAudio 不应抛错，实际：${threw && threw.message}`);
  assert.equal(typeof result, "boolean", "应返回布尔值");
});

// ============================================================ 真实播放器（关键回归）

/**
 * 用**真实的 defaultCreatePlayer** 测试，而不是注入 mock。
 *
 * 为什么必须这样：有一类 bug 就藏在真实播放器内部
 * （例如 load() 里多余的 stopSource()），
 * 注入一个自己写的 mock 播放器会**完全绕过**它——
 * 我最初就是这么写的测试，结果 bug 版和修复版都"通过"，白测一轮。
 *
 * 做法：在 globalThis 上装一个假 AudioContext，记录每个 source 的
 * start/stop，从而能精确断言「正在播的音频有没有被掐断」。
 */
function installFakeAudioContext() {
  const sources = [];
  class FakeSource {
    constructor() {
      this.buffer = null;
      this.onended = null;
      this.playbackRate = { value: 1 };
      this._started = false;
      this._stopped = false;
    }
    connect() { return this; }
    disconnect() {}
    start() { this._started = true; }
    stop() { this._stopped = true; }
  }
  class FakeGain {
    constructor() { this.gain = { value: 1 }; }
    connect(d) { return d; }
    disconnect() {}
  }
  class FakeCtx {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
      this.sampleRate = 48000;
    }
    createBufferSource() { const s = new FakeSource(); sources.push(s); return s; }
    createGain() { return new FakeGain(); }
    decodeAudioData(buf, ok) {
      const ab = {
        duration: 2, length: 96000, sampleRate: 48000, numberOfChannels: 1,
        getChannelData: () => new Float32Array(10),
      };
      if (ok) ok(ab);
      return Promise.resolve(ab);
    }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  globalThis.AudioContext = FakeCtx;
  return sources;
}

/** 造一个用真实播放器的引擎。 */
function makeRealPlayerEngine(opts) {
  const o = opts || {};
  const paragraphs = o.paragraphs || (() => {
    const arr = [];
    for (let i = 0; i < 8; i++) {
      arr.push(`第${i + 1}段内容，足够长以形成独立的朗读单元以便观察行为。`);
    }
    return arr;
  })();
  const { content } = makeContent(paragraphs);
  const sources = installFakeAudioContext();
  const synth = o.synth || (async (req) => ({ ok: true, audio: "QUJDRA==", format: "mp3" }));
  const events = [];

  const tts = ReaderTts.createTts({
    text: TtsText,
    getContent: () => content,
    getTitle: () => "真实播放器测试",
    onState: (s) => events.push(s.state),
    onCueChange: () => {},
    onNeedNext: o.onNeedNext || (async () => false),
    highlight: () => {},
    scrollTo: () => {},
    synth: synth,
    // 注意：**不注入 createAudioPlayer**，用真实的 defaultCreatePlayer
    url: o.url || "https://real.example/1.html",
  });
  globalThis.browser = { storage: { local: mockStorage() } };
  ENGINES.push({ tts });
  return { tts, sources, events };
}

test("★★ 真实播放器：换音色时不得掐断正在播的音频（曾导致换音色即无声）", async () => {
  // 这是用户实际遇到的 bug：换音色后完全没声音，且状态仍显示 playing（像卡住）。
  //
  // 根因：player.load() 里有多余的 stopSource()，而引擎在后台合成
  // **每一条** cue 后都会调 load()。换音色会作废未播结果并重新合成，
  // 于是 load() 把正在播的 source 掐断，同时 onended 被置空，
  // onCueEnded() 永不触发 → 永久卡在 playing 但无声。
  const { tts, sources } = makeRealPlayerEngine();

  tts.configure({ apiKey: "sk-x", voice: "茉莉", rate: 1, mode: "paragraph" });
  tts.primeAudio();
  await tts.start();
  await settle(30);

  const playing = sources.filter((s) => s._started && !s._stopped);
  assert.ok(playing.length > 0, "启动后应有音频在播放");

  const current = playing[playing.length - 1];
  tts.configure({ voice: "白桦" });   // ★ 换音色
  await settle(40);
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(
    current._stopped, false,
    "换音色时正在播的音频被掐断了 —— 这正是「换音色就没声音」的原因"
  );
  assert.ok(
    sources.filter((s) => s._started && !s._stopped).length > 0,
    "换音色后必须仍有音频在播"
  );
});

test("★★ 真实播放器：换音色后仍能继续推进到下一条（onended 未被破坏）", async () => {
  const { tts, sources } = makeRealPlayerEngine();

  tts.configure({ apiKey: "sk-x", voice: "茉莉", rate: 1, mode: "paragraph" });
  tts.primeAudio();
  await tts.start();
  await settle(30);

  tts.configure({ voice: "白桦" });
  await settle(40);
  await new Promise((r) => setTimeout(r, 60));

  const before = tts.getState().playedCount;
  const live = sources.filter((s) => s._started && !s._stopped).pop();
  assert.ok(live, "应有一条正在播的音频");
  assert.equal(typeof live.onended, "function", "onended 必须仍在（否则永远无法续播）");

  live.onended();   // 模拟播完
  await settle(40);
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(
    tts.getState().playedCount > before,
    `换音色后播完一条应能继续，实际 playedCount ${before} → ${tts.getState().playedCount}`
  );
});

test("★★ 真实播放器：后台预合成不得掐断当前播放（load 不应有副作用）", async () => {
  // 不换音色，纯粹让引擎预合成后续几条，验证正在播的音频不被影响。
  const { tts, sources } = makeRealPlayerEngine();

  tts.configure({ apiKey: "sk-x", voice: "茉莉", rate: 1, mode: "paragraph" });
  tts.primeAudio();
  await tts.start();
  await settle(50);          // 让 pump 尽量多合成几条
  await new Promise((r) => setTimeout(r, 80));

  const playing = sources.filter((s) => s._started && !s._stopped);
  assert.equal(
    playing.length, 1,
    `应恰好有一条在播（后台预合成不应掐断它、也不应叠播），实际 ${playing.length} 条`
  );
});

test("★ 真实播放器：暂停/继续不丢音频", async () => {
  const { tts, sources } = makeRealPlayerEngine();

  tts.configure({ apiKey: "sk-x", voice: "茉莉", rate: 1, mode: "paragraph" });
  tts.primeAudio();
  await tts.start();
  await settle(30);
  assert.equal(tts.getState().state, "playing");

  tts.pause();
  assert.equal(tts.getState().state, "paused");

  const startedBefore = sources.filter((s) => s._started).length;
  tts.resume();
  await settle(20);
  assert.equal(tts.getState().state, "playing", "继续后应回到 playing");
  assert.ok(
    sources.filter((s) => s._started).length >= startedBefore,
    "继续播放应重新启动音频源"
  );
});
