import { cloneStrokes, normalizeStrokes, type InkStroke } from './ink.js';

/**
 * 図面に付ける「文書情報」— 概要・注記文・境界コメント・メモ。
 *
 * デスクトップ版 TrCad2D の `ProjectInfoDto` / `CommentSelDto` /
 * `KyokaiCommentDto` / `MemoText` / `MemoStrokes` の移植。図形ではないので
 * 描画には出ず、**保存と `.tc2` の往復のためだけに持つ**。
 *
 * ## 手書きメモ（`memoStrokes`）は点列で持つ
 *
 * デスクトップ版の手書きメモは **Windows Ink の ISF を Base64 化した文字列**で、
 * ブラウザでは描くことも編集することもできない。**中身を解釈せずそのまま持ち、
 * 書き戻す**（Web で開いて保存しても手書きメモが消えないようにするため）。
 */

/** 概要（現場名・概要コードなど）。 */
export interface ProjectInfo {
  /** 現場名。 */
  name: string;
  /** 概要コード。デスクトップ版は保存名の既定に使う。 */
  code: string;
  worker: string;
  note: string;
}

/** 選んだ注記文。`key` で `comments.ts` の標準一覧に照合する。 */
export interface CommentSelection {
  key: string;
  checked: boolean;
  /** 編集後の本文（`|` が改行）。標準のままなら標準文と同じ。 */
  text: string;
}

/** 境界コメント（境界番号と境界標の種類）。 */
export interface KyokaiComment {
  /** 境界番号。 */
  name: string;
  /** 境界標の種類（`RC杭` など）。 */
  kind: string;
}

export interface DocumentInfo {
  project: ProjectInfo;
  comments: CommentSelection[];
  kyokai: KyokaiComment[];
  /** メモ（テキスト）。 */
  memoText: string;
  /**
   * メモ（手書き）。**点列**で持つ（issue #39・案 B）。
   *
   * 以前は Windows Ink の ISF を素通しで保っていたが、ブラウザに読み書きする
   * 手段が無く Web から編集できなかった。**ISF は持たない**（読んでも捨てる）。
   */
  memoStrokes: InkStroke[];
}

export const EMPTY_PROJECT: ProjectInfo = { name: '', code: '', worker: '', note: '' };

export function emptyDocumentInfo(): DocumentInfo {
  return { project: { ...EMPTY_PROJECT }, comments: [], kyokai: [], memoText: '', memoStrokes: [] };
}

/** 概要が空か（デスクトップ版 `ProjectInfoDto.IsEmpty` と同じ判定）。 */
export function isProjectEmpty(p: ProjectInfo): boolean {
  return p.name === '' && p.code === '' && p.worker === '' && p.note === '';
}

/** 何も入っていないか。空なら保存に出さない（古い読み手を驚かせない）。 */
export function isDocumentInfoEmpty(info: DocumentInfo): boolean {
  return (
    isProjectEmpty(info.project) &&
    info.comments.length === 0 &&
    info.kyokai.length === 0 &&
    info.memoText === '' &&
    info.memoStrokes.length === 0
  );
}

/** 複製（配列とオブジェクトの参照を共有しない）。 */
export function cloneDocumentInfo(info: DocumentInfo): DocumentInfo {
  return {
    project: { ...info.project },
    comments: info.comments.map((c) => ({ ...c })),
    kyokai: info.kyokai.map((k) => ({ ...k })),
    memoText: info.memoText,
    memoStrokes: cloneStrokes(info.memoStrokes),
  };
}

/**
 * 保存された値から組み立て直す。**壊れた形は捨てて既定へ落とす**
 * （文書情報のせいで図面が開けなくならないようにする）。
 */
export function normalizeDocumentInfo(raw: unknown): DocumentInfo {
  const out = emptyDocumentInfo();
  if (typeof raw !== 'object' || raw === null) return out;
  const o = raw as Partial<DocumentInfo>;

  if (typeof o.project === 'object' && o.project !== null) {
    out.project = {
      name: str(o.project.name),
      code: str(o.project.code),
      worker: str(o.project.worker),
      note: str(o.project.note),
    };
  }
  if (Array.isArray(o.comments)) {
    out.comments = o.comments
      .filter((c): c is CommentSelection => typeof c === 'object' && c !== null)
      .map((c) => ({ key: str(c.key), checked: c.checked === true, text: str(c.text) }));
  }
  if (Array.isArray(o.kyokai)) {
    out.kyokai = o.kyokai
      .filter((k): k is KyokaiComment => typeof k === 'object' && k !== null)
      .map((k) => ({ name: str(k.name), kind: str(k.kind) }));
  }
  out.memoText = str(o.memoText);
  out.memoStrokes = normalizeStrokes(o.memoStrokes);
  return out;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 保存名の既定に使う名前。
 *
 * デスクトップ版は**概要コードを優先**し、無ければ現場名を使う
 * （`GaiyoCD` を保存名の既定にしている）。どちらも無ければ `null`。
 */
export function fileNameBaseOf(p: ProjectInfo): string | null {
  const pick = p.code.trim() !== '' ? p.code : p.name;
  const cleaned = pick.trim().replace(/[\\/:*?"<>|\r\n\t]+/g, '_');
  return cleaned === '' ? null : cleaned;
}

/** 境界標の種類の既定の選択肢（デスクトップ版 `KyokaiKinds.Defaults` と同じ語彙）。 */
export const KYOKAI_KINDS: readonly string[] = [
  'RC杭',
  '金属標',
  '金属鋲',
  'プラスチック杭',
  '木杭',
  '石杭',
  '鋲',
  '釘',
  'キザミ',
  '既設ペンキ',
  '仮ペンキ',
  '仮ポイント',
  '不明',
];
