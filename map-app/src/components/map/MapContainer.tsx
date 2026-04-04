import { MapContainer as LeafletMap, TileLayer } from 'react-leaflet'
import { MarkerLayer } from './MarkerLayer'
import { MyLocationButton } from './MyLocationButton'
import { MapLegend } from './MapLegend'
import 'leaflet/dist/leaflet.css'

// Fix for default marker icons in leaflet + webpack/vite
import L from 'leaflet'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

const SEOUL_CENTER: [number, number] = [37.5665, 126.978]

export function MapContainer() {
  return (
    <LeafletMap
      center={SEOUL_CENTER}
      zoom={13}
      scrollWheelZoom={true}
      className="w-full h-full"
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        maxZoom={19}
      />
      <MarkerLayer />
      <MyLocationButton />
      <MapLegend />
    </LeafletMap>
  )
}
