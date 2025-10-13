import { InferenceProvider, InferenceRequest, InferenceResponse, hashJsonStable } from './types'
import { loadModel, computeScore } from '../model'

export class LocalProvider implements InferenceProvider {
  name() { return 'ts-local' }
  async run(req: InferenceRequest): Promise<InferenceResponse> {
    const model = loadModel()
    const { score, z, weightsUsedHash } = computeScore(req.features, model)
    // model.modelHash déjà stable à partir du fichier
    return {
      score,
      z,
      modelHash: model.modelHash,
      weightsUsedHash,
      provider: this.name(),
      version: model.version,
      meta: { arch: model.arch }
    }
  }
}
