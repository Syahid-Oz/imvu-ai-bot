/**
 * IMVU room connection via the @imvu/imq realtime service.
 *
 * Flow (discovered live against the IMVU backend):
 *   1. GET /room/room-<roomId>          -> confirm the room exists / is ours
 *   2. GET /chat/chat-<roomId>          -> `imq_queue` + `imq_messages_mount`
 *   3. POST /chat/chat-<roomId>/participants -> become a chat participant
 *   4. IMQManager.connect()             -> websocket + msg_c2g_connect auth
 *   5. subscribeMessage(queue, mount)   -> resolves the chat message mount
 *   6. subscriberUpdate 'joined'        -> confirms we entered the queue
 *
 * Reconnection is delegated to the library (IMQConnection retries with an
 * escalating 5s..3min backoff and IMQManager re-subscribes all queues after
 * re-authenticating), so there is no rapid reconnect loop here.
 */
import { EventEmitter } from 'events';

import { IMQManager } from '../../packages/imq/src/IMQManager';
import { IMQMessageMount } from '../../packages/imq/src/message/IMQMessageMount';
import { ImvuAccount } from './auth';
import { BotConfig } from '../config';

export type RoomStatus = 'disconnected' | 'connecting' | 'connected';

const CONNECT_TIMEOUT_MS = 30_000;
const JOIN_CONFIRMATION_TIMEOUT_MS = 20_000;
const REJOIN_INITIAL_DELAY_MS = 5_000;
const REJOIN_RETRY_DELAY_MS = 15_000;

function sameUser(a: unknown, b: string): boolean {
	const normalize = (value: unknown) =>
		String(value ?? '')
			.replace(/^user-/, '')
			.replace(/[^0-9]/g, '');

	const left = normalize(a);
	const right = normalize(b);

	return left !== '' && left === right;
}

export class RoomConnection extends EventEmitter {
	public readonly manager: IMQManager;
	public mount: IMQMessageMount | null = null;
	public status: RoomStatus = 'disconnected';

	/** The IMVU room name (for display), if it could be resolved. */
	public roomName = '';

	private readonly config: BotConfig;
	private readonly account: ImvuAccount;
	private statusListeners: Array<(status: RoomStatus) => void> = [];

	// Resolved from /chat/chat-<roomId>
	private chatQueue = '';
	private chatMount = '';

	// Auto-rejoin state (used when the room closes / we are dropped from
	// the chat queue, e.g. when the room owner leaves).
	private rejoinTimer?: ReturnType<typeof setTimeout>;
	private rejoining = false;

	public constructor(config: BotConfig, account: ImvuAccount) {
		super();

		this.config = config;
		this.account = account;

		this.manager = new IMQManager({
			url: config.imqUrl,
			userId: account.legacyCid,
			sessionId: account.sessionId,
			connectOpId: 1,
			metadata: {
				// Mirror the official IMVU desktop client metadata.
				app: 'imvu_client3',
				platform_type: process.platform === 'win32' ? 'windows' : process.platform,
			},
		});

		this.manager.on('state', (state: string) => {
			if (state === 'connected') {
				// IMQManager re-subscribes existing queues automatically after
				// reconnecting, so an existing mount means the room is live again.
				if (this.mount) {
					this.setStatus('connected');
				}
			} else if (this.status === 'connected') {
				this.setStatus('disconnected');
				console.log('[WARN] IMVU connection lost');
				console.log('[INFO] Reconnecting (handled by IMQ backoff)...');
			}
		});
	}

	public onStatus(listener: (status: RoomStatus) => void): void {
		this.statusListeners.push(listener);
	}

	private setStatus(status: RoomStatus) {
		if (this.status === status) {
			return;
		}

		this.status = status;

		for (const listener of this.statusListeners) {
			listener(status);
		}
	}

	/**
	 * Resolve the room's chat queue/mount via the IMVU API and join the chat
	 * as a participant. Must be called before connecting to IMQ.
	 */
	private async discoverRoomChat(): Promise<void> {
		const client = this.account.client;

		// Confirm the room exists (and grab its display name when possible).
		try {
			const room = await client.request(`/room/room-${this.config.roomId}`);
			this.roomName = String(room.denormalized[room.id]?.data?.name ?? '');
		} catch {
			throw new Error(
				`Room "${this.config.roomId}" could not be found on IMVU. ` +
					'Check IMVU_ROOM_ID in .env (format: <ownerId>-<roomId>, e.g. 391692542-1).'
			);
		}

		// The chat resource advertises the IMQ queue + message mount.
		const chat = await client.request(`/chat/chat-${this.config.roomId}`);
		const chatData = chat.denormalized[chat.id]?.data as Record<string, any> | undefined;

		this.chatQueue = String(chatData?.imq_queue ?? '');
		this.chatMount = String(chatData?.imq_messages_mount ?? 'messages');

		if (!this.chatQueue) {
			throw new Error(`Room "${this.config.roomId}" does not expose an IMVU chat queue.`);
		}
	}

