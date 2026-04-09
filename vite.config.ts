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
import { postgresAdminApiPlugin } from './vite-plugin-postgres-admin-api'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    hostsApiPlugin(),
    nginxApiPlugin(),
    apacheApiPlugin(),
    terminalWsPlugin(),
    dbTestApiPlugin(),
    redisBrowserApiPlugin(),
    postgresBrowserApiPlugin(),
    postgresAdminApiPlugin(),
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
