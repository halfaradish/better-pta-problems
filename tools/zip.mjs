// 最小 zip 写入 / 读取器（deflate 或原样存储，不含 zip64）。
//
// 为什么自己写：发行包里含中文文件名（安装教程.html），必须显式设置 UTF-8 文件名
// 标志位（general purpose bit 11）——中文 Windows 的资源管理器按该位判断是否用
// UTF-8 解码，否则显示乱码；命令行 zip、PowerShell Compress-Archive 是否设置该位
// 随版本与区域设置而异，自己写才能钉死。时间戳固定为 1980-01-01（DOS 时间最小值），
// 同输入产出同字节，便于比对。
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const VERSION_NEEDED = 20; // 2.0：deflate
const VERSION_MADE_BY = 0x031e; // 3.0，来源 UNIX（外部属性按 0644 解释）
export const FLAG_UTF8 = 0x0800; // general purpose bit 11：文件名是 UTF-8
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01
const UNIX_MODE_644 = 0x81a40000; // 0o100644 << 16
const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data }]，name 用 '/' 分隔、相对 zip 根（目录由路径隐含，不需要单独条目）。
export function makeZip(entries) {
  if (entries.length > MAX_ENTRIES) throw new Error(`条目数 ${entries.length} 超过 ${MAX_ENTRIES}，需要 zip64`);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    if (data.length > MAX_32 || body.length > MAX_32 || offset > MAX_32) {
      throw new Error(`「${entry.name}」超出 zip 的 4GB 限制，需要 zip64`);
    }

    const local = Buffer.alloc(LOCAL_HEADER_SIZE);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度
    parts.push(local, name, body);

    const dir = Buffer.alloc(CENTRAL_HEADER_SIZE);
    dir.writeUInt32LE(CENTRAL_SIG, 0);
    dir.writeUInt16LE(VERSION_MADE_BY, 4);
    dir.writeUInt16LE(VERSION_NEEDED, 6);
    dir.writeUInt16LE(FLAG_UTF8, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // 起始磁盘号
    dir.writeUInt16LE(0, 36); // 内部属性
    dir.writeUInt32LE(UNIX_MODE_644, 38); // 外部属性
    dir.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(dir, name);

    offset += LOCAL_HEADER_SIZE + name.length + body.length;
  }

  const dirBuf = Buffer.concat(central);
  if (dirBuf.length > MAX_32 || offset > MAX_32) throw new Error('中央目录超出 zip 的 4GB 限制，需要 zip64');
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // 本磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度
  return Buffer.concat([...parts, dirBuf, eocd]);
}

// 回读 zip（走中央目录，和 unzip / 资源管理器一致），用于打包自检与单测。
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - EOCD_SIZE; i >= 0 && i >= buf.length - EOCD_SIZE - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾记录');
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (p + dirSize !== eocd) throw new Error('不是有效的 zip：中央目录偏移与结尾记录不符');

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('不是有效的 zip：中央目录条目签名错误');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + CENTRAL_HEADER_SIZE, p + CENTRAL_HEADER_SIZE + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`不是有效的 zip：「${name}」的本地头签名错误`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + LOCAL_HEADER_SIZE + localNameLen + localExtraLen;
    const body = buf.subarray(start, start + compressedSize);
    const data = method === METHOD_DEFLATE ? inflateRawSync(body) : Buffer.from(body);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`不是有效的 zip：「${name}」内容校验失败`);

    entries.push({ name, flags, method, size, compressedSize, data });
    p += CENTRAL_HEADER_SIZE + nameLen + extraLen + commentLen;
  }
  return entries;
}
