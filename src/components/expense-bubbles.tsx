import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'

import './expense-bubbles.css'

export type ExpenseBubble = { id: string; label: string; amount: number; icon: string; color: string }
export type Point = { x: number; y: number }
export type Polygon = Point[]
export type BlobTheme = { background: string; foreground: string }
export type BlobCell = { id: string; polygon: Polygon; inner: Polygon; centroid: Point; area: number; path: string; theme: BlobTheme }
export type SeedParticle = Point & { baseX: number; baseY: number; vx: number; vy: number; dragging?: boolean }

const viewBox = { width: 370, height: 228 }
const gapScale = 0.965
/** The positions from the populated Figma home frame: two broad upper cells,
 * three lower cells and a narrower cell at the right. */
const populatedReferenceSeeds: Point[] = [
  { x: 0.34, y: 0.28 }, { x: 0.70, y: 0.27 }, { x: 0.15, y: 0.70 },
  { x: 0.47, y: 0.70 }, { x: 0.72, y: 0.75 }, { x: 0.91, y: 0.48 },
]
/** When one category has transactions, Figma keeps the zero-yen categories
 * on the left and gives the populated category a calm, readable right cell. */
const singleValueReferenceSeeds: Point[] = [
  { x: 0.10, y: 0.22 }, { x: 0.29, y: 0.22 }, { x: 0.085, y: 0.72 },
  { x: 0.275, y: 0.72 }, { x: 0.465, y: 0.72 }, { x: 0.765, y: 0.52 },
]
/**
 * The home frame needs a composed, readable fallback while there is only one
 * amount. A weighted Voronoi partition can legally collapse a zero-yen cell
 * to a sliver, which is mathematically correct but visibly wrong here. These
 * authored contours keep the same soft, liquid Figma rhythm without sharp
 * contacts or clipped labels. The populated category receives the large cell.
 */
const singleValueReferencePolygons: Polygon[] = [
  [{ x: 3, y: 25 }, { x: 15, y: 7 }, { x: 49, y: 2 }, { x: 69, y: 16 }, { x: 75, y: 42 }, { x: 69, y: 78 }, { x: 52, y: 105 }, { x: 20, y: 102 }, { x: 5, y: 80 }, { x: 1, y: 50 }],
  [{ x: 83, y: 8 }, { x: 126, y: 3 }, { x: 151, y: 13 }, { x: 158, y: 37 }, { x: 154, y: 71 }, { x: 140, y: 100 }, { x: 111, y: 108 }, { x: 88, y: 97 }, { x: 76, y: 72 }, { x: 78, y: 40 }],
  [{ x: 3, y: 130 }, { x: 15, y: 110 }, { x: 43, y: 104 }, { x: 65, y: 116 }, { x: 74, y: 148 }, { x: 72, y: 188 }, { x: 56, y: 218 }, { x: 30, y: 226 }, { x: 10, y: 211 }, { x: 1, y: 181 }],
  [{ x: 78, y: 135 }, { x: 88, y: 113 }, { x: 119, y: 105 }, { x: 143, y: 119 }, { x: 151, y: 150 }, { x: 149, y: 188 }, { x: 133, y: 217 }, { x: 104, y: 225 }, { x: 84, y: 206 }, { x: 76, y: 176 }],
  [{ x: 155, y: 143 }, { x: 167, y: 121 }, { x: 189, y: 111 }, { x: 208, y: 124 }, { x: 218, y: 153 }, { x: 219, y: 187 }, { x: 207, y: 218 }, { x: 181, y: 225 }, { x: 159, y: 211 }, { x: 149, y: 179 }],
  [{ x: 242, y: 14 }, { x: 279, y: 5 }, { x: 319, y: 4 }, { x: 350, y: 23 }, { x: 367, y: 59 }, { x: 369, y: 108 }, { x: 358, y: 157 }, { x: 336, y: 199 }, { x: 302, y: 226 }, { x: 265, y: 218 }, { x: 238, y: 197 }, { x: 225, y: 159 }, { x: 224, y: 116 }, { x: 230, y: 64 }],
]
const populatedReferenceAreas = [0.235, 0.18, 0.175, 0.145, 0.14, 0.125]
const fallbackTilt = { x: 0, y: 0 }
const figmaThemes: Record<string, BlobTheme> = {
  food: { background: '#708779', foreground: '#ffffff' }, daily: { background: '#cfb170', foreground: '#ffffff' },
  transit: { background: '#c4cfdb', foreground: '#34465a' }, utility: { background: '#d0cbd9', foreground: '#4d4862' },
  subscription: { background: '#e5cbcd', foreground: '#70474b' }, other: { background: '#d1d1cf', foreground: '#171717' },
}

