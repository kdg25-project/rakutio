import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <section className="welcome-screen">
      <div className="welcome-mark">家</div>
      <p className="eyebrow">あなたの毎日に、ゆとりを</p>
      <h1>家計簿</h1>
      <p>日々の支出と資産を、ひとつの場所で見やすく管理します。</p>
      <div className="actions">
        <Link to="/signup" className="button">新規登録</Link>
        <Link to="/login" className="button secondary">ログイン</Link>
      </div>
    </section>
  )
}
