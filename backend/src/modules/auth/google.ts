import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { GoogleConfig } from '../../config/env.js';

/** The identity facts we use from Google's verified ID token. */
export interface GoogleProfile {
  /** Google's stable, never-reused account identifier ("sub"). */
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  /** Must equal the nonce we generated for this sign-in. */
  nonce: string | null;
}

export interface AuthUrlParams {
  state: string;
  nonce: string;
  codeChallenge: string;
}

/**
 * The small surface of Google OAuth that CampusCart depends on. The real
 * implementation talks to Google; tests substitute a fake. A fake is never
 * wired into the running server.
 */
export interface GoogleOAuthClient {
  createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }>;
  buildAuthUrl(params: AuthUrlParams): string;
  /** Exchanges the authorization code and returns the *verified* ID-token claims. */
  exchangeCode(params: { code: string; codeVerifier: string }): Promise<GoogleProfile>;
}

export function createGoogleClient(config: GoogleConfig): GoogleOAuthClient {
  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.callbackUrl,
  });

  return {
    async createPkcePair() {
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      if (!codeChallenge) throw new Error('Failed to create PKCE challenge');
      return { codeVerifier, codeChallenge };
    },

    buildAuthUrl({ state, nonce, codeChallenge }) {
      return client.generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        prompt: 'select_account',
        access_type: 'online',
      });
    },

    async exchangeCode({ code, codeVerifier }) {
      const { tokens } = await client.getToken({ code, codeVerifier });
      if (!tokens.id_token) throw new Error('Google did not return an ID token');

      // Verifies the signature against Google's keys, the audience (our client ID),
      // the issuer and the expiry. Throws if any check fails.
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) throw new Error('ID token is missing sub or email');

      return {
        subject: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
        name: payload.name ?? null,
        picture: payload.picture ?? null,
        nonce: payload.nonce ?? null,
      };
    },
  };
}
