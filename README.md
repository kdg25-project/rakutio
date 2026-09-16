# 家計簿 開発環境

仕様の参照元: [Notion](https://app.notion.com/p/3db704c9a94380e69310da2a6cb984bf?source=copy_link)

TanStack Start を Cloudflare Workers で動かす家計簿アプリです。Figma 参照に合わせたモバイル画面、メール/パスワード認証、Cloudflare D1、Drizzle ORM、Google Cloud Document AI Expense Parser によるレシート OCR を実装しています。

## 構成

| 領域 | 使用技術 |
| --- | --- |
| フレームワーク | TanStack Start + React + TypeScript |
| 認証 | Better Auth（メール/パスワード） |
| データベース | Cloudflare D1（SQLite） |
| ORM / マイグレーション | Drizzle ORM / Drizzle Kit |
| 実行・デプロイ | Cloudflare Workers / Wrangler |
| OCR | Google Cloud Document AI Expense Parser（Workers の Web Crypto によるサービスアカウント OAuth） |

## ローカル起動

```bash
npm install
# .dev.vars がなければ作成する
cp -n .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`http://localhost:5173` を開きます。ワークスペースには起動用の `.dev.vars` が用意されていますが、Git 管理外です。新しい clone では以下でランダム値を作り、`.dev.vars` の `BETTER_AUTH_SECRET` に設定してください。

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`BETTER_AUTH_URL` はローカルでは `http://localhost:5173` です。Document AI の設定またはサービスアカウント鍵が未設定の場合、OCR は安全に 503 を返します。

```bash
npm run typecheck
npm run build
npm run db:generate
npm run cf-typegen
```

## D1・R2 とデプロイ

Cloudflare Workers Builds では、Vite/TanStack Start の生成処理を先に完了させる必要があります。Worker の **Settings → Builds** を次のように設定してください。

| 設定 | 値 |
| --- | --- |
| Root directory | リポジトリ直下（空欄でも可） |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| 非本番ブランチ Deploy command | `npx wrangler versions upload`（既定値） |

`npx wrangler deploy` 単体では TanStack Start が生成するエントリとマニフェストが存在しないため、`#tanstack-router-entry` などを解決できず失敗します。ローカルから一続きで実行する場合だけ、既存の `npm run deploy`（`npm run build && wrangler deploy`）を使えます。Workers Builds の Build command と Deploy command の両方に `npm run deploy` は設定しません。詳細は [デプロイ手順](./docs/deployment.md) を参照してください。

`wrangler.jsonc` には D1 の `database_id` と R2 の binding を設定済みです。デプロイ前に、接続先 Cloudflare アカウントで同じ D1/R2 リソースを確認してからマイグレーションを適用します。

```bash
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

`RECEIPTS` は `wrangler.jsonc` の R2 binding です。ローカルの `wrangler dev` では同じ binding 名を使ってローカル R2 を利用します。本番では上記の R2 bucket を作成したうえで、設定内の `bucket_name` と一致させます。これらのコマンドは手順の案内であり、このリポジトリから Cloudflare リソースを作成・デプロイしていません。

デプロイ完了後、実際の Workers URL または接続した独自ドメインを `BETTER_AUTH_URL` に設定します。たとえば `https://your-worker.your-subdomain.workers.dev` を入力します。ブラウザが使う URL とこの値が一致しないと、Better Auth の Origin 検証でログイン・登録を拒否します。

```bash
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put BETTER_AUTH_URL
npx wrangler secret put DOCUMENT_AI_PROJECT_ID
npx wrangler secret put DOCUMENT_AI_LOCATION
npx wrangler secret put DOCUMENT_AI_PROCESSOR_ID
npx wrangler secret put DOCUMENT_AI_PROCESSOR_VERSION
npx wrangler secret put DOCUMENT_AI_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put DOCUMENT_AI_SERVICE_ACCOUNT_PRIVATE_KEY
```

`.dev.vars` はアップロード・コミットしません。

## 実装済み

- `/app` と `/api/ocr/receipt` はログイン済みセッションを要求します。
- Better Auth の `user`、`session`、`account`、`verification` テーブルは [Drizzle migration](./drizzle/0000_ancient_spiral.sql) で管理します。D1 は対話的トランザクションに対応しないため、Drizzle adapter は `transaction: false` を使用します。
- Figma 参照に合わせたホーム、履歴、明細登録、分析、設定、プロフィール、資産、予算、定期取引の画面とアプリ内遷移を提供します。
- [ledger core migration](./drizzle/0001_ledger_core.sql) と後続 migration は、レシート下書き、複数ページ、カテゴリ、明細、資産、予算、定期取引、プロフィール設定を D1 で管理します。元画像はユーザーごとの private R2 object として保存し、認証済みの所有者だけが取得できます。
- レシートは PNG / JPEG / WebP を受け付け、画像署名、8 MB のストリーム上限、認証・処理を通した20秒タイムアウトを検証します。カメラでは `getUserMedia` によるライブ撮影と端末ファイル選択を使え、複数ページの追加、ページ別の状態表示、失敗ページの再読み取りに対応します。
- OCR 処理に失敗しても、保存済みレシートには受付 ID と認証済み画像取得 URL を返すため、後続の確認・再処理の参照に使えます。
- Document AI への送信先は `us` または `eu` の固定リージョンと Google OAuth / Document AI ホストだけに限定します。Expense Parser の `supplier_name`、`receipt_date`、`currency`、`total_amount`、`line_item` の説明・金額だけを既存の表示形式へ対応付け、不明な値は `null` にします。

## 現在の API

| Endpoint | 用途 |
| --- | --- |
| `GET /api/health` | D1 接続確認 |
| `POST /api/auth/*` | Better Auth の認証 API |
| `POST /api/ocr/receipt` | 元画像を private R2 に保存し、Document AI の OCR 下書きを作成 |
| `GET /api/receipts/:id` | 所有者のレシート下書きを取得 |
| `GET /api/receipts/:id/image` | 所有者だけに private R2 の元画像を返却 |

`npm run test` は OCR の値正規化・設定エラー、複数ページのアップロードと再試行、R2 所有者境界、台帳計算、認証導線、画面レイアウトと API 境界を検証します。

## Document AI の準備

Google Cloud で Document AI API を有効化し、対象リージョン（`us` または `eu`）に日本語を扱える Expense Parser プロセッサを作成します。必要なら、そのプロセッサのバージョン ID を `DOCUMENT_AI_PROCESSOR_VERSION` に設定します。空欄ならプロセッサの既定バージョンを使用します。

Workers から使うサービスアカウントには対象プロジェクトで最小権限の `roles/documentai.apiUser` を付与します。サービスアカウントのメールアドレスと PEM 形式の秘密鍵は Workers secret のみへ設定し、JSON キーファイル、秘密鍵、`.dev.vars` をコミットしません。OAuth トークン交換は固定の `oauth2.googleapis.com` だけに送信します。

Expense Parser は10ページ以下の文書で 1 文書あたり $0.10 です。継続的な無料枠は価格表に記載されていません。新規かつ対象の Google Cloud アカウントは $300・90日間の無料トライアルを利用できる場合があります。Document OCR の「最初の1,000ページ無料」は Expense Parser には適用しません。

## 本番前に確認すること

- Cloudflare の接続先で D1/R2 resource、全 migration、Workers Builds の設定を確認します。ローカルの build・テスト結果はリモート D1/R2 への適用や公開を意味しません。
- `BETTER_AUTH_SECRET`、公開 URL に一致する `BETTER_AUTH_URL`、Document AI の project/location/processor/サービスアカウント secret を Workers に設定し、実際の登録・ログイン・OCR を確認します。
- ライブ撮影は HTTPS とカメラ権限が必要です。実端末での権限許可、前後カメラ切替、撮影から OCR 完了までの動作は別途確認します。
- Document AI の processor 権限、利用上限、課金、実レシートの抽出精度は Google Cloud 側の設定と本番 secret に依存するため、実環境で確認します。
