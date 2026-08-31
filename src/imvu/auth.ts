/**
 * IMVU account authentication using the real @imvu/client library
 * (https://api.imvu.com). No tokens are fabricated: the library performs the
 * official username/password login, persists session cookies to cookies.json
 * (which .gitignore already excludes), and derives the per-request "sauce"
 * token from /login/me.
 */
import { Client } from '../../packages/client/src/client/Client';

export interface ImvuAccount {
	/** The authenticated IMVU username. */
	username: string;
	/** The IMVU user id (public). */
	id: string;
	/** Legacy numeric cid used by the IMQ realtime service as user_id. */
	legacyCid: string;
	/** Session identifier used as the IMQ connect cookie (never logged). */
	sessionId: string;
	/** The authenticated API client. */
	client: Client;
}

export class AuthError extends Error {}

/**
 * Maps internal/login errors to messages that are safe to display
 * (no passwords, tokens or cookies are included).
 */
function sanitizeLoginError(error: unknown): AuthError {
	const raw = error instanceof Error ? error.message : String(error);

	const lower = raw.toLowerCase();

	if (lower.includes('invalid') && (lower.includes('password') || lower.includes('username'))) {
		return new AuthError('Invalid IMVU username or password');
	}
	if (lower.includes('2fa') || lower.includes('two-factor') || lower.includes('totp') || lower.includes('verification code')) {
		return new AuthError(
			'This account requires a two-factor code. Set IMVU_2FA_CODE in .env (code is single-use).'
		);
	}
	if (lower.includes('econn') || lower.includes('network') || lower.includes('timeout') || lower.includes('getaddrinfo')) {
		return new AuthError('Network error while contacting IMVU (check your internet connection)');
	}
	if (lower.includes('blocked') || lower.includes('locked') || lower.includes('suspended')) {
		return new AuthError('IMVU rejected the login (account blocked/locked or security hold)');
	}

	// Generic fallback - the raw message could contain anything, so only
	// expose a short stable prefix.
	return new AuthError(`IMVU authentication failed (${raw.slice(0, 80)})`);
}

/**
 * Fetch the raw denormalized resource data for a URL via the public client
 * request API.
 */
async function rawResource(client: Client, url: string): Promise<Record<string, any>> {
	const response = await client.request(url);
	const resource = response.denormalized[response.id];
	return (resource?.data ?? {}) as Record<string, any>;
}

/**
 * Log in with the configured IMVU account and resolve everything the IMQ
 * realtime layer needs:
 *   - the user id / legacy cid used as IMQ `user_id`
 *   - the session id used as IMQ `cookie`
 */
export async function login(username: string, password: string, twoFactorCode?: string): Promise<ImvuAccount> {
	const client = new Client();

	try {
		await client.login(username, password, twoFactorCode ? { twoFactorCode } : {});
	} catch (error) {
		throw sanitizeLoginError(error);
	}

	const account = client.account;
	const id = String(account.user.id);

	// The IMQ gateway expects the legacy numeric cid as user_id. The raw
	// /user response contains it; fall back to the account id when absent.
	let legacyCid = id;
	try {
		const user = await rawResource(client, `/user/user-${id}`);
		const candidate = user.legacy_cid ?? user.cid;
		if (candidate !== undefined && candidate !== null && String(candidate) !== '') {
			legacyCid = String(candidate);
		}
	} catch {
		// Keep the account id - it is the same value for most accounts.
	}

	// /login/me exposes the session id used by the IMQ handshake. The
	// Login resource in @imvu/client documents this field (session_id).
	let sessionId = '';
	try {
		const me = await rawResource(client, '/login/me');
		sessionId = String(me.session_id ?? '');
	} catch {
		// fall through to the cookie jar
	}

	if (!sessionId) {
		const cookies = await client.cookies.getCookies('https://imvu.com/');
		const sessionCookie =
			cookies.find((c) => c.key === '_imvu_session') ?? cookies.find((c) => c.key === 'osCsid');
		sessionId = sessionCookie?.value ?? '';
	}

	if (!sessionId) {
		throw new AuthError('IMVU authenticated but no session id was returned by IMVU');
	}

	return {
		username: account.username || username,
		id,
		legacyCid,
		sessionId,
		client,
	};
}

/**
 * Clear the in-memory session. Persistent cookies are intentionally kept so
 * the next start can reuse the session (cookies.json is git-ignored).
 */
export async function logout(account: ImvuAccount | null): Promise<void> {
	if (!account) {
		return;
	}

	try {
		await account.client.logout();
	} catch {
		// logout is best-effort
	}
}
