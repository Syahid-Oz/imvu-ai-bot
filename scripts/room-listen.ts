/**
 * Room diagnostic.
 *
 * Logs in as the configured account, joins the configured room's chat queue
 * and prints EVERY incoming IMQ event for a short time. It also sends one
 * test message: IMVU echoes sent messages back to the sender's own IMQ
 * subscription, so seeing that echo proves BOTH the send and the receive
 * path work for the room.
 *
 * Stop any running bot first (only one active session is expected).
 * Run with:  npm run check:room
 */
import { getConfig } from '../src/config';
import { login, logout } from '../src/imvu/auth';
import { RoomConnection } from '../src/imvu/room';
import { sendRoomMessage, observeRoomEvent } from '../src/imvu/chat';

const LISTEN_MS = 45_000;

async function main(): Promise<void> {
	const config = getConfig();

	console.log(`Logging in as ${config.username}...`);
	const account = await login(config.username, config.password, config.twoFactorCode);
	console.log(`[OK] Logged in (IMVU id ${account.id}, legacyCid ${account.legacyCid})`);

	const room = new RoomConnection(config, account);

	// Dump the chat resource once - it may carry the numeric chatId that
	// room chat payloads reference.
	try {
		const chat = await account.client.request(`/chat/chat-${config.roomId}`);
		console.log('[debug] chat resource:', JSON.stringify(chat).slice(0, 1200));
	} catch (error) {
		console.error('[debug] could not fetch chat resource:', String(error).slice(0, 200));
	}

	console.log(`Connecting to room ${config.roomId}...`);
	await room.connect();
	console.log(`[OK] Subscribed to room ${config.roomId}${room.roomName ? ` (${room.roomName})` : ''}`);

	const mount = room.mount;
	if (!mount) {
		console.error('[FAIL] No message mount resolved for the room');
		room.disconnect();
		process.exit(1);
		return;
	}

	// Raw listeners: show EVERYTHING, including the bot's own messages,
	// exactly as received on the wire.
	mount.on('message', (event: any) => {
		observeRoomEvent(event, account.legacyCid);
		const own = String(event.user_id ?? '').replace(/^user-/, '') === String(account.legacyCid);
		console.log(`[message] from=${event.user_id}${own ? ' (SELF)' : ''} raw=${JSON.stringify(event.message)}`);
	});
	mount.on('subscriberUpdate', (event: any) => {
		observeRoomEvent(event, account.legacyCid);
		console.log(`[subscriberUpdate] ${event.action} user=${event.user_id} subscribers=${JSON.stringify(event.subscribers)}`);
	});

	console.log(`\nListening for ${LISTEN_MS / 1000}s - chat in the room from any account now...\n`);

	// Wait a moment so incoming room events teach us the chatId, then send
	// a test message with the native room payload shape.
	setTimeout(async () => {
		try {
			await sendRoomMessage(mount, 'Shirah room test - sent automatically by check:room', config.maxReplyLength);
			console.log('[OK] Test message SENT to the room (check the room chat in IMVU)');
		} catch (error) {
			console.error('[FAIL] Could not send the test message:', String(error).slice(0, 200));
		}
	}, 2500);

	setTimeout(async () => {
		console.log('\n[done] Closing connection.');
		room.disconnect();
		await logout(account);
		process.exit(0);
	}, LISTEN_MS);
}

main().catch((error) => {
	console.error('[FATAL]', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
