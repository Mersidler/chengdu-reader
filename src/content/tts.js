/**
 * tts.js — 有声朗读引擎。
 *
 * 职责：把阅读视图的正文切分成 cue，调用 TTS 合成音频，按顺序播放，
 * 并在本章将尽时提前加载下一章。
 *
 * ## 核心设计：播放水位驱动，而不是滚动驱动
 *
 * 「本章快读完了」这件事**不需要用滚动位置去猜**——播放引擎自己精确知道
 * 还剩几条 cue 没合成、还剩多少秒音频。这比滚动像素准得多，且天然带提前量。
 *
 *     cue 队列 → 合成队列（并发 N，保持水位）→ 音频队列 → 顺序播放
 *                  ↑                                    │
 *                  └── 剩余未播时长 < 阈值 → 触发续章 ────┘
 *
 * ## 下一章的文字预取是现成的
 *
 * auto-next.js 的 prefetch() 在进入阅读模式约 1.2 秒后就把下一章抓取、
 * 解析、净化、清空行完毕，缓存在内部。读到底时 maybeLoadNext() 命中缓存
 * 即零等待插入。本模块**不重复实现抓取**，只在水位不足时调用它。
 *
 * ## 为什么扫描 .rd-content 而不是直接取 article
 *
 * 追加内容时 reader-view.appendArticle 会把 article.content 的节点**搬移**
 * 进 .rd-content。若本模块直接持有 article.content 的引用，节点被搬走后
 * 引用就指向空容器了。改为扫描 .rd-content 则天然跟随，且节点身份在搬移后
 * 不变（同一个 DOM 对象），高亮可以直接对块元素加 class。
 *
 * ## 两个实测得来的硬约束
 *
 * 1. **合成必须走 background**：content script 的 origin 是 moz-extension://，
 *    对 api.xiaomimimo.com 是跨源，且 host_permissions 对 content script 无效。
 * 2. **音频用 Web Audio 播放**，不用 <audio>+blob：后者受页面 CSP 的 media-src
 *    约束（本项目在 CSP 上栽过），decodeAudioData 完全不受影响。
 *
 * ## 顶层绝不能碰 AudioContext
 *
 * jsdom 里没有 AudioContext，若在模块加载时就 new 一个，所有加载本模块的
 * 测试都会崩。因此音频上下文一律惰性创建，且处处 typeof 守卫。
 */
