import { buildApp } from './app.js'
import { warnIfAdapterSecretMissing } from './flows.js'

const PORT = Number(process.env.PORT || 3000)

async function main() {
  const app = await buildApp()

  await app.listen({ port: PORT, host: '0.0.0.0' })
  app.log.info(`model-catalog-api listening on port ${PORT}`)
  warnIfAdapterSecretMissing(app.log)

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info('Shutting down...')
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
