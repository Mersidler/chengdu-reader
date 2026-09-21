/**
 * tts-bar.js — 有声朗读的底部播放条。
 *
 * 位置：shadow root 的直接子元素，与 .rd-status 同理。
 * **绝不能放进 .rd-scroll 内部**——overflow:auto 容器里的绝对定位元素
 * 会随内容滚动，bottom:0 会指向「内容底部」而不是视口底部
 * （状态条曾踩过这个坑，见 reader-view.setStatus 的说明）。
 *
 * 层级：由 shadow 内的 DOM 顺序决定（都是 absolute，后者绘于上层）。
 * 播放条在 reader-view 里**最后** append，因此永远在最上层。
 *
 * ## 与工具条的分工
 *
 * 顶部 .rd-bar 只放一个「朗读」开关（是否启用朗读）。
 * 真正的播放控制（播放/暂停/上下条/语速/音色/粒度/进度）都在这条里，
 * 避免顶部工具条控件膨胀到换行、挤压正文。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.TtsBar = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /** 音色名（与 background.js 的 TTS_SUPPORTED_VOICES 保持一致）。 */
  const VOICES = ["茉莉", "冰糖", "苏打", "白桦", "mimo_default", "Mia", "Chloe", "Milo", "Dean"];

  /** 音色显示名（英文音色也给出中文说明，便于选择）。 */
  const VOICE_LABELS = {
    "茉莉": "茉莉·女声清亮",
    "冰糖": "冰糖·女声温和",
    "苏打": "苏打·男声阳光",
    "白桦": "白桦·男声浑厚",
    "mimo_default": "默认",
    "Mia": "Mia",
    "Chloe": "Chloe",
    "Milo": "Milo",
    "Dean": "Dean",
  };

  /** 语速档位。 */
  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

  /** 状态 → 显示文案与图标。 */
  const STATE_LABELS = {
    idle: { icon: "▶", text: "朗读" },
    buffering: { icon: "◌", text: "合成中…" },
    playing: { icon: "❚❚", text: "暂停" },
    paused: { icon: "▶", text: "继续" },
    ended: { icon: "↺", text: "重读" },
    error: { icon: "▶", text: "重试" },
  };

  /**
   * 创建播放条。
   *
   * @param {object} opts
   * @param {object} opts.prefs 偏好对象（会被就地修改）
   * @param {Function} opts.onToggle 播放/暂停/重试（由调用方按状态决定）
   * @param {Function} opts.onPrev 上一条
   * @param {Function} opts.onNext 下一条
   * @param {Function} opts.onChange (prefs) => void 偏好变化（音色/语速/粒度）
   * @param {Function} [opts.onApiKey] (key) => void API Key 变化（应立即写盘）
   * @param {Function} [opts.onSubmitKey] () => void 在输入框按回车（顺手开始播放）
   * @param {Function} opts.onClose 关闭（退出朗读）
   * @param {Function} [opts.onSeek] (index) => void 拖动进度
   */
  function create(opts) {
    const o = opts || {};
    const prefs = o.prefs || {};
    const onChange = o.onChange || function () {};
    const onApiKey = o.onApiKey || null;
    const onSubmitKey = o.onSubmitKey || null;
    const onToggle = o.onToggle || function () {};
    const onPrev = o.onPrev || function () {};
    const onNext = o.onNext || function () {};
    const onClose = o.onClose || function () {};
    const onSeek = o.onSeek || function () {};

    const doc = document;
    const bar = doc.createElement("div");
    bar.className = "rd-tts-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "朗读控制");

    // ---------------------------------------------------------- 辅助构造

    const btn = (label, title, onClick, extraClass) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (title) b.title = title;
      if (extraClass) b.className = extraClass;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(b, e);
      });
      return b;
    };

    const sep = () => {
      const s = doc.createElement("span");
      s.className = "rd-tts-sep";
      s.setAttribute("aria-hidden", "true");
      return s;
    };

    /** 下拉选择器（音色/粒度共用）。 */
    const select = (options, value, title, onPick) => {
      const sel = doc.createElement("select");
      sel.className = "rd-tts-select";
      if (title) sel.title = title;
      for (const opt of options) {
        const el = doc.createElement("option");
        el.value = opt.value;
        el.textContent = opt.label;
        sel.appendChild(el);
      }
      sel.value = value;
      sel.addEventListener("change", (e) => {
        e.stopPropagation();
        onPick(sel.value);
      });
      // 键盘事件不要冒泡到页面（否则空格/方向键会被页面截走）
      sel.addEventListener("keydown", (e) => e.stopPropagation());
      sel.addEventListener("mousedown", (e) => e.stopPropagation());
      return sel;
    };

    // ---------------------------------------------------------- 控件

    const toggleBtn = btn("▶", "开始朗读", () => onToggle(), "rd-tts-toggle");
    const prevBtn = btn("⏮", "上一段", () => onPrev());
    const nextBtn = btn("⏭", "下一段", () => onNext());

    const rateLabel = doc.createElement("span");
    rateLabel.className = "rd-tts-num";
    const rateDown = btn("−", "减慢语速", () => {
      prefs.ttsRate = stepRate(prefs.ttsRate, -1);
      refresh();
      onChange(prefs);
    });
    const rateUp = btn("+", "加快语速", () => {
      prefs.ttsRate = stepRate(prefs.ttsRate, 1);
      refresh();
      onChange(prefs);
    });

    const voiceSelect = select(
      VOICES.map((v) => ({ value: v, label: VOICE_LABELS[v] || v })),
      prefs.ttsVoice || "茉莉",
      "朗读音色",
      (v) => {
        prefs.ttsVoice = v;
        refresh();
        onChange(prefs);
      }
    );

    const modeSelect = select(
      [
        { value: "paragraph", label: "分段（出声快）" },
        { value: "page", label: "整页（更连贯）" },
      ],
      prefs.ttsGranularity || "paragraph",
      "合成粒度：分段出声快但段间语气可能有细微变化；整页更连贯但首次出声慢",
      (v) => {
        prefs.ttsGranularity = v;
        refresh();
        onChange(prefs);
      }
    );

    const info = doc.createElement("span");
    info.className = "rd-tts-info";

    /**
     * API Key 输入框。
     *
     * 为什么直接放在播放条上而不是藏在设置面板里：这是自用扩展，
     * 填一次就持久化，放明面上比「先找设置入口」少两步操作。
     * 用 type=text 而不是 password——用户需要能核对粘贴的 key 是否正确
     * （key 很长，粘贴错一位很难发现）。
     *
     * 注意：input 上的键盘事件必须 stopPropagation，否则在输入框里
     * 按空格/方向键会被页面截走（表现为「打字没反应」）。
     */
    const keyInput = doc.createElement("input");
    keyInput.type = "text";
    keyInput.className = "rd-tts-key";
    keyInput.placeholder = "MiMo API Key";
    keyInput.title = "小米 MiMo 开放平台的 API Key（sk- 开头）。只保存在本地，不会上传。";
    keyInput.value = prefs.ttsApiKey || "";
    keyInput.setAttribute("autocomplete", "off");
    keyInput.setAttribute("spellcheck", "false");
    // 注意：这个 keydown 监听既要**阻止冒泡**（否则在输入框里按空格/
    // 方向键会被页面截走，表现为「打字没反应」），又要**处理回车**。
    //
    // 曾经把回车单独注册成另一个 keydown 监听，结果永远不触发——
    // 同一元素上的监听按注册顺序执行，先注册的这个 stopPropagation
    // 虽然不会阻止同元素上的其他监听，但两者顺序易错、难以察觉。
    // 合并成一个监听是唯一可靠的做法（实测确认单独注册不工作）。
    keyInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commitKey(true);
        if (onSubmitKey) onSubmitKey();
      }
    });
    keyInput.addEventListener("mousedown", (e) => e.stopPropagation());
    keyInput.addEventListener("click", (e) => e.stopPropagation());

    /**
     * 提交 API Key。
     *
     * ## 为什么同时监听 input / change / blur / Enter（而不是只 change）
     *
     * 曾经只监听 `change`，它**只在元素失焦或按回车时才触发**。
     * 用户粘贴完 key 后直接点播放按钮，某些情况下 change 不会先派发，
     * 于是 key 没被写进 storage —— 表现为「每次都要重新填」。
     *
     * 现在改为：
     *   · `input`  —— 每次输入/粘贴都同步到内存并**立即写盘**（防抖 400ms），
     *                 保证「填了就一定存下来」，不依赖失焦
     *   · `change`/`blur` —— 兜底立即写盘
     *   · `Enter`  —— 顺手开始播放（用户填完 key 的自然动作）
     */
    let keySaveTimer = null;
    const commitKey = (immediate) => {
      const val = String(keyInput.value || "").trim();
      if (prefs.ttsApiKey === val) return;
      prefs.ttsApiKey = val;
      if (onApiKey) onApiKey(val);   // main.js 里立即写盘
      // 兜底：即便调用方没立即写盘，这里也防抖写一次
      if (immediate) {
        clearTimeout(keySaveTimer);
        keySaveTimer = null;
      } else {
        clearTimeout(keySaveTimer);
        keySaveTimer = setTimeout(() => {
          keySaveTimer = null;
          if (onApiKey) onApiKey(prefs.ttsApiKey);
        }, 400);
      }
      refresh();
    };

    keyInput.addEventListener("input", () => commitKey(false));
    keyInput.addEventListener("change", () => commitKey(true));
    keyInput.addEventListener("blur", () => commitKey(true));

    const closeBtn = btn("✕", "退出朗读", () => onClose(), "rd-tts-close");

    // ---------------------------------------------------------- 组装

    bar.append(
      toggleBtn, prevBtn, nextBtn, sep(),
      rateDown, rateLabel, rateUp, sep(),
      voiceSelect, modeSelect, sep(),
      keyInput, sep(),
      info, closeBtn
    );

    // 阻止交互冒泡到页面（否则点播放条会触发页面自己的快捷键/滚动）
    bar.addEventListener("mousedown", (e) => e.stopPropagation());
    bar.addEventListener("keydown", (e) => e.stopPropagation());
    bar.addEventListener("click", (e) => e.stopPropagation());

    // ---------------------------------------------------------- 刷新

    let lastState = null;

    /**
     * 更新播放条显示。
     *
     * @param {object} status { state, cueIndex, cueCount, playedCount,
     *                          reachedEnd, message, chapterTitle, remainingSeconds }
     */
    function refresh(status) {
      const st = (status && status.state) || lastState || "idle";
      lastState = st;
      const label = STATE_LABELS[st] || STATE_LABELS.idle;
      toggleBtn.textContent = label.icon;
      toggleBtn.title = label.text;
      toggleBtn.dataset.state = st;
      toggleBtn.setAttribute("aria-label", label.text);

      // 进度文案：优先显示章节与进度
      const parts = [];
      if (status) {
        if (status.chapterTitle) parts.push(status.chapterTitle);
        if (typeof status.cueCount === "number" && status.cueCount > 0) {
          const cur = Math.min((status.cueIndex >= 0 ? status.cueIndex : status.playedCount) + 1, status.cueCount);
          parts.push(`${cur}/${status.cueCount}`);
        }
        if (status.state === "buffering") parts.push("合成中…");
        if (status.state === "ended") parts.push("已读完");
        if (status.message) parts.push(status.message);
        if (status.reachedEnd && st !== "ended") parts.push("已到末尾");
      }
      info.textContent = parts.join(" · ");
      info.title = parts.join(" · ");

      rateLabel.textContent = `${formatRate(prefs.ttsRate)}×`;
      if (voiceSelect.value !== (prefs.ttsVoice || "茉莉")) {
        voiceSelect.value = prefs.ttsVoice || "茉莉";
      }
      if (modeSelect.value !== (prefs.ttsGranularity || "paragraph")) {
        modeSelect.value = prefs.ttsGranularity || "paragraph";
      }
      // 仅在值真的不同时才写回，否则会打断用户正在输入的内容
      const keyVal = String(prefs.ttsApiKey || "");
      if (keyInput.value !== keyVal && doc.activeElement !== keyInput) {
        keyInput.value = keyVal;
      }
      // 没填 key 时把输入框标红，给出明确的可操作提示
      const noKey = !keyVal;
      keyInput.dataset.missing = String(noKey);

      // 上一条/下一条在「未开始」时禁用
      const idle = st === "idle" || st === "error";
      prevBtn.disabled = idle;
      nextBtn.disabled = idle;
      bar.dataset.state = st;
    }

    function formatRate(r) {
      const n = Number(r);
      if (!Number.isFinite(n)) return "1.0";
      return (Math.round(n * 100) / 100).toFixed(2).replace(/0$/, "");
    }

    /** 语速步进（在 RATES 档位里取相邻值）。 */
    function stepRate(current, dir) {
      const n = Number(current);
      const cur = Number.isFinite(n) ? n : 1;
      // 找到最接近的档位，再移动一步
      let idx = 0;
      let best = Infinity;
      RATES.forEach((r, i) => {
        const d = Math.abs(r - cur);
        if (d < best) { best = d; idx = i; }
      });
      const next = Math.max(0, Math.min(RATES.length - 1, idx + dir));
      return RATES[next];
    }

    /** 设置错误/提示文案（由外部在失败时调用）。 */
    function setMessage(text) {
      info.textContent = text || "";
      info.title = text || "";
    }

    refresh({ state: "idle" });

    return {
      element: bar,
      refresh,
      setMessage,
      /**
       * 立即把输入框当前内容提交出去（取消防抖）。
       *
       * 为什么需要：用户可能**填完 key 直接点 ✕ 关闭**或关掉阅读模式。
       * 此时若还压在 400ms 防抖窗口里，这次输入就丢了——
       * 表现为「每次进来都要重新填 key」。
       * 关闭路径必须先调它。
       */
      flushKey: () => commitKey(true),
      RATES,
      VOICES,
      VOICE_LABELS,
    };
  }

  return { create, VOICES, VOICE_LABELS, RATES, STATE_LABELS };
});
