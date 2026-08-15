import { describe, expect, it } from 'vitest';
import { CadDocument, type DocumentJson } from '../src/core/document.js';
import {
  KYOKAI_KINDS,
  cloneDocumentInfo,
  emptyDocumentInfo,
  fileNameBaseOf,
  isDocumentInfoEmpty,
  isProjectEmpty,
  normalizeDocumentInfo,
  type DocumentInfo,
} from '../src/core/project-info.js';
import { STANDARD_COMMENTS, commentTextToLines, findStandardComment } from '../src/core/comments.js';
import { documentToTc2Json, tc2InfoToDocument, tc2JsonToDocument, type Tc2DocDto } from '../src/io/tc2.js';

/** Windows Ink の ISF を Base64 化した文字列の模擬（中身は解釈しない）。 */
/** 手書きメモのサンプル（点列。issue #39・案 B で ISF から置き換えた）。 */
const STROKES = [
  { points: [{ x: 0, y: 0, p: 0.5 }, { x: 0.5, y: 0.25, p: 0.75 }], color: '#1b1b1b', width: 0.004 },
];

function filled(): DocumentInfo {
  return {
    project: { name: '○○様邸', code: 'G12345', worker: '平間', note: '境界立会済み' },
    comments: [{ key: '3', checked: true, text: '境界標は確認致しましたが、|所有権境をご確認ください。' }],
    kyokai: [{ name: '1', kind: 'RC杭' }],
    memoText: '現地は雨',
    memoStrokes: STROKES,
  };
}

describe('標準注記文のマスタ', () => {
  it('デスクトップ版と同じ 40 件を持つ', () => {
    expect(STANDARD_COMMENTS).toHaveLength(40);
  });

  it('キーで引ける', () => {
    expect(findStandardComment('3')?.summary).toContain('境界標は確認致しました');
    expect(findStandardComment('999')).toBeUndefined();
  });

  it('キーは 1..40 の通し番号（.tc2 の照合に使うので変えない）', () => {
    expect(STANDARD_COMMENTS.map((c) => c.key)).toEqual(Array.from({ length: 40 }, (_, i) => String(i + 1)));
  });

  it('本文の | は改行として開ける', () => {
    expect(commentTextToLines('あ|い|う')).toEqual(['あ', 'い', 'う']);
    expect(commentTextToLines('改行なし')).toEqual(['改行なし']);
  });

  it('末尾はフリー入力枠（デスクトップ版と同じ）', () => {
    expect(STANDARD_COMMENTS[39]?.summary).toContain('フリー入力');
  });
});

describe('文書情報の基本', () => {
  it('空の判定', () => {
    expect(isDocumentInfoEmpty(emptyDocumentInfo())).toBe(true);
    expect(isDocumentInfoEmpty(filled())).toBe(false);
  });

  it('手書きメモだけでも「空ではない」', () => {
    const info = emptyDocumentInfo();
    info.memoStrokes = STROKES;
    expect(isDocumentInfoEmpty(info)).toBe(false);
  });

  it('概要の空判定', () => {
    expect(isProjectEmpty({ name: '', code: '', worker: '', note: '' })).toBe(true);
    expect(isProjectEmpty({ name: '', code: 'A', worker: '', note: '' })).toBe(false);
  });

  it('複製は配列とオブジェクトを共有しない', () => {
    const src = filled();
    const copy = cloneDocumentInfo(src);
    expect(copy).toEqual(src);
    expect(copy.comments).not.toBe(src.comments);
    expect(copy.comments[0]).not.toBe(src.comments[0]);
    expect(copy.project).not.toBe(src.project);
    copy.kyokai.push({ name: '2', kind: '木杭' });
    expect(src.kyokai).toHaveLength(1);
  });

  it('境界標の種類は旧 VB 版と同じ語彙', () => {
    expect(KYOKAI_KINDS).toContain('RC杭');
    expect(KYOKAI_KINDS).toContain('プラスチック杭');
    expect(KYOKAI_KINDS).toContain('不明');
  });
});

describe('壊れた値の受け止め', () => {
  it('null / 数値は空として受ける', () => {
    expect(normalizeDocumentInfo(null)).toEqual(emptyDocumentInfo());
    expect(normalizeDocumentInfo(42)).toEqual(emptyDocumentInfo());
  });

  it('文字列でない項目は空文字にする', () => {
    const got = normalizeDocumentInfo({ project: { name: 123, code: null }, memoText: {}, memoStrokes: 'x' });
    expect(got.project.name).toBe('');
    expect(got.memoText).toBe('');
    expect(got.memoStrokes).toEqual([]);
  });

  it('配列でない comments / kyokai は捨てる', () => {
    const got = normalizeDocumentInfo({ comments: 'x', kyokai: 5 });
    expect(got.comments).toEqual([]);
    expect(got.kyokai).toEqual([]);
  });

  it('配列の中の壊れた要素は落とす', () => {
    const got = normalizeDocumentInfo({ comments: [null, { key: '1', checked: true, text: 'あ' }, 3] });
    expect(got.comments).toHaveLength(1);
    expect(got.comments[0]?.key).toBe('1');
  });

  it('checked は真偽値だけを真とする', () => {
    const got = normalizeDocumentInfo({ comments: [{ key: '1', checked: 'yes', text: '' }] });
    expect(got.comments[0]?.checked).toBe(false);
  });
});