export function yen(value: number) { return `¥ ${new Intl.NumberFormat('ja-JP').format(value)}` }
export function categoryTheme(item: Pick<ExpenseBubble, 'label' | 'icon' | 'color'>): BlobTheme {
  const value = `${item.label} ${item.icon}`
  if (/食費|food/.test(value)) return figmaThemes.food
  if (/日用品|daily/.test(value)) return figmaThemes.daily
  if (/交通費|transit|train/.test(value)) return figmaThemes.transit
  if (/光熱費|utility|zap/.test(value)) return figmaThemes.utility
  if (/サブスク|subscription|repeat/.test(value)) return figmaThemes.subscription
  if (/その他|other|more-horizontal/.test(value)) return figmaThemes.other
  return { background: item.color, foreground: '#ffffff' }
}

export function blobAreaTargets(items: ReadonlyArray<Pick<ExpenseBubble, 'amount'>>, width: number, height: number) {
  const totalArea = width * height
  const count = Math.max(items.length, 1)
  const values = items.map((item) => Math.max(0, item.amount))
  const total = values.reduce((sum, amount) => sum + amount, 0)
  const populatedCount = values.filter((amount) => amount > 0).length
  if (total === 0) return items.map(() => totalArea / count)

  // A single receipt must not turn the remaining five categories into thin
  // ribbons. The two-row Figma composition needs at least 11% per zero-yen
  // cell to keep its icon, label and amount inside the painted blob. The one
  // populated cell can still grow, but never past the remaining 45%.
  if (populatedCount === 1) {
    const minimum = totalArea * Math.min(0.11, 0.66 / count)
    const remaining = Math.max(0, totalArea - minimum * count)
    return values.map((amount) => minimum + (amount > 0 ? remaining : 0))
  }

  // In the populated reference frame, geometry has a stable editorial order;
  // amounts nudge it rather than rearranging the entire composition.
  return values.map((amount, index) => {
    const reference = populatedReferenceAreas[index] ?? 1 / count
    const share = amount / total
    return totalArea * (reference * 0.8 + share * 0.2)
  })
}
export function baseBlobSeeds(width: number, height: number) { return populatedReferenceSeeds.map((seed) => ({ x: seed.x * width, y: seed.y * height })) }
function singleValueSeeds(items: ReadonlyArray<Pick<ExpenseBubble, 'amount'>>, width: number, height: number) {
  const valueIndex = items.findIndex((item) => item.amount > 0)
  if (valueIndex < 0 || valueIndex === 5) return singleValueReferenceSeeds.map((seed) => ({ x: seed.x * width, y: seed.y * height }))
  // Preserve the same layout for a populated category other than "その他" by
  // moving that category into the spacious right-hand anchor.
  const seeds = singleValueReferenceSeeds.map((seed) => ({ x: seed.x * width, y: seed.y * height }))
  const other = seeds[5]!
  seeds[5] = seeds[valueIndex]!
  seeds[valueIndex] = other
  return seeds
}
function layoutSeeds(items: ReadonlyArray<Pick<ExpenseBubble, 'amount'>>, width: number, height: number) {
  return items.filter((item) => item.amount > 0).length === 1 ? singleValueSeeds(items, width, height) : baseBlobSeeds(width, height)
}

