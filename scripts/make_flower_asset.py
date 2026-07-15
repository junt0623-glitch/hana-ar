#!/usr/bin/env python3
"""花材画像の一括処理スクリプト（引き継ぎ一式 §8 タスク4）

無地背景で撮影・生成された花材写真を、hana-ar.html に埋め込める形へ加工する。

処理内容:
  1. 背景除去   : 画像の四辺から背景色（無地・中間グレー等）をフラッドフィルで辿って透過化。
                  花・枝の内部に背景色と似た画素があっても、外周から連結していなければ残る。
  2. フリンジ抑制: 透過境界のうち背景色に近い縁画素のアルファを緩やかに落とす。
  3. トリム     : 不透明画素のバウンディングボックスで切り出し（左右下に少し余白）。
  4. リサイズ   : 縦1200px基準・長辺1600px上限（花材撮影仕様書 §2）。
  5. WebP出力   : 150〜250KB目安に品質を自動探索。
  6. アンカー計測: 「留め」= 最下端の不透明画素行の重心を相対座標 {x, y} で出力。
  7. base64     : hana-ar.html の flowers[].img に貼れる data URI とJSON断片を出力。

使い方:
  python3 scripts/make_flower_asset.py 入力画像 出力名.webp [--tolerance 28] [--gradient] [--morimono]
  例（無地背景の一枝もの）: python3 scripts/make_flower_asset.py _incoming/regen3.jpg winter-bunjin-robai.webp
  例（グラデ背景の一枝もの）: python3 scripts/make_flower_asset.py _incoming/botan1.jpg spring-bunjin-botan.webp --gradient
  例（盛物）: python3 scripts/make_flower_asset.py _incoming/busshu3.jpg winter-morimono-busshukan.webp --morimono
出力:
  出力名.webp / 出力名.webp.json（アンカー・サイズ・data URI を含むメタ情報）
"""
import sys
import json
import base64
import argparse
from collections import deque
from PIL import Image


