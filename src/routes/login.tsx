import { Link, createFileRoute, redirect, useNavigate, useRouter } from '@tanstack/react-router'
import { FormEvent, useState } from 'react'

import { authClient } from '../lib/auth-client'
import { invalidateSessionAndReplace, isAuthenticated } from '../lib/auth-navigation'
import { BrandLogo } from '../components/brand-logo'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => {
    if (isAuthenticated(context.session)) {
      throw redirect({ to: '/app' })
    }
  },
  component: Login,
})

function Login() {
  const navigate = useNavigate()
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [showPassword, setShowPassword] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(undefined)
    setIsSubmitting(true)
    const form = new FormData(event.currentTarget)
    const { error: signInError } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
      rememberMe,
    })
    setIsSubmitting(false)
    if (signInError) {
      setError(signInError.message || 'ログインできませんでした。')
      return
    }
    await invalidateSessionAndReplace(router, navigate, '/app')
  }

  return (
    <section className="card auth-card auth-screen">
      <BrandLogo className="auth-wordmark" />
      <p className="auth-welcome">ようこそ</p>
      <h1 className="auth-title">ログイン</h1>
      <form onSubmit={onSubmit} className="form">
        <label className="auth-field"><img src="/icons/mail.svg" alt="" /><input name="email" type="email" autoComplete="email" placeholder="メールアドレス" aria-label="メールアドレス" required /></label>
        <label className="auth-field auth-password-field"><img src="/icons/lock.svg" alt="" /><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="パスワード" aria-label="パスワード" required /><button type="button" className="password-visibility" aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'} onClick={() => setShowPassword((value) => !value)}><img src="/icons/eye.svg" alt="" /></button></label>
        <div className="auth-options"><label className="remember-field"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />ログインしたままにする</label></div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="button" disabled={isSubmitting}>{isSubmitting ? 'ログイン中…' : 'ログイン'}</button>
      </form>
      <p className="auth-switch">新規登録はこちら <Link to="/signup">新規登録</Link></p>
    </section>
  )
}
