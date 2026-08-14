import { describe, expect, it } from 'vitest';
import { crc32, looksLikeZip, unzip, zip } from '../src/io/zip.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b);

describe('CRC32', () => {
  it('既知の値', () => {
    // 標準的な検査値（多項式 0xEDB88320）
    expect(crc32(utf8(''))).toBe(0);
    expect(crc32(utf8('a'))).toBe(0xe8b7be43);
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
  });
});

describe('ZIP の判定', () => {
  it('先頭 2 バイトが PK かで見る（拡張子では見ない）', () => {
    expect(looksLikeZip(utf8('PK\x03\x04'))).toBe(true);
    expect(looksLikeZip(utf8('{"format"'))).toBe(false);
    expect(looksLikeZip(new Uint8Array([0x50]))).toBe(false);
  });
});

describe('ZIP の往復', () => {
  it('1 エントリ', async () => {
    const body = utf8(JSON.stringify({ hello: '世界', n: 1 }));
    const archive = await zip([{ name: 'TrCad2D.json', bytes: body }]);
    expect(looksLikeZip(archive)).toBe(true);

    const entries = await unzip(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('TrCad2D.json');
    expect(text(entries[0]!.bytes)).toBe(text(body));
  });

  it('複数エントリと日本語のファイル名', async () => {
    const entries = await unzip(
      await zip([
        { name: 'a.json', bytes: utf8('{"a":1}') },
        { name: '図面/メモ.txt', bytes: utf8('メモです') },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(['a.json', '図面/メモ.txt']);
    expect(text(entries[1]!.bytes)).toBe('メモです');
  });

  it('よく縮む内容は deflate される（元より小さい）', async () => {
    const body = utf8('あ'.repeat(5000));
    const archive = await zip([{ name: 'x.txt', bytes: body }]);
    expect(archive.length).toBeLessThan(body.length);
    expect(text((await unzip(archive))[0]!.bytes)).toBe('あ'.repeat(5000));
  });

  it('縮まない短い内容でも往復する（無圧縮で入る）', async () => {
    const body = utf8('x');
    expect(text((await unzip(await zip([{ name: 'x.txt', bytes: body }])))[0]!.bytes)).toBe('x');
  });

  it('空のファイルも往復する', async () => {
    const entries = await unzip(await zip([{ name: 'empty.json', bytes: new Uint8Array(0) }]));
    expect(entries[0]!.bytes).toHaveLength(0);
  });

  it('大きめの内容でも壊れない', async () => {
    const body = utf8(JSON.stringify({ pts: Array.from({ length: 20000 }, (_, i) => i * 0.5) }));
    const back = (await unzip(await zip([{ name: 'big.json', bytes: body }])))[0]!;
    expect(text(back.bytes)).toBe(text(body));
  });
});

describe('壊れた ZIP', () => {
  it('PK で始まらない', async () => {
    await expect(unzip(utf8('not a zip'))).rejects.toThrow('ZIP ではありません');
  });

  it('EOCD が無い', async () => {
    await expect(unzip(utf8('PK\x03\x04broken'))).rejects.toThrow('EOCD');
  });

  it('CRC が合わない中身は拒否する', async () => {
    // .NET の ZipArchive は CRC を検証する。こちらも見ておかないと、
    // 壊れた ZIP を書いても気づけない
    const archive = await zip([{ name: 'a.json', bytes: utf8('{"a":1}') }]);
    const view = new DataView(archive.buffer);
    // 中央ディレクトリの CRC を書き換える（EOCD から位置を引く）
    const centralOffset = view.getUint32(archive.length - 22 + 16, true);
    view.setUint32(centralOffset + 16, 0xdeadbeef, true);
    await expect(unzip(archive)).rejects.toThrow('CRC');
  });

  it('中央ディレクトリの位置が壊れている', async () => {
    const archive = await zip([{ name: 'a.json', bytes: utf8('{}') }]);
    // EOCD の「中央ディレクトリの位置」を壊す
    const view = new DataView(archive.buffer);
    view.setUint32(archive.length - 22 + 16, 999999, true);
    await expect(unzip(archive)).rejects.toThrow('中央ディレクトリ');
  });
});
