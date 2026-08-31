/**
 * IMVU messages/inbox handling via IMQ.
 *
 * Listens for incoming private messages between users.
 * Live-observed wire format of a private message:
 *   receive: {"from":"user-123456789","to":"user-987654321","message":"hello","timestamp":1234567890}
 *
 * The bot will:
 * 1. Subscribe to the user's messages queue
 * 2. Listen for incoming private messages
 * 3. Reply using AI
 */
import { EventEmitter } from 'events';

import { IMQMessageMount } from '../../packages/imq/src/message/IMQMessageMount';

import { chatReply } from '../ai/ai';
import { getConfig } from '../config';

export interface PrivateMessage {
  /** IMVU user id of the sender */
  userId: string;
  /** Chat text */
  text: string;
  /** Message timestamp */
  timestamp: number;
}

/**
 * Remember the bot's own numeric user id for filtering self-messages.
 */
let ownUserId = '';

/**
 * Register the bot's own user ID for self-message filtering.
 */
export function registerBotSelfId(selfId: string): void {
  ownUserId = String(selfId).replace(/^user-/, '');
}

/**
 * Parse a private message payload from IMQ event data.
 */
function extractPrivateMessage(event: any): PrivateMessage | null {
  const payload = event?.message;
  
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  
  // Extract sender info
  let userId = '';
  if (payload.from) {
    userId = String(payload.from).replace(/^user-/, '');
  } else if (payload.user_id) {
    userId = String(payload.user_id).replace(/^user-/, '');
  } else if (payload.userId) {
    userId = String(payload.userId).replace(/^user-/, '');
  }
  
  if (!userId) {
    return null;
  }
  
  // Extract text
  let text = '';
  if (typeof payload.message === 'string') {
    text = payload.message;
  } else if (payload.message && typeof payload.message.text === 'string') {
    text = payload.message.text;
  } else if (typeof payload.text === 'string') {
    text = payload.text;
  }
  
  if (!text) {
    return null;
  }
  
  return {
    userId,
    text: text.trim(),
    timestamp: payload.timestamp || Date.now()
  };
}

/**
 * Attach a listener for incoming private messages (inbox messages).
 * Self messages are filtered out before the handler runs.
 */
export function onPrivateMessage(
  source: EventEmitter,
  handler: (message: PrivateMessage) => void
): void {
  const self = new Set<string>();
  if (ownUserId) {
    self.add(ownUserId);
  }
  
  source.on('message', (event: any) => {
    const parsed = extractPrivateMessage(event);
    
    if (!parsed) {
      return;
    }
    
    // Filter out the bot's own messages (IMVU echoes them back)
    if (parsed.userId && self.has(parsed.userId)) {
      return;
    }
    
    handler(parsed);
  });
}

/**
 * Send a private message to a user through the IMQ messages queue.
 * 
 * Uses the native IMVU private message payload shape:
 *   {"to":"user-<target_id>","message":"<text>","from":"<sender_id>"}
 */
export async function sendPrivateMessage(
  mount: IMQMessageMount,
  targetUserId: string,
  text: string
): Promise<void> {
  const config = getConfig();
  const body = text.slice(0, config.maxReplyLength);
  
  // Format the target user ID properly
  let targetId = String(targetUserId).replace(/^user-/, '');
  if (!targetId.startsWith('user-')) {
    targetId = `user-${targetId}`;
  }
  
  const payloadObject: Record<string, unknown> = {
    to: targetId,
    message: body
  };
  
  if (ownUserId) {
    payloadObject.from = `user-${ownUserId}`;
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

/**
 * Process and reply to a private message using the AI system.
 */
export async function handlePrivateMessage(
  mount: IMQMessageMount,
  message: PrivateMessage
): Promise<void> {
  const config = getConfig();
  
  try {
    const reply = await chatReply(message.userId, message.text);
    
    if (reply === null) {
      console.log(`[INFO] Rate limited - no reply for private message from ${message.userId}`);
      return;
    }
    
    // Send reply as private message
    await sendPrivateMessage(mount, message.userId, reply);
    console.log(`[✓] Private message reply sent to ${message.userId}: ${reply.slice(0, 60)}${reply.length > 60 ? '...' : ''}`);
    
  } catch (error) {
    console.error(`[ERROR] Failed to process private message from ${message.userId}: ${String(error).slice(0, 120)}`);
  }
}