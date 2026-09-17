import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'

import { privateSessionHeaders } from '../lib/auth-navigation'
import { getCurrentSession } from '../lib/session'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  beforeLoad: async () => ({
    session: await getCurrentSession(),
  }),
  headers: () => privateSessionHeaders,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Rakutio' },
      { name: 'description', content: 'Rakutio 家計簿' },
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
        <div className="page"><Outlet /></div>
        <Scripts />
      </body>
    </html>
  )
}
