import { EventEmitter } from 'events';

import { IMQConnection, Status } from './IMQConnection';
import { IMQQueue } from './message/IMQQueue';

const STATUS = {
	[Status.CONNECTING]: 'connecting',
	[Status.AUTHENTICATED]: 'connected',
	[Status.CLOSED]: 'disconnected',
	[Status.WAITING]: 'disconnected',
	[Status.AUTHENTICATING]: 'authenticating',
} as const;

export class IMQManager extends EventEmitter {
	private connection: IMQConnection;
	private messageOpId = 0;

	private queuedSubscriptions: Array<() => void> = [];

	messageCallbacks: any[] = [];

	private state: { status: typeof STATUS[Status]; connectAt?: number } = {
		status: 'disconnected',
		connectAt: Date.now(),
	};

	public queues: Map<string, IMQQueue> = new Map();

	public constructor(private config: any) {
		super();
		this.connection = new IMQConnection(config);

		this.connection.on('state', (state: any) => {
			this.onConnectionState(state);
		});

		this.connection.on('message', (message: any) => {
			this.onMessage(message);
		});
	}

	public get status(): string {
		return this.state.status;
	}

	public async connect(callback?: any): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.connection.status === Status.AUTHENTICATED) {
				return resolve(callback?.());
			}

			const onState = (status: Status) => {
				if (status === Status.AUTHENTICATED) {
					this.connection.off('state', onState);
					resolve();
				}
			};

			this.connection.on('state', onState);

			if (this.connection.status === Status.WAITING || this.connection.status === Status.CLOSED) {
				this.connection.connect();
			}
		});
	}

	public subscribeState(a: any, name: string, c: any) {
		const queueState = () => {
			this.subscribeQueue(
				a,
				(f: any) => {
					return f.getStateMount(name);
				},
				c
			);
		};

		if (this.connection.status !== Status.AUTHENTICATED) {
			this.queuedSubscriptions.push(queueState);
		} else {
			queueState();
		}
	}

	public subscribeMessage(a: any, b: any, c: any) {
		const queueMessage = () => {
			this.subscribeQueue(
				a,
				(f: any) => {
					return f.getMessageMount(b);
				},
				c
			);
		};

		if (this.connection.status !== Status.AUTHENTICATED) {
			this.queuedSubscriptions.push(queueMessage);
		} else {
			queueMessage();
		}
	}

	public close() {
		this.connection.close();

		for (const [, queue] of this.queues) {
			for (const [, mount] of queue.messageMounts) {
				mount.removeAllListeners();
			}

			queue.messageMounts.clear();

			for (const [, mount] of queue.stateMounts) {
				mount.removeAllListeners();
			}

			queue.stateMounts.clear();
		}

		this.queues.clear();
	}

	public sendMessage(queueName: string, mountName: string, message: any, callback?: any) {
		const data = {
			queueName,
			mountName,
			message,
			op_id: this.messageOpId++,
		};

		this.send('msg_c2g_send_message', data, callback);
	}

	public sendStateChange(queueName: string, mountName: string, delta: any, callback?: any) {
		this.send(
			'msg_c2g_state_change',
			{
				queueName,
				mountName,
				delta,
			},
			callback
		);
	}

	private onConnectionState(status: Status, connectAt?: number) {
		this.state = {
			status: STATUS[status] ?? 'unknown',
			connectAt: connectAt ?? this.state.connectAt,
		};

		this.emit('state', this.state.status);

		if (status === Status.AUTHENTICATED) {
			this.queues.forEach((queue) => {
				this.send('msg_c2g_subscribe', [queue.name]);
			});

			this.queuedSubscriptions.forEach((subscriber) => {
				subscriber();
			});

			this.queuedSubscriptions = [];
		}
	}

	private subscribeQueue(name: string, callback: any, c: any) {
		if (!this.queues.has(name)) {
			const subscription = {
				record: 'subscription',
				name,
				op_id: this.messageOpId++,
			};

			this.send('msg_c2g_subscribe', [subscription], (error?: string) => {
				if (error) {
					console.error(`IMQ subscribe error for queue "${name}": ${error}`);
				}
			});
		}

		c(null, callback(this.getOrCreateQueue(name)));
	}

	public unsubscribeQueue(name: string, callback?: (err: string) => void) {
		if (this.queues.has(name)) {
			this.queues.delete(name);
		}

		this._unsubscribeQueue(name, (err: string) => {
			if (err && err !== 'Cannot send data: Not authenticated!') {
				console.error('Error unsubscribing from queue', name, ':', err);
			}

			if (callback) {
				callback(err);
			}
		});
	}

	private _unsubscribeQueue(name: string, callback: (err: string) => void) {
		const subscription = {
			record: 'subscription',
			name,
			op_id: this.messageOpId++,
		};

		this.send('msg_c2g_unsubscribe', [subscription], callback);
	}

	private onMessage(message: any) {
		const { type, data } = message;

		switch (type) {
			case 'msg_g2c_result':
				// Wire events are snake_case; accept both spellings.
				this.receiveOpId(data.op_id ?? data.opId, data.error ?? data.error_message);
				break;
			case 'msg_g2c_left_queue':
			case 'msg_g2c_joined_queue':
				this.receiveQueue(data.queueName, type.split('_')[2], data.userId);
				break;
			case 'msg_g2c_create_mount':
				this.receiveMount(data);
				break;
			case 'msg_g2c_send_message':
				this.receiveMessage(data);
				break;
			case 'msg_g2c_state_change':
				this.receiveStateChange(data);
				break;
			default:
				this.onUnhandledMessage(data);
		}
	}

	private handleCallback(a: Promise<any> | ((a: any) => void), error?: string) {
		if (typeof a === 'function') {
			a(error);
		} else {
			return a;
		}
	}

	private send(type: string, b: any, c?: any) {
		if (this.connection.status === Status.AUTHENTICATED) {
			const opId = b?.op_id ?? (Array.isArray(b) ? b[0]?.op_id : undefined);

			this.connection.send(type, b, opId);
			if (c && opId !== undefined && opId !== null) {
				this.messageCallbacks.push({
					opId,
					function: c,
				});
			}
		} else if (c) {
			this.handleCallback(c);
		}
	}

	private getOrCreateQueue(name: string): IMQQueue {
		if (!this.queues.has(name)) {
			this.queues.set(name, new IMQQueue(this, name));
		}

		return this.queues.get(name)!;
	}

	private receiveOpId(opId: number, error?: string) {
		if (opId === undefined || opId === null) {
			return;
		}

		const c = this.messageCallbacks.find((c) => c.opId === opId);

		if (c) {
			this.handleCallback(c.function, error);
		}
	}

	private receiveQueue(queue: string, action: 'joined' | 'left', userId: string) {
		this.getOrCreateQueue(queue).dispatchSubscriberUpdate({
			action,
			userId,
		});
	}

	private receiveMount(message: any) {
		switch (message.type) {
			case 'message':
				this.getOrCreateQueue(message.queueName).initMessageMount(message.mountName);
				break;
			case 'state':
				this.getOrCreateQueue(message.queueName).initStateMount(message.mountName, message.state);
				break;
			default:
				console.warn('Unhandled mount type', message);
		}
	}

	private receiveMessage(message: any) {
		if (this.queues.has(message.queueName)) {
			this.queues.get(message.queueName)?.dispatchMessage(message.mountName, { ...message });
		}
	}

	private receiveStateChange(message: any) {
		if (this.queues.has(message.queueName)) {
			this.queues.get(message.queueName)?.dispatchState(message.mountName, { ...message });
		}
	}

	private onUnhandledMessage(message: any) {
		console.warn('Unhandled IMQ message', message);
	}
}
