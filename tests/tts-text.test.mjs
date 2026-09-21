/**
 * 朗读文本切分测试。
 *
 * 覆盖三类高风险行为：
 *   1. **增量扫描的稳定性**——自动续页会不断往正文追加块；若已吐出的 cue
 *      因重新切分而错位，缓存的音频就会对不上文本（朗读内容串了）。
 *   2. **章节归属**——增量扫描必须把累积的章节标题/页码正确传给新单元，
 *      否则新章节的 cue 会挂上上一章的标题，且打包时可能跨章拼接。
 *   3. **打包阈值**——首个 cue 必须小（否则点下播放要等几十秒才出声）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TtsText = require("../src/content/tts-text.js");

/** 造一个 .rd-content 容器。 */
function content(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div class="rd-content">${html}</div></body></html>`);
  return dom.window.document.querySelector(".rd-content");
}

/** 造一个可增量追加的容器。 */
function live() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div class="rd-content"></div></body></html>`);
  const doc = dom.window.document;
  const c = doc.querySelector(".rd-content");
  return {
    c,
    addP(text) {
      const p = doc.createElement("p");
      p.textContent = text;
      c.appendChild(p);
      return p;
    },
    addSep(title) {
      const d = doc.createElement("div");
      d.className = "rd-chapter-sep";
      const s = doc.createElement("span");
      s.textContent = title;
      d.appendChild(s);
      c.appendChild(d);
      return d;
    },
  };
}

// ============================================================ 句子切分

test("切句：在句末标点处断开", () => {
  assert.deepEqual(
    TtsText.splitSentences("今天天气很好。我们一起去公园散步吧。"),
    ["今天天气很好。", "我们一起去公园散步吧。"]
  );
});

test("切句：收尾引号归属前一句", () => {
  assert.deepEqual(
    TtsText.splitSentences("他说：「你好。」然后走了。"),
    ["他说：「你好。」", "然后走了。"]
  );
});

test("切句：问号感叹号省略号都算句末", () => {
  // 「……」是两个字符，必须整体当作一个句末标点，
  // 否则会切出空句（实测踩过）。
  const r = TtsText.splitSentences("这……怎么可能？不可能！");
  assert.deepEqual(r, ["这……", "怎么可能？", "不可能！"]);
  for (const s of r) assert.ok(s.length > 0, "不应产生空句");
});

test("切句：连续标点（？！）整体作为一个句末", () => {
  assert.deepEqual(TtsText.splitSentences("真的吗？！太好了。"), ["真的吗？！", "太好了。"]);
});

test("切句：逗号不断句（避免把一句话拆碎）", () => {
  const r = TtsText.splitSentences("他慢慢地，一步一步地，走了过去。");
  assert.equal(r.length, 1, "逗号不应断句");
});

test("切句：超长无标点文本会被兜底切分", () => {
  // 必须超过 MAX_CUE_CHARS 硬上限才会触发二次切分。
  // 若不做这件事，一整段没有句号的网文会变成一个几千字的请求：
  // 生成耗时长、失败代价高，且中途无法播放。
  const long = "这是一段没有任何句末标点的超长文本".repeat(80);
  assert.ok(long.length > TtsText.MAX_CUE_CHARS, "测试用例必须超过硬上限");
  const r = TtsText.splitSentences(long);
  assert.ok(r.length > 1, "超长无标点文本必须被切分");
  for (const s of r) {
    assert.ok(s.length <= TtsText.MAX_CUE_CHARS, `单片不应超过 ${TtsText.MAX_CUE_CHARS} 字，实际 ${s.length}`);
  }
  // 切分不能丢字
  assert.equal(r.join("").length, long.length, "切分不应丢失字符");
});

test("切句：空白与零宽字符被归一化", () => {
  const r = TtsText.splitSentences("第一句。\u200b\n\n  第二句。");
  assert.equal(r.length, 2);
  assert.equal(r[0], "第一句。");
  assert.equal(r[1], "第二句。");
});

