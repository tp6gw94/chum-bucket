import { openaiCompatible } from "@tanstack/ai-openai/compatible";

export const deepinfra = openaiCompatible({
  name: "deepinfra",
  baseURL: "https://api.deepinfra.com/v1/openai",
  apiKey: process.env.MODEL_API_KEY!,
  models: ["deepseek-ai/DeepSeek-V4.1-Flash"],
});
