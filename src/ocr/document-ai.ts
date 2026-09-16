import { env } from 'cloudflare:workers'

import { extractReceiptWithDocumentAi, validateDocumentAiConfig } from './receipt'

export function extractReceipt(file: File) {
  const config = validateDocumentAiConfig({
    projectId: env.DOCUMENT_AI_PROJECT_ID,
    location: env.DOCUMENT_AI_LOCATION || 'us',
    processorId: env.DOCUMENT_AI_PROCESSOR_ID,
    processorVersion: env.DOCUMENT_AI_PROCESSOR_VERSION,
    serviceAccountEmail: env.DOCUMENT_AI_SERVICE_ACCOUNT_EMAIL,
    serviceAccountPrivateKey: env.DOCUMENT_AI_SERVICE_ACCOUNT_PRIVATE_KEY,
  })
  return extractReceiptWithDocumentAi(file, config)
}
