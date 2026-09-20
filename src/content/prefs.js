/**
 * prefs.js — 用户偏好读写。
 *
 * 存储在 browser.storage.local；读取失败（如临时加载、无权限）时回退到默认值，
 * 保证阅读模式永远可用。
 */
(function (root) {
  "use strict";

  const THEME_CYCLE = ["light", "sepia", "dark"];
  const WIDTH_CYCLE = ["narrow", "medium", "wide", "full"];

  const FONT_STACKS = {
    system: 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    serif: 'Georgia, "Times New Roman", "Songti SC", "Noto Serif SC", SimSun, serif',
    sans: '"Helvetica Neue", Helvetica, Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  };

  const DEFAULTS = {
    theme: "light",
    width: "medium",
    fontSize: 19,
    lineHeight: 1.85,
    paraGap: 0.9,
    fontFamilyKey: "system",
    cleanBlank: true,
    // 滚动到底自动加载下一章/下一页。默认开启——这正是本扩展面向长文阅读的核心便利。
    autoLoadNext: true,
    // 由 normalize 按 fontFamilyKey 派生，此处给出默认值以便直接使用 DEFAULTS。
    fontFamily: FONT_STACKS.system,
  };

  const LIMITS = {
    fontSize: [14, 30],
    lineHeight: [1.3, 2.6],
    paraGap: [0.1, 2.4],
  };

  const STORAGE_KEY = "readerPrefs";

  /** 兼容 Firefox(browser) 与 Chrome(chrome)。 */
  function api() {
    return (typeof browser !== "undefined" && browser.storage)
      ? browser
      : (typeof chrome !== "undefined" && chrome.storage ? chrome : null);
  }

  function clamp(key, value) {
    const range = LIMITS[key];
    if (!range) return value;
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULTS[key];
    return Math.min(range[1], Math.max(range[0], n));
  }

  /** 把任意来源的对象规整成合法偏好。 */
  function normalize(raw) {
    const out = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== "object") {
      out.fontFamily = FONT_STACKS[out.fontFamilyKey];
      return out;
    }

    if (THEME_CYCLE.includes(raw.theme)) out.theme = raw.theme;
    if (WIDTH_CYCLE.includes(raw.width)) out.width = raw.width;
    if (raw.fontFamilyKey in FONT_STACKS) out.fontFamilyKey = raw.fontFamilyKey;
    out.fontSize = clamp("fontSize", raw.fontSize);
    out.lineHeight = clamp("lineHeight", raw.lineHeight);
    out.paraGap = clamp("paraGap", raw.paraGap);
    out.cleanBlank = raw.cleanBlank !== false;
    // 布尔偏好统一遵循「只认显式 false」的范式，非法值一律回退为 true。
    out.autoLoadNext = raw.autoLoadNext !== false;

    // 派生出可直接用于 CSS 的字体栈。
    // 必须在这里解析：偏好里只存 fontFamilyKey（可枚举、可校验），
    // 而消费者（styles.js）需要的是完整 font-family 值。
    // 曾经让消费者直接读 prefs.fontFamily，而该字段从未被赋值，
    // 结果 CSS 里被写成 font-family: undefined，字体设置静默失效。
    out.fontFamily = FONT_STACKS[out.fontFamilyKey];
    return out;
  }

  /**
   * 读取偏好（带默认值兜底）。
   *
   * 注意：偏好 → CSS 的转换统一由 styles.hostInlineStyle 负责，
   * 不在这里再维护一份（曾因两处各写一套「变量名 → 属性」的映射而产生分歧）。
   */
  async function load() {
    const a = api();
    if (!a || !a.storage || !a.storage.local) return Object.assign({}, DEFAULTS);
    try {
      const got = await a.storage.local.get(STORAGE_KEY);
      return normalize(got && got[STORAGE_KEY]);
    } catch (_) {
      return Object.assign({}, DEFAULTS);
    }
  }

  /** 保存偏好（静默失败，不影响阅读）。 */
  async function save(prefs) {
    const a = api();
    if (!a || !a.storage || !a.storage.local) return;
    try {
      await a.storage.local.set({ [STORAGE_KEY]: normalize(prefs) });
    } catch (_) {
      /* 存储不可用时忽略：用户本次的设置仍然生效 */
    }
  }

  /** 循环切换到下一个主题。 */
  function nextTheme(current) {
    const i = THEME_CYCLE.indexOf(current);
    return THEME_CYCLE[(i + 1) % THEME_CYCLE.length];
  }

  /** 循环切换到下一个页宽。 */
  function nextWidth(current) {
    const i = WIDTH_CYCLE.indexOf(current);
    return WIDTH_CYCLE[(i + 1) % WIDTH_CYCLE.length];
  }

  const apiObj = {
    DEFAULTS,
    LIMITS,
    THEME_CYCLE,
    WIDTH_CYCLE,
    FONT_STACKS,
    STORAGE_KEY,
    normalize,
    clamp,
    load,
    save,
    nextTheme,
    nextWidth,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = apiObj;
  } else {
    root.ReaderPrefs = apiObj;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
