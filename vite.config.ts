import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { hostsApiPlugin } from './vite-plugin-hosts-api'
import { apacheApiPlugin } from './vite-plugin-apache-api'
import { nginxApiPlugin } from './vite-plugin-nginx-api'
import { terminalWsPlugin } from './vite-plugin-terminal-ws'
import { dbTestApiPlugin } from './vite-plugin-db-test-api'
import { redisBrowserApiPlugin } from './vite-plugin-redis-browser-api'
import { postgresBrowserApiPlugin } from './vite-plugin-postgres-browser-api'
import { mysqlBrowserApiPlugin } from './vite-plugin-mysql-browser-api'
import { postgresAdminApiPlugin } from './vite-plugin-postgres-admin-api'
import { mysqlAdminApiPlugin } from './vite-plugin-mysql-admin-api'
import { linuxAutostartApiPlugin } from './vite-plugin-linux-autostart-api'
import { deploymentsPackageApiPlugin } from './vite-plugin-deployments-package-api'
import { dockerApiPlugin } from './vite-plugin-docker-api'
import { pm2ApiPlugin } from './vite-plugin-pm2-api'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    pm2ApiPlugin(),
    hostsApiPlugin(),
    nginxApiPlugin(),
    apacheApiPlugin(),
    dockerApiPlugin(),
    terminalWsPlugin(),
    dbTestApiPlugin(),
    redisBrowserApiPlugin(),
    postgresBrowserApiPlugin(),
    mysqlBrowserApiPlugin(),
    postgresAdminApiPlugin(),
    mysqlAdminApiPlugin(),
    linuxAutostartApiPlugin(),
    deploymentsPackageApiPlugin(),
  ],
  server: {
    port: 9999,
    host: true,
    allowedHosts: ['dev-manager.test'],
  },
  preview: {
    port: 9999,
    host: true,
    allowedHosts: ['dev-manager.test'],
  },
})
