import { PrivyClient, type PrivyEthereumService } from '@privy-io/node';
import {
  createPublicClient,
  erc20Abi,
  http,
  numberToHex,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
  type Address,
} from 'viem';
import { robinhood, ROBINHOOD_CHAIN_ID, ROBINHOOD_EXPLORER, robinhoodTxUrl } from './robinhoodChain.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  assertBotSwapTransactionAllowed,
  assertBuyEthWithinCap,
} from './botSwapPolicy.js';
import { odosBuyWithEth, odosSellTokenForEth } from './odosSwap.js';
import {
  fetchPrivyUserRecordById,
  isPrivyWalletDelegatedForAddress,
  type IdentityClaim,
  resolveWalletForIdentity,
} from './privy.js';
import type { ParsedTradeIntent, TradeSide } from './tradeIntent.js';

const ZEROX_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CHAIN_ID = String(ROBINHOOD_CHAIN_ID);
const ZEROX_BASE = 'https://api.0x.org';

export type QuoteProvider = '0x' | 'odos';

let privyClient: PrivyClient | null = null;

function getPrivyClient(): PrivyClient {
  if (!privyClient) {
    privyClient = new PrivyClient({
      appId: config.privy.appId,
      appSecret: config.privy.appSecret,
    });
  }
  return privyClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPrivyTransactionHash(
  client: PrivyClient,
  transactionId: string,
): Promise<{ transactionHash?: string; status?: string }> {
  const delaysMs = [1000, 1000, 1500, 2000, 2500, 3000];
  for (const delayMs of delaysMs) {
    await sleep(delayMs);
    try {
      const tx = (await (client as any).transactions().get(transactionId)) as {
        status?: string;
        transaction_hash?: string;
      };
      if (typeof tx?.transaction_hash === 'string' && tx.transaction_hash) {
        return { transactionHash: tx.transaction_hash, status: tx.status };
      }
      if (tx?.status === 'failed' || tx?.status === 'execution_reverted' || tx?.status === 'provider_error') {
        return { status: tx.status };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('Privy transaction poll failed', { transactionId, msg });
    }
  }
  return {};
}

/** Privy auth key + at least one quote provider (0x or Odos). */
export function delegatedServerConfigured(): boolean {
  const basePrivy =
    config.privy.enabled && config.privy.walletApiAuthorizationPrivateKey.length > 0;
  const quoteOk = config.zeroX.enabled || config.odos.enabled;
  return basePrivy && quoteOk;
}

/** Short, Telegram-safe copy; full viem text stays in logs only. */
function userFacingSwapSimulationError(
  raw: string,
  buyEth: string,
): { error: string; hint?: string } {
  const lower = raw.toLowerCase();
  if (
    lower.includes('insufficient funds') ||
    lower.includes('exceeds the balance') ||
    lower.includes('gas * price + value')
  ) {
    return {
      error: 'Not enough Base ETH in your embedded wallet for this swap + gas.',
      hint: `This deployment buys with ${buyEth} ETH per tap (DELEGATED_SWAP_BUY_ETH). Add Base ETH to the wallet shown in Liquid Launcher, or ask the operator to lower that setting.`,
    };
  }
  const max = 450;
  const short = raw.length > max ? `${raw.slice(0, max)}…` : raw;
  return { error: `Simulation failed: ${short}` };
}

interface ZeroExQuoteTx {
  to: string;
  data: string;
  value?: string;
}

interface ZeroExQuote {
  liquidityAvailable?: boolean;
  transaction?: ZeroExQuoteTx;
  issues?: { allowance?: unknown };
  message?: string;
}

async function fetch0xQuote(params: URLSearchParams): Promise<ZeroExQuote> {
  const url = `${ZEROX_BASE}/swap/allowance-holder/quote?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      '0x-api-key': config.zeroX.apiKey,
      '0x-version': 'v2',
    },
  });
  const data = (await res.json()) as ZeroExQuote;
  if (!res.ok) {
    throw new Error(typeof data.message === 'string' ? data.message : `0x quote ${res.status}`);
  }
  return data;
}

async function simulateTx(
  from: Address,
  to: Address,
  data: `0x${string}`,
  value: bigint,
): Promise<void> {
  const pc = createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });
  await pc.call({
    to,
    data,
    value,
    account: from,
  });
}

async function build0xQuoteParams(
  side: TradeSide,
  token: Address,
  taker: Address,
  amount?: string,
): Promise<URLSearchParams> {
  if (side === 'buy') {
    const sellWei = parseEther(amount || config.delegatedSwapBuyEth);
    return new URLSearchParams({
      chainId: CHAIN_ID,
      sellToken: ZEROX_NATIVE,
      buyToken: token,
      sellAmount: sellWei.toString(),
      taker,
      slippageBps: '100',
    });
  }

  const pc = createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });
  let decimals = 18;
  try {
    decimals = Number(
      await pc.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'decimals',
      }),
    );
  } catch {
    decimals = 18;
  }
  const sellHuman = amount || config.delegatedSwapSellTokenAmount || '1';
  const sellWei = parseUnits(sellHuman, decimals);
  return new URLSearchParams({
    chainId: CHAIN_ID,
    sellToken: token,
    buyToken: ZEROX_NATIVE,
    sellAmount: sellWei.toString(),
    taker,
    slippageBps: '100',
  });
}

function resolveQuoteProvider(requested?: QuoteProvider): QuoteProvider {
  const preferred = requested ?? config.botSwap.defaultQuoteProvider;
  if (preferred === 'odos' && config.odos.enabled) return 'odos';
  if (preferred === '0x' && config.zeroX.enabled) return '0x';
  if (config.odos.enabled) return 'odos';
  if (config.zeroX.enabled) return '0x';
  return preferred;
}

export type DelegatedSwapResult =
  | {
      ok: true;
      transactionHash: string;
      basescanUrl: string;
      quoteProvider: QuoteProvider;
      isPendingUserOperation?: boolean;
    }
  | { ok: false; error: string; hint?: string };

export type DelegatedSwapPreviewResult =
  | { ok: true; summary: string; quoteProvider: QuoteProvider }
  | { ok: false; error: string; hint?: string };

type PreparedDelegatedSwap =
  | {
      ok: true;
      to: Address;
      data: `0x${string}`;
      value: bigint;
      provider: QuoteProvider;
      taker: Address;
      walletId: string;
    }
  | { ok: false; error: string; hint?: string };

/**
 * Resolve user, validate delegation, build quote (0x or Odos), enforce router/spend policy.
 * Does not simulate or broadcast.
 */
async function prepareDelegatedSwapTransaction(
  identity: IdentityClaim,
  intent: ParsedTradeIntent,
  provider: QuoteProvider,
): Promise<PreparedDelegatedSwap> {
  try {
    const resolved = await resolveWalletForIdentity(identity);
    if (!resolved.walletId) {
      return {
        ok: false,
        error:
          'Could not resolve a Privy wallet id for this account. Open the website once to finish wallet setup.',
      };
    }

    const userRecord = await fetchPrivyUserRecordById(resolved.privyUserId);
    if (!userRecord) {
      return { ok: false, error: 'Could not load Privy user.' };
    }
    if (!isPrivyWalletDelegatedForAddress(userRecord, resolved.address)) {
      return {
        ok: false,
        error: 'Wallet is not delegated for server access.',
        hint:
          'Open Liquid Launcher → Wallet → "Bot & server access" → Grant server access (Privy confirmation).',
      };
    }

    const taker = resolved.address as Address;
    const token = intent.address;
    const chainIdNum = ROBINHOOD_CHAIN_ID;
    const pc = createPublicClient({
      chain: robinhood,
      transport: http(config.chainRpcUrl),
    });

    let to: Address;
    let data: `0x${string}`;
    let value: bigint;

    if (provider === 'odos') {
      if (intent.side === 'buy') {
        const sellHuman = intent.amount || config.delegatedSwapBuyEth;
        const sellWei = parseEther(sellHuman);
        const cap = assertBuyEthWithinCap(sellWei);
        if (!cap.ok) return { ok: false, error: cap.reason };
        const ethBalance = await pc.getBalance({ address: taker });
        if (ethBalance < sellWei) {
          return {
            ok: false,
            error:
              `Not enough Base ETH in your embedded wallet. Need ${sellHuman} ETH plus gas, wallet has ${formatEther(ethBalance)} ETH.`,
            hint: 'Top up the wallet shown in Liquid Launcher, use a smaller buy amount, or trade in the browser.',
          };
        }

        const tx = await odosBuyWithEth({
          chainId: chainIdNum,
          userAddr: taker,
          buyToken: token,
          sellAmountWei: sellWei.toString(),
        });
        to = tx.to as Address;
        data = tx.data as `0x${string}`;
        value = BigInt(tx.value || '0');
      } else {
        let decimals = 18;
        try {
          decimals = Number(
            await pc.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'decimals',
            }),
          );
        } catch {
          decimals = 18;
        }
        const sellHuman = intent.amount || config.delegatedSwapSellTokenAmount || '1';
        const sellWei = parseUnits(sellHuman, decimals);
        const [tokenBalance, symbol] = await Promise.all([
          pc.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [taker],
          }) as Promise<bigint>,
          pc.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'symbol',
          }).catch(() => 'token') as Promise<string>,
        ]);
        if (tokenBalance < sellWei) {
          return {
            ok: false,
            error:
              `Not enough ${symbol} in your embedded wallet. Need ${sellHuman} ${symbol}, wallet has ${formatUnits(tokenBalance, decimals)} ${symbol}.`,
            hint: 'Use a smaller sell amount or top up that token balance first.',
          };
        }
        const tx = await odosSellTokenForEth({
          chainId: chainIdNum,
          userAddr: taker,
          sellToken: token,
          sellAmountWei: sellWei.toString(),
        });
        to = tx.to as Address;
        data = tx.data as `0x${string}`;
        value = BigInt(tx.value || '0');
      }
    } else {
      if (intent.side === 'buy') {
        const sellHuman = intent.amount || config.delegatedSwapBuyEth;
        const sellWei = parseEther(sellHuman);
        const cap = assertBuyEthWithinCap(sellWei);
        if (!cap.ok) return { ok: false, error: cap.reason };
        const ethBalance = await pc.getBalance({ address: taker });
        if (ethBalance < sellWei) {
          return {
            ok: false,
            error:
              `Not enough Base ETH in your embedded wallet. Need ${sellHuman} ETH plus gas, wallet has ${formatEther(ethBalance)} ETH.`,
            hint: 'Top up the wallet shown in Liquid Launcher, use a smaller buy amount, or trade in the browser.',
          };
        }
      } else {
        let decimals = 18;
        try {
          decimals = Number(
            await pc.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'decimals',
            }),
          );
        } catch {
          decimals = 18;
        }
        const sellHuman = intent.amount || config.delegatedSwapSellTokenAmount || '1';
        const sellWei = parseUnits(sellHuman, decimals);
        const [tokenBalance, symbol] = await Promise.all([
          pc.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [taker],
          }) as Promise<bigint>,
          pc.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'symbol',
          }).catch(() => 'token') as Promise<string>,
        ]);
        if (tokenBalance < sellWei) {
          return {
            ok: false,
            error:
              `Not enough ${symbol} in your embedded wallet. Need ${sellHuman} ${symbol}, wallet has ${formatUnits(tokenBalance, decimals)} ${symbol}.`,
            hint: 'Use a smaller sell amount or top up that token balance first.',
          };
        }
      }

      const params = await build0xQuoteParams(intent.side, token, taker, intent.amount);
      const quote = await fetch0xQuote(params);

      if (!quote.liquidityAvailable || !quote.transaction?.to || !quote.transaction?.data) {
        return { ok: false, error: 'No executable 0x quote (liquidity or amount).' };
      }
      if (quote.issues?.allowance) {
        return {
          ok: false,
          error: 'Token allowance required.',
          hint: 'Approve the swap spender once in the Liquid Launcher web app, then retry.',
        };
      }

      if (intent.side === 'buy') {
        const sellWei = parseEther(intent.amount || config.delegatedSwapBuyEth);
        const cap = assertBuyEthWithinCap(sellWei);
        if (!cap.ok) return { ok: false, error: cap.reason };
      }

      const tx = quote.transaction;
      to = tx.to as Address;
      data = tx.data as `0x${string}`;
      value = BigInt(tx.value ?? '0');
    }

    const policy = assertBotSwapTransactionAllowed({ to, data, value });
    if (!policy.ok) {
      return { ok: false, error: policy.reason };
    }

    return {
      ok: true,
      to,
      data,
      value,
      provider,
      taker,
      walletId: resolved.walletId,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('prepareDelegatedSwapTransaction', { msg });
    return { ok: false, error: msg };
  }
}

/**
 * Read-only quote + policy check + optional eth_call simulation (does not send on-chain).
 */
export async function previewDelegatedSwapQuote(
  identity: IdentityClaim,
  intent: ParsedTradeIntent,
  opts?: { quoteProvider?: QuoteProvider },
): Promise<DelegatedSwapPreviewResult> {
  if (!delegatedServerConfigured()) {
    return {
      ok: false,
      error: 'Delegated server swaps are not configured on this deployment.',
      hint:
        'Set PRIVY_WALLET_API_AUTHORIZATION_PRIVATE_KEY and at least one of: ZEROX_API_KEY, ODOS_API_KEY.',
    };
  }

  const provider = resolveQuoteProvider(opts?.quoteProvider);
  if (provider === 'odos' && !config.odos.enabled) {
    return { ok: false, error: 'Odos quotes are not configured (ODOS_API_KEY).' };
  }
  if (provider === '0x' && !config.zeroX.enabled) {
    return { ok: false, error: '0x quotes are not configured (ZEROX_API_KEY).' };
  }

  const prep = await prepareDelegatedSwapTransaction(identity, intent, provider);
  if (!prep.ok) return prep;

  let simLine: string;
  try {
    await simulateTx(prep.taker, prep.to, prep.data, prep.value);
    simLine = 'eth_call simulation: succeeded';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    simLine = `eth_call simulation: failed (${msg})`;
  }

  const buyEth = intent.amount || config.delegatedSwapBuyEth;
  const sellTok = intent.amount || config.delegatedSwapSellTokenAmount || '1';
  const summary = [
    `chain: Robinhood (${ROBINHOOD_CHAIN_ID})`,
    `side: ${intent.side}`,
    `token: ${intent.address}`,
    `buy uses ${buyEth} ETH (sell uses ${sellTok} token units, decimals resolved on-chain)`,
    `quoteProvider: ${prep.provider}`,
    `router to: ${prep.to}`,
    `msg.value (wei): ${prep.value.toString()}`,
    simLine,
  ].join('\n');

  return { ok: true, summary, quoteProvider: prep.provider };
}

/**
 * Resolve user, validate delegation, build quote (0x or Odos), enforce policies, simulate, Privy send.
 */
export async function executeBotSwap(
  identity: IdentityClaim,
  intent: ParsedTradeIntent,
  opts?: { quoteProvider?: QuoteProvider },
): Promise<DelegatedSwapResult> {
  if (!delegatedServerConfigured()) {
    return {
      ok: false,
      error: 'Delegated server swaps are not configured on this deployment.',
      hint:
        'Set PRIVY_WALLET_API_AUTHORIZATION_PRIVATE_KEY and at least one of: ZEROX_API_KEY, ODOS_API_KEY.',
    };
  }

  const provider = resolveQuoteProvider(opts?.quoteProvider);
  if (provider === 'odos' && !config.odos.enabled) {
    return { ok: false, error: 'Odos quotes are not configured (ODOS_API_KEY).' };
  }
  if (provider === '0x' && !config.zeroX.enabled) {
    return { ok: false, error: '0x quotes are not configured (ZEROX_API_KEY).' };
  }

  const prep = await prepareDelegatedSwapTransaction(identity, intent, provider);
  if (!prep.ok) {
    return { ok: false, error: prep.error, ...(prep.hint ? { hint: prep.hint } : {}) };
  }

  const { to, data, value, taker, walletId } = prep;

  try {
    try {
      await simulateTx(taker, to, data, value);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'simulation failed';
      logger.warn('Delegated swap simulation failed', { msg });
      const buyEth = intent.amount || config.delegatedSwapBuyEth;
      const uf = userFacingSwapSimulationError(msg, buyEth);
      return { ok: false, error: uf.error, ...(uf.hint ? { hint: uf.hint } : {}) };
    }

    const authKey = config.privy.walletApiAuthorizationPrivateKey;
    const client = getPrivyClient();

    const sendInput: PrivyEthereumService.SendTransactionInput = {
      caip2: `eip155:${ROBINHOOD_CHAIN_ID}`,
      params: {
        transaction: {
          to,
          data,
          value: numberToHex(value),
        },
      },
      authorization_context: {
        authorization_private_keys: [authKey],
      },
      ...(config.privy.sponsorServerTransactions ? { sponsor: true } : {}),
    };

    const sendRes = (await client.wallets().ethereum().sendTransaction(walletId, sendInput)) as {
      hash?: string;
      transaction_id?: string;
      user_operation_hash?: string;
      caip2?: string;
    };

    const hash =
      typeof sendRes.hash === 'string' && sendRes.hash
        ? sendRes.hash
        : typeof sendRes.user_operation_hash === 'string' && sendRes.user_operation_hash
          ? sendRes.user_operation_hash
          : '';
    if (!hash) {
      logger.error('Delegated swap: unexpected Privy response', { sendRes });
      return { ok: false, error: 'Privy did not return a transaction or user operation hash.' };
    }

    const isUserOp = !sendRes.hash && !!sendRes.user_operation_hash;
    let finalHash = hash;
    let finalIsUserOp = isUserOp;
    if (finalIsUserOp && sendRes.transaction_id) {
      const polled = await waitForPrivyTransactionHash(client, sendRes.transaction_id);
      if (polled.transactionHash) {
        finalHash = polled.transactionHash;
        finalIsUserOp = false;
      } else if (
        polled.status === 'failed' ||
        polled.status === 'execution_reverted' ||
        polled.status === 'provider_error'
      ) {
        return {
          ok: false,
          error: `Privy transaction status: ${polled.status}.`,
          hint: 'The smart-wallet submission was accepted but did not finalize on-chain.',
        };
      }
    }

    const basescanUrl = finalIsUserOp
      ? `${ROBINHOOD_EXPLORER}/search?f=0&q=${finalHash}`
      : robinhoodTxUrl(finalHash);
    logger.info('Delegated swap submitted', {
      hash: finalHash,
      isUserOp: finalIsUserOp,
      transactionId: sendRes.transaction_id,
      provider: prep.provider,
    });

    return {
      ok: true,
      transactionHash: finalHash,
      basescanUrl,
      quoteProvider: prep.provider,
      ...(finalIsUserOp ? { isPendingUserOperation: true } : {}),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('Delegated swap failed', { msg });
    return { ok: false, error: msg };
  }
}

/** @deprecated Use executeBotSwap — kept for call sites that only need the old name. */
export async function executeDelegatedSwapFromChat(
  identity: IdentityClaim,
  intent: ParsedTradeIntent,
): Promise<DelegatedSwapResult> {
  return executeBotSwap(identity, intent);
}

export function isDelegatedServerSwapConfigured(): boolean {
  return delegatedServerConfigured();
}

/** Agent / diagnostics: whether server swaps + this user's delegation are usable. */
export async function getDelegatedSwapReadiness(identity: IdentityClaim): Promise<{
  serverConfigured: boolean;
  delegated: boolean;
  walletAddress?: string;
  providers: { zeroX: boolean; odos: boolean };
  buyEth: string;
  sellTokenAmount: string;
  defaultQuoteProvider: string;
  detail: string;
}> {
  const base = {
    providers: { zeroX: config.zeroX.enabled, odos: config.odos.enabled },
    buyEth: config.delegatedSwapBuyEth,
    sellTokenAmount: config.delegatedSwapSellTokenAmount || '1',
    defaultQuoteProvider: config.botSwap.defaultQuoteProvider,
  };

  if (!delegatedServerConfigured()) {
    return {
      serverConfigured: false,
      delegated: false,
      ...base,
      detail:
        'Set PRIVY_WALLET_API_AUTHORIZATION_PRIVATE_KEY and at least one of ZEROX_API_KEY, ODOS_API_KEY.',
    };
  }

  try {
    const resolved = await resolveWalletForIdentity(identity);
    if (!resolved.walletId) {
      return {
        serverConfigured: true,
        delegated: false,
        ...base,
        detail: 'Could not resolve a Privy embedded wallet for this account.',
      };
    }
    const userRecord = await fetchPrivyUserRecordById(resolved.privyUserId);
    const delegated =
      !!userRecord && isPrivyWalletDelegatedForAddress(userRecord, resolved.address);
    return {
      serverConfigured: true,
      delegated,
      walletAddress: resolved.address,
      ...base,
      detail: delegated
        ? 'Wallet is delegated for server signing. Preview/execute tools may be used.'
        : 'Open Liquid Launcher → Grant server access (Privy) for this wallet.',
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      serverConfigured: true,
      delegated: false,
      ...base,
      detail: msg,
    };
  }
}
