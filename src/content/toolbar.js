/**
 * toolbar.js — 阅读视图顶部的浮动工具条。
 *
 * 全部控件即时生效：改动偏好 → 回调 → reader-view 更新 CSS 变量 → 持久化。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ReaderToolbar = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const THEME_LABELS = { light: "浅色", sepia: "护眼", dark: "深色" };
  const WIDTH_LABELS = { narrow: "窄", medium: "中", wide: "宽", full: "全宽" };
  const FONT_LABELS = { system: "系统", serif: "衬线", sans: "无衬线" };

  /** 当前工具条实例持有的引用，用于 refresh。 */
  let current = null;

  /**
   * 创建工具条。
   * @param {object} opts
   * @param {object} opts.prefs 初始偏好（会被就地修改）
   * @param {Function} opts.onChange 偏好变化回调，收到完整偏好对象
   * @param {Function} opts.onClose 关闭回调
   * @param {Function} [opts.onToggleClean] 空行清理开关变化
   * @param {Function} [opts.onToggleAutoNext] 自动续页开关变化
   * @param {Function} [opts.onToggleTts] 朗读开关变化
   * @param {object} [opts.cleanStats] 清理统计，用于展示效果
   */
  function create(opts) {
    const prefs = opts.prefs;
    const onChange = opts.onChange || (() => {});
    const onClose = opts.onClose || (() => {});

    const bar = document.createElement("div");
    bar.className = "rd-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "阅读设置");

    // ---------------------------------------------------------- 辅助构造

    const btn = (label, title, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(b);
      });
      return b;
    };

    const sep = () => {
      const s = document.createElement("span");
      s.className = "rd-bar-sep";
      s.setAttribute("aria-hidden", "true");
      return s;
    };

    const numLabel = () => {
      const s = document.createElement("span");
      s.className = "rd-num";
      return s;
    };

    // ---------------------------------------------------------- 主题

    const themeBtn = btn("", "切换主题", () => {
      prefs.theme = nextOf(prefs.theme, ["light", "sepia", "dark"]);
      emit();
    });

    // ---------------------------------------------------------- 字号

    const fontSizeLabel = numLabel();
    const fontDown = btn("A−", "减小字号", () => {
      prefs.fontSize = clampStep("fontSize", prefs.fontSize - 1);
      emit();
    });
    const fontUp = btn("A+", "增大字号", () => {
      prefs.fontSize = clampStep("fontSize", prefs.fontSize + 1);
      emit();
    });

    // ---------------------------------------------------------- 行距

    const lineHeightLabel = numLabel();
    const lhDown = btn("≡−", "减小行距", () => {
      prefs.lineHeight = clampStep("lineHeight", round1(prefs.lineHeight - 0.05));
      emit();
    });
    const lhUp = btn("≡+", "增大行距", () => {
      prefs.lineHeight = clampStep("lineHeight", round1(prefs.lineHeight + 0.05));
      emit();
    });

    // ---------------------------------------------------------- 页宽

    const widthBtn = btn("", "切换页宽", () => {
      prefs.width = nextOf(prefs.width, ["narrow", "medium", "wide", "full"]);
      emit();
    });

    // ---------------------------------------------------------- 字体

    const fontBtn = btn("", "切换字体", () => {
      prefs.fontFamilyKey = nextOf(prefs.fontFamilyKey, ["system", "serif", "sans"]);
      emit();
    });

    // ---------------------------------------------------------- 段距
    // 空行清理之外，段距是「阅读通透感」的第二个旋钮。

    const paraGapLabel = numLabel();
    const gapDown = btn("↕−", "收紧段距", () => {
      prefs.paraGap = clampStep("paraGap", round1(prefs.paraGap - 0.1));
      emit();
    });
    const gapUp = btn("↕+", "放宽段距", () => {
      prefs.paraGap = clampStep("paraGap", round1(prefs.paraGap + 0.1));
      emit();
    });

    // ---------------------------------------------------------- 空行清理开关

    const cleanBtn = btn("", "开关空行清理（需重新进入生效）", () => {
      prefs.cleanBlank = !prefs.cleanBlank;
      emit();
      // 清理是渲染前的一次性 DOM 处理，开关后需要重新提取才能看到差异。
      if (opts.onToggleClean) opts.onToggleClean(prefs.cleanBlank);
    });

    // ---------------------------------------------------------- 自动加载下一章

    const autoNextBtn = btn("", "开关「滚动到底自动加载下一章/下一页」", () => {
      prefs.autoLoadNext = !prefs.autoLoadNext;
      emit();
      // 该开关即时生效，无需重新提取（控制器只需切换 enabled）。
      if (opts.onToggleAutoNext) opts.onToggleAutoNext(prefs.autoLoadNext);
    });

    // ---------------------------------------------------------- 有声朗读
    // 顶部工具条只放「是否启用朗读」这一个开关；真正的播放控制
    // （播放/暂停、上下条、语速、音色、粒度）都在底部的 .rd-tts-bar 里，
    // 避免顶部控件膨胀到换行、挤压正文。

    const ttsBtn = btn("", "开关有声朗读（用小米 MiMo TTS 合成语音）", () => {
      prefs.ttsEnabled = !prefs.ttsEnabled;
      emit();
      // 即时生效：打开则开始朗读，关闭则停止并收起播放条。
      if (opts.onToggleTts) opts.onToggleTts(prefs.ttsEnabled);
    });

    // ---------------------------------------------------------- 关闭

    const closeBtn = btn("✕", "退出阅读模式 (Esc)", onClose);
    closeBtn.classList.add("rd-close");

    // ---------------------------------------------------------- 组装

    bar.append(
      themeBtn, sep(),
      fontDown, fontSizeLabel, fontUp, sep(),
      lhDown, lineHeightLabel, lhUp, sep(),
      gapDown, paraGapLabel, gapUp, sep(),
      widthBtn, fontBtn, sep(),
      cleanBtn, autoNextBtn, ttsBtn, sep(),
      closeBtn
    );

    // ---------------------------------------------------------- 状态刷新

    function refresh(next) {
      const p = next || prefs;
      themeBtn.textContent = THEME_LABELS[p.theme] || p.theme;
      fontSizeLabel.textContent = `${p.fontSize}px`;
      lineHeightLabel.textContent = p.lineHeight.toFixed(2);
      paraGapLabel.textContent = p.paraGap.toFixed(1);
      widthBtn.textContent = `宽 ${WIDTH_LABELS[p.width] || p.width}`;
      fontBtn.textContent = FONT_LABELS[p.fontFamilyKey] || p.fontFamilyKey;
      // 文案尽量短：工具条变高会挤压正文（顶部留白随之增大）。
      // 状态用符号 + aria-pressed 表达，完整含义放在 title。
      cleanBtn.textContent = p.cleanBlank ? "空行 ✓" : "空行 ✗";
      cleanBtn.title = p.cleanBlank
        ? "已开启空行清理（点击关闭，需重新进入阅读模式生效）"
        : "已关闭空行清理（点击开启，需重新进入阅读模式生效）";
      cleanBtn.setAttribute("aria-pressed", String(!!p.cleanBlank));

      autoNextBtn.textContent = p.autoLoadNext ? "续页 ✓" : "续页 ✗";
      autoNextBtn.title = p.autoLoadNext
        ? "已开启自动续页：滚动到底会自动加载下一章/下一页（点击关闭）"
        : "已关闭自动续页：滚动到底不会自动加载（点击开启）";
      autoNextBtn.setAttribute("aria-pressed", String(!!p.autoLoadNext));

      // 朗读开关。文案用「听书」二字，比「朗读」更能表达这是长时间收听。
      ttsBtn.textContent = p.ttsEnabled ? "听书 ✓" : "听书 ✗";
      ttsBtn.title = p.ttsEnabled
        ? "已开启有声朗读（点击停止并收起播放条）"
        : "开启有声朗读：用小米 MiMo TTS 把正文合成语音（需先填 API Key）";
      ttsBtn.setAttribute("aria-pressed", String(!!p.ttsEnabled));
    }

    function emit() {
      refresh();
      onChange(prefs);
    }

    // --- 工具函数

    function nextOf(value, list) {
      const i = list.indexOf(value);
      return list[(i + 1) % list.length];
    }

    function clampStep(key, value) {
      const P = root.ReaderPrefs;
      const range = (P && P.LIMITS && P.LIMITS[key]) || null;
      const n = round1(value);
      if (!range) return n;
      return Math.min(range[1], Math.max(range[0], n));
    }

    function round1(n) {
      return Math.round(n * 100) / 100;
    }

    // 阻止工具条上的交互冒泡到页面。
    bar.addEventListener("mousedown", (e) => e.stopPropagation());
    bar.addEventListener("keydown", (e) => e.stopPropagation());

    refresh();
    current = { element: bar, refresh };

    // 展示清理效果。文案保持极简（工具条变高会挤压正文），
    // 详细信息放到 title 里，鼠标悬停可见。
    const stats = opts.cleanStats;
    if (stats && stats.removed > 0) {
      const hint = document.createElement("span");
      hint.className = "rd-label";
      hint.textContent = `清除 ${stats.removed} 处`;
      hint.title =
        `已清除空白行 ${stats.removed} 处\n` +
        `· 空元素 ${stats.reasons.empty} 个\n` +
        `· 连续换行 ${stats.reasons.br} 处\n` +
        `· 首尾留白 ${stats.reasons.edges} 处\n` +
        `· 注释/脚本 ${stats.reasons.invisible} 处`;
      bar.insertBefore(hint, bar.firstChild);
    }

    return bar;
  }

  /** 刷新当前工具条。 */
  function refresh(prefs) {
    if (current && current.refresh) current.refresh(prefs);
  }

  return { create, refresh, THEME_LABELS, WIDTH_LABELS, FONT_LABELS };
});
