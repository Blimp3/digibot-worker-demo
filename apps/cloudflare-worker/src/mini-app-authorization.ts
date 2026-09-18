import type { AuthenticatedMiniAppUser } from "./mini-app-auth";
import type { MiniAppDefinition } from "./mini-app-router";

/** Identity plus the one app it is authorized to use. */
type AuthorizedMiniAppIdentity = Readonly<{ userId: string; authDate: number }>;
export type AuthorizedMiniAppPrincipal = AuthorizedMiniAppIdentity & Readonly<{ appId: "downloader" }>;

/**
 * Authentication is shared, authorization is not. Adding an app to the
 * registry must add an explicit policy branch here; downloader access never
 * implicitly grants a future app access.
 */
export function authorizeMiniAppUser(
  app: MiniAppDefinition,
  user: AuthenticatedMiniAppUser,
): AuthorizedMiniAppPrincipal | null {
  if (app.id === "downloader" && app.authorizationPolicy === "downloader-owner") {
    return Object.freeze({ appId: "downloader", userId: user.userId, authDate: user.authDate });
  }
  return null;
}
