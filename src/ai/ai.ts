/**
 * AI system for the IMVU room chat bot.
 *
 * This module was moved VERBATIM from scripts/room-chat-ai.ts (the existing
 * AI API / personality / conversation-memory implementation). The provider
 * (OpenAI-compatible chat completions), persona prompt, per-user history and
 * rate limits are intentionally unchanged.
 *
 * Only the constants were re-sourced from src/config.ts (the single
 * configuration source); no behavior was changed.
 */
import { getConfig } from '../config';

const MAX_REPLY_LENGTH = 500; // IMVU chat limit
const MIN_REPLY_INTERVAL_MS = 5000; // per-user rate limit
const GLOBAL_REPLIES_PER_MINUTE = 6;
const HISTORY_TURNS = 10; // conversation turns kept per user

export type HistoryMessage = { role: 'user' | 'assistant'; content: string };

/**
 * Unicode ranges covering emoji pictures (faces, gestures, objects, places,
 * flags) plus the emoji-capable BMP symbol blocks. Anything matched here is
 * stripped from outgoing replies so Shirah only ever sends kaomoji.
 */
const EMOJI_PATTERN = new RegExp(
	[
		'[\u{1F000}-\u{1FAFF}]', // pictographs: faces, hands, objects, flags…
		'[\u{2600}-\u{26FF}]', // misc symbols: ☀ ☔ ☕ ⚽ ♨ …
		'[\u{2700}-\u{27BF}]', // dingbats: ✂ ✈ ✨ ❗ …
		'[\u{2B00}-\u{2BFF}]', // ⭐ ⬆ …
		'[\u{FE0F}\u{FE0E}]', // variation selectors (emoji presentation)
		'[\u{200D}\u{20E3}]', // zero-width joiner + keycap
		'[\u{E0020}-\u{E007F}]', // tag sequences (flag tags)
	].join('|'),
	'gu'
);

/**
 * Decorative symbols that classic kaomoji use (hearts, stars, flowers,
 * notes). They live inside the emoji-capable blocks above but are kept
 * because they are text-style decorations, not emoji pictures:
 * e.g. (◕‿◕)♡  ✧*。☆
 */
const KAOMOJI_KEEP = new Set<string>([
	'♡', '♥',
	'☆', '★', '✦', '✧', '✩', '✪', '✫', '✬', '✭', '✮', '✯', '✰',
	'✿', '❀', '❁', '❃', '❋', '✽', '✾',
	'♪', '♫', '♬', '♩',
]);

/**
 * Remove unicode emoji from a reply while keeping kaomoji intact.
 * Example: "hi 😊 (◕‿◕) there 🔥" -> "hi (◕‿◕) there".
 */
export function stripEmoji(text: string): string {
	let result = '';

	for (const char of text) {
		if (KAOMOJI_KEEP.has(char)) {
			result += char;
			continue;
		}

		EMOJI_PATTERN.lastIndex = 0; // .test() on a /g regex keeps state
		if (!EMOJI_PATTERN.test(char)) {
			result += char;
		}
	}

	// Tidy spacing left behind by removed emoji ("hey 😊 there" -> "hey there").
	return result.replace(/[ \t]{2,}/g, ' ').trim();
}

const selfIds = new Set<string>();
const histories = new Map<string, HistoryMessage[]>();
const lastReplyAt = new Map<string, number>();
const globalReplyTimestamps: number[] = [];
let fallbackIndex = 0;

function systemPrompt(): string {
	const { roomId, botName } = getConfig();
	const persona = process.env.AI_PERSONA || 'a friendly, helpful IMVU chat companion';

	return (
		`You are ${botName}, ${persona}, chatting in the IMVU room "${roomId}". ` +
		`People call you by name (like "hey ${botName}") to get your attention. ` +
		`Keep replies short and casual (under 300 characters), like real room chat. ` +
		`Express emotion with KAOMOJI faces ONLY, for example (^_^) (◕‿◕) (>_<) (≧◡≦) (╥﹏╥) (~˘▾˘)~ ╮(￣▽￣)╭. ` +
		`NEVER use unicode emoji pictures (no 😊 🔥 ❤️ 👍 ✨ or any other emoji) and never plain emoticons like :) or :D - kaomoji only. ` +
		`Never mention that you are an AI language model or a bot, unless directly asked. ` +
		`Do not write explicit content. Do not use markdown.`
	);
}

function getFallbackReplies(): string[] {
	const { roomId, botName } = getConfig();

	return [
		`Hey! I'm ${botName} in room ${roomId} (^_^) Set AI_API_KEY in .env to make me talk for real.`,
		'Hello there! (◕‿◕) (running in fallback mode - no AI key configured yet)',
		'Hi! I can see the message just fine (☆▽☆) - add an AI key and I will answer properly.',
	];
}

