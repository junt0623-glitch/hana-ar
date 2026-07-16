# AI生成花材の元WebP（調達区分③）

`scripts/make_flower_asset.py` で加工した透過WebPの保管場所。
アプリ本体 `hana-ar.html` の `FLOWERS[].img` には、これらを base64 で埋め込んでいる
（単一HTML・オフライン原則のため）。差し替え・再加工の際の元ファイルとして参照する。

| ファイル | ID | 花材 | 調達 | 状態 |
|---|---|---|---|---|
| winter-bunjin-robai.webp | F021 | 蝋梅 | ③ Canva AI | 考証チェック待ち |
| spring-bunjin-botan.webp | F029 | 牡丹 | ③ Canva AI | 考証チェック待ち |
| summer-bunjin-zakurobana.webp | F009 | 石榴花 | ③ Canva AI | 考証チェック待ち |
| autumn-bunjin-keika.webp | F016 | 桂花 | ③ Canva AI | 考証チェック待ち |
| spring-bunjin-ume-zanshun.webp | F001 | 梅（残春） | ①の暫定(AI生成) | 考証チェック待ち |
| spring-bunjin-kaido.webp | F002 | 海棠 | ①の暫定(AI生成) | 考証チェック待ち |
| spring-bunjin-ran.webp | F003 | 蘭 | ①の暫定(AI生成) | 考証チェック待ち |
| spring-gyo-momo.webp | F004 | 桃 | ②の暫定(AI生成) | 考証チェック待ち |

考証チェックで不採用になった花材は、`hana-ar.html` の該当 `FLOWERS` エントリを削除し、
`素材調達管理シート.xlsx` の状態を戻すこと。