	/**
	 * Become a participant of the room chat so the IMQ gateway accepts our
	 * messages (otherwise sends fail with "unknown_user").
	 */
	private async joinChatParticipants(): Promise<void> {
		const client = this.account.client;

		try {
			await client.request(`/chat/chat-${this.config.roomId}/participants`, {
				method: 'POST',
				data: {},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not join the room chat participants: ${message}`);
		}
	}

	/**
	 * Connect to IMQ and enter the configured room's chat queue.
	 */
	public async connect(): Promise<void> {
		this.setStatus('connecting');

		await this.discoverRoomChat();
		await this.joinChatParticipants();

		try {
			await withTimeout(
				this.manager.connect(),
				CONNECT_TIMEOUT_MS,
				`Timed out connecting to the IMVU realtime service (${this.config.imqUrl})`
			);
		} catch (error) {
			this.setStatus('disconnected');
			throw new Error(error instanceof Error ? error.message : String(error));
		}

		await this.joinRoom();
	}
	/**
	 * Subscribe to the room's chat queue/mount and wait for join confirmation.
	 */
	public async joinRoom(): Promise<void> {
		if (!this.chatQueue) {
			throw new Error('Room chat queue not resolved; call connect() first.');
		}

		const mount = await new Promise<IMQMessageMount>((resolve, reject) => {
			this.manager.subscribeMessage(
				this.chatQueue,
				this.chatMount,
				(error: unknown, result: IMQMessageMount) => {
					if (error) {
						reject(new Error(`Could not subscribe to room ${this.config.roomId}: ${error}`));
					} else {
						resolve(result);
					}
				}
			);
		});

		this.mount = mount;
		this.attachMountListeners(mount);

		// Confirm we actually entered the room queue (msg_g2c_joined_queue).
		const joined = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				mount.off('subscriberUpdate', onUpdate);
				resolve(false);
			}, JOIN_CONFIRMATION_TIMEOUT_MS);

			const onUpdate = (event: any) => {
				if (event?.action === 'joined' && sameUser(event?.user_id, this.account.legacyCid)) {
					clearTimeout(timer);
					mount.off('subscriberUpdate', onUpdate);
					resolve(true);
				}
			};

			mount.on('subscriberUpdate', onUpdate);
		});

		if (!joined) {
			console.log(
				`[WARN] Could not confirm room join for ${this.config.roomId} within ` +
					`${JOIN_CONFIRMATION_TIMEOUT_MS / 1000}s. Staying subscribed; chat will ` +
					'activate as soon as messages arrive. Check that the room id exists and is accessible.'
			);
		}

		this.setStatus('connected');
	}

	/**
	 * Proxy the active mount's events through the RoomConnection itself so
	 * listeners keep working even when the mount is replaced after a
	 * rejoin (a reopened room gets a new chat queue).
	 */
	private attachMountListeners(mount: IMQMessageMount): void {
		mount.on('message', (event: any) => {
			this.emit('message', event);
		});

		mount.on('subscriberUpdate', (event: any) => {
			this.emit('subscriberUpdate', event);

			// When WE are dropped from the chat queue (room closed by the
			// owner, kicked, session replaced) schedule a rejoin.
			if (event?.action === 'left' && sameUser(event?.user_id, this.account.legacyCid)) {
				this.onSelfLeftQueue();
			}
		});
	}

	private onSelfLeftQueue(): void {
		if (this.status === 'disconnected' || this.rejoining || this.rejoinTimer) {
			return;
		}

		console.log('[WARN] Dropped from the room chat queue (room closed?) - scheduling rejoin');
		this.scheduleRejoin(REJOIN_INITIAL_DELAY_MS);
	}

	private scheduleRejoin(delayMs: number): void {
		if (this.status === 'disconnected' || this.rejoining || this.rejoinTimer) {
			return;
		}

		this.rejoinTimer = setTimeout(() => {
			this.rejoinTimer = undefined;
			void this.rejoinRoom();
		}, delayMs);
	}

	/**
	 * Re-resolve the room's chat queue and rejoin as a participant. A
	 * reopened room can have a NEW chat queue id, so everything is
	 * rediscovered from the IMVU API.
	 */
	private async rejoinRoom(): Promise<void> {
		if (this.status === 'disconnected' || this.rejoining) {
			return;
		}

		this.rejoining = true;

		try {
			await this.discoverRoomChat();
			await this.joinChatParticipants();

			// Force a fresh IMQ subscription (the old queue entry may be
			// stale, and a reopened room uses a different queue name).
			this.manager.queues.delete(this.chatQueue);

			const mount = await new Promise<IMQMessageMount>((resolve, reject) => {
				this.manager.subscribeMessage(
					this.chatQueue,
					this.chatMount,
					(error: unknown, result: IMQMessageMount) => {
						if (error) {
							reject(new Error(String(error)));
						} else {
							resolve(result);
						}
					}
				);
			});

			this.mount = mount;
			this.attachMountListeners(mount);
			this.setStatus('connected');
			console.log(`[✓] Rejoined the room chat queue (${this.chatQueue})`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.log(`[WARN] Room rejoin failed (${message.slice(0, 120)}) - retrying in ${REJOIN_RETRY_DELAY_MS / 1000}s`);
			this.scheduleRejoin(REJOIN_RETRY_DELAY_MS);
		} finally {
			this.rejoining = false;
		}
	}

	public disconnect(): void {
		this.setStatus('disconnected');

		if (this.rejoinTimer) {
			clearTimeout(this.rejoinTimer);
			this.rejoinTimer = undefined;
		}

		try {
			this.manager.close();
		} catch {
			// best-effort
		}

		// Leave the room chat participants (best-effort).
		this.account.client
			.request(`/chat/chat-${this.config.roomId}/participants/user-${this.account.id}`, {
				method: 'DELETE',
			})
			.catch(() => {
				// best-effort
			});

		this.mount = null;
		this.statusListeners = [];
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);

		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

