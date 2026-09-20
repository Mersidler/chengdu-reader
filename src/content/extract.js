/**
 * extract.js — 正文提取。
 *
 * 流程：克隆文档 → 修复 baseURI → Readability 解析 → 空行清理 → 返回结构化结果。
 *
 * 关键陷阱（实测确认）
 * -------------------
 * 1. Readability **会污染传入的 document**（构造函数直接 `this._doc = doc`，
 *    不克隆）。所以必须先 `cloneNode(true)`，否则退出阅读模式后原页面会被破坏。
 * 2. Readability 用 `this._doc.baseURI` 把相对链接/图片转成绝对地址。
 *    而 cloneNode 出来的文档，其 baseURI 依赖 documentURI，在部分实现下为空，
 *    导致 `new URL(uri, null)` 抛错后静默返回相对路径 → 阅读视图里图片全裂。
 *    对策：克隆后把 baseURI 显式指向原文档的 baseURI。
 */
(function (root, factory) {
  const deps = {
    CleanBlank: typeof module === "object" && module.exports
      ? require("./clean/clean-blank.js")
      : root.CleanBlank,
    CleanDomUtils: typeof module === "object" && module.exports
      ? require("./clean/dom-utils.js")
      : root.CleanDomUtils,
  };
  const mod = factory(root, deps);
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  } else {
    root.ReaderExtract = mod;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, deps) {
  "use strict";

  /** 可读性下限：正文太短就不值得进入阅读模式。 */
  const MIN_CONTENT_LENGTH = 120;

  /**
   * 克隆文档并修复 baseURI / documentURI。
   * 这是让 Readability 能正确解析相对 URL 的前提。
   */
  function cloneDocumentSafely(doc) {
    const clone = doc.cloneNode(true);
    try {
      const base = doc.baseURI;
      if (base) {
        Object.defineProperty(clone, "baseURI", {
          value: base,
          configurable: true,
        });
      }
    } catch (_) {
      /* 定义失败不影响主流程，Readability 内部会退化为返回原始相对路径 */
    }
    try {
      if (doc.documentURI) {
        Object.defineProperty(clone, "documentURI", {
          value: doc.documentURI,
          configurable: true,
        });
      }
    } catch (_) {
      /* 同上 */
    }
    return clone;
  }

  /**
   * 把 Readability 返回的 HTML 字符串挂到一个游离容器里，便于跑清理管线。
   *
   * 用 DOMParser 而不是 innerHTML：
   *   1. 更符合规范——按完整 HTML 文档语义解析，不会像 innerHTML 那样
   *      在特定上下文里丢弃或重排标签；
   *   2. 解析结果位于游离（未挂载）文档树中，脚本不会执行、图片不会加载；
   *   3. 天然规避了动态 innerHTML 赋值带来的注入风险。
   *
   * 安全性最终由紧随其后的 sanitize() 兜住：真正有风险的是「把节点搬进
   * 页面 DOM」那一刻（见 reader-view.open），而 sanitize 在那之前已清除
   * 所有 on* 属性与危险协议。
   */
  function toContainer(html, doc) {
    const holder = doc.createElement("div");
    // DOMParser 是 DOM 标准的一部分，Firefox 140+ 必然可用。
    // 这里不做「退化到 innerHTML」的兜底：多一条路径就多一个风险面，
    // 况且真出现缺失也应尽早暴露，而不是静默降级到不安全的写法。
    const ParserCtor = (doc.defaultView && doc.defaultView.DOMParser) || DOMParser;
    const parsed = new ParserCtor().parseFromString(String(html), "text/html");
    holder.append(...parsed.body.childNodes);
    return holder;
  }

  /**
   * 把一段完整 HTML 字符串解析成**可交给 Readability 的 Document**。
   *
   * 与 toContainer 的区别：toContainer 只要片段（用于挂载已提取的正文），
   * 这里要一个完整文档（继续做正文提取）。
   *
   * 关键：必须把 baseURI / documentURI 指到**目标页面的真实 URL**，
   * 否则 Readability 解析相对链接（图片、下一章链接）时会得到错误结果。
   * 从字符串新建的文档，其 baseURI 默认是 about:blank，不是页面 URL。
   *
   * @param {string} html 完整 HTML 文本
   * @param {string} pageUrl 该 HTML 对应的真实 URL
   * @param {Document} hostDoc 用于借 DOMParser 的宿主文档
   */
  function documentFromHtml(html, pageUrl, hostDoc) {
    const ParserCtor =
      (hostDoc && hostDoc.defaultView && hostDoc.defaultView.DOMParser) ||
      (typeof DOMParser !== "undefined" ? DOMParser : null);
    if (!ParserCtor) throw new Error("DOMParser 不可用");

    const doc = new ParserCtor().parseFromString(String(html), "text/html");

    // 让相对 URL 能正确解析到目标页面。
    if (pageUrl) {
      const url = String(pageUrl);
      for (const prop of ["baseURI", "documentURI", "URL"]) {
        try {
          Object.defineProperty(doc, prop, { value: url, configurable: true });
        } catch (_) {
          /* 定义失败时退化为相对解析，不阻断主流程 */
        }
      }
      // 补齐 <base>：Readability 内部也会参考它。
      try {
        const head = doc.head || doc.querySelector("head");
        if (head) {
          let base = head.querySelector("base");
          if (!base) {
            base = doc.createElement("base");
            head.insertBefore(base, head.firstChild);
          }
          base.setAttribute("href", url);
        }
      } catch (_) {
        /* 同上 */
      }
    }

    return doc;
  }

  // ------------------------------------------------------------ 自动翻页：链接识别

  /**
   * 「下一章 / 下一页」候选链接的文本特征。
   *
   * 设计约束：这些模式会作用于**整段链接文本**，因此必须足够「专指」。
   * 反例：曾把 `/翻[页下]/` 放进来，结果正文里「…翻页按钮」这种普通链接
   * 被误判为下一页，导致自动翻页跳到无关页面。
   * 教训：像「翻页」这种在正文中会作为普通词出现的，不能单凭它判定。
   */
  const NEXT_TEXT_PATTERNS = [
    /^下一[章页节篇回]$/,          // 精确的「下一章」按钮
    /^下[章页节篇回]$/,            // 简写「下章」
    /下一[章页节篇回]\s*[»›→>]?$/, // 「下一章 →」
    /^下一页$/,
    /^后[一章页节篇回]$/,
    /^继续阅读$/,
    /^next(\s+(page|chapter|part))?$/i,
    /^next\s*[»›→>]$/i,
  ];

  /**
   * 宽松模式：用于 title / aria-label / class 这类**结构性**属性。
   * 这些位置出现「下一章」几乎必然就是翻页控件，可以放宽。
   */
  const NEXT_ATTR_PATTERNS = [
    /下一[章页节篇回]/,
    /下一页/,
    /后[一章页节篇回]/,
    /继续阅读/,
    /next(\s*(page|chapter|part))?/i,
  ];

  /** 明显不是正文续页的文本（用于负向排除）。 */
  const NEXT_TEXT_BLACKLIST = [
    /上一[章页节篇回]/,      // 上一章
    /^首[页章]/,
    /目[录录]/,              // 目录
    /书[架签]/,              // 书架 / 书签
    /推荐/,
    /排行/,
    /首页/,
    /完本/,
    /登录|注册/,
    /下载/,
    /评论|留言/,
    /顶部|底部|返回/,
  ];

  /** 链接自身的否定属性值。 */
  const NEXT_REL_BLACKLIST = /(^|\s)(prev|previous|up|author|bookmark|nofollow|tag|category)(\s|$)/i;

  /**
   * 在文档中寻找「下一章 / 下一页」的链接。
   *
   * Readability 0.6.0 并不提供这个能力（已核实源码），所以必须自己判断。
   * 采用**打分**而不是首个匹配：小说站的导航区往往同时有「上一章 / 目录 / 下一章」，
   * 且页脚还有一堆同名链接，单纯取第一个很容易取错。
   *
   * @param {Document|Element} root
   * @param {string} [pageUrl] 当前页 URL，用于排除外链与锚点
   * @returns {{url:string, text:string, score:number, reason:string}|null}
   */
  function findNextLink(root, pageUrl) {
    if (!root || !root.querySelectorAll) return null;

    const anchors = [...root.querySelectorAll("a[href]")];
    if (!anchors.length) return null;

    const baseUrl = pageUrl || root.baseURI || "";
    let baseHost = "";
    try {
      baseHost = baseUrl ? new URL(baseUrl).host : "";
    } catch (_) {
      baseHost = "";
    }

    let best = null;

    for (const a of anchors) {
      const rawHref = (a.getAttribute("href") || "").trim();
      if (!rawHref) continue;

      // 排除纯锚点、javascript:、mailto: 等
      if (rawHref.startsWith("#")) continue;
      if (/^(javascript|mailto|tel|data|blob):/i.test(rawHref)) continue;

      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      const title = a.getAttribute("title") || "";
      const aria = a.getAttribute("aria-label") || "";
      const rel = a.getAttribute("rel") || "";
      const cls = a.className || "";
      const id = a.id || "";
      const haystack = `${text} ${title} ${aria}`;

      // 太长的一定不是翻页按钮（多为正文里的普通链接）。
      // 用 20 作为界：'下一页' 'Next Chapter' '下一章 »' 都在此之内，
      // 而正文里的句子链接会明显更长。
      if (text.length > 20) continue;

      // 负向排除
      if (NEXT_REL_BLACKLIST.test(rel)) continue;
      if (NEXT_TEXT_BLACKLIST.some((re) => re.test(haystack) || re.test(cls) || re.test(id))) continue;

      // 解析绝对 URL，并限定同站（跨站自动翻页风险太大）
      let absUrl;
      try {
        absUrl = new URL(rawHref, baseUrl || undefined).href;
      } catch (_) {
        continue;
      }
      if (baseHost) {
        let host;
        try {
          host = new URL(absUrl).host;
        } catch (_) {
          continue;
        }
        if (host !== baseHost) continue;
      }
      // 指向自己 = 不是下一页
      if (absUrl === baseUrl) continue;

      // 正向打分
      let score = 0;
      const reasons = [];

      // 文本用**严格**模式：整段文本必须就是翻页按钮文案。
      // 这点很重要——宽松匹配会把正文里的「…下一章的内容…」误判为按钮。
      if (NEXT_TEXT_PATTERNS.some((re) => re.test(text))) {
        score += 60;
        reasons.push("文本精确匹配");
      } else if (NEXT_ATTR_PATTERNS.some((re) => re.test(title) || re.test(aria))) {
        score += 40;
        reasons.push("title/aria 匹配");
      } else if (/\bnext\b/i.test(`${cls} ${id} ${rel}`)) {
        // class/id 含 next：结构性证据，但单靠它不足以判定，
        // 因此给足分数（35）+ 下面通常还会有导航容器加分。
        score += 35;
        reasons.push("class/id 含 next");
      }

      if (score === 0) continue;

      // 结构加分：位于导航区、是块级按钮样式、有箭头符号
      if (/[»›→>]/.test(text)) {
        score += 8;
        reasons.push("含箭头");
      }
      if (/\b(next|page|chapter|nav|btn|button)\b/i.test(`${cls} ${id}`)) {
        score += 8;
      }
      if (a.closest("nav, .pagination, .page-nav, .nav-links, .chapter-nav, .bottem, .bottem1, .bottem2")) {
        score += 15;
        reasons.push("位于导航容器");
      }
      // 「下一章」通常靠后出现（在导航条右侧）
      if (a.compareDocumentPosition && anchors.indexOf(a) > anchors.length * 0.6) {
        score += 5;
      }
      // 纯「下一章」文本比「下一章 xxx」更可信
      if (/^下一[章页]?$/.test(text.trim())) {
        score += 10;
        reasons.push("文本精确");
      }
      // URL 相似度：翻页链接通常与当前页是「同目录下的兄弟页」
      //（例如 /book/1/2.html → /book/1/3.html），这是很强的独立证据。
      if (isSiblingPage(baseUrl, absUrl)) {
        score += 12;
        reasons.push("同目录兄弟页");
      }

      if (!best || score > best.score) {
        best = { url: absUrl, text, score, reason: reasons.join("+") || "弱匹配" };
      }
    }

    // 阈值：避免把无关链接当成下一页。
    // 40 分的含义：文本精确匹配 / title 匹配 / class 含 next 三者任一即可成立，
    // 其余加分用于在多个候选中排优选。
    return best && best.score >= 40 ? best : null;
  }

  /**
   * 判断两个 URL 是否像「同一批分页的兄弟页」。
   *
   * 依据：同 host + 同目录 + 末段不同。
   *   /book/1/2.html vs /book/1/3.html  → true
   *   /book/1/2.html vs /book/1/       → false（目录页，层级不同）
   *   /a/1 vs /b/2                      → false（不同目录）
   *
   * 这个信号能显著降低「把博客的『下一篇』链接误当成续页」的概率，
   * 因为那类链接通常跨目录（/posts/other-title）。
   */
  function isSiblingPage(currentUrl, candidateUrl) {
    if (!currentUrl || !candidateUrl) return false;
    try {
      const a = new URL(currentUrl);
      const b = new URL(candidateUrl);
      if (a.host !== b.host) return false;

      // 目录必须相同
      const dirA = a.pathname.replace(/\/[^/]*$/, "/");
      const dirB = b.pathname.replace(/\/[^/]*$/, "/");
      if (dirA !== dirB) return false;

      // 末段必须不同（否则是同一页）
      const lastA = a.pathname.slice(dirA.length);
      const lastB = b.pathname.slice(dirB.length);
      if (!lastA || !lastB || lastA === lastB) return false;

      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 估算正文可读性，判断是否值得进入阅读模式。
   * 用纯文本长度做粗判即可，不引入额外依赖。
   */
  function isLikelyReaderable(doc) {
    const body = doc.body;
    if (!body) return false;
    const text = (body.innerText || body.textContent || "").trim();
    if (text.length < MIN_CONTENT_LENGTH) return false;
    // 链接密度过高（导航页 / 列表页）不适合阅读模式。
    const linkText = [...body.querySelectorAll("a")]
      .reduce((sum, a) => sum + (a.textContent || "").length, 0);
    if (linkText / Math.max(text.length, 1) > 0.5) return false;
    return true;
  }

  /**
   * 清理从 <title> 得到的标题：去掉附带的站点名后缀。
   *
   * 浏览器标题通常是「文章标题｜站点名」形式，直接显示会在阅读视图里
   * 夹带站点名噪音、并与正文标题构成重复。
   *
   * 策略：按分隔符切分，取最长的一段作为文章标题。
   * 站点名通常较短、文章标题通常较长，取最长是最稳的启发式；
   * 若只有一段（无分隔符）或切分结果不合理，则原样保留。
   */
  function cleanTitle(raw, siteName) {
    const title = String(raw || "").replace(/\s+/g, " ").trim();
    if (!title) return "";

    // 已知站点名：优先精确去掉「分隔符 + 站点名」的结尾。
    if (siteName) {
      const s = String(siteName).trim();
      if (s) {
        const re = new RegExp(
          "\\s*[|｜\\-–—·»/:：]\\s*" + escapeRegExp(s) + "\\s*$", "i"
        );
        const cut = title.replace(re, "").trim();
        if (cut) return cut;
      }
    }

    // 通用规则：按分隔符切分，取最长片段。
    // 分隔符写法必须能匹配实际字符（曾因漏写全角「｜」导致整段失效）。
    const sepRe = /\s*[|｜]\s*|\s+[-–—]\s+|\s*·\s*|\s+»\s+|\s+::\s+/;
    if (!sepRe.test(title)) return title;

    const parts = title.split(sepRe).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return title;

    // 取最长片段：站点名通常较短、文章标题较长，这是最稳的启发式。
    // 并列时取靠前者（站点名常见于后缀，但前缀形式也需保留标题）。
    // 注意不要用「占比过半」这类判据：中文单字信息密度高，
    // 「城市里的树 | 示例站点」的标题只占 5/12，按比例会被误判为不合理。
    const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (longest.length < 2) return title;
    return longest;
  }

  /** 转义正则元字符。 */
  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * 从正文里取出开头的标题元素（h1/h2/h3）。
   *
   * 为什么要用它：Readability 会把 <title> 的文本作为 article.title，
   * 而正文通常已经自带一个 <h1>/<h2>。两者同时显示就会出现「标题重复」，
   * 且 metadata 版本还带着站点名。正文自带的标题才是真正的文章标题。
   *
   * 该元素会被从原位置摘除并返回，交由调用方决定如何渲染。
   */
  function takeLeadingHeading(container) {
    if (!container) return null;
    const headings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const h of headings) {
      const text = (h.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      // 只采纳「文档顺序靠前」的标题，避免把正文中段的子标题当成文章标题。
      // 判定方式：该标题之前不应有实质段落内容。
      if (hasSubstantialTextBefore(container, h)) return null;
      if (h.parentNode) h.parentNode.removeChild(h);
      return h;
    }
    return null;
  }

  /**
   * 判断某元素之前是否已经出现实质文本（用于确认它是不是开篇标题）。
   *
   * 返回值语义必须区分三种情况，否则「找到目标」会被误当成「找到之前有文字」：
   *   命中目标     → { reached: true,  hasTextBefore: false }
   *   先遇到文字   → { reached: false, hasTextBefore: true  }
   *   都没有       → { reached: false, hasTextBefore: false }
   */
  function scanBefore(root, target, threshold) {
    let seen = 0;
    let reached = false;
    let hasTextBefore = false;

    const walk = (node) => {
      if (reached || hasTextBefore) return;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (reached || hasTextBefore) return;

        if (c === target) {
          reached = true;
          return;
        }
        if (c.nodeType === 3) {
          if (/\S/.test(c.nodeValue)) seen += c.nodeValue.trim().length;
        } else if (c.nodeType === 1) {
          walk(c);
        }
        if (seen > threshold) {
          hasTextBefore = true;
          return;
        }
      }
    };

    walk(root);
    return { reached, hasTextBefore };
  }

  /** 该元素之前是否已有实质文本（有则它不是开篇标题）。 */
  function hasSubstantialTextBefore(root, target, threshold) {
    const limit = typeof threshold === "number" ? threshold : 40;
    const r = scanBefore(root, target, limit);
    return r.hasTextBefore;
  }

  /**
   * 提取正文。
   *
   * @param {Document} doc 当前页面文档
   * @param {object} [opts]
   * @param {boolean} [opts.cleanBlank=true] 是否执行空行清理
   * @param {number}  [opts.paddingStripThreshold] 透传给清理管线
   * @param {Function} [opts.Readability] 注入构造函数（便于测试）
   * @returns {{ok:boolean, reason?:string, title?:string, heading?:Element,
   *            content?:Element, byline?:string, excerpt?:string, siteName?:string,
   *            lang?:string, dir?:string, cleanStats?:object, sanitizeStats?:object}}
   */
  function extractArticle(doc, opts) {
    const options = opts || {};
    const ReadabilityCtor = options.Readability ||
      (root && root.Readability) ||
      (typeof require === "function" ? tryRequireReadability() : null);

    if (typeof ReadabilityCtor !== "function") {
      return { ok: false, reason: "no-readability" };
    }

    if (!options.force && !isLikelyReaderable(doc)) {
      return { ok: false, reason: "not-readerable" };
    }

    // 1. 先克隆，避免破坏原页面。
    const clone = cloneDocumentSafely(doc);

    // 2. Readability 解析。
    let article;
    try {
      article = new ReadabilityCtor(clone, {
        // 保留 class 会让页面自带样式（可能含大间距）跟着进来，故默认不保留。
        keepClasses: false,
        charThreshold: 200,
      }).parse();
    } catch (err) {
      return { ok: false, reason: "parse-error", error: String(err && err.message || err) };
    }

    if (!article || !article.content) {
      return { ok: false, reason: "empty-article" };
    }
    if (!options.force && (article.length || 0) < MIN_CONTENT_LENGTH) {
      return { ok: false, reason: "too-short" };
    }

    // 3. 挂到容器后先净化，再跑空行清理。
    const container = toContainer(article.content, doc);

    // 安全净化独立于「空行清理」开关：即使用户关掉了清理，
    // 也必须剥掉 on* 事件属性与危险协议，否则恶意页面能在阅读视图里执行脚本。
    const sanitizeStats = deps.CleanDomUtils && deps.CleanDomUtils.sanitize
      ? deps.CleanDomUtils.sanitize(container)
      : null;

    // 4. 取正文自带的开篇标题，避免与 <title> 重复显示。
    //    在清理之前取走：标题元素随后就不参与空行清理，也就不会
    //    因为含全角空格之类的原因被误判为空块删掉。
    const heading = takeLeadingHeading(container);

    let cleanStats = null;
    if (options.cleanBlank !== false && deps.CleanBlank) {
      cleanStats = deps.CleanBlank.cleanContent(container, {
        enabled: true,
        sanitize: false,   // 上面已独立执行过，避免重复计数
        paddingStripThreshold: options.paddingStripThreshold,
      });
    }

    // 标题优先级：正文自带的开篇标题 > 清理过的 <title> > 文档标题。
    const headingText = heading ? (heading.textContent || "").replace(/\s+/g, " ").trim() : "";
    const siteName = article.siteName || "";
    const title = headingText
      || cleanTitle(article.title || doc.title || "", siteName);

    // 下一章 / 下一页链接：在**原始文档**上找（不是清理后的正文容器），
    // 因为小说站的翻页导航通常位于正文之外的独立导航区，会被 Readability 剔除。
    const nextLink = options.findNext === false ? null : findNextLink(doc, doc.baseURI || doc.URL);

    return {
      ok: true,
      title,
      heading: heading || null,
      content: container,
      byline: article.byline || "",
      excerpt: article.excerpt || "",
      siteName,
      lang: article.lang || doc.documentElement.getAttribute("lang") || "",
      dir: article.dir || doc.documentElement.getAttribute("dir") || "",
      cleanStats,
      sanitizeStats,
      nextLink,
    };
  }

  /** 在 Node 测试环境下按需加载 Readability（浏览器里走 root.Readability）。 */
  function tryRequireReadability() {
    try {
      // eslint-disable-next-line global-require
      return require("../vendor/readability.js");
    } catch (_) {
      return null;
    }
  }

  return {
    MIN_CONTENT_LENGTH,
    extractArticle,
    isLikelyReaderable,
    cloneDocumentSafely,
    toContainer,
    documentFromHtml,
    findNextLink,
    isSiblingPage,
    cleanTitle,
    takeLeadingHeading,
    hasSubstantialTextBefore,
    scanBefore,
  };
});
