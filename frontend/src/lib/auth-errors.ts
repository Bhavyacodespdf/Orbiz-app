/** Plain-language explanations for the error codes the sign-in flow can return. */
const messages: Record<string, string> = {
  GOOGLE_NOT_CONFIGURED:
    'Google sign-in is not set up on this server yet. An administrator needs to add the Google OAuth credentials.',
  GOOGLE_CANCELLED: 'Sign-in was cancelled. You can try again whenever you’re ready.',
  OAUTH_STATE_INVALID:
    'That sign-in link expired or was already used. Please start signing in again from this page.',
  GOOGLE_VERIFICATION_FAILED: 'We couldn’t verify your Google sign-in. Please try again.',
  EMAIL_CONFLICT:
    'Another CampusCart account already uses this email address, so this sign-in was not linked to it. Sign in with the account you used before.',
  ACCOUNT_SUSPENDED: 'This account has been suspended. Contact the CampusCart administrator.',
  EMAIL_DOMAIN_NOT_ALLOWED:
    'CampusCart is only open to college accounts. Sign in with your college email address.',
  RATE_LIMITED: 'Too many sign-in attempts. Please wait a few minutes and try again.',
};

export function describeAuthError(code: string | null): string | null {
  if (!code) return null;
  return messages[code] ?? 'Sign-in failed. Please try again.';
}
