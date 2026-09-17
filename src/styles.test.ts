import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const loginRoute = readFileSync(new URL('./routes/login.tsx', import.meta.url), 'utf8')
const rootRoute = readFileSync(new URL('./routes/__root.tsx', import.meta.url), 'utf8')
const ledgerApp = readFileSync(new URL('./components/ledger-app.tsx', import.meta.url), 'utf8')
const chevron = readFileSync(new URL('../public/icons/chevron-right.svg', import.meta.url), 'utf8')
const backChevron = readFileSync(new URL('../public/icons/chevron-left.svg', import.meta.url), 'utf8')
const wallet = readFileSync(new URL('../public/icons/wallet.svg', import.meta.url), 'utf8')
const logo = readFileSync(new URL('../public/rakutio-logo.svg', import.meta.url), 'utf8')
const brandLogo = readFileSync(new URL('./components/brand-logo.tsx', import.meta.url), 'utf8')
const receiptCameraStyles = readFileSync(new URL('./components/receipt-camera.css', import.meta.url), 'utf8')

describe('mobile-frame layout', () => {
  it('uses the Rakutio wordmark consistently instead of the Figma placeholder', () => {
    expect(loginRoute).not.toContain('AppName')
    expect(rootRoute).toContain("{ title: 'Rakutio' }")
    expect(rootRoute).toContain("{ name: 'description', content: 'Rakutio 家計簿' }")
    expect(ledgerApp).toContain('<BrandLogo />')
    expect(loginRoute).toContain('<BrandLogo className="auth-wordmark" />')
    expect(brandLogo).toContain('<img src="/rakutio-logo.svg" alt="Rakutio" />')
    expect(logo).toContain('<svg width="213" height="70" viewBox="0 0 213 70"')
    expect(styles).toContain('.brand-logo img { display: block; height: auto; max-width: 100%; object-fit: contain; width: 100%; }')
    expect(styles).toContain('.auth-wordmark { display: block; height: auto; margin: 0 0 8px; max-width: 213px; width: 213px; }')
    expect(styles).toContain('.ledger-brand .brand-logo { display: block; height: 35px; width: 106.5px; }')
  })

  it('uses the Figma frame background for the document and outer app surface', () => {
    expect(styles).toContain(':root { color: #26342e; background: #f7f7f5;')
    expect(styles).toContain('html { background: #f7f7f5; scrollbar-gutter: stable; }')
    expect(styles).toContain('body { background: #f7f7f5; margin: 0; min-width: 320px; }')
  })
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
    expect(styles).toContain('html { background: #f7f7f5; scrollbar-gutter: stable; }')
  })

  it('uses a bottom sheet for capture and a single-scroller full screen for review', () => {
    expect(styles).toContain('.app-receipt-capture-sheet { height: min(84dvh, 734px);')
    expect(styles).toContain('.app-receipt-capture-sheet > .receipt-flow { background: #fff; border-radius: 20px 20px 0 0; box-sizing: border-box; height: 100%; max-height: none; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;')
    expect(styles).toContain('.app-receipt-screen { background: #fff; border: 0; box-shadow: none; height: min(100dvh, 874px);')
    expect(styles).toContain(".app-receipt-screen > .receipt-flow[data-phase='review'] { gap: 10px; grid-template-rows: auto minmax(0, 1fr) auto auto; }")
    expect(styles).toContain('.app-receipt-screen .receipt-preview { align-self: start; aspect-ratio: 4 / 5; background: #a87654; border-radius: 9px; max-height: min(54dvh, 470px); }')
    expect(styles).toContain('.app-receipt-screen .receipt-pages > div > button img, .app-receipt-screen .receipt-pages > div > .receipt-continue-capture { border-radius: 8px; height: 96px; width: 74px; }')
    expect(receiptCameraStyles).toContain('.receipt-camera-live__preview { aspect-ratio: .91 / 1; background: #9c684a;')
    expect(receiptCameraStyles).toContain('.receipt-camera-live__corner.top-left')
  })

  it('keeps the Home brand left-aligned and its actions on the right', () => {
    expect(styles).toContain('.ledger-brand { display: grid; gap: 2px; justify-items: start; }')
    expect(styles).toContain('.ledger-top-actions { display: flex; gap: 8px; margin-left: auto; }')
  })

  it('does not imitate a device status bar and keeps every Settings disclosure on one line', () => {
    expect(ledgerApp).not.toContain('home-statusbar')
    expect(styles).not.toContain('.home-statusbar')
    expect(styles).toContain('.ledger-topbar { background: #f7f7f5; display: grid; grid-template-columns: 1fr auto; padding: 12px 16px 11px; position: relative; }')
    expect(styles).toContain('.settings-list > .settings-group { display: grid; grid-template-columns: minmax(0, 1fr); }')
    expect(styles).toContain('.settings-list > .settings-profile-row > span:not(.settings-avatar), .settings-group > button > span { flex: 1 1 auto; min-width: 0; white-space: nowrap; }')
  })

  it('keeps profile values in Figma input controls and reserves placeholder copy for empty values', () => {
    expect(ledgerApp).toContain('placeholder="ユーザー名"')
    expect(ledgerApp).toContain('placeholder="メモを入力"')
    expect(ledgerApp).not.toContain('placeholder="めもめも"')
    expect(ledgerApp).toContain("profile.memo === 'めもめも' ? '' : profile.memo")
    expect(styles).toContain('.profile-field input, .profile-field > .profile-field-value, .profile-field textarea { background: #fff; border: 1px solid #e4e5e1; border-radius: 5px;')
    expect(styles).toContain('.profile-field textarea { height: 150px; min-height: 150px; overflow-y: auto; padding: 14px 16px; resize: none; }')
    expect(ledgerApp).toContain('/icons/chevron-right.svg')
    expect(ledgerApp).toContain("value: 'peach'")
    expect(styles).toContain('right: 16px; top: 50%; transform: translateY(-50%) rotate(90deg); width: 8px;')
    expect(styles).toContain('.profile-theme button.active::before { border: 1.5px solid #6e746f;')
    expect(styles).toContain(".profile-theme button.active::after { align-items: center; color: #fff; content: '✓'; display: grid; font-size: 20px; inset: 0;")
  })

  it('keeps manual deduction inputs visible against the entry surface', () => {
    expect(ledgerApp).toContain('className="form-grid deduction-fields"><label>レシート値引き')
    expect(ledgerApp).not.toContain('>ポイント利用<input')
    expect(ledgerApp).not.toContain('>商品券利用<input')
    expect(ledgerApp).not.toContain('>商品券口座<select')
    expect(styles).toContain('.deduction-fields input { background: #fff; border-color: #e4e5e1; }')
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

  it('keeps the login password visibility control in the field row', () => {
    expect(loginRoute).toContain('className="auth-field auth-password-field"')
    expect(styles).toContain('.auth-password-field { grid-template-columns: 21px minmax(0, 1fr) 21px; height: 48px; min-height: 48px; }')
    expect(styles).toContain('.auth-password-field .password-visibility { align-items: center; grid-column: 3; grid-row: 1; height: 42px; justify-content: center; width: 21px; }')
    expect(styles).toContain('.auth-password-field .password-visibility img { display: block; height: auto; width: 20px; }')
  })

  it('uses fixed SVG colors when the asset is rendered through an img element', () => {
    expect(chevron).toContain('stroke="#777773"')
    expect(backChevron).toContain('stroke="#789485"')
    expect(wallet).toContain('stroke="#789485"')
    expect(chevron).not.toContain('currentColor')
    expect(backChevron).not.toContain('currentColor')
  })

  it('lets the 402px mobile frame fill narrow phone viewports without a generic page gutter', () => {
    expect(styles).toContain('@media (max-width: 430px) {')
    expect(styles).toContain('.page:has(.ledger-shell), .page:has(.auth-screen) { padding: 0; }')
    expect(styles).toContain('.ledger-shell, .auth-screen { margin-left: auto; margin-right: auto; max-width: 402px; width: 100%; }')
    expect(styles).toContain('html, body { max-width: 100%; overflow-x: hidden; }')
    expect(styles).toContain('.bottom-nav, .entry-fixed-action, .category-fixed-actions, .detail-fixed-actions, .receipt-saved-actions { max-width: 402px; width: 100%; }')
  })
})
