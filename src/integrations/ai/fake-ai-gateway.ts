import { type AiGatewayPort, type VisionRequest, type VisionResponse } from './ai-gateway.port';

/** No model in dev/tests: every vision call answers "nothing recognised" (the OCR fakes do the work). */
export class FakeAiGateway implements AiGatewayPort {
  readonly mode = 'fake' as const;
  readonly calls: VisionRequest[] = [];

  vision(request: VisionRequest): Promise<VisionResponse> {
    this.calls.push(request);
    return Promise.resolve({ json: null, model: 'fake', usage: null });
  }
}
