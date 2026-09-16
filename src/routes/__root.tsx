import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: '家計簿' },
      { name: 'description', content: '家計簿の開発環境' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootDocument,
})

function RootDocument() {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        <header className="site-header">
          <Link to="/" className="brand">家計簿</Link>
          <nav aria-label="メインナビゲーション">
            <Link to="/login">ログイン</Link>
            <Link to="/signup" className="button small">新規登録</Link>
          </nav>
        </header>
        <main className="page"><Outlet /></main>
        <Scripts />
      </body>
    </html>
  )
}
