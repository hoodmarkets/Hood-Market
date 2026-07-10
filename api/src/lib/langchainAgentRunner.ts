import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { config } from '../config.js';
import { createLiquidLauncherAgentTools } from './langchainTools.js';
import type { IdentityClaim } from './privy.js';

// ─── Per-user conversation memory ───────────────────────────────────────────
// Stores the last N condensed (human + final AI) turns per user, keyed by
// `platform:userId`. Cleared only on server restart; intentionally lightweight.
const memoryStore = new Map<string, Array<[HumanMessage, AIMessage]>>();

function memoryKey(identity: IdentityClaim): string {
  return `${identity.platform}:${identity.userId}`;
}

function loadMemory(identity: IdentityClaim): BaseMessage[] {
  const turns = config.langchainAgent.memoryTurns;
  if (turns === 0) return [];
  const stored = memoryStore.get(memoryKey(identity)) ?? [];
  const recent = stored.slice(-turns);
  return recent.flatMap(([h, a]) => [h, a]);
}

function saveMemory(identity: IdentityClaim, human: HumanMessage, assistant: AIMessage): void {
  const turns = config.langchainAgent.memoryTurns;
  if (turns === 0) return;
  const key = memoryKey(identity);
  const stored = memoryStore.get(key) ?? [];
  stored.push([human, assistant]);
  if (stored.length > turns) stored.splice(0, stored.length - turns);
  memoryStore.set(key, stored);
}

// ─── System prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a proactive Base trading agent on Liquid Launcher (chain id 8453).

PERSONALITY: Direct, natural, Brooklyn edge. Under 1200 chars per response. No filler.

CORE RULES — never break these:
- proactive_by_default: Any token or pool mentioned → run the RESEARCH CHECKLIST immediately, in parallel. Never ask "want me to?" or "should I look that up?" — run tools and synthesize.
- never_ask_just_do: Clear buy/sell/swap/deploy intent → use the right checklist; assume reasonable defaults, execute, correct if wrong.
- verify_before_answering: Never cite prices, balances, or pool state from memory — always fetch fresh with tools.
- parallel_tools: Fire independent tool calls together (market + web + wallet + on-chain pool when applicable).
- narrative_filter: Deprioritize stale hype: if web/volume story is >7d cold or no meaningful 24h volume on CoinGecko data, say so bluntly. Do not recycle dead CT narratives as "alpha."
- sleep_for_confirmations: After tx lands, post hash + Basescan link. Done. Don't follow up unless asked.

MEMORIES (user prefs — never override):
- User wants gasless delegated trades, no per-tx signatures
- Cheap fast LLMs for tool work
- No native ETH sends — swaps only, Base mainnet only

RESEARCH CHECKLIST (auto-run on any token mention):
1. resolve_token_on_base — Base contract from symbol/name
2. [parallel] get_token_market_data — price, mcap, FDV, volume, 24h/7d Δ, liquidity, ATH
3. [parallel] web_search "{token} CT alpha OR news last 72h -scam -ad" — real-time sentiment (if Tavily configured)
4. If user gives a Uniswap v4 bytes32 poolId (from Liquid deploy): [parallel] read_v4_pool_liquidity(poolId) — on-chain sqrtPrice, liquidity, rough impact bands (no paid API)
5. Deliver: price action, on-chain depth (when poolId known), risks, fit. Under 1200 chars.

SWAP CHECKLIST:
1. resolve_token_on_base (if symbol)
2. [parallel] get_token_market_data + get_wallet_eth_balance
3. check_swap_readiness — Privy delegation + server config (or get_trading_context)
4. preview_delegated_swap — quote (output, price impact, route)
5. Clear confirmation → execute_delegated_swap → tx hash + basescan.org

WALLET / "HOW MUCH CAN I TRADE" CHECKLIST:
1. get_trading_context — wallet, ETH balance, delegated caps + status (first call for these questions)

TOOLS:
- resolve_token_on_base(query): CoinGecko → Base contract address
- get_token_market_data(tokenAddress): price, mcap, FDV, 24h vol, Δ%, liquidity, ATH
- read_v4_pool_liquidity(poolId): Uniswap v4 PoolManager on Base — sqrtPriceX96, tick, liquidity, rough 1–5% depth impact (CP approx). poolId = 0x + 64 hex, not a token address.
- get_wallet_eth_balance(): user ETH balance on Base
- get_trading_context(): wallet 0x, ETH balance, swap readiness + limits
- get_token_balance(tokenAddress): user ERC-20 balance on Base
- web_search(query, maxResults?): Tavily — skip silently if not configured
- check_swap_readiness(): Privy delegation + quote providers
- preview_delegated_swap(tokenAddress, side, quoteProvider?): quote + sim, no tx
- execute_delegated_swap(tokenAddress, side, quoteProvider?): Privy server signing

