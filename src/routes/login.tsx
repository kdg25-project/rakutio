import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { FormEvent, useState } from 'react'

import { authClient } from '../lib/auth-client'

export const Route = createFileRoute('/login')({ component: Login })

function Login() {
  const navigate = useNavigate()
  const [error, setError] = useState<string>()
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(undefined)
    setIsSubmitting(true)
    const form = new FormData(event.currentTarget)
    const { error: signInError } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
      rememberMe: true,
    })
    setIsSubmitting(false)
    if (signInError) {
      setError(signInError.message || 'ログインできませんでした。')
      return
    }
    await navigate({ to: '/app' })
  }

  return (
    <section className="card auth-card">
      <h1>ログイン</h1>
      <form onSubmit={onSubmit} className="form">
        <label>メールアドレス<input name="email" type="email" autoComplete="email" required /></label>
        <label>パスワード<input name="password" type="password" autoComplete="current-password" required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="button" disabled={isSubmitting}>{isSubmitting ? 'ログイン中…' : 'ログイン'}</button>
      </form>
      <p>アカウントがない場合は <Link to="/signup">新規登録</Link></p>
    </section>
  )
}