function scaleReferencePolygon(polygon: Polygon, width: number, height: number) {
  return polygon.map((point) => ({ x: point.x * width / viewBox.width, y: point.y * height / viewBox.height }))
}
function singleValueBlobTreemap(items: ReadonlyArray<ExpenseBubble>, width: number, height: number): BlobCell[] {
  const populatedIndex = items.findIndex((item) => item.amount > 0)
  const slots = singleValueReferencePolygons.map((polygon) => scaleReferencePolygon(polygon, width, height))
  if (populatedIndex >= 0 && populatedIndex !== 5) [slots[populatedIndex], slots[5]] = [slots[5]!, slots[populatedIndex]!]
  return items.map((item, index) => {
    const polygon = slots[index]!
    const centroid = polygonCentroid(polygon)
    const inner = smoothBlobPolygon(insetPolygon(polygon, centroid))
    return { id: item.id, polygon, inner, centroid: polygonCentroid(inner), area: polygonArea(polygon), path: roundedPath(inner), theme: categoryTheme(item) }
  })
}

function polygonArea(polygon: Polygon) { return Math.abs(polygon.reduce((sum, point, index) => { const next = polygon[(index + 1) % polygon.length]!; return sum + point.x * next.y - next.x * point.y }, 0) / 2) }
function polygonCentroid(polygon: Polygon) {
  const signed = polygon.reduce((sum, point, index) => { const next = polygon[(index + 1) % polygon.length]!; return sum + point.x * next.y - next.x * point.y }, 0)
  if (Math.abs(signed) < 0.001) return polygon[0] ?? { x: 0, y: 0 }
  const factor = 1 / (3 * signed)
  return polygon.reduce((centroid, point, index) => { const next = polygon[(index + 1) % polygon.length]!; const cross = point.x * next.y - next.x * point.y; return { x: centroid.x + (point.x + next.x) * cross * factor, y: centroid.y + (point.y + next.y) * cross * factor } }, { x: 0, y: 0 })
}
function clipHalfPlane(polygon: Polygon, normal: Point, constant: number): Polygon {
  const result: Polygon = []
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]!; const end = polygon[(index + 1) % polygon.length]!
    const startValue = normal.x * start.x + normal.y * start.y - constant; const endValue = normal.x * end.x + normal.y * end.y - constant
    const startInside = startValue <= 0.0001; const endInside = endValue <= 0.0001
    if (startInside) result.push(start)
    if (startInside !== endInside) { const ratio = startValue / (startValue - endValue); result.push({ x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio }) }
  }
  return result
}
function powerCell(index: number, seeds: Point[], weights: number[], width: number, height: number) {
  let polygon: Polygon = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]
  const seed = seeds[index]!
  for (let other = 0; other < seeds.length && polygon.length; other += 1) {
    if (other === index) continue
    const next = seeds[other]!; const normal = { x: 2 * (next.x - seed.x), y: 2 * (next.y - seed.y) }
    const constant = next.x ** 2 + next.y ** 2 - seed.x ** 2 - seed.y ** 2 + weights[index]! - weights[other]!
    polygon = clipHalfPlane(polygon, normal, constant)
  }
  return polygon
}
function insetPolygon(polygon: Polygon, centroid: Point) { return polygon.map((point) => ({ x: centroid.x + (point.x - centroid.x) * gapScale, y: centroid.y + (point.y - centroid.y) * gapScale })) }
export function chaikinSmooth(polygon: Polygon, passes = 2) {
  let points = polygon
  for (let pass = 0; pass < passes; pass += 1) {
    const next: Polygon = []
    for (let index = 0; index < points.length; index += 1) {
      const left = points[index]!; const right = points[(index + 1) % points.length]!
      next.push({ x: left.x * 0.75 + right.x * 0.25, y: left.y * 0.75 + right.y * 0.25 })
      next.push({ x: left.x * 0.25 + right.x * 0.75, y: left.y * 0.25 + right.y * 0.75 })
    }
    points = next
  }
  return points
}
function scalePolygon(polygon: Polygon, centroid: Point, scale: number) { return polygon.map((point) => ({ x: centroid.x + (point.x - centroid.x) * scale, y: centroid.y + (point.y - centroid.y) * scale })) }
/** Turns a power-cell into an all-curved, liquid contour without straight edges. */
export function smoothBlobPolygon(polygon: Polygon) {
  const targetArea = polygonArea(polygon)
  const smooth = chaikinSmooth(polygon, 2)
  const centroid = polygonCentroid(smooth)
  return scalePolygon(smooth, centroid, Math.sqrt(targetArea / Math.max(1, polygonArea(smooth))))
}
export function roundedPath(polygon: Polygon) {
  if (!polygon.length) return ''
  if (polygon.length < 3) return `M ${polygon[0]!.x} ${polygon[0]!.y}`
  let path = `M ${polygon[0]!.x.toFixed(2)} ${polygon[0]!.y.toFixed(2)}`
  for (let index = 0; index < polygon.length; index += 1) {
    const before = polygon[(index - 1 + polygon.length) % polygon.length]!; const current = polygon[index]!; const next = polygon[(index + 1) % polygon.length]!; const after = polygon[(index + 2) % polygon.length]!
    const control1 = { x: current.x + (next.x - before.x) / 6, y: current.y + (next.y - before.y) / 6 }
    const control2 = { x: next.x - (after.x - current.x) / 6, y: next.y - (after.y - current.y) / 6 }
    path += ` C ${control1.x.toFixed(2)} ${control1.y.toFixed(2)} ${control2.x.toFixed(2)} ${control2.y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`
  }
  return `${path} Z`
}

