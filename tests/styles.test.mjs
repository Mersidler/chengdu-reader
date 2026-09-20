/**
 * 样式表的静态守卫。
 *
 * 为什么需要这个文件：样式 bug（尤其是 :has()/:not() 组合）只在**真实浏览器布局**下
 * 才暴露，jsdom 不做布局、甚至不支持 :has()，所以行为测试无法覆盖。
 * 实测教训：曾写下 `.rd-content p:not(:has(*)):not(:empty) { display: none }`，
 * 它的实际含义是「有文字但无嵌套元素的段落」，把几乎所有正文段落都隐藏了，
 * 93 个 jsdom 测试全部通过、却在真实浏览器里一片空白。
 *
 * 因此这里对生成的 CSS 做静态断言：禁止已知危险的选择器形态，
 * 并要求关键的「不隐藏正文」保障存在。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Styles = require("../src/content/styles.js");
const Prefs = require("../src/content/prefs.js");

/** 生成各主题/各页宽下的全部样式表，确保没有漏网的分支。 */
function allCss() {
  const out = [];
  for (const theme of Prefs.THEME_CYCLE) {
    for (const width of Prefs.WIDTH_CYCLE) {
      out.push({
        label: `${theme}/${width}`,
        css: Styles.buildCss(Object.assign({}, Prefs.DEFAULTS, { theme, width })),
      });
    }
  }
  return out;
}

/** 去掉 CSS 注释，只保留真实规则（注释里会提到危险选择器，不能误判）。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

test("样式：禁止 :not(:has(...)) 这类反直觉的隐藏规则", () => {
  for (const { label, css } of allCss()) {
    const rules = stripComments(css);
    // 危险形态 1：`p:not(:has(*))` —— 含义是「没有子元素的段落」，即正常纯文本段落
    assert.ok(
      !/:\s*not\(\s*:\s*has\(/i.test(rules),
      `${label}：样式表中出现 :not(:has(...))，会把正常段落隐藏，实测曾导致正文全部不可见`
    );
  }
});

test("样式：禁止 :only-child 与 :has 组合用于隐藏段落", () => {
  for (const { label, css } of allCss()) {
    const rules = stripComments(css);
    // `:has(> br:only-child)` 的 :only-child 忽略文本节点，
    // 「br + 文字」的段落也会命中而被整体隐藏。
    assert.ok(
      !/:has\([^)]*:only-child[^)]*\)/i.test(rules),
      `${label}：:has(... :only-child ...) 会误伤「br + 文字」的段落`
    );
  }
});

/**
 * 允许 display:none 的选择器白名单。
 *
 * 每一条都必须「只针对确定无内容/无意义的元素」，且不能命中正常正文。
 * 新增规则时必须在此登记并说明理由，避免悄悄引入误伤。
 */
const ALLOWED_HIDDEN = [
  // 空元素：语义明确，不可能含内容
  { re: /:empty\s*$/, why: "完全无子节点的空元素" },
  // 无 src 的图片：懒加载失败/占位，渲染出来是破图，隐藏更干净
  { re: /img\[src=""\]\s*$/, why: "空 src 的破图" },
  { re: /img:not\(\[src\]\)\s*$/, why: "无 src 属性的破图" },
];

