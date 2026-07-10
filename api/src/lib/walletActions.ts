import { PrivyClient, type PrivyEthereumService } from '@privy-io/node';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  numberToHex,
  parseEther,
  parseUnits,
  type Address,
} from 'viem';
import { base } from 'viem/chains';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  fetchPrivyUserRecordById,
  isPrivyWalletDelegatedForAddress,
  resolveWalletForIdentity,
  type IdentityClaim,
} from './privy.js';

export type ParsedWalletCommand =
  | { kind: 'balance'; tokenAddress?: `0x${string}` }
  | { kind: 'portfolio' }
  | { kind: 'transfer'; asset: 'eth'; amount: string; recipient: `0x${string}` }
  | {
      kind: 'transfer';
      asset: 'token';
      tokenAddress: `0x${string}`;
      amount: string;
      recipient: `0x${string}`;
    };

/** Strip one or more leading @mentions (e.g. @liquidlauncher @user …). */
export function stripLeadingMentions(text: string): string {
  let s = text.trim();
  while (/^@\w+\s+/.test(s)) {
    s = s.replace(/^@\w+\s+/, '').trim();
  }
  return s;
}

/**
 * True if the user clearly asked to deploy/launch a token — whole words only.
 * Avoids matching the substring "launch" inside "liquidlauncher".
 */
export function wantsDeployIntent(lowerText: string): boolean {
  return /\bdeploy\b/.test(lowerText) || /\blaunch\b/.test(lowerText);
}

export function parseWalletCommandMessage(text: string): ParsedWalletCommand | null {
  const t = text.trim();
  if (!t) return null;
  const cleaned = stripLeadingMentions(t);

  // Natural-language balance (Farcaster/Telegram: "whats my balance?", etc.)
  const balanceNl =
    /\b(?:what\s+is|what'?s|whats)\s+my\s+balance\b/i.test(cleaned) ||
    /\bmy\s+balance\b/i.test(cleaned) ||
    /\bshow\s+(?:my\s+)?balance\b/i.test(cleaned) ||
    /\bcheck\s+(?:my\s+)?balance\b/i.test(cleaned) ||
    /\bhow\s+much\s+(?:eth|ethereum)\b/i.test(cleaned);
  if (balanceNl && !/\bdeploy\b/i.test(cleaned)) {
    const tokenM = cleaned.match(/\b(0x[a-fA-F0-9]{40})\b/i);
    if (tokenM?.[1] && isAddress(tokenM[1])) {
      return { kind: 'balance', tokenAddress: getAddress(tokenM[1]) };
    }
    return { kind: 'balance' };
  }

  const bal = /^(?:check\s+)?balance(?:\s+(0x[a-fA-F0-9]{40}))?$/i.exec(cleaned);
  if (bal) {
    const token = bal[1];
    if (!token) return { kind: 'balance' };
    if (!isAddress(token)) return null;
    return { kind: 'balance', tokenAddress: getAddress(token) };
  }

  if (
    !/\bdeploy\b/i.test(cleaned) &&
    (/^(?:portfolio|holdings|my holdings|wallet holdings)$/i.test(cleaned) ||
      /\b(?:my\s+)?portfolio\b/i.test(cleaned) ||
      /\b(?:my\s+)?holdings\b/i.test(cleaned))
  ) {
    return { kind: 'portfolio' };
  }

  // Natural ETH transfer phrasing (common on Farcaster): "send 0.005 eth to 0x…", "transfer eth 0.1 to 0x…"
  const ethNl1 = /^(?:transfer|send)\s+([0-9]*\.?[0-9]+)\s+eth\s+to\s+(0x[a-fA-F0-9]{40})\s*$/i.exec(cleaned);
  if (ethNl1?.[1] && ethNl1[2] && isAddress(ethNl1[2])) {
    return { kind: 'transfer', asset: 'eth', amount: ethNl1[1], recipient: getAddress(ethNl1[2]) };
  }
  const ethNl2 = /^(?:transfer|send)\s+eth\s+([0-9]*\.?[0-9]+)\s+to\s+(0x[a-fA-F0-9]{40})\s*$/i.exec(cleaned);
  if (ethNl2?.[1] && ethNl2[2] && isAddress(ethNl2[2])) {
    return { kind: 'transfer', asset: 'eth', amount: ethNl2[1], recipient: getAddress(ethNl2[2]) };
  }
  const ethNl3 = /^(?:transfer|send)\s+([0-9]*\.?[0-9]+)\s+eth\s+(0x[a-fA-F0-9]{40})\s*$/i.exec(cleaned);
  if (ethNl3?.[1] && ethNl3[2] && isAddress(ethNl3[2])) {
    return { kind: 'transfer', asset: 'eth', amount: ethNl3[1], recipient: getAddress(ethNl3[2]) };
  }

  const tx = /^(?:transfer|send)\s+(eth|0x[a-fA-F0-9]{40})\s+([0-9]*\.?[0-9]+)\s+(0x[a-fA-F0-9]{40})$/i.exec(cleaned);
  if (!tx) return null;

  const assetRaw = tx[1]!;
  const amount = tx[2]!;
  const recipientRaw = tx[3]!;
  if (!isAddress(recipientRaw)) return null;
  const recipient = getAddress(recipientRaw);

  if (assetRaw.toLowerCase() === 'eth') {
    return { kind: 'transfer', asset: 'eth', amount, recipient };
  }
  if (!isAddress(assetRaw)) return null;
  return {
    kind: 'transfer',
    asset: 'token',
    tokenAddress: getAddress(assetRaw),
    amount,
    recipient,
  };
}

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

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(config.baseRpcUrl),
  });
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
      logger.warn('Privy transaction poll failed (wallet actions)', { transactionId, msg });
    }
  }
  return {};
}

