/**
 * 作図ツールの状態機械。
 *
 * 各ツールは「クリックで点を集め、必要数そろったら図形を作る」だけを担う。
 * 入力（マウス・キー）の解釈は `CadApp` 側、図形の作り方はここ、という分担。
 */

import type { Vec2 } from '../core/geometry.js';
import { dist } from '../core/geometry.js';
import type { Entity, EntityColor, LineStyleName, NewEntity } from '../core/entity.js';
import { DEFAULT_ATTRS, angleOf } from '../core/entity.js';

export type ToolName =
  | 'select'
  | 'line'
  | 'rect'
  | 'circle'
  | 'arc'
  | 'polyline'
  | 'point'
  | 'text'
  | 'move'
  | 'copy';

export const TOOL_LABEL: Record<ToolName, string> = {
  select: '選択',
  line: '線',
  rect: '矩形',
  circle: '円',
  arc: '円弧',
  polyline: '連続線',
  point: '点',
  text: '文字',
  move: '移動',
  copy: '複写',
};

/** ツールのショートカット（デスクトップ版 TrCad2D と同じ割当）。 */
export const TOOL_KEYS: Record<string, ToolName> = {
  s: 'select',
  l: 'line',
  r: 'rect',
  c: 'circle',
  a: 'arc',
  p: 'polyline',
  t: 'text',
  m: 'move',
};

/** 新しい図形に与える属性（ツールバーの現在値）。 */
export interface DrawAttrs {
  layer: string;
  color: EntityColor;
  lineStyle: LineStyleName;
  lineWidth: number;
  /** 文字の既定の高さ（mm）。 */
  textHeight: number;
}

export const DEFAULT_DRAW_ATTRS: DrawAttrs = {
  ...DEFAULT_ATTRS,
  textHeight: 250,
};

export type { NewEntity };

/** ツールが 1 手進んだ結果。 */
export interface ToolStep {
  /** 確定した図形（あれば図面へ追加する）。 */
  created?: NewEntity[];
  /** ツールを初期状態へ戻すか。 */
  reset?: boolean;
}

export class DrawTool {
  private points: Vec2[] = [];
  private cursor: Vec2 | null = null;
  /** 文字ツールの入力内容。`CadApp` が確定前に入れる。 */
  pendingText = '';

  constructor(
    public name: ToolName,
    private readonly attrs: () => DrawAttrs,
  ) {}

  reset(): void {
    this.points = [];
    this.cursor = null;
  }

  get pointCount(): number {
    return this.points.length;
  }

  moveCursor(p: Vec2): void {
    this.cursor = p;
  }

  /** クリック 1 回分。図形が確定したら `created` に入って返る。 */
  click(p: Vec2): ToolStep {
    this.points.push(p);
    const need = requiredPoints(this.name);
    if (need !== null && this.points.length >= need) {
      const created = this.build(this.points);
      this.reset();
      return created ? { created, reset: true } : { reset: true };
    }
    return {};
  }

  /** 連続線を右クリック／Enter で確定する。 */
  finish(): ToolStep {
    if (this.name === 'polyline' && this.points.length >= 2) {
      const created = this.build(this.points);
      this.reset();
      return created ? { created, reset: true } : { reset: true };
    }
    this.reset();
    return { reset: true };
  }

  /** 作図中のラバーバンド。 */
  preview(): Entity[] {
    if (!this.cursor || this.points.length === 0) return [];
    const pts = [...this.points, this.cursor];
    const built = this.build(pts, true);
    if (!built) return [];
    return built.map((e, i) => ({ ...e, id: -1 - i }) as Entity);
  }

  private base(): Omit<Entity, 'id' | 'kind'> {
    const a = this.attrs();
    return { layer: a.layer, color: a.color, lineStyle: a.lineStyle, lineWidth: a.lineWidth };
  }

  private build(pts: readonly Vec2[], isPreview = false): NewEntity[] | null {
    const b = this.base();
    switch (this.name) {
      case 'line':
        if (pts.length < 2) return null;
        return [{ ...b, kind: 'line', a: pts[0]!, b: pts[1]! }];
      case 'rect':
        if (pts.length < 2) return null;
        return [{ ...b, kind: 'rect', a: pts[0]!, b: pts[1]! }];
      case 'circle': {
        if (pts.length < 2) return null;
        const r = dist(pts[0]!, pts[1]!);
        if (r <= 0) return null;
        return [{ ...b, kind: 'circle', center: pts[0]!, radius: r }];
      }
      case 'arc': {
        if (pts.length < 2) return null;
        const center = pts[0]!;
        const r = dist(center, pts[1]!);
        if (r <= 0) return null;
        const startAngle = angleOf(center, pts[1]!);
        // 3 点目が来るまでは始点だけの弧をプレビューする
        const endAngle = pts.length >= 3 ? angleOf(center, pts[2]!) : startAngle + 0.001;
        return [{ ...b, kind: 'arc', center, radius: r, startAngle, endAngle }];
      }
      case 'polyline':
        if (pts.length < 2) return null;
        return [{ ...b, kind: 'polyline', points: [...pts], closed: false }];
      case 'point':
        if (pts.length < 1) return null;
        return [{ ...b, kind: 'point', at: pts[0]! }];
      case 'text': {
        if (pts.length < 1) return null;
        const text = isPreview ? (this.pendingText || '文字') : this.pendingText;
        if (text === '') return null;
        return [
          {
            ...b,
            kind: 'text',
            at: pts[0]!,
            text,
            height: this.attrs().textHeight,
            rotation: 0,
            hAlign: 'left',
            vAlign: 'baseline',
          },
        ];
      }
      default:
        return null;
    }
  }
}

/** ツールが図形を確定するのに必要なクリック数。`null` は不定（連続線）。 */
export function requiredPoints(name: ToolName): number | null {
  switch (name) {
    case 'point':
    case 'text':
      return 1;
    case 'line':
    case 'rect':
    case 'circle':
    case 'move':
    case 'copy':
      return 2;
    case 'arc':
      return 3;
    case 'polyline':
      return null;
    case 'select':
      return null;
  }
}

/** 次に何をクリックすればよいかの案内文。 */
export function promptFor(name: ToolName, collected: number): string {
  switch (name) {
    case 'select':
      return '図形をクリックして選択（Shift+クリックで追加／空白から左ドラッグで矩形選択）';
    case 'line':
      return collected === 0 ? '始点をクリック' : '終点をクリック';
    case 'rect':
      return collected === 0 ? '1つ目の角をクリック' : '対角をクリック';
    case 'circle':
      return collected === 0 ? '中心をクリック' : '円周上の点をクリック';
    case 'arc':
      return collected === 0 ? '中心をクリック' : collected === 1 ? '始点をクリック' : '終点をクリック（反時計回り）';
    case 'polyline':
      return collected === 0 ? '始点をクリック' : '次の点をクリック（右クリック／Enter で確定）';
    case 'point':
      return '位置をクリック';
    case 'text':
      return '文字の挿入位置をクリック';
    case 'move':
      return collected === 0 ? '基点をクリック' : '移動先をクリック';
    case 'copy':
      return collected === 0 ? '基点をクリック' : '複写先をクリック';
  }
}
