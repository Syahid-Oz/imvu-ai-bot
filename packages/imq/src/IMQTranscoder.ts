/**
 * Codec for the IMVU IMQ websocket wire protocol.
 *
 * Mirrors the official IMVU desktop client implementation (imq.min.js):
 *   - transport: plain JSON TEXT websocket frames (no binary header)
 *   - every object carries a `record` field naming the event
 *   - selected string fields are base64-encoded on the wire:
 *       connect cookie, metadata values, chat messages, user ids
 *
 * Encode input/output uses the same shapes as the manager layer
 * (queueName/mountName/op_id); the codec maps them to the wire names
 * (queue/mount/op_id) exactly like the official client.
 */

type AnyRecord = Record<string, any>;

function utf8ToBase64(value: unknown): string {
	return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function base64ToUtf8(value: unknown): string {
	try {
		return Buffer.from(String(value ?? ''), 'base64').toString('utf8');
	} catch {
		return String(value ?? '');
	}
}

/**
 * Decode a user id from the wire. IMQ normally base64-encodes ids, but some
 * events carry plain numeric ids; decoding those as base64 yields garbage,
 * so only use the decoded form when it looks like a real id/text.
 */
function decodeIdValue(value: unknown): string {
	const raw = String(value ?? '');

	if (!raw) {
		return '';
	}

	if (/^\d+$/.test(raw) || /^user-\d+$/.test(raw)) {
		return raw.replace(/^user-/, '');
	}

	const decoded = base64ToUtf8(raw);

	if (/^user-\d+$/.test(decoded) || /^\d+$/.test(decoded)) {
		return decoded.replace(/^user-/, '');
	}

	if (/^[\x20-\x7e]+$/.test(decoded)) {
		return decoded;
	}

	return raw; // opaque binary id - keep the wire value
}

/**
 * Outgoing message encoders (client -> gateway), keyed by event name.
 * Input is the manager-layer shape; output is the wire shape.
 */
const encoders: Record<string, (data: AnyRecord) => AnyRecord> = {
	msg_c2g_connect: (data) => ({
		record: 'msg_c2g_connect',
		user_id: data.user_id,
		cookie: utf8ToBase64(data.cookie),
		metadata: Object.entries(data.metadata ?? {}).map(([key, value]) => ({
			record: 'metadata',
			key,
			value: utf8ToBase64(value),
		})),
		op_id: data.op_id,
	}),
	msg_c2g_subscribe: (data) => ({
		record: 'msg_c2g_subscribe',
		queues_with_results: Array.isArray(data) ? data : data.queues_with_results,
	}),
	msg_c2g_unsubscribe: (data) => ({
		record: 'msg_c2g_unsubscribe',
		queues_with_results: Array.isArray(data) ? data : data.queues_with_results,
	}),
	msg_c2g_send_message: (data) => ({
		record: 'msg_c2g_send_message',
		queue: data.queueName,
		mount: data.mountName,
		message: utf8ToBase64(data.message),
		op_id: data.op_id,
	}),
	msg_c2g_state_change: (data) => ({
		record: 'msg_c2g_state_change',
		queue: data.queueName,
		mount: data.mountName,
		properties: Object.entries(data.delta ?? {}).map(([key, value]) => ({
			record: 'state_property',
			key,
			value: utf8ToBase64(value),
		})),
	}),
	msg_c2g_open_floodgates: () => ({ record: 'msg_c2g_open_floodgates' }),
	msg_c2g_ping: () => ({ record: 'msg_c2g_ping' }),
};

/**
 * Incoming message decoders (gateway -> client). Input is the raw wire
 * object; output is the manager-layer shape.
 */
const decoders: Record<string, (data: AnyRecord) => AnyRecord> = {
	msg_g2c_result: (data) => ({ ...data }),
	msg_g2c_joined_queue: (data) => ({
		queueName: data.queue,
		userId: decodeIdValue(data.user_id),
	}),
	msg_g2c_left_queue: (data) => ({
		queueName: data.queue,
		userId: decodeIdValue(data.user_id),
	}),
	msg_g2c_create_mount: (data) => {
		const types: Record<number, string> = { 1: 'message', 2: 'state' };
		const type = types[data.type as number];

		if (type === undefined) {
			throw new Error(`Mount created of unknown type: ${data.type}`);
		}

		const result: AnyRecord = {
			type,
			queueName: data.queue,
			mountName: data.mount,
		};

		if (type === 'state') {
			result.state = decodePropertyList(data.properties);
		}

		return result;
	},
	msg_g2c_send_message: (data) => {
		const message = base64ToUtf8(data.message);
		const result: AnyRecord = {
			queueName: data.queue,
			mountName: data.mount,
			userId: decodeIdValue(data.user_id),
			message,
			op_id: data.op_id,
		};

		// Convenience: expand JSON chat messages so listeners get `text`.
		try {
			const parsed = JSON.parse(message);

			if (parsed && typeof parsed === 'object') {
				result.message = parsed;

				if (typeof parsed.text === 'string') {
					result.text = parsed.text;
				}
			}
		} catch {
			result.text = message;
		}

		return result;
	},
	msg_g2c_state_change: (data) => ({
		queueName: data.queue,
		mountName: data.mount,
		userId: data.user_id,
		delta: decodePropertyList(data.properties),
	}),
	msg_g2c_pong: () => ({}),
};

function decodePropertyList(properties: any): Record<string, string> {
	const result: Record<string, string> = {};

	for (const property of properties ?? []) {
		result[property.key] = base64ToUtf8(property.value);
	}

	return result;
}

export class IMQTranscoder {
	/**
	 * Encode an outgoing event into a JSON text frame payload.
	 */
	public encode(event: string, data: AnyRecord | AnyRecord[]): string {
		const encoder = encoders[event];

		if (!encoder) {
			throw new Error(`Unable to encode unknown IMQ message "${event}"`);
		}

		return JSON.stringify(encoder((data ?? {}) as AnyRecord));
	}

	/**
	 * Decode one or more incoming websocket messages into normalized
	 * events of the shape { type: <record>, data: {...} }.
	 */
	public decode(data: unknown): Array<{ type: string; data: AnyRecord }> {
		if (data === undefined || data === null) {
			return [];
		}

		const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);

		try {
			const parsed = JSON.parse(text);
			const decoder = decoders[parsed?.record];

			if (!decoder) {
				console.warn(`IMQ transcoder: unknown incoming record "${parsed?.record}"`);
				return [];
			}

			return [{ type: parsed.record, data: decoder(parsed) }];
		} catch (error) {
			console.error('IMQ transcoder: failed to parse frame', text.slice(0, 200));
			return [];
		}
	}

	/**
	 * Kept for API compatibility with reconnect handling; the JSON codec is
	 * stateless, so there is nothing to reset.
	 */
	public reset(): void {
		// no-op
	}
}

