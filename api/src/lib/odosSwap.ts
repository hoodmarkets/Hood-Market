import { logger } from '../logger.js';
import { config } from '../config.js';

const ETH_PLACEHOLDER = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export interface OdosExecutableTx {
  to: string;
  data: string;
  value: string;
}

interface OdosQuoteV3Response {
  pathId?: string;
  outAmounts?: string[];
  gasEstimate?: number;
  detail?: string;
  error?: string;
}

interface OdosAssembleResponse {
  transaction?: OdosExecutableTx;
  simulation?: { isSuccess?: boolean; simulationError?: unknown };
  detail?: string;
  error?: string;
}

function odosHeaders(): HeadersInit {
  const key = config.odos.apiKey;
  return {
    'Content-Type': 'application/json',
    ...(key ? { 'x-api-key': key } : {}),
  };
}

/**
 * Quote (v3) + assemble with simulation. Requires `ODOS_API_KEY` and Odos enterprise API access.
 * @see https://docs.odos.xyz/api/sor/quote
 * @see https://docs.odos.xyz/api/sor/assemble
 */
export async function odosQuoteAndAssemble(params: {
  chainId: number;
  userAddr: string;
  inputTokens: { tokenAddress: string; amount: string }[];
  outputTokens: { tokenAddress: string; proportion: number }[];
  slippageLimitPercent: number;
}): Promise<OdosExecutableTx> {
  if (!config.odos.enabled) {
    throw new Error('Odos is not configured (set ODOS_API_KEY).');
  }

  const quoteUrl = `${config.odos.apiBase.replace(/\/$/, '')}/sor/quote/v3`;
  const quoteBody = {
    chainId: params.chainId,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    userAddr: params.userAddr,
    slippageLimitPercent: params.slippageLimitPercent,
    compact: true,
  };

  const qRes = await fetch(quoteUrl, {
    method: 'POST',
    headers: odosHeaders(),
    body: JSON.stringify(quoteBody),
  });
  const quote = (await qRes.json()) as OdosQuoteV3Response;
  if (!qRes.ok || !quote.pathId) {
    const msg =
      typeof quote.detail === 'string'
        ? quote.detail
        : typeof quote.error === 'string'
          ? quote.error
          : `Odos quote failed (${qRes.status})`;
    throw new Error(msg);
  }

  const assembleUrl = `${config.odos.apiBase.replace(/\/$/, '')}/sor/assemble`;
  const assembleBody = {
    userAddr: params.userAddr,
    pathId: quote.pathId,
    simulate: true,
  };

  const aRes = await fetch(assembleUrl, {
    method: 'POST',
    headers: odosHeaders(),
    body: JSON.stringify(assembleBody),
  });
  const assembled = (await aRes.json()) as OdosAssembleResponse;
  if (!aRes.ok || !assembled.transaction?.to || !assembled.transaction?.data) {
    const msg =
      typeof assembled.detail === 'string'
        ? assembled.detail
        : typeof assembled.error === 'string'
          ? assembled.error
          : `Odos assemble failed (${aRes.status})`;
    throw new Error(msg);
  }

  if (assembled.simulation && assembled.simulation.isSuccess === false) {
    logger.warn('Odos assemble simulation not successful', { assembled });
    throw new Error('Odos simulation reported failure for this path.');
  }

  const tx = assembled.transaction;
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value ?? '0',
  };
}

/** Buy: spend native ETH (via placeholder) for `buyToken`. */
export async function odosBuyWithEth(params: {
  chainId: number;
  userAddr: string;
  buyToken: string;
  sellAmountWei: string;
  slippageLimitPercent?: number;
}): Promise<OdosExecutableTx> {
  return odosQuoteAndAssemble({
    chainId: params.chainId,
    userAddr: params.userAddr,
    inputTokens: [
      {
        tokenAddress: ETH_PLACEHOLDER,
        amount: params.sellAmountWei,
      },
    ],
    outputTokens: [{ tokenAddress: params.buyToken, proportion: 1 }],
    slippageLimitPercent: params.slippageLimitPercent ?? 1,
  });
}

/** Sell: ERC-20 → ETH (placeholder). */
export async function odosSellTokenForEth(params: {
  chainId: number;
  userAddr: string;
  sellToken: string;
  sellAmountWei: string;
  slippageLimitPercent?: number;
}): Promise<OdosExecutableTx> {
  return odosQuoteAndAssemble({
    chainId: params.chainId,
    userAddr: params.userAddr,
    inputTokens: [
      {
        tokenAddress: params.sellToken,
        amount: params.sellAmountWei,
      },
    ],
    outputTokens: [{ tokenAddress: ETH_PLACEHOLDER, proportion: 1 }],
    slippageLimitPercent: params.slippageLimitPercent ?? 1,
  });
}
