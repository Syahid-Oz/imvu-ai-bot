/**
 * IMVU AI Bot - entry point.
 *
 * Flow:
 *   authenticate IMVU account -> connect IMQ realtime -> enter configured
 *   room -> enable existing AI chatbot -> relay room messages to the AI and
 *   back.
 *
 * Features:
 *   - Auto-reply room chat (mention-based)
 *   - Auto-reply to inbox/private messages
 *   - Auto-accept friend requests
 *   - 24/7 keep-alive with automatic reconnection
 *
 * Run with: npm start
 */
import 'reflect-metadata';
import * as readline from 'readline';

import { getConfig, hasAi, ConfigError, BotConfig } from './config';
import { login, logout, ImvuAccount, AuthError } from './imvu/auth';
import { RoomConnection } from './imvu/room';
import { onRoomMessage, onUserJoined, sendRoomMessage, observeRoomEvent } from './imvu/chat';
import { chatReply, registerSelfIds } from './ai/ai';
import { FriendRequestManager, createFriendRequestManager } from './imvu/friendRequests';
import { registerBotSelfId, onPrivateMessage, handlePrivateMessage } from './imvu/messages';
import { IMQMessageMount } from '../packages/imq/src/message/IMQMessageMount';

let account: ImvuAccount | null = null;
let room: RoomConnection | null = null;
let chatbotEnabled = false;
let booted = false;
let friendManager: FriendRequestManager | null = null;
let inboxMount: IMQMessageMount | null = null;

// --- Welcomes -------------------------------------------------------------
// Right after (re)subscribing, the server sends a BURST of "joined" updates
// for everybody already in the room; welcoming all of them would be spam, so
// joins are ignored during this settling window after every (re)connect.
// (Live observation: the burst arrives within ~1-2 seconds of subscribing.)
const WELCOME_SETTLE_MS = 5_000;
const WELCOME_MIN_INTERVAL_MS = 10_000; // minimum gap between two welcomes
const WELCOME_MAX_PER_MINUTE = 3; // global welcome budget

type Indicator = 'connected' | 'disconnected' | 'off' | 'enabled' | 'fallback';

/**
 * Set up inbox/private message handling by subscribing to the user's messages
 * queue and wiring up the auto-reply handler.
 */
async function setupInboxHandling(
	account: ImvuAccount,
	config: BotConfig,
	room: RoomConnection
): Promise<void> {
	// Register the bot's own ID to filter out self-messages
	registerBotSelfId(account.legacyCid);

	// Discover the user's messages queue via the IMVU API
	// The user resource typically advertises the messages queue
	let messagesQueue = '';
	let messagesMount = 'messages';

	try {
		const user = await account.client.request(`/user/user-${account.id}`);
		const userData = user.denormalized[user.id]?.data as Record<string, any> | undefined;

		messagesQueue = String(userData?.imq_queue ?? userData?.messages_queue ?? '');
		messagesMount = String(userData?.imq_messages_mount ?? userData?.messages_mount ?? 'messages');

		if (!messagesQueue) {
			// Fallback to a standard pattern if not advertised
			messagesQueue = `/user/user-${account.id}/messages`;
		}
	} catch (error) {
		console.error(`[WARN] Could not discover messages queue: ${String(error).slice(0, 120)}`);
		// Use fallback pattern
		messagesQueue = `/user/user-${account.id}/messages`;
	}

	console.log(`[INFO] Subscribing to inbox queue: ${messagesQueue}`);

	// Subscribe to the messages queue using the room's IMQ manager
	const mount = await new Promise<IMQMessageMount>((resolve, reject) => {
		room.manager.subscribeMessage(
			messagesQueue,
			messagesMount,
			(error: unknown, result: IMQMessageMount) => {
				if (error) {
					reject(new Error(`Could not subscribe to inbox: ${error}`));
				} else {
					resolve(result);
				}
			}
		);
	});

	inboxMount = mount;

	// Wire up the private message handler
	onPrivateMessage(mount, async (message) => {
		if (!chatbotEnabled) {
			return;
		}

		console.log(`[INBOX] Message from ${message.userId}: ${message.text.slice(0, 60)}${message.text.length > 60 ? '...' : ''}`);

		try {
			await handlePrivateMessage(mount, message);
		} catch (error) {
			console.error(`[ERROR] Failed to handle inbox message: ${String(error).slice(0, 120)}`);
		}
	});

	console.log('[✓] Inbox message listener attached');
}