function formatIndexedBaseHoldingsLines(holdings: Array<{ symbol: string; amount: string; usd: number }>): string[] {
  const top = holdings.slice(0, 15);
  const totalUsd = holdings.reduce((sum, h) => sum + (Number.isFinite(h.usd) ? h.usd : 0), 0);
  const out: string[] = [
    '',
    'Base tokens (indexed):',
    `Detected: ${holdings.length} token${holdings.length === 1 ? '' : 's'} · Est. value ${shortUsd(totalUsd)}`,
  ];
  if (!top.length) {
    out.push('No other ERC-20 balances to show yet (ETH above is from the chain directly).');
  } else {
    out.push('');
    for (const h of top) {
      out.push(`• ${h.symbol}: ${shortAmount(h.amount)} (${shortUsd(h.usd)})`);
    }
    if (holdings.length > top.length) {
      out.push(`…and ${holdings.length - top.length} more. Say portfolio for the full-style report.`);
    }
  }
  return out;
}

export async function getWalletBalanceText(
  identity: IdentityClaim,
  tokenAddress?: `0x${string}`,
): Promise<string> {
  try {
    const resolved = await resolveWalletForIdentity(identity);
    const pc = getPublicClient();
    const ethWei = await pc.getBalance({ address: resolved.address as Address });
    const lines = [`Wallet: ${resolved.address}`, `Base ETH: ${formatEther(ethWei)} ETH`];

    if (tokenAddress) {
      const [bal, decimals, symbol] = await Promise.all([
        pc.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [resolved.address as Address],
        }) as Promise<bigint>,
        pc.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }) as Promise<number>,
        pc.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }) as Promise<string>,
      ]);
      lines.push(`${symbol}: ${formatUnits(bal, decimals)} ${symbol}`);
      lines.push(`Token: ${tokenAddress}`);
    } else {
      const covalentKey = (process.env.COVALENT_API_KEY || '').trim();
      if (covalentKey) {
        try {
          const holdings = await loadPortfolioFromCovalent(resolved.address);
          lines.push(...formatIndexedBaseHoldingsLines(holdings));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.warn('Indexed token list unavailable (balance)', { msg, wallet: resolved.address });
          lines.push(
            '',
            'Could not load your full token list right now. For any ERC-20 on Base, use `balance` with the token contract (0x…).',
          );
        }
      } else {
        lines.push(
          '',
          'For ERC-20 balances: use `balance` with a token contract on Base (0x…), or try `portfolio` for an all-tokens summary.',
        );
      }
    }
    return lines.join('\n');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Could not check balance: ${msg}`;
  }
}

function shortAmount(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function shortUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

async function loadPortfolioFromCovalent(walletAddress: string): Promise<Array<{ symbol: string; amount: string; usd: number }>> {
  const apiKey = (process.env.COVALENT_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('COVALENT_API_KEY is missing (required for portfolio indexing).');
  }
  const url = `https://api.covalenthq.com/v1/8453/address/${walletAddress}/balances_v2/?nft=false&no-nft-fetch=true&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Covalent HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    data?: {
      items?: Array<{
        contract_ticker_symbol?: string;
        balance?: string;
        contract_decimals?: number;
        quote?: number | null;
      }>;
    };
  };
  const items = data.data?.items ?? [];
  const mapped = items
    .map((i) => {
      const symbol = i.contract_ticker_symbol || 'TOKEN';
      const balRaw = i.balance || '0';
      const decimals = Number.isFinite(i.contract_decimals) ? Number(i.contract_decimals) : 18;
      let amount = '0';
      try {
        amount = formatUnits(BigInt(balRaw), decimals);
      } catch {
        amount = '0';
      }
      const usd = typeof i.quote === 'number' ? i.quote : 0;
      return { symbol, amount, usd };
    })
    .filter((i) => Number(i.amount) > 0 || i.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  return mapped;
}