describe('保存名の既定', () => {
  it('概要コードを優先する', () => {
    expect(fileNameBaseOf({ name: '○○様邸', code: 'G12345', worker: '', note: '' })).toBe('G12345');
  });

  it('概要コードが無ければ現場名', () => {
    expect(fileNameBaseOf({ name: '○○様邸', code: '', worker: '', note: '' })).toBe('○○様邸');
  });

  it('どちらも無ければ null（日時つきの既定名を使う）', () => {
    expect(fileNameBaseOf({ name: '', code: '  ', worker: '', note: '' })).toBeNull();
  });

  it('ファイル名に使えない文字は潰す', () => {
    expect(fileNameBaseOf({ name: '', code: 'A/B:C*D?', worker: '', note: '' })).toBe('A_B_C_D_');
  });
});

describe('.tc2w（JSON）の往復', () => {
  it('概要・注記文・境界コメント・メモが往復する', () => {
    const doc = new CadDocument();
    doc.clear();
    doc.info = filled();
    const back = new CadDocument();
    back.loadJson(JSON.parse(JSON.stringify(doc.toJson())) as DocumentJson);
    expect(back.info).toEqual(filled());
  });

  it('**手書きメモ（点列）はそのまま戻る**', () => {
    const doc = new CadDocument();
    doc.clear();
    doc.info.memoStrokes = STROKES;
    const back = new CadDocument();
    back.loadJson(JSON.parse(JSON.stringify(doc.toJson())) as DocumentJson);
    expect(back.info.memoStrokes).toEqual(STROKES);
  });

  it('何も入っていなければ info を書かない（古い読み手を驚かせない）', () => {
    const doc = new CadDocument();
    doc.clear();
    expect(doc.toJson().info).toBeUndefined();
  });

  it('新規図面で空に戻る', () => {
    const doc = new CadDocument();
    doc.info = filled();
    doc.clear();
    expect(isDocumentInfoEmpty(doc.info)).toBe(true);
  });

  it('info が無い古いファイルも読める', () => {
    const doc = new CadDocument();
    doc.info = filled();
    doc.loadJson({ format: 'tr-cad2w', version: 1, lineTypeScale: 500, layers: [], entities: [] });
    expect(isDocumentInfoEmpty(doc.info)).toBe(true);
  });
});

describe('.tc2 の往復', () => {
  const docJson = (info: DocumentInfo): DocumentJson => ({
    format: 'tr-cad2w',
    version: 1,
    lineTypeScale: 500,
    layers: [],
    entities: [],
    info,
  });

  it('デスクトップ版の名前（Project / Comments / Kyokai / MemoText）で書く', () => {
    const dto = documentToTc2Json(docJson(filled()));
    expect(dto.Project).toEqual({ Name: '○○様邸', Code: 'G12345', Worker: '平間', Note: '境界立会済み' });
    expect(dto.Comments).toEqual([
      { Key: '3', Check: true, Text: '境界標は確認致しましたが、|所有権境をご確認ください。' },
    ]);
    expect(dto.Kyokai).toEqual([{ Name: '1', Kind: 'RC杭' }]);
    expect(dto.MemoText).toBe('現地は雨');
  });

  /** 案 B（issue #39）で ISF は捨て、点列だけを書くようになった。 */
  it('**MemoStrokes を書き、MemoInk は書かない**', () => {
    const dto = documentToTc2Json(docJson(filled()));
    expect(dto.MemoStrokes).toEqual(STROKES);
    expect(dto.MemoInk).toBeUndefined();
  });

  it('.tc2 → Web → .tc2 で手書きメモが一致する（往復で消えない）', () => {
    const src: Tc2DocDto = {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [],
      MemoStrokes: STROKES,
      MemoText: 'テキストのメモ',
    };
    const web = tc2JsonToDocument(src).json;
    expect(web.info?.memoStrokes).toEqual(STROKES);
    const again = documentToTc2Json(web);
    expect(again.MemoStrokes).toEqual(STROKES);
    expect(again.MemoText).toBe('テキストのメモ');
  });

  it('デスクトップ版の JSON から概要・注記文・境界コメントを読む', () => {
    const dto: Tc2DocDto = {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [],
      Project: { Name: '現場', Code: 'C1', Worker: '担当', Note: '備考' },
      Comments: [{ Key: '5', Check: true, Text: '本文' }],
      Kyokai: [{ Name: '2', Kind: '金属標' }],
    };
    const info = tc2InfoToDocument(dto);
    expect(info.project.code).toBe('C1');
    expect(info.comments[0]).toEqual({ key: '5', checked: true, text: '本文' });
    expect(info.kyokai[0]).toEqual({ name: '2', kind: '金属標' });
  });

  it('項目が無い .tc2 は空の文書情報になる', () => {
    const dto: Tc2DocDto = {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [],
    };
    expect(isDocumentInfoEmpty(tc2InfoToDocument(dto))).toBe(true);
    expect(tc2JsonToDocument(dto).json.info).toBeUndefined();
  });

  it('空の文書情報は .tc2 に項目を作らない', () => {
    const dto = documentToTc2Json(docJson(emptyDocumentInfo()));
    expect(dto.Project).toBeUndefined();
    expect(dto.Comments).toBeUndefined();
    expect(dto.MemoInk).toBeUndefined();
  });

  it('概要が空でもメモがあれば MemoText だけ出る', () => {
    const info = emptyDocumentInfo();
    info.memoText = 'メモだけ';
    const dto = documentToTc2Json(docJson(info));
    expect(dto.Project).toBeUndefined();
    expect(dto.MemoText).toBe('メモだけ');
  });

  it('チェックを外した注記文も持ち続ける（本文の編集を捨てない）', () => {
    const info = emptyDocumentInfo();
    info.comments = [{ key: '1', checked: false, text: '直した本文' }];
    const dto = documentToTc2Json(docJson(info));
    expect(dto.Comments).toEqual([{ Key: '1', Check: false, Text: '直した本文' }]);
    expect(tc2InfoToDocument(dto).comments[0]?.text).toBe('直した本文');
  });
});
