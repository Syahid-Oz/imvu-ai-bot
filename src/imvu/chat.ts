/**
 * IMVU room chat message handling on top of the room chat message mount
 * (the `imq_messages_mount` advertised by the room's chat resource).
 * Receives incoming room messages, filters out the bot's own and
 * system messages, and sends replies through the same mount.
 *
 * Live-observed wire format of room chat (user 164128108 typing "hello"):
 *   receive: {"to":0,"message":"hello","userId":164128108,"chatId":956879219}
 *   send:    {"to":0,"message":"hello","userId":<sender cid>,"chatId":<id>}
 * Note that the chat text lives in the `message` field, NOT `text`. The
 * room also broadcasts system commands ("*use ...", "*msg SeatAssignment",
 * "*msg BeginText", ...) which are filtered out here.
 */
import { EventEmitter } from 'events';

import { IMQMessageMount } from '../../packages/imq/src/message/IMQMessageMount';

export interface RoomChatMessage {
	/** Normalized (numeric) IMVU user id of the sender. */
	userId: string;
	/** Chat text. */
	text: string;
}

/** The chatId of the room chat (numeric part of the `/chat/<id>` queue or
 * the `chatId` field of incoming messages), mirrored into outgoing payloads. */
let activeChatId: number | string = 0;
/** The bot's own numeric user id, mirrored into outgoing payloads. */
let activeSelfId = '';

/** Remember the room's chat id / own id from incoming events for send payloads. */
export function observeRoomEvent(event: any, selfId: string | number): void {
	activeSelfId = String(selfId ?? '').replace(/^user-/, '');

	const payload = event?.message;
	if (payload && typeof payload === 'object') {
		if (payload.chatId !== undefined && payload.chatId !== null) {
			activeChatId = payload.chatId;
		}
	}

	// The room chat queue is named "/chat/<chatId>" - use it as a fallback
	// before any message carrying a chatId has arrived.
	if (!activeChatId) {
		const queue = String(event?.queue ?? '');
		const match = queue.match(/\/chat\/(\d+)/);
		if (match) {
			activeChatId = Number(match[1]);
		}
	}
}

/**
 * Normalize a sender id coming from the IMQ transcoder. Ids arrive as plain
 * numeric strings ("123456789") when decodable; opaque binary ids are kept
 * as-is so self-filtering and per-user memory still work per identity.
 */
function decodeUserId(raw: unknown): string {
	const value = String(raw ?? '');

	if (!value) {
		return '';
	}

	return value.replace(/^user-/, '');
}

function extractText(message: any): string {
	if (typeof message === 'string') {
		return message;
	}
	if (message && typeof message === 'object') {
		// Room chat carries the text in `message`; some other mounts use `text`.
		if (typeof message.message === 'string') {
			return message.message;
		}
		if (typeof message.text === 'string') {
			return message.text;
		}
	}
	return '';
}

/**
 * Attach a listener for incoming room chat messages. Self messages and
 * system/no-text messages are filtered out before the handler runs.
 */
export function onRoomMessage(
	source: EventEmitter,
	selfIds: Array<string | number>,
	handler: (message: RoomChatMessage) => void
): void {
	const self = new Set(selfIds.map((id) => String(id).replace(/^user-/, '')));

	source.on('message', (event: any) => {
		const userId = decodeUserId(event?.user_id);
		const text = extractText(event?.message ?? event?.text).trim();

		// Ignore empty/system messages. IMVU rooms constantly broadcast
		// avatar/seat/typing commands that start with "*".
		if (!text || text.startsWith('*')) {
			return;
		}

		// Ignore the bot's own messages (IMVU echoes them back to us).
		if (userId && self.has(userId)) {
			console.log(
				`[info] Ignored a message from the bot's own account (${userId}). ` +
					'To talk to the bot, chat from a SECOND IMVU account in the room.'
			);
			return;
		}

		handler({ userId, text });
	});
}

/**
 * Attach a listener for users joining the room chat queue
 * (a `subscriberUpdate` event with action "joined"). The bot's own join
 * is filtered out. userId is the normalized numeric IMVU id.
 */
export function onUserJoined(
	source: EventEmitter,
	selfIds: Array<string | number>,
	handler: (userId: string) => void
): void {
	const self = new Set(selfIds.map((id) => String(id).replace(/^user-/, '')));

	source.on('subscriberUpdate', (event: any) => {
		if (event?.action !== 'joined') {
			return;
		}

		const userId = decodeUserId(event?.user_id);
		if (!userId || self.has(userId)) {
			return;
		}

		handler(userId);
	});
}

/**
 * Send a chat message into the room through the room chat mount.
 *
 * Uses the native IMVU room chat payload shape observed live on the wire:
 *   {"to":0,"message":"<text>","userId":<sender>,"chatId":<room chat id>}
 * The IMQ transcoder base64-encodes it on the wire automatically.
 */
export function sendRoomMessage(
	mount: IMQMessageMount,
	text: string,
	maxLength: number
): Promise<void> {
	const body = text.slice(0, maxLength);

	const payloadObject: Record<string, unknown> = { to: 0, message: body };
	if (activeSelfId) {
		payloadObject.userId = Number(activeSelfId) || activeSelfId;
	}
	if (activeChatId) {
		payloadObject.chatId = activeChatId;
	}

	const payload = JSON.stringify(payloadObject);

	return new Promise<void>((resolve, reject) => {
		try {
			mount.sendMessage(payload, (error: unknown) => {
				if (error) {
					reject(new Error(String(error)));
				} else {
					resolve();
				}
			});
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}
