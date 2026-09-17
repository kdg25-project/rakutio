import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'

import './expense-bubbles.css'

export type ExpenseBubble = { id: string; label: string; amount: number; icon: string; color: string }
export type Point = { x: number; y: number }
export type Polygon = Point[]
export type BlobTheme = { background: string; foreground: string }
export type BlobBounds = { x: number; y: number; width: number; height: number }
export type BlobCell = { id: string; polygon: Polygon; inner: Polygon; centroid: Point; area: number; path: string; theme: BlobTheme; bounds: BlobBounds }
export type SeedParticle = Point & { baseX: number; baseY: number; vx: number; vy: number; dragging?: boolean }

/** Dimensions of the category illustration in Figma Home / 160:1788. */
export const expenseBubbleViewBox = { width: 370, height: 205.667 }
const fallbackTilt = { x: 0, y: 0 }

/** These are deliberately authored bounds, rather than a calculated treemap.
 * Power Voronoi moves the two upper / three lower / one-right composition as
 * values change, which is exactly the visual drift the Figma design avoids. */
export const figmaReferenceBounds: ReadonlyArray<BlobBounds> = [
  { x: 35.71, y: 0.83, width: 152.955, height: 111.043 },
  { x: 196.9, y: 0, width: 114.969, height: 106.564 },
  { x: 0, y: 79.91, width: 112.938, height: 115.416 },
  { x: 120.32, y: 88.52, width: 101.534, height: 109.731 },
  { x: 222.87, y: 112.14, width: 93.734, height: 93.524 },
  { x: 292, y: 62.41, width: 76.483, height: 94.72 },
]
const referenceAmounts = [17_600, 10_470, 11_870, 6_320, 7_560, 10_780]
const referenceShares = referenceAmounts.map((amount) => amount / referenceAmounts.reduce((sum, value) => sum + value, 0))
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

/** Kept public for analytics tests: every category receives a readable floor. */
export function blobAreaTargets(items: ReadonlyArray<Pick<ExpenseBubble, 'amount'>>, width: number, height: number) {
  const totalArea = width * height
  if (!items.length) return []
  const values = items.map((item) => Math.max(0, item.amount))
  const total = values.reduce((sum, amount) => sum + amount, 0)
  if (!total) return items.map(() => totalArea / items.length)
  const floors = Math.min(.1, .6 / items.length)
  const available = 1 - floors * items.length
  return values.map((amount) => totalArea * (floors + available * amount / total))
}

export function baseBlobSeeds(width: number, height: number) {
  return figmaReferenceBounds.map((bound) => ({ x: (bound.x + bound.width / 2) * width / expenseBubbleViewBox.width, y: (bound.y + bound.height / 2) * height / expenseBubbleViewBox.height }))
}
export function seedParticles(width: number, height: number): SeedParticle[] {
  return baseBlobSeeds(width, height).map((seed) => ({ x: seed.x, y: seed.y, baseX: seed.x, baseY: seed.y, vx: 0, vy: 0 }))
}