test("切句：空输入返回空数组", () => {
  assert.deepEqual(TtsText.splitSentences(""), []);
  assert.deepEqual(TtsText.splitSentences("   \n\u200b  "), []);
  assert.deepEqual(TtsText.splitSentences(null), []);
});

// ============================================================ 打包

test("打包：首个 cue 更小，以尽快出声", () => {
  // 生成耗时 ≈ 2.8s + 0.14s/字，首个 cue 若取大阈值，用户要等很久才有声音
  const sents = [];
  for (let i = 0; i < 20; i++) sents.push(`这是第${i}句话，大约二十个字的内容用于测试。`);
  const cues = TtsText.packSentences(sents, { firstTarget: 40, target: 200 });
  assert.ok(cues.length >= 2, "应至少切成 2 个 cue");
  assert.ok(
    cues[0].length <= 40 * 1.4,
    `首个 cue 应接近 40 字阈值，实际 ${cues[0].length}`
  );
  assert.ok(
    cues[1].length > cues[0].length,
    "第二个 cue 应比首个大（后续用大阈值以减少请求数）"
  );
});

test("打包：句子边界优先于阈值（不切断句子）", () => {
  const sents = ["短句一。", "短句二。", "短句三。"];
  const cues = TtsText.packSentences(sents, { firstTarget: 5, target: 5 });
  // 阈值很小，但每句都应完整出现在某个 cue 里
  for (const s of sents) {
    assert.ok(cues.some((c) => c.includes(s)), `句子「${s}」不应被切断`);
  }
});

test("打包：不产生空 cue", () => {
  const cues = TtsText.packSentences(["甲。", "乙。"], {});
  for (const c of cues) assert.ok(c.trim().length > 0, "不应产生空 cue");
});

// ============================================================ 单元收集

test("单元：段落模式一个块一个单元", () => {
  const c = content("<p>第一段的内容。</p><p>第二段的内容。</p>");
  const units = TtsText.collectUnits(c, { mode: "paragraph" });
  assert.equal(units.length, 2);
  assert.equal(units[0].text, "第一段的内容。");
});

test("单元：分隔线不产生单元，但会切换章节标题与页码", () => {
  const c = content(
    "<p>第一章内容。</p>" +
    '<div class="rd-chapter-sep"><span>第二章 开端</span></div>' +
    "<p>第二章内容。</p>"
  );
  const units = TtsText.collectUnits(c, { mode: "paragraph" });
  assert.equal(units.length, 2, "分隔线本身不应成为朗读单元");
  assert.equal(units[0].pageIndex, 0);
  assert.equal(units[1].pageIndex, 1);
  assert.equal(units[1].chapterTitle, "第二章 开端");
});

test("单元：纯图片块被跳过（不朗读）", () => {
  const c = content('<p>有文字。</p><p><img src="a.jpg"></p><p>还有文字。</p>');
  const units = TtsText.collectUnits(c, { mode: "paragraph" });
  assert.equal(units.length, 2, "只有图片的块不应被朗读");
});

test("单元：首个单元用视图标题兜底", () => {
  const c = content("<p>正文第一段。</p>");
  const units = TtsText.collectUnits(c, { mode: "paragraph", fallbackTitle: "我的小说" });
  assert.equal(units[0].chapterTitle, "我的小说");
});

test("单元：整页模式把一页的多个块合成一个单元", () => {
  const c = content(
    "<p>第一段。</p><p>第二段。</p>" +
    '<div class="rd-chapter-sep"><span>第二章</span></div>' +
    "<p>第三段。</p><p>第四段。</p>"
  );
  const units = TtsText.collectUnits(c, { mode: "page" });
  assert.equal(units.length, 2, "整页模式应得到 2 个单元（2 页）");
  assert.equal(units[0].blocks.length, 2, "第一页应含 2 个块");
  assert.ok(units[0].text.includes("第一段。") && units[0].text.includes("第二段。"));
});

// ============================================================ 增量扫描（最关键）

