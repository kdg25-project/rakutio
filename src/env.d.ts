/// <reference types="vite/client" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    RECEIPTS: R2Bucket
    BETTER_AUTH_SECRET: string
    BETTER_AUTH_URL: string
    DOCUMENT_AI_PROJECT_ID?: string
    DOCUMENT_AI_LOCATION?: 'us' | 'eu'
    DOCUMENT_AI_PROCESSOR_ID?: string
    DOCUMENT_AI_PROCESSOR_VERSION?: string
    DOCUMENT_AI_SERVICE_ACCOUNT_EMAIL?: string
    DOCUMENT_AI_SERVICE_ACCOUNT_PRIVATE_KEY?: string
    GOOGLE_AI_API_KEY?: string
    GOOGLE_AI_MODEL?: string
  }
}
