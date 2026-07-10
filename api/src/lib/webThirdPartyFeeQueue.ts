/**
 * Serialize web deploys where fees go to a third-party wallet so
 * `countThirdPartyFeeRecipientDeploymentsRollingHours` and `recordDeploymentCatalog` stay ordered
 * (avoids parallel tabs racing on the same fee address).
 */
const tailByFeeWallet = new Map<string, Promise<unknown>>();

export function runAfterPriorWebThirdPartyFeeWork<T>(
  feeWalletAddress: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = feeWalletAddress.trim().toLowerCase();
  const prev = tailByFeeWallet.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  tailByFeeWallet.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
