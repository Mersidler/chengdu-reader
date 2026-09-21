/**
 * tts-text.js — 朗读文本切分（纯函数，无副作用、无网络）。
 *
 * 职责：把阅读视图里的正文 DOM 切成「朗读单元（unit）」，再把单元切成「句子（cue）」。
 *
 * ## 两种合成粒度（用户可在播放条上切换）
 *
 *   paragraph（默认）：一个正文块 = 一个单元。切分细，首句出声快，
 *                      但相邻请求之间语气可能有细微跳变。
 *   page            ：一条章节分隔线到一个单元。整页一次请求，语气连贯，
 *                      但首次出声慢，且无法做句级跳转。
 *
 * ## 单元边界为什么在 DOM 里是现成的
 *
 * reader-view 的 appendArticle() 每次追加新页前都会先插一条 .rd-chapter-sep
 * （带章节标题），所以 .rd-content 的结构天然是：
 *
 *     [第1页块...] [分隔线·第2章] [第2页块...] [分隔线·第3章] ...
 *
 * 按分隔线切就是「页」，按顶层块切就是「段」。
 *
 * ## 关键不变式：单元只会被追加，不会被改写
 *
 * 追加永远以分隔线开头，所以一个单元的所有块一旦出现就不会再变。
 * 这让「一看到就能开始合成」成立——不需要等下一页加载完。
 * 唯一的例外是**最后一个 page 单元**：它还在增长，必须等它后面的
 * 分隔线出现（terminated=true）才能合成；首个 page 单元在打开阅读模式时
 * 就已经是完整的，由引擎用 baseline 数量标记。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  } else {
    root.TtsText = mod;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** 章节分隔线的类名（与 reader-view.appendArticle 保持一致）。 */
  const SEP_CLASS = "rd-chapter-sep";

  /** 单元切分模式。 */
  const MODE_PARAGRAPH = "paragraph";
  const MODE_PAGE = "page";
  const MODES = [MODE_PARAGRAPH, MODE_PAGE];

  /**
   * 句末标点。刻意不含逗号/顿号/冒号——
   * 在这些位置断句会把一句话拆成两半，语气反而更碎。
   */
  const SENT_END_RE = /[。！？；!?;…]/;

  /** 句末标点后面可能紧跟的收尾符号，应与标点一起归入上一句。 */
  const CLOSER_RE = /[」』】》〉）)\]"'”’]/;

  /**
   * 次级断点（仅在单句过长时才启用）。
   * 一整段没有句号的长文本（网文常见）必须在这里兜底切分，
   * 否则会生成一个几千字的请求。
   */
  const SECONDARY_RE = /[，、,：:—－]/;

  /**
   * 打包阈值（字符数）。为什么分「首块」与「后续」两档：
   *
   * 实测官方 TTS 的生成耗时 ≈ 2.8 秒固定开销 + 0.14 秒/字。
   * 若首个 cue 就取 200 字，用户点下播放要等 ~31 秒才有声音。
   * 因此首个 cue 取小阈值（尽快出声），后续 cue 取大阈值
   * （减少请求数、让语气更连贯）。
   *
   * 数值依据：40 字 ≈ 8.4 秒（首句等待可接受）；
   * 180 字 ≈ 28 秒，而播放 180 字需 ~45 秒，合成快于播放，
   * 配合并发预合成即可始终领先。
   */
  const PARA_FIRST_CHARS = 40;
  const PARA_TARGET_CHARS = 180;

  /**
   * 整页模式的块大小。
   *
   * ## 为什么不是「整章一次发完」
   *
   * 实测生成耗时 ≈ 2.8 秒 + 0.14 秒/字。一章 3000 字一次请求要等约 7 分钟，
   * 且中途失败会丢掉全部工作。因此超过阈值时按阈值切分——
   * 短于一页（<1200 字）时**确实是整页一次请求**，长页才分块。
   *
   * ## 为什么是 1200
   *
   * 生成 1200 字约 171 秒，播放 1200 字约 300 秒——**合成快于播放**，
   * 配合并发预合成即可始终领先，不会卡顿。
   * 一章 3000 字约 3 块，接缝比段落模式（每 180 字一块）少约 5 倍。
   *
   * ## 首块为什么小
   *
   * 首块决定「点下播放后多久听到第一声」。取 60 字约 11 秒；
   * 连贯性的收益主要在正文主体（后续大块），首块小几乎不损失什么。
   */
  const PAGE_FIRST_CHARS = 60;
  const PAGE_TARGET_CHARS = 1200;

  /** 短于此长度的碎片会与相邻碎片合并，避免为几个字发一次请求。 */
  const MIN_CUE_CHARS = 10;

  /** 单条 cue 的硬上限；超过则在次级断点处切分。 */
  const MAX_CUE_CHARS = 900;

  /** 空白归一化：含零宽字符（Readability 会漏掉只含零宽的段落，见 README）。 */
  const BLANK_RE = /[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]+/g;

  /** 判定「有可读文字」：排除零宽字符后仍有非空白字符。 */
  const HAS_TEXT_RE = /[^\s\u200b\u200c\u200d\u2060\ufeff]/;

  // ---------------------------------------------------------------- 基础工具

  /** 归一化空白：折叠连续空白与零宽字符。 */
  function normalizeSpace(s) {
    return String(s == null ? "" : s).replace(BLANK_RE, " ").trim();
  }

  /** 是否为章节分隔线元素。 */
  function isSeparator(el) {
    if (!el || !el.classList) return false;
    try {
      return el.classList.contains(SEP_CLASS);
    } catch (_) {
      return false;
    }
  }

  /** 取分隔线上显示的章节标题（无则返回空串）。 */
  function separatorTitle(el) {
    if (!el) return "";
    const span = el.querySelector ? el.querySelector("span") : null;
    const t = span ? span.textContent : el.textContent;
    return normalizeSpace(t);
  }

  /**
   * 取一个块元素的可朗读文本。
   *
   * 注意：这里用 textContent 而非 innerText——innerText 依赖布局，
   * 在 jsdom 里恒为空（本项目已被 jsdom 不做布局坑过多次）。
   */
  function blockText(el) {
    if (!el) return "";
    let text;
    try {
      text = el.textContent || "";
    } catch (_) {
      return "";
    }
    return normalizeSpace(text);
  }

  /** 块里是否只有图片等无文字内容（这类块跳过，不朗读）。 */
  function isTextless(el) {
    return !HAS_TEXT_RE.test(el && el.textContent ? el.textContent : "");
  }

  // ---------------------------------------------------------------- 句子切分

  /**
   * 把一段文本切成句子（**不合并**，保留原始句边界）。
   *
   * 规则：
   *   1. 在句末标点处断句，并把其后的收尾引号/括号一并归入该句；
   *   2. 超长句在次级断点（逗号等）处二次切分，避免几千字一个请求。
   *
   * 合并成 cue 是下一步（packSentences）的事——那里按「首块小、后续大」
   * 的阈值打包，比在这里硬性合并更可控。
   *
   * @param {string} text
   * @returns {string[]} 句子数组（已去空、已归一化空白）
   */
  function splitSentences(text) {
    const src = normalizeSpace(text);
    if (!src) return [];

    const raw = [];
    let buf = "";
    let i = 0;

    while (i < src.length) {
      const ch = src[i];
      buf += ch;

      if (SENT_END_RE.test(ch)) {
        // 先吃掉**连续**的句末标点：「……」是两个字符、还有「？！」「！？」，
        // 它们整体才是一个句末。若只按单字符断句，会把「这……怎么可能？」
        // 切成「这」+「」+「怎么可能？」，产生空句（实测踩过）。
        let j = i + 1;
        while (j < src.length && SENT_END_RE.test(src[j])) {
          buf += src[j];
          j++;
        }
        // 再吃掉收尾符号（引号、括号等），它们属于本句。
        while (j < src.length && CLOSER_RE.test(src[j])) {
          buf += src[j];
          j++;
        }
        while (j < src.length && src[j] === " ") j++; // 标点后的空格
        const s = buf.trim();
        if (s) raw.push(s);
        buf = "";
        i = j;
        continue;
      }
      i++;
    }
    if (buf.trim()) raw.push(buf.trim());

    // 超长句二次切分
    const out = [];
    for (const s of raw) {
      if (s.length <= MAX_CUE_CHARS) out.push(s);
      else for (const piece of splitLong(s)) out.push(piece);
    }
    return out.filter((s) => HAS_TEXT_RE.test(s));
  }

  /** 超长句在次级断点处切分；仍超长则按长度硬切。 */
  function splitLong(sentence) {
    const parts = [];
    let buf = "";
    for (let i = 0; i < sentence.length; i++) {
      buf += sentence[i];
      const atBreak = SECONDARY_RE.test(sentence[i]);
      const tooLong = buf.length >= MAX_CUE_CHARS;
      if ((atBreak && buf.length >= MIN_CUE_CHARS) || tooLong) {
        parts.push(buf.trim());
        buf = "";
      }
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts.filter(Boolean);
  }

  /**
   * 把句子打包成 cue。
   *
   * 策略：顺序累积句子，直到达到目标长度才切断。
   * 首个 cue 用较小的 firstTarget（尽快出声），之后用 target。
   * 单句本身就超长时独占一个 cue。
   *
   * @param {string[]} sentences
   * @param {object} opts { firstTarget, target }
   * @returns {string[]} cue 文本数组
   */
  function packSentences(sentences, opts) {
    const o = opts || {};
    const firstTarget = o.firstTarget || PARA_FIRST_CHARS;
    const target = o.target || PARA_TARGET_CHARS;

    const cues = [];
    let buf = "";
    const limit = () => (cues.length === 0 ? firstTarget : target);

    for (const s of sentences) {
      if (!buf) {
        buf = s;
      } else if (buf.length + s.length <= limit() * 1.4) {
        // 1.4 倍松弛：略微超出目标好过留下一个极短的尾巴
        buf = buf + s;
      } else {
        cues.push(buf);
        buf = s;
      }
      // 已达目标 → 立即切（下一句开新 cue）
      if (buf.length >= limit()) {
        cues.push(buf);
        buf = "";
      }
    }
    if (buf) cues.push(buf);
    return cues;
  }

  /**
   * 把段落文本按段落边界打包（整页模式用，**不切断段落**）。
   *
   * @param {string[]} paragraphs
   * @param {object} opts { firstTarget, target }
   * @returns {Array<{text:string, from:number, to:number}>} 每段覆盖的段落下标区间 [from, to]
   */
  function packParagraphs(paragraphs, opts) {
    const o = opts || {};
    const firstTarget = o.firstTarget || PAGE_FIRST_CHARS;
    const target = o.target || PAGE_TARGET_CHARS;

    const out = [];
    let buf = [];
    let len = 0;
    const limit = () => (out.length === 0 ? firstTarget : target);

    const flush = () => {
      if (!buf.length) return;
      out.push({
        text: buf.join("\n"),
        from: out.length ? null : 0, // 占位，下面统一重算
        to: 0,
      });
      buf = [];
      len = 0;
    };

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      buf.push(p);
      len += p.length;
      if (len >= limit()) flush();
    }
    flush();

    // 重算每块覆盖的段落下标区间，供高亮定位使用
    let cursor = 0;
    for (const item of out) {
      const count = item.text.split("\n").length;
      item.from = cursor;
      item.to = cursor + count - 1;
      cursor += count;
    }
    return out;
  }

  // ---------------------------------------------------------------- 单元收集

  /**
   * 收集正文容器里的朗读单元。
   *
   * paragraph 模式：一个正文块 = 一个单元。
   * page     模式：一条章节分隔线到下一个分隔线之间的所有块 = 一个单元。
   *
   * 每个单元都带 pageIndex（遇到分隔线就 +1），用于保证打包时
   * **不会让一个 cue 跨越章节边界**——跨章拼接会让语气在接缝处突变。
   *
   * ## 增量扫描（startIndex / initialChapterTitle）
   *
   * 自动续页会不断往容器追加子元素。引擎只需扫描新增部分，
   * 因此支持从第 startIndex 个子元素开始；但章节标题与 pageIndex
   * 是**累积状态**，必须由调用方把上次的终值传回来
   * （initialChapterTitle / initialPageIndex），否则新单元的章节归属会错。
   *
   * @param {Element} contentEl .rd-content 元素
   * @param {object} [opts]
   * @param {string} [opts.mode] "paragraph"（默认）| "page"
   * @param {string} [opts.fallbackTitle] 首个单元的标题（视图标题兜底）
   * @param {number} [opts.startIndex] 从第几个子元素开始扫描（默认 0）
   * @param {string} [opts.initialChapterTitle] 起始时的章节标题
   * @param {number} [opts.initialPageIndex] 起始时的页码
   * @returns {Array<object>} 单元数组
   */
  function collectUnits(contentEl, opts) {
    const options = opts || {};
    const mode = MODES.indexOf(options.mode) >= 0 ? options.mode : MODE_PARAGRAPH;
    const fallbackTitle = normalizeSpace(options.fallbackTitle);

    const units = [];
    if (!contentEl || !contentEl.children) return units;

    const children = Array.prototype.slice.call(contentEl.children);
    const startIndex = Math.max(0, Number(options.startIndex) || 0);
    let chapterTitle = normalizeSpace(options.initialChapterTitle) || "";
    let pageIndex = Number(options.initialPageIndex) || 0;
    let open = null; // page 模式下正在累积的单元

    const push = (u) => {
      u.index = units.length;
      u.key = mode + ":" + u.index;
      units.push(u);
    };

    /**
     * 把 page 模式下正在累积的 open 对象固化成单元。
     *
     * 抽成函数是因为它在两处被调用（遇到分隔线时、扫描结束时），
     * 曾经只在结尾处补齐 text 字段，导致遇到分隔线时推出的单元
     * 缺少 text（表现为 `u.text.length` 报 undefined）。
     */
    const sealPage = (o, terminated) => {
      push({
        text: o.texts.join("\n"),
        texts: o.texts,
        blocks: o.blocks,
        sentences: o.sentences,
        chapterTitle: o.chapterTitle,
        pageIndex: o.pageIndex,
        terminated: terminated,
      });
    };

    for (let ci = startIndex; ci < children.length; ci++) {
      const el = children[ci];

      if (isSeparator(el)) {
        if (mode === MODE_PAGE && open) {
          sealPage(open, true); // 分隔线出现 → 上一页已完整
          open = null;
        }
        const t = separatorTitle(el);
        if (t) chapterTitle = t;
        pageIndex++;
        continue;
      }

      if (isTextless(el)) continue; // 纯图片等：不朗读
      const text = blockText(el);
      if (!text) continue;

      if (mode === MODE_PARAGRAPH) {
        push({
          text: text,
          blocks: [el],
          sentences: splitSentences(text),
          chapterTitle: chapterTitle || (units.length === 0 && startIndex === 0 ? fallbackTitle : ""),
          pageIndex: pageIndex,
          terminated: true, // 块一旦出现即完整
        });
      } else {
        if (!open) {
          open = {
            texts: [],
            blocks: [],
            sentences: [],
            chapterTitle: chapterTitle || (units.length === 0 && startIndex === 0 ? fallbackTitle : ""),
            pageIndex: pageIndex,
            terminated: false,
          };
        }
        open.texts.push(text);
        open.blocks.push(el);
        open.sentences.push(text); // 整页模式按段打包，不按句
      }
    }

    // 末尾未闭合的 page 单元：先收进来但标记未终止。
    //
    // 注意：这里**不会**造成「半页」问题——reader-view.appendArticle 是
    // 原子追加（一次性搬入整页所有节点），所以任何时刻观测到的页都是完整的。
    // terminated 仅用于区分「页尾是否已有分隔线」，引擎不依赖它做等待。
    if (mode === MODE_PAGE && open) sealPage(open, false);

    return units;
  }

  /**
   * 读取容器的累积扫描状态（供增量扫描传回 collectUnits）。
   *
   * @param {Element} contentEl
   * @returns {{childCount:number, chapterTitle:string, pageIndex:number}}
   */
  function scanState(contentEl) {
    if (!contentEl || !contentEl.children) {
      return { childCount: 0, chapterTitle: "", pageIndex: 0 };
    }
    const children = Array.prototype.slice.call(contentEl.children);
    let chapterTitle = "";
    let pageIndex = 0;
    for (const el of children) {
      if (isSeparator(el)) {
        const t = separatorTitle(el);
        if (t) chapterTitle = t;
        pageIndex++;
      }
    }
    return { childCount: children.length, chapterTitle: chapterTitle, pageIndex: pageIndex };
  }

  /**
   * 增量打包器：把单元陆续喂进来，陆续吐出 cue。
   *
   * ## 为什么必须增量（而不是每次重建整份 cue 列表）
   *
   * 自动续页会在用户阅读过程中不断往 .rd-content 追加新块。若每次追加都
   * 重新打包整份列表，**已经合成好的 cue 会因重新切分而错位**——
   * 缓存的音频对不上文本，朗读内容会串。
   *
   * 增量打包保证：一旦某个 cue 被吐出，它的文本与下标永不改变。
   * 新内容只会追加成新 cue。
   *
   * @param {object} [opts]
   * @param {string} [opts.mode] paragraph（默认）| page
   * @param {number} [opts.firstTarget] 首个 cue 目标字符数（更小 → 更快出声）
   * @param {number} [opts.target] 后续 cue 目标字符数
   */
  function createPacker(opts) {
    const o = opts || {};
    const mode = MODES.indexOf(o.mode) >= 0 ? o.mode : MODE_PARAGRAPH;
    const isPage = mode === MODE_PAGE;
    const firstTarget = Number(o.firstTarget) > 0
      ? Number(o.firstTarget)
      : (isPage ? PAGE_FIRST_CHARS : PARA_FIRST_CHARS);
    const target = Number(o.target) > 0
      ? Number(o.target)
      : (isPage ? PAGE_TARGET_CHARS : PARA_TARGET_CHARS);

    const cues = [];
    let buf = null;

    /** 目标长度：首个 cue 更小，尽快出声。 */
    function limit() {
      return cues.length === 0 ? firstTarget : target;
    }

    /** 把手上的缓冲吐成一个 cue（永不修改已吐出的 cue）。 */
    function flush() {
      if (!buf || !buf.texts.length) {
        buf = null;
        return null;
      }
      const cue = {
        index: cues.length,
        text: buf.texts.join("\n"),
        blocks: buf.blocks.slice(),
        chars: buf.chars,
        chapterTitle: buf.chapterTitle,
        unitIndex: buf.unitIndex,
        pageIndex: buf.pageIndex,
        mode: mode,
      };
      cues.push(cue);
      buf = null;
      return cue;
    }

    function newBuf(unit) {
      return {
        texts: [],
        blocks: [],
        chars: 0,
        pageIndex: unit.pageIndex,
        chapterTitle: unit.chapterTitle || "",
        unitIndex: unit.index,
      };
    }

    /**
     * 喂入一个单元。**只应喂入「已完整」的单元**——
     * 仍在增长的整页单元由调用方（引擎）判断后再喂，否则会把
     * 半页文本固化成一个 cue。
     */
    function addUnit(unit) {
      if (!unit) return;
      // 章节边界 → 先收掉手上的缓冲，避免一个 cue 跨章拼接
      if (buf && unit.pageIndex !== buf.pageIndex) flush();

      const pieces = (unit.sentences && unit.sentences.length)
        ? unit.sentences
        : (unit.text ? [unit.text] : []);

      for (const piece of pieces) {
        if (!piece) continue;
        // 手上已有内容且加上这句会明显超出目标 → 先收
        if (buf && buf.chars + piece.length > limit() * 1.4) flush();
        if (!buf) buf = newBuf(unit);
        buf.texts.push(piece);
        buf.chars += piece.length;
        buf.blocks.push((unit.blocks && unit.blocks[0]) || null);
        if (buf.chars >= limit()) flush();
      }
    }

    return {
      addUnit,
      flush,
      mode,
      limit,
      get cues() { return cues; },
      /** 尚未成 cue 的缓冲字符数（引擎判断「是否还有未固化文本」用）。 */
      pendingChars: () => (buf ? buf.chars : 0),
      hasPending: () => Boolean(buf && buf.texts.length),
    };
  }

  /**
   * 一次性构建全部 cue（测试与简单场景用；运行时用 createPacker 增量喂）。
   *
   * @returns {{cues:Array<object>, units:Array<object>}}
   */
  function buildCues(contentEl, opts) {
    const options = opts || {};
    const mode = MODES.indexOf(options.mode) >= 0 ? options.mode : MODE_PARAGRAPH;
    const units = collectUnits(contentEl, {
      mode: mode,
      fallbackTitle: options.fallbackTitle,
    });
    const packer = createPacker(options);
    for (const u of units) packer.addUnit(u);
    packer.flush();
    return { cues: packer.cues, units: units };
  }

  /**
   * 估算一段文字的朗读时长（秒）。
   *
   * 中文按约 4.5 字/秒（实测官方 TTS 语速：1134 字 → 350 秒，约 3.2 字/秒；
   * 取 4 字/秒做保守估计，宁可高估提前量也不要低估）。
   *
   * 用途：引擎判断「剩余可播音频还够多久」时，把「已排队但还没合成完的
   * cue 文本量」折算成秒数，从而在水位不足前就触发续章。
   *
   * @param {string} text
   * @param {number} [rate] 播放速率（>1 时耗时更短）
   */
  function estimateSeconds(text, rate) {
    const chars = normalizeSpace(text).length;
    if (!chars) return 0;
    const r = Number(rate) > 0 ? Number(rate) : 1;
    return chars / 4 / r;
  }

  return {
    MODE_PARAGRAPH,
    MODE_PAGE,
    MODES,
    MIN_CUE_CHARS,
    MAX_CUE_CHARS,
    PARA_FIRST_CHARS,
    PARA_TARGET_CHARS,
    PAGE_FIRST_CHARS,
    PAGE_TARGET_CHARS,
    SEP_CLASS,
    normalizeSpace,
    isSeparator,
    separatorTitle,
    blockText,
    isTextless,
    splitSentences,
    splitLong,
    packSentences,
    packParagraphs,
    collectUnits,
    scanState,
    createPacker,
    buildCues,
    estimateSeconds,
  };
});