test("样式：display:none 只用于白名单内的安全选择器", () => {
  for (const { label, css } of allCss()) {
    const rules = stripComments(css);
    const hidden = [...rules.matchAll(/([^{}]+)\{[^{}]*display:\s*none/gi)]
      .map((m) => m[1].trim())
      .filter((sel) => !sel.startsWith("@"));

    for (const group of hidden) {
      // 逗号分隔的选择器组，逐个检查
      for (const sel of group.split(",").map((s) => s.trim()).filter(Boolean)) {
        const ok = ALLOWED_HIDDEN.some((rule) => rule.re.test(stripPseudo(sel)));
        assert.ok(
          ok,
          `${label}：display:none 的选择器不在白名单内：${sel}\n` +
            `  如确为有意为之，请在 tests/styles.test.mjs 的 ALLOWED_HIDDEN 中登记并说明理由。`
        );
      }
    }
  }
});

/** 参与匹配时忽略选择器上的伪类（:hover 等不改变「是否命中正文」的判断）。 */
function stripPseudo(sel) {
  return sel.replace(/:(hover|focus|focus-visible|visited|active|target|root)\b/g, "");
}

test("样式：正文段落没有被整类隐藏的风险", () => {
  for (const { label, css } of allCss()) {
    const rules = stripComments(css);
    // 明确要求：不存在「无条件隐藏 p」的规则
    const blanketHide = [...rules.matchAll(/([^{}]+)\{[^{}]*display:\s*none/gi)]
      .map((m) => m[1].trim())
      .filter((sel) => /(^|[\s,>])p\s*(\{|,|$)/.test(sel) && !/:empty/.test(sel));
    assert.deepEqual(
      blanketHide, [],
      `${label}：存在无条件隐藏 <p> 的规则：${blanketHide.join(" | ")}`
    );
  }
});

test("样式：段距由 --rd-gap 变量驱动（可实时调节）", () => {
  for (const { label, css } of allCss()) {
    assert.match(css, /--rd-gap\s*:/, `${label}：缺少 --rd-gap 变量定义`);
    assert.match(css, /margin-block:\s*var\(--rd-gap\)/, `${label}：段距未绑定到 --rd-gap`);
  }
});

test("样式：包含必要的兜底空元素规则", () => {
  const css = Styles.buildCss(Prefs.DEFAULTS);
  for (const sel of ["p:empty", "div:empty", "span:empty", "li:empty"]) {
    assert.ok(css.includes(sel), `缺少兜底规则：${sel}`);
  }
});

test("样式：宿主为全屏固定浮层且重置继承", () => {
  const css = Styles.buildCss(Prefs.DEFAULTS);
  assert.match(css, /:host\s*\{[^}]*position:\s*fixed/s, ":host 应为固定定位");
  assert.match(css, /:host\s*\{[^}]*all:\s*initial/s, ":host 应重置继承样式");
  assert.match(css, /:host\s*\{[^}]*z-index:\s*2147483647/s, ":host 应处于最高层级");
});

test("样式：结构性元素不被隐藏（表格/图片/代码）", () => {
  const css = Styles.buildCss(Prefs.DEFAULTS);
  // 表格要能横向滚动而不溢出
  assert.match(css, /\.rd-content table\s*\{[^}]*overflow-x:\s*auto/s, "表格应可横向滚动");
  // 图片自适应
  assert.match(css, /\.rd-content img[^{]*\{[^}]*max-width:\s*100%/s, "图片应限制最大宽度");
  // 代码块横向滚动
  assert.match(css, /\.rd-content pre\s*\{[^}]*overflow-x:\s*auto/s, "代码块应可横向滚动");
  // 代码颜色继承，保证暗色主题可读
  assert.match(css, /\.rd-content code[^{]*\{[^}]*color:\s*inherit/s, "行内代码颜色应继承，避免暗色主题下不可读");
});

test("样式：工具条居中方式不会导致被迫换行", () => {
  for (const { label, css } of allCss()) {
    const rules = stripComments(css);
    const barRule = /\.rd-bar\s*\{([^}]*)\}/s.exec(rules);
    assert.ok(barRule, `${label}：缺少 .rd-bar 规则`);
    const body = barRule[1];

    // 反例：absolute + left:50% 的可收缩宽度只有容器一半 → 必然换行（实机踩过）
    assert.ok(
      !/left\s*:\s*50%/.test(body),
      `${label}：.rd-bar 使用 left:50% 会让可收缩宽度只剩半屏，导致工具条被迫换行`
    );
    // 正解：inset-inline:0 + margin auto + fit-content
    assert.match(body, /inset-inline\s*:\s*0/, `${label}：.rd-bar 应用 inset-inline:0`);
    assert.match(body, /margin-inline\s*:\s*auto/, `${label}：.rd-bar 应用 margin-inline:auto`);
    assert.match(body, /width\s*:\s*fit-content/, `${label}：.rd-bar 应用 width:fit-content`);
  }
});

test("样式：滚动容器为工具条预留了顶部留白（兜底值）", () => {
  const css = Styles.buildCss(Prefs.DEFAULTS);
  const scrollRule = /\.rd-scroll\s*\{([^}]*)\}/s.exec(stripComments(css));
  assert.ok(scrollRule, "缺少 .rd-scroll 规则");
  // 首帧脚本未执行时也不能让正文压到工具条下面
  assert.match(
    scrollRule[1], /padding:\s*[\d.]+rem/,
    "应在 CSS 里给出兜底的顶部留白（JS 随后会按实测高度覆盖）"
  );
});

test("样式：状态条必须相对宿主定位（不能放进滚动容器）", () => {
  // 回归：状态条曾在滚动容器内部使用 position:absolute。滚动容器的
  // overflow:auto 使 absolute 子元素相对「内容」定位，bottom:0 指向内容底部，
  // 于是提示条出现在正文中间——只有真实浏览器布局才会暴露这个问题。
  const css = stripComments(Styles.buildCss(Prefs.DEFAULTS));
  const statusRule = /\.rd-status\s*\{([^}]*)\}/s.exec(css);
  assert.ok(statusRule, "缺少 .rd-status 规则");
  const body = statusRule[1];
  assert.match(body, /position:\s*absolute/, "状态条应为绝对定位");
  assert.match(body, /bottom:\s*0/, "状态条应贴底");
  assert.match(body, /left:\s*0/, "状态条应横向铺满");
  assert.match(body, /right:\s*0/, "状态条应横向铺满");
  // 必须在滚动容器之上，否则会被内容盖住
  assert.match(body, /z-index\s*:\s*[1-9]/, "状态条应有正 z-index，避免被正文覆盖");
});

test("样式：小屏时状态条与底部工具条不重叠", () => {
  const css = stripComments(Styles.buildCss(Prefs.DEFAULTS));
  // 小屏媒体查询里工具条贴底，状态条需要上移
  const smallScreen = /@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(smallScreen, "应存在小屏媒体查询");
  assert.match(
    smallScreen[1], /\.rd-status\s*\{[^}]*bottom\s*:/s,
    "小屏时状态条应上移，避免和贴底的工具条重叠"
  );
});

test("样式：章节分隔线可辨识", () => {
  const css = stripComments(Styles.buildCss(Prefs.DEFAULTS));
  assert.match(css, /\.rd-chapter-sep/, "缺少章节分隔线样式");
  // 应有左右延伸的横线
  assert.match(css, /\.rd-chapter-sep::before[\s\S]{0,200}background:/, "分隔线应有可见横线");
});

test("样式：degradation - 非法主题/页宽回退到默认且结构完整", () => {
  const css = Styles.buildCss({ theme: "不存在", width: "不存在", fontSize: 18, lineHeight: 1.8, paraGap: 1, fontFamily: "system-ui" });
  assert.match(css, /#ffffff/, "非法主题应回退浅色");
  assert.match(css, /44rem/, "非法页宽应回退中号");
  assert.match(css, /\.rd-content/, "正文样式应完整");
});
