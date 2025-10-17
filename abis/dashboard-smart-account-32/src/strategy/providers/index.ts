import { InferenceProvider, InferenceRequest, InferenceResponse } from './types'
import { LocalProvider } from './local'
import { OpenGradientStubProvider } from './opengradientStub'
import { OpenGradientHttpProvider } from './opengradientHttp'
import { OpenAIProvider } from './openai'

export function selectInferenceProvider(modeOverride?: string): InferenceProvider {
  const mode = (modeOverride || process.env.INFERENCE_PROVIDER || 'local').toLowerCase()
  if (mode === 'openai') {
    return new OpenAIProvider()
  }
  if (mode === 'opengradient_stub' || mode === 'opengradient-stub' || mode === 'og-stub') {
    return new OpenGradientStubProvider({ modelCid: process.env.OG_MODEL_CID, inferenceMode: process.env.OG_INFERENCE_MODE })
  }
  if (mode === 'opengradient' || mode === 'og' || mode === 'open-gradient') {
    return new OpenGradientHttpProvider({ baseUrl: process.env.OG_PROXY_URL, modelId: process.env.OG_MODEL_ID, version: process.env.OG_PROVIDER_VERSION })
  }
  // Fallback par défaut
  return new LocalProvider()
}

export type { InferenceProvider, InferenceRequest, InferenceResponse }