function indicatorSymbol(state: Indicator): string {
	switch (state) {
		case 'connected':
		case 'enabled':
			return '\u{1F7E2}'; // green circle
		case 'fallback':
			return '\u{1F7E1}'; // yellow circle
		default:
			return '\u{1F534}'; // red circle
	}
}

function statusPanel(): void {
	if (!account) {
		console.log(
			[
				'\u2554' + '\u2550'.repeat(30) + '\u2557',
				'\u2551' + '       IMVU AI BOT'.padEnd(30) + '\u2551',
				'\u2560' + '\u2550'.repeat(30) + '\u2563',
				'\u2551 Status: Disconnected'.padEnd(31) + '\u2551',
				'\u255A' + '\u2550'.repeat(30) + '\u255D',
			].join('\n')
		);
		return;
	}

	const config = getConfig();
	const roomConnected = room?.status === 'connected';
	const line = (label: string, value: string) => `\u2551 ${(label + value).padEnd(29)}\u2551`;

	console.log(
		[
			'\u2554' + '\u2550'.repeat(30) + '\u2557',
			'\u2551' + '       IMVU AI BOT'.padEnd(30) + '\u2551',
			'\u2560' + '\u2550'.repeat(30) + '\u2563',
			line('Account: ', account.username),
			line('IMVU ID: ', account.id),
			line('Room: ', config.roomId),
			'\u2551' + ''.padEnd(30) + '\u2551',
			line('IMVU:     ', `\u{1F7E2} Connected`),
			line('Room:     ', `${roomConnected ? '\u{1F7E2}' : '\u{1F534}'} ${roomConnected ? 'Connected' : 'Disconnected'}`),
			line('AI:       ', `${hasAi(config) ? '\u{1F7E2}' : '\u{1F7E1}'} ${hasAi(config) ? 'Enabled' : 'Fallback mode'}`),
			line('Memory:   ', '\u{1F7E2} Enabled'),
			'\u255A' + '\u2550'.repeat(30) + '\u255D',
		].join('\n')
	);
}

