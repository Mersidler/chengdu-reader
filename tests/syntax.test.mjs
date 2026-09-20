/**
 * 全量脚本的语法校验。
 *
 * 为什么单独做这件事：本项目所有模块都是「普通脚本 + 全局变量」（Firefox 的
 * content script 不支持 ES module import），模块内部大量使用模板字符串生成
 * CSS/HTML。一旦在模板字符串里写入反引号，模板会被提前截断、整个脚本语法错误。
 * 这个坑我踩了两次（styles.js 的 CSS 注释里写了反引号），而其他测试文件
 * 只在 import 时才加载对应模块——写错的模块可能整轮测试都不被触达。
 *
 * 所以这里不依赖 import，直接用子进程对每个脚本跑语法检查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** 递归收集 src 下的全部 .js。 */
function collectScripts(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectScripts(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

const SCRIPTS = collectScripts(join(ROOT, "src"));

test("语法：src 下每个脚本都能通过 node --check", () => {
  assert.ok(SCRIPTS.length >= 10, `应至少发现 10 个脚本，实际 ${SCRIPTS.length}`);

  const failures = [];
  for (const file of SCRIPTS) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (err) {
      failures.push(
        `${relative(ROOT, file)}:\n${String(err.stderr || err.message).trim()}`
      );
    }
  }

  assert.deepEqual(failures, [], `以下脚本存在语法错误：\n${failures.join("\n\n")}`);
});

/**
 * 找出源码中所有模板字符串的区间 [start, end)。
 * 正确处理转义、${} 嵌套、以及模板内的普通引号。
 */
function findTemplateSpans(src) {
  const spans = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // 跳过普通字符串，避免其中的反引号被误认为模板起点
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    // 跳过行注释
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    // 跳过块注释
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "`") {
      const start = i;
      i++;
      let depth = 0;
      while (i < src.length) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
        if (c === "}" && depth > 0) { depth--; i++; continue; }
        // 深度为 0 时遇到反引号 → 模板结束
        if (c === "`" && depth === 0) { i++; break; }
        i++;
      }
      spans.push([start, i]);
      continue;
    }
    i++;
  }
  return spans;
}

test("语法：模板字符串内的注释不含反引号（该坑踩过两次）", () => {
  const offenders = [];

  for (const file of SCRIPTS) {
    const src = readFileSync(file, "utf8");
    const spans = findTemplateSpans(src);

    for (const [start, end] of spans) {
      const body = src.slice(start + 1, end - 1);
      // 模板体内若还有反引号，说明原写法有问题（会被解析器提前截断）。
      // 这里用嵌套反引号的出现位置反推源码行号，给出可定位的提示。
      if (!body.includes("`")) continue;
      const line = src.slice(0, start).split("\n").length;
      offenders.push(
        `${relative(ROOT, file)}:${line} 的模板字符串内部出现反引号`
      );
    }
  }

  assert.deepEqual(
    offenders, [],
    `模板字符串被反引号截断（表现为 SyntaxError: Unexpected identifier）：\n${offenders.join("\n")}`
  );
});

test("语法：styles.js 的 CSS 模板可正常生成", () => {
  // styles.js 用模板字符串拼 CSS，最容易被反引号破坏，单独再做一次实跑。
  const prefs = require("../src/content/prefs.js");
  const styles = require("../src/content/styles.js");
  const css = styles.buildCss(prefs.DEFAULTS);
  assert.ok(css.length > 2000, `生成的 CSS 过短（${css.length}），可能被截断`);
  assert.match(css, /\.rd-content/, "应包含正文样式");
  assert.match(css, /\.rd-bar/, "应包含工具条样式");
  assert.match(css, /:host/, "应包含宿主样式");
});

