/** 起動処理。DOM を拾って `CadApp` に渡すだけ。 */

import { CadApp } from './ui/app.js';

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} が見つかりません`);
  return el as T;
}

const app = new CadApp(required<HTMLCanvasElement>('canvas'), {
  toolbar: required('toolbar'),
  status: required('status'),
  info: required('info'),
  layerList: required('layer-list'),
});

// 動作確認用。開発者ツールから `TrCad2w.snapshot()` などを叩ける
declare global {
  interface Window {
    TrCad2w?: CadApp;
  }
}
window.TrCad2w = app;
