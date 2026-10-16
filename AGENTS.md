# AGENTS.md — pi-chat-view

読者: pi-chat-view を変更するエージェントと開発者。利用者向けの仕様は README、設計判断は DESIGN.md と [docs/adr/](docs/adr/)。
共通の検証と規則はルートの `AGENTS.md` にある。

## 壊してはいけない制約

### 拡張の登録と起動

- 登録するコマンドは `chat-view` だけ。ツールを登録しない（恒久のコンテキストコストは 0）。フックは `session_shutdown` だけ（`test/contract/surface.test.ts`）。
- 読み込み時にはサーバー・タイマー・ウォッチを起動しない。停止は冪等で、shutdown と `/chat-view stop` は同じ経路に収束する。起動中に届いた停止も、起動したサーバーを閉じる（`test/integration/extension.test.ts`）。
- 起動失敗と不明な引数は例外にせず通知する。ポート使用中は理由の分かるエラーで起動に失敗する（`test/integration/server.test.ts`）。`port` が不正なら既定値に戻して警告する（`test/unit/config.test.ts`）。
- `/chat-view status` は稼働状態・使用ポート・設定ファイルを通知し、不正な設定は警告行で示す（`test/integration/extension.test.ts`）。

### HTTP と表示

- 待ち受けは `127.0.0.1` のみ。ルートは `/`、`/favicon.ico`、`/api/threads`、`/api/thread/<id>` だけ。GET 以外は 405（`test/integration/server.test.ts`）。
- API 応答は `cache-control: no-store`。`limit` は 1〜1000、不正値と欠落は既定 100（`test/integration/server.test.ts`）。
- ページが叩く API は `/api/threads` と `/api/thread/` の2つだけ（`test/contract/page.test.ts`）。
- 表示は text node だけで行い、`innerHTML` を使わない（`test/contract/page.test.ts`）。`getElementById` が指す id はすべて markup にある（`test/contract/page.test.ts`）。
- reasoning とツールはトグルで表示を切り替える（`test/contract/page.test.ts`）。

### 設定とスレッド化

- 子セッションの場所は `<agentDir>/spawn-sessions`（`test/integration/extension.test.ts`）。
- スレッドは兄弟一覧の参照の連結成分。存在するファイルの id だけを辺にする。表示名は他ファイルの兄弟一覧から復元し、無ければ id を使う（`test/unit/transcript.test.ts`）。
- 兄弟一覧は `name (id)` と KV 形式（`target_run_id=` / `target_session_id=`）の両方を読む。解釈できない兄弟一覧はスレッドに警告を付ける（`test/unit/format-compat.test.ts`）。
- 配送の複製は、本文が一致する送信側の発言があるときだけ除外する。配送ヘッダーは `from_run_id=` と `from_session_id=` の両方を除く。指示の本文から兄弟一覧を除く（`test/unit/transcript.test.ts`）。
- 継承した親の履歴は子の会話として表示しない。親セッションが無いときは継承を切り分けずに読み進める（`test/unit/transcript.test.ts`）。
- 分岐した transcript は最後の entry の分岐だけを表示する。分岐を読めないファイルは書かれた順に表示する（`test/unit/transcript.test.ts`）。
- タイムラインは時刻順。同時刻はファイル順で安定させる。空の thinking / text はエントリにせず、不明な種別は無視する（`test/unit/transcript.test.ts`）。
- ファイル不在・ヘッダー欠落・書き込み途中の行でも落ちない（`test/unit/transcript.test.ts`）。

### 依存関係

- 実行時依存を持たない。`src` の import は node builtin・相対 `.ts`・Pi 提供パッケージだけ（`test/contract/dependencies.test.ts`）。
- 配布は `files` の whitelist と一致させ、`src/web/index.html` を含める（`test/ci/package-contents.test.ts`）。

## 変更手順

- ルート・ページの API を増減するときは、`test/integration/server.test.ts` と `test/contract/page.test.ts` を先に更新する。
- スレッド化・表示名・配送の除外規則を変えるときは、`test/unit/transcript.test.ts` を先に更新し、関係する ADR（[0001](docs/adr/0001-web-view-of-spawn-conversations.md)）を読む。
- 兄弟一覧の形式に追随するときは、`test/unit/format-compat.test.ts` の fixture を先に更新する。
- 手動で確認する項目は [docs/manual-checks.md](docs/manual-checks.md) に書く。
