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
  return o.format === 'tr-cad2w' && typeof o.version === 'number' && Array.isArray(o.entities);
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

/** ファイル選択ダイアログを開いてテキストを読む。キャンセルなら null。 */
export function pickTextFile(accept = `${FILE_EXTENSION},.json`): Promise<{ name: string; text: string } | null> {
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
      void file.text().then((text) => resolve({ name: file.name, text }));
    });
    // キャンセルは change が来ないので cancel を見る（対応ブラウザのみ）
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** 既定の保存名。`図面-20260814-1530.tc2w` の形。 */
export function defaultFileName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `図面-${stamp}${FILE_EXTENSION}`;
}
