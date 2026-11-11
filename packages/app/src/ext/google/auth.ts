// Google sign-in shared by the Google extensions (Drive now, Calendar later).
//
// Uses the token model of Google Identity Services: a short-lived access token
// (about an hour) requested in a Google popup. Popups open only from a user
// gesture, so code that runs on its own (autosave, polling) asks for the token
// with interactive = false and gets SignInRequired once it has expired.
// The token is kept in memory only and is never written to the document or to storage.

export interface GoogleConfig {
  clientId: string;
  /** Browser API key, restricted to the Picker API and to the app's sites. */
  apiKey: string;
  /** Google Cloud project number; the Picker grants file access to this app. */
  appId: string;
}

/**
 * Values come from the build environment (VITE_GOOGLE_*): packages/app/.env.local
 * locally, repository variables in the Pages workflow. They are not secrets, but
 * they are not kept in the repository either (decision D12).
 */
export function googleConfig(): GoogleConfig | null {
  const env = import.meta.env;
  const clientId = env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  if (!clientId) return null;
  return {
    clientId,
    apiKey: (env.VITE_GOOGLE_API_KEY as string | undefined) ?? '',
    appId: (env.VITE_GOOGLE_APP_ID as string | undefined) ?? '',
  };
}

/** Thrown when a Google call needs a sign-in that only a user action can start. */
export class SignInRequired extends Error {
  constructor() {
    super('вход в Google истёк — нажмите «Сохранить», чтобы войти снова');
    this.name = 'SignInRequired';
  }
}

const IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
const API_SCRIPT = 'https://apis.google.com/js/api.js';

const scripts = new Map<string, Promise<void>>();

export function loadScript(src: string): Promise<void> {
  let loading = scripts.get(src);
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scripts.delete(src);
        reject(new Error('не удалось загрузить сервис Google — проверьте подключение к сети'));
      };
      document.head.append(script);
    });
    scripts.set(src, loading);
  }
  return loading;
}

/**
 * Loads the sign-in script ahead of time. A popup must be requested soon after
 * the user's click; waiting for a script download first could get it blocked.
 */
export function preloadSignIn(): void {
  loadScript(IDENTITY_SCRIPT).catch(() => undefined);
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(options?: { prompt?: string }): void;
}

interface IdentityServices {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type: string; message?: string }) => void;
      }): TokenClient;
    };
  };
}

let token: { value: string; expires: number; scopes: Set<string> } | null = null;
let pending: Promise<string> | null = null;

const covers = (scopes: string[]) =>
  !!token && token.expires - 60_000 > Date.now() && scopes.every((scope) => token!.scopes.has(scope));

/**
 * An access token that covers `scopes`. With `interactive`, may open the Google
 * popup, so call it only while handling a click or a key press; without it,
 * throws SignInRequired when there is no valid token.
 */
export async function accessToken(scopes: string[], interactive: boolean): Promise<string> {
  if (covers(scopes)) return token!.value;
  if (!interactive) throw new SignInRequired();
  pending ??= requestToken(scopes).finally(() => {
    pending = null;
  });
  return pending;
}

/** Drops the token after Google rejected it; the next user action signs in again. */
export function forgetToken(): void {
  token = null;
}

async function requestToken(scopes: string[]): Promise<string> {
  const config = googleConfig();
  if (!config) throw new Error('вход в Google не настроен в этой сборке');
  await loadScript(IDENTITY_SCRIPT);
  const google = (window as unknown as { google: IdentityServices }).google;
  // Ask again for the scopes already granted so one token keeps serving every extension.
  const wanted = new Set([...(token?.scopes ?? []), ...scopes]);
  return new Promise<string>((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: [...wanted].join(' '),
      callback: (response) => {
        if (!response.access_token) {
          reject(new Error(`Google отказал во входе: ${response.error_description ?? response.error ?? 'нет токена'}`));
          return;
        }
        const granted = new Set((response.scope ?? '').split(' ').filter(Boolean));
        token = { value: response.access_token, expires: Date.now() + (response.expires_in ?? 3600) * 1000, scopes: granted };
        if (!scopes.every((scope) => granted.has(scope))) {
          reject(new Error('доступ не выдан — при входе отметьте все запрошенные разрешения'));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: (error) => {
        const reason =
          error.type === 'popup_closed'
            ? 'окно входа закрыто'
            : error.type === 'popup_failed_to_open'
              ? 'браузер заблокировал окно входа Google — разрешите всплывающие окна для этого сайта'
              : (error.message ?? error.type);
        reject(new Error(reason));
      },
    });
    client.requestAccessToken({ prompt: '' });
  });
}

/** Loads the Google Picker library. */
export async function loadPicker(): Promise<void> {
  await loadScript(API_SCRIPT);
  const gapi = (window as unknown as { gapi: { load(name: string, callback: () => void): void } }).gapi;
  await new Promise<void>((resolve) => gapi.load('picker', resolve));
}
