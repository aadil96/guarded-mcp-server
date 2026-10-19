/** Server-side approvals configuration. Read once at startup; never taken from request input. */
export type ApprovalsConfig = Readonly<{ singleOperator: boolean }>;

export const defaultApprovalsConfig: ApprovalsConfig = Object.freeze({ singleOperator: false });

/**
 * APPROVALS_SINGLE_OPERATOR=true lets a lone local developer approve their own requests.
 * It is refused outright in production so a misconfigured deploy fails to start instead of
 * silently dropping the two-person rule.
 */
export function loadApprovalsConfig(env: Record<string, string | undefined> = process.env): ApprovalsConfig {
  const raw = env.APPROVALS_SINGLE_OPERATOR;
  if (raw !== undefined && raw !== '' && raw !== 'true' && raw !== 'false') {
    throw new Error(`APPROVALS_SINGLE_OPERATOR must be "true" or "false", got ${JSON.stringify(raw)}`);
  }
  const singleOperator = raw === 'true';
  if (singleOperator && env.NODE_ENV === 'production') {
    throw new Error('APPROVALS_SINGLE_OPERATOR=true is not allowed when NODE_ENV=production');
  }
  return Object.freeze({ singleOperator });
}