/** Power-distance cells with iterative weight and light Lloyd relaxation. */
export function blobTreemap(items: ReadonlyArray<ExpenseBubble>, width: number, height: number, suppliedSeeds = layoutSeeds(items, width, height)): BlobCell[] {
  if (!items.length || width <= 0 || height <= 0) return []
  if (items.filter((item) => item.amount > 0).length === 1) return singleValueBlobTreemap(items, width, height)
  const fallback = layoutSeeds(items, width, height)
  const seeds = items.map((_, index) => suppliedSeeds[index] ?? fallback[index]!)
  const weights = items.map(() => 0); const targets = blobAreaTargets(items, width, height); let cells: Polygon[] = []
  for (let iteration = 0; iteration < 54; iteration += 1) {
    cells = items.map((_, index) => powerCell(index, seeds, weights, width, height))
    cells.forEach((cell, index) => { const error = targets[index]! - polygonArea(cell); weights[index] = Math.max(-width * height, Math.min(width * height, weights[index]! + error * 0.72)) })
    // Keep the Figma seed composition fixed. Lloyd relaxation here made the
    // right cell drift left and pushed zero-yen cells into slivers.
  }
  cells = items.map((_, index) => powerCell(index, seeds, weights, width, height))
  return items.map((item, index) => {
    const polygon = cells[index]!
    const centroid = polygonCentroid(polygon)
    const inner = smoothBlobPolygon(insetPolygon(polygon, centroid))
    return { id: item.id, polygon, inner, centroid: polygonCentroid(inner), area: polygonArea(polygon), path: roundedPath(inner), theme: categoryTheme(item) }
  })
}

