import { useEffect, useState } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { createRoot, Root } from 'react-dom/client'
import { CATEGORY_META } from '@/types'
import { useUiStore } from '@/store'
import type { PriceCategory } from '@/types'

const CATEGORIES: PriceCategory[] = [
  'exchange', 'fuel', 'restaurant', 'cafe', 'convenience',
  'jjimjilbang', 'karaoke', 'market', 'attraction', 'extra',
]

function LegendPanel() {
  const [open, setOpen] = useState(false)
  const { language } = useUiStore()

  return (
    <div style={{
      background: '#fff', borderRadius: '12px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.15)', border: '1px solid #e2e8f0',
      overflow: 'hidden', minWidth: '130px',
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '8px 10px', width: '100%', background: 'none',
          border: 'none', cursor: 'pointer', fontSize: '13px',
          fontWeight: 600, color: '#334155',
        }}
      >
        <span>🗂️</span>
        <span>{language === 'ko' ? '범례' : 'Legend'}</span>
        <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: '11px' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', gap: '8px', fontSize: '11px', color: '#64748b', paddingTop: '4px', borderTop: '1px solid #f1f5f9', flexWrap: 'wrap' }}>
            <span style={{ color: '#f59e0b', fontWeight: 700 }}>👑 1위</span>
            <span>🥈 2위</span>
            <span>🥉 3위</span>
          </div>
          {CATEGORIES.map((cat) => {
            const meta = CATEGORY_META[cat]
            return (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#334155' }}>
                <span style={{
                  width: '20px', height: '20px', borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '11px', background: meta.color + '22',
                  border: `2px solid ${meta.color}`, flexShrink: 0,
                }}>
                  {meta.emoji}
                </span>
                <span>{language === 'ko' ? meta.label : meta.labelEn}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function MapLegend() {
  const map = useMap()

  useEffect(() => {
    let root: Root | null = null

    const control = new (L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd() {
        const container = L.DomUtil.create('div')
        L.DomEvent.disableClickPropagation(container)
        root = createRoot(container)
        root.render(<LegendPanel />)
        return container
      },
    }))()

    control.addTo(map)
    return () => {
      root?.unmount()
      control.remove()
    }
  }, [map])

  return null
}
