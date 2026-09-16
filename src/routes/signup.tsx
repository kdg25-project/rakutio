import { Link, createFileRoute, redirect, useNavigate, useRouter } from '@tanstack/react-router'
import { FormEvent, useState } from 'react'

import { authClient } from '../lib/auth-client'
import { invalidateSessionAndReplace, isAuthenticated } from '../lib/auth-navigation'

export const Route = createFileRoute('/signup')({
  beforeLoad: ({ context }) => {
    if (isAuthenticated(context.session)) {
      throw redirect({ to: '/app' })
    }
  },
  component: SignUp,
})

function SignUp() {
  const navigate = useNavigate()
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [acceptedTerms, setAcceptedTerms] = useState(false)

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
    if (!acceptedTerms) {
      setError('利用規約とプライバシーポリシーへの同意が必要です。')
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
    await invalidateSessionAndReplace(router, navigate, '/app')
  }

  return (
    <section className="card auth-card auth-screen">
      <h1 className="auth-title signup-title">新規アカウント登録</h1>
      <form onSubmit={onSubmit} className="form">
        <label className="auth-field"><img src="/icons/user.svg" alt="" /><input name="name" autoComplete="name" placeholder="ユーザー名" aria-label="ユーザー名" required /></label><small className="auth-helper">アプリ内で表示される名前です</small>
        <label className="auth-field"><img src="/icons/mail.svg" alt="" /><input name="email" type="email" autoComplete="email" placeholder="メールアドレス" aria-label="メールアドレス" required /></label>
        <label className="auth-field"><img src="/icons/lock.svg" alt="" /><input name="password" type="password" minLength={8} autoComplete="new-password" placeholder="パスワード" aria-label="パスワード" required /></label><small className="auth-helper">半角英数字8文字以上で入力してください</small>
        <label className="auth-field"><img src="/icons/lock.svg" alt="" /><input name="passwordConfirmation" type="password" minLength={8} autoComplete="new-password" placeholder="パスワード（確認用）" aria-label="パスワード（確認）" required /></label>
        <label className="terms-field"><input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} />利用規約とプライバシーポリシーに同意する</label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="button signup-submit" disabled={isSubmitting}>{isSubmitting ? '登録中…' : '登録する'}</button>
      </form>
      <p className="auth-switch">すでにアカウントをお持ちの方は <Link to="/login">ログイン</Link></p>
    </section>
  )
}