async function start(): Promise<void> {
	console.log('Starting IMVU AI Bot...');

	// Welcome state: who has been greeted already and when the next welcome
	// is allowed (see the WELCOME_* constants above).
	const welcomed = new Set<string>();
	const welcomeTimestamps: number[] = [];
	let welcomeReadyAt = 0;
	let lastWelcomeAt = 0;

	let config: BotConfig;
	try {
		config = getConfig();
	} catch (error) {
		if (error instanceof ConfigError) {
			console.error(`[ERROR] ${error.message}`);
			console.error('[INFO] Copy .env.example to .env and fill in your values.');
			process.exit(1);
			return;
		}
		throw error;
	}

	// [1/5] Authenticate
	console.log('\n[1/5] Authenticating IMVU account...');
	try {
		account = await login(config.username, config.password, config.twoFactorCode);
	} catch (error) {
		if (error instanceof AuthError) {
			console.error(`[ERROR] IMVU authentication failed: ${error.message}`);
		} else {
			console.error('[ERROR] IMVU authentication failed (unexpected error)');
		}
		process.exit(1);
	}

	console.log(`[✓] Logged in as ${account.username}`);
	console.log(`[✓] IMVU ID: ${account.id}`);

	registerSelfIds([account.id, account.legacyCid]);

	// [2/5] + [3/5] IMQ + room
	room = new RoomConnection(config, account);

	room.onStatus((status) => {
		if (status === 'connected') {
			chatbotEnabled = true;
			// Ignore "joined" updates for a moment: right after every
			// (re)connect the server reports ALL current participants, and
			// those are not newcomers to welcome.
			welcomeReadyAt = Date.now() + WELCOME_SETTLE_MS;
			if (booted) {
				console.log(`[✓] Room reconnected (${config.roomId})`);
				console.log('[✓] AI chatbot enabled');
			}
		} else if (status === 'disconnected') {
			chatbotEnabled = false;
			if (booted) {
				console.log('[WARN] Chatbot disabled until the room reconnects');
			}
		}
	});

	console.log('\n[2/5] Connecting to IMVU...');
	try {
		await room.connect();
	} catch (error) {
		console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
		console.error(`[ERROR] Could not connect to room ${config.roomId}`);
		await shutdown(1);
		return;
	}
	console.log('[✓] Connected to IMVU realtime service');

	console.log('\n[3/5] Connecting to room...');
	console.log(
		`[✓] Room connected (${config.roomId}${room.roomName ? ` - ${room.roomName}` : ''})`
	);

	// [4/5] AI
	console.log('\n[4/5] Initializing AI...');
	if (hasAi(config)) {
		console.log(`[✓] AI connected (model: ${config.aiModel} @ ${config.aiBaseUrl})`);
	} else {
		console.log('[WARN] No AI_API_KEY/OPENAI_API_KEY configured - running in fallback mode');
	}

	// [5/5] Chatbot wiring (only reachable because the room is connected)
	console.log('\n[5/5] Starting chatbot...');

	if (!room.mount) {
		console.error(`[ERROR] Room ${config.roomId} is not available - chatbot not enabled`);
		await shutdown(1);
		return;
	}

	// Observe live events on the wire so sending learns the room's
	// chatId and the bot's numeric user id (native room payload shape).
	// Listen on the room (it proxies the active mount, so listeners keep
	// working across rejoins).
	const self = account;
	room.on('message', (event: any) => {
		observeRoomEvent(event, self.legacyCid);
	});

	onRoomMessage(room, [account.id, account.legacyCid], async ({ userId, text }) => {
		if (!chatbotEnabled) {
			return;
		}

		console.log(`\nUser${userId}:`);
		console.log(text);

		try {
			const reply = await chatReply(userId, text);

			if (reply === null) {
				// Rate limited - ignore silently.
				return;
			}

			if (!room?.mount) {
				console.log('[WARN] Room connection lost before the reply could be sent');
				return;
			}

			await sendRoomMessage(room.mount, reply, config.maxReplyLength);

			console.log(`\n${config.botName}:`);
			console.log(reply);
		} catch (error) {
			const message = String(error);
			if (message.includes('AI')) {
				console.error('[ERROR] AI API request failed');
			} else {
				console.error(`[ERROR] Could not send IMVU message: ${message.slice(0, 120)}`);
			}
		}
	});

	chatbotEnabled = true;
	console.log('[✓] Chatbot enabled');

	// Welcome newcomers to the room and tell them how to reach the bot.
	onUserJoined(room, [account.id, account.legacyCid], async (userId) => {
		if (!chatbotEnabled) {
			return;
		}

		const now = Date.now();

		// Skip the participant burst right after a (re)connect.
		if (now < welcomeReadyAt) {
			return;
		}

		// Welcome each user only once per session.
		if (welcomed.has(userId)) {
			return;
		}

		// Rate limits: minimum gap between welcomes + per-minute budget.
		while (welcomeTimestamps.length > 0 && now - welcomeTimestamps[0] > 60_000) {
			welcomeTimestamps.shift();
		}
		if (
			now - lastWelcomeAt < WELCOME_MIN_INTERVAL_MS ||
			welcomeTimestamps.length >= WELCOME_MAX_PER_MINUTE
		) {
			console.log(`[info] Welcome for user ${userId} skipped (rate limited)`);
			return;
		}

		if (!room?.mount) {
			console.log('[WARN] Room connection lost before the welcome could be sent');
			return;
		}

		const welcome =
			`Welcome to ${room.roomName || config.roomId}! (^_^) ` +
			`If you want to chat, just mention ${config.botName} ` +
			'and I will answer you ✧';

		try {
			await sendRoomMessage(room.mount, welcome, config.maxReplyLength);
			welcomed.add(userId);
			lastWelcomeAt = now;
			welcomeTimestamps.push(now);

			console.log(`\n${config.botName} (welcoming user ${userId}):`);
			console.log(welcome);
		} catch (error) {
			console.error(`[ERROR] Could not send welcome: ${String(error).slice(0, 120)}`);
		}
	});
	console.log('[✓] Welcome messages enabled');

	// Start friend request auto-accept if enabled
	if (config.autoAcceptFriends && account) {
		console.log('\n[6/6] Starting friend request auto-accept...');
		friendManager = createFriendRequestManager(account.client);
		friendManager.start();
		console.log('[✓] Friend request auto-accept enabled');
	} else {
		console.log('\n[6/6] Friend request auto-accept: OFF');
	}

	// 7. Set up inbox/private message handling if enabled
	if (config.autoReplyInbox && account && room) {
		console.log('\n[7/7] Setting up inbox message handling...');
		await setupInboxHandling(account, config, room);
		console.log('[✓] Inbox auto-reply enabled');
	} else {
		console.log('\n[7/7] Inbox auto-reply: OFF');
	}

	// Keep-alive ping
	setInterval(() => {
		if (room?.status === 'connected') {
			// Room is alive - nothing to do
		} else if (room?.status === 'disconnected') {
			console.log('[KEEP-ALIVE] Room disconnected, attempting reconnect...');
			room.connect().catch(() => {});
		}
	}, 30000);

	console.log('\n' + '='.repeat(32));
	console.log(`        ${config.botName.toUpperCase()} IS ONLINE`);
	console.log('='.repeat(32));
	console.log(`Room: ${config.roomId}`);
	console.log(`Account: ${account.username}`);
	console.log(`AI: ${hasAi(config) ? 'ONLINE' : 'FALLBACK MODE'}`);
	console.log(`Trigger: only replies when messages mention "${config.botName}"`);
	console.log('Welcomes: ENABLED (newcomers are greeted)');
	console.log('Inbox: ' + (config.autoReplyInbox ? 'ENABLED' : 'OFF') + ' (auto-reply to private messages)');
	console.log('Friends: ' + (config.autoAcceptFriends ? 'ENABLED' : 'OFF') + ' (auto-accept friend requests)');
	console.log('Chatbot: ENABLED');
	console.log('='.repeat(32));

	statusPanel();

	booted = true;

	startCommandLine();
}

