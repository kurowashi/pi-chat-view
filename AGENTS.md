# AGENTS.md — pi-chat-view で作業するエージェント向けの指示

読者は pi-chat-view を変更する AI エージェントと開発者です。
利用者向けの仕様は [README](README.md) に、設計の判断基準は [DESIGN.md](DESIGN.md) と [PHILOSOPHY.md](PHILOSOPHY.md)（このプラグイン群共通）に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。
制約の正はテストで、下の表はその索引です。
実装と表が食い違った場合はテストが正です。
検証手段を併記できないものは制約として書かず、自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`（= `npm run check` + `npm test` + `npm run test:coverage`）が通ること。
フックが通っても CI が通らなければ未完了です。
CI は同じ `verify` を Node 22.19 / 24 で実行します。
カバレッジは `test/unit` と `test/integration` で計測します。
下の表の「検証」列は個別の検証箇所であり、自動検証はすべて `verify` に含まれます。

## 制約

### 拡張の面

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 登録するコマンドは `chat-view` だけ | `test/contract/surface.test.ts` | `src/command.ts` の `registerChatViewCommand` |
| ツールを登録しない（恒久のコンテキストコストは 0） | `test/contract/surface.test.ts` | `src/index.ts` |
| フックは `session_shutdown` だけ | `test/contract/surface.test.ts` | `src/command.ts` |
| 読み込み時にはサーバーもタイマーもウォッチも起動しない | `test/contract/surface.test.ts` | `src/command.ts` の遅延起動 |
| 停止は冪等（shutdown と `/chat-view stop` が同じ経路に収束する） | `test/integration/extension.test.ts` | `src/command.ts` の `close` |
| 起動中に届いた停止も、起動したサーバーを閉じる | `test/integration/extension.test.ts` | `src/command.ts` の `pending` |
| 起動失敗と不明な引数は例外にせず通知する | `test/integration/extension.test.ts` | `src/command.ts` の `run` |

### サーバー

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 待ち受けは `127.0.0.1` のみ | `test/integration/extension.test.ts` | `src/server.ts` の `LOOPBACK` |
| ルートは `/`、`/favicon.ico`、`/api/threads`、`/api/thread/<id>` だけ | `test/integration/server.test.ts` | `src/server.ts` の `route` |
| GET 以外は 405 で拒否する | `test/integration/server.test.ts` | `src/server.ts` の `route` |
| API 応答は `cache-control: no-store` | `test/integration/server.test.ts` | `src/server.ts` の `sendJson` |
| `limit` は 1〜1000、不正値と欠落は既定 100 | `test/integration/server.test.ts` | `src/server.ts` の `limitOf`、`src/transcript.ts` の `THREAD_LIMIT` |
| ポート使用中は理由の分かるエラーで起動に失敗する | `test/integration/server.test.ts` | `src/server.ts` の `listen` |
| 設定 `port` が不正なら既定 7787 に戻して警告する | `test/unit/config.test.ts` | `src/config.ts` |
| 子セッションの場所は `<agentDir>/spawn-sessions` | `test/integration/extension.test.ts` | `src/command.ts` の `SPAWN_SESSIONS` |

### 読み取りと同定

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| スレッドは兄弟一覧の参照の連結成分。存在するファイルの id だけを辺にする | `test/unit/transcript.test.ts` | `src/transcript.ts` の `buildThreads` |
| 兄弟一覧は `name (id)` と KV 形式 `target_run_id= / target_session_id=` を読む | `test/unit/transcript.test.ts` | `src/transcript.ts` の `extractBriefing` |
| 表示名は他ファイルの兄弟一覧から復元し、無ければ id を使う | `test/unit/transcript.test.ts` | `src/transcript.ts` の `referenceLabels` |
| 配送の複製は、本文が一致する送信側の発言がある場合だけ除外する | `test/unit/transcript.test.ts` | `src/transcript.ts` の `filterDeliveries` |
| 配送ヘッダーは `from_run_id=` と `from_session_id=` の両方を除く | `test/unit/transcript.test.ts` | `src/transcript.ts` の `stripDeliveryHeader` |
| 分岐した transcript は最後の entry の分岐だけを表示する | `test/unit/transcript.test.ts` | `src/transcript.ts` の `activeBranch` |
| 分岐を読み取れないファイルは書かれた順に表示する | `test/unit/transcript.test.ts` | `src/transcript.ts` の `activeBranch` |
| 解釈できない兄弟一覧はスレッドに警告を付ける | `test/unit/format-compat.test.ts` | `src/transcript.ts` の `unparsedBriefing` |
| 継承した親の履歴を子の会話として表示しない | `test/unit/transcript.test.ts` | `src/transcript.ts` の `scanHead` / `isInherited` |
| 親セッションが無いときは継承を切り分けずに読み進める | `test/unit/transcript.test.ts` | `src/transcript.ts` の `taskPromptStops` |
| 指示の本文から兄弟一覧を除く | `test/unit/transcript.test.ts` | `src/transcript.ts` の `stripBriefing` |
| タイムラインは時刻順。同時刻はファイル順で安定 | `test/unit/transcript.test.ts` | `src/transcript.ts` の `comparePlacement` |
| 空の thinking / text はエントリにしない。不明な種別は無視する | `test/unit/transcript.test.ts` | `src/transcript.ts` の `textEntry` / `partEntries` |
| ファイル不在・ヘッダー欠落・書き込み途中の行でも落ちない | `test/unit/transcript.test.ts` | `src/transcript.ts` の `scanChildFile` / `readTailTimestamp` |

### ページ

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `getElementById` が指す id はすべて markup にある | `test/contract/page.test.ts` | `src/web/index.html` |
| 表示は `textContent` のみ（`innerHTML` を使わない） | `test/contract/page.test.ts` | `src/web/index.html` |
| ページが叩く API は `/api/threads` と `/api/thread/` の2つだけ | `test/contract/page.test.ts` | `src/web/index.html` |
| reasoning とツールはトグルで表示を切り替える | `test/contract/page.test.ts` | `src/web/index.html` の `show-reasoning` / `show-tools` |

### 依存関係・配布

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない（`dependencies` を持たない） | `test/contract/dependencies.test.ts` | `package.json` |
| `src` の import は node builtin / 相対 `.ts` / Pi 提供パッケージの3種のみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_PEER_DEPENDENCIES` |
| devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_DEV_DEPENDENCIES` |
| 公開物は `files` の whitelist と一致し、`src/web/index.html` を含む | `test/ci/package-contents.test.ts` | `package.json` の `files` |

## 手動で確認する範囲

自動テストで代替できないため、変更時は次を手元で確認します。結果は PR の本文に残します。

| 確認 | 手順 |
|---|---|
| 実データの表示 | 実際の spawn を1回行い、`/chat-view` でスレッド一覧とタイムラインが出ること |
| 実行中の追記 | 子が動いている間にブラウザを開き、新しい発言が1.5秒以内に現れること |
| 終了時の停止 | Pi を終了した後に URL が開けなくなること |
| 表示の崩れ | 長文・改行・引用符・絵文字を含む発言が崩れず、HTML として解釈されないこと |
| 分岐 | `resume_entry_id` で過去の位置から再開し、破棄した分岐が表示されないこと |
