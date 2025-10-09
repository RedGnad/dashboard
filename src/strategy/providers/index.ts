import { InferenceProvider, InferenceRequest, InferenceResponse } from './types'
import { LocalProvider } from './local'
import { OpenGradientStubProvider } from './opengradientStub'

export function selectInferenceProvider(): InferenceProvider {
  const mode = (process.env.INFERENCE_PROVIDER || 'local').toLowerCase()
  if (mode === 'opengradient_stub' || mode === 'opengradient-stub' || mode === 'og-stub') {
    return new OpenGradientStubProvider({ modelCid: process.env.OG_MODEL_CID, inferenceMode: process.env.OG_INFERENCE_MODE })
  }
  // Fallback par défaut
  return new LocalProvider()
}

export type { InferenceProvider, InferenceRequest, InferenceResponse }