function polygonArea(polygon: Polygon) { return Math.abs(polygon.reduce((sum, point, index) => { const next = polygon[(index + 1) % polygon.length]!; return sum + point.x * next.y - next.x * point.y }, 0) / 2) }
function polygonCentroid(polygon: Polygon) {
  const signed = polygon.reduce((sum, point, index) => { const next = polygon[(index + 1) % polygon.length]!; return sum + point.x * next.y - next.x * point.y }, 0)
  if (Math.abs(signed) < .001) return polygon[0] ?? { x: 0, y: 0 }
  const factor = 1 / (3 * signed)
  return polygon.reduce((centroid, point, index) => { const next = polygon[(index + 1) % polygon.length]!; const cross = point.x * next.y - next.x * point.y; return { x: centroid.x + (point.x + next.x) * cross * factor, y: centroid.y + (point.y + next.y) * cross * factor } }, { x: 0, y: 0 })
}
export function chaikinSmooth(polygon: Polygon, passes = 2) {
  let points = polygon
  for (let pass = 0; pass < passes; pass += 1) {
    const next: Polygon = []
    for (let index = 0; index < points.length; index += 1) {
      const left = points[index]!; const right = points[(index + 1) % points.length]!
      next.push({ x: left.x * .75 + right.x * .25, y: left.y * .75 + right.y * .25 })
      next.push({ x: left.x * .25 + right.x * .75, y: left.y * .25 + right.y * .75 })
    }
    points = next
  }
  return points
}
function scalePolygon(polygon: Polygon, centroid: Point, scale: number) { return polygon.map((point) => ({ x: centroid.x + (point.x - centroid.x) * scale, y: centroid.y + (point.y - centroid.y) * scale })) }
export function smoothBlobPolygon(polygon: Polygon) {
  const targetArea = polygonArea(polygon); const smooth = chaikinSmooth(polygon, 2); const centroid = polygonCentroid(smooth)
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

const profiles: ReadonlyArray<ReadonlyArray<Point>> = [
  [{ x: .43, y: 0 }, { x: .77, y: .04 }, { x: 1, y: .28 }, { x: .94, y: .62 }, { x: .72, y: .93 }, { x: .43, y: 1 }, { x: .13, y: .84 }, { x: 0, y: .53 }, { x: .09, y: .18 }],
  [{ x: .35, y: 0 }, { x: .72, y: .05 }, { x: 1, y: .3 }, { x: .95, y: .68 }, { x: .71, y: .96 }, { x: .38, y: 1 }, { x: .09, y: .78 }, { x: 0, y: .43 }, { x: .11, y: .13 }],
  [{ x: .34, y: 0 }, { x: .73, y: .05 }, { x: 1, y: .32 }, { x: .93, y: .67 }, { x: .67, y: 1 }, { x: .31, y: .96 }, { x: .05, y: .76 }, { x: 0, y: .4 }, { x: .12, y: .12 }],
  [{ x: .42, y: 0 }, { x: .79, y: .09 }, { x: 1, y: .36 }, { x: .89, y: .71 }, { x: .61, y: 1 }, { x: .27, y: .96 }, { x: .03, y: .69 }, { x: 0, y: .35 }, { x: .15, y: .08 }],
  [{ x: .42, y: 0 }, { x: .78, y: .08 }, { x: 1, y: .34 }, { x: .94, y: .7 }, { x: .66, y: 1 }, { x: .28, y: .95 }, { x: .04, y: .7 }, { x: 0, y: .38 }, { x: .14, y: .09 }],
  [{ x: .48, y: 0 }, { x: .82, y: .1 }, { x: 1, y: .4 }, { x: .86, y: .76 }, { x: .56, y: 1 }, { x: .2, y: .91 }, { x: .01, y: .62 }, { x: 0, y: .29 }, { x: .17, y: .06 }],
]
function clamp(value: number, lower: number, upper: number) { return Math.max(lower, Math.min(upper, value)) }
function boundsFor(index: number, width: number, height: number, scale: number, offset: Point) {
  const source = figmaReferenceBounds[index] ?? figmaReferenceBounds[figmaReferenceBounds.length - 1]!
  const basis = { x: source.x * width / expenseBubbleViewBox.width, y: source.y * height / expenseBubbleViewBox.height, width: source.width * width / expenseBubbleViewBox.width, height: source.height * height / expenseBubbleViewBox.height }
  let next = { x: basis.x + basis.width * (1 - scale) / 2 + offset.x, y: basis.y + basis.height * (1 - scale) / 2 + offset.y, width: basis.width * scale, height: basis.height * scale }
  next = { ...next, x: clamp(next.x, 0, Math.max(0, width - next.width)), y: clamp(next.y, 0, Math.max(0, height - next.height)) }
  return next
}
function amountScale(items: ReadonlyArray<ExpenseBubble>, index: number) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.amount), 0)
  if (!total) return .78
  const share = Math.max(0, items[index]?.amount ?? 0) / total
  const reference = referenceShares[index] ?? 1 / Math.max(items.length, 1)
  // The floor preserves text at zero; the cap preserves the authored gaps.
  return clamp(Math.sqrt((.1 + .4 * share) / (.1 + .4 * reference)), .72, 1.18)
}
function organicPolygon(index: number, bounds: BlobBounds) {
  const profile = profiles[index] ?? profiles[profiles.length - 1]!
  return profile.map((point) => ({ x: bounds.x + point.x * bounds.width, y: bounds.y + point.y * bounds.height }))
}

/** Figma-first layout. Supplied seeds only add a bounded visual offset, so
 * drag/gyro movement cannot turn a small category into a clipped sliver. */
export function blobTreemap(items: ReadonlyArray<ExpenseBubble>, width: number, height: number, suppliedSeeds = baseBlobSeeds(width, height)): BlobCell[] {
  if (!items.length || width <= 0 || height <= 0) return []
  const bases = baseBlobSeeds(width, height)
  return items.map((item, index) => {
    const seed = suppliedSeeds[index] ?? bases[index] ?? { x: width / 2, y: height / 2 }
    const base = bases[index] ?? seed
    const offset = { x: clamp((seed.x - base.x) * .42, -12, 12), y: clamp((seed.y - base.y) * .42, -10, 10) }
    const bounds = boundsFor(index, width, height, amountScale(items, index), offset)
    const inner = organicPolygon(index, bounds); const centroid = polygonCentroid(inner)
    return { id: item.id, polygon: inner, inner, centroid, area: polygonArea(inner), path: roundedPath(inner), theme: categoryTheme(item), bounds }
  })
}

