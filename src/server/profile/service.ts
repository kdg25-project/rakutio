export const PROFILE_THEMES = ['sage', 'rose', 'beige', 'lavender', 'blue', 'gray', 'peach'] as const
export type ProfileTheme = (typeof PROFILE_THEMES)[number]

export type UserProfile = {
  name: string
  theme: ProfileTheme
  memo: string
  image: string | null
}

export type UpdateProfileInput = {
  name?: unknown
  theme?: unknown
  memo?: unknown
  image?: unknown
}

type ProfileRow = Record<string, unknown>
type SqlValue = string | number | null

const MAX_NAME_LENGTH = 100
const MAX_MEMO_LENGTH = 500
export const MAX_PROFILE_IMAGE_BYTES = 256 * 1024
const MAX_IMAGE_DATA_URL_LENGTH = 'data:image/webp;base64,'.length + Math.ceil(MAX_PROFILE_IMAGE_BYTES / 3) * 4
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/

export class ProfileError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

function statement(db: D1Database, query: string, values: SqlValue[] = []) { return db.prepare(query).bind(...values) }
function has(input: UpdateProfileInput, key: keyof UpdateProfileInput) { return Object.prototype.hasOwnProperty.call(input, key) }
function rowText(row: ProfileRow, key: string) { return row[key] == null ? '' : String(row[key]) }

function requiredText(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string') throw new ProfileError('INVALID_INPUT', `${field} を文字列で指定してください。`)
  const result = value.trim()
  if (!result || result.length > maximum) throw new ProfileError('INVALID_INPUT', `${field} は 1 文字以上 ${maximum} 文字以下にしてください。`)
  return result
}

function optionalText(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string') throw new ProfileError('INVALID_INPUT', `${field} を文字列で指定してください。`)
  const result = value.trim()
  if (result.length > maximum) throw new ProfileError('INVALID_INPUT', `${field} は ${maximum} 文字以下にしてください。`)
  return result
}

function theme(value: unknown): ProfileTheme {
  if (typeof value !== 'string' || !PROFILE_THEMES.includes(value as ProfileTheme)) throw new ProfileError('INVALID_THEME', 'アプリのテーマが不正です。')
  return value as ProfileTheme
}

function image(value: unknown) {
  if (value === null) return null
  if (typeof value !== 'string' || !value || value.length > MAX_IMAGE_DATA_URL_LENGTH) throw new ProfileError('INVALID_IMAGE', 'プロフィール画像は 256KB 以下の PNG、JPEG、WebP、GIF を指定してください。')
  const match = DATA_URL.exec(value)
  if (!match || match[2].length % 4 !== 0) throw new ProfileError('INVALID_IMAGE', 'プロフィール画像は 256KB 以下の PNG、JPEG、WebP、GIF を指定してください。')
  const encoded = match[2]
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const byteLength = encoded.length / 4 * 3 - padding
  if (!encoded || byteLength > MAX_PROFILE_IMAGE_BYTES) throw new ProfileError('INVALID_IMAGE', 'プロフィール画像は 256KB 以下の PNG、JPEG、WebP、GIF を指定してください。')
  return value
}

function profileFrom(row: ProfileRow): UserProfile {
  const savedTheme = rowText(row, 'theme')
  return {
    name: rowText(row, 'name'),
    theme: PROFILE_THEMES.includes(savedTheme as ProfileTheme) ? savedTheme as ProfileTheme : 'sage',
    memo: rowText(row, 'memo'),
    image: row.image == null ? null : String(row.image),
  }
}

export class ProfileService {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async get(): Promise<UserProfile> {
    const profile = await statement(this.db, 'SELECT name, theme, memo, image FROM user WHERE id = ?', [this.userId]).first<ProfileRow>()
    if (!profile) throw new ProfileError('PROFILE_NOT_FOUND', 'プロフィールが見つかりません。', 404)
    return profileFrom(profile)
  }

  async update(input: UpdateProfileInput): Promise<UserProfile> {
    const keys = (['name', 'theme', 'memo', 'image'] as const).filter((key) => has(input, key))
    if (!keys.length) throw new ProfileError('INVALID_INPUT', '更新するプロフィール項目を指定してください。')

    const assignments: string[] = []
    const values: SqlValue[] = []
    if (has(input, 'name')) { assignments.push('name = ?'); values.push(requiredText(input.name, '名前', MAX_NAME_LENGTH)) }
    if (has(input, 'theme')) { assignments.push('theme = ?'); values.push(theme(input.theme)) }
    if (has(input, 'memo')) { assignments.push('memo = ?'); values.push(optionalText(input.memo, 'メモ', MAX_MEMO_LENGTH)) }
    if (has(input, 'image')) { assignments.push('image = ?'); values.push(image(input.image)) }
    assignments.push('updatedAt = ?'); values.push(Date.now(), this.userId)

    const result = await statement(this.db, `UPDATE user SET ${assignments.join(', ')} WHERE id = ?`, values).run()
    if (!result.meta.changes) throw new ProfileError('PROFILE_NOT_FOUND', 'プロフィールが見つかりません。', 404)
    return this.get()
  }
}
