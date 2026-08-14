/**
 * 最小限の ZIP 読み書き。
 *
 * デスクトップ版の `.tc2` は **JSON を ZIP 圧縮したもの**（中身は `TrCad2D.json`
 * 1 件）なので、相互運用にはこれが要る。**実行時依存を増やさない**ため、
 * 圧縮・伸長はブラウザ標準の `CompressionStream` / `DecompressionStream`
 * （`deflate-raw`）を使い、ZIP のヘッダだけ自前で組み立てる。
 *
 * 対応するのは**単純な ZIP だけ**:
 *
 * | 対応する | 対応しない |
 * |---|---|
 * | 格納（method 0）・deflate（method 8） | bzip2 / LZMA などその他の圧縮 |
 * | 4GB 未満・65535 エントリ未満 | Zip64 |
 * | 暗号化なし | 暗号化・分割書庫 |
 *
 * 図面ファイルにはこれで足りる。足りない形式は**理由のわかる例外**にする。
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;

/** ZIP の中の 1 ファイル。 */
export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** 先頭 2 バイトが `PK` か。**形式判定は拡張子ではなく中身で行う**（デスクトップ版と同じ約束）。 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

// ---- CRC32 ---------------------------------------------------------------

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** ZIP のヘッダに入れる CRC-32（多項式 0xEDB88320）。 */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 伸長・圧縮 ----------------------------------------------------------

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('このブラウザは DecompressionStream に対応していません');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('このブラウザは CompressionStream に対応していません');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- 読込 ----------------------------------------------------------------

/**
 * ZIP を展開する。エントリ名は UTF-8 として読む
 * （汎用フラグの UTF-8 ビットが立っていなくても、`.tc2` の中身は ASCII なので実害はない）。
 */
export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (!looksLikeZip(bytes)) throw new Error('ZIP ではありません（先頭が PK ではない）');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.length);
  if (eocd < 0) throw new Error('ZIP の終端レコード（EOCD）が見つかりません');

  // Zip64 は扱わない。素通しすると壊れた読み方をするので、はっきり断る
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    throw new Error('Zip64 形式には対応していません');
  }

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error('ZIP の中央ディレクトリが壊れています');
    }
    const method = view.getUint16(offset + 10, true);
    const expectedCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    const data = await readLocalEntry(bytes, view, localOffset, method, compressedSize);
    // CRC を照合する。**壊れたまま通すと、こちらが書いた ZIP を .NET 側が
    // 開けない不具合に気づけない**（.NET の ZipArchive は CRC を検証する）
    if (expectedCrc !== 0 && crc32(data) !== expectedCrc) {
      throw new Error(`ZIP の中身が壊れています（${name} の CRC が合いません）`);
    }
    entries.push({ name, bytes: data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readLocalEntry(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
): Promise<Uint8Array> {
  if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error('ZIP のローカルヘッダが壊れています');
  }
  // 名前と拡張フィールドの長さは**ローカルヘッダ側の値**を使う（中央ディレクトリと違うことがある）
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + compressedSize);

  if (method === 0) return new Uint8Array(data); // 無圧縮
  if (method === 8) return inflateRaw(data);
  throw new Error(`対応していない圧縮方式です（method ${method}）`);
}

/** EOCD をファイル末尾から探す（コメントは最大 65535 バイト）。 */
function findEocd(view: DataView, length: number): number {
  const min = Math.max(0, length - 22 - 0xffff);
  for (let i = length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

// ---- 書出 ----------------------------------------------------------------

/**
 * ZIP を組み立てる。deflate で圧縮し、**縮まなければ無圧縮で入れる**
 * （小さい JSON では deflate が元より大きくなることがある）。
 */
export async function zip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const deflated = await deflateRaw(entry.bytes);
    const useDeflate = deflated.length < entry.bytes.length;
    const data = useDeflate ? deflated : entry.bytes;
    const method = useDeflate ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    lv.setUint16(4, 20, true); // 展開に必要なバージョン 2.0
    lv.setUint16(6, 0x0800, true); // 汎用フラグ: 名前は UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // 更新時刻（0 固定＝再現可能な出力にする）
    lv.setUint16(12, 0, true); // 更新日付
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, entry.bytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // 拡張フィールド無し
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    cv.setUint16(4, 20, true); // 作成バージョン
    cv.setUint16(6, 20, true); // 展開に必要なバージョン
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, entry.bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // 拡張フィールド
    cv.setUint16(32, 0, true); // コメント
    cv.setUint16(34, 0, true); // ディスク番号
    cv.setUint16(36, 0, true); // 内部属性
    cv.setUint32(38, 0, true); // 外部属性
    cv.setUint32(42, offset, true); // ローカルヘッダの位置
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIGNATURE, true);
  ev.setUint16(4, 0, true); // このディスクの番号
  ev.setUint16(6, 0, true); // 中央ディレクトリのあるディスク
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // コメント長

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
