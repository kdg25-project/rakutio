import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const loginRoute = readFileSync(new URL('./routes/login.tsx', import.meta.url), 'utf8')
const ledgerApp = readFileSync(new URL('./components/ledger-app.tsx', import.meta.url), 'utf8')
const chevron = readFileSync(new URL('../public/icons/chevron-right.svg', import.meta.url), 'utf8')
const backChevron = readFileSync(new URL('../public/icons/chevron-left.svg', import.meta.url), 'utf8')
const wallet = readFileSync(new URL('../public/icons/wallet.svg', import.meta.url), 'utf8')

describe('mobile-frame layout', () => {
  it('centres category bubbles and every viewport-fixed app action within the 402px frame', () => {
    expect(ledgerApp).toContain("import { ExpenseBubbles } from './expense-bubbles'")
    expect(ledgerApp).toContain('<ExpenseBubbles items={expenseCategories.map')
    expect(styles).not.toContain('.category-bubbles { display: block;')

    for (const selector of ['category-fixed-actions', 'detail-fixed-actions', 'receipt-saved-actions', 'entry-fixed-action', 'bottom-nav']) {
      const rule = new RegExp(`\\.${selector} \\{[^}]*left: 50%;[^}]*transform: translateX\\(-50%\\);[^}]*width: min\\(100vw, 402px\\);`)
      expect(styles).toMatch(rule)
    }

    const entryActionRule = styles.match(/\.entry-fixed-action \{[^}]*\}/)?.[0] ?? ''
    expect(entryActionRule).not.toMatch(/position: sticky|left: 18px|width: calc\(100% - 36px\)/)
    expect(entryActionRule).toContain('border-width: 10px 18px calc(10px + env(safe-area-inset-bottom))')
  })

  it('uses the Figma fixed receipt result actions and chevrons inside the mobile frame', () => {
    expect(styles).toContain('.receipt-saved-actions .button.secondary { background: #ececea; border: 0; color: #637169; }')
    expect(styles).toContain('.receipt-saved-actions .primary-action { background: #799487; }')
    expect(styles).toContain('.row-chevron { color: #9da39f;')
  })

  it('keeps the Home brand left-aligned and its actions on the right', () => {
    expect(styles).toContain('.ledger-brand { display: grid; gap: 2px; justify-items: start; }')
    expect(styles).toContain('.ledger-top-actions { display: flex; gap: 8px; margin-left: auto; }')
  })

  it('does not imitate a device status bar and keeps every Settings disclosure on one line', () => {
    expect(ledgerApp).not.toContain('home-statusbar')
    expect(styles).not.toContain('.home-statusbar')
    expect(styles).toContain('.ledger-topbar { background: #f7f7f5; display: grid; grid-template-columns: 1fr auto; padding: 20px 16px 11px; position: relative; }')
    expect(styles).toContain('.settings-list > .settings-group { display: grid; grid-template-columns: minmax(0, 1fr); }')
    expect(styles).toContain('.settings-list > .settings-profile-row > span:not(.settings-avatar), .settings-group > button > span { flex: 1 1 auto; min-width: 0; white-space: nowrap; }')
  })

  it('keeps profile values in Figma input controls and reserves placeholder copy for empty values', () => {
    expect(ledgerApp).toContain('placeholder="ユーザー名"')
    expect(ledgerApp).toContain('placeholder="メモを入力"')
    expect(ledgerApp).not.toContain('placeholder="めもめも"')
    expect(styles).toContain('.profile-field input, .profile-field > .profile-field-value, .profile-field textarea { background: #fff; border: 1px solid #e4e5e1; border-radius: 5px;')
    expect(styles).toContain('.profile-field textarea { height: 150px; min-height: 150px; overflow-y: auto; padding: 14px 16px; resize: none; }')
    expect(ledgerApp).toContain('/icons/chevron-right.svg')
    expect(ledgerApp).toContain("value: 'peach'")
    expect(styles).toContain('right: 16px; top: 50%; transform: translateY(-50%) rotate(90deg); width: 8px;')
    expect(styles).toContain('.profile-theme button.active::before { border: 1.5px solid #6e746f;')
    expect(styles).toContain(".profile-theme button.active::after { align-items: center; color: #fff; content: '✓'; display: grid; font-size: 20px; inset: 0;")
  })

  it('centres the Account theme check and currency disclosure inside their own controls', () => {
    expect(styles).toContain('.profile-theme button { align-items: center; background: var(--profile-theme-color); border: 3px solid transparent; border-radius: 50%; display: grid; height: 32px; justify-content: center; line-height: 1; padding: 0; place-items: center; position: relative; width: 32px; }')
    const activeThemeCheck = styles.match(/\.profile-theme button\.active::after \{[^}]*\}/)?.[0] ?? ''
    expect(activeThemeCheck).toBe(".profile-theme button.active::after { align-items: center; color: #fff; content: '✓'; display: grid; font-size: 20px; inset: 0; justify-content: center; line-height: 1; place-items: center; pointer-events: none; position: absolute; }")
    expect(activeThemeCheck).not.toMatch(/(?:left|top):/)
    expect(styles).toContain('.profile-field > .profile-field-value img { height: 14px; pointer-events: none; position: absolute; right: 16px; top: 50%; transform: translateY(-50%) rotate(90deg); width: 8px; }')
  })

  it('keeps the Figma Account geometry in one profile rule set', () => {
    expect(styles).not.toContain('.profile-edit { display: grid; gap: 10px; }')
    expect(styles).not.toContain('.profile-field { background: #fff; border-bottom: 1px solid #e8e8e4;')
    expect(styles).not.toContain('.profile-theme button.active { box-shadow: 0 0 0 1px var(--profile-theme-color);')
    expect(styles).toContain('.profile-avatar { align-items: center; background: #eceeea; border: 0; border-radius: 50%; cursor: pointer; display: flex; height: 72px;')
    expect(styles).toContain(".profile-theme button[data-theme='gray'] { --profile-theme-color: #ba9848; }")
  })

  it('does not add an unavailable password-reset message or unsupported information screens', () => {
    expect(loginRoute).not.toContain('パスワード再設定は現在利用できません')
    expect(ledgerApp).not.toContain('function InformationScreen')
    expect(ledgerApp).not.toContain("'app-settings'")
  })

  it('uses fixed SVG colors when the asset is rendered through an img element', () => {
    expect(chevron).toContain('stroke="#777773"')
    expect(backChevron).toContain('stroke="#789485"')
    expect(wallet).toContain('stroke="#789485"')
    expect(chevron).not.toContain('currentColor')
    expect(backChevron).not.toContain('currentColor')
  })
})
