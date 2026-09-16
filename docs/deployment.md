# Cloudflare Workers Builds の設定

このアプリは TanStack Start と Cloudflare Vite plugin を使います。`npm run build` が TanStack の仮想エントリとサーバーマニフェストを `dist/` に生成し、その後の Wrangler が生成済みの `dist/server/wrangler.json` を読んで Worker をデプロイします。

Cloudflare ダッシュボードで **Workers & Pages → rakutio → Settings → Builds** を開き、次を保存します。

| 設定 | 値 |
| --- | --- |
| Root directory | リポジトリ直下（空欄でも可） |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| 非本番ブランチ Deploy command | `npx wrangler versions upload` |

Cloudflare Workers Builds は Build command と Deploy command を別々に実行します。このため、Build command を空欄にして `npx wrangler deploy` だけを実行すると、TanStack Start が生成する `#tanstack-router-entry`、`#tanstack-start-entry`、`tanstack-start-manifest:v` を Wrangler が解決できず失敗します。

`wrangler.jsonc` の Worker 名はダッシュボードに接続した Worker と同じ `rakutio` です。D1 と R2 の既存リソース名は Worker 名と別なので、ここでは変更しません。また `database_id` はプレースホルダーのままです。実在する D1 の ID を確認してから設定してください。

## ローカルでの検証

Cloudflare に公開せず、生成物を検査するには次を順番に実行します。

```bash
npm run build
npx wrangler deploy --dry-run
```

通常のローカル公開は次で行います。

```bash
npm run deploy
```

Workers Builds のダッシュボードでは、同じ処理を二重にしないため `npm run deploy` を Deploy command に設定しません。Build command が `npm run build` を実行済みなので、Deploy command は `npx wrangler deploy` だけにします。

## 初回公開前の準備

1. `wrangler.jsonc` の `database_id` を作成済み D1 の ID に置き換えます。
2. 設定済みの `database_name` と `bucket_name` に対応する D1/R2 リソースを確認します。
3. D1 migration をリモートに適用します。
4. Better Auth と Document AI の値を Workers の **Variables & Secrets** に secret として設定します。

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put BETTER_AUTH_URL
npx wrangler secret put DOCUMENT_AI_PROJECT_ID
npx wrangler secret put DOCUMENT_AI_LOCATION
npx wrangler secret put DOCUMENT_AI_PROCESSOR_ID
npx wrangler secret put DOCUMENT_AI_PROCESSOR_VERSION
npx wrangler secret put DOCUMENT_AI_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put DOCUMENT_AI_SERVICE_ACCOUNT_PRIVATE_KEY
```

本番環境のリソース作成、ID の書き込み、migration の適用、secret の設定、公開は別途 Cloudflare アカウントで行う操作です。このリポジトリからは実行しません。