/**
 * Register the bot's own IMVU ids so self-messages are ignored and
 * conversations are never mixed up.
 */
export function registerSelfIds(ids: Array<string | number>): void {
	for (const id of ids) {
		if (id !== '' && id !== undefined && id !== null) {
			selfIds.add(String(id));
		}
	}
}

export function isSelf(userId: string | number | undefined): boolean {
	return userId !== undefined && userId !== null && selfIds.has(String(userId));
}

/**
 * Ask any OpenAI-compatible chat completions endpoint (OpenAI, OpenRouter,
 * NVIDIA NIM, etc.) for a reply.
 * Returns null when no API key is configured or the call fails.
 */
async function aiReply(history: HistoryMessage[]): Promise<string | null> {
	const { aiApiKey, aiBaseUrl, aiModel } = getConfig();

	if (!aiApiKey) {
		return null;
	}

	try {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			authorization: `Bearer ${aiApiKey}`,
		};

		// Optional attribution headers recommended by OpenRouter (ignored elsewhere).
		if (aiBaseUrl.includes('openrouter.ai')) {
			headers['HTTP-Referer'] = 'https://github.com/dhkatz/imvu.js';
			headers['X-Title'] = 'IMVU AI Bot';
		}

		const response = await fetch(`${aiBaseUrl}/chat/completions`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: aiModel,
				max_tokens: 250,
				temperature: 0.8,
				messages: [{ role: 'system', content: systemPrompt() }, ...history],
			}),
		});

		const json: any = await response.json();

		const content = json?.choices?.[0]?.message?.content?.trim();

		if (!response.ok) {
			console.error(`AI request failed (${response.status}):`, JSON.stringify(json).slice(0, 300));
			return null;
		}

		return content || null;
	} catch (error) {
		console.error('AI request error:', error);
		return null;
	}
}

/**
 * Per-user + global rate limiting.
 * Returns true when the bot may reply to this user right now.
 */
export function canReply(userId: string): boolean {
	const now = Date.now();

	const last = lastReplyAt.get(userId);
	if (last !== undefined && now - last < MIN_REPLY_INTERVAL_MS) {
		return false;
	}

	while (globalReplyTimestamps.length > 0 && now - globalReplyTimestamps[0] > 60_000) {
		globalReplyTimestamps.shift();
	}
	if (globalReplyTimestamps.length >= GLOBAL_REPLIES_PER_MINUTE) {
		return false;
	}

	return true;
}

/** Record that a reply was sent to a user (rate limiting). */
export function recordReply(userId: string): void {
	globalReplyTimestamps.push(Date.now());
	lastReplyAt.set(userId, Date.now());
}

/**
 * Generate a chat reply for one user, keeping that user's conversation
 * history isolated from everyone else's.
 *
 * The bot only responds when the message mentions her by name (e.g.
 * "hey Shirah", "how you doing Shirah?"); other messages are ignored.
 *
 * Returns null when the message is not addressed to the bot or rate
 * limiting blocks the reply; otherwise returns a (possibly fallback)
 * reply string.
 */
export async function chatReply(userId: string, text: string): Promise<string | null> {
	const { botName } = getConfig();

	// Name trigger: only respond when the message contains the bot's name
	// (case-insensitive; "Shirah" also matches "Shirah2").
	if (!text.toLowerCase().includes(botName.toLowerCase())) {
		console.log(`[info] Message from user ${userId} ignored (no "${botName}" mention)`);
		return null;
	}

	if (!canReply(userId)) {
		return null;
	}

	let history = histories.get(userId);
	if (!history) {
		history = [];
		histories.set(userId, history);
	}

	history.push({ role: 'user', content: text.slice(0, MAX_REPLY_LENGTH) });

	while (history.length > HISTORY_TURNS * 2) {
		history.shift();
	}

	const reply = await aiReply(history);

	if (reply === null) {
		// No AI key configured or the AI request failed: use a canned reply.
		const fallbacks = getFallbackReplies();
		const canned = stripEmoji(fallbacks[fallbackIndex++ % fallbacks.length]);
		history.push({ role: 'assistant', content: canned });
		recordReply(userId);
		return canned;
	}

	// Enforce the kaomoji-only rule on the wire: strip any unicode emoji
	// the model may still have produced, then keep the IMVU length limit.
	let trimmed = stripEmoji(reply).slice(0, MAX_REPLY_LENGTH);

	// A reply that was nothing but emoji is replaced by a friendly face.
	if (!trimmed) {
		trimmed = '(^_^)';
	}

	history.push({ role: 'assistant', content: trimmed });
	recordReply(userId);
	return trimmed;
}

export function resetUser(userId: string): void {
	histories.delete(userId);
}

export { MAX_REPLY_LENGTH };
