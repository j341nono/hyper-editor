# hyper-editor

Hyper terminal 上で動作する、Vim ライクなテキストエディタープラグイン。`Ctrl+Shift+E` でターミナル上にエディターをオーバーレイ表示し、モーダル編集・ファイルの読み書きができます。

> 現在テスト運用中のため、npm には公開していません。使用する際は後述のインストール手順に従ってください。

## 機能

- **モーダル編集** — Normal / Insert / Visual モード
- **Vim キーバインド** — 移動・編集・コピー＆ペーストなど主要操作に対応
- **ファイル操作** — `:e` で開く、`:w` で保存、`:q` で閉じる
- **シンタックスハイライト** — `.js` `.ts` `.tsx` `.jsx` `.json` `.css` `.html` `.md` `.py`
- **ワンキー切替** — `Ctrl+Shift+E` でエディターのオン・オフ

## 動作環境

- [Hyper](https://hyper.is) v3 以上
- macOS（Windows / Linux は未検証）

## インストール

```bash
cd ~/.hyper_plugins/local
git clone https://github.com/j341nono/hyper-editor.git
cd hyper-editor
npm install
```

次に `~/.hyper.js` の `localPlugins` に追加します。

```js
localPlugins: [
  "hyper-editor",
],
```

Hyper Terminal を再起動すると有効になります。

## 使い方

### エディターの起動・終了

| 操作 | キー |
|------|------|
| エディターを開く / 閉じる | `Ctrl+Shift+E` |

起動すると画面中央にファイルパス入力欄が表示されます。

- パスを入力して `Enter` → そのファイルを開く（存在しない場合は新規作成）
- 何も入力せずに `Enter` → 空のバッファで開く
- `Esc` → キャンセルして閉じる

### モード

| モード | 切替方法 |
|--------|---------|
| Normal | `Esc` |
| Insert | `i` `a` `o` など |
| Visual | `v` |
| Visual Line | `V` |

### Normal モードの主要操作

| キー | 動作 |
|------|------|
| `h` `j` `k` `l` | 左・下・上・右移動 |
| `w` `b` | 単語単位で前後に移動 |
| `0` `$` | 行頭・行末 |
| `gg` `G` | ファイル先頭・末尾 |
| `dd` | 行を削除 |
| `yy` | 行をコピー |
| `p` | ペースト |
| `u` | Undo |
| `Ctrl+r` | Redo |
| `/` | 検索 |

### コマンド（Normal モードで `:` から入力）

| コマンド | 動作 |
|---------|------|
| `:e ~/path/to/file` | ファイルを開く |
| `:w` | 上書き保存 |
| `:w ~/path/to/file` | 名前をつけて保存 |
| `:q` | エディターを閉じる |
| `:wq` | 保存して閉じる |

