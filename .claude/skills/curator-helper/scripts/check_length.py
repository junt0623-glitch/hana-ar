#!/usr/bin/env python3
"""
check_length.py — 日本語テキストの文字数を機械的に数え、
指定した上限を超えていないか確認する検証スクリプト。

使い方:
    python3 check_length.py --file draft.txt --limit 200
    python3 check_length.py --text "本文をここに直接渡す" --limit 200
    echo "本文" | python3 check_length.py --stdin --limit 200

出力: JSONをstdoutへ出す(diagnosticsはstderr)。
終了コード: 0=制限内 / 1=超過 / 2=入力エラー
"""
import argparse
import json
import sys


def count_chars(text: str) -> int:
    # 改行・空白を除いた文字数(日本語キャプション等の慣例に合わせる)
    return len("".join(text.split()))


def main() -> int:
    parser = argparse.ArgumentParser(description="テキストの文字数を数えて上限と比較する")
    parser.add_argument("--file", help="読み込むテキストファイルのパス")
    parser.add_argument("--text", help="直接渡すテキスト")
    parser.add_argument("--stdin", action="store_true", help="標準入力から読み込む")
    parser.add_argument("--limit", type=int, required=True, help="文字数の上限")
    args = parser.parse_args()

    if sum([bool(args.file), bool(args.text), args.stdin]) != 1:
        print("エラー: --file / --text / --stdin のいずれか1つを指定してください", file=sys.stderr)
        return 2

    try:
        if args.file:
            with open(args.file, "r", encoding="utf-8") as f:
                text = f.read()
        elif args.stdin:
            text = sys.stdin.read()
        else:
            text = args.text
    except OSError as e:
        print(f"エラー: ファイルを読み込めませんでした: {e}", file=sys.stderr)
        return 2

    length = count_chars(text)
    passed = length <= args.limit

    result = {
        "length": length,
        "limit": args.limit,
        "passed": passed,
        "over_by": max(0, length - args.limit),
    }
    print(json.dumps(result, ensure_ascii=False))

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
