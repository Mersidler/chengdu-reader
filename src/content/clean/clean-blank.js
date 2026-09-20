/**
 * clean-blank.js — 阅读模式正文的「空白行清理」核心管线。
 *
 * 设计原则
 * --------
 * 1. 纯函数：输入一个 DOM 根节点，就地修改并返回统计。不依赖 document/window 全局，
 *    因此可以在 Node + jsdom 下完整回归测试。
 * 2. 样式探测依赖注入：浏览器与测试环境对「元素是否视觉显著」的判断依据不同，
 *    通过 opts.styleProbe 注入，默认使用「仅内联样式」探测（与阅读视图观感一致）。
 * 3. 幂等：连续执行两次的结果必须与执行一次相同。这是硬性验收项。
 *
 * 空白的两个来源，分层解决
 * ------------------------
 *   A. 真正空的元素（<p></p> / <p><br></p> / <p>&nbsp;</p> / 连排 <br> / 空 div）
 *      → 直接从 DOM 删除（步骤 1、4、5、6）
 *   B. 作者内联样式造成的大间距（margin:60px 0 / padding）
 *      → 剥离垂直方向样式（步骤 2），垂直节奏改由阅读视图 CSS 统一接管
 *
 * 处理顺序（每一步都可独立测试）
 * -----------------------------
 *   0. sanitize              净化：移除 script/iframe 与 on* 事件属性、危险协议 URL
 *   1. stripInvisible        移除注释 / script / style / noscript / aria-hidden
 *   2. normalizeInlineStyles 剥离垂直 margin/padding、font-size、color
 *   3. normalizeWhitespace   nbsp→空格、合并连续空格、trim（跳过 pre/code）
 *   4. collapseBrRuns        3+ 连续 <br> 压到 2；块级元素首尾孤立 <br> 删除
 *   5. removeEmptyBlocks     自底向上删除「视觉上为空」的块级元素
 *   6. trimEdges             删除根节点首尾的空块
 *   7. unwrapDivs            拆掉纯容器 div（剥离站点布局残留的间距）
 */