(function (root, factory) {
  const mod = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  } else {
    root.ReaderTts = mod;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /** 状态机取值。 */
  const STATE = {
    IDLE: "idle",
    BUFFERING: "buffering", // 首次合成中（还没出声）
    PLAYING: "playing",
    PAUSED: "paused",
    ENDED: "ended",
    ERROR: "error",
  };

  /**
   * 并发合成数。取 2 的原因：
   *   - 1 会导致「合成慢于播放」时断流；
   *   - 3+ 在实测中收益不明显（服务端单次生成约 0.14s/字），
   *     反而更容易触发服务端的并发限流。
   */
  const CONCURRENCY = 2;

  /**
   * 水位阈值（秒）。剩余可播音频低于此值就触发续章预取。
   *
   * 取 90 秒的理由：续章一次抓取+解析通常几秒，但站点被 Cloudflare 拦时
   * 会降级为真实导航（更慢）。90 秒足够覆盖，又不会过早触发导致
   * 用户还在本章开头就把下一章也拉了（浪费流量）。
   */
  const LOW_WATER_SECONDS = 90;

  /** 水位检查间隔（毫秒）。不必太频繁：音频是按秒消耗的。 */
  const WATER_CHECK_MS = 3000;

  /** 单条 cue 合成失败后的重试次数。 */
  const MAX_RETRY = 2;

  /** 重试退避基数（毫秒），按次数翻倍。 */
  const RETRY_BACKOFF_MS = 800;

  /** 进度记忆的存储键前缀（实际 key 会拼上页面 URL 的 hash）。 */
  const PROGRESS_KEY = "readerTtsProgress";
  /** 最多保留多少条进度记录（超出时淘汰最旧的）。 */
  const PROGRESS_MAX = 50;

  // ---------------------------------------------------------------- 工具

  function now() {
    return typeof Date !== "undefined" && Date.now ? Date.now() : 0;
  }

  /** 取扩展的 runtime（用于发消息）。 */
  function runtime() {
    if (typeof browser !== "undefined" && browser.runtime) return browser.runtime;
    if (typeof chrome !== "undefined" && chrome.runtime) return chrome.runtime;
    return null;
  }

  /** 取 storage.local。 */
  function storageLocal() {
    if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
      return browser.storage.local;
    }
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
    return null;
  }

  /** 把 URL 规整成进度记录的键（去 hash）。 */
  function urlKey(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      return u.href;
    } catch (_) {
      return String(url || "");
    }
  }

  /**
   * 创建朗读引擎。
   *
   * @param {object} deps
   * @param {Function} deps.getContent  () => Element|null  取 .rd-content
   * @param {Function} [deps.getTitle]  () => string         取当前章节标题（兜底）
   * @param {Function} [deps.onState]   (state) => void      状态变化（驱动播放条）
   * @param {Function} [deps.onCueChange] (cue, index) => void 当前 cue 变化
   * @param {Function} [deps.onNeedNext] () => Promise<boolean> 需要下一章时调用
   *                                    （由 main.js 接到 autoNext.maybeLoadNext）
   * @param {Function} [deps.highlight] (block, on) => void  高亮/取消高亮
   * @param {Function} [deps.scrollTo]  (block) => void      滚动到块
   * @param {Function} [deps.synth]     (req) => Promise<result> 合成函数（测试可注入）
   * @param {Function} [deps.createAudioPlayer] () => player  音频播放器（测试可注入）
   * @param {object}   [deps.text]      TtsText 模块（默认取全局）
   * @param {string}   [deps.url]       页面 URL（进度记忆用，默认 location.href）
   */
  function createTts(deps) {
    const d = deps || {};
    const textMod = d.text || (root && root.TtsText) || null;
    if (!textMod) {
      throw new Error("ReaderTts 需要 TtsText 模块（切分文本用）");
    }

    const getContent = d.getContent || (() => null);
    const getTitle = d.getTitle || (() => "");
    const onState = d.onState || function () {};
    const onCueChange = d.onCueChange || function () {};
    const onNeedNext = d.onNeedNext || null;
    const highlight = d.highlight || function () {};
    const scrollTo = d.scrollTo || function () {};
    const synth = d.synth || defaultSynth;
    const createPlayer = d.createAudioPlayer || defaultCreatePlayer;
    const pageUrl = d.url || (typeof location !== "undefined" ? location.href : "");

    // ---- 可配置项（由外部通过 configure 设置）
    let opts = {
      apiKey: "",
      voice: "茉莉",
      format: "mp3",
      rate: 1,
      mode: textMod.MODE_PARAGRAPH,
      autoNext: true,
      resume: true,
    };

    // ---- 运行时状态
    let state = STATE.IDLE;
    let player = null;
    /** 已构建的 cue 列表（增量追加，下标永不改变）。 */
    let cues = [];
    /** 增量打包器。 */
    let packer = null;
    /** 已经喂给打包器的正文块数量（扫描游标）。 */
    let scannedCount = 0;
    /** 扫描游标的累积章节标题与页码（增量扫描时必须传回）。 */
    let scanChapterTitle = "";
    let scanPageIndex = 0;
    /** 每个 cue 的合成结果：{status, audio, error, attempts} */
    let synthResults = [];
    /** 正在合成中的 cue 下标集合。 */
    let inFlight = new Set();
    /** 下一个待播放的 cue 下标。 */
    let playCursor = 0;
    /** 当前正在播放的 cue 下标（-1 表示无）。 */
    let currentCue = -1;
    /** 水位检查定时器。 */
    let waterTimer = null;
    /** 是否正在请求下一章（防并发）。 */
    let loadingNext = false;
    /** 是否已到末尾（没有下一章了）。 */
    let reachedEnd = false;
    /** 停止标志（关闭时置位，让在途回调不再继续）。 */
    let stopped = true;
    /** 待恢复的进度（cue 下标），首次播放时跳转。 */
    let pendingResumeIndex = -1;
    /** 播放会话令牌：每次 start/stop 递增，用于丢弃过期回调。 */
    let session = 0;

    // ---------------------------------------------------------------- 状态

    function setState(next, extra) {
      if (state === next && !extra) return;
      state = next;
      onState({
        state: state,
        cueIndex: currentCue,
        cueCount: cues.length,
        playedCount: playCursor,
        reachedEnd: reachedEnd,
        chapterTitle: currentChapter(),
      });
    }

    function currentChapter() {
      if (currentCue >= 0 && cues[currentCue]) return cues[currentCue].chapterTitle || "";
      if (cues.length && playCursor < cues.length) return cues[playCursor].chapterTitle || "";
      return cues.length ? cues[cues.length - 1].chapterTitle || "" : "";
    }

    // ---------------------------------------------------------------- 文本扫描

    /**
     * 扫描 .rd-content，把**新出现**的块喂进打包器。
     *
     * ## 为什么按子元素数量做游标
     *
     * reader-view.appendArticle 是**原子追加**：一次把所有新节点搬进容器，
     * 不存在「加到一半」的中间状态。因此块只会追加、不会修改，
     * 用「已消费的子元素数」做游标即可保证幂等——重复扫描不会重复喂入。
     *
     * 注意游标基于**全部子元素**（含 .rd-chapter-sep），而不是「正文块」，
     * 因为分隔线也参与 pageIndex/章节标题的累积，跳过它会让归属算错。
     *
     * @returns {number} 本次新增的 cue 数
     */
    function scan() {
      const contentEl = getContent();
      if (!contentEl) return 0;

      const childCount = contentEl.children ? contentEl.children.length : 0;
      if (childCount <= scannedCount) return 0;

      const prevCueCount = cues.length;

      // 把上次的累积状态传回去，保证新单元的章节归属正确
      const units = textMod.collectUnits(contentEl, {
        mode: opts.mode,
        fallbackTitle: getTitle(),
        startIndex: scannedCount,
        initialChapterTitle: scanChapterTitle,
        initialPageIndex: scanPageIndex,
      });

      for (const unit of units) packer.addUnit(unit);

      // 扫描后**必须 flush**：打包器为凑满目标长度会留住尾巴，
      // 但 appendArticle 是原子追加——任何时刻扫描到的内容都是完整的，
      // 没有「等更多内容」的必要。不 flush 会让首次打开时
      // 缓冲区里的文字永远成不了 cue（实测踩过：cueCount 恒为 0）。
      // flush 只把缓冲吐成新 cue，不会改动已吐出的 cue。
      packer.flush();

      // ★ 关键：cue 列表由打包器拥有。引擎自己的 `cues` 变量只是
      // 同一数组的引用——必须重新同步，否则新增的 cue 不可见
      // （实测踩过：scannedCount 已推进但 cueCount 仍为 0）。
      cues = packer.cues;

      // 更新累积状态：从「已扫描过的最后位置」继续累积
      const st = textMod.scanState(contentEl);
      scanChapterTitle = st.chapterTitle;
      scanPageIndex = st.pageIndex;
      scannedCount = childCount;

      return cues.length - prevCueCount;
    }

    // ---------------------------------------------------------------- 合成

    /** 通过 background 合成（content script 无跨域权限）。 */
    function defaultSynth(req) {
      return new Promise((resolve) => {
        const rt = runtime();
        if (!rt || !rt.sendMessage) {
          resolve({ ok: false, reason: "no-runtime" });
          return;
        }
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        try {
          rt.sendMessage(
            { type: "cd-tts-synth", text: req.text, voice: req.voice, format: req.format, apiKey: req.apiKey },
            (response) => {
              const lastError = rt.lastError;
              if (lastError) {
                done({ ok: false, reason: "message-error", message: String(lastError.message || lastError) });
                return;
              }
              done(response || { ok: false, reason: "empty-response" });
            }
          );
        } catch (err) {
          done({ ok: false, reason: "exception", message: String((err && err.message) || err) });
        }
      });
    }

    /**
     * 把 base64 音频解码成 AudioBuffer。
     *
     * 为什么用 Web Audio 而不是 <audio src=blob:>：
     * <audio> 元素在页面文档里受页面 CSP 的 media-src 限制，
     * 而 decodeAudioData 走的是纯 JS 数据路径，不受 CSP 约束。
     */
    function defaultCreatePlayer() {
      let ctx = null;
      let source = null;
      let gain = null;
      let startedAt = 0;
      let offsetAtStart = 0;
      let playing = false;
      let onEndedCb = null;
      let pending = null;

      function ensureCtx() {
        if (ctx) return ctx;
        const AC = (typeof AudioContext !== "undefined" && AudioContext)
          || (typeof webkitAudioContext !== "undefined" && webkitAudioContext)
          || null;
        if (!AC) return null;
        try {
          ctx = new AC();
        } catch (_) {
          ctx = null;
        }
        return ctx;
      }

      /**
       * 在**用户手势的同步栈里**创建并解锁音频上下文。
       *
       * ## 为什么必须单独做这一步（这是「合成成功但没有声音」的根因）
       *
       * 浏览器的自动播放策略要求 `AudioContext` 在用户手势的同步执行栈中
       * 创建或 `resume()`。而引擎的启动链路是：
       *
       *     点击播放 → start() → await loadProgress() → await synth()（网络数秒）
       *                            ↑ 中间隔着 await，手势上下文早已失效
       *     → player.load() → new AudioContext()   ← 在这里才创建，太晚了
       *
       * 实测后果：context 被创建为 `suspended`，音频**解码成功、source.start()
       * 也不报错，但完全不出声**；而且 `onended` 永不触发，
       * 引擎会卡在第一条 cue 上再也不前进。
       *
       * 更糟的是 `ctx.resume()` 在无手势时返回的 Promise **永不 resolve**
       * （浏览器在等一个不会到来的手势），所以不能靠「等一下再 resume」补救，
       * 必须在手势里就完成。
       *
       * @returns {boolean} 是否已处于 running（或至少创建成功）
       */
      function prime() {
        const c = ensureCtx();
        if (!c) return false;
        try {
          if (c.state === "suspended" && c.resume) {
            // 刻意不 await：resume() 在无手势时永不 resolve，
            // 等它会把整个启动流程挂死。同步调用即已在手势栈中生效。
            const p = c.resume();
            if (p && typeof p.catch === "function") p.catch(() => {});
          }
        } catch (_) {
          /* 忽略：下面用 state 判断结果 */
        }
        return c.state === "running";
      }

      /** 解码 base64 音频。 */
      async function decode(b64) {
        const c = ensureCtx();
        if (!c) throw new Error("AudioContext 不可用");
        // atob → Uint8Array（避免 fetch data: URL，那会受 CSP 影响）
        const bin = typeof atob === "function" ? atob(b64) : null;
        if (bin === null) throw new Error("atob 不可用");
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        // decodeAudioData 在部分实现里只接受 ArrayBuffer 且会 detach
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + len);
        return await new Promise((resolve, reject) => {
          let settled = false;
          const ok = (r) => { if (!settled) { settled = true; resolve(r); } };
          const fail = (e) => { if (!settled) { settled = true; reject(e || new Error("decode-failed")); } };
          try {
            const p = c.decodeAudioData(buf, ok, fail);
            if (p && typeof p.then === "function") p.then(ok).catch(fail);
          } catch (e) {
            fail(e);
          }
        });
      }

      function stopSource() {
        if (source) {
          try { source.onended = null; source.stop(); } catch (_) { /* 已停止 */ }
          try { source.disconnect(); } catch (_) { /* 忽略 */ }
          source = null;
        }
        playing = false;
      }

      return {
        prime,
        /** 音频上下文是否已就绪（running）。未就绪时播放不会出声。 */
        isReady() {
          return Boolean(ctx && ctx.state === "running");
        },
        /** 当前音频上下文状态（诊断用）。 */
        ctxState() {
          return ctx ? ctx.state : "none";
        },
        /**
         * 解码一段音频，**只解码、不播放、不打断当前播放**。
         *
         * ## 这里曾经有两个 bug（合并表现为「换音色后就没声音」）
         *
         * 1. 函数开头调了 `stopSource()`。而引擎在后台合成完**每一条**
         *    cue 后都会调 load()——于是后台合成第 2 条时，第 1 条
         *    正在播的音频被强行停掉。更糟的是 stopSource() 会把
         *    `source.onended` 置空，`onCueEnded()` 永不触发，
         *    引擎就永远卡在 "playing" 状态却没有任何声音。
         *
         *    换音色会**必然**触发这条路径：configure({voice}) 作废未播结果
         *    → pump() 重新合成 → load() → 掐掉当前播放。所以症状是
         *    「换音色就没声音了」，且看起来像卡住（状态仍是 playing）。
         *
         * 2. 它把结果写进共享变量 `pending`，而 pending 只应代表
         *    「当前正在播的那条」——后台预合成会把它覆盖成还没播的音频，
         *    导致暂停后 resume() 恢复到错误的音频上。
         *
         * 现在：load() 纯解码并返回；`pending` 由 play() 独占维护。
         */
        async load(b64) {
          return await decode(b64);
        },
        play(buffer, rate, onEnded) {
          const c = ensureCtx();
          if (!c) return false;
          stopSource();
          const buf = buffer || pending;
          if (!buf) return false;
          // pending 代表「当前这条」，供 pause/resume 使用。
          // 只在这里赋值，保证它与实际播放的内容一致。
          pending = buf;
          try {
            if (c.state === "suspended" && c.resume) c.resume();
          } catch (_) { /* 忽略 */ }
          source = c.createBufferSource();
          source.buffer = buf;
          // 语速：Web Audio 的 playbackRate 会同时改变音调
          // （原生没有「变速不变调」，这是已知限制，见 README）。
          source.playbackRate.value = Number(rate) > 0 ? Number(rate) : 1;
          if (!gain) {
            gain = c.createGain();
            gain.connect(c.destination);
          }
          source.connect(gain);
          onEndedCb = onEnded || null;
          source.onended = () => {
            playing = false;
            const cb = onEndedCb;
            onEndedCb = null;
            if (cb) cb();
          };
          offsetAtStart = 0;
          startedAt = c.currentTime;
          try {
            source.start(0);
          } catch (_) {
            return false;
          }
          playing = true;
          return true;
        },
        pause() {
          if (!playing || !source || !ctx) return false;
          try {
            offsetAtStart += (ctx.currentTime - startedAt) * (source.playbackRate.value || 1);
            source.onended = null;
            source.stop();
            source.disconnect();
          } catch (_) { /* 忽略 */ }
          source = null;
          playing = false;
          return true;
        },
        resume(rate, onEnded) {
          const c = ensureCtx();
          if (!c || !pending) return false;
          stopSource();
          try {
            if (c.state === "suspended" && c.resume) c.resume();
          } catch (_) { /* 忽略 */ }
          source = c.createBufferSource();
          source.buffer = pending;
          source.playbackRate.value = Number(rate) > 0 ? Number(rate) : 1;
          if (!gain) {
            gain = c.createGain();
            gain.connect(c.destination);
          }
          source.connect(gain);
          onEndedCb = onEnded || null;
          source.onended = () => {
            playing = false;
            const cb = onEndedCb;
            onEndedCb = null;
            if (cb) cb();
          };
          startedAt = c.currentTime;
          try {
            source.start(0, Math.max(0, offsetAtStart));
          } catch (_) {
            return false;
          }
          playing = true;
          return true;
        },
        stop() {
          stopSource();
          pending = null;
          offsetAtStart = 0;
        },
        setVolume(v) {
          if (gain) gain.gain.value = Number(v);
        },
        isPlaying() { return playing; },
        /** 当前音频总时长（秒）。 */
        duration() { return pending ? pending.duration : 0; },
        /** 已播放时长（秒，含暂停前的累计）。 */
        position() {
          if (!ctx) return offsetAtStart;
          if (playing && source) {
            return offsetAtStart + (ctx.currentTime - startedAt) * (source.playbackRate.value || 1);
          }
          return offsetAtStart;
        },
        close() {
          stopSource();
          if (ctx && ctx.close) {
            try { ctx.close(); } catch (_) { /* 忽略 */ }
          }
          ctx = null;
        },
      };
    }

    /** 合成指定下标的 cue（带重试）。 */
    async function synthCue(index, token) {
      const cue = cues[index];
      if (!cue) return;
      if (synthResults[index] && synthResults[index].status === "done") return;
      if (inFlight.has(index)) return;

      inFlight.add(index);
      let attempts = 0;
      let lastErr = null;

      while (attempts <= MAX_RETRY) {
        if (stopped || token !== session) { inFlight.delete(index); return; }
        attempts++;
        let res;
        try {
          res = await synth({
            text: cue.text,
            voice: opts.voice,
            format: opts.format,
            apiKey: opts.apiKey,
          });
        } catch (err) {
          res = { ok: false, reason: "exception", message: String((err && err.message) || err) };
        }

        if (stopped || token !== session) { inFlight.delete(index); return; }

        if (res && res.ok) {
          try {
            const buffer = await player.load(res.audio);
            synthResults[index] = { status: "done", audio: res.audio, buffer: buffer, attempts: attempts };
            inFlight.delete(index);
            onSynthDone();
            return;
          } catch (err) {
            lastErr = { ok: false, reason: "decode-failed", message: String((err && err.message) || err) };
          }
        } else {
          lastErr = res;
          // 配置类错误重试无意义，直接失败
          const fatal = res && (res.reason === "no-api-key" || res.reason === "http-error"
            || res.reason === "empty-text" || res.reason === "too-long");
          if (fatal) break;
        }

        if (attempts <= MAX_RETRY) {
          await sleep(RETRY_BACKOFF_MS * attempts);
        }
      }

      synthResults[index] = { status: "failed", error: lastErr, attempts: attempts };
      inFlight.delete(index);
      onSynthDone();
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** 一个 cue 合成完成后：可能在等它播放 → 尝试推进。 */
    function onSynthDone() {
      if (state === STATE.BUFFERING) {
        // 首块好了就能出声
        if (synthResults[playCursor] && synthResults[playCursor].status === "done") {
          playCurrent();
        } else if (synthResults[playCursor] && synthResults[playCursor].status === "failed") {
          // 首块失败：跳过它，别让用户卡死
          skipFailed();
        }
      }
      pump();
    }

    /** 填充合成队列，保持水位。 */
    function pump() {
      if (stopped) return;
      scan(); // 先看看有没有新内容进来
      let active = inFlight.size;
      for (let i = 0; i < cues.length && active < CONCURRENCY; i++) {
        // 只合成「播放游标附近」的 cue，避免一开始就把整章都请求了
        if (i < playCursor) continue;
        if (i > playCursor + CONCURRENCY + 2) break;
        const r = synthResults[i];
        if (r && (r.status === "done" || r.status === "failed")) continue;
        if (inFlight.has(i)) continue;
        synthCue(i, session);
        active++;
      }
    }

    /** 跳过失败的 cue，继续往下。 */
    function skipFailed() {
      while (playCursor < cues.length) {
        const r = synthResults[playCursor];
        if (r && r.status === "failed") {
          playCursor++;
          continue;
        }
        break;
      }
      if (playCursor >= cues.length) {
        handleDrained();
      }
    }

    /** 播放当前 playCursor 指向的 cue。 */
    function playCurrent() {
      if (stopped) return;
      if (playCursor >= cues.length) {
        handleDrained();
        return;
      }
      const r = synthResults[playCursor];
      if (!r || r.status !== "done") {
        // 还没合成好 → 进入等待（若首次则显示缓冲）
        if (state !== STATE.PAUSED) setState(STATE.BUFFERING);
        pump();
        return;
      }

      // 进度恢复：start() 已把 playCursor 设为目标位置，
      // 这里只需清掉标记（避免影响后续 seek 的语义）。
      if (pendingResumeIndex >= 0) pendingResumeIndex = -1;

      const cue = cues[playCursor];
      const token = session;
      const started = player.play(r.buffer, opts.rate, () => {
        if (stopped || token !== session) return;
        onCueEnded();
      });

      if (!started) {
        // 播放器拒绝播放（通常是音频上下文未就绪）→ 报错而非静默
        setState(STATE.ERROR, { message: "音频播放失败（可能是浏览器阻止了自动播放，请再点一次播放）" });
        return;
      }

      currentCue = playCursor;
      setState(STATE.PLAYING);
      onCueChange(cue, playCursor);
      if (cue.blocks && cue.blocks.length) {
        highlight(cue.blocks[0], true);
        scrollTo(cue.blocks[0]);
      }
    }

    /** 当前 cue 播完。 */
    function onCueEnded() {
      const finished = cues[currentCue];
      if (finished && finished.blocks && finished.blocks.length) highlight(finished.blocks[0], false);
      playCursor++;
      currentCue = -1;
      if (playCursor >= cues.length) {
        handleDrained();
      } else {
        playCurrent();
      }
    }

    /**
     * 已播到「当前已构建 cue」的末尾。
     *
     * 这里必须区分两种情况：
     *   · 还有未扫描的正文 → 继续扫描（可能马上就有新 cue）
     *   · 正文已扫完但还有下一章 → 请求下一章
     *   · 都没有 → 真的结束了
     */
    function handleDrained() {
      scan();
      if (playCursor < cues.length) {
        playCurrent();
        return;
      }

      // 还没扫到正文末尾？再扫一次（appendArticle 可能刚插入）
      const contentEl = getContent();
      const childCount = contentEl && contentEl.children ? contentEl.children.length : 0;
      if (scannedCount < childCount) {
        scan();
        if (playCursor < cues.length) {
          playCurrent();
          return;
        }
      }

      if (reachedEnd) {
        setState(STATE.ENDED);
        return;
      }

      // 需要下一章
      requestNextChapter().then((loaded) => {
        if (stopped) return;
        if (loaded) {
          scan();
          pump();
          if (playCursor < cues.length) playCurrent();
          else setState(STATE.ENDED);
        } else {
          setState(STATE.ENDED);
        }
      });
    }

    /**
     * 请求加载下一章。
     *
     * 走 main.js 注入的 onNeedNext（内部是 autoNext.maybeLoadNext），
     * 它命中 prefetch 缓存时是零等待的——这正是「提前取好下一章」的收益。
     *
     * @returns {Promise<boolean>} 是否成功追加了新内容
     */
    async function requestNextChapter() {
      if (!onNeedNext || loadingNext || reachedEnd) return false;
      loadingNext = true;
      const before = scannedCount;
      try {
        const res = await onNeedNext();
        if (stopped) return false;
        scan();
        const grew = scannedCount > before || cues.length > playCursor;
        if (!grew) {
          reachedEnd = true;
          return false;
        }
        return true;
      } catch (_) {
        return false;
      } finally {
        loadingNext = false;
      }
    }

    /**
     * 水位检查：剩余可播音频不足时提前拉下一章。
     *
     * 「剩余时长」由两部分组成：
     *   1. 已合成但未播的 cue 的实际音频时长；
     *   2. 已扫描但未合成的 cue 文本按字速折算的估算时长。
     * 这样即使合成队列还没跑完，也能正确判断「快听完了」。
     */
    function remainingSeconds() {
      let seconds = 0;
      // 当前正在播的 cue：算它剩余部分
      if (currentCue >= 0 && synthResults[currentCue] && synthResults[currentCue].status === "done") {
        const dur = player.duration ? player.duration() : 0;
        const pos = player.position ? player.position() : 0;
        seconds += Math.max(0, dur - pos) / (Number(opts.rate) > 0 ? Number(opts.rate) : 1);
      }
      for (let i = playCursor; i < cues.length; i++) {
        if (i === currentCue) continue;
        const r = synthResults[i];
        if (r && r.status === "done") {
          // 已合成：用真实时长（解码后 player.duration 只反映当前加载的那条，
          // 因此这里用文本估算，误差可接受且方向保守）
          seconds += textMod.estimateSeconds(cues[i].text, opts.rate);
        } else if (!r || r.status === "pending") {
          seconds += textMod.estimateSeconds(cues[i].text, opts.rate);
        }
      }
      return seconds;
    }

    function startWaterTimer() {
      stopWaterTimer();
      waterTimer = setInterval(() => {
        if (stopped || state === STATE.PAUSED || state === STATE.ENDED) return;
        if (reachedEnd || !onNeedNext) return;
        if (remainingSeconds() > LOW_WATER_SECONDS) return;
        // 水位不足 → 提前拉下一章（不打断当前播放）
        requestNextChapter().then((loaded) => {
          if (stopped || !loaded) return;
          scan();
          pump();
        });
      }, WATER_CHECK_MS);
    }

    function stopWaterTimer() {
      if (waterTimer) {
        clearInterval(waterTimer);
        waterTimer = null;
      }
    }

    // ---------------------------------------------------------------- 进度记忆

    function progressStoreKey() {
      return PROGRESS_KEY;
    }

    async function saveProgress() {
      if (!opts.resume) return;
      const store = storageLocal();
      if (!store) return;
      const key = urlKey(pageUrl);
      if (!key) return;
      // 记录「已播完的 cue 数」，恢复时从这一条继续。
      // 不记 cue 下标以外的内容：正文可能因重新提取而变化，下标足够稳。
      const entry = {
        index: playCursor,
        chapterTitle: currentChapter(),
        total: cues.length,
        at: now(),
      };
      try {
        const got = await store.get(progressStoreKey());
        const all = (got && got[progressStoreKey()]) || {};
        all[key] = entry;
        // 淘汰最旧，避免无限增长
        const keys = Object.keys(all);
        if (keys.length > PROGRESS_MAX) {
          keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
          for (const k of keys.slice(0, keys.length - PROGRESS_MAX)) delete all[k];
        }
        await store.set({ [progressStoreKey()]: all });
      } catch (_) {
        /* 存储不可用不影响朗读 */
      }
    }

    async function loadProgress() {
      if (!opts.resume) return null;
      const store = storageLocal();
      if (!store) return null;
      const key = urlKey(pageUrl);
      try {
        const got = await store.get(progressStoreKey());
        const all = (got && got[progressStoreKey()]) || {};
        return all[key] || null;
      } catch (_) {
        return null;
      }
    }

    async function clearProgress() {
      const store = storageLocal();
      if (!store) return;
      const key = urlKey(pageUrl);
      try {
        const got = await store.get(progressStoreKey());
        const all = (got && got[progressStoreKey()]) || {};
        if (all[key]) {
          delete all[key];
          await store.set({ [progressStoreKey()]: all });
        }
      } catch (_) {
        /* 忽略 */
      }
    }

    // ---------------------------------------------------------------- 生命周期

    /**
     * 在用户手势里解锁音频（**必须同步调用**）。
     *
     * 由 UI 的点击处理器直接调用，不要包在 Promise/await 之后，
     * 否则手势上下文失效、音频上下文会一直是 suspended。
     * 详见 player.prime 的说明。
     *
     * @returns {boolean} 是否已就绪
     */
    function primeAudio() {
      if (!player) player = createPlayer();
      if (!player.prime) return false;
      return player.prime();
    }

    /**
     * 开始朗读。
     *
     * @param {object} [opts2]
     * @param {boolean} [opts2.userGesture] 是否由用户手势直接触发。
     *   为 true 时不再要求音频上下文已 running（手势里已经 prime 过）。
     * @returns {Promise<boolean>} 是否成功启动
     */
    async function start(opts2) {
      if (!opts.apiKey) {
        setState(STATE.ERROR, { message: "请先填写小米 MiMo API Key" });
        return false;
      }
      stopped = false;
      session++;
      reachedEnd = false;
      loadingNext = false;
      playCursor = 0;
      currentCue = -1;
      cues = [];
      synthResults = [];
      inFlight = new Set();
      scannedCount = 0;
      scanChapterTitle = "";
      scanPageIndex = 0;
      packer = textMod.createPacker({ mode: opts.mode });

      if (!player) player = createPlayer();

      // 注意：这里**刻意不**因为「音频上下文尚未 running」就中止启动。
      //
      // 原因是 state 的更新是异步的：用户点击时 new AudioContext() 之后，
      // 即便处在手势栈里，紧跟着读 ctx.state 也可能仍是 "suspended"，
      // 稍后才转为 "running"。若在这里硬性判定失败，就会把
      // **本来可以正常播放**的情况误杀成「播放失败」（这类误判比无声更难排查）。
      //
      // 真正的失败由 playCurrent() 里 player.play() 返回 false 时给出提示，
      // 那时才是有依据的判断。

      scan();
      if (!cues.length) {
        setState(STATE.ERROR, { message: "这个页面没有可朗读的文字" });
        stopped = true;
        return false;
      }

      // 进度恢复：只恢复位置，不自动跳（首块仍从头合成以便快速出声），
      // 待首块播完再跳到目标位置会打断体验，因此这里直接设为目标位置。
      const saved = await loadProgress();
      if (saved && saved.index > 0 && saved.index < cues.length) {
        playCursor = saved.index;
        pendingResumeIndex = saved.index;
      }

      setState(STATE.BUFFERING);
      pump();
      startWaterTimer();
      return true;
    }

    /** 暂停。 */
    function pause() {
      if (state !== STATE.PLAYING && state !== STATE.BUFFERING) return false;
      if (player && player.pause) player.pause();
      setState(STATE.PAUSED);
      stopWaterTimer();
      saveProgress();
      return true;
    }

    /** 继续。 */
    function resume() {
      if (state !== STATE.PAUSED) return false;
      const token = session;
      const r = synthResults[currentCue >= 0 ? currentCue : playCursor];
      if (r && r.status === "done" && player && player.resume) {
        const started = player.resume(opts.rate, () => {
          if (stopped || token !== session) return;
          onCueEnded();
        });
        if (started) {
          setState(STATE.PLAYING);
          startWaterTimer();
          return true;
        }
      }
      // 音频已失效（如被 stop）→ 重新播当前条
      playCursor = currentCue >= 0 ? currentCue : playCursor;
      currentCue = -1;
      setState(STATE.PLAYING);
      startWaterTimer();
      pump();
      playCurrent();
      return true;
    }

    /** 跳到指定 cue 下标。 */
    function seek(index) {
      const i = Math.max(0, Math.min(Number(index) || 0, cues.length - 1));
      if (player && player.stop) player.stop();
      if (currentCue >= 0 && cues[currentCue] && cues[currentCue].blocks) {
        highlight(cues[currentCue].blocks[0], false);
      }
      currentCue = -1;
      playCursor = i;
      pendingResumeIndex = -1;
      setState(state === STATE.PAUSED ? STATE.PAUSED : STATE.BUFFERING);
      pump();
      if (state !== STATE.PAUSED) playCurrent();
      return true;
    }

    /** 上一条 / 下一条（按 cue）。 */
    function prev() {
      // 若当前这条已经播了一会儿，先回到本条开头（符合播放器习惯）
      if (currentCue >= 0 && player && player.position && player.position() > 2) {
        return seek(currentCue);
      }
      return seek((currentCue >= 0 ? currentCue : playCursor) - 1);
    }

    function next() {
      return seek((currentCue >= 0 ? currentCue : playCursor) + 1);
    }

    /** 停止并清理。 */
    function stop() {
      stopped = true;
      session++;
      stopWaterTimer();
      if (player) player.stop();
      if (currentCue >= 0 && cues[currentCue] && cues[currentCue].blocks) {
        highlight(cues[currentCue].blocks[0], false);
      }
      currentCue = -1;
      inFlight = new Set();
      setState(STATE.IDLE);
    }

    /** 完全销毁（关闭阅读模式时调用）。 */
    function destroy() {
      saveProgress();
      stop();
      if (player && player.close) player.close();
      player = null;
      cues = [];
      synthResults = [];
      packer = null;
    }

    /** 更新配置（音量/语速/音色/模式等）。 */
    function configure(next) {
      const prevMode = opts.mode;
      const prevVoice = opts.voice;
      opts = Object.assign({}, opts, next || {});

      if (next && next.mode && next.mode !== prevMode) {
        // 模式变化会改变切分结果，必须重来（已播位置按 cue 下标保留没有意义）
        const wasPlaying = state === STATE.PLAYING || state === STATE.BUFFERING;
        const idx = playCursor;
        cues = [];
        synthResults = [];
        inFlight = new Set();
        scannedCount = 0;
        scanChapterTitle = "";
        scanPageIndex = 0;
        packer = textMod.createPacker({ mode: opts.mode });
        scan();
        playCursor = Math.min(idx, Math.max(0, cues.length - 1));
        if (wasPlaying) {
          pump();
          playCurrent();
        }
      } else if (next && next.voice && next.voice !== prevVoice) {
        // 音色变化：已合成但未播的作废，重新合成
        for (let i = playCursor; i < synthResults.length; i++) {
          if (synthResults[i]) synthResults[i] = null;
        }
        pump();
      }

      if (next && next.rate && player && player.isPlaying && player.isPlaying()) {
        // 语速实时生效需要重建 source；简化处理：当前条播完自然应用。
        // （重建会引入可听的中断，得不偿失）
      }
    }

    return {
      start,
      pause,
      resume,
      stop,
      destroy,
      seek,
      prev,
      next,
      configure,
      primeAudio,
      saveProgress,
      clearProgress,
      scan,
      // 测试与 UI 用的只读访问
      getState: () => ({
        state: state,
        cueIndex: currentCue,
        cueCount: cues.length,
        playedCount: playCursor,
        scannedCount: scannedCount,
        reachedEnd: reachedEnd,
        remainingSeconds: remainingSeconds(),
        chapterTitle: currentChapter(),
        pendingResumeIndex: pendingResumeIndex,
      }),
      getCues: () => cues.slice(),
      getOptions: () => Object.assign({}, opts),
      /** 当前 cue 的文本（UI 显示用）。 */
      getCurrentText: () => (currentCue >= 0 && cues[currentCue] ? cues[currentCue].text : ""),
    };
  }

  return {
    STATE,
    CONCURRENCY,
    LOW_WATER_SECONDS,
    WATER_CHECK_MS,
    MAX_RETRY,
    RETRY_BACKOFF_MS,
    PROGRESS_KEY,
    PROGRESS_MAX,
    urlKey,
    createTts,
  };
});
