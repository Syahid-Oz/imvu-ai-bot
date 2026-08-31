/**
 * Single configuration source for the IMVU AI bot.
 *
 * Every configurable value is read here exactly once from the environment
 * (.env). No room id, credential or token is hard-coded anywhere else.
 */
import * as dotenv from 'dotenv';

dotenv.config();

export interface BotConfig {
	/** IMVU account username (from .env, never logged). */
	username: string;
	/** IMVU account password (from .env, never logged). */
	password: string;
	/** Optional TOTP/2FA code if the account requires it. */
	twoFactorCode?: string;

	/** The ONLY room this bot connects to. */
	roomId: string;
	/** IMQ websocket endpoint. */
	imqUrl: string;

	/** AI API key (never sent to IMVU, never logged). */
	aiApiKey?: string;
	/** OpenAI-compatible base URL. */
	aiBaseUrl: string;
	/** Model name. */
	aiModel: string;

	/** Bot display name; also the name users must mention to trigger a reply. */
	botName: string;

	/** Owner name for users who need help (from .env). */
	ownerName: string;
	/** Owner IMVU ID (optional). */
	ownerId: string;

	/** Enable auto-reply to private/inbox messages. */
	autoReplyInbox: boolean;
	/** Enable auto-accept friend requests. */
	autoAcceptFriends: boolean;

	/** IMVU chat message length limit. */
	maxReplyLength: number;
	/** Minimum time between replies to the same user (ms). */
	minReplyIntervalMs: number;
	/** Global reply budget per minute. */
	globalRepliesPerMinute: number;
	/** Conversation turns kept per user. */
	historyTurns: number;
}

export class ConfigError extends Error {}

export function getConfig(): BotConfig {
	const username = process.env.IMVU_USERNAME?.trim() ?? '';
	const password = process.env.IMVU_PASSWORD ?? '';

	// IMVU_ROOM_ID is the primary name; IMQ_ROOM_ID is kept as a legacy alias.
	const roomId = (process.env.IMVU_ROOM_ID || process.env.IMQ_ROOM_ID || '').trim();

	// AI_API_KEY is the primary name; OPENAI_API_KEY is kept as a legacy alias.
	const aiApiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;

	if (!username) {
		throw new ConfigError('IMVU_USERNAME is not set in .env');
	}
	if (!password) {
		throw new ConfigError('IMVU_PASSWORD is not set in .env');
	}
	if (!roomId) {
		throw new ConfigError('IMVU_ROOM_ID is not set in .env');
	}

	return {
		username,
		password,
		twoFactorCode: process.env.IMVU_2FA_CODE?.trim() || undefined,

		roomId,
		imqUrl:
			process.env.IMQ_URL?.trim() || 'wss://imq.imvu.com:444/streaming/imvu_pre',

		aiApiKey,
		aiBaseUrl: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
		aiModel: process.env.AI_MODEL || 'gpt-4o-mini',

		botName: process.env.BOT_NAME?.trim() || 'Shirah',

		ownerName: process.env.OWNER_NAME?.trim() || '4imie',
		ownerId: process.env.OWNER_ID?.trim() || '',

		autoReplyInbox: process.env.AUTO_REPLY_INBOX?.trim().toLowerCase() !== 'false',
		autoAcceptFriends: process.env.AUTO_ACCEPT_FRIENDS?.trim().toLowerCase() !== 'false',

		maxReplyLength: 500, // IMVU chat limit
		minReplyIntervalMs: 5000, // per-user rate limit
		globalRepliesPerMinute: 6,
		historyTurns: 10, // conversation turns kept per user
	};
}

/** True when an AI API key is configured. */
export function hasAi(config: BotConfig = getConfig()): boolean {
	return Boolean(config.aiApiKey);
}