export function orientationAcceleration(beta: number | null | undefined, gamma: number | null | undefined) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return fallbackTilt
  return { x: clamp(gamma! / 45, -1, 1) * .08, y: clamp(beta! / 60, -1, 1) * .08 }
}
export function animationEnabled(prefersReducedMotion: boolean) { return !prefersReducedMotion }
export function stepSeedPhysics(particles: SeedParticle[], width: number, height: number, tilt = fallbackTilt, deltaFrames = 1) {
  const damping = Math.pow(.88, deltaFrames)
  for (const particle of particles) {
    if (particle.dragging) continue
    particle.vx += ((particle.baseX - particle.x) * .014 + tilt.x * .68) * deltaFrames
    particle.vy += ((particle.baseY - particle.y) * .014 + tilt.y * .68) * deltaFrames
    particle.vx *= damping; particle.vy *= damping; particle.x += particle.vx * deltaFrames; particle.y += particle.vy * deltaFrames
    const nextX = clamp(particle.x, 14, width - 14); const nextY = clamp(particle.y, 14, height - 14)
    if (nextX !== particle.x) particle.vx *= -.32
    if (nextY !== particle.y) particle.vy *= -.32
    particle.x = nextX; particle.y = nextY
  }
}
export function subscribeDeviceOrientation(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, onTilt: (tilt: Point) => void) {
  const listener = (event: DeviceOrientationEvent) => onTilt(orientationAcceleration(event.beta, event.gamma))
  target.addEventListener('deviceorientation', listener)
  return () => target.removeEventListener('deviceorientation', listener)
}
function iconPath(icon: string) { return icon.startsWith('/') ? icon : `/icons/${icon}.svg` }
function fontScale(area: number) { return clamp(Math.sqrt(area / 11_000), .8, 1.08) }

