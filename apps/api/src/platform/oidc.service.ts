import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { CONFIG, type AppConfig } from "./config.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface OidcStart { url: string; state: string; nonce: string; verifier: string }
export interface VerifiedIdentity { sub: string; email: string; authTime: Date }

/**
 * Google OIDC for the BFF (design A6.1): Authorization Code + PKCE,
 * server-side code exchange, ID token validation including the hosted
 * domain (hd) claim.
 */
@Injectable()
export class OidcService {
  private jwks: JWTVerifyGetKey;
  fetchImpl: typeof fetch = fetch;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS));
  }

  /** Test hook: use a local key set instead of Google's. */
  useKeySet(jwks: JWTVerifyGetKey): void {
    this.jwks = jwks;
  }

  start(redirectUri: string): OidcStart {
    const state = randomBytes(16).toString("base64url");
    const nonce = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      hd: this.config.GOOGLE_HOSTED_DOMAIN ?? "",
      prompt: "select_account",
    });
    return { url: `${GOOGLE_AUTH}?${params}`, state, nonce, verifier };
  }

  async exchange(code: string, verifier: string, redirectUri: string): Promise<string> {
    const res = await this.fetchImpl(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        client_id: this.config.GOOGLE_CLIENT_ID ?? "",
        client_secret: this.config.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new Error("no id_token in token response");
    return body.id_token;
  }

  async verify(idToken: string, expectedNonce: string): Promise<VerifiedIdentity> {
    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: this.config.GOOGLE_CLIENT_ID,
      clockTolerance: 60,
    });
    if (payload.nonce !== expectedNonce) throw new Error("nonce mismatch");
    if (payload.hd !== this.config.GOOGLE_HOSTED_DOMAIN) throw new Error("account is not in the company domain");
    if (payload.email_verified !== true || typeof payload.email !== "string") throw new Error("email not verified");
    if (typeof payload.sub !== "string") throw new Error("missing sub");
    const authTime = typeof payload.auth_time === "number" ? payload.auth_time : payload.iat ?? Date.now() / 1000;
    return { sub: payload.sub, email: payload.email.toLowerCase(), authTime: new Date(authTime * 1000) };
  }
}
