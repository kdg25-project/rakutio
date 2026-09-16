import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { FormEvent, useState } from 'react'

import { authClient } from '../lib/auth-client'

export const Route = createFileRoute('/signup')({ component: SignUp })

function SignUp() {
  const navigate = useNavigate()
  const [error, setError] = useState<string>()
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(undefined)
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password'))
    const passwordConfirmation = String(form.get('passwordConfirmation'))
    if (password.length < 8) {
      setError('パスワードは8文字以上にしてください。')
      return
    }
    if (password !== passwordConfirmation) {
      setError('パスワードが一致しません。')
      return
    }
    setIsSubmitting(true)
    const { error: signUpError } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password,
    })
    setIsSubmitting(false)
    if (signUpError) {
      setError(signUpError.message || '新規登録できませんでした。')
      return
    }
    await navigate({ to: '/app' })
  }

  return (
    <section className="card auth-card auth-screen">
      <p className="app-wordmark">家計簿</p>
      <h1>新規アカウント登録</h1>
      <form onSubmit={onSubmit} className="form">
        <label>名前<input name="name" autoComplete="name" required /></label>
        <label>メールアドレス<input name="email" type="email" autoComplete="email" required /></label>
        <label>パスワード<input name="password" type="password" minLength={8} autoComplete="new-password" required /></label>
        <label>パスワード（確認）<input name="passwordConfirmation" type="password" minLength={8} autoComplete="new-password" required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="button" disabled={isSubmitting}>{isSubmitting ? '登録中…' : '登録する'}</button>
      </form>
      <p className="auth-switch">すでにアカウントがある場合は <Link to="/login">ログイン</Link></p>
    </section>
  )
}