export function orientationAcceleration(beta: number | null | undefined, gamma: number | null | undefined) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return fallbackTilt
  return { x: Math.max(-1, Math.min(1, gamma! / 45)) * 0.08, y: Math.max(-1, Math.min(1, beta! / 60)) * 0.08 }
}
export function seedParticles(width: number, height: number, items?: ReadonlyArray<Pick<ExpenseBubble, 'amount'>>): SeedParticle[] {
  const seeds = items ? layoutSeeds(items, width, height) : baseBlobSeeds(width, height)
  return seeds.map((seed) => ({ x: seed.x, y: seed.y, baseX: seed.x, baseY: seed.y, vx: 0, vy: 0 }))
}
export function stepSeedPhysics(particles: SeedParticle[], width: number, height: number, tilt = fallbackTilt, deltaFrames = 1) {
  const damping = Math.pow(0.88, deltaFrames)
  for (const particle of particles) {
    if (particle.dragging) continue
    particle.vx += ((particle.baseX - particle.x) * 0.014 + tilt.x * 0.68) * deltaFrames
    particle.vy += ((particle.baseY - particle.y) * 0.014 + tilt.y * 0.68) * deltaFrames
    particle.vx *= damping; particle.vy *= damping
    particle.x += particle.vx * deltaFrames; particle.y += particle.vy * deltaFrames
    const nextX = Math.max(14, Math.min(width - 14, particle.x)); const nextY = Math.max(14, Math.min(height - 14, particle.y))
    if (nextX !== particle.x) particle.vx *= -0.32
    if (nextY !== particle.y) particle.vy *= -0.32
    particle.x = nextX; particle.y = nextY
  }
  for (let left = 0; left < particles.length; left += 1) for (let right = left + 1; right < particles.length; right += 1) {
    const first = particles[left]!; const second = particles[right]!; const dx = second.x - first.x; const dy = second.y - first.y; const distance = Math.hypot(dx, dy) || 0.001
    const minimum = 42
    if (distance >= minimum) continue
    const push = (minimum - distance) * 0.045
    const x = dx / distance; const y = dy / distance
    if (!first.dragging) { first.vx -= x * push; first.vy -= y * push }
    if (!second.dragging) { second.vx += x * push; second.vy += y * push }
  }
}
export function subscribeDeviceOrientation(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, onTilt: (tilt: Point) => void) {
  const listener = (event: DeviceOrientationEvent) => onTilt(orientationAcceleration(event.beta, event.gamma))
  target.addEventListener('deviceorientation', listener)
  return () => target.removeEventListener('deviceorientation', listener)
}
function iconPath(icon: string) { return icon.startsWith('/') ? icon : `/icons/${icon}.svg` }
function fontScale(area: number) { return Math.max(0.78, Math.min(1.18, Math.sqrt(area / (viewBox.width * viewBox.height / 6)))) }

