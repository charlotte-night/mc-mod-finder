// 生成《MC Mod Finder — 问题 / 提示词 / 结果》Word 文档（原生 docx，零依赖）
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const OUT_DIR = 'E:\\dsh\\mc-mod-finder\\docs';
const OUT_FILE = OUT_DIR + '\\MC Mod Finder 问题-提示词-结果.docx';

/* ---------------- 基础工具 ---------------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT_BODY = '等线';
const FONT_HEAD = '微软雅黑';
const FONT_MONO = 'Consolas';

/** 富文本：`**粗体**`、反引号包住的等宽片段 */
function rich(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((s) => s !== '');
  return parts.map((part) => {
    let m;
    if ((m = part.match(/^\*\*([^*]+)\*\*$/))) {
      return `<w:r><w:rPr><w:rFonts w:ascii="${FONT_BODY}" w:hAnsi="${FONT_BODY}" w:eastAsia="${FONT_BODY}"/><w:b/></w:rPr><w:t xml:space="preserve">${esc(m[1])}</w:t></w:r>`;
    }
    if ((m = part.match(/^`([^`]+)`$/))) {
      return `<w:r><w:rPr><w:rFonts w:ascii="${FONT_MONO}" w:hAnsi="${FONT_MONO}" w:eastAsia="${FONT_BODY}"/><w:sz w:val="18"/><w:color w:val="9C3F1F"/></w:rPr><w:t xml:space="preserve">${esc(m[1])}</w:t></w:r>`;
    }
    return `<w:r><w:rPr><w:rFonts w:ascii="${FONT_BODY}" w:hAnsi="${FONT_BODY}" w:eastAsia="${FONT_BODY}"/></w:rPr><w:t xml:space="preserve">${esc(part)}</w:t></w:r>`;
  }).join('');
}

/** 组装一个段落：inner 是若干 <w:r> */
const wrapPara = (inner, { style, align, spaceBefore = 0, spaceAfter = 60, keepNext = false, indent } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}` +
  `${keepNext ? '<w:keepNext/>' : ''}` +
  `<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}" w:line="300" w:lineRule="auto"/>` +
  `${indent ? `<w:ind w:left="${indent.left}" w:hanging="${indent.hanging}"/>` : ''}` +
  `${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>${inner}</w:p>`;

const para = (text, opts = {}) => wrapPara(rich(text), opts);

const bullet = (text) =>
  wrapPara(rich(`· ${text}`), { spaceAfter: 30, indent: { left: 340, hanging: 220 } });

const codeBlock = (lines) =>
  lines
    .map((line, index) =>
      wrapPara(
        `<w:r><w:rPr><w:rFonts w:ascii="${FONT_MONO}" w:hAnsi="${FONT_MONO}" w:eastAsia="${FONT_BODY}"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(line) || ' '}</w:t></w:r>`,
        {
          style: 'CodeBlock',
          spaceBefore: index === 0 ? 60 : 0,
          spaceAfter: index === lines.length - 1 ? 100 : 0,
        },
      ),
    )
    .join('');

const table = (widths, rows, { headerFill = 'EFF3F7' } = {}) => {
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const body = rows
    .map((cells, rowIndex) => {
      const isHeader = rowIndex === 0;
      const tcs = cells
        .map((cellText, i) => {
          const shade = isHeader ? `<w:shd w:val="clear" w:color="auto" w:fill="${headerFill}"/>` : '';
          const runs = rich(cellText);
          return (
            `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${shade}<w:vAlign w:val="center"/></w:tcPr>` +
            `<w:p><w:pPr><w:spacing w:before="20" w:after="20" w:line="260" w:lineRule="auto"/>${isHeader ? '<w:jc w:val="center"/>' : ''}</w:pPr>` +
            `${isHeader ? runs.replace(/<w:rPr>/g, '<w:rPr><w:b/>') : runs}</w:p></w:tc>`
          );
        })
        .join('');
      const trPr = isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${trPr}${tcs}</w:tr>`;
    })
    .join('');
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>` +
    `<w:tblBorders>` +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="B7C2CE"/>`)
      .join('') +
    `</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
  );
};

const EMPTY = '<w:p><w:pPr><w:spacing w:after="0" w:line="200" w:lineRule="auto"/></w:pPr></w:p>';
const h1 = (t) => para(t, { style: 'Heading1', spaceBefore: 200, spaceAfter: 80, keepNext: true });
const h2 = (t) => para(t, { style: 'Heading2', spaceBefore: 140, spaceAfter: 60, keepNext: true });

/* ---------------- 文档内容 ---------------- */
const stageRows = [
  ['1', '模糊需求', '“想做一个我的世界模组网站，能搜模组和整合包。”', '定下定位：只做**检索与推荐**，不做下载托管；技术底线是**零依赖 Node**。'],
  ['2', '跨平台检索', '“搜索要能同时搜 Modrinth、CurseForge，但要按名称、游戏版本、类型筛。”', '多数据源并行查询 + 字段归一化 + 跨平台去重（同名保留下载量高的那条）。'],
  ['3', '排序依据', '“结果要能按下载速度以及是否免费来推荐。”', '推荐分 = 6 维加权：相关度 30%、下载量 20%、速度 20%、免费 15%、更新 10%、关注 5%。'],
  ['4', '真实速度', '“速度不要估算，要真的测；但只测一小段，别把整个包拖下来。”', 'Range 分块只读 1 MiB、6 秒超时、并发 3；**速度 = 读取字节 ÷ 流式时间，排除首字节延迟**。'],
  ['5', '可解释可调', '“推荐依据要看得见，权重我想自己拖；慢一点不算失败、同一个 CDN 别重复测。”', '卡片列出各维度得分与贡献；6 个滑条实时重排并本地保存；按 CDN 主机缓存 10 分钟，超时但有样本仍给速率。'],
  ['6', '收尾与公开', '“要能双击就用、不弹黑窗；别人也想用，怎么给外面访问？先说清风险。”', '桌面快捷方式 + 纯 ASCII 启动脚本，失败自动打开日志；三种公开方案 + 默认限流，避免测速口被当成免费下载器。'],
];
const stageTable = table([560, 1000, 3400, 4400], [['阶段', '需求状态', '用户提示词（演进）', '对应结果'], ...stageRows]);

const featureTable = table(
  [1500, 7860],
  [
    ['核心功能', '落到的结果'],
    ['一、跨平台搜索', '一次输入同时查 Modrinth 与 CurseForge，按名称 + 游戏版本 + 加载器 + 类型（模组/整合包/资源包/光影/数据包）过滤；同一项目在两个平台重复时按下载量去重。'],
    ['二、按速度与免费推荐', '推荐分由 6 个维度加权得出，**每个维度的得分、权重、贡献都在结果卡片上列明**；权重滑条可实时调整并本地保存，调到速度 60% 即完全按速度排序。'],
    ['三、真实测速闭环', '点「为推荐测速」后服务端真下载一小段采样，客户端带着新速度重新搜索（命中缓存，毫秒级返回），排序随之变化；同一 CDN 只发一次真实请求，其余复用。'],
    ['四、诚实的数据源策略', '有公开 API 的（Modrinth / CurseForge）接入并实测；已失效或无 API 的（FTB、MC百科等）不爬取、不伪造，改为「在其它站点搜索」一键深链。'],
    ['五、调权重即调推荐', '同一批结果，把速度权重从 20% 拉到 60% 后名次立刻改变（实测）：`Create: Steam \'n\' Rails` 从第 2 掉到第 4，`Create Slice & Dice` 从第 4 升到第 2。'],
  ],
);

const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${para('MC Mod Finder', { style: 'Title', align: 'center', spaceAfter: 20 })}
${para('从一句模糊需求到可用站点：问题 / 提示词 / 结果', { style: 'Subtitle', align: 'center', spaceAfter: 160 })}

${h1('一、问题')}
${para('装一个《我的世界》模组或整合包，得先在 Modrinth、CurseForge、MC百科之间来回翻：条目散在不同平台，版本与加载器要逐个比对，下载页不显示速度，同一个模组在不同平台的下载体验可能差一个数量级。要找「一个能用的模组」，实际上被拆成了搜索、比对、试下载三段重复劳动。')}
${para('要解决的问题因此可以写成一句话：**给一个名字（外加版本与类型），直接返回一份带理由的推荐排序，并把「下载快不快、是不是免费」做成可核对的排序依据，而不是站点自己说的热门榜。**')}

${h1('二、提示词：需求是分阶段长出来的')}
${para('站点不是一次说清楚的。下表按阶段列出提示词，可以看到需求从「一个搜索框」逐步收紧到「可解释、可调、可部署」的闭环：', { spaceAfter: 100 })}
${stageTable}
${EMPTY}

${h1('三、结果')}
${para('最终交付的是零依赖 Node 站点（`npm start` 即跑）：界面分搜索筛选区、推荐权重面板、结果卡片，工具栏提供「为推荐测速」。核心功能与落点：', { spaceAfter: 100 })}
${featureTable}
${EMPTY}
${h2('结果里最能说明问题的一处：测速真的改变了排序')}
${para('同一批结果，测速前速度项取中性值 0.55（不埋没也不抬举），测速后换成实测值，平台差距立刻反映到分数上：', { spaceAfter: 80 })}
${codeBlock([
  '                        速度项            实测',
  'Create Goggles (CF)     0.55 → 0.000     11 kbps',
  'Delightful Creators(CF) 0.55 → 0.000     11 kbps',
  'Modrinth 同批 5 条       0.55 → 0.427    357 kbps',
  '',
  '同一批内容，357 kbps : 11 kbps —— 差约 32 倍；8 条结果只发了 4 次真实探测。',
])}
${para('这就是「按实测下载速度推荐」的价值：**Modrinth 内部比不出差别（全站一个 CDN，同批结果速度一致），跨平台对比时才有区分度。** 推荐依据也是可读的，例如：`名称高度匹配搜索词 / 下载量 1072.9万 / 1727 人关注 / 实测下载 357 KB/s（一般） / 首字节 2433 ms / 免费直链 + 开源许可 MIT / 15 天前更新`。')}

${h2('已知边界（避免误解）')}
${bullet('测速反映**本机到该 CDN 的链路**，换网络、换地区数值都会变；样本短于 150 ms 会标 `lowConfidence`。')}
${bullet('速度维度的**单位换算尚未统一**：界面按 KB/s 显示（357 KB/s），计分函数取的是接口里的 kbps 数值，使速度项得分偏高（按 KB/s 算应为 0.075 左右，当前 0.427）。**排序方向不受影响**，但这是下一步要先修的地方。')}
${bullet('FTB 搜索接口已失效、MC百科等站点无公开 API，这些**只做深链跳转**；CurseForge 搜索端点曾对旧 key 返回 403，现 key 已恢复，诊断接口会区分 `invalid-key` 与 `search-blocked`。')}

${EMPTY}
${para('文档位置：E:\\dsh\\mc-mod-finder\\docs\\MC Mod Finder 问题-提示词-结果.docx　·　站点：http://127.0.0.1:8765　·　项目：E:\\dsh\\mc-mod-finder', { style: 'Note', spaceAfter: 0 })}
</w:body>
</w:document>`;

/* ---------------- styles / 包装 ---------------- */
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT_BODY}" w:eastAsia="${FONT_BODY}" w:hAnsi="${FONT_BODY}" w:cs="${FONT_BODY}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="${FONT_HEAD}" w:eastAsia="${FONT_HEAD}" w:hAnsi="${FONT_HEAD}"/><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/><w:color w:val="1F3864"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="${FONT_BODY}" w:eastAsia="${FONT_BODY}" w:hAnsi="${FONT_BODY}"/><w:sz w:val="20"/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:rFonts w:ascii="${FONT_HEAD}" w:eastAsia="${FONT_HEAD}" w:hAnsi="${FONT_HEAD}"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/><w:color w:val="1F3864"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="140" w:after="60"/></w:pPr><w:rPr><w:rFonts w:ascii="${FONT_HEAD}" w:eastAsia="${FONT_HEAD}" w:hAnsi="${FONT_HEAD}"/><w:b/><w:sz w:val="23"/><w:szCs w:val="23"/><w:color w:val="2E5496"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F4F7"/><w:ind w:left="120" w:right="120"/><w:spacing w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="${FONT_MONO}" w:eastAsia="${FONT_BODY}" w:hAnsi="${FONT_MONO}"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/><w:color w:val="7F7F7F"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="B7C2CE"/><w:left w:val="single" w:sz="4" w:space="0" w:color="B7C2CE"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="B7C2CE"/><w:right w:val="single" w:sz="4" w:space="0" w:color="B7C2CE"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="B7C2CE"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="B7C2CE"/></w:tblBorders></w:tblPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>MC Mod Finder · 问题 / 提示词 / 结果</dc:title>
<dc:creator>DeepSeek Harness</dc:creator>
<cp:lastModifiedBy>DeepSeek Harness</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-30T13:00:00Z</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-30T13:00:00Z</dcterms:modified>
</cp:coreProperties>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;

const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:zoom w:percent="110"/>
<w:defaultTabStop w:val="420"/>
<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>`;

const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>mc-mod-finder doc builder</Application>
<DocSecurity>0</DocSecurity>
<ScaleCrop>false</ScaleCrop>
<Company></Company>
<AppVersion>1.0</AppVersion>
</Properties>`;

const listXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;

const sectPr =
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
  `<w:pgMar w:top="1020" w:right="1020" w:bottom="1020" w:left="1020" w:header="851" w:footer="850" w:gutter="0"/>` +
  `<w:cols w:space="425"/><w:docGrid w:linePitch="312"/></w:sectPr>`;

/* ---------------- ZIP 打包 ---------------- */
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(data, 'utf8');
    const comp = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(comp.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

const finalDoc = doc.replace('</w:body>', `${sectPr}</w:body>`);
const entries = [
  { name: '[Content_Types].xml', data: contentTypes },
  { name: '_rels/.rels', data: rels },
  { name: 'docProps/core.xml', data: core },
  { name: 'docProps/app.xml', data: app },
  { name: 'word/document.xml', data: finalDoc },
  { name: 'word/_rels/document.xml.rels', data: docRels },
  { name: 'word/styles.xml', data: styles },
  { name: 'word/settings.xml', data: settings },
  { name: 'word/numbering.xml', data: listXml },
];

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, zip(entries));
console.log('written:', OUT_FILE);
console.log('document.xml 长度:', finalDoc.length, '字符');
console.log('段落数:', (finalDoc.match(/<w:p>/g) ?? []).length, '表格数:', (finalDoc.match(/<w:tbl>/g) ?? []).length);
