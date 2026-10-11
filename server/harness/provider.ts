import { openaiCompatible } from "@tanstack/ai-openai/compatible";
import { providerModels } from "./agents";

export const deepinfra = openaiCompatible({
  name: "deepinfra",
  baseURL: "https://api.deepinfra.com/v1/openai",
  apiKey: process.env.MODEL_API_KEY!,
  models: [...providerModels],
});
