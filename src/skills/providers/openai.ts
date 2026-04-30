import type { LlmKeyVerification } from '@elisym/sdk/llm-health';
import type {
  CompletionResult,
  LlmClient,
  ToolCall,
  ToolDef,
  ToolResult,
} from '@elisym/sdk/skills';
import type { LlmProviderDescriptor } from '../registry';
import { fetchWithRetry, fetchWithTimeout } from './http';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = 4096;
const FALLBACK_MODELS = ['gpt-4o', 'gpt-4o-mini', 'o3-mini'];

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIResponse {
  choices?: Array<{ message?: OpenAIMessage }>;
}

interface OpenAIClientConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export function isOpenAIReasoningModel(model: string): boolean {
  return /^o\d/.test(model) || /^gpt-5(\b|[-.])/.test(model);
}

export class OpenAIClient implements LlmClient {
  constructor(private readonly config: OpenAIClientConfig) {}

  private isReasoningModel(): boolean {
    return isOpenAIReasoningModel(this.config.model);
  }

  async complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string> {
    const reasoning = this.isReasoningModel();
    const response = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(reasoning
            ? { max_completion_tokens: this.config.maxTokens }
            : { max_tokens: this.config.maxTokens }),
          messages: [
            { role: reasoning ? 'developer' : 'system', content: systemPrompt },
            { role: 'user', content: userInput },
          ],
        }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as OpenAIResponse;
    return data.choices?.[0]?.message?.content ?? '';
  }

  async completeWithTools(
    systemPrompt: string,
    messages: unknown[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const openaiTools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            tool.parameters.map((param) => [
              param.name,
              { type: 'string', description: param.description },
            ]),
          ),
          required: tool.parameters.filter((param) => param.required).map((param) => param.name),
        },
      },
    }));

    const reasoning = this.isReasoningModel();
    const response = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(reasoning
            ? { max_completion_tokens: this.config.maxTokens }
            : { max_tokens: this.config.maxTokens }),
          messages: [
            { role: reasoning ? 'developer' : 'system', content: systemPrompt },
            ...messages,
          ],
          tools: openaiTools,
        }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as OpenAIResponse;
    const message = data.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];

    if (toolCalls.length > 0) {
      const calls: ToolCall[] = toolCalls.map((call) => {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        return { id: call.id ?? '', name: call.function?.name ?? '', arguments: args };
      });
      return { type: 'tool_use', calls, assistantMessage: message };
    }
    return { type: 'text', text: message?.content ?? '' };
  }

  formatToolResultMessages(results: ToolResult[]): unknown[] {
    return results.map((result) => ({
      role: 'tool',
      tool_call_id: result.callId,
      content: result.content,
    }));
  }
}

async function fetchModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(
      'https://api.openai.com/v1/models',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      signal,
    );
    if (!response.ok) {
      return FALLBACK_MODELS;
    }
    const data = (await response.json()) as { data?: { id: string }[] };
    const models = (data.data ?? [])
      .map((entry) => entry.id)
      .filter(
        (id) =>
          (id.startsWith('gpt-') ||
            id.startsWith('o1') ||
            id.startsWith('o3') ||
            id.startsWith('o4') ||
            id.startsWith('chatgpt-')) &&
          !id.includes('instruct') &&
          !id.includes('realtime') &&
          !id.includes('audio') &&
          !id.includes('tts') &&
          !id.includes('whisper'),
      )
      .sort();
    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

async function verifyKey(apiKey: string, signal?: AbortSignal): Promise<LlmKeyVerification> {
  try {
    const response = await fetchWithTimeout(
      'https://api.openai.com/v1/models',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      signal,
    );
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: true };
    }
    const body = (await response.text().catch(() => '')).slice(0, 500);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid', status: response.status, body };
    }
    return {
      ok: false,
      reason: 'unavailable',
      error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'unavailable', error: message };
  }
}

const BILLING_BODY_MARKERS = ['credit balance', 'billing', 'insufficient_quota', 'insufficient'];

function bodyLooksLikeBilling(body: string): boolean {
  const lower = body.toLowerCase();
  return BILLING_BODY_MARKERS.some((marker) => lower.includes(marker));
}

async function verifyKeyDeep(
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<LlmKeyVerification> {
  try {
    const reasoning = isOpenAIReasoningModel(model);
    const response = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          ...(reasoning ? { max_completion_tokens: 1 } : { max_tokens: 1 }),
          messages: [{ role: 'user', content: '.' }],
        }),
      },
      signal,
    );
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: true };
    }
    const body = (await response.text().catch(() => '')).slice(0, 500);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid', status: response.status, body };
    }
    if (response.status === 402) {
      return { ok: false, reason: 'billing', status: response.status, body };
    }
    if (response.status === 429 && bodyLooksLikeBilling(body)) {
      return { ok: false, reason: 'billing', status: response.status, body };
    }
    if (response.status === 400 && bodyLooksLikeBilling(body)) {
      return { ok: false, reason: 'billing', status: response.status, body };
    }
    return {
      ok: false,
      reason: 'unavailable',
      error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'unavailable', error: message };
  }
}

export const OPENAI_PROVIDER: LlmProviderDescriptor = {
  id: 'openai',
  displayName: 'OpenAI (GPT)',
  envVar: 'OPENAI_API_KEY',
  defaultModel: DEFAULT_MODEL,
  fallbackModels: FALLBACK_MODELS,
  fetchModels,
  verifyKey,
  verifyKeyDeep,
  createClient: (config) =>
    new OpenAIClient({
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODEL,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    }),
  isReasoningModel: isOpenAIReasoningModel,
};