function startCommandLine(): void {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

	rl.on('line', async (line) => {
		const input = line.trim();
		if (!input) {
			return;
		}
		const command = input.toLowerCase();

		// /say <text> - send a raw message to the room (tests the IMVU SEND path).
		if (command.startsWith('/say ')) {
			const text = input.slice('/say '.length).trim();
			if (!room?.mount) {
				console.log('[WARN] No room connection - cannot send');
				return;
			}
			if (!text) {
				console.log('Usage: /say <text>');
				return;
			}
			try {
				await sendRoomMessage(room.mount, text, getConfig().maxReplyLength);
				console.log(`[✓] Sent to room: ${text}`);
			} catch (error) {
				console.error(`[ERROR] Could not send IMVU message: ${String(error).slice(0, 120)}`);
			}
			return;
		}

		// /test - run the AI reply pipeline once (tests AI + persona, prints only).
		if (command === '/test') {
			console.log('Testing AI reply pipeline...');
			try {
				// Must mention the bot name so the trigger rule lets it through.
				const reply = await chatReply('console-test', `hello ${getConfig().botName}, are you there?`);
				console.log(reply === null ? '[WARN] Rate limited - no reply generated' : `[✓] AI reply: ${reply}`);
			} catch (error) {
				console.error(`[ERROR] AI test failed: ${String(error).slice(0, 120)}`);
			}
			return;
		}

		switch (command) {
			case '/status':
				statusPanel();
				break;
			case '/help':
				console.log('Commands: /status, /say <text>, /test, /logout, /exit');
				break;
			case '/logout':
				await shutdown(0, true);
				break;
			case '/exit':
				await shutdown(0);
				break;
			default:
				if (command) {
					console.log('Unknown command. Try /help');
				}
		}
	});
}

async function shutdown(code: number, explicitLogout = false): Promise<void> {
	// 1. Disable chatbot
	chatbotEnabled = false;

	// 2. Stop friend request manager
	if (friendManager) {
		friendManager.stop();
		friendManager = null;
	}

	// 3. Stop inbox message subscription
	if (inboxMount) {
		inboxMount.removeAllListeners();
		inboxMount = null;
	}

	// 4 + 5. Leave room and close the realtime connection
	if (room) {
		room.disconnect();
		room = null;
	}

	// 6. Clear session data held in memory (persistent cookies remain for reuse)
	if (account) {
		await logout(account);
		account = null;
	}

	if (explicitLogout) {
		console.log('\nIMVU Login:     Disconnected');
		console.log('Logged out. The application has returned to the login state.');
	} else {
		console.log('\nShutting down...');
	}

	process.exit(code);
}

process.on('SIGINT', () => {
	void shutdown(0);
});

process.on('unhandledRejection', (reason) => {
	const message = reason instanceof Error ? reason.message : String(reason);
	// Never echo raw errors here - they may contain tokens or cookies.
	console.error(`[ERROR] Unhandled failure: ${message.slice(0, 160)}`);
});

start().catch(async (error) => {
	console.error(`[ERROR] Fatal: ${error instanceof Error ? error.message : String(error)}`);
	await shutdown(1);
});

