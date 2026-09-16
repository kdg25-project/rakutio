/** Reject cross-site writes before cookie-authenticated application handlers run. */
export function enforceSameOrigin(request: Request, configuredBaseUrl: string) {
  const origin = request.headers.get('origin')
  let expected: string
  try { expected = new URL(configuredBaseUrl || request.url).origin }
  catch { expected = new URL(request.url).origin }
  if (!origin || origin !== expected) {
    return Response.json({ error: { code: 'CSRF_ORIGIN_DENIED', message: 'この操作は同一オリジンから実行してください。' } }, { status: 403 })
  }
  return null
}
