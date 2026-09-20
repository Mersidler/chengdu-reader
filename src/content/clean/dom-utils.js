/**
 * dom-utils.js — 空行清理所需的 DOM 判定与遍历工具。
 *
 * 同时支持两种运行环境：
 *   - Firefox content script：普通脚本，挂到 globalThis.CleanDomUtils
 *   - Node + jsdom 单元测试：CommonJS 导出
 *
 * 本文件不含任何副作用，全部为纯函数。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  } else {
    root.CleanDomUtils = mod;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---------------------------------------------------------------- 常量表

  /** 块级标签：用于判断空白文本节点是否有渲染意义。 */
  const BLOCK_TAGS = new Set([
    "address", "article", "aside", "blockquote", "caption", "center", "dd",
    "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption",
    "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hgroup", "hr", "li", "main", "menu", "nav", "ol", "p", "pre", "section",
    "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  ]);

  /**
   * 有视觉含义的标签：包含任意一个就绝不能被判定为「空」。
   * 注意包含 hr（分隔线是作者的有意表达）与 table（表格结构）。
   */
  const MEANINGFUL_TAGS = new Set([
    "img", "picture", "video", "audio", "iframe", "canvas", "svg", "object",
    "embed", "table", "hr", "math", "input", "select", "textarea", "button",
    "progress", "meter", "map", "area",
  ]);

  /** 绝不能进入的子树：空白在此处有意义。 */
  const SKIP_SUBTREE_TAGS = new Set(["pre", "code", "textarea", "script", "style", "template", "svg"]);

  /** 表格结构：删空单元格会破坏布局，整表跳过「空元素」删除。 */
  const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col", "caption"]);

  /** 链接保留：`<a name>` / `<a id>` 可能是文内锚点，删掉会断掉目录跳转。 */
  const KEEP_IF_ANCHOR = new Set(["a"]);

  /** 不可见字符（零宽 / BOM）。 */
  const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u2060\ufeff]/g;

  /** 非空白字符（用于判空）。\s 已覆盖 \u00a0 与各类 Unicode 空格。 */
  const NON_BLANK_RE = /[^\s\u200b\u200c\u200d\u2060\ufeff]/;

  /**
   * 一律整棵删除的标签。
   *
   * 只收录「可执行或会主动加载外部资源」的元素。刻意不含：
   *  - svg / math：它们有视觉价值（图标、公式），且其中的 <script> 会被
   *    下面的 script 规则单独清除，无需整棵删掉；
   *  - 表单控件（input/button/textarea…）：不能执行代码，且 textarea 里的
   *    空白有内容意义，删掉会误伤。
   */
  const DANGEROUS_TAGS = new Set([
    "script", "style", "iframe", "frame", "frameset", "object", "embed",
    "applet", "base", "meta", "link", "template",
  ]);

  /**
   * 危险 URL 协议前缀。
   * 注意：`javascript:` 是经典 XSS 向量；`data:` 在 img src 上是图片，
   * 但在 a href 上可以配合 download 造成钓鱼，故也过滤（图片 data URL 由
   * 单独的图片属性白名单放行）。
   */
  const DANGEROUS_URL_RE = /^\s*(javascript|vbscript|data:text\/html|data:application\/xhtml)/i;

  // ---------------------------------------------------------------- 基础判定

  /** 元素标签名（小写）。 */
  function tagOf(node) {
    return node && node.nodeType === 1 ? node.localName : null;
  }

  /** 文本是否「视觉上为空白」（含 &nbsp;、零宽字符、全角空格）。 */
  function isBlankText(text) {
    if (!text) return true;
    return !NON_BLANK_RE.test(text);
  }

  /** 该元素是否位于某个「空白有意义」的子树内（pre / code / textarea …）。 */
  function isInSkipSubtree(node) {
    let cur = node;
    while (cur && cur.nodeType === 1) {
      if (SKIP_SUBTREE_TAGS.has(cur.localName)) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  /** 该元素是否是表格结构的一部分。 */
  function isInTable(node) {
    let cur = node;
    while (cur && cur.nodeType === 1) {
      if (TABLE_TAGS.has(cur.localName)) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  /**
   * 子树中是否含有「有视觉含义」的元素。
   * 同时检查传入节点自身：`<hr>`、`<img>` 这类空元素没有后代，
   * 只看后代会把它们误判成空。
   */
  function containsMeaningful(node) {
    if (node.nodeType === 1 && MEANINGFUL_TAGS.has(node.localName)) return true;
    if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return false;
    const all = node.querySelectorAll ? node.querySelectorAll("*") : [];
    for (const el of all) {
      if (MEANINGFUL_TAGS.has(el.localName)) return true;
    }
    return false;
  }

  /** 元素是否带锚点身份（不应被当作空元素删除）。 */
  function isAnchorTarget(el) {
    const tag = el.localName;
    if (KEEP_IF_ANCHOR.has(tag) && (el.hasAttribute("name") || el.hasAttribute("id") || el.hasAttribute("href"))) {
      return true;
    }
    return el.hasAttribute("id") || el.hasAttribute("name");
  }

  // ---------------------------------------------------------------- 样式探测

  /**
   * 默认样式探测器。浏览器中读取计算样式；环境不支持时退化为读内联样式。
   * 返回值只需包含我们关心的字段，便于测试注入桩函数。
   */
  function defaultStyleProbe(el) {
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    let cs = null;
    if (view && typeof view.getComputedStyle === "function") {
      try {
        cs = view.getComputedStyle(el);
      } catch (_) {
        cs = null;
      }
    }
    if (cs) {
      return {
        backgroundImage: cs.backgroundImage || "none",
        borderTopWidth: cs.borderTopWidth || "0px",
        borderBottomWidth: cs.borderBottomWidth || "0px",
        borderLeftWidth: cs.borderLeftWidth || "0px",
        borderRightWidth: cs.borderRightWidth || "0px",
        borderTopStyle: cs.borderTopStyle || "none",
        borderBottomStyle: cs.borderBottomStyle || "none",
        marginTop: cs.marginTop || "0px",
        marginBottom: cs.marginBottom || "0px",
        paddingTop: cs.paddingTop || "0px",
        paddingBottom: cs.paddingBottom || "0px",
      };
    }
    const inline = el.style || {};
    return {
      backgroundImage: inline.backgroundImage || "none",
      borderTopWidth: inline.borderTopWidth || "0px",
      borderBottomWidth: inline.borderBottomWidth || "0px",
      borderLeftWidth: inline.borderLeftWidth || "0px",
      borderRightWidth: inline.borderRightWidth || "0px",
      borderTopStyle: inline.borderTopStyle || "none",
      borderBottomStyle: inline.borderBottomStyle || "none",
      marginTop: inline.marginTop || "0px",
      marginBottom: inline.marginBottom || "0px",
      paddingTop: inline.paddingTop || "0px",
      paddingBottom: inline.paddingBottom || "0px",
    };
  }

  /**
   * 仅基于内联 style 属性探测。
   *
   * 为什么阅读管线要用这个而不是 getComputedStyle：
   * 正文最终渲染在我们的 Shadow DOM 里，页面自身的 CSS（包括选择器带来的
   * background-image / border 等）根本不会生效。若按原页面的计算样式判断
   * 「这个空块是否装饰性显著」，会把一堆渲染后其实什么都没有的元素保留下来。
   * 只有内联样式会随元素一起进入阅读视图，所以以它为准才与最终观感一致。
   */
  function inlineStyleProbe(el) {
    const s = (el && el.style) || {};
    const get = (k, d) => (s[k] || d);
    return {
      backgroundImage: get("backgroundImage", "none"),
      borderTopWidth: get("borderTopWidth", "0px"),
      borderBottomWidth: get("borderBottomWidth", "0px"),
      borderLeftWidth: get("borderLeftWidth", "0px"),
      borderRightWidth: get("borderRightWidth", "0px"),
      borderTopStyle: get("borderTopStyle", "none"),
      borderBottomStyle: get("borderBottomStyle", "none"),
      marginTop: get("marginTop", "0px"),
      marginBottom: get("marginBottom", "0px"),
      paddingTop: get("paddingTop", "0px"),
      paddingBottom: get("paddingBottom", "0px"),
    };
  }

  /** 把 "12.5px" 解析为数字；解析失败返回 0。 */
  function px(value) {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return 0;
    const m = /^(-?[\d.]+)px$/.exec(value.trim());
    return m ? parseFloat(m[1]) : 0;
  }

  /** 是否有可见边框。 */
  function hasVisibleBorder(s) {
    const pairs = [
      [s.borderTopWidth, s.borderTopStyle],
      [s.borderBottomWidth, s.borderBottomStyle],
    ];
    for (const [w, style] of pairs) {
      if (style && style !== "none" && style !== "hidden" && px(w) > 0) return true;
    }
    // 左右边框在文本流里几乎不产生新的「行」，但装饰性卡片会，故一并计入。
    if (px(s.borderLeftWidth) > 0 || px(s.borderRightWidth) > 0) return true;
    return false;
  }

  /**
   * 元素是否「视觉上显著」——即虽然不含文字，但有可见表现。
   * 用于保护装饰性分隔图案、带背景图的块，避免误删。
   */
  function isVisuallySignificant(el, styleProbe) {
    const probe = styleProbe || defaultStyleProbe;
    let s;
    try {
      s = probe(el);
    } catch (_) {
      return false;
    }
    if (!s) return false;

    const bg = String(s.backgroundImage || "none").trim();
    if (bg && bg !== "none" && !/^url\((["']?)\)?$/.test(bg)) return true;

    if (hasVisibleBorder(s)) return true;

    return false;
  }

  // ---------------------------------------------------------------- 遍历

  /** 收集子树中所有元素（用于自底向上处理）。 */
  function collectElements(root) {
    const out = [];
    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) {
          out.push(child);
          walk(child);
        }
      }
    };
    walk(root);
    return out;
  }

  // ---------------------------------------------------------------- 安全净化

  /**
   * 判断属性名是否为内联事件处理器（onclick / onerror / onload …）。
   */
  function isEventHandlerAttr(name) {
    return /^on/i.test(name);
  }

  /** 判断 URL 值是否指向危险协议。 */
  function isDangerousUrl(value) {
    if (!value) return false;
    // 去掉控制字符后再判断，避免 `java\tscript:` 这类绕过。
    const cleaned = String(value).replace(/[\u0000-\u0020]/g, "");
    return DANGEROUS_URL_RE.test(cleaned);
  }

  /**
   * 就地净化一棵 DOM 子树，移除所有可执行内容。
   *
   * 为什么必须做：Readability **不会**剥离 `on*` 内联事件属性，
   * 而阅读视图是挂到页面 DOM 上的。若正文里带有 `<img onerror=...>`，
   * 在阅读模式下就会真实执行——恶意页面或已被注入广告脚本的页面都能触发。
   *
   * @returns {{tags:number, attrs:number, urls:number}} 各类清理计数
   */
  function sanitize(root) {
    const stats = { tags: 0, attrs: 0, urls: 0 };
    if (!root) return stats;

    // 危险标签：整棵移除。
    for (const tag of DANGEROUS_TAGS) {
      const found = root.querySelectorAll ? root.querySelectorAll(tag) : [];
      for (const el of found) {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
          stats.tags++;
        }
      }
    }

    // 属性层面净化。
    for (const el of collectElements(root)) {
      const attrs = [...el.attributes];
      for (const attr of attrs) {
        const name = attr.name;

        // 1) 内联事件处理器：无条件移除（这是最主要的 XSS 面）。
        if (isEventHandlerAttr(name)) {
          el.removeAttribute(name);
          stats.attrs++;
          continue;
        }

        // 2) 危险协议 URL。
        const isUrlAttr = name === "href" || name === "src" || name === "xlink:href"
          || name === "action" || name === "formaction" || name === "data"
          || name === "poster" || name === "srcdoc";
        if (isUrlAttr && isDangerousUrl(attr.value)) {
          el.removeAttribute(name);
          stats.urls++;
          continue;
        }

        // 3) srcdoc 内联文档：直接移除，避免其中嵌套可执行内容。
        if (name === "srcdoc") {
          el.removeAttribute(name);
          stats.attrs++;
          continue;
        }

        // 4) 不安全的 target 值：_top/_parent 会把阅读视图上级窗口导航走。
        if (name === "target" && (attr.value === "_top" || attr.value === "_parent")) {
          el.setAttribute("target", "_blank");
          stats.attrs++;
        }
      }
    }

    return stats;
  }

  return {
    BLOCK_TAGS,
    MEANINGFUL_TAGS,
    SKIP_SUBTREE_TAGS,
    TABLE_TAGS,
    DANGEROUS_TAGS,
    ZERO_WIDTH_RE,
    NON_BLANK_RE,

    tagOf,
    isBlankText,
    isInSkipSubtree,
    isInTable,
    containsMeaningful,
    isAnchorTarget,
    defaultStyleProbe,
    inlineStyleProbe,
    px,
    hasVisibleBorder,
    isVisuallySignificant,
    collectElements,
    sanitize,
    isEventHandlerAttr,
    isDangerousUrl,
  };
});
