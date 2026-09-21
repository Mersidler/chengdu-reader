/**
 * reader-view.js — 阅读视图的挂载与卸载。
 *
 * 用 Shadow DOM 承载正文，原因：
 *   1. 页面 CSS（含 !important）无法穿透 shadow 边界，阅读排版不会被撕碎；
 *   2. 我们的样式也不会泄漏到页面上。
 *
 * 生命周期：open() → 挂载 → close() → 完全还原页面（含滚动位置）。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ReaderView = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /** Shadow 宿主元素的 id。 */
  const HOST_ID = "chengdu-reader-host";

  /**
   * 宿主的内联样式（一次性写入，不再改动）。
   *
   * 为什么用内联而不是只靠样式表里的 :host：
   *   宿主元素既受 shadow 内的 :host 规则影响，也受**页面**样式影响，
   *   而 :host 的普通声明会输给外层页面的规则（可能被 div{margin/border/font} 干扰）。
   *   内联样式优先级最高，是唯一能与页面样式稳定对抗的手段。
   *
   * 关键：`all: initial` 会同时重置 color / background / font-size 等一切属性，
   * 且内联优先级最高——因此由它重置掉的属性必须**也由内联补回来**，
   * 光写在 :host 规则里是没用的（实测踩过：深色主题下正文仍是黑字，
   * 因为 all:initial 把 color 重置为初始值黑色，而 :host 的 color 被内联压过）。
   * 颜色与字体类属性统一在 applyPrefs 里按当前主题补齐。
   */
  const HOST_INLINE_STYLE = [
    "all: initial",
    "position: fixed !important",
    "inset: 0 !important",
    "z-index: 2147483647 !important",
    "display: block !important",
    "overflow: hidden !important",
  ].join("; ");


  /**
   * 创建阅读视图。
   * @param {object} deps
   * @param {object} deps.prefs          偏好模块（提供 toCssVars）
   * @param {object} deps.styles         样式模块（提供 buildCss）
   * @param {object} deps.toolbar        工具条模块
   * @param {Function} [deps.onPrefsChange] 用户改动设置时回调（用于持久化）
   * @param {Function} [deps.onToggleClean] 切换「空行清理」开关时回调（需重新提取）
   * @param {Function} [deps.onToggleAutoNext] 切换「自动续页」开关时回调
   * @param {Function} [deps.onToggleTts] 切换「有声朗读」开关时回调
   */
  function createReaderView(deps) {
    const { prefs, styles, toolbar, onPrefsChange, onToggleClean, onToggleAutoNext, onToggleTts } = deps;

    /** @type {{host:Element, shadow:ShadowRoot, scroll:Element, content:Element, prefs:object, restore:Function}|null} */
    let session = null;

    /**
     * 当前滚动监听的退订函数（由 onScrollNearBottom 设置）。
     * 单独保存是因为 close() 时 session 已置空，但仍需用它解绑监听器。
     */
    let lastScrollUnsub = null;

    /** 是否处于打开状态。 */
    function isOpen() {
      return session !== null;
    }

    /**
     * 打开阅读视图。
     * @param {object} article extractArticle 的返回结果
     * @param {object} initialPrefs
     */
    function open(article, initialPrefs) {
      if (session) return session;

      // 归一化一份偏好副本：保证字体栈等派生字段存在（见 prefs.normalize）。
      // 不直接用调用方传入的对象，避免后续改动反向影响调用方的状态。
      const prefsState = prefs.normalize
        ? prefs.normalize(initialPrefs)
        : Object.assign({}, initialPrefs);

      // ---- 保存并冻结页面：防止背景滚动「穿透」到阅读视图下方。
      const doc = document;
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const prevOverflow = doc.documentElement.style.overflow;
      doc.documentElement.style.overflow = "hidden";

      // ---- 宿主与 shadow root
      const host = doc.createElement("div");
      host.id = HOST_ID;
      // 见 HOST_INLINE_STYLE 的说明：内联优先级最高，用于对抗页面样式。
      host.setAttribute("style", HOST_INLINE_STYLE);
      const shadow = host.attachShadow({ mode: "open" });

      // ---- 样式
      const styleEl = doc.createElement("style");
      styleEl.textContent = styles.buildCss(prefsState);
      shadow.appendChild(styleEl);

      // ---- 滚动容器
      const scroll = doc.createElement("div");
      scroll.className = "rd-scroll";
      scroll.setAttribute("tabindex", "-1");

      const page = doc.createElement("div");
      page.className = "rd-page";

      // ---- 标题区
      // article.heading 是正文自带的开篇标题元素（已在 extract 中摘除）；
      // title 是兜底文本。优先用前者，因为它带着原文的语义与层级。
      const titleEl = article.heading || null;
      const titleText = (titleEl ? titleEl.textContent : article.title || "")
        .replace(/\s+/g, " ").trim();

      if (titleText) {
        const header = doc.createElement("header");
        header.className = "rd-header";

        // 统一用 h1 呈现：阅读视图里它就是文章主标题，
        // 保留原文的 h2/h3 会导致层级语义混乱、字号也偏小。
        const h1 = doc.createElement("h1");
        h1.className = "rd-title";
        h1.textContent = titleText;
        header.appendChild(h1);

        const metaBits = [];
        if (article.byline) metaBits.push(article.byline);
        if (article.siteName) metaBits.push(article.siteName);
        if (metaBits.length) {
          const meta = doc.createElement("div");
          meta.className = "rd-meta";
          metaBits.forEach((bit, i) => {
            if (i > 0) {
              const sep = doc.createElement("span");
              sep.className = "rd-sep";
              sep.textContent = "·";
              meta.appendChild(sep);
            }
            const span = doc.createElement("span");
            span.textContent = bit;
            meta.appendChild(span);
          });
          header.appendChild(meta);
        }
        page.appendChild(header);
      }

      // ---- 正文
      const content = doc.createElement("div");
      content.className = "rd-content";
      if (article.lang) content.setAttribute("lang", article.lang);
      if (article.dir) content.setAttribute("dir", article.dir);
      // 把清理过的正文节点整体搬进来。
      while (article.content.firstChild) {
        content.appendChild(article.content.firstChild);
      }
      page.appendChild(content);

      scroll.appendChild(page);

      // ---- 工具条
      const bar = toolbar
        ? toolbar.create({
            prefs: prefsState,
            onChange: applyPrefs,
            onClose: () => close(),
            onToggleClean: onToggleClean,
            onToggleAutoNext: onToggleAutoNext,
            onToggleTts: onToggleTts,
            cleanStats: article.cleanStats,
          })
        : null;
      // 注意 append 顺序：scroll 与 bar 都是 absolute 定位的元素，
      // 在没有 z-index 时「后者绘于上层」。因此必须**先**挂滚动容器、
      // **后**挂工具条，否则滚动容器会盖住工具条（实测踩过：工具条完全不可见）。
      shadow.appendChild(scroll);
      if (bar) shadow.appendChild(bar);

      doc.documentElement.appendChild(host);

      // 必须先建立 session，再调用 syncScrollInset ——
      // 后者以 session 为前置条件（无 session 直接返回）。
      // 之前把调用写在赋值之前，导致浏览器里顶部留白从未生效、标题被工具条遮住，
      // 而 jsdom 不做布局，测试也没暴露出来。
      session = {
        host,
        shadow,
        scroll,
        content,
        prefs: prefsState,
        // 记录「上次实际应用」的主题与页宽。
        // 不能拿 session.prefs 去比较：工具条持有同一个对象引用，
        // 它会先改值再回调，导致比较时两边已经相等、判断不出需要重建样式表。
        appliedTheme: prefsState.theme,
        appliedWidth: prefsState.width,
        // 视口尺寸变化会改变工具条的换行情况，需要重算顶部留白。
        onResize: syncScrollInset,
        restore: () => {
          window.removeEventListener("resize", syncScrollInset);
          doc.documentElement.style.overflow = prevOverflow;
          // 还原滚动位置，退出阅读模式后回到原处。
          window.scrollTo(scrollX, scrollY);
        },
      };

      // 按工具条实测高度设定正文顶部留白，避免遮挡（含换行成两行的情况）。
      syncScrollInset();

      // 统一应用一次偏好，把主题色/字体/页宽等内联到宿主。
      // 这一步不可省略：宿主内联的 `all: initial` 会把颜色、字体、字号
      // 全部重置为初始值，必须由 applyPrefs 补齐（曾漏调，导致打开后
      // 所有偏好都没生效，而当时测试恰好只断言了样式表内容因而没发现）。
      // silent：打开不是「用户改动设置」，不应触发持久化回调。
      applyPrefs(prefsState, { silent: true });

      window.addEventListener("resize", syncScrollInset);

      // 焦点移入，便于键盘滚动与 Esc 退出。
      try {
        scroll.focus({ preventScroll: true });
      } catch (_) {
        /* 忽略 */
      }

      return session;
    }

    /**
     * 按工具条的实际高度调整正文顶部留白。
     *
     * 为什么需要动态测量：工具条控件多，窄视口或大字号下会 `flex-wrap` 换成两行，
     * 写死的 padding 就会导致正文被遮住标题（实机截图中确实出现过）。
     * 实测高度最稳，且能同时适配一行/两行。
     *
     * ## 为什么底部留白也在这里统一算
     *
     * 之前底部 padding 由 setStatus 单独设置，朗读播放条出现后就有两处
     * 写同一个属性，互相覆盖（表现为「播放条遮住最后一行」或
     * 「状态条消失后底部仍留着空白」）。现在统一由本函数根据
     * **所有浮层的高度之和**计算一次，是唯一的权威。
     */
    function syncScrollInset() {
      if (!session) return;
      const { scroll, shadow } = session;
      const bar = shadow.querySelector(".rd-bar");
      if (!bar) return;

      const barHeight = bar.getBoundingClientRect().height || 0;
      // 小屏时工具条贴底（见样式表的媒体查询）。matchMedia 在极老环境可能缺失，
      // 缺失时按桌面布局处理。
      const isBottomBar = typeof window.matchMedia === "function"
        ? window.matchMedia("(max-width: 640px)").matches
        : false;

      // 底部浮层：状态条与朗读播放条都固定在视口底部，它们的高度
      // 必须累加进底部留白，否则会盖住正文最后几行。
      const statusEl = shadow.querySelector(".rd-status");
      const ttsEl = shadow.querySelector(".rd-tts-bar");
      const statusH = statusEl ? (statusEl.getBoundingClientRect().height || 0) : 0;
      const ttsH = ttsEl ? (ttsEl.getBoundingClientRect().height || 0) : 0;
      const bottomOverlay = statusH + ttsH;

      if (isBottomBar) {
        // 小屏：工具条也贴底，一并计入底部留白
        scroll.style.paddingTop = "";
        scroll.style.paddingBottom = `${Math.round(bottomOverlay + barHeight) + 32}px`;
      } else {
        scroll.style.paddingTop = `${Math.round(barHeight) + 26}px`;
        scroll.style.paddingBottom = bottomOverlay > 0
          ? `${Math.round(bottomOverlay) + 40}px`
          : "";
      }
    }

    /**
     * 应用偏好：只更新 CSS 变量与必要的样式，不重建 DOM。
     *
     * @param {object} next 新的偏好（可与当前值部分重叠）
     * @param {object} [opts]
     * @param {boolean} [opts.silent] 不触发 onPrefsChange（用于打开时的首次应用，
     *   否则「打开阅读模式」会被误当成一次用户改动而触发写盘）
     */
    function applyPrefs(next, opts) {
      if (!session) return;

      // 合并后重新归一化：保证派生字段（如 fontFamily）与 fontFamilyKey 始终同步。
      // 若不归一化，工具条改了 fontFamilyKey 之后 fontFamily 仍是旧值，字体切换会失效。
      const merged = prefs.normalize
        ? prefs.normalize(Object.assign({}, session.prefs, next))
        : Object.assign({}, session.prefs, next);

      // 主题/页宽变化需要重建样式表；其余维度用 CSS 变量增量更新即可。
      // 与「上次已应用值」比较，而不是与 session.prefs（同一对象引用，已被改写）。
      const needsRebuild =
        merged.theme !== session.appliedTheme ||
        merged.width !== session.appliedWidth;

      Object.assign(session.prefs, merged);

      if (needsRebuild) {
        session.appliedTheme = merged.theme;
        session.appliedWidth = merged.width;
        const styleEl = session.shadow.querySelector("style");
        if (styleEl) styleEl.textContent = styles.buildCss(session.prefs);
      }

      // 主题色、字体、页宽等一律由 styles.hostInlineStyle 统一下发到宿主内联样式，
      // 原因是宿主上的 `all: initial` 会把它们重置为初始值，
      // 只有内联声明才能可靠覆盖（详见 styles.hostInlineStyle 的说明）。
      const inline = styles.hostInlineStyle(session.prefs);
      for (const [k, v] of Object.entries(inline)) {
        session.host.style.setProperty(k, v);
      }

      // 段距由正文容器上的变量驱动，便于实时调节。
      session.content.style.setProperty("--rd-gap", `${session.prefs.paraGap}em`);

      if (toolbar && toolbar.refresh) toolbar.refresh(session.prefs);
      // 字号/控件文案变化会改变工具条高度，需重新留白。
      syncScrollInset();

      if (!(opts && opts.silent) && onPrefsChange) onPrefsChange(session.prefs);
    }

    /** 关闭并完全还原页面。 */
    function close() {
      if (!session) return;

      const { host, restore, statusEl, ttsBar } = session;
      session = null;

      // 解绑滚动监听：由 onScrollNearBottom 返回的退订函数负责，
      // 避免会话结束后监听器仍持有对已移除容器的引用。
      if (lastScrollUnsub) {
        try {
          lastScrollUnsub();
        } catch (_) {
          /* 忽略 */
        }
        lastScrollUnsub = null;
      }

      if (statusEl) statusEl.remove();
      // 播放条由 main.js 创建并持有引用，这里只负责从 DOM 摘掉；
      // 引擎自身的销毁由 main.js 的 closeReader 统一负责。
      if (ttsBar && ttsBar.parentNode) ttsBar.parentNode.removeChild(ttsBar);
      if (host && host.parentNode) host.parentNode.removeChild(host);
      restore();
    }

    /** 切换。 */
    function toggle(article, initialPrefs) {
      if (isOpen()) {
        close();
        return false;
      }
      open(article, initialPrefs);
      return true;
    }

    /**
     * 向已打开的阅读视图追加一篇文章（自动翻页用）。
     *
     * 为什么要独立入口而不是再调 open()：
     *   - open() 会把宿主、样式、工具条重建一遍，且会重置滚动位置；
     *   - open() 内部已把 article.content 的节点搬走，无法二次使用。
     * 这里只做「插一条分隔线 + 把新正文节点搬进 content」。
     *
     * @param {object} article 与 extractArticle 同形状的结果
     * @param {object} [opts]
     * @param {boolean} [opts.separator] 是否插入章节分隔线（默认 true）
     */
    function appendArticle(article, opts) {
      if (!session) return false;
      if (!article || !article.content) return false;

      const doc = session.content.ownerDocument;
      const options = opts || {};

      // 章节分隔线：让读者能看出章节边界（也便于定位）
      if (options.separator !== false) {
        const sep = doc.createElement("div");
        sep.className = "rd-chapter-sep";
        sep.setAttribute("aria-hidden", "true");
        const span = doc.createElement("span");
        span.textContent = article.title || "下一章";
        sep.appendChild(span);
        session.content.appendChild(sep);
      }

      // 把新正文节点整体搬入
      while (article.content.firstChild) {
        session.content.appendChild(article.content.firstChild);
      }

      session.appendedCount = (session.appendedCount || 0) + 1;
      // 追加后页面变长，工具条遮挡情况不变，但滚动条可能出现，重算一次留白。
      syncScrollInset();
      return true;
    }

    /**
     * 设置阅读视图底部的状态提示（加载中 / 已到末尾 / 出错）。
     *
     * 注意：状态条挂在 **shadow root** 上，而不是滚动容器内部。
     * 原因：`overflow: auto` 容器里的绝对定位子元素会随内容一起滚动，
     * `bottom: 0` 于是指向「内容底部」而非「视口底部」——实测表现为
     * 提示条出现在正文中间。挂在滚动容器外，它才能真正固定在视口底部。
     *
     * @param {null|{state:string, message?:string}} status 传 null 清除
     */
    function setStatus(status) {
      if (!session) return;

      const clear = () => {
        if (session.statusEl) {
          session.statusEl.remove();
          session.statusEl = null;
        }
        // 底部留白统一由 syncScrollInset 重算（它会把播放条的高度也算进去），
        // 这里不再自己写 paddingBottom —— 两处写同一属性会互相覆盖。
        syncScrollInset();
      };

      if (!status || status.state === "idle" || status.state === "off") {
        clear();
        return;
      }

      if (!session.statusEl) {
        const doc = session.scroll.ownerDocument;
        const el = doc.createElement("div");
        el.className = "rd-status";
        el.dataset.state = status.state;
        // 插到工具条之后，保证绘制在最上层
        session.shadow.appendChild(el);
        session.statusEl = el;
      }

      const el = session.statusEl;
      el.textContent = status.message || "";
      el.dataset.state = status.state;

      // 状态条覆盖在内容之上，重算底部留白（含播放条）避免遮住最后几行。
      syncScrollInset();
    }

    /** 滚动监听是否已绑定（供自动翻页判定）。 */
    function onScrollNearBottom(handler, thresholdPx) {
      if (!session) return () => {};
      const threshold = typeof thresholdPx === "number" ? thresholdPx : 600;
      const el = session.scroll;

      const listener = () => {
        // 距底部不足 threshold 时触发
        const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (remaining <= threshold) handler();
      };
      el.addEventListener("scroll", listener, { passive: true });

      const unsub = () => {
        try {
          el.removeEventListener("scroll", listener);
        } catch (_) {
          /* 忽略 */
        }
      };
      lastScrollUnsub = unsub;
      return unsub;
    }

    /**
     * 高亮 / 取消高亮一个正文块（朗读跟随用）。
     *
     * 用 class 而不是内联样式：样式表在 shadow 内已定义 .rd-tts-active，
     * 且它随主题变化（内联样式无法跟随主题切换）。
     *
     * @param {Element|null} block
     * @param {boolean} on
     */
    function highlightBlock(block, on) {
      if (!block || !block.classList) return;
      try {
        if (on) block.classList.add("rd-tts-active");
        else block.classList.remove("rd-tts-active");
      } catch (_) {
        /* 忽略：高亮失败不应影响朗读 */
      }
    }

    /**
     * 把某个正文块滚动到视口中央（朗读跟随用）。
     *
     * 用 scrollIntoView({block:"center"}) 而不是手算 scrollTop：
     * 块可能嵌在嵌套结构里，手算容易出错。
     * 注意要传 behavior:"auto"（立即）而不是 "smooth"——
     * 朗读每几十秒跳一次，平滑滚动反而显得拖沓。
     *
     * @param {Element|null} block
     */
    function scrollToBlock(block) {
      if (!block || !session) return;
      try {
        block.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      } catch (_) {
        /* 老环境不支持 options 对象时忽略 */
      }
    }

    /**
     * 挂载朗读播放条元素（由 main.js 创建后交进来）。
     *
     * 为什么由外部创建、这里挂载：播放条需要 tts 引擎的引用，
     * 而引擎依赖 view 的 content/scroll，两者互相依赖。
     * 让 main.js 负责编排（它本来就承担装配职责），view 只负责挂到正确位置。
     *
     * @param {Element} el
     */
    function attachTtsBar(el) {
      if (!session || !el) return false;
      session.ttsBar = el;
      // 追加到最后 → 在所有 absolute 浮层里绘制在最上层
      // （同 z-index 时后者在上；样式里另给了 z-index:3 双保险）。
      session.shadow.appendChild(el);
      syncScrollInset();
      return true;
    }

    /** 移除朗读播放条。 */
    function detachTtsBar() {
      if (!session) return;
      const el = session.ttsBar;
      if (el && el.parentNode) el.parentNode.removeChild(el);
      session.ttsBar = null;
      syncScrollInset();
    }

    return {
      isOpen,
      open,
      close,
      toggle,
      applyPrefs,
      appendArticle,
      setStatus,
      onScrollNearBottom,
      highlightBlock,
      scrollToBlock,
      attachTtsBar,
      detachTtsBar,
      /** 重算滚动留白（播放条显隐后需要）。 */
      refreshInset: () => syncScrollInset(),
      getContent: () => (session ? session.content : null),
      getScroll: () => (session ? session.scroll : null),
      getShadow: () => (session ? session.shadow : null),
      HOST_ID,
    };
  }

  return { createReaderView, HOST_ID };
});
