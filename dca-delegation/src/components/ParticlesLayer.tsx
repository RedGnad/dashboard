import { useEffect, useRef } from 'react'

export default function ParticlesLayer() {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let w = (canvas.width = window.innerWidth)
    let h = (canvas.height = window.innerHeight)

    const onResize = () => {
      w = canvas.width = window.innerWidth
      h = canvas.height = window.innerHeight
    }
    window.addEventListener('resize', onResize)

    const count = Math.max(36, Math.floor((w * h) / 120000)) // density faible
    const parts: { x: number; y: number; r: number; vx: number; vy: number; hue: number }[] = []
    const rand = (a: number, b: number) => a + Math.random() * (b - a)

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = rand(0.03, 0.08)
      parts.push({
        x: rand(w * 0.2, w * 0.8),
        y: rand(h * 0.2, h * 0.8),
        r: rand(0.5, 1.6),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        hue: rand(250, 290), // violet/indigo subtil
      })
    }

    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'

      for (const p of parts) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0) p.x = w
        if (p.x > w) p.x = 0
        if (p.y < 0) p.y = h
        if (p.y > h) p.y = 0

        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 8)
        g.addColorStop(0, `hsla(${p.hue},80%,70%,0.35)`)
        g.addColorStop(1, 'hsla(0,0%,0%,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r * 6, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    tick()
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <div className="pointer-events-none absolute inset-0 z-[1]">
      <canvas ref={ref} className="w-full h-full" />
    </div>
  )
}
