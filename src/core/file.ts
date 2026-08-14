/**
 * 図面ファイルの入出力。
 *
 * 正本は `.tc2w`（`DocumentJson` の JSON テキスト、UTF-8）。
 * デスクトップ版の `.tc2` は JSON を ZIP 圧縮したものなので、相互運用が必要に
 * なったらここに解凍/圧縮を足す（形式判定は拡張子ではなく**中身の先頭 2 バイト**
 * が `PK` かどうかで行う、という約束もデスクトップ版と同じにする）。
 */

import type { DocumentJson } from './document.js';

export const FILE_EXTENSION = '.tc2w';

/** 「開く」で選べる拡張子。 */
export const OPEN_ACCEPT = `${FILE_EXTENSION},.json,.dxf`;

export function serialize(json: DocumentJson): string {
  return JSON.stringify(json);
}

export function deserialize(text: string): DocumentJson {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) {
    throw new Error('図面ファイルとして読めません（JSON ではありません）');
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isDocumentJson(parsed)) throw new Error('図面ファイルの内容が壊れています');
  return parsed;
}

function isDocumentJson(v: unknown): v is DocumentJson {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<DocumentJson>;
  if (o.format !== 'tr-cad2w' || typeof o.version !== 'number') return false;
  if (!Array.isArray(o.entities) || !Array.isArray(o.layers)) return false;
  if (o.layouts !== undefined) {
    if (!Array.isArray(o.layouts)) return false;
    // レイアウトの中身が配列でないと読込の途中で落ちる。ここで弾く
    if (!o.layouts.every((l) => Array.isArray(l?.entities) && Array.isArray(l?.viewports))) return false;
  }
  return true;
}

/** ブラウザにファイルとして保存させる。 */
export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // revoke はクリック処理が終わってから
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface PickedFile {
  name: string;
  /**
   * 生のバイト列。**テキストとして解釈する前に必ずここを通す。**
   * DXF は Shift-JIS のことがあり、`File.text()`（UTF-8 固定）では化ける
   */
  bytes: Uint8Array;
}

/** ファイル選択ダイアログを開いてバイト列を読む。キャンセルなら null。 */
export function pickFile(accept = OPEN_ACCEPT): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      void readFile(file).then(resolve);
    });
    // キャンセルは change が来ないので cancel を見る（対応ブラウザのみ）
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** `File`（ドラッグ＆ドロップ含む）をバイト列として読む。 */
export async function readFile(file: File): Promise<PickedFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** BOM を落として UTF-8 として解釈する（`.tc2w` / JSON 用）。 */
export function decodeUtf8(bytes: Uint8Array): string {
  const body =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  return new TextDecoder('utf-8').decode(body);
}

/** 既定の保存名。`図面-20260814-1530.tc2w` の形。 */
export function defaultFileName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `図面-${stamp}${FILE_EXTENSION}`;
}
