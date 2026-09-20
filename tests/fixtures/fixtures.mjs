/**
 * 各类「脏」HTML 样本。每个样本都对应真实站点上常见的空白行来源。
 * 命名：因由_场景。
 */

export const FIXTURES = {
  /** 最经典：空段落、只有 <br> 的段落、&nbsp; 段落。 */
  classicEmptyParagraphs: `
    <div id="root">
      <p>第一段有内容。</p>
      <p></p>
      <p> </p>
      <p>&nbsp;</p>
      <p><br></p>
      <p><br><br></p>
      <p><span></span></p>
      <p><span>  </span></p>
      <p>第二段有内容。</p>
    </div>
  `,

  /** 空 div 层层嵌套（Word / 公众号复制粘贴的典型结构）。 */
  nestedEmptyDivs: `
    <div id="root">
      <p>正文一。</p>
      <div><div></div></div>
      <div><div><div>  </div></div></div>
      <div><p>&nbsp;</p></div>
      <p>正文二。</p>
    </div>
  `,

  /** 连排 <br> 制造的空行。 */
  brRuns: `
    <div id="root">
      <p>正文一。</p>
      <p>行内换行<br><br><br><br>后面还有字。</p>
      <p><br></p>
      <p>正文二。</p>
    </div>
  `,

  /**
   * ★ 本扩展的核心价值场景 ★
   *
   * Readability 的判空正则是 /^\s*$/，而 JS 的 \s **不包含** \u200b / \u200c / \u200d。
   * 因此「只含零宽字符的段落」会被 Readability 完整保留下来——
   * 渲染出来就是一行空空如也的空白行。公众号、CMS、Word 粘贴的内容里极常见。
   *
   * 这一组用例是本扩展相对「Readability / Firefox 原生阅读模式」的真实增量。
   */
  zeroWidthParagraphs: `
    <div id="root">
      <p>正文一。</p>
      <p>\u200b\u200b\u200b</p>
      <p>\u200c\u200d</p>
      <p>\u2060</p>
      <p>\ufeff</p>
      <p>\u200b \u200b</p>
      <p>&nbsp;\u200b&nbsp;</p>
      <p>正文二。</p>
    </div>
  `,

  /** 零宽字符与其它空白混合。 */
  zeroWidthMixed: `
    <div id="root">
      <p>正文一。</p>
      <p><span>\u200b</span></p>
      <p><span><span>\u200b\u200c</span></span></p>
      <div>\u200b</div>
      <p><br>\u200b</p>
      <p>正文二。</p>
    </div>
  `,

  /** 作者内联大 margin/padding：视觉空白的第二大来源。 */
  inlineVerticalSpacing: `
    <div id="root">
      <p>正文一。</p>
      <div style="margin: 60px 0;"></div>
      <p style="margin-top: 40px; margin-bottom: 40px;">正文二。</p>
      <p style="margin: 80px 0 20px 0;">正文三。</p>
      <div style="padding: 50px 0;">正文四。</div>
    </div>
  `,

  /** 必须保住的东西：图片、hr、表格、视频、装饰背景块。 */
  mustKeep: `
    <div id="root">
      <p>正文一。</p>
      <p></p>
      <p><img src="a.png" alt="图"></p>
      <p><picture><source srcset="b.webp"><img src="b.png"></picture></p>
      <hr>
      <p><video src="v.mp4"></video></p>
      <p><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></p>
      <div style="background-image: url(deco.png)"></div>
      <div style="border-top: 1px solid #ccc;"></div>
      <p></p>
      <p>正文二。</p>
    </div>
  `,

  /** 空白有意义的地方，一行都不能动。 */
  whitespaceSignificant: `
    <div id="root">
      <p>正文一。</p>
      <pre>
  function f() {
      return 1;
  }
      </pre>
      <p>正文二。<code>a    +    b</code> 结束。</p>
      <textarea>  保留   我  </textarea>
      <p>&nbsp;</p>
      <p>正文三。</p>
    </div>
  `,

  /** 表格结构：空的 <td> 是合法布局，绝不能删。 */
  tableStructure: `
    <div id="root">
      <p>正文一。</p>
      <table>
        <tbody>
          <tr><th>列一</th><th>列二</th></tr>
          <tr><td></td><td>值</td></tr>
          <tr><td>  </td><td>&nbsp;</td></tr>
        </tbody>
      </table>
      <p></p>
      <p>正文二。</p>
    </div>
  `,

  /** 首尾留白：文章最开头和结尾的大片空白。 */
  edgeWhitespace: `
    <div id="root">
      <p></p>
      <p>&nbsp;</p>
      <div style="height: 40px;"></div>
      <p>唯一一段正文。</p>
      <p></p>
      <div></div>
      <p> </p>
    </div>
  `,

  /** 锚点元素必须保留（会断掉目录跳转）。 */
  anchorTargets: `
    <div id="root">
      <p>正文一。</p>
      <a id="section-2"></a>
      <a name="legacy-anchor"></a>
      <p></p>
      <p>正文二。</p>
    </div>
  `,

  /** 列表：空 li 应删，但列表结构本身要保住。 */
  lists: `
    <div id="root">
      <p>正文一。</p>
      <ul>
        <li>项目一</li>
        <li></li>
        <li>   </li>
        <li>&nbsp;</li>
        <li>项目二</li>
      </ul>
      <ol>
        <li>有序一</li>
        <li><p>&nbsp;</p></li>
        <li>有序二</li>
      </ol>
      <p>正文二。</p>
    </div>
  `,

  /** 注释节点与残留脚本。 */
  invisibleJunk: `
    <div id="root">
      <p>正文一。</p>
      <!-- 这是注释 -->
      <!--[if IE]><p>IE 专用</p><![endif]-->
      <script>console.log(1)</script>
      <style>.x { color: red }</style>
      <noscript><p>无脚本提示</p></noscript>
      <p>正文二。</p>
      <p aria-hidden="true">装饰性文字</p>
    </div>
  `,

  /** 公众号 / 富文本典型：多层 span + 内联字号颜色。 */
  richTextPaste: `
    <div id="root">
      <p style="font-size: 17px; color: rgb(63,63,63); line-height: 1.75;">
        <span style="font-size: 17px; color: rgb(63,63,63);">正文一。</span>
      </p>
      <p style="font-size: 17px;"><span style="font-size: 17px;"><br></span></p>
      <p style="margin-top: 30px; font-size: 17px; color: #333;">
        <span style="color: #333;">正文二。</span>
      </p>
    </div>
  `,
};
