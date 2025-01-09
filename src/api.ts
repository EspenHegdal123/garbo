import express from 'express'
import pino from 'pino-http'
import swaggerJsdoc from 'swagger-jsdoc'
import { apiReference } from '@scalar/express-api-reference'

import readCompanies from './api/routes/company.read'
import updateCompanies from './api/routes/company.update'
import deleteCompanyData from './api/routes/company.delete'
import {
  createMetadata,
  ensureEconomyExists,
  ensureEmissionsExists,
  ensureReportingPeriod,
  fakeAuth,
  fetchCompanyByWikidataId,
  validateMetadata,
  validateReportingPeriodRequest,
} from './api/middlewares/middlewares'
import { errorHandler } from './api/middlewares/errorhandler'
import { swaggerOptions } from './swagger'
import { prisma } from './lib/prisma'
import { processRequestParams } from './api/middlewares/zod-middleware'
import { wikidataIdParamSchema } from './api/schemas'

const apiRouter = express.Router()
const pinoConfig = process.stdin.isTTY && {
  transport: {
    target: 'pino-pretty',
  },
  level: 'info',
}
apiRouter.use(pino(pinoConfig || undefined))

// API Routes

apiRouter.use('/companies', express.json())
apiRouter.use('/companies', readCompanies)

apiRouter.use('/companies', fakeAuth(prisma))
apiRouter.use('/companies', deleteCompanyData)

apiRouter.use('/companies', validateMetadata(), createMetadata(prisma))
apiRouter.use(
  '/companies/:wikidataId',
  processRequestParams(wikidataIdParamSchema),
  fetchCompanyByWikidataId(prisma)
)
apiRouter.use(
  '/companies/:wikidataId/:year',
  validateReportingPeriodRequest(),
  ensureReportingPeriod(prisma)
)
apiRouter.use('/:wikidataId/:year/emissions', ensureEmissionsExists(prisma))
apiRouter.use('/:wikidataId/:year/economy', ensureEconomyExists(prisma))
apiRouter.use('/companies', updateCompanies)

// Generate and publish OpenAPI documentation
const openApiSpec = swaggerJsdoc(swaggerOptions)
apiRouter.get('/openapi.json', (_req, res) => {
  res.json(openApiSpec)
})
apiRouter.use(
  '/',
  apiReference({
    spec: {
      url: '/api/openapi.json',
    },
  })
)

apiRouter.use(errorHandler)

export default apiRouter