test("★ 增量扫描：逐页喂入的结果与一次性全扫完全一致", () => {
  const L = live();
  const acc = [];
  let scanned = 0;
  let chapter = "";
  let page = 0;

  const step = () => {
    const units = TtsText.collectUnits(L.c, {
      mode: "paragraph",
      fallbackTitle: "视图标题",
      startIndex: scanned,
      initialChapterTitle: chapter,
      initialPageIndex: page,
    });
    acc.push(...units);
    const st = TtsText.scanState(L.c);
    chapter = st.chapterTitle;
    page = st.pageIndex;
    scanned = st.childCount;
  };

  // 第 1 页
  L.addP("第一章第一段的内容，需要足够长才能形成独立 cue。");
  L.addP("第一章第二段的内容，同样需要足够长以形成独立 cue。");
  step();

  // 第 2 页（带分隔线）
  L.addSep("第二章 开端");
  L.addP("第二章第一段的内容，属于第二章，章节标题应当正确。");
  L.addP("第二章第二段的内容，继续补充。");
  step();

  // 第 3 页
  L.addSep("第三章 转折");
  L.addP("第三章第一段的内容，属于第三章。");
  step();

  const all = TtsText.collectUnits(L.c, { mode: "paragraph", fallbackTitle: "视图标题" });
  const sig = (arr) => arr.map((u) => `${u.chapterTitle || ""}|${u.pageIndex}|${u.text.slice(0, 8)}`);
  assert.deepEqual(
    sig(acc), sig(all),
    "增量扫描与一次性全扫必须完全一致，否则续页后章节归属会错"
  );
});

test("★ 增量扫描：重复扫描不产生重复单元（幂等）", () => {
  const L = live();
  L.addP("一段内容，足够长以便形成单元。");
  const st = TtsText.scanState(L.c);
  const again = TtsText.collectUnits(L.c, {
    mode: "paragraph",
    startIndex: st.childCount,
    initialChapterTitle: st.chapterTitle,
    initialPageIndex: st.pageIndex,
  });
  assert.equal(again.length, 0, "从末尾再次扫描不应产生新单元");
});

test("★ 增量打包：已吐出的 cue 下标与文本永不改变", () => {
  // 这是自动续页场景的核心保证：若重新切分导致已有 cue 错位，
  // 已合成好的音频就会对不上文本。
  const L = live();
  const packer = TtsText.createPacker({ mode: "paragraph" });
  let scanned = 0;
  let chapter = "";
  let page = 0;

  const feed = () => {
    const units = TtsText.collectUnits(L.c, {
      mode: "paragraph",
      startIndex: scanned,
      initialChapterTitle: chapter,
      initialPageIndex: page,
    });
    for (const u of units) packer.addUnit(u);
    const st = TtsText.scanState(L.c);
    chapter = st.chapterTitle;
    page = st.pageIndex;
    scanned = st.childCount;
  };

  L.addP("第一段内容。这里有足够长的文字用于测试增量打包的正确性。");
  L.addP("第二段内容。同样包含足够多的文字来验证跨段打包效果。");
  feed();
  const snap1 = packer.cues.map((c) => c.text);
  const idx1 = packer.cues.map((c) => c.index);
  assert.ok(snap1.length > 0, "应至少产生一个 cue");

  // 追加更多内容（模拟自动续页）
  L.addP("第三段内容。这是新追加的内容，不应该改变已有 cue 的切分。");
  L.addP("第四段内容。继续追加更多文字以触发新的 cue 生成。");
  feed();
  const snap2 = packer.cues.map((c) => c.text);
  const idx2 = packer.cues.map((c) => c.index);

  assert.deepEqual(
    snap2.slice(0, snap1.length), snap1,
    "已吐出的 cue 文本必须保持不变，否则音频与文本会错位"
  );
  assert.deepEqual(
    idx2.slice(0, idx1.length), idx1,
    "已吐出的 cue 下标必须保持不变"
  );
  assert.ok(snap2.length >= snap1.length, "新内容应追加成新 cue");
});