Platform identity is fixed server-side — never ask for user id, handles, or keys.
Delegation missing → "Open Liquid Launcher web app → Wallet → Grant server access."
Auto-bridge/gas-top-up coming soon — for now flag low ETH balance to user.`;

// ─── LLM factory ────────────────────────────────────────────────────────────
function makeModel(
  modelId: string,
  apiKey: string,
  baseUrl: string,
  bindTools?: DynamicStructuredTool[],
) {
  const opts = baseUrl ? { configuration: { baseURL: baseUrl } } : {};
  const llm = new ChatOpenAI({ apiKey, model: modelId, temperature: 0.1, ...opts });
  return bindTools ? llm.bindTools(bindTools) : llm;
}

// ─── Agent runner ────────────────────────────────────────────────────────────
export async function runLiquidLauncherLangchainAgent(input: {
  userMessage: string;
  identity: IdentityClaim;
}): Promise<{ output: string }> {
  const { userMessage, identity } = input;

  const agentCfg = config.langchainAgent;
  const apiKey = agentCfg.llmApiKey;
  if (!apiKey) {
    throw new Error('Set LANGCHAIN_LLM_API_KEY or OPENAI_API_KEY for the agent LLM.');
  }

  const tools = createLiquidLauncherAgentTools(identity) as DynamicStructuredTool[];

  // Tool-calling model (cheap / fast for multi-step reasoning)
  const toolModelId = agentCfg.toolModel;
  const toolBaseUrl = agentCfg.openaiCompatibleBaseUrl;
  const toolModel = makeModel(toolModelId, apiKey, toolBaseUrl, tools);

  // Synthesis model (for the final user-facing reply — may be different provider)
  const synthModelId = agentCfg.synthesisModel;
  const synthApiKey = agentCfg.synthesisApiKey || apiKey;
  const synthBaseUrl = agentCfg.synthesisBaseUrl || toolBaseUrl;
  const useSeparateSynthModel =
    synthModelId !== toolModelId || synthApiKey !== apiKey || synthBaseUrl !== toolBaseUrl;
  const synthModel = useSeparateSynthModel
    ? makeModel(synthModelId, synthApiKey, synthBaseUrl)
    : null;

  // Load conversation memory (last N turns)
  const humanMsg = new HumanMessage(userMessage);
  const messages: BaseMessage[] = [
    new SystemMessage(SYSTEM_PROMPT),
    ...loadMemory(identity),
    humanMsg,
  ];

  // ─── ReAct tool loop ───────────────────────────────────────────────────
  let finalAiMessage: AIMessage | null = null;

  for (let step = 0; step < agentCfg.maxIterations; step++) {
    const response = await toolModel.invoke(messages);
    const ai = response as AIMessage;
    messages.push(ai);

    const calls = ai.tool_calls;
    if (!calls?.length) {
      // No more tool calls — this is the final model output
      finalAiMessage = ai;
      break;
    }

    // Execute tools in series (parallel tool calls are rare in practice but LangChain handles it)
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      const toolCallId = call.id ?? `call_${call.name}_${step}`;
      if (!tool) {
        messages.push(new ToolMessage({ content: `Unknown tool: ${call.name}`, tool_call_id: toolCallId }));
        continue;
      }
      const out = await tool.invoke(call.args ?? {});
      messages.push(new ToolMessage({ content: String(out), tool_call_id: toolCallId }));
    }
  }

  // ─── Extract or synthesize final response ──────────────────────────────
  let output: string;

  if (synthModel && finalAiMessage) {
    // Pass the full tool conversation to the synthesis model for a clean final reply
    const synthMessages: BaseMessage[] = [
      new SystemMessage(
        `${SYSTEM_PROMPT}\n\nYou are now writing the final response to the user. The research has been completed. Synthesize the findings into a clear, concise reply under 1200 characters. Do not repeat raw JSON or tool output verbatim — interpret and summarize.`,
      ),
      ...loadMemory(identity),
      humanMsg,
      ...messages.slice(1 + loadMemory(identity).length + 1), // tool conversation
    ];
    const synthResponse = await synthModel.invoke(synthMessages);
    const synthAi = synthResponse as AIMessage;
    const c = synthAi.content;
    output =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((x) => (typeof x === 'object' && x && 'text' in x ? String((x as { text?: string }).text ?? '') : '')).filter(Boolean).join('')
          : JSON.stringify(c);
  } else if (finalAiMessage) {
    const c = finalAiMessage.content;
    output =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((x) => (typeof x === 'object' && x && 'text' in x ? String((x as { text?: string }).text ?? '') : '')).filter(Boolean).join('')
          : JSON.stringify(c);
    if (!output) output = '(no text response)';
  } else {
    output = 'Agent stopped after the maximum number of tool rounds.';
  }

  // Persist memory (store clean human + final AI text turn)
  if (finalAiMessage || output) {
    const storedAi = new AIMessage(output);
    saveMemory(identity, humanMsg, storedAi);
  }

  return { output };
}