(function (root, factory) {
  const utils = typeof module === "object" && module.exports
    ? require("./dom-utils.js")
    : root.CleanDomUtils;
  const mod = factory(utils);
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  } else {
    root.CleanBlank = mod;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (U) {
  "use strict";

  const { ZERO_WIDTH_RE, NON_BLANK_RE } = U;

  /** 默认配置（均衡模式）。 */
  const DEFAULTS = {
    /** 是否启用管线（工具条上的「空行清理」开关）。 */
    enabled: true,
    /** 垂直 padding 超过该值才剥离，避免动到按钮/标签那类小内边距。 */
    paddingStripThreshold: 24,
    /** 连续 <br> 折叠后的上限。 */
    maxBrRun: 2,
    /** 是否剥离内联 font-size / color（让排版设置完全接管）。 */
    stripTextStyles: true,
    /** 是否拆掉纯容器 div。 */
    unwrapContainers: true,
    /** 样式探测器，见 dom-utils.inlineStyleProbe。 */
    styleProbe: U.inlineStyleProbe,
    /** 是否执行安全净化（移除 on* 事件、危险协议、可执行标签）。 */
    sanitize: true,
  };

  // ================================================================ 步骤 1

  const INVISIBLE_TAGS = new Set(["script", "style", "noscript", "link", "meta", "title", "template"]);

  /** 移除注释节点、残留的 script/style、以及 aria-hidden 元素。 */
  function stripInvisible(root) {
    let removed = 0;

    const walk = (node) => {
      // 先收集再删除，避免在遍历过程中改动兄弟指针。
      const toRemove = [];
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 8) {
          toRemove.push({ node: child, kind: "comment" });
        } else if (child.nodeType === 1) {
          if (INVISIBLE_TAGS.has(child.localName)) {
            toRemove.push({ node: child, kind: "invisible-tag" });
          } else if (child.getAttribute("aria-hidden") === "true") {
            toRemove.push({ node: child, kind: "aria-hidden" });
          } else {
            walk(child);
          }
        }
      }
      for (const { node: n } of toRemove) {
        if (n.parentNode) n.parentNode.removeChild(n);
        removed++;
      }
    };

    walk(root);
    return { removed };
  }

  // ================================================================ 步骤 2

  /** 垂直方向、会制造空白行的属性（kebab-case）。 */
  const VERTICAL_MARGIN_PROPS = new Set([
    "margin-top", "margin-bottom", "margin-block-start", "margin-block-end",
  ]);
  const VERTICAL_PADDING_PROPS = new Set([
    "padding-top", "padding-bottom", "padding-block-start", "padding-block-end",
  ]);

  /**
   * 剥离会制造「空白行」的内联样式。
   *
   * 实现方式：直接文本重写 style 属性，而不是走 CSSOM 的 longhand API。
   * 原因：各引擎（尤其 jsdom）的 shorthand/longhand 交互是有损的——
   * `removeProperty("margin-top")` 之后 shorthand 的序列化结果可能原样不变，
   * 导致「残余 0px 声明」与「不幂等」。文本重写是确定性的，两个环境行为一致。
   *
   * 处理规则：
   * - 垂直 margin：无条件移除。垂直节奏完全由阅读视图 CSS 决定，
   *   这是消除「作者写了 margin:60px 0 造成大段空白」的关键一步。
   * - 垂直 padding：仅在超过阈值时移除，保留小内边距的呼吸感。
   * - font-size / line-height / color：移除，让字号与主题设置完全接管
   *   （color 即使在 pre/code 内也移除，否则暗色主题下代码会变成黑字不可读）。
   * - font-family：移除，但 pre/code 子树内保留（不能毁掉等宽字体）。
   */
  function normalizeInlineStyles(root, opts) {
    let stripped = 0;

    for (const el of U.collectElements(root)) {
      const raw = el.getAttribute("style");
      if (!raw || !raw.trim()) continue;

      const inSkip = U.isInSkipSubtree(el);
      const { declarations } = parseStyleAttribute(raw);
      const kept = [];
      let touched = false;

      for (const { prop, value } of declarations) {
        const p = prop.toLowerCase();

        // ---- 垂直 margin：无条件丢弃
        if (VERTICAL_MARGIN_PROPS.has(p)) {
          touched = true;
          continue;
        }

        // ---- 垂直 padding：超过阈值才丢弃
        if (VERTICAL_PADDING_PROPS.has(p)) {
          if (U.px(stripImportant(value)) > opts.paddingStripThreshold) {
            touched = true;
            continue;
          }
          kept.push({ prop, value });
          continue;
        }

        // ---- margin 简写：丢掉垂直分量，水平分量改写为 longhand。
        // 关键：不能用两值简写来回写（"0 0" 会被重新解析为「垂直 0」而无法收敛），
        // 必须展开成 margin-left / margin-right 才无歧义、才幂等。
        if (p === "margin" && !inSkip) {
          const bare = stripImportant(value);
          const horiz = shorthandHorizontal(bare);
          if (horiz !== null) {
            touched = true;
            if (!isZeroValue(horiz.left)) {
              kept.push({ prop: "margin-left", value: horiz.left });
            }
            if (!isZeroValue(horiz.right)) {
              kept.push({ prop: "margin-right", value: horiz.right });
            }
            continue;
          }
          kept.push({ prop, value });
          continue;
        }

        // ---- padding 简写：垂直分量超阈值时改写为水平 longhand。
        if (p === "padding" && !inSkip) {
          const bare = stripImportant(value);
          if (verticalComponentOfShorthand(bare) > opts.paddingStripThreshold) {
            const horiz = shorthandHorizontal(bare);
            if (horiz !== null) {
              touched = true;
              if (!isZeroValue(horiz.left)) {
                kept.push({ prop: "padding-left", value: horiz.left });
              }
              if (!isZeroValue(horiz.right)) {
                kept.push({ prop: "padding-right", value: horiz.right });
              }
              continue;
            }
          }
          kept.push({ prop, value });
          continue;
        }

        // ---- 文字样式：交给阅读设置接管
        if (opts.stripTextStyles) {
          const isTextProp = p === "font-size" || p === "line-height" || p === "color";
          const isFontFamily = p === "font-family";
          if (isTextProp || (isFontFamily && !inSkip)) {
            touched = true;
            continue;
          }
        }

        kept.push({ prop, value });
      }

      if (!touched) continue;
      stripped++;

      if (kept.length === 0) {
        el.removeAttribute("style");
      } else {
        el.setAttribute("style", kept.map((d) => `${d.prop}: ${d.value}`).join("; "));
      }
    }

    return { stripped };
  }

  /** 去掉值尾部的 !important，用于数值解析。 */
  function stripImportant(value) {
    return String(value).replace(/!\s*important\s*$/i, "").trim();
  }

  /**
   * 解析 style 属性文本为声明列表。
   * 尊重引号与括号，避免把 `url(a;b)` 或 `content: ";"` 里的分号误当分隔符。
   */
  function parseStyleAttribute(text) {
    const declarations = [];
    let depth = 0;
    let quote = null;
    let buf = "";

    const flush = () => {
      const chunk = buf.trim();
      buf = "";
      if (!chunk) return;
      const idx = chunk.indexOf(":");
      if (idx === -1) return;
      const prop = chunk.slice(0, idx).trim();
      const value = chunk.slice(idx + 1).trim();
      if (prop && value) declarations.push({ prop, value });
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") { buf += ch + (text[++i] || ""); continue; }
        if (ch === quote) quote = null;
        buf += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === ";" && depth === 0) { flush(); continue; }
      buf += ch;
    }
    flush();

    return { declarations };
  }

  /**
   * 取出 margin/padding 简写中的水平分量（左、右）。
   *
   *   "60px 0"              → {left: 0, right: 0}
   *   "10px 20px"           → {left: 20, right: 20}
   *   "10px 20px 30px"      → {left: 20, right: 20}
   *   "10px 20px 30px 40px" → {left: 20, right: 40}
   *   "10px"                → {left: 0, right: 0}   （单值即垂直值）
   *
   * 含 auto / % / calc / var 时返回 null（无法静态解析，保持原样）。
   */
  function shorthandHorizontal(value) {
    const v = String(value).trim();
    if (!v) return null;
    if (/auto|calc|var\(|%/.test(v)) return null;

    const parts = v.split(/\s+/);
    if (parts.length === 1) return { left: 0, right: 0 };
    if (parts.length === 2 || parts.length === 3) {
      return { left: parts[1], right: parts[1] };
    }
    return { left: parts[1], right: parts[3] };
  }

  /** 水平分量是否完全为零。 */
  function isZeroValue(v) {
    return U.px(v) === 0;
  }

  /** 取 padding 简写中垂直分量的像素值（用于阈值判断）。 */
  function verticalComponentOfShorthand(value) {
    const v = String(value).trim();
    if (!v || /auto|calc|var\(/.test(v)) return 0;
    const parts = v.split(/\s+/);
    const top = U.px(parts[0]);
    return top;
  }

  // ================================================================ 步骤 3

  /**
   * 归一化文本空白：nbsp→普通空格、压缩连续空格、去首尾空白。
   * `pre` / `code` / `textarea` 子树完全跳过（空白在此处是内容）。
   */
  function normalizeWhitespace(root) {
    let changed = 0;

    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const text = child.nodeValue;
          let next = text.replace(ZERO_WIDTH_RE, "");
          next = next.replace(/\u00a0/g, " ");
          // 压缩连续空白，但保留单个换行（避免把词粘在一起）。
          next = next.replace(/[ \t\r\n]+/g, " ");
          if (next !== text) {
            child.nodeValue = next;
            changed++;
          }
        } else if (child.nodeType === 1) {
          if (U.SKIP_SUBTREE_TAGS.has(child.localName)) continue;
          walk(child);
        }
      }
    };

    walk(root);

    // 单独一趟做「块边界 trim」：块级元素内首尾的空格没有排版意义。
    for (const el of U.collectElements(root)) {
      if (U.SKIP_SUBTREE_TAGS.has(el.localName)) continue;
      trimEdgeTextNodes(el);
    }

    return { changed };
  }

  /** 去掉元素内部首尾文本节点的空白（不跨元素）。 */
  function trimEdgeTextNodes(el) {
    let first = el.firstChild;
    if (first && first.nodeType === 3) {
      const trimmed = first.nodeValue.replace(/^[ \t\r\n]+/, "");
      if (trimmed !== first.nodeValue) {
        first.nodeValue = trimmed;
        if (!trimmed) first.parentNode.removeChild(first);
      }
    }
    let last = el.lastChild;
    if (last && last.nodeType === 3) {
      const trimmed = last.nodeValue.replace(/[ \t\r\n]+$/, "");
      if (trimmed !== last.nodeValue) {
        last.nodeValue = trimmed;
        if (!trimmed) last.parentNode.removeChild(last);
      }
    }
  }

  // ================================================================ 步骤 4

  /**
   * 折叠连续 <br>：超过 maxBrRun 的压到上限。
   * 同时删除块级元素首尾的孤立 <br>（它们只会在渲染时制造空行）。
   * 注意首尾 <br> 的删除是安全且幂等的，因为缩进用的空白已被步骤 3 归一。
   */
  function collapseBrRuns(root, opts) {
    let collapsed = 0;

    // 4a. 连续 <br> 折叠。br 之间若只有空白文本节点也算连续。
    for (const el of U.collectElements(root)) {
      if (U.SKIP_SUBTREE_TAGS.has(el.localName)) continue;

      let run = 0;
      let child = el.firstChild;
      while (child) {
        const next = child.nextSibling;
        const isBr = child.nodeType === 1 && child.localName === "br";
        const isBlankText = child.nodeType === 3 && U.isBlankText(child.nodeValue);

        if (isBr) {
          run++;
          if (run > opts.maxBrRun) {
            el.removeChild(child);
            collapsed++;
          }
        } else if (isBlankText) {
          // 空白文本不打断 <br> 连续序列，本身也无保留价值。
          if (run > 0) {
            el.removeChild(child);
          }
        } else {
          run = 0;
        }
        child = next;
      }
    }

    // 4b. 块级元素首尾的孤立 <br>（含其后空白）删除。
    for (const el of U.collectElements(root)) {
      if (U.SKIP_SUBTREE_TAGS.has(el.localName)) continue;
      if (!U.BLOCK_TAGS.has(el.localName)) continue;
      if (el.localName === "br") continue;

      while (true) {
        const first = el.firstChild;
        if (!first) break;
        if (first.nodeType === 1 && first.localName === "br") {
          el.removeChild(first);
          collapsed++;
          continue;
        }
        break;
      }
      while (true) {
        const last = el.lastChild;
        if (!last) break;
        if (last.nodeType === 1 && last.localName === "br") {
          el.removeChild(last);
          collapsed++;
          continue;
        }
        break;
      }
    }

    return { collapsed };
  }

  // ================================================================ 步骤 5

  /**
   * 判断元素是否「视觉上为空」——不含任何文字、也不含任何有视觉含义的内容。
   * 宁可不删，也不误删：任何有光栅内容、装饰背景、边框、锚点身份的元素都保留。
   */
  function isVisuallyEmpty(el, opts) {
    if (el.nodeType !== 1) return false;

    // 安全豁免：表格结构、表单控件、空白有意义的子树、锚点目标。
    if (U.TABLE_TAGS.has(el.localName)) return false;
    if (U.SKIP_SUBTREE_TAGS.has(el.localName)) return false;
    if (U.isInSkipSubtree(el.parentNode)) return false;
    if (U.isAnchorTarget(el)) return false;

    // 含图片/视频/表格/hr 等有视觉含义的元素 → 非空。
    if (U.containsMeaningful(el)) return false;

    // 文本层面是否有可见字符。
    for (const node of textNodesOf(el)) {
      if (!U.isBlankText(node.nodeValue)) return false;
    }

    // 只剩空元素时，看它是否有独立的视觉表现（背景图 / 边框）。
    if (U.isVisuallySignificant(el, opts.styleProbe)) return false;

    return true;
  }

  /** 收集子树中的文本节点。 */
  function textNodesOf(el) {
    const out = [];
    const walk = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out.push(c);
        else if (c.nodeType === 1) walk(c);
      }
    };
    walk(el);
    return out;
  }

  /**
   * 自底向上递归删除空块。
   * 自底向上很关键：`<div><p></p></div>` 需要先删掉空的 <p>，
   * 外层 div 才会「变成空」并被一并删除（否则会残留一层空壳）。
   */
  function removeEmptyBlocks(root, opts) {
    let removed = 0;

    const process = (node) => {
      // 先递归子元素（自底向上）。
      const children = [];
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1) children.push(c);
      }
      for (const child of children) {
        if (child.parentNode === node) process(child);
      }

      // 再判断当前节点的子元素是否该删。
      const stillChildren = [];
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1) stillChildren.push(c);
      }
      for (const child of stillChildren) {
        if (child.parentNode !== node) continue;
        if (!U.BLOCK_TAGS.has(child.localName)) continue;
        if (child.localName === "br" || child.localName === "hr") continue;
        if (isVisuallyEmpty(child, opts)) {
          node.removeChild(child);
          removed++;
        }
      }
    };

    process(root);
    return { removed };
  }

  // ================================================================ 步骤 6

  /** 删除根节点首尾的空块（文章开头/结尾的大片留白）。 */
  function trimEdges(root, opts) {
    let removed = 0;

    const isEmptyish = (node) => {
      if (node.nodeType === 3) return U.isBlankText(node.nodeValue);
      if (node.nodeType === 8) return true;
      if (node.nodeType === 1) {
        if (node.localName === "br") return true;
        return U.BLOCK_TAGS.has(node.localName) && isVisuallyEmpty(node, opts);
      }
      return false;
    };

    while (root.firstChild && isEmptyish(root.firstChild)) {
      root.removeChild(root.firstChild);
      removed++;
    }
    while (root.lastChild && isEmptyish(root.lastChild)) {
      root.removeChild(root.lastChild);
      removed++;
    }

    return { removed };
  }

  // ================================================================ 步骤 7

  /** 无属性、无身份的纯容器 div/span → 拆掉，避免残留一层层间距。 */
  function unwrapContainers(root) {
    let unwrapped = 0;

    const walk = (node) => {
      // pre / code / textarea 子树不拆：拆掉其中的 div/span 会改变代码格式。
      if (node.nodeType === 1 && U.SKIP_SUBTREE_TAGS.has(node.localName)) return;

      const children = [];
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1) children.push(c);
      }
      for (const child of children) {
        if (child.parentNode !== node) continue;
        walk(child);

        if (child.parentNode !== node) continue;
        if (!isUnwrappable(child)) continue;

        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        unwrapped++;
      }
    };

    walk(root);
    // 拆完容器后可能又暴露出新的空块，需再清一遍（这是幂等性的关键）。
    return { unwrapped };
  }

  /** 是否是可安全拆掉的纯容器。 */
  function isUnwrappable(el) {
    const tag = el.localName;
    if (tag !== "div" && tag !== "span") return false;
    if (el.attributes.length > 0) return false;   // 带 class/id/style 的不动
    return true;
  }

  // ================================================================ 主编排

  /**
   * 执行完整的空行清理管线。
   *
   * @param {Element|DocumentFragment} root 正文根节点（就地修改）
   * @param {object} [options] 见 DEFAULTS
   * @returns {{removed:number, collapsed:number, strippedStyles:number, reasons:object}}
   */
  function cleanContent(root, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const stats = {
      removed: 0,
      collapsed: 0,
      strippedStyles: 0,
      reasons: {
        invisible: 0,
        empty: 0,
        br: 0,
        edges: 0,
        unwrapped: 0,
        unsafe: 0,
      },
    };

    if (!root || !opts.enabled) return stats;

    // 不变式：removed 始终等于各类删除原因之和，便于测试与排查。
    const finalize = () => {
      const r = stats.reasons;
      stats.collapsed = r.br;
      stats.removed = r.invisible + r.br + r.empty + r.edges + r.unsafe;
      return stats;
    };

    // 0. 安全净化。必须最先执行：任何后续步骤都可能把危险属性当成
    //    「普通属性」保留下来，先清干净才能安心处理 DOM。
    if (opts.sanitize && U.sanitize) {
      const s0 = U.sanitize(root);
      stats.reasons.unsafe += s0.tags + s0.attrs + s0.urls;
      stats.sanitized = s0;
    }

    // 1. 移除注释 / script / style / aria-hidden
    stats.reasons.invisible += stripInvisible(root).removed;

    // 2. 剥离制造空白的内联样式
    stats.strippedStyles += normalizeInlineStyles(root, opts).stripped;

    // 3. 归一化文本空白
    normalizeWhitespace(root);

    // 4. 折叠连续 <br> + 删除首尾孤立 <br>
    stats.reasons.br += collapseBrRuns(root, opts).collapsed;

    // 5. 自底向上删除空块
    stats.reasons.empty += removeEmptyBlocks(root, opts).removed;

    // 6. 裁掉首尾空块
    stats.reasons.edges += trimEdges(root, opts).removed;

    // 7. 拆掉纯容器 div，并再清一遍因此暴露出的空块
    if (opts.unwrapContainers) {
      stats.reasons.unwrapped += unwrapContainers(root).unwrapped;
      stats.reasons.empty += removeEmptyBlocks(root, opts).removed;
      stats.reasons.edges += trimEdges(root, opts).removed;
    }

    return finalize();
  }

  return {
    DEFAULTS,
    cleanContent,
    // 各步骤单独导出，便于单元测试与调试
    stripInvisible,
    normalizeInlineStyles,
    normalizeWhitespace,
    collapseBrRuns,
    removeEmptyBlocks,
    trimEdges,
    unwrapContainers,
    isVisuallyEmpty,
    shorthandHorizontal,
    stripVerticalFromShorthand: shorthandHorizontal,   // 向后兼容别名
  };
});