test("★ 增量打包：一个 cue 不跨章节边界", () => {
  const L = live();
  const packer = TtsText.createPacker({ mode: "paragraph" });
  let scanned = 0;
  let chapter = "";
  let page = 0;
  const feed = () => {
    const units = TtsText.collectUnits(L.c, {
      mode: "paragraph",
      startIndex: scanned,
      initialChapterTitle: chapter,
      initialPageIndex: page,
    });
    for (const u of units) packer.addUnit(u);
    const st = TtsText.scanState(L.c);
    chapter = st.chapterTitle;
    page = st.pageIndex;
    scanned = st.childCount;
  };

  // 第一章内容不足一个目标长度，若没有章节阻断就会与第二章拼在一起
  L.addP("第一章的短内容。");
  feed();
  L.addSep("第二章 标题");
  L.addP("第二章的短内容。");
  feed();
  packer.flush();

  const texts = packer.cues.map((c) => c.text);
  for (const t of texts) {
    const hasOne = t.includes("第一章");
    const hasTwo = t.includes("第二章");
    assert.ok(
      !(hasOne && hasTwo),
      `一个 cue 不应同时包含两章内容：${JSON.stringify(t)}`
    );
  }
});

// ============================================================ 一次性构建

test("buildCues：返回 cues 与 units，且 cue 文本非空", () => {
  const c = content("<p>第一段的内容，足够长以形成 cue。</p><p>第二段的内容。</p>");
  const r = TtsText.buildCues(c, { mode: "paragraph" });
  assert.ok(r.cues.length > 0);
  assert.ok(r.units.length > 0);
  for (const cue of r.cues) {
    assert.ok(cue.text.trim().length > 0);
    assert.ok(Array.isArray(cue.blocks));
  }
});

test("buildCues：cue 带 blocks 引用，供高亮定位", () => {
  const c = content("<p>第一段的内容，足够长以形成 cue。</p>");
  const r = TtsText.buildCues(c, { mode: "paragraph" });
  assert.ok(r.cues[0].blocks.length > 0, "cue 必须带块引用，否则无法高亮");
  assert.equal(r.cues[0].blocks[0].textContent, "第一段的内容，足够长以形成 cue。");
});

// ============================================================ 时长估算

test("估算时长：与实测语速同量级（不严重低估）", () => {
  // 实测官方 TTS：1134 字 → 350 秒（约 3.2 字/秒）。
  // 估算取 4 字/秒（略快），宁可略微高估提前量也不要低估。
  const s = TtsText.estimateSeconds("字".repeat(1134), 1);
  assert.ok(s > 200 && s < 400, `1134 字应估算在 200~400 秒，实际 ${s}`);
});

test("估算时长：语速越快耗时越短", () => {
  const slow = TtsText.estimateSeconds("字".repeat(100), 1);
  const fast = TtsText.estimateSeconds("字".repeat(100), 2);
  assert.ok(fast < slow, "语速翻倍应使估算时长减半");
  assert.equal(Math.round(slow / fast), 2);
});

test("估算时长：空文本为 0", () => {
  assert.equal(TtsText.estimateSeconds("", 1), 0);
  assert.equal(TtsText.estimateSeconds("   ", 1), 0);
});

// ============================================================ 边界

test("边界：空容器返回空结果", () => {
  const c = content("");
  assert.deepEqual(TtsText.collectUnits(c, { mode: "paragraph" }), []);
  const r = TtsText.buildCues(c, { mode: "paragraph" });
  assert.deepEqual(r.cues, []);
});

test("边界：非法 mode 回退到段落模式", () => {
  const c = content("<p>内容。</p>");
  const units = TtsText.collectUnits(c, { mode: "不存在的模式" });
  assert.equal(units.length, 1);
  assert.equal(units[0].terminated, true, "应表现为段落模式（单元立即完整）");
});

test("边界：只有分隔线没有正文时不产生 cue", () => {
  const c = content('<div class="rd-chapter-sep"><span>只有标题</span></div>');
  const r = TtsText.buildCues(c, { mode: "paragraph" });
  assert.deepEqual(r.cues, [], "分隔线不应产生朗读内容");
});
