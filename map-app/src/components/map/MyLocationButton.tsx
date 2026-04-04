import { useEffect } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'

export function MyLocationButton() {
  const map = useMap()

  useEffect(() => {
    const btn = L.DomUtil.create('button') as HTMLButtonElement
    btn.innerHTML = '📍'
    btn.title = '내 위치로 이동'
    btn.style.cssText = `
      width:40px;height:40px;border-radius:50%;background:#fff;
      border:2px solid #e2e8f0;box-shadow:0 2px 8px rgba(0,0,0,0.15);
      font-size:18px;cursor:pointer;display:flex;align-items:center;
      justify-content:center;transition:background 0.15s;
    `
    btn.onmouseenter = () => { btn.style.background = '#f8fafc' }
    btn.onmouseleave = () => { btn.style.background = '#fff' }

    const control = new (L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const container = L.DomUtil.create('div')
        L.DomEvent.disableClickPropagation(container)
        let loading = false

        btn.onclick = () => {
          if (loading || !navigator.geolocation) return
          loading = true
          btn.innerHTML = '⟳'
          btn.style.animation = 'spin 1s linear infinite'
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              map.flyTo([pos.coords.latitude, pos.coords.longitude], 15, { duration: 1.2 })
              loading = false
              btn.innerHTML = '📍'
              btn.style.animation = ''
            },
            () => {
              loading = false
              btn.innerHTML = '📍'
              btn.style.animation = ''
            },
            { timeout: 8000 }
          )
        }
        container.appendChild(btn)
        return container
      },
    }))()

    control.addTo(map)
    return () => { control.remove() }
  }, [map])

  return null
}