export async function getWalletPortfolioText(identity: IdentityClaim): Promise<string> {
  try {
    const resolved = await resolveWalletForIdentity(identity);
    const holdings = await loadPortfolioFromCovalent(resolved.address);
    const top = holdings.slice(0, 12);
    const totalUsd = holdings.reduce((sum, h) => sum + (Number.isFinite(h.usd) ? h.usd : 0), 0);
    const lines = [
      `Wallet: ${resolved.address}`,
      `Detected Base holdings: ${holdings.length} tokens`,
      `Estimated value: ${shortUsd(totalUsd)}`,
    ];
    if (!top.length) {
      lines.push('No other token balances to show yet.');
    } else {
      lines.push('');
      for (const h of top) {
        lines.push(`- ${h.symbol}: ${shortAmount(h.amount)} (${shortUsd(h.usd)})`);
      }
      if (holdings.length > top.length) {
        lines.push(`…and ${holdings.length - top.length} more tokens.`);
      }
    }
    return lines.join('\n');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('getWalletPortfolioText failed', { msg });
    try {
      const resolved = await resolveWalletForIdentity(identity);
      return [
        `Wallet: ${resolved.address}`,
        '',
        'Could not load a full portfolio right now. Check one token with `balance` + Base contract (0x…).',
      ].join('\n');
    } catch {
      return 'Could not load portfolio right now. Try `balance` with a Base token contract (0x…).';
    }
  }
}

export type WalletTransferResult =
  | { ok: true; transactionHash: string; basescanUrl: string; isPendingUserOperation?: boolean }
  | { ok: false; error: string; hint?: string };

