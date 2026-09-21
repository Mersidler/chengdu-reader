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

    // ---- 有声朗读 ----
    /**
     * 小米 MiMo 的 API Key。**默认为空**：不在代码里硬编码任何密钥，
     * 用户在播放条里自行填写并存在本地 storage。
     *
     * 为什么不预置：扩展包是明文可读的，硬编码的 key 会被任何拿到扩展的人
     * 提取滥用。空值时朗读入口会提示「请先填写 API Key」。
     */
    ttsApiKey: "",
    /** 音色（与 background.js 的 TTS_SUPPORTED_VOICES 保持一致）。 */
    ttsVoice: "茉莉",
    /** 播放语速。Web Audio 的 playbackRate 会同时改变音调（原生无变速不变调）。 */
    ttsRate: 1,
    /**
     * 合成粒度：
     *   paragraph — 分段合成，首句出声快，但段间语气可能有细微跳变（默认）
     *   page      — 整页合成，语气连贯，但首次出声慢
     */
    ttsGranularity: "paragraph",
    /** 是否启用朗读功能（顶部工具条的开关）。 */
    ttsEnabled: false,
    /** 是否记住朗读进度并在下次打开该页时从上次位置继续。 */
    ttsResume: true,
  };

  const LIMITS = {
    fontSize: [14, 30],
    lineHeight: [1.3, 2.6],
    paraGap: [0.1, 2.4],
    // 语速上限取 2：再快音调失真严重（Web Audio 的硬限制），体验反而更差。
    ttsRate: [0.5, 2],
  };

  /** 合成粒度白名单。 */
  const TTS_GRANULARITIES = ["paragraph", "page"];

  /** 音色白名单（与 background.js 的 TTS_SUPPORTED_VOICES 一致）。 */
  const TTS_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];

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
    // 朗读的布尔项中，ttsEnabled 是「用户主动开启」的开关，默认关闭，
    // 因此它不适用「只认显式 false」——这里只认显式 true。
    out.ttsEnabled = raw.ttsEnabled === true;
    out.ttsResume = raw.ttsResume !== false;

    // 字符串偏好：只认非空字符串，否则回退默认值。
    // API Key 尤其不能用「非空即合法」以外的方式处理（不能 trim 掉内容）。
    if (typeof raw.ttsApiKey === "string") out.ttsApiKey = raw.ttsApiKey.trim();
    if (TTS_VOICES.indexOf(raw.ttsVoice) >= 0) out.ttsVoice = raw.ttsVoice;
    if (TTS_GRANULARITIES.indexOf(raw.ttsGranularity) >= 0) {
      out.ttsGranularity = raw.ttsGranularity;
    }
    out.ttsRate = clamp("ttsRate", raw.ttsRate);

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
    TTS_GRANULARITIES,
    TTS_VOICES,
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
