import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <section className="hero">
      <p className="eyebrow">2026 PHP 審査会</p>
      <h1>家計簿</h1>
      <p>メールアドレスでアカウントを作成し、レシート画像の OCR を試せる開発環境です。</p>
      <div className="actions">
        <Link to="/signup" className="button">新規登録</Link>
        <Link to="/login" className="button secondary">ログイン</Link>
      </div>
    </section>
  )
}
