# 家計簿 開発環境

仕様の参照元: [Notion](https://app.notion.com/p/3db704c9a94380e69310da2a6cb984bf?source=copy_link)

TanStack Start を Cloudflare Workers で動かすための基盤です。メール/パスワード認証、Cloudflare D1、Drizzle ORM、Google Cloud Document AI Expense Parser によるレシート OCR の最小確認画面を含みます。

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

`wrangler.jsonc` の `database_id` は未作成状態のプレースホルダーです。本番用 D1 を作成して表示された ID に置き換えてから、マイグレーションとデプロイを行います。

```bash
npx wrangler d1 create kakeibo-2026
# 表示された database_id を wrangler.jsonc に設定する
npx wrangler r2 bucket create kakeibo-2026-receipts
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

## 実装済みの境界

- `/app` と `/api/ocr/receipt` はログイン済みセッションを要求します。
- Better Auth の `user`、`session`、`account`、`verification` テーブルは [Drizzle migration](./drizzle/0000_ancient_spiral.sql) で管理します。D1 は対話的トランザクションに対応しないため、Drizzle adapter は `transaction: false` を使用します。
- [ledger core migration](./drizzle/0001_ledger_core.sql) は、レシート下書き、カテゴリ、明細、明細項目、冪等性キーを D1 で管理します。元画像はユーザーごとの private R2 object として保存し、認証済みの所有者だけが取得できます。
- OCR は PNG / JPEG / WebP を受け付け、画像署名、8 MB のストリーム上限、認証・処理を通した20秒タイムアウトを検証します。OCR 処理に失敗しても、保存済みレシートには受付 ID と認証済み画像取得 URL を返すため、後続の確認・再処理の参照に使えます。
- Document AI への送信先は `us` または `eu` の固定リージョンと Google OAuth / Document AI ホストだけに限定します。Expense Parser の `supplier_name`、`receipt_date`、`currency`、`total_amount`、`line_item` の説明・金額だけを既存の表示形式へ対応付け、不明な値は `null` にします。

## 現在の API

| Endpoint | 用途 |
| --- | --- |
| `GET /api/health` | D1 接続確認 |
| `POST /api/auth/*` | Better Auth の認証 API |
| `POST /api/ocr/receipt` | 元画像を private R2 に保存し、Document AI の OCR 下書きを作成 |
| `GET /api/receipts/:id` | 所有者のレシート下書きを取得 |
| `GET /api/receipts/:id/image` | 所有者だけに private R2 の元画像を返却 |

`npm run test` は20件の基準を拡張した現在22件のユニットテストで、OCR の値正規化・設定エラー、アップロード制約、R2 所有者境界、台帳計算と API 境界を検証します。

## Document AI の準備

Google Cloud で Document AI API を有効化し、対象リージョン（`us` または `eu`）に日本語を扱える Expense Parser プロセッサを作成します。必要なら、そのプロセッサのバージョン ID を `DOCUMENT_AI_PROCESSOR_VERSION` に設定します。空欄ならプロセッサの既定バージョンを使用します。

Workers から使うサービスアカウントには対象プロジェクトで最小権限の `roles/documentai.apiUser` を付与します。サービスアカウントのメールアドレスと PEM 形式の秘密鍵は Workers secret のみへ設定し、JSON キーファイル、秘密鍵、`.dev.vars` をコミットしません。OAuth トークン交換は固定の `oauth2.googleapis.com` だけに送信します。

Expense Parser は10ページ以下の文書で 1 文書あたり $0.10 です。継続的な無料枠は価格表に記載されていません。新規かつ対象の Google Cloud アカウントは $300・90日間の無料トライアルを利用できる場合があります。Document OCR の「最初の1,000ページ無料」は Expense Parser には適用しません。

## 今回は未実装

実際の家計簿画面、銀行連携、資産管理、予算、定期取引、集計・分析、OCR 内容を確定して明細へ反映する画面、カテゴリ分類は未実装です。D1 の台帳コアと private R2 のレシート下書きは準備済みですが、業務画面の完成を意味しません。

`docs/design-reference` に確認できた Figma 参照バッファは4画像のみです。画面仕様を補完するには不足しているため、このアプリの Figma 準拠 UI は未着手です。
