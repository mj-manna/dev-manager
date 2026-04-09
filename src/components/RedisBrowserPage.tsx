import { useNavigate, useParams } from 'react-router-dom'
import { getConnectionById } from '../database/connectionsStorage'
import { RedisDataBrowser } from './RedisDataBrowser'

export function RedisBrowserPage() {
  const { connectionId } = useParams<{ connectionId: string }>()
  const navigate = useNavigate()
  const decoded = connectionId ? decodeURIComponent(connectionId) : ''
  const conn = decoded ? getConnectionById(decoded) : undefined

  if (!conn || conn.kind !== 'redis') {
    return (
      <section className="panel">
        <div className="panel__head">
          <h2>Connection not found</h2>
        </div>
        <p className="database-connections-panel__empty">
          This Redis connection is missing or was removed. Return to connections to pick another one.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => navigate('/database')}>
          Back to connections
        </button>
      </section>
    )
  }

  return <RedisDataBrowser connection={conn} onBack={() => navigate('/database')} />
}
