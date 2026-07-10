import { formatEther, getAddress, type Address, type Hex } from 'viem';
import { config } from '../config.js';
import { parseDeployBondWeiFromEnv } from './deployBondEnv.js';
import { buildAgentDeployCommitment, verifyAgentDeployCommitment } from './agentDeployCommitment.js';
import { ROBINHOOD_CHAIN_ID } from './robinhoodChain.js';
import { verifyAgentPaymentTransaction } from './agentDeployPaymentVerify.js';
import { tryReserveAgentPaymentTx } from './deploymentCatalog.js';

const BANKR_SUBMIT_URL = 'https://api.bankr.bot/wallet/submit';

export function resolveAgentDeployPaymentTreasury(): Address | null {
  const raw = config.agentDeployPayment.treasury?.trim();
  if (!raw) return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

export function agentDeployPaymentEnabled(): boolean {
  return resolveAgentDeployPaymentTreasury() !== null;
}

/** Minimum ETH the agent wallet must send on Robinhood before a paid server deploy. */
export function agentDeployPaymentMinWei(): bigint {
  return config.agentDeployPayment.minWei;
}

export type AgentDeployPaymentCommitmentInput = {
  name: string;
  symbol: string;
  agentFeeRecipient: Address;
  description: string;
  imageUrl: string;
};

export function buildAgentDeployPaymentCommitment(input: AgentDeployPaymentCommitmentInput): string {
  return buildAgentDeployCommitment(input);
}

export type AgentDeployPaymentRequiredPayload = {
  error: string;
  payment_required: true;
  paymentReason: 'agent_x_daily_limit';
  commitment: string;
  treasury: Address;
  minPaymentWei: string;
  minPaymentEth: string;
  chainId: number;
  bankrSubmitUrl: string;
  replyHint: string;
  transactions: {
    step: string;
    to: Address;
    data: Hex;
    value: Hex;
    chainId: number;
    description: string;
  }[];
  retryDeploy: {
    note: string;
    includeFields: ['deployCommitment', 'paymentTxHash'];
  };
};

export function buildAgentDeployPaymentRequiredResponse(
  input: AgentDeployPaymentCommitmentInput & { limitMessage: string; replyHint: string },
): AgentDeployPaymentRequiredPayload {
  const treasury = resolveAgentDeployPaymentTreasury();
  if (!treasury) {
    throw new Error('Agent deploy payment treasury is not configured.');
  }
  const minWei = agentDeployPaymentMinWei();
  const commitment = buildAgentDeployPaymentCommitment(input);
  const valueHex = `0x${minWei.toString(16)}` as Hex;

  return {
    error: input.limitMessage,
    payment_required: true,
    paymentReason: 'agent_x_daily_limit',
    commitment,
    treasury,
    minPaymentWei: minWei.toString(),
    minPaymentEth: formatEther(minWei),
    chainId: ROBINHOOD_CHAIN_ID,
    bankrSubmitUrl: BANKR_SUBMIT_URL,
    replyHint: input.replyHint,
    transactions: [
      {
        step: 'pay_launch_fee',
        to: treasury,
        data: '0x' as Hex,
        value: valueHex,
        chainId: ROBINHOOD_CHAIN_ID,
        description: `Pay ${formatEther(minWei)} ETH launch fee on Robinhood Chain (hood.markets)`,
      },
    ],
    retryDeploy: {
      note:
        'After payment confirms, POST the same deploy body again with deployCommitment and paymentTxHash from this response.',
      includeFields: ['deployCommitment', 'paymentTxHash'],
    },
  };
}

type PaymentVerifyClient = Parameters<typeof verifyAgentPaymentTransaction>[0]['publicClient'];

/** Verify paid agent deploy; returns reserved payment tx hash or throws. */
export async function verifyAndReserveAgentDeployPayment(params: {
  publicClient: PaymentVerifyClient;
  paymentTxHash: string;
  deployCommitment: string;
  commitmentInput: AgentDeployPaymentCommitmentInput;
}): Promise<string> {
  const treasury = resolveAgentDeployPaymentTreasury();
  if (!treasury) {
    throw new Error('Paid agent deploy is not configured (AGENT_DEPLOY_PAYMENT_TREASURY).');
  }

  if (!verifyAgentDeployCommitment(params.deployCommitment, params.commitmentInput)) {
    throw new Error('deployCommitment does not match this launch request.');
  }

  await verifyAgentPaymentTransaction({
    publicClient: params.publicClient,
    txHash: params.paymentTxHash,
    expectedFrom: params.commitmentInput.agentFeeRecipient,
    treasury,
    minValueWei: agentDeployPaymentMinWei(),
  });

  const reserved = await tryReserveAgentPaymentTx(params.paymentTxHash);
  if (!reserved) {
    throw new Error('This payment transaction was already used for a deploy.');
  }

  return params.paymentTxHash.trim();
}