export function ExpenseBubbles({ items, onSelect }: { items: ReadonlyArray<ExpenseBubble>; onSelect?: (item: ExpenseBubble) => void }) {
  const svgRef = useRef<SVGSVGElement>(null); const pathRefs = useRef(new Map<string, SVGPathElement>()); const contentRefs = useRef(new Map<string, SVGGElement>())
  const seedsRef = useRef<SeedParticle[]>(seedParticles(viewBox.width, viewBox.height, items)); const tiltRef = useRef(fallbackTilt); const dragRef = useRef<{ id: string; pointerId: number; last: Point } | undefined>(undefined)
  const draggedRef = useRef(false); const mountedRef = useRef(false); const orientationStopRef = useRef<() => void>(() => undefined); const [size, setSize] = useState(viewBox)
  const itemKey = useMemo(() => items.map((item) => `${item.id}:${item.amount}`).join('|'), [items])
  const initial = useMemo(() => blobTreemap(items, size.width, size.height), [items, itemKey, size])
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof window === 'undefined') return
    seedsRef.current = seedParticles(size.width, size.height, items)
    let frame = 0; let previous = 0; let query: MediaQueryList | undefined; let stopOrientation: () => void = () => undefined
    const paint = (time = 0) => {
      // A sub-pixel tide keeps idle blobs alive without changing target areas.
      const visualSeeds = seedsRef.current.map((seed, index) => ({ x: seed.x + Math.sin(time / 2600 + index * 1.7) * 0.65, y: seed.y + Math.cos(time / 3100 + index * 1.3) * 0.5 }))
      blobTreemap(items, size.width, size.height, visualSeeds).forEach((cell) => {
        const path = pathRefs.current.get(cell.id); const content = contentRefs.current.get(cell.id); const scale = fontScale(cell.area)
        if (path) path.setAttribute('d', cell.path)
        if (content) content.setAttribute('transform', `translate(${cell.centroid.x.toFixed(2)} ${cell.centroid.y.toFixed(2)}) scale(${scale.toFixed(3)})`)
      })
    }
    const animate = (time: number) => { const frames = Math.min(2, Math.max(0.25, (time - previous || 16.67) / 16.67)); previous = time; stepSeedPhysics(seedsRef.current, size.width, size.height, tiltRef.current, frames); paint(time); frame = window.requestAnimationFrame(animate) }
    const applyMotion = () => { if (query?.matches) { if (frame) window.cancelAnimationFrame(frame); frame = 0; paint(0) } else if (!frame) frame = window.requestAnimationFrame(animate) }
    const resize = () => {
      const bounds = svg.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      const next = { width: viewBox.width, height: Math.round(viewBox.width * bounds.height / bounds.width) }
      setSize((current) => {
        if (current.width === next.width && current.height === next.height) return current
        seedsRef.current = seedParticles(next.width, next.height, items)
        return next
      })
    }
    const observer = new ResizeObserver(resize); observer.observe(svg); mountedRef.current = true
    const device = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> }
    if (device && typeof device.requestPermission !== 'function') stopOrientation = subscribeDeviceOrientation(window, (tilt) => { tiltRef.current = tilt })
    orientationStopRef.current = stopOrientation
    query = window.matchMedia('(prefers-reduced-motion: reduce)'); query.addEventListener('change', applyMotion); applyMotion()
    return () => { mountedRef.current = false; observer.disconnect(); query?.removeEventListener('change', applyMotion); orientationStopRef.current(); orientationStopRef.current = () => undefined; if (frame) window.cancelAnimationFrame(frame) }
  }, [itemKey, items, size])
  function requestOrientation() {
    if (typeof window === 'undefined') return
    const device = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> }
    if (typeof device?.requestPermission !== 'function') return
    void device.requestPermission().then((result) => {
      if (result !== 'granted' || !mountedRef.current) return
      orientationStopRef.current()
      orientationStopRef.current = subscribeDeviceOrientation(window, (tilt) => { tiltRef.current = tilt })
    }).catch(() => undefined)
  }
  function pointerPosition(event: PointerEvent<SVGGElement>) { const box = svgRef.current!.getBoundingClientRect(); return { x: (event.clientX - box.left) * size.width / box.width, y: (event.clientY - box.top) * size.height / box.height } }
  function startDrag(item: ExpenseBubble, event: PointerEvent<SVGGElement>) { requestOrientation(); const point = pointerPosition(event); dragRef.current = { id: item.id, pointerId: event.pointerId, last: point }; const particle = seedsRef.current.find((seed, index) => items[index]?.id === item.id); if (particle) particle.dragging = true; draggedRef.current = false; event.currentTarget.setPointerCapture(event.pointerId) }
  function moveDrag(event: PointerEvent<SVGGElement>) { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; const index = items.findIndex((item) => item.id === drag.id); const particle = seedsRef.current[index]; if (!particle) return; const point = pointerPosition(event); particle.vx = (point.x - drag.last.x) * 0.65; particle.vy = (point.y - drag.last.y) * 0.65; particle.x = point.x; particle.y = point.y; drag.last = point; draggedRef.current = true }
  function endDrag(item: ExpenseBubble, event: PointerEvent<SVGGElement>) { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; const index = items.findIndex((candidate) => candidate.id === drag.id); const particle = seedsRef.current[index]; if (particle) particle.dragging = false; dragRef.current = undefined; if (!draggedRef.current) onSelect?.(item) }
  return <div className="expense-bubbles" aria-label="カテゴリ別の支出"><svg ref={svgRef} viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="カテゴリ別の支出。金額が大きいカテゴリほど面積が大きく表示されます。">
    {initial.map((cell, index) => { const item = items[index]!; const scale = fontScale(cell.area); const iconSize = 27 * scale; return <g key={item.id} className="expense-blob" onPointerDown={(event) => startDrag(item, event)} onPointerMove={moveDrag} onPointerUp={(event) => endDrag(item, event)} onPointerCancel={(event) => endDrag(item, event)}>
      <path ref={(element) => { if (element) pathRefs.current.set(item.id, element); else pathRefs.current.delete(item.id) }} d={cell.path} fill={cell.theme.background} />
      <g ref={(element) => { if (element) contentRefs.current.set(item.id, element); else contentRefs.current.delete(item.id) }} className="expense-blob-content" transform={`translate(${cell.centroid.x} ${cell.centroid.y}) scale(${scale})`} fill={cell.theme.foreground}>
        <image href={iconPath(item.icon)} x={-iconSize / 2} y={-iconSize - 16} width={iconSize} height={iconSize} /><text y="-1" textAnchor="middle" fontSize="14" fontWeight="700">{item.label}</text><text y="21" textAnchor="middle" fontSize="18" fontWeight="500">{yen(item.amount)}</text>
      </g>
    </g> })}
  </svg></div>
}
