import OpenAI, { type ClientOptions } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ReasoningEffort } from "openai/resources/shared";
import { assertReceiptImageType, ReceiptFields, RECEIPT_PROMPT, toReading, type ReceiptReader } from "./receipt-reader.js";

export { FixedReceiptReader, ReceiptFields, toReading, type ReceiptReader } from "./receipt-reader.js";

export interface OpenAIReceiptReaderOptions {
  /** Default "gpt-5.5" (image input + structured outputs). Any Responses API model with both works. */
  model?: string;
  /** Default "low": this is a short extraction. */
  reasoningEffort?: ReasoningEffort;
  /** Extra OpenAI client options (baseURL, organization, project, fetch...). The API key is the constructor's first argument. */
  clientOptions?: Omit<ClientOptions, "apiKey">;
}

/**
 * OpenAI reads the receipt (official OpenAI SDK, Responses API, strict structured output
 * validated against ReceiptFields). Pass OPENAI_API_KEY from the environment.
 */
export class OpenAIReceiptReader implements ReceiptReader {
  readonly name: string;
  private client: OpenAI;
  private model: string;
  private effort: ReasoningEffort;
  constructor(apiKey: string, options: OpenAIReceiptReaderOptions = {}) {
    this.model = options.model ?? "gpt-5.5";
    this.effort = options.reasoningEffort ?? "low";
    this.client = new OpenAI({ timeout: 60_000, maxRetries: 2, ...options.clientOptions, apiKey });
    this.name = this.model;
  }

  async read(image: Buffer, mime: string) {
    assertReceiptImageType(mime);
    const response = await this.client.responses.parse({
      model: this.model,
      max_output_tokens: 2048,
      reasoning: { effort: this.effort },
      store: false,
      input: [{ role: "user", content: [
        { type: "input_image", detail: "high", image_url: `data:${mime};base64,${image.toString("base64")}` },
        { type: "input_text", text: RECEIPT_PROMPT },
      ] }],
      text: { format: zodTextFormat(ReceiptFields, "receipt_fields") },
    });
    for (const item of response.output) {
      if (item.type !== "message") continue;
      for (const part of item.content) if (part.type === "refusal") throw new Error(`openai declined (${part.refusal.slice(0, 200)})`);
    }
    if (response.status && response.status !== "completed") {
      throw new Error(`openai: response ${response.status}${response.incomplete_details?.reason ? ` (${response.incomplete_details.reason})` : ""}`);
    }
    if (!response.output_parsed) throw new Error("openai: no structured output");
    return toReading(response.output_parsed);
  }
}
