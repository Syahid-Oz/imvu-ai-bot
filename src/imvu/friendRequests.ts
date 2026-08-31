/**
 * IMVU friend request handling.
 *
 * Auto-accepts incoming friend requests.
 * Uses the FriendManager from @imvu/client to manage friendship relationships.
 */
import { Client } from '../../packages/client/src/client/Client';
import { User } from '../../packages/client/src/resources/User';
import { FriendManager } from '../../packages/client/src/managers/FriendManager';

export interface FriendRequest {
  user: User;
  receivedAt: Date;
}

export type FriendRequestHandler = (request: FriendRequest) => Promise<void> | void;

export class FriendRequestManager {
  private client: Client;
  private friendManager: FriendManager;
  private handler: FriendRequestHandler | null = null;
  private running = false;
  private checkIntervalMs = 30000;
  private checkInterval: NodeJS.Timeout | null = null;
  private requestsProcessed = new Set<string>();

  constructor(client: Client) {
    this.client = client;
    this.friendManager = client.account.friends;
  }

  public onFriendRequest(handler: FriendRequestHandler): void {
    this.handler = handler;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.checkForRequests();
    this.checkInterval = setInterval(() => this.checkForRequests(), this.checkIntervalMs);
    console.log('[FriendManager] Started monitoring for friend requests');
  }

  public stop(): void {
    this.running = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log('[FriendManager] Stopped monitoring for friend requests');
  }

  private async checkForRequests(): Promise<void> {
    try {
      const friendsIterator = this.friendManager.list();
      for await (const friend of friendsIterator) {
        const friendId = String(friend.id).replace(/^user-/, '');
        if (this.requestsProcessed.has(friendId)) continue;
        const request: FriendRequest = { user: friend, receivedAt: new Date() };
        if (this.handler) {
          try {
            await this.handler(request);
            this.requestsProcessed.add(friendId);
            console.log('[FriendManager] Processed friend request from ' + friendId);
          } catch (error) {
            console.error('[FriendManager] Error processing friend request from ' + friendId + ': ' + String(error));
          }
        } else {
          await this.acceptFriendRequest(friendId);
          this.requestsProcessed.add(friendId);
          console.log('[FriendManager] Auto-accepted friend request from ' + friendId);
        }
      }
    } catch (error) {
      console.error('[FriendManager] Error checking for friend requests: ' + String(error));
    }
  }

  public async acceptFriendRequest(userIdOrUser: string | number | User): Promise<boolean> {
    try {
      if (typeof userIdOrUser === 'object' && 'id' in userIdOrUser) {
        await this.friendManager.add(userIdOrUser);
      } else {
        await this.friendManager.add(userIdOrUser);
      }
      return true;
    } catch (error) {
      console.error('[FriendManager] Error accepting friend request: ' + String(error));
      return false;
    }
  }

  public async rejectFriendRequest(userIdOrUser: string | number | User): Promise<boolean> {
    try {
      if (typeof userIdOrUser === 'object' && 'id' in userIdOrUser) {
        await this.friendManager.remove(userIdOrUser);
      } else {
        await this.friendManager.remove(userIdOrUser);
      }
      return true;
    } catch (error) {
      console.error('[FriendManager] Error rejecting friend request: ' + String(error));
      return false;
    }
  }

  public async addFriend(userIdOrUser: string | number | User): Promise<boolean> {
    try {
      await this.friendManager.add(userIdOrUser);
      return true;
    } catch (error) {
      console.error('[FriendManager] Error adding friend: ' + String(error));
      return false;
    }
  }

  public async removeFriend(userIdOrUser: string | number | User): Promise<boolean> {
    try {
      await this.friendManager.remove(userIdOrUser);
      return true;
    } catch (error) {
      console.error('[FriendManager] Error removing friend: ' + String(error));
      return false;
    }
  }
}

export function createFriendRequestManager(client: Client): FriendRequestManager {
  return new FriendRequestManager(client);
}