/**
 * Vision provider abstraction.
 *
 * OCR recovers the words inside a diagram but not its structure: it will read
 * "Manager Approval" and "Finance Review" without telling you that one leads to
 * the other. A vision model can describe the flow. That is genuinely useful and
 * genuinely expensive, so it is an opt-in enrichment rather than part of the
 * default path.
 */

export interface VisionInput {
  image: Buffer;
  mimeType: string;
  /** Surrounding page text, so the description can use the document's language. */
  contextText?: string;
  label?: string;
}

export interface VisionResult {
  description: string;
  model: string;
  durationMs: number;
  tokens: number;
}

export interface VisionProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  describe(input: VisionInput): Promise<VisionResult>;
}