export async function executeWalletTransfer(
  identity: IdentityClaim,
  cmd: Extract<ParsedWalletCommand, { kind: 'transfer' }>,
): Promise<WalletTransferResult> {
  if (!config.privy.enabled || !config.privy.walletApiAuthorizationPrivateKey) {
    return {
      ok: false,
      error: 'Wallet transfer is not configured on this server.',
      hint: 'Set PRIVY_APP_ID, PRIVY_APP_SECRET, and PRIVY_WALLET_API_AUTHORIZATION_PRIVATE_KEY.',
    };
  }

  try {
    const resolved = await resolveWalletForIdentity(identity);
    if (!resolved.walletId) {
      return { ok: false, error: 'Could not resolve your Privy wallet id for transfers.' };
    }
    const userRecord = await fetchPrivyUserRecordById(resolved.privyUserId);
    if (!userRecord || !isPrivyWalletDelegatedForAddress(userRecord, resolved.address)) {
      return {
        ok: false,
        error: 'Wallet is not delegated for server access.',
        hint: 'Open Liquid Launcher → Wallet → Grant server access, then retry.',
      };
    }

    const pc = getPublicClient();
    let to: Address;
    let data: `0x${string}` | undefined;
    let value: bigint;

    if (cmd.asset === 'eth') {
      const amountWei = parseEther(cmd.amount);
      const bal = await pc.getBalance({ address: resolved.address as Address });
      if (bal < amountWei) {
        return {
          ok: false,
          error: `Not enough Base ETH. Need ${cmd.amount} ETH plus gas, wallet has ${formatEther(bal)} ETH.`,
        };
      }
      to = cmd.recipient;
      value = amountWei;
      data = undefined;
    } else {
      let decimals = 18;
      try {
        decimals = Number(
          await pc.readContract({ address: cmd.tokenAddress, abi: erc20Abi, functionName: 'decimals' }),
        );
      } catch {
        decimals = 18;
      }
      const [symbol, tokenBal] = await Promise.all([
        pc.readContract({ address: cmd.tokenAddress, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'token') as Promise<string>,
        pc.readContract({
          address: cmd.tokenAddress,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [resolved.address as Address],
        }) as Promise<bigint>,
      ]);
      const amountWei = parseUnits(cmd.amount, decimals);
      if (tokenBal < amountWei) {
        return {
          ok: false,
          error: `Not enough ${symbol}. Need ${cmd.amount} ${symbol}, wallet has ${formatUnits(tokenBal, decimals)} ${symbol}.`,
        };
      }
      to = cmd.tokenAddress;
      value = 0n;
      data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [cmd.recipient, amountWei],
      });
    }

    const sendInput: PrivyEthereumService.SendTransactionInput = {
      caip2: 'eip155:8453',
      params: {
        transaction: {
          to,
          ...(data ? { data } : {}),
          value: numberToHex(value),
        },
      },
      authorization_context: {
        authorization_private_keys: [config.privy.walletApiAuthorizationPrivateKey],
      },
      ...(config.privy.sponsorServerTransactions ? { sponsor: true } : {}),
    };

    const client = getPrivyClient();
    const sendRes = (await client.wallets().ethereum().sendTransaction(resolved.walletId, sendInput)) as {
      hash?: string;
      transaction_id?: string;
      user_operation_hash?: string;
    };

    let hash =
      typeof sendRes.hash === 'string' && sendRes.hash
        ? sendRes.hash
        : typeof sendRes.user_operation_hash === 'string' && sendRes.user_operation_hash
          ? sendRes.user_operation_hash
          : '';
    if (!hash) {
      return { ok: false, error: 'Privy did not return a transaction or user operation hash.' };
    }

    let isPendingUserOperation = !sendRes.hash && !!sendRes.user_operation_hash;
    if (isPendingUserOperation && sendRes.transaction_id) {
      const polled = await waitForPrivyTransactionHash(client, sendRes.transaction_id);
      if (polled.transactionHash) {
        hash = polled.transactionHash;
        isPendingUserOperation = false;
      } else if (
        polled.status === 'failed' ||
        polled.status === 'execution_reverted' ||
        polled.status === 'provider_error'
      ) {
        return {
          ok: false,
          error: `Privy transaction status: ${polled.status}.`,
          hint: 'Submission was accepted but did not finalize on-chain.',
        };
      }
    }

    const basescanUrl = isPendingUserOperation
      ? `https://basescan.org/search?f=0&q=${hash}`
      : `https://basescan.org/tx/${hash}`;
    return {
      ok: true,
      transactionHash: hash,
      basescanUrl,
      ...(isPendingUserOperation ? { isPendingUserOperation: true } : {}),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('executeWalletTransfer failed', { msg });
    return { ok: false, error: msg };
  }
}

