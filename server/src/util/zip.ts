import { deflateRawSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';

/**
 * 最小 ZIP 实现（写 + 读），零依赖。
 *
 * 为什么不引 archiver/jszip：语料库导出是唯一用途，而我们需要的能力只有
 * 「把一组文件打成一个 zip / 再解开」。手写 150 行换零依赖，划算。
 *
 * 只支持经典 ZIP（非 ZIP64）：单文件 < 4GB、总大小 < 4GB。
 * 语料库导出里图片是大头，JPEG 本身已压缩所以走 STORE；
 * 清单 JSON 是文本，走 DEFLATE。
 *
 * 写出的包 Windows 资源管理器 / 7-Zip / macOS 都能直接打开 ——
 * 用 `Expand-Archive` 做过互操作验证（见 diagnostics/verify-corpus-transfer.ts）。
 */

export interface ZipEntryInput {
  /** 条目名。用 `/` 分隔（ZIP 规范），不要用 `\`。 */
  name: string;
  data: Buffer;
  /**
   * true = 原样存储不压缩（适合已经是 JPEG/PNG 的二进制）。
   * 缺省走 DEFLATE。
   */
  store?: boolean;
}

export interface ZipEntryOutput {
  name: string;
  data: Buffer;
}

/* ------------------------------------------------------------------ */
/* CRC32                                                              */
/* ------------------------------------------------------------------ */

// 标准表驱动 CRC-32（多项式 0xEDB88320），ZIP 规范要求的那个。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* DOS 时间（ZIP 头里的修改时间只有 2 秒精度，够用）                      */
/* ------------------------------------------------------------------ */

function dosTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/* ------------------------------------------------------------------ */
/* 写                                                                  */
/* ------------------------------------------------------------------ */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0：DEFLATE 的最低要求

interface CentralRecord {
  name: string;
  crc: number;
  size: number;
  compressedSize: number;
  method: number;
  offset: number;
  time: number;
  date: number;
}

export function createZip(entries: ZipEntryInput[]): Buffer {
  const { time, date } = dosTime(new Date());
  const chunks: Buffer[] = [];
  const central: CentralRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const method = entry.store ? 0 : 8;
    const payload = entry.store ? entry.data : deflateRawSync(entry.data, { level: 6 });

    const local = Buffer.alloc(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, VERSION_NEEDED, true);
    lv.setUint16(6, 0, true); // general purpose flag：不流式、名字是 ASCII
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBuf.length, true);
    lv.setUint16(28, 0, true); // extra 长度

    chunks.push(local, nameBuf, payload);
    central.push({
      name: entry.name,
      crc,
      size: entry.data.length,
      compressedSize: payload.length,
      method,
      offset,
      time,
      date,
    });

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const rec of central) {
    const nameBuf = Buffer.from(rec.name, 'utf8');
    const head = Buffer.alloc(46);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, SIG_CENTRAL, true);
    hv.setUint16(4, VERSION_NEEDED, true); // version made by：低字节 20（MS-DOS）
    hv.setUint16(6, VERSION_NEEDED, true);
    hv.setUint16(8, 0, true);
    hv.setUint16(10, rec.method, true);
    hv.setUint16(12, rec.time, true);
    hv.setUint16(14, rec.date, true);
    hv.setUint32(16, rec.crc, true);
    hv.setUint32(20, rec.compressedSize, true);
    hv.setUint32(24, rec.size, true);
    hv.setUint16(28, nameBuf.length, true);
    // extra / comment / disk start / internal attrs / external attrs 全 0
    hv.setUint32(42, rec.offset, true);
    chunks.push(head, nameBuf);
    centralSize += head.length + nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);

  chunks.push(eocd);
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 解开一个 ZIP。只支持经典 ZIP（STORE / DEFLATE，无加密、无 ZIP64、无分卷）。
 *
 * 从中央目录读而不是顺着本地头扫，这样「写的时候用了 data descriptor
 * （本地头里大小是 0）」的包也能解 —— Windows 资源管理器压缩出来的就是这种。
 */
export function readZip(buf: Buffer): ZipEntryOutput[] {
  const eocdPos = findEocd(buf);
  if (eocdPos < 0) throw new Error('不是有效的 ZIP（找不到中央目录结尾记录）');

  const ev = new DataView(buf.buffer, buf.byteOffset + eocdPos, Math.min(22, buf.length - eocdPos));
  const count = ev.getUint16(10, true);
  const cdOffset = ev.getUint32(16, true);

  const out: ZipEntryOutput[] = [];
  let pos = cdOffset;

  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error(`ZIP 中央目录在第 ${i} 项处损坏`);
    }
    const cv = new DataView(buf.buffer, buf.byteOffset + pos, 46);
    const method = cv.getUint16(10, true);
    const compressedSize = cv.getUint32(20, true);
    const nameLen = cv.getUint16(28, true);
    const extraLen = cv.getUint16(30, true);
    const commentLen = cv.getUint16(32, true);
    const localOffset = cv.getUint32(42, true);

    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);

    if (!name.endsWith('/')) {
      // 数据起点 = 本地头 + 名字 + extra。本地头里的 extra 长度可能与中央目录不同，分别读。
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
        throw new Error(`ZIP 条目 ${name} 的本地头损坏`);
      }
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compressedSize);

      if (method === 0) {
        out.push({ name, data: Buffer.from(data) });
      } else if (method === 8) {
        out.push({ name, data: inflateRawSync(data) });
      } else {
        throw new Error(`ZIP 条目 ${name} 用了不支持的压缩方法 ${method}（只支持 STORE/DEFLATE）`);
      }
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

/** 从尾部往前找 EOCD 签名（允许最多 64KB 的注释）。 */
function findEocd(buf: Buffer): number {
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let pos = buf.length - 22; pos >= minPos; pos--) {
    if (buf.readUInt32LE(pos) === SIG_EOCD) return pos;
  }
  return -1;
}

/** 统一 zip 内部路径分隔符，并拒绝越出包顶层的名字。 */
export function safeEntryName(...parts: Array<string | number>): string {
  const joined = parts.join('/');
  if (joined.includes('\\') || joined.includes('..') || path.isAbsolute(joined)) {
    throw new Error(`非法的 zip 条目名：${joined}`);
  }
  return joined;
}
