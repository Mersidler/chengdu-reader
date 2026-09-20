/**
 * styles.js — 阅读视图样式。
 *
 * 注入 Shadow Root，因此不会与页面样式互相污染。
 * 设计要点：
 *   1. 垂直节奏由这里的变量统一接管（--rd-gap-para 等）。JS 侧负责删掉空元素，
 *      CSS 侧负责让「留下的元素」间距一致——两者合起来才算真正消灭空白行。
 *   2. 兜底层：`p:empty` / `p:has(> br:only-child)` 等直接 display:none，
 *      即使 JS 漏掉某个边缘情况，渲染出来也不会是空行。
 *   3. `all: initial` 重置宿主继承，再用我们自己的规则重建。
 */
(function (root) {
  "use strict";

  /** 主题调色板。 */
  const THEMES = {
  light: {
    bg: "#ffffff",
    fg: "#24292f",
    muted: "#6b7280",
    link: "#2563eb",
    barBg: "rgba(255,255,255,.94)",
    barBorder: "rgba(0,0,0,.10)",
    barHover: "rgba(0,0,0,.06)",
    codeBg: "rgba(0,0,0,.05)",
    quoteBar: "rgba(0,0,0,.18)",
    selBg: "rgba(37,99,235,.22)",
  },
  sepia: {
    bg: "#f6efe3",
    fg: "#3b3226",
    muted: "#7c6f5c",
    link: "#9a6a2f",
    barBg: "rgba(246,239,227,.95)",
    barBorder: "rgba(0,0,0,.12)",
    barHover: "rgba(0,0,0,.07)",
    codeBg: "rgba(0,0,0,.06)",
    quoteBar: "rgba(0,0,0,.20)",
    selBg: "rgba(154,106,47,.25)",
  },
  dark: {
    bg: "#1b1e23",
    fg: "#d7dbe0",
    muted: "#8b949e",
    link: "#6cb6ff",
    barBg: "rgba(27,30,35,.95)",
    barBorder: "rgba(255,255,255,.14)",
    barHover: "rgba(255,255,255,.10)",
    codeBg: "rgba(255,255,255,.08)",
    quoteBar: "rgba(255,255,255,.22)",
    selBg: "rgba(108,182,255,.28)",
  },
};

/** 页宽预设（相对视口的百分比 / 像素）。 */
const WIDTHS = {
  narrow: "34rem",
  medium: "44rem",
  wide: "56rem",
  full: "100%",
};

/**
 * 生成阅读视图的完整 CSS。
 * @param {object} prefs 见 prefs.js DEFAULTS
 */
function buildCss(prefs) {
  const t = THEMES[prefs.theme] || THEMES.light;
  const width = WIDTHS[prefs.width] || WIDTHS.medium;

  return `
:host {
  /* 重置所有可能从页面继承的属性，避免「页面字体/颜色渗进来」。 */
  all: initial;
  /* 但自身必须是固定定位的全屏浮层。 */
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: block;
  background: ${t.bg};
  color: ${t.fg};
  font-family: ${prefs.fontFamily};
  font-size: ${prefs.fontSize}px;
  line-height: ${prefs.lineHeight};
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

*, *::before, *::after { box-sizing: border-box; }

/* 滚动容器：整页滚动交给它，避免影响宿主页面。 */
.rd-scroll {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  background: ${t.bg};
  /* 顶部留白由 JS 按工具条实测高度动态设定（见 reader-view.syncScrollInset），
     这里的值只是「脚本未及执行时」的兜底，避免首帧正文压到工具条下面。 */
  padding: 4.6rem 1.4rem 6rem;
}

.rd-page {
  width: 100%;
  /* 页宽由宿主内联的 --rd-page-width 驱动，便于实时切换。 */
  max-width: var(--rd-page-width, ${width});
  margin: 0 auto;
}

/* ------------------------------------------------------------- 标题区 */
.rd-header { margin-bottom: 2.2rem; }
.rd-title {
  font-size: 1.85em;
  line-height: 1.3;
  font-weight: 700;
  margin: 0 0 .55rem;
  color: ${t.fg};
}
.rd-meta {
  font-size: .82em;
  color: ${t.muted};
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  align-items: baseline;
}
.rd-meta .rd-sep { opacity: .5; }

/* --------------------------------------------------- 正文：垂直节奏核心 */
.rd-content {
  /* 段距统一由此变量驱动，工具条可实时调节。 */
  --rd-gap: ${prefs.paraGap}em;
  font-size: 1em;
}

/* 先全局归零，再用白名单重建间距——顺序很重要。 */
.rd-content * { margin-block: 0; }

.rd-content p,
.rd-content ul,
.rd-content ol,
.rd-content dl,
.rd-content blockquote,
.rd-content pre,
.rd-content figure,
.rd-content table,
.rd-content h1, .rd-content h2, .rd-content h3,
.rd-content h4, .rd-content h5, .rd-content h6 {
  margin-block: var(--rd-gap);
}

.rd-content > :first-child { margin-block-start: 0; }
.rd-content > :last-child { margin-block-end: 0; }

/* 标题与后文拉开一些，与前文收紧。 */
.rd-content h1, .rd-content h2, .rd-content h3,
.rd-content h4, .rd-content h5, .rd-content h6 {
  margin-block-start: calc(var(--rd-gap) * 1.6);
  margin-block-end: calc(var(--rd-gap) * .55);
  line-height: 1.35;
  font-weight: 700;
}
.rd-content h1 { font-size: 1.6em; }
.rd-content h2 { font-size: 1.35em; }
.rd-content h3 { font-size: 1.15em; }
.rd-content h4, .rd-content h5, .rd-content h6 { font-size: 1em; }

/* 相邻标题不叠加间距。 */
.rd-content h1 + h2, .rd-content h2 + h3, .rd-content h3 + h4 { margin-block-start: 0; }

/* 段落之间不留额外空隙（已由 margin-block 提供），避免视觉上的双倍行距。 */
.rd-content p + p { margin-block-start: var(--rd-gap); }

/* ------------------------------------------------------- 兜底层：空元素 */
/*
 * 只做「纯 CSS 能准确判定」的兜底，JS 管线是主力，这里是双保险。
 *
 * 只用 :empty —— 它的语义明确：匹配「完全没有子节点」的元素。
 * 空的段落标签命中；含空白文本节点的段落不命中，交由 JS 处理。
 *
 * 刻意不写下面这两类看似聪明、实则危险的选择器（都曾在实机暴露或险些出错）：
 *
 *   1. p:not(:has(*)):not(:empty)
 *      实际含义是「有文字但没有嵌套元素的段落」——会把绝大多数正常正文段落
 *      全部隐藏。jsdom 不做布局，单元测试无法发现，只有在真实浏览器里才暴露。
 *
 *   2. p:has(> br:only-child)
 *      :only-child 忽略文本节点，因此「br + 正文」形态的段落也会命中并被
 *      整体隐藏。该形态已由 collapseBrRuns（删除块首尾孤立 br）处理。
 *
 * 结论：不要在这里加反直觉的 :has()/:not() 组合。要加规则，先用真实浏览器验证。
 */
.rd-content p:empty,
.rd-content div:empty,
.rd-content span:empty,
.rd-content li:empty { display: none; }

/* ------------------------------------------------------------- 链接 */
.rd-content a { color: ${t.link}; text-decoration: none; border-bottom: 1px solid transparent; }
.rd-content a:hover { border-bottom-color: currentColor; }
.rd-content a:visited { color: ${t.link}; }
.rd-content ::selection { background: ${t.selBg}; }

/* 补齐被清理掉下划线的锚点（阅读模式下不可见更自然）。 */
.rd-content a[href^="#"]:empty { display: block; }

/* ------------------------------------------------------------- 列表 */
.rd-content ul, .rd-content ol { padding-inline-start: 1.6em; }
.rd-content li { margin-block: calc(var(--rd-gap) * .3); }
.rd-content li > p { margin-block: calc(var(--rd-gap) * .3); }
.rd-content li > ul, .rd-content li > ol { margin-block: calc(var(--rd-gap) * .3); }

/* ------------------------------------------------------------- 引用 */
.rd-content blockquote {
  padding-inline-start: 1.1em;
  border-inline-start: .22em solid ${t.quoteBar};
  color: ${t.muted};
}

/* ------------------------------------------------------------- 代码 */
.rd-content code, .rd-content kbd, .rd-content samp {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: .9em;
  background: ${t.codeBg};
  padding: .15em .38em;
  border-radius: .25em;
  /* 关键：清理管线会剥掉内联 color，这里用 inherit 保证暗色主题下仍可读。 */
  color: inherit;
  white-space: pre-wrap;
  word-break: break-word;
}
.rd-content pre {
  background: ${t.codeBg};
  padding: .9em 1.1em;
  border-radius: .4em;
  overflow-x: auto;
  font-size: .9em;
  line-height: 1.55;
}
.rd-content pre code {
  background: none;
  padding: 0;
  font-size: 1em;
  white-space: pre;
  word-break: normal;
}

/* ------------------------------------------------------------- 图片 */
.rd-content img, .rd-content video, .rd-content svg, .rd-content canvas {
  max-width: 100%;
  height: auto;
  display: block;
  margin-inline: auto;
  border-radius: .35em;
}
.rd-content figure { text-align: center; }
.rd-content figcaption { font-size: .85em; color: ${t.muted}; margin-top: .5em; }

/* 懒加载兜底：清理阶段可能已把 src 转为绝对地址。 */
.rd-content img[src=""], .rd-content img:not([src]) { display: none; }

/* ------------------------------------------------------------- 表格 */
.rd-content table {
  width: 100%;
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
  font-size: .95em;
}
.rd-content th, .rd-content td {
  border: 1px solid ${t.barBorder};
  padding: .45em .7em;
  text-align: start;
  /* 空单元格也要保住边框，维持表格结构可读。 */
  min-width: 2em;
}
.rd-content th { background: ${t.codeBg}; font-weight: 600; }

/* ------------------------------------------------------------- 分隔线 */
.rd-content hr {
  border: 0;
  border-top: 1px solid ${t.barBorder};
  margin-block: calc(var(--rd-gap) * 1.5);
}

/* --------------------------------------------------------- 自动续页：章节分隔与状态 */
/* 追加进来的每一章之间用一条分隔线 + 章节名，让读者能看出边界。 */
.rd-chapter-sep {
  display: flex;
  align-items: center;
  gap: .8em;
  margin-block: calc(var(--rd-gap) * 2.4);
  color: ${t.muted};
  font-size: .85em;
  letter-spacing: .04em;
}
.rd-chapter-sep::before,
.rd-chapter-sep::after {
  content: "";
  flex: 1 1 auto;
  height: 1px;
  background: ${t.barBorder};
}
.rd-chapter-sep span {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 底部状态提示：加载中 / 已到末尾 / 出错。
   它是 shadow root 的直接子元素（在滚动容器之外），因此这里的 absolute
   是相对宿主（:host 全屏）定位，能真正固定在视口底部。
   若放进滚动容器内部，absolute 会相对「内容」定位、随滚动移动。 */
.rd-status {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 2;
  padding: .85em 1.2em;
  text-align: center;
  font-size: .85em;
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
  color: ${t.muted};
  background: ${t.barBg};
  border-top: 1px solid ${t.barBorder};
  backdrop-filter: blur(8px);
}
/* 小屏时工具条贴在底部，状态条上移，避免两者重叠 */
@media (max-width: 640px) {
  .rd-status { bottom: 3.6rem; }
}
/* 加载中：加一个脉动圆点，给出「正在工作」的反馈 */
.rd-status[data-state="loading"]::before {
  content: "";
  display: inline-block;
  width: .5em;
  height: .5em;
  margin-inline-end: .5em;
  border-radius: 50%;
  background: ${t.link};
  vertical-align: middle;
  animation: rd-pulse 1s ease-in-out infinite;
}
.rd-status[data-state="end"] { color: ${t.muted}; }
.rd-status[data-state="error"] { color: #c0392b; }

@keyframes rd-pulse {
  0%, 100% { opacity: .3; transform: scale(.8); }
  50%      { opacity: 1;  transform: scale(1.15); }
}

/* 尊重「减少动态效果」的系统设置 */
@media (prefers-reduced-motion: reduce) {
  .rd-status[data-state="loading"]::before { animation: none; opacity: 1; }
}

/* --------------------------------------------------------- 工具条 */
.rd-bar {
  position: absolute;
  /* 居中方式很关键：不要用 left:50% + transform:translateX(-50%)。
     绝对定位元素在 width 为 auto 时的可收缩宽度是「左边界 → 容器右边缘」，
     写成 left:50% 就只剩半个屏幕宽，工具条必然被迫换行（实测踩过）。
     用 inset-inline:0 + margin:auto + fit-content，可收缩宽度才是整屏。 */
  inset-inline: 0;
  top: .9rem;
  margin-inline: auto;
  width: fit-content;
  display: flex;
  align-items: center;
  gap: .15rem;
  padding: .32rem .4rem;
  background: ${t.barBg};
  border: 1px solid ${t.barBorder};
  border-radius: 999px;
  box-shadow: 0 4px 18px rgba(0,0,0,.13);
  backdrop-filter: blur(10px);
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: 13px;
  line-height: 1;
  max-width: calc(100% - 1.5rem);
  flex-wrap: wrap;
  justify-content: center;
}
.rd-bar button {
  all: unset;
  cursor: pointer;
  padding: .42em .6em;
  border-radius: 999px;
  color: ${t.fg};
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: .3em;
}
.rd-bar button:hover { background: ${t.barHover}; }
.rd-bar button:focus-visible { outline: 2px solid ${t.link}; outline-offset: 1px; }
.rd-bar button[aria-pressed="true"] { background: ${t.barHover}; font-weight: 600; }
.rd-bar .rd-bar-sep {
  width: 1px;
  height: 1.15em;
  background: ${t.barBorder};
  margin-inline: .3em;
  flex: none;
}
.rd-bar .rd-label { color: ${t.muted}; padding-inline: .35em; font-variant-numeric: tabular-nums; }
.rd-bar .rd-close { margin-inline-start: .2em; }
.rd-bar .rd-num { min-width: 2.4em; text-align: center; color: ${t.muted}; font-variant-numeric: tabular-nums; }

/* 小屏：工具条贴底，避免遮挡标题。 */
@media (max-width: 640px) {
  .rd-bar { top: auto; bottom: .8rem; }
  .rd-scroll { padding-top: 2rem; }
}
`;
}

/** 取主题调色板（非法主题回退浅色）。 */
function themeOf(name) {
  return THEMES[name] || THEMES.light;
}

/** 取页宽值（非法页宽回退中号）。 */
function widthOf(name) {
  return WIDTHS[name] || WIDTHS.medium;
}

/**
 * 宿主元素需要的内联样式。
 *
 * 为什么必须内联：宿主内联写了 `all: initial`（用于阻断页面样式继承），
 * 而内联样式优先级最高——它会把 color / background / font-* 一并重置为初始值，
 * 使得写在 :host 规则里的主题色完全失效（实测踩过：深色主题下正文仍是黑字）。
 * 因此凡是被 all:initial 重置、又需要按主题变化的属性，都必须在这里以
 * 内联形式补回来。:host 规则里的同名声明退化为「内联未及设置时」的兜底。
 *
 * @param {object} prefs
 * @returns {Object<string,string>} CSS 属性（kebab-case）→ 值
 */
function hostInlineStyle(prefs) {
  const t = themeOf(prefs.theme);
  const width = widthOf(prefs.width);
  return {
    // 主题色：必须内联，否则会被 all:initial 重置为初始值
    "background-color": t.bg,
    color: t.fg,
    // 文字排版：同样被 all:initial 重置，内联补回
    "font-family": prefs.fontFamily,
    "font-size": `${prefs.fontSize}px`,
    "line-height": String(prefs.lineHeight),
    // 自定义属性不参与 all 重置，但仍统一在此设置，便于样式表引用
    "--rd-page-width": width,
    "--rd-font-family": prefs.fontFamily,
    "--rd-font-size": `${prefs.fontSize}px`,
    "--rd-line-height": String(prefs.lineHeight),
    "--rd-para-gap": `${prefs.paraGap}em`,
  };
}

const api = { THEMES, WIDTHS, buildCss, themeOf, widthOf, hostInlineStyle };

if (typeof module === "object" && module.exports) {
  module.exports = api;
} else {
  root.ReaderStyles = api;
}
})(typeof globalThis !== "undefined" ? globalThis : this);
