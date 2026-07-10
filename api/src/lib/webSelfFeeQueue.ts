/**
 * Serialize web deploys where `feeTarget === 'self'` per Privy user so
 * `countSelfFeeDeploymentsCurrentEasternDay` and `recordDeploymentCatalog` stay ordered
 * (avoids parallel tabs all seeing count 0).
 */
const tailByPrivyUser = new Map<string, Promise<unknown>>();

export function runAfterPriorWebSelfFeeWork<T>(privyUserId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tailByPrivyUser.get(privyUserId) ?? Promise.resolve();
  const next = prev.then(fn);
  tailByPrivyUser.set(
    privyUserId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
