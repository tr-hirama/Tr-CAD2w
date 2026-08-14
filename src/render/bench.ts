/**
 * 描画の計測。
 *
 * **WebGL 化の可否は、この数値を見てから決める**（issue #16）。先に作り込むと
 * 「速くなったのかどうか」を言えない。Canvas 2D で足りているなら WebGL は要らない。
 *
 * 比較の相手はデスクトップ版 TrCad2D の実測（3 万要素）:
 * 一部表示 ≈ 2ms / 全体表示 ≈ 30ms / 超縮小 ≈ 10ms。
 *
 * 図面は**毎回同じもの**が出る（線形合同法の擬似乱数を種つきで使う）。
 * `Math.random()` を使うと計測のたびに図面が変わって比較にならない。
 */

import { CadDocument } from '../core/document.js';
import type { NewEntity } from '../core/entity.js';
import { vec } from '../core/geometry.js';
import { CadView } from '../core/view.js';
import type { Renderer, RenderOptions } from './renderer.js';
import { DEFAULT_RENDER } from './renderer.js';

/** 種つきの擬似乱数（線形合同法）。同じ種なら必ず同じ列が出る。 */
export class Lcg {
  private state: number;

  constructor(seed = 12345) {
    this.state = seed >>> 0;
  }

  /** 0 以上 1 未満。 */
  next(): number {
    // Numerical Recipes の定数
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, maxExclusive: number): number {
    return Math.floor(this.range(min, maxExclusive));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length)]!;
  }
}

/** 計測用の図面の広さ（mm）。実図面（数百 m の現場）に近い値。 */
export const BENCH_EXTENT = 200_000;

/**
 * 計測用の図面を作る。
 *
 * 内訳は実際の測量図に近づけてある（線と点番文字が多く、円と連続線が続く）。
 */
export function generateBenchDocument(count = 30_000, seed = 12345): CadDocument {
  const rng = new Lcg(seed);
  const doc = new CadDocument();
  const layers = ['0', '境界', '道路', '家屋', '電柱'];
  const styles = ['solid', 'solid', 'solid', 'dashed', 'dashdot'] as const;
  const created: NewEntity[] = [];

  for (let i = 0; i < count; i++) {
    const x = rng.range(0, BENCH_EXTENT);
    const y = rng.range(0, BENCH_EXTENT);
    const base = {
      layer: rng.pick(layers),
      color: null,
      lineStyle: rng.pick(styles),
      lineWidth: 0,
    };
    const kind = rng.next();

    if (kind < 0.45) {
      // 線（最も多い）
      created.push({ ...base, kind: 'line', a: vec(x, y), b: vec(x + rng.range(-3000, 3000), y + rng.range(-3000, 3000)) });
    } else if (kind < 0.65) {
      // 点番文字
      created.push({
        ...base,
        layer: '点番',
        kind: 'text',
        at: vec(x, y),
        text: `K${i % 1000}`,
        height: 500,
        rotation: 0,
        hAlign: 'left',
        vAlign: 'baseline',
      });
    } else if (kind < 0.8) {
      created.push({ ...base, kind: 'point', at: vec(x, y) });
    } else if (kind < 0.9) {
      created.push({ ...base, kind: 'circle', center: vec(x, y), radius: rng.range(125, 1500) });
    } else {
      const n = rng.int(3, 8);
      const points = [vec(x, y)];
      for (let k = 1; k < n; k++) {
        const prev = points[k - 1]!;
        points.push(vec(prev.x + rng.range(-2000, 2000), prev.y + rng.range(-2000, 2000)));
      }
      created.push({ ...base, kind: 'polyline', points, closed: rng.next() < 0.3 });
    }
  }
  doc.addAll(created);
  return doc;
}

export interface BenchCase {
  name: string;
  /** 画面に出た図形数。 */
  drawn: number;
  msMedian: number;
  msMin: number;
  msMax: number;
  /** 中央値から出した目安の fps。 */
  fps: number;
  /** 空間インデックスが走査したセル数（画面に映るワールド範囲 ÷ セル幅）。 */
  cells: number;
  /** そのうち索引の引き当てにかかった時間（ms・中央値）。 */
  queryMs: number;
}

export interface BenchResult {
  entities: number;
  canvas: { width: number; height: number };
  cases: BenchCase[];
  /** 図面の生成にかかった時間（ms）。 */
  buildMs: number;
  /** 空間インデックスの構築にかかった時間（ms）。 */
  indexMs: number;
}

