import { useNavigate } from 'react-router-dom'
import { getConnectionById } from '../database/connectionsStorage'
import { MysqlDataBrowser } from './MysqlDataBrowser'

export function MysqlBrowserPage({ connectionId }: { connectionId: string }) {
  const navigate = useNavigate()
  const conn = getConnectionById(connectionId)

  if (!conn || conn.kind !== 'mysql') {
    return (
      <section className="panel">
        <div className="panel__head">
          <h2>Connection not found</h2>
        </div>
        <p className="database-connections-panel__empty">
          This MySQL connection is missing or was removed. Return to connections to pick another one.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => navigate('/database')}>
          Back to connections
        </button>
      </section>
    )
  }

  return <MysqlDataBrowser connection={conn} />
}
