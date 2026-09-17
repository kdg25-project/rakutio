import { describe, expect, it, vi } from 'vitest'

import { animationEnabled, baseBlobSeeds, blobAreaTargets, blobTreemap, categoryTheme, expenseBubbleViewBox, figmaReferenceBounds, orientationAcceleration, roundedPath, seedParticles, smoothBlobPolygon, stepSeedPhysics, subscribeDeviceOrientation } from './expense-bubbles'

const items = [
  { id: 'food', label: '食費', amount: 17_600, icon: 'category-food', color: '#000' }, { id: 'daily', label: '日用品', amount: 10_470, icon: 'category-daily', color: '#000' },
  { id: 'transit', label: '交通費', amount: 11_870, icon: 'category-transit', color: '#000' }, { id: 'utility', label: '光熱費', amount: 6_320, icon: 'category-utility', color: '#000' },
  { id: 'subscription', label: 'サブスク', amount: 7_560, icon: 'category-subscription', color: '#000' }, { id: 'other', label: 'その他', amount: 10_780, icon: 'category-other', color: '#000' },
]

function bounds(points: ReadonlyArray<{ x: number; y: number }>) {
  const xs = points.map((point) => point.x); const ys = points.map((point) => point.y)
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

describe('expense bubbles', () => {
  it('pins the baseline illustration to Figma Home section 165:2148', () => {
    const layout = blobTreemap(items, expenseBubbleViewBox.width, expenseBubbleViewBox.height)
    expect(layout).toHaveLength(6)
    layout.forEach((cell, index) => {
      const actual = bounds(cell.inner); const reference = figmaReferenceBounds[index]!
      expect(cell.bounds.x).toBeCloseTo(reference.x, 5); expect(cell.bounds.y).toBeCloseTo(reference.y, 5)
      expect(cell.bounds.width).toBeCloseTo(reference.width, 5); expect(cell.bounds.height).toBeCloseTo(reference.height, 5)
      expect(actual.x).toBeCloseTo(reference.x, 5); expect(actual.y).toBeCloseTo(reference.y, 5)
      expect(actual.width).toBeCloseTo(reference.width, 5); expect(actual.height).toBeCloseTo(reference.height, 5)
      expect(cell.path).toContain(' C ')
    })
  })

  it('keeps the authored rhythm while values dynamically change size and area', () => {
    const baseline = blobTreemap(items, 370, expenseBubbleViewBox.height)
    const changed = blobTreemap(items.map((item) => ({ ...item, amount: item.id === 'other' ? 60_000 : item.id === 'food' ? 0 : item.amount })), 370, expenseBubbleViewBox.height)
    const food = changed.find((cell) => cell.id === 'food')!; const other = changed.find((cell) => cell.id === 'other')!
    expect(other.area).toBeGreaterThan(baseline.find((cell) => cell.id === 'other')!.area)
    expect(food.area).toBeLessThan(baseline.find((cell) => cell.id === 'food')!.area)
    expect(changed.map((cell) => cell.bounds.x)).toEqual(expect.arrayContaining([expect.any(Number)]))
    changed.forEach((cell) => {
      expect(cell.bounds.width).toBeGreaterThan(50)
      expect(cell.bounds.height).toBeGreaterThan(60)
      expect(cell.bounds.x).toBeGreaterThanOrEqual(0)
      expect(cell.bounds.y).toBeGreaterThanOrEqual(0)
      expect(cell.bounds.x + cell.bounds.width).toBeLessThanOrEqual(370)
      expect(cell.bounds.y + cell.bounds.height).toBeLessThanOrEqual(expenseBubbleViewBox.height)
    })
  })

  it('keeps zero-yen and one-category extremes readable without slivers', () => {
    const total = 370 * expenseBubbleViewBox.height
    const zeroes = items.map((item) => ({ ...item, amount: 0 }))
    expect(blobAreaTargets(zeroes, 370, expenseBubbleViewBox.height)).toEqual(Array(6).fill(total / 6))
    const one = items.map((item) => ({ ...item, amount: item.id === 'other' ? 1_234 : 0 }))
    const layout = blobTreemap(one, 370, expenseBubbleViewBox.height)
    layout.forEach((cell) => {
      expect(cell.area).toBeGreaterThan(4_400)
      expect(cell.bounds.width).toBeGreaterThan(50)
      expect(cell.bounds.height).toBeGreaterThan(60)
    })
  })

  it('moves shapes with bounded seed physics and returns them to their base', () => {
    const particles = seedParticles(370, expenseBubbleViewBox.height); const particle = particles[0]!; const start = particle.x
    particle.vx = 8; stepSeedPhysics(particles, 370, expenseBubbleViewBox.height)
    expect(particle.x).toBeGreaterThan(start); expect(particle.vx).toBeLessThan(8)
    const shifted = baseBlobSeeds(370, expenseBubbleViewBox.height).map((seed) => ({ x: seed.x + 48, y: seed.y - 32 }))
    const layout = blobTreemap(items, 370, expenseBubbleViewBox.height, shifted)
    layout.forEach((cell, index) => {
      expect(Math.abs(cell.bounds.x - figmaReferenceBounds[index]!.x)).toBeLessThanOrEqual(12.1)
      expect(Math.abs(cell.bounds.y - figmaReferenceBounds[index]!.y)).toBeLessThanOrEqual(10.1)
    })
  })

  it('has deterministic curved paths, honors reduced motion, and cleans up orientation', () => {
    expect(blobTreemap(items, 370, expenseBubbleViewBox.height).map((cell) => cell.path)).toEqual(blobTreemap(items, 370, expenseBubbleViewBox.height).map((cell) => cell.path))
    expect(roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }])).toContain(' C ')
    const smooth = smoothBlobPolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }])
    expect(smooth).toHaveLength(16)
    expect(animationEnabled(true)).toBe(false); expect(animationEnabled(false)).toBe(true)
    const added = vi.fn(); const removed = vi.fn()
    const stop = subscribeDeviceOrientation({ addEventListener: added, removeEventListener: removed } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>, () => undefined)
    stop()
    expect(added).toHaveBeenCalledWith('deviceorientation', expect.any(Function))
    expect(removed).toHaveBeenCalledWith('deviceorientation', expect.any(Function))
  })

  it('uses Figma foreground colours and a safe orientation fallback', () => {
    expect(categoryTheme(items[0]!)).toEqual({ background: '#708779', foreground: '#ffffff' })
    expect(categoryTheme(items[2]!)).toEqual({ background: '#c4cfdb', foreground: '#34465a' })
    expect(categoryTheme(items[3]!)).toEqual({ background: '#d0cbd9', foreground: '#4d4862' })
    expect(categoryTheme(items[4]!)).toEqual({ background: '#e5cbcd', foreground: '#70474b' })
    expect(categoryTheme(items[5]!)).toEqual({ background: '#d1d1cf', foreground: '#171717' })
    expect(orientationAcceleration(null, undefined)).toEqual({ x: 0, y: 0 })
  })
})