def flood_background_mask(img, tolerance, gradient=False, sat_tol=30, local_tol=16):
    """四辺から背景連結領域を探索し、背景画素の集合(bytearray mask)を返す。

    通常モード: 各画素を四辺平均の背景色と比較（tolerance以内なら背景）。無地背景向け。
    gradientモード: 背景がグラデーション（口径の広い花器の陰影・ビネット等）でも扱えるよう、
      「低彩度（sat_tol以内）かつ隣接背景画素との明度差がlocal_tol以内」で連結を広げる。
      彩度の高い花弁・葉・枝には侵入せず、明度が緩やかに変化する無彩色背景だけを辿る。
    """
    w, h = img.size
    px = img.load()

    border = []
    for x in range(w):
        border.append(px[x, 0][:3])
        border.append(px[x, h - 1][:3])
    for y in range(h):
        border.append(px[0, y][:3])
        border.append(px[w - 1, y][:3])
    n = len(border)
    bg = tuple(sum(c[i] for c in border) // n for i in range(3))

    def lum(c):
        return (c[0] * 299 + c[1] * 587 + c[2] * 114) // 1000

    def sat(c):
        return max(c) - min(c)

    if gradient:
        def seed_ok(c):
            return sat(c) <= sat_tol and abs(lum(c) - lum(bg)) <= tolerance

        def grow_ok(c, src):
            return sat(c) <= sat_tol and abs(lum(c) - lum(src)) <= local_tol
    else:
        def seed_ok(c):
            return (abs(c[0] - bg[0]) <= tolerance
                    and abs(c[1] - bg[1]) <= tolerance
                    and abs(c[2] - bg[2]) <= tolerance)

        def grow_ok(c, src):
            return seed_ok(c)

    mask = bytearray(w * h)  # 1 = 背景
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not mask[y * w + x] and seed_ok(px[x, y][:3]):
                mask[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not mask[y * w + x] and seed_ok(px[x, y][:3]):
                mask[y * w + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        src = px[x, y][:3]
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not mask[ny * w + nx]:
                if grow_ok(px[nx, ny][:3], src):
                    mask[ny * w + nx] = 1
                    q.append((nx, ny))
    return mask, bg


def remove_background(img, tolerance, gradient=False):
    img = img.convert("RGBA")
    w, h = img.size
    mask, bg = flood_background_mask(img, tolerance, gradient=gradient)
    px = img.load()
    # 背景を透過に
    for y in range(h):
        row = y * w
        for x in range(w):
            if mask[row + x]:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    # フリンジ抑制: 透過画素に隣接する不透明画素のうち背景色に近いものはアルファを半減
    for y in range(h):
        row = y * w
        for x in range(w):
            if not mask[row + x]:
                near_bg = any(
                    0 <= nx < w and 0 <= ny < h and mask[ny * w + nx]
                    for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))
                )
                if near_bg:
                    r, g, b, a = px[x, y]
                    d = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
                    if d < tolerance * 4:
                        px[x, y] = (r, g, b, a // 2)
    return img


def _global_bg_mask(img_rgba, tolerance, gradient):
    """連結性を使わず、背景色に近い画素を全て背景とみなすマスク（bytearray）。
    葉などに囲まれ外周とつながらない内部の背景ポケットも除去できる。
    被写体に背景色（無彩色・淡色）の部分が無い花材専用（例: 桂花・石榴花）。
    """
    w, h = img_rgba.size
    px = img_rgba.load()
    border = []
    for x in range(w):
        border.append(px[x, 0][:3]); border.append(px[x, h - 1][:3])
    for y in range(h):
        border.append(px[0, y][:3]); border.append(px[w - 1, y][:3])
    n = len(border)
    bg = tuple(sum(c[i] for c in border) // n for i in range(3))
    def lum(c): return (c[0]*299 + c[1]*587 + c[2]*114)//1000
    def sat(c): return max(c) - min(c)
    mask = bytearray(w * h)
    for y in range(h):
        row = y*w
        for x in range(w):
            c = px[x, y][:3]
            if gradient:
                ok = sat(c) <= 30 and abs(lum(c) - lum(bg)) <= tolerance
            else:
                ok = (abs(c[0]-bg[0]) <= tolerance and abs(c[1]-bg[1]) <= tolerance
                      and abs(c[2]-bg[2]) <= tolerance)
            if ok:
                mask[row + x] = 1
    return mask, bg


def remove_background_precise(img, tolerance=28, gradient=False, band=3,
                             feather_lo=None, feather_hi=None,
                             speck_frac=0.0002, hole_frac=0.0008, connected=True):
    """高精度な背景除去（numpy/scipy利用）。切り抜き境界の甘さを最小化する。

    通常/フリンジ抑制版(remove_background)との違い:
      - アンチエイリアス: 境界画素のアルファを背景色との距離で連続的に決め、ギザつきを無くす
      - エッジ除染(despill): 半透明画素から背景色の混色分を差し引き、灰色のフチ残りを消す
      - 背景場推定: 前景を最近傍背景色で埋めた「背景色マップ」を基準にするためグラデ背景に強い
      - ゴミ除去: 微小な不透明の孤立塊（切り抜き残り）を除去
      - 穴埋め: 被写体内部の小さな透明穴（背景色に近い花芯等の誤除去）を埋める
    numpy/scipy が無い環境では ImportError。その場合は remove_background にフォールバックする。
    """
    import numpy as np
    from scipy import ndimage

    src = img.convert("RGB")
    w, h = src.size
    arr = np.asarray(src, dtype=np.float32)  # (h, w, 3)

    # 1) 背景マスク。connected=True は外周からのフラッドフィル（被写体内の同色域を保護）、
    #    connected=False は色のみで判定（葉に囲まれた内部の背景ポケットも除去）
    if connected:
        mask_bytes, _bg = flood_background_mask(src.convert("RGBA"), tolerance, gradient=gradient)
    else:
        mask_bytes, _bg = _global_bg_mask(src.convert("RGBA"), tolerance, gradient=gradient)
    bg_mask = np.frombuffer(bytes(mask_bytes), dtype=np.uint8).reshape(h, w).astype(bool)
    fg_mask = ~bg_mask
    if not fg_mask.any():
        raise SystemExit("エラー: 不透明画素がありません（toleranceを下げてください）")

    # 2) 背景色マップ: 前景画素を最近傍の背景画素色で埋める（グラデ背景の局所基準色）
    idx = ndimage.distance_transform_edt(fg_mask, return_distances=False, return_indices=True)
    bg_field = arr[tuple(idx)]  # (h, w, 3)

    # 3) 局所背景との色距離 → 境界のソフトアルファ
    dist = np.abs(arr - bg_field).sum(axis=2)  # 0..765
    lo = tolerance if feather_lo is None else feather_lo
    hi = tolerance * 3 if feather_hi is None else feather_hi
    alpha_color = np.clip((dist - lo) / max(1.0, (hi - lo)), 0.0, 1.0)

    # 4) 境界帯（背景からband px以内の前景）だけをソフト化。内部前景は完全不透明のまま
    dfrombg = ndimage.distance_transform_edt(fg_mask)
    band_mask = fg_mask & (dfrombg <= band)
    alpha = fg_mask.astype(np.float32)
    alpha[band_mask] = alpha_color[band_mask]
    alpha[bg_mask] = 0.0

    # 5) エッジ除染: 半透明画素の色から背景寄与を差し引く（灰色フチ除去）
    a3 = alpha[:, :, None]
    with np.errstate(divide="ignore", invalid="ignore"):
        fg_col = (arr - (1.0 - a3) * bg_field) / np.where(a3 > 0, a3, 1.0)
    fg_col = np.clip(fg_col, 0, 255)
    partial = (alpha > 0) & (alpha < 1)
    out_rgb = arr.copy()
    out_rgb[partial] = fg_col[partial]

    # 6) 微小な不透明ゴミの除去（面積 < speck_frac の孤立塊）
    solid = alpha > 0.5
    lbl, n = ndimage.label(solid)
    if n > 0:
        sizes = ndimage.sum(np.ones_like(lbl), lbl, index=range(1, n + 1))
        min_area = max(30.0, speck_frac * h * w)
        keep = np.where(sizes >= min_area)[0] + 1
        drop = solid & ~np.isin(lbl, keep)
        alpha[drop] = 0.0

    # 7) 被写体内部の小さな透明穴を埋める（外周に連結しない透明塊のみ）
    holes = alpha < 0.5
    lblh, nh = ndimage.label(holes)
    if nh > 0:
        border = set(np.unique(np.concatenate(
            [lblh[0, :], lblh[-1, :], lblh[:, 0], lblh[:, -1]])).tolist())
        for lab in range(1, nh + 1):
            if lab in border:
                continue
            comp = lblh == lab
            if comp.sum() < hole_frac * h * w:
                alpha[comp] = 1.0

    out = np.dstack([out_rgb, alpha * 255.0]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def trim_and_resize(img, target_h=1200, max_long=1600, pad=8):
    bbox = img.getbbox()  # アルファ0を除いた範囲
    if bbox is None:
        raise SystemExit("エラー: 不透明画素がありません（背景除去のtoleranceを下げてください）")
    l, t, r, b = bbox
    l = max(0, l - pad)
    t = max(0, t - pad)
    r = min(img.width, r + pad)
    b = min(img.height, b + pad)
    img = img.crop((l, t, r, b))
    scale = target_h / img.height
    if max(img.width * scale, target_h) > max_long:
        scale = max_long / max(img.width, img.height)
    img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                     Image.LANCZOS)
    return img


def compute_anchor(img, morimono=False):
    """アンカー（配置エンジンが器の口に合わせる基準点）を相対座標 {x, y} で返す。

    通常（一枝もの）: 「留め」= 最下端の不透明画素帯の重心。茎の切り口が器の口に来る。
    盛物（morimono）: 茎の留めが無く器（盤）の上に果実・株が載る構成のため、
      全不透明画素の水平重心・最下端を基準にする（左右に張り出す葉に引っ張られないよう
      帯ではなく全体重心のxを使う）。
    """
    w, h = img.size
    alpha = img.getchannel("A").load()
    bottom = None
    for y in range(h - 1, -1, -1):
        if any(alpha[x, y] > 32 for x in range(w)):
            bottom = y
            break
    if morimono:
        xs = [x for y in range(h) for x in range(w) if alpha[x, y] > 32]
        ax = sum(xs) / len(xs) / w
    else:
        band = 6
        xs = [x for y in range(max(0, bottom - band + 1), bottom + 1)
              for x in range(w) if alpha[x, y] > 32]
        ax = sum(xs) / len(xs) / w
    ay = bottom / h
    return {"x": round(ax, 3), "y": round(ay, 3)}


def save_webp(img, path, max_kb=250):
    """上限250KB（花材撮影仕様書 §2）以下で最も高い品質を採用する"""
    for q in range(95, 30, -5):
        img.save(path, "WEBP", quality=q, method=6)
        kb = len(open(path, "rb").read()) / 1024
        if kb <= max_kb:
            return q, kb
    raise SystemExit("エラー: 容量が仕様(250KB)に収まりません。解像度を下げてください")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--tolerance", type=int, default=28,
                    help="背景色の許容差（無地背景のムラに応じて調整。既定28）")
    ap.add_argument("--gradient", action="store_true",
                    help="背景がグラデーション（口径の広い花器の陰影・ビネット等）の場合に指定。"
                         "低彩度＋近傍明度差で背景を辿る")
    ap.add_argument("--morimono", action="store_true",
                    help="盛物（茎の留めが無く器の上に載る構成）。アンカーを全体水平重心にする")
    ap.add_argument("--band", type=int, default=3,
                    help="高精度モードで境界をソフト化する帯の幅(px)。既定3")
    ap.add_argument("--feather", type=int, nargs=2, metavar=("LO", "HI"), default=None,
                    help="高精度モードのソフトアルファ境界（色距離 lo hi）。既定 tolerance と tolerance*3")
    ap.add_argument("--global", dest="global_bg", action="store_true",
                    help="連結性を使わず色だけで背景除去（葉に囲まれた内部の背景ポケットも除去）。"
                         "被写体に淡色・無彩色部分が無い花材専用（例: 桂花・石榴花）")
    ap.add_argument("--legacy", action="store_true",
                    help="numpy/scipyを使わず旧フリンジ抑制方式で処理する（フォールバック）")
    args = ap.parse_args()

    img = Image.open(args.input)
    lo, hi = (args.feather if args.feather else (None, None))
    if args.legacy:
        img = remove_background(img, args.tolerance, gradient=args.gradient)
    else:
        try:
            img = remove_background_precise(img, args.tolerance, gradient=args.gradient,
                                            band=args.band, feather_lo=lo, feather_hi=hi,
                                            connected=not args.global_bg)
        except ImportError:
            print("警告: numpy/scipy が無いため旧方式にフォールバックします")
            img = remove_background(img, args.tolerance, gradient=args.gradient)
    img = trim_and_resize(img)
    anchor = compute_anchor(img, morimono=args.morimono)
    q, kb = save_webp(img, args.output)

    data = base64.b64encode(open(args.output, "rb").read()).decode()
    meta = {
        "file": args.output,
        "width": img.width,
        "height": img.height,
        "quality": q,
        "kb": round(kb, 1),
        "anchor": anchor,
        "img": "data:image/webp;base64," + data,
    }
    with open(args.output + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(f"OK: {args.output} {img.width}x{img.height} q={q} {kb:.0f}KB anchor={anchor}")
    print(f"メタ情報: {args.output}.json（imgキーが data URI）")


if __name__ == "__main__":
    main()