export interface BenchOptions {
  count?: number;
  seed?: number;
  /** 1 ケースあたりの描画回数（中央値を取る）。 */
  repeat?: number;
  render?: Partial<RenderOptions>;
}

/**
 * 3 つの見え方で描画時間を測る。
 *
 * | ケース | 何を見るか |
 * |---|---|
 * | 一部表示 | 空間インデックスが効いているか（画面内だけ描けているか） |
 * | 全体表示 | 全図形を描いたときの素の速さ |
 * | 超縮小 | LOD（間引き・破線の実線化）が効いているか |
 */
export function runRenderBench(
  renderer: Renderer,
  canvasSize: { width: number; height: number },
  options: BenchOptions = {},
): BenchResult {
  const { count = 30_000, seed = 12345, repeat = 15 } = options;

  const t0 = performance.now();
  const doc = generateBenchDocument(count, seed);
  const buildMs = performance.now() - t0;

  const t1 = performance.now();
  doc.spatialIndex(); // 最初の 1 回だけ構築のコストが乗るので先に済ませる
  const indexMs = performance.now() - t1;

  const view = new CadView();
  view.resize(canvasSize.width, canvasSize.height);
  const opts: RenderOptions = { ...DEFAULT_RENDER, ...options.render };
  const bounds = doc.bounds();

  const cases: BenchCase[] = [];
  const setups: { name: string; apply: () => void }[] = [
    {
      name: '一部表示（1%）',
      apply: () => {
        view.zoomToFit(bounds);
        view.setScale(view.scale * 10); // 面積で 1% ぶん
      },
    },
    { name: '全体表示', apply: () => view.zoomToFit(bounds) },
    {
      name: '超縮小（1/10）',
      apply: () => {
        view.zoomToFit(bounds);
        view.setScale(view.scale / 10);
      },
    },
  ];

  const index = doc.spatialIndex();

  for (const setup of setups) {
    setup.apply();
    const samples: number[] = [];
    let drawn = 0;
    // 1 回目は JIT の暖機で遅いので捨てる
    for (let i = 0; i <= repeat; i++) {
      const stats = renderer.draw(doc, view, opts);
      if (i > 0) samples.push(stats.ms);
      drawn = stats.drawn;
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? 0;

    // 索引の引き当てだけを切り出して測る（描画そのものと分けたい）
    const world = view.visibleWorld();
    const querySamples: number[] = [];
    for (let i = 0; i <= repeat; i++) {
      const t = performance.now();
      index.query(world);
      if (i > 0) querySamples.push(performance.now() - t);
    }
    querySamples.sort((a, b) => a - b);

    cases.push({
      name: setup.name,
      drawn,
      msMedian: round2(median),
      msMin: round2(samples[0] ?? 0),
      msMax: round2(samples[samples.length - 1] ?? 0),
      fps: median > 0 ? Math.round(1000 / median) : 0,
      cells: countCells(world, index.cellSize),
      queryMs: round2(querySamples[Math.floor(querySamples.length / 2)] ?? 0),
    });
  }

  return { entities: doc.count, canvas: { ...canvasSize }, cases, buildMs: round2(buildMs), indexMs: round2(indexMs) };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** その範囲を引くときに走査するセル数。 */
export function countCells(box: { minX: number; minY: number; maxX: number; maxY: number }, cellSize: number): number {
  if (!(cellSize > 0)) return 0;
  const cols = Math.floor(box.maxX / cellSize) - Math.floor(box.minX / cellSize) + 1;
  const rows = Math.floor(box.maxY / cellSize) - Math.floor(box.minY / cellSize) + 1;
  return Math.max(0, cols) * Math.max(0, rows);
}

/** 計測結果を人が読める表にする（コンソール／issue 貼り付け用）。 */
export function formatBenchResult(r: BenchResult): string {
  const lines = [
    `図形 ${r.entities.toLocaleString()} 件 / canvas ${r.canvas.width}×${r.canvas.height}`,
    `生成 ${r.buildMs}ms / 空間インデックス構築 ${r.indexMs}ms`,
    '',
    '| ケース | 描画数 | 中央値 | 最小 | 最大 | fps | 走査セル | 索引 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const c of r.cases) {
    lines.push(
      `| ${c.name} | ${c.drawn.toLocaleString()} | ${c.msMedian}ms | ${c.msMin}ms | ${c.msMax}ms | ${c.fps} | ` +
        `${c.cells.toLocaleString()} | ${c.queryMs}ms |`,
    );
  }
  return lines.join('\n');
}
