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
const referenceSeeds: Point[] = [
  { x: 0.34, y: 0.28 }, { x: 0.70, y: 0.27 }, { x: 0.15, y: 0.70 },
  { x: 0.47, y: 0.70 }, { x: 0.72, y: 0.75 }, { x: 0.91, y: 0.48 },
]
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
  // Six Figma categories must remain legible even when the ledger only has
  // one populated category. 72% is reserved as equal readable space; only
  // the remaining 28% expresses the amount ratio, capping a lone value at 40%.
  const minimum = totalArea * Math.min(0.12, 0.82 / Math.max(items.length, 1))
  const remaining = Math.max(0, totalArea - minimum * items.length)
  const total = items.reduce((sum, item) => sum + Math.max(0, item.amount), 0)
  if (total === 0) return items.map(() => totalArea / Math.max(items.length, 1))
  return items.map((item) => minimum + remaining * (Math.max(0, item.amount) / total))
}
export function baseBlobSeeds(width: number, height: number) { return referenceSeeds.map((seed) => ({ x: seed.x * width, y: seed.y * height })) }

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
export function blobTreemap(items: ReadonlyArray<ExpenseBubble>, width: number, height: number, suppliedSeeds = baseBlobSeeds(width, height)): BlobCell[] {
  if (!items.length || width <= 0 || height <= 0) return []
  const fallback = baseBlobSeeds(width, height)
  const seeds = items.map((_, index) => suppliedSeeds[index] ?? fallback[index]!)
  const weights = items.map(() => 0); const targets = blobAreaTargets(items, width, height); let cells: Polygon[] = []
  for (let iteration = 0; iteration < 54; iteration += 1) {
    cells = items.map((_, index) => powerCell(index, seeds, weights, width, height))
    cells.forEach((cell, index) => { const error = targets[index]! - polygonArea(cell); weights[index] = Math.max(-width * height, Math.min(width * height, weights[index]! + error * 0.72)) })
    if (iteration === 17 || iteration === 35) cells.forEach((cell, index) => { if (!cell.length) return; const centroid = polygonCentroid(cell); seeds[index] = { x: seeds[index]!.x * 0.84 + centroid.x * 0.16, y: seeds[index]!.y * 0.84 + centroid.y * 0.16 } })
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
export function seedParticles(width: number, height: number): SeedParticle[] {
  return baseBlobSeeds(width, height).map((seed) => ({ x: seed.x, y: seed.y, baseX: seed.x, baseY: seed.y, vx: 0, vy: 0 }))
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
  const seedsRef = useRef<SeedParticle[]>(seedParticles(viewBox.width, viewBox.height)); const tiltRef = useRef(fallbackTilt); const dragRef = useRef<{ id: string; pointerId: number; last: Point } | undefined>(undefined)
  const draggedRef = useRef(false); const mountedRef = useRef(false); const orientationStopRef = useRef<() => void>(() => undefined); const [size, setSize] = useState(viewBox)
  const itemKey = useMemo(() => items.map((item) => `${item.id}:${item.amount}`).join('|'), [items])
  const initial = useMemo(() => blobTreemap(items, size.width, size.height), [items, itemKey, size])
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof window === 'undefined') return
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
        seedsRef.current = seedParticles(next.width, next.height)
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
