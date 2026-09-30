// 校验生成的 docx：ZIP 结构、XML 良构、表格行列数、纯文本预览
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const file = process.argv[2];
const buf = readFileSync(file);

/* --- 读 ZIP 中央目录 --- */
const entries = new Map();
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('找不到 ZIP 结尾记录');
const total = buf.readUInt16LE(eocd + 10);
const cdOffset = buf.readUInt32LE(eocd + 16);
let p = cdOffset;
for (let i = 0; i < total; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏 @' + p);
  const method = buf.readUInt16LE(p + 10);
  const compSize = buf.readUInt32LE(p + 20);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOffset = buf.readUInt32LE(p + 42);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  const localNameLen = buf.readUInt16LE(localOffset + 26);
  const localExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const raw = buf.subarray(dataStart, dataStart + compSize);
  const data = method === 8 ? inflateRawSync(raw) : raw;
  const crc = buf.readUInt32LE(p + 16);
  const check = (() => { let c = -1; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ -1) >>> 0; })();
  entries.set(name, { data, crcOk: crc === check, method, compSize, size: data.length });
  p += 46 + nameLen + extraLen + commentLen;
}

console.log('=== ZIP 条目 ===');
for (const [name, e] of entries) {
  console.log(`${e.crcOk ? 'CRC OK ' : 'CRC BAD'}  ${String(e.size).padStart(7)}B  ${name}`);
}

/* --- XML 良构 + 标签配对检查 --- */
function checkXml(label, xml) {
  const stack = [];
  const re = /<(\/?)([A-Za-z0-9:_.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  let count = 0;
  while ((m = re.exec(xml))) {
    const [, closing, name, , selfClose] = m;
    count++;
    if (closing) {
      const top = stack.pop();
      if (top !== name) throw new Error(`${label}: 标签不匹配，期望 </${top}> 实际 </${name}> @${m.index}`);
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length) throw new Error(`${label}: 有未闭合标签 ${stack.join(',')}`);
  console.log(`${label}: 良构 OK，${count} 个标签`);
}
const decoder = new TextDecoder('utf-8');
for (const name of ['word/document.xml', 'word/styles.xml', 'word/settings.xml', '[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'docProps/core.xml', 'docProps/app.xml']) {
  checkXml(name, decoder.decode(entries.get(name).data));
}

/* --- 检查 BOM / 编码 --- */
const docXml = decoder.decode(entries.get('word/document.xml').data);
console.log('\n是否以 BOM 开头:', docXml.charCodeAt(0) === 0xfeff);
console.log('是否含替换字符 U+FFFD:', docXml.includes('\uFFFD'));

/* --- 表格行列 --- */
const tables = docXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];
console.log('\n=== 表格结构 ===');
tables.forEach((t, i) => {
  const rows = (t.match(/<w:tr>/g) ?? []).length;
  const firstRowCols = ((t.match(/<w:tr>[\s\S]*?<\/w:tr>/) ?? [''])[0].match(/<w:tc>/g) ?? []).length;
  const allCols = [...t.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)].map((r) => (r[0].match(/<w:tc>/g) ?? []).length);
  console.log(`表 ${i + 1}: ${rows} 行 × ${firstRowCols} 列，各行列数=${allCols.join(',')} ${allCols.every((c) => c === firstCols(allCols)) ? '（一致 ✓）' : '（不一致 ✗）'}`);
  const gridW = [...t.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((g) => Number(g[1]));
  console.log(`        列宽合计 ${gridW.reduce((a, b) => a + b, 0)} twips（正文可用宽 9866）`);
});
function firstCols(arr) { return arr[0]; }

/* --- 纯文本预览 --- */
const text = docXml
  .replace(/<\/w:p>/g, '\n')
  .replace(/<\/w:tc>/g, ' | ')
  .replace(/<\/w:tr>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n');
console.log('\n=== 纯文本预览 ===');
console.log(text.trim());
console.log('\n总字符数:', text.trim().length);
