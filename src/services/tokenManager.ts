import axios from "axios";
import https from "node:https";
import { config } from "../config";
import Logger from "../utils/logger";

// Shared HTTPS keep-alive agent so repeated OAuth token requests reuse the
// same TLS connection to the ServiceNow instance.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface CachedToken {
  value: string;
  expiresAtEpochMs: number;
}

type TokenAuthStyle = "auto" | "request_body" | "basic";
type GrantType = "auto" | "password" | "client_credentials";

export class TokenManager {
  private cachedToken?: CachedToken;
  // Single-flight guard: when a token request is already in flight, parallel
  // callers await the same promise instead of stampeding the OAuth endpoint
  // (which both wastes throughput and risks per-IP throttling on cold start).
  private inFlight?: Promise<string>;

  private formatTokenRequestError(error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error.message : "unknown token request error";
    }

    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const responseData = error.response?.data;
    const oauthError = typeof responseData === "object" && responseData !== null
      ? (responseData as Record<string, unknown>).error
      : undefined;
    const oauthDescription = typeof responseData === "object" && responseData !== null
      ? (responseData as Record<string, unknown>).error_description
      : undefined;

    const oauthBits = [oauthError, oauthDescription]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join(": ");

    if (status) {
      return oauthBits
        ? `HTTP ${status}${statusText ? ` ${statusText}` : ""} (${oauthBits})`
        : `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
    }

    return oauthBits || error.message || "request failed without response";
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAtEpochMs) {
      Logger.debug("Using cached ServiceNow access token", {
        operation: "token.get_cached",
        expiresInMs: this.cachedToken.expiresAtEpochMs - Date.now()
      });
      return this.cachedToken.value;
    }

    // Coalesce concurrent acquisitions into a single in-flight request.
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.acquireToken().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async acquireToken(): Promise<string> {
    const tokenUrl = new URL(config.serviceNow.tokenPath, config.serviceNow.instanceUrl).toString();
    const configuredGrant = (config.serviceNow.grantType || "auto") as GrantType;
    const hasCredentials = !!(config.serviceNow.username && config.serviceNow.password);

    // Determine which grant type(s) to try.
    // "auto": prefer password grant when username/password are provided (works with the
    //         standard ServiceNow App Registry without any extra system properties);
    //         fall back to client_credentials otherwise.
    const grantsToTry: Array<Exclude<GrantType, "auto">> =
      configuredGrant === "password"
        ? ["password"]
        : configuredGrant === "client_credentials"
          ? ["client_credentials"]
          : hasCredentials
            ? ["password"]
            : ["client_credentials"];

    const configuredStyle = (config.serviceNow.tokenAuthStyle || "auto") as TokenAuthStyle;
    const stylesToTry: Array<Exclude<TokenAuthStyle, "auto">> =
      configuredStyle === "request_body"
        ? ["request_body"]
        : configuredStyle === "basic"
          ? ["basic"]
          : ["request_body", "basic"];

    Logger.debug("Acquiring ServiceNow access token", {
      operation: "token.acquire",
      grantsToTry: grantsToTry.join(","),
      stylesToTry: stylesToTry.join(",")
    });

    let response: { data: OAuthTokenResponse } | undefined;
    let lastError: Error | undefined;
    let lastErrorMessage = "";

    outer: for (const grant of grantsToTry) {
      for (const style of stylesToTry) {
        try {
          Logger.debug("Attempting token request", {
            operation: "token.request_attempt",
            grant,
            style
          });
          response = await this.requestToken(tokenUrl, grant, style);
          Logger.info("ServiceNow token acquired successfully", {
            operation: "token.acquired",
            grant,
            style,
            expiresIn: response.data.expires_in
          });
          break outer;
        } catch (error) {
          const errorMsg = this.formatTokenRequestError(error);
          lastErrorMessage = `${grant}/${style}: ${errorMsg}`;
          lastError = error instanceof Error ? error : new Error(errorMsg);
          Logger.warn("Token request failed", {
            operation: "token.request_failed",
            grant,
            style,
            error: errorMsg
          });
        }
      }
    }

    if (!response) {
      const message = `Unable to acquire ServiceNow OAuth token after trying configured grant/auth styles. Last failure: ${lastErrorMessage || "unknown error"}`;
      Logger.error("ServiceNow token acquisition failed", {
        operation: "token.acquisition_failed",
        grantsAttempted: grantsToTry.join(","),
        stylesAttempted: stylesToTry.join(",")
      }, lastError);
      throw new Error(message);
    }

    const expiresInMs = Math.max(30, response.data.expires_in - 30) * 1000;
    this.cachedToken = {
      value: response.data.access_token,
      expiresAtEpochMs: Date.now() + expiresInMs
    };

    return this.cachedToken.value;
  }

  private async requestToken(
    tokenUrl: string,
    grant: "password" | "client_credentials",
    style: "request_body" | "basic"
  ) {
    const params: Record<string, string> = { grant_type: grant };

    if (grant === "password") {
      if (!config.serviceNow.username || !config.serviceNow.password) {
        throw new Error(
          "SERVICENOW_USERNAME and SERVICENOW_PASSWORD are required for the password grant type"
        );
      }
      params.username = config.serviceNow.username;
      params.password = config.serviceNow.password;
    }

    if (style === "request_body") {
      params.client_id = config.serviceNow.clientId;
      params.client_secret = config.serviceNow.clientSecret;
    }

    const payload = new URLSearchParams(params);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded"
    };

    if (style === "basic") {
      const basic = Buffer.from(
        `${config.serviceNow.clientId}:${config.serviceNow.clientSecret}`
      ).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    }

    return axios.post<OAuthTokenResponse>(tokenUrl, payload.toString(), {
      headers,
      timeout: 10_000,
      httpsAgent: keepAliveAgent
    });
  }
}