export function ExpenseBubbles({ items, onSelect }: { items: ReadonlyArray<ExpenseBubble>; onSelect?: (item: ExpenseBubble) => void }) {
  const svgRef = useRef<SVGSVGElement>(null); const pathRefs = useRef(new Map<string, SVGPathElement>()); const contentRefs = useRef(new Map<string, SVGGElement>())
  const seedsRef = useRef<SeedParticle[]>(seedParticles(expenseBubbleViewBox.width, expenseBubbleViewBox.height)); const tiltRef = useRef(fallbackTilt); const dragRef = useRef<{ id: string; pointerId: number; last: Point } | undefined>(undefined)
  const draggedRef = useRef(false); const mountedRef = useRef(false); const orientationStopRef = useRef<() => void>(() => undefined); const [size, setSize] = useState(expenseBubbleViewBox)
  const itemKey = useMemo(() => items.map((item) => `${item.id}:${item.amount}`).join('|'), [items])
  const initial = useMemo(() => blobTreemap(items, size.width, size.height), [items, itemKey, size])
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof window === 'undefined') return
    seedsRef.current = seedParticles(size.width, size.height)
    let frame = 0; let previous = 0; let query: MediaQueryList | undefined; let stopOrientation: () => void = () => undefined
    const paint = (time = 0) => {
      const visualSeeds = seedsRef.current.map((seed, index) => ({ x: seed.x + Math.sin(time / 2600 + index * 1.7) * .65, y: seed.y + Math.cos(time / 3100 + index * 1.3) * .5 }))
      blobTreemap(items, size.width, size.height, visualSeeds).forEach((cell) => {
        const path = pathRefs.current.get(cell.id); const content = contentRefs.current.get(cell.id); const scale = fontScale(cell.area)
        if (path) path.setAttribute('d', cell.path)
        if (content) content.setAttribute('transform', `translate(${cell.centroid.x.toFixed(2)} ${cell.centroid.y.toFixed(2)}) scale(${scale.toFixed(3)})`)
      })
    }
    const animate = (time: number) => { const frames = clamp((time - previous || 16.67) / 16.67, .25, 2); previous = time; stepSeedPhysics(seedsRef.current, size.width, size.height, tiltRef.current, frames); paint(time); frame = window.requestAnimationFrame(animate) }
    const applyMotion = () => { if (!animationEnabled(Boolean(query?.matches))) { if (frame) window.cancelAnimationFrame(frame); frame = 0; paint(0) } else if (!frame) frame = window.requestAnimationFrame(animate) }
    const resize = () => { const bounds = svg.getBoundingClientRect(); if (!bounds.width || !bounds.height) return; const next = { width: expenseBubbleViewBox.width, height: Math.round(expenseBubbleViewBox.width * bounds.height / bounds.width * 1000) / 1000 }; setSize((current) => current.width === next.width && current.height === next.height ? current : next) }
    const observer = new ResizeObserver(resize); observer.observe(svg); mountedRef.current = true
    const device = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> }
    if (device && typeof device.requestPermission !== 'function') stopOrientation = subscribeDeviceOrientation(window, (tilt) => { tiltRef.current = tilt })
    orientationStopRef.current = stopOrientation; query = window.matchMedia('(prefers-reduced-motion: reduce)'); query.addEventListener('change', applyMotion); applyMotion()
    return () => { mountedRef.current = false; observer.disconnect(); query?.removeEventListener('change', applyMotion); orientationStopRef.current(); orientationStopRef.current = () => undefined; if (frame) window.cancelAnimationFrame(frame) }
  }, [itemKey, items, size])
  function requestOrientation() {
    if (typeof window === 'undefined') return
    const device = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> }
    if (typeof device?.requestPermission !== 'function') return
    void device.requestPermission().then((result) => { if (result !== 'granted' || !mountedRef.current) return; orientationStopRef.current(); orientationStopRef.current = subscribeDeviceOrientation(window, (tilt) => { tiltRef.current = tilt }) }).catch(() => undefined)
  }
  function pointerPosition(event: PointerEvent<SVGGElement>) { const box = svgRef.current!.getBoundingClientRect(); return { x: (event.clientX - box.left) * size.width / box.width, y: (event.clientY - box.top) * size.height / box.height } }
  function startDrag(item: ExpenseBubble, event: PointerEvent<SVGGElement>) { requestOrientation(); const point = pointerPosition(event); dragRef.current = { id: item.id, pointerId: event.pointerId, last: point }; const particle = seedsRef.current.find((_, index) => items[index]?.id === item.id); if (particle) particle.dragging = true; draggedRef.current = false; event.currentTarget.setPointerCapture(event.pointerId) }
  function moveDrag(event: PointerEvent<SVGGElement>) { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; const index = items.findIndex((item) => item.id === drag.id); const particle = seedsRef.current[index]; if (!particle) return; const point = pointerPosition(event); particle.vx = (point.x - drag.last.x) * .65; particle.vy = (point.y - drag.last.y) * .65; particle.x = point.x; particle.y = point.y; drag.last = point; draggedRef.current = true }
  function endDrag(item: ExpenseBubble, event: PointerEvent<SVGGElement>) { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; const index = items.findIndex((candidate) => candidate.id === drag.id); const particle = seedsRef.current[index]; if (particle) particle.dragging = false; dragRef.current = undefined; if (!draggedRef.current) onSelect?.(item) }
  function onKey(item: ExpenseBubble, event: KeyboardEvent<SVGGElement>) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(item) } }
  return <div className="expense-bubbles" aria-label="カテゴリ別の支出"><svg ref={svgRef} viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="カテゴリ別の支出。金額が大きいカテゴリほど面積が大きく表示されます。">
    {initial.map((cell, index) => { const item = items[index]!; const scale = fontScale(cell.area); const iconSize = 27 * scale; return <g key={item.id} className="expense-blob" role="button" tabIndex={0} aria-label={`${item.label} ${yen(item.amount)}。分析を表示`} onKeyDown={(event) => onKey(item, event)} onPointerDown={(event) => startDrag(item, event)} onPointerMove={moveDrag} onPointerUp={(event) => endDrag(item, event)} onPointerCancel={(event) => endDrag(item, event)}>
      <path ref={(element) => { if (element) pathRefs.current.set(item.id, element); else pathRefs.current.delete(item.id) }} d={cell.path} fill={cell.theme.background} />
      <g ref={(element) => { if (element) contentRefs.current.set(item.id, element); else contentRefs.current.delete(item.id) }} className="expense-blob-content" transform={`translate(${cell.centroid.x} ${cell.centroid.y}) scale(${scale})`} fill={cell.theme.foreground}>
        <image href={iconPath(item.icon)} x={-iconSize / 2} y={-iconSize - 16} width={iconSize} height={iconSize} /><text y="-1" textAnchor="middle" fontSize="14" fontWeight="700">{item.label}</text><text y="21" textAnchor="middle" fontSize="18" fontWeight="500">{yen(item.amount)}</text>
      </g>
    </g> })}
  </svg></div>
}
